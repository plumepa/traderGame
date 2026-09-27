"""把源 m4a 转成适合小游戏打包的 BGM（纯 PyAV + 标准库，不依赖 numpy）。

用法：
    python transcode_bgm.py <src> <dst> [bitrate] [channels] [trim|notrim]

做三件事：
  1. 解成 PCM 再重编码 —— 顺带把 fragmented mp4 摊平，摆脱 mvhd duration=0 的坑
  2. 量首尾静音并裁掉 —— 循环播放时首尾留白会听出"空一拍"
  3. 按目标码率 / 声道数编码输出

实现要点：libmp3lame 只接受 planar 采样格式（s32p / fltp / s16p），
所以统一用 s16p —— planar 的好处是裁剪可以按声道直接切字节。
"""
import array
import math
import os
import sys

import av

SRC = sys.argv[1]
DST = sys.argv[2]
BITRATE = int(sys.argv[3]) if len(sys.argv) > 3 else 96000
CHANNELS = int(sys.argv[4]) if len(sys.argv) > 4 else 2
TRIM = (sys.argv[5] if len(sys.argv) > 5 else 'trim') != 'notrim'

RATE = 44100
LAYOUT = 'stereo' if CHANNELS == 2 else 'mono'
CH = CHANNELS
THRESH_DB = -55.0
WINDOW = 0.02          # 20ms 一个窗口
FRAME = 1152           # LAME 帧长
BYTES_PER_SAMPLE = 2   # s16


def plane_bytes(plane, nbytes):
    """取 plane 的真实数据。

    ⚠️ 坑：PyAV 的 AudioFrame plane 缓冲区带对齐填充，
       buffer_size 会比实际数据大（实测 1024 采样的 s16 平面返回 2112 字节，
       真实只有 2048）。直接 bytes(plane) 会把填充字节当成音频样本，
       每帧多插 32 个采样 —— 既拉长时长，又每 23ms 插一段杂音。
       必须按 samples × 每采样字节数截断。
    """
    raw = bytes(plane)
    return raw[:nbytes] if len(raw) > nbytes else raw


# ---------------------------------------------------------------- 分析

def scan_edges(path):
    """解一遍，按 20ms 窗口算 RMS，返回 (首静音秒, 尾静音秒, 峰值, 总时长)。"""
    container = av.open(path)
    stream = container.streams.audio[0]
    resampler = av.AudioResampler(format='s16', layout=LAYOUT, rate=RATE)

    per_win = int(RATE * WINDOW) * CH
    rms_list = []
    buf = array.array('h')
    total = 0
    peak = 0

    def flush():
        while len(buf) >= per_win:
            chunk = buf[:per_win]
            del buf[:per_win]
            s = 0
            for v in chunk:
                s += v * v
            rms_list.append(math.sqrt(s / per_win))

    def absorb(frame):
        nonlocal total, peak
        arr = array.array('h')
        arr.frombytes(plane_bytes(frame.planes[0], frame.samples * CH * BYTES_PER_SAMPLE))
        total += len(arr)
        for v in arr:
            a = v if v >= 0 else -v
            if a > peak:
                peak = a
        buf.extend(arr)
        flush()

    for frame in container.decode(stream):
        for rf in resampler.resample(frame):
            absorb(rf)
    for rf in resampler.resample(None):
        absorb(rf)
    container.close()

    dur = total / (RATE * CH)
    thresh = 32768.0 * (10 ** (THRESH_DB / 20.0))
    loud = [i for i, r in enumerate(rms_list) if r > thresh]
    if not loud:
        return 0.0, 0.0, peak, dur
    head = loud[0] * WINDOW
    tail = max(0.0, dur - (loud[-1] + 1) * WINDOW)
    return head, tail, peak, dur


# ---------------------------------------------------------------- 转码

def transcode(src, dst, bitrate, skip_head, skip_tail):
    """重编码，掐头去尾（秒）。用 planar 字节缓冲做样本级裁剪。"""
    in_c = av.open(src)
    in_s = in_c.streams.audio[0]

    out_c = av.open(dst, 'w', format='mp3')
    out_s = out_c.add_stream('libmp3lame', rate=RATE, layout=LAYOUT)
    out_s.bit_rate = bitrate

    resampler = av.AudioResampler(format='s16p', layout=LAYOUT, rate=RATE)

    step = FRAME * BYTES_PER_SAMPLE          # 每声道每帧字节数
    hold = int(skip_tail * RATE) * BYTES_PER_SAMPLE   # 尾部先扣住，最后丢掉
    head_bytes = int(skip_head * RATE) * BYTES_PER_SAMPLE
    seen = 0

    buf = [bytearray() for _ in range(CH)]   # 每声道一个待输出缓冲
    emitted = 0

    def push(payloads, nsamples):
        frame = av.AudioFrame(format='s16p', layout=LAYOUT, samples=nsamples)
        frame.sample_rate = RATE
        for i, data in enumerate(payloads):
            frame.planes[i].update(bytes(data))
        for pkt in out_s.encode(frame):
            out_c.mux(pkt)

    def drain():
        """缓冲够了就吐整帧，始终给尾部留 hold 字节。"""
        nonlocal emitted
        while len(buf[0]) - hold >= step:
            payloads = []
            for i in range(CH):
                payloads.append(buf[i][:step])
                del buf[i][:step]
            push(payloads, FRAME)
            emitted += FRAME

    def absorb(frame):
        nonlocal seen
        nb = frame.samples * BYTES_PER_SAMPLE
        planes = [bytearray(plane_bytes(frame.planes[i], nb)) for i in range(CH)]
        nbytes = len(planes[0])

        # 掐头
        if seen + nbytes <= head_bytes:
            seen += nbytes
            return
        if seen < head_bytes:
            cut = head_bytes - seen
            planes = [p[cut:] for p in planes]
            nbytes = len(planes[0])
            seen = head_bytes
        else:
            seen += nbytes

        for i in range(CH):
            buf[i].extend(planes[i])
        drain()

    for frame in in_c.decode(in_s):
        for rf in resampler.resample(frame):
            absorb(rf)
    for rf in resampler.resample(None):
        absorb(rf)

    # 去尾：把预留的 hold 丢掉
    for i in range(CH):
        if hold:
            del buf[i][max(0, len(buf[i]) - hold):]

    # 收尾：补零到整帧
    remain = len(buf[0])
    if remain:
        pad = (-remain) % step
        payloads = []
        for i in range(CH):
            data = buf[i]
            if pad:
                data = data + bytes(pad)
            payloads.append(data)
        push(payloads, (remain + pad) // BYTES_PER_SAMPLE)
        emitted += (remain + pad) // BYTES_PER_SAMPLE

    for pkt in out_s.encode(None):
        out_c.mux(pkt)
    out_c.close()
    in_c.close()
    return emitted / RATE


# ---------------------------------------------------------------- 主流程

def main():
    src_size = os.path.getsize(SRC)
    print(f'源文件 : {os.path.basename(SRC)}')
    print(f'         {src_size:,} bytes ({src_size / 1024:.1f} KB)')

    head, tail, peak, dur = scan_edges(SRC)
    print(f'解码   : {dur:.3f}s  {LAYOUT} @ {RATE}Hz  '
          f'峰值 {peak / 32768.0 * 100:.1f}% FS')
    print(f'静音   : 首 {head:.3f}s   尾 {tail:.3f}s')

    if not TRIM:
        head = tail = 0.0
        print('         （notrim：保留原始首尾）')

    out_dur = transcode(SRC, DST, BITRATE, head, tail)

    dst_size = os.path.getsize(DST)
    print(f'输出   : {os.path.basename(DST)}')
    print(f'         {dst_size:,} bytes ({dst_size / 1024:.1f} KB)  '
          f'{out_dur:.3f}s  {BITRATE // 1000} kbps {LAYOUT}')
    print(f'体积   : 源文件的 {dst_size / src_size * 100:.1f}%  '
          f'（省 {(src_size - dst_size) / 1024:.0f} KB）')


if __name__ == '__main__':
    main()
