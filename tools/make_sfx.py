"""准备按钮点击音效。

输入一个源音频，输出：
  audio/click.mp3   —— 兼容性最好
  audio/click.wav   —— 无编码器延迟，但体积大一些

然后**回读两个产物**，量它们的起始延迟与有效时长，用数据决定留哪个。
（很短的声音最怕 MP3 的编码器延迟把瞬态抹掉，那样点击会"慢半拍"。）

用法：
    python tools/make_sfx.py <源文件> [目标峰值dBFS]
"""
import array
import math
import os
import sys
import wave

import av

SRC = sys.argv[1]
PEAK_DB = float(sys.argv[2]) if len(sys.argv) > 2 else -3.0
RATE = 44100
OUT_DIR = 'audio'


def decode_mono(path):
    """解成单声道 int16 列表。"""
    c = av.open(path)
    s = c.streams.audio[0]
    rs = av.AudioResampler(format='s16', layout='mono', rate=RATE)
    out = array.array('h')

    def take(fr):
        raw = bytes(fr.planes[0])[:fr.samples * 2]
        a = array.array('h')
        a.frombytes(raw)
        out.extend(a)

    for frame in c.decode(s):
        for rf in rs.resample(frame):
            take(rf)
    for rf in rs.resample(None):
        take(rf)
    c.close()
    return out


def trim(samples, rel=0.02):
    """掐掉首尾低于峰值 2% 的样本。"""
    peak = max(abs(v) for v in samples) or 1
    thr = peak * rel
    a = 0
    for i, v in enumerate(samples):
        if abs(v) > thr:
            a = i
            break
    b = len(samples)
    for i in range(len(samples) - 1, -1, -1):
        if abs(samples[i]) > thr:
            b = i + 1
            break
    return samples[a:b], a / RATE, (len(samples) - b) / RATE


def normalize(samples, target_db):
    peak = max(abs(v) for v in samples) or 1
    target = 32767.0 * (10 ** (target_db / 20.0))
    g = target / peak
    return array.array('h', [max(-32768, min(32767, int(round(v * g))))
                             for v in samples])


def fade_edges(samples, ms=1.5):
    """首尾各加 1.5ms 淡入淡出，消掉掐头去尾产生的爆音。"""
    n = max(1, int(RATE * ms / 1000.0))
    n = min(n, len(samples) // 2)
    out = array.array('h', samples)
    for i in range(n):
        k = i / n
        out[i] = int(out[i] * k)
        out[len(out) - 1 - i] = int(out[len(out) - 1 - i] * k)
    return out


def write_wav(samples, path):
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(samples.tobytes())


def encode_mp3(samples, path, bitrate=64000):
    out = av.open(path, 'w', format='mp3')
    st = out.add_stream('libmp3lame', rate=RATE, layout='mono')
    st.bit_rate = bitrate
    step = 1152
    for i in range(0, len(samples), step):
        block = samples[i:i + step]
        if not block:
            continue
        if len(block) < step:
            block = array.array('h', list(block) + [0] * (step - len(block)))
        fr = av.AudioFrame(format='s16p', layout='mono', samples=step)
        fr.sample_rate = RATE
        fr.planes[0].update(block.tobytes())
        fr.pts = i
        for pkt in st.encode(fr):
            out.mux(pkt)
    for pkt in st.encode(None):
        out.mux(pkt)
    out.close()


def probe(path):
    """回读产物：起始延迟、有效时长、峰值。"""
    s = decode_mono(path)
    peak = max(abs(v) for v in s) or 1
    thr = peak * 0.02
    lead = 0
    for i, v in enumerate(s):
        if abs(v) > thr:
            lead = i
            break
    last = len(s) - 1
    for i in range(len(s) - 1, -1, -1):
        if abs(s[i]) > thr:
            last = i
            break
    return {
        'dur': len(s) / RATE,
        'lead': lead / RATE,
        'eff': (last - lead + 1) / RATE,
        'peak_db': 20 * math.log10(peak / 32768.0 + 1e-12),
    }


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f'源文件: {SRC}  ({os.path.getsize(SRC):,} bytes)')

    raw = decode_mono(SRC)
    print(f'解码  : {len(raw) / RATE:.4f}s  峰值 '
          f'{20 * math.log10(max(abs(v) for v in raw) / 32768.0):.1f} dBFS')

    body, l, t = trim(raw)
    print(f'掐静音: 首 {l * 1000:.1f}ms  尾 {t * 1000:.1f}ms  →  '
          f'{len(body) / RATE * 1000:.1f}ms')

    body = normalize(body, PEAK_DB)
    body = fade_edges(body)
    print(f'归一化: 峰值 {PEAK_DB:.1f} dBFS')

    wav_path = os.path.join(OUT_DIR, 'click.wav')
    mp3_path = os.path.join(OUT_DIR, 'click.mp3')
    write_wav(body, wav_path)
    encode_mp3(body, mp3_path)

    print()
    print(f'{"产物":<20} {"体积":>10} {"时长":>9} {"起始延迟":>10} '
          f'{"有效":>9} {"峰值dB":>8}')
    print('-' * 72)
    for p in (mp3_path, wav_path):
        r = probe(p)
        print(f'{os.path.basename(p):<20} {os.path.getsize(p):>8,}B '
              f'{r["dur"]:>8.4f}s {r["lead"] * 1000:>8.2f}ms '
              f'{r["eff"] * 1000:>7.1f}ms {r["peak_db"]:>8.1f}')
    print()
    print('判据：起始延迟越小越好（>5ms 会让点击感觉"慢半拍"）。')


if __name__ == '__main__':
    main()
