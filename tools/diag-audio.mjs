/**
 * 背景音乐诊断 —— 播放行为 + 音频资产 + 打包范围
 *
 * 三块：
 *   [1] 播放行为：loop / 音量 / play-pause-stop / 幂等
 *   [2] 静音与持久化：静音只压音量不停播、状态跨会话保留
 *   [3] 降级与容错：没有 wx 音频 API 的环境下不能抛异常
 *   [4] 音频资产体检：文件真的存在、是真 MP3、时长与码率对得上
 *   [5] 打包范围体检：代码包体积不能被测试/文档/备份撑爆
 *
 * ★ [4] 是这一套里最值钱的部分：
 *   "模块逻辑正确"和"用户真的能听到音乐"是两件事。
 *   路径写错一个字母、文件没同步进包、转码参数跑偏 —— 逻辑测试全都测不出来。
 *
 * 运行：
 *   node --experimental-vm-modules --experimental-loader ./tools/register.mjs tools/diag-audio.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAudioHarness } from './wx-audio.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let passed = 0;
let failed = 0;
const fails = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    fails.push(name + (detail ? '  -> ' + detail : ''));
    console.log(`  FAIL ${name}${detail ? '  -> ' + detail : ''}`);
  }
}
function section(t) {
  console.log(`\n${t}`);
}

// =================================================================
// [1] 播放行为
// =================================================================

section('[1] 播放行为');

const harness = createAudioHarness();

// 一个"干净"的 wx：只有音频 + 缓存，别的什么都不给
function freshWx(opts = {}) {
  const storage = new Map();
  const h = createAudioHarness();
  globalThis.wx = {
    ...h.api,
    getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
    setStorageSync: (k, v) => storage.set(k, v),
    ...opts,
  };
  return { h, storage };
}

const { h: h1, storage: store1 } = freshWx();
const bgm = await import(new URL('js/core/bgm.js', `file://${ROOT}/`).href);

bgm.reset();
const st0 = bgm.init();

check('init 后创建了且仅创建了一个音频实例', h1.contexts.length === 1,
  `实际 ${h1.contexts.length}`);
check('init 返回状态里 hasCtx 为真', st0.hasCtx === true);

const ctx1 = h1.last();
check('★ loop 已打开（循环播放的根据）', ctx1.loop === true);
check('★ src 指向包内音频文件', ctx1.src === 'audio/bgm.mp3', `实际 ${ctx1.src}`);
check('音量默认 0.4', ctx1.volume === 0.4, `实际 ${ctx1.volume}`);
check('★ init 后自动开始播放', h1.calls('play').length === 1,
  `play 调用 ${h1.calls('play').length} 次`);
check('播放中 paused 为 false', ctx1.paused === false);
check('★ 设置了 obeyMuteSwitch（手机静音也放）',
  h1.calls('setInnerAudioOption').length === 1 &&
  h1.calls('setInnerAudioOption')[0].opt.obeyMuteSwitch === false);
check('注册了 onError 回调（播放失败不炸）', typeof ctx1.onError === 'function');

// 幂等
bgm.init();
bgm.init({ src: 'https://example.com/other.mp3' });
check('★ 重复 init 不会重复创建实例（幂等）', h1.contexts.length === 1,
  `实际 ${h1.contexts.length}`);
check('重复 init 不会改变已有 src', ctx1.src === 'audio/bgm.mp3', `实际 ${ctx1.src}`);

// play / pause / stop
h1.clear();
bgm.pause();
check('pause() 落到实例上', h1.calls('pause').length === 1);
check('pause() 后 paused 为 true', ctx1.paused === true);

bgm.play();
check('play() 落到实例上', h1.calls('play').length === 1);
check('play() 后 paused 为 false', ctx1.paused === false);

bgm.stop();
check('stop() 落到实例上', h1.calls('stop').length === 1);

// ensurePlaying 兜底
bgm.pause();
h1.clear();
bgm.ensurePlaying();
check('★ ensurePlaying() 在暂停时会拉起播放', h1.calls('play').length === 1);
h1.clear();
bgm.ensurePlaying();
check('★ ensurePlaying() 已在播时不重复调 play', h1.calls('play').length === 0,
  `实际 ${h1.calls('play').length}`);

// 音量边界
check('setVolume 上限钳到 1', bgm.setVolume(5) === 1);
check('setVolume 下限钳到 0', bgm.setVolume(-3) === 0);
check('setVolume 非法值当 0', bgm.setVolume('abc') === 0);
check('setVolume 正常值生效', bgm.setVolume(0.55) === 0.55 && ctx1.volume === 0.55);

// =================================================================
// [2] 静音与持久化
// =================================================================

section('[2] 静音与持久化');

bgm.setVolume(0.4);
h1.clear();
bgm.setMuted(true);
check('★ 静音后实际音量为 0', ctx1.volume === 0, `实际 ${ctx1.volume}`);
check('★ 静音不停播（音乐仍在走，取消后无缝接上）', ctx1.paused === false);
check('静音没有触发 pause', h1.calls('pause').length === 0);
check('静音状态写进了本地缓存', store1.get(bgm.STORAGE_KEY) === true,
  `实际 ${store1.get(bgm.STORAGE_KEY)}`);
check('isMuted() 反映静音状态', bgm.isMuted() === true);

bgm.setMuted(false);
check('取消静音后音量恢复', ctx1.volume === 0.4, `实际 ${ctx1.volume}`);
check('取消静音后缓存同步为 false', store1.get(bgm.STORAGE_KEY) === false);

check('toggleMute() 一次进静音', bgm.toggleMute() === true && ctx1.volume === 0);
check('toggleMute() 再一次退出静音', bgm.toggleMute() === false && ctx1.volume === 0.4);

// 跨会话：把静音状态写进缓存后重新初始化
bgm.setMuted(true);
const { h: h2, storage: store2 } = freshWx();
store2.set(bgm.STORAGE_KEY, true);
bgm.reset();
const st2 = bgm.init();
check('★ 重新初始化会读回上次的静音状态', st2.muted === true);
check('★ 静音状态下重新初始化，音量直接为 0', h2.last().volume === 0,
  `实际 ${h2.last().volume}`);

// 静音时改音量不应把声音放出来
bgm.setVolume(0.8);
check('静音中调音量不会意外发声', h2.last().volume === 0, `实际 ${h2.last().volume}`);
check('静音中调音量被记下（取消静音后生效）', bgm.getVolume() === 0.8);
bgm.setMuted(false);
check('取消静音后用到的是刚才记下的音量', h2.last().volume === 0.8,
  `实际 ${h2.last().volume}`);

// =================================================================
// [3] 降级与容错
// =================================================================

section('[3] 降级与容错');

// 3a. 完全没有 wx
bgm.reset();
const savedWx = globalThis.wx;
delete globalThis.wx;
let threw = null;
try {
  bgm.init();
} catch (e) {
  threw = e;
}
check('★ 没有 wx 时 init 不抛异常', threw === null, threw && threw.message);
check('没有 wx 时状态标记为未持有实例', bgm.state().hasCtx === false);
threw = null;
try {
  bgm.play(); bgm.pause(); bgm.stop(); bgm.ensurePlaying(); bgm.setMuted(true);
} catch (e) {
  threw = e;
}
check('没有 wx 时各操作均为空操作且不抛异常', threw === null, threw && threw.message);
globalThis.wx = savedWx;

// 3b. 有 wx 但没有音频 API（老基础库 / 无头环境）
bgm.reset();
globalThis.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
};
threw = null;
try {
  bgm.init();
} catch (e) {
  threw = e;
}
check('★ 缺 createInnerAudioContext 时 init 不抛异常', threw === null,
  threw && threw.message);
check('降级后 hasCtx 为 false', bgm.state().hasCtx === false);

// 3c. createInnerAudioContext 抛异常
bgm.reset();
globalThis.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  createInnerAudioContext: () => { throw new Error('模拟底层失败'); },
};
threw = null;
try {
  bgm.init();
} catch (e) {
  threw = e;
}
check('★ createInnerAudioContext 抛异常时 init 仍不抛', threw === null,
  threw && threw.message);

// 3d. 缓存 API 抛异常
bgm.reset();
const { h: h3 } = freshWx({
  getStorageSync: () => { throw new Error('缓存读失败'); },
  setStorageSync: () => { throw new Error('缓存写失败'); },
});
threw = null;
try {
  bgm.init();
  bgm.setMuted(true);
} catch (e) {
  threw = e;
}
check('★ 本地缓存读写失败时不影响播放', threw === null, threw && threw.message);
check('缓存失败后音乐仍在播', h3.last() && h3.last().paused === false);

// 3e. destroy
bgm.reset();
const { h: h4 } = freshWx();
bgm.init();
const ctx4 = h4.last();
bgm.destroy();
check('destroy() 调到了实例上', h4.calls('destroy').length === 1);
check('destroy() 后状态清空', bgm.state().hasCtx === false);
threw = null;
try {
  bgm.play(); bgm.pause(); bgm.stop(); bgm.ensurePlaying();
} catch (e) {
  threw = e;
}
check('destroy() 后再操作不抛异常', threw === null, threw && threw.message);
check('destroy() 后 play() 返回 false', bgm.play() === false);
check('destroy() 后实例确实被销毁', ctx4.destroyed === true);

bgm.reset();
globalThis.wx = savedWx;

// =================================================================
// [4] 音频资产体检
// =================================================================

section('[4] 音频资产体检');

const AUDIO_REL = bgm.DEFAULT_SRC;
const AUDIO_ABS = path.join(ROOT, AUDIO_REL);

check(`音频文件存在：${AUDIO_REL}`, fs.existsSync(AUDIO_ABS),
  '缺失！模块会静默不播，但用户听不到任何声音');

let mp3 = null;
if (fs.existsSync(AUDIO_ABS)) {
  const buf = fs.readFileSync(AUDIO_ABS);
  const size = buf.length;

  check('音频文件非空', size > 0);
  check(`体积在合理区间（实测 ${(size / 1024).toFixed(1)} KB）`,
    size > 300 * 1024 && size < 1200 * 1024,
    `体积 ${(size / 1024).toFixed(1)} KB 超出预期区间`);
  check('★ 单文件不超过主包上限 4MB', size < 4 * 1024 * 1024);

  mp3 = parseMp3(buf);
  check('★ 是合法 MP3（MPEG Layer III 帧同步字）', mp3 !== null,
    '文件头不是 MP3 帧同步，播放器可能拒绝');
}

if (mp3) {
  check(`采样率 44100Hz（实际 ${mp3.sampleRate}）`, mp3.sampleRate === 44100);
  check(`码率 96kbps CBR（实际 ${mp3.bitRate}）`, mp3.bitRate === 96000,
    `实际 ${mp3.bitRate}`);
  check('★ 带 Xing/Info 头（时长可被播放器正确识别）', mp3.xing === true,
    '缺 Xing 头时部分播放器会把时长算成 0');
  check(`★ 时长约 60 秒（实际 ${mp3.duration.toFixed(3)}s）`,
    mp3.duration > 58 && mp3.duration < 62,
    `实际 ${mp3.duration.toFixed(3)}s`);
}

// 路径一致性：模块里的常量必须和磁盘上的文件对得上
check('★ 模块 src 常量与磁盘文件一致', fs.existsSync(path.join(ROOT, bgm.DEFAULT_SRC)),
  `模块写的 ${bgm.DEFAULT_SRC} 在磁盘上不存在`);

// main.js 真的接上了
const mainSrc = fs.readFileSync(path.join(ROOT, 'js/main.js'), 'utf8');
check('★ main.js 引入了 bgm 模块', /from\s+['"]\.\/core\/bgm['"]/.test(mainSrc));
check('★ main.js 启动了背景音乐', /bgm\.init\s*\(/.test(mainSrc));
check('main.js 在首次触摸时兜底拉起播放', /bgm\.ensurePlaying\s*\(/.test(mainSrc));
check('★ main.js 引入了全局音频模块', /from\s+['"]\.\/core\/audio['"]/.test(mainSrc));
check('★ main.js 初始化了音效池', /audio\.init\s*\(/.test(mainSrc));
check('★ main.js 引入了声音开关按钮', /ui\/mute-button/.test(mainSrc));
check('★ main.js 每帧绘制声音开关', /muteButton\.draw\s*\(/.test(mainSrc));
check('★ main.js 优先处理声音开关的点击', /muteButton\.handleTap\s*\(/.test(mainSrc));
check('★ 只在命中可点区域时才播放点击音效',
  /const hit = this\.current\.handleTouch[\s\S]{0,120}if \(hit\) audio\.playClick\(\)/.test(mainSrc),
  '点击音效必须绑在"真的点到了东西"上，点空白处不该响');

// =================================================================
// [5] 打包范围体检
// =================================================================
section('[5] 打包范围体检');

const PKG_LIMIT = 4 * 1024 * 1024; // 主包上限
const MUST_SHIP = ['game.js', 'game.json', 'project.config.json', 'js', AUDIO_REL];
const MUST_IGNORE = [
  'tools', 'preview', 'README.md', 'DEV-TASKS.md',
  '.git', '.workbuddy-ai', '_backup_素材_20260925_051453',
  'sonilo_music_8826bff6-60a9-4c13-b090-83e73ac64ae4_1.m4a',
  '_backup_数据_20260925_073551.tar.gz',
  '_backup_旧数据层_20260925_081701.tar.gz',
];

function dirSize(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return 0;
  const st = fs.statSync(abs);
  if (st.isFile()) return st.size;
  let total = 0;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    total += dirSize(path.join(rel, entry.name));
  }
  return total;
}

const shipBytes = MUST_SHIP.reduce((s, p) => s + dirSize(p), 0);
console.log(`  代码包实际内容体积：${(shipBytes / 1024).toFixed(1)} KB` +
  `  （上限 ${PKG_LIMIT / 1024 / 1024} MB）`);
check('★ 代码包体积在上限内', shipBytes < PKG_LIMIT,
  `${(shipBytes / 1024 / 1024).toFixed(2)} MB 超过 ${PKG_LIMIT / 1024 / 1024} MB`);
check('代码包留有充足余量（用掉不到一半）', shipBytes < PKG_LIMIT / 2,
  `用掉 ${(shipBytes / PKG_LIMIT * 100).toFixed(0)}%`);

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'));
const ignore = (cfg.packOptions && cfg.packOptions.ignore) || [];
const ignored = new Set(ignore.map((e) => (typeof e === 'string' ? e : e.value)));

const missing = MUST_IGNORE.filter((p) => !ignored.has(p));
check('★ 测试/文档/备份/原始素材都不进包', missing.length === 0,
  `未忽略：${missing.join(', ')}`);

const wholeRepo = dirSize('.');
console.log(`  若不做忽略，整个仓库会被打进包：${(wholeRepo / 1024 / 1024).toFixed(2)} MB`);
check('★ 不做忽略时确实会超限（证明忽略清单是必要的）', wholeRepo > PKG_LIMIT,
  `仓库仅 ${(wholeRepo / 1024 / 1024).toFixed(2)} MB，忽略清单可能已多余`);

// 原始 m4a 不应进包（它只是转码素材）
check('原始 m4a 素材已列入忽略清单', ignored.has(
  'sonilo_music_8826bff6-60a9-4c13-b090-83e73ac64ae4_1.m4a'));

// =================================================================
// [6] 点击音效与开关联动
// =================================================================

section('[6] 点击音效与开关联动');

const audioMod = await import(new URL('js/core/audio.js', `file://${ROOT}/`).href);
const muteButton = await import(new URL('js/ui/mute-button.js', `file://${ROOT}/`).href);

{
  const { h: h6 } = freshWx();
  bgm.reset(); // 同时复位 core/audio（开关 + 音效池）
  audioMod.init();
  bgm.init();

  const sfx = h6.contexts.filter((c) => c.src === audioMod.CLICK_SRC);
  const music = h6.contexts.filter((c) => c.src === bgm.DEFAULT_SRC);

  check('★ 音效用实例池复用（不是每次播放都新建）',
    sfx.length === audioMod.POOL_SIZE, `音效实例 ${sfx.length} 个`);
  check('背景音乐仍是独立的一个实例', music.length === 1, `${music.length} 个`);
  check('音效实例不循环播放', sfx.every((c) => c.loop === false));
  check('音效音量默认 0.5',
    sfx.every((c) => c.volume === audioMod.CLICK_VOLUME),
    `实际 ${sfx.map((c) => c.volume).join('/')}`);

  // ---- 播放与轮转 ----
  h6.clear();
  check('playClick() 返回 true', audioMod.playClick() === true);
  check('★ 播放前先 stop() 归零（否则正在播时 play() 会被忽略）',
    h6.calls('stop').length === 1 && h6.calls('play').length === 1,
    `stop=${h6.calls('stop').length} play=${h6.calls('play').length}`);

  h6.clear();
  audioMod.playClick();
  audioMod.playClick();
  audioMod.playClick();
  audioMod.playClick();
  const played = h6.calls('play').length;
  check('连点 4 次都能出声', played === 4, `实际 ${played} 次`);
  const order = h6.log.filter((e) => e.type === 'play').map((e) => h6.contexts.indexOf(e.ctx));
  check('★ 实例轮转复用（连点不会互相打断）',
    new Set(order).size === audioMod.POOL_SIZE,
    `用到的实例下标 ${order.join(',')}`);

  // ---- 静音：音效与音乐必须一起闭嘴 ----
  audioMod.setMuted(true);
  check('★ 静音后音效实例音量归零',
    sfx.every((c) => c.volume === 0), `实际 ${sfx.map((c) => c.volume).join('/')}`);
  check('★ 静音后背景音乐实例音量也归零（两者共享同一个开关）',
    music[0].volume === 0, `实际 ${music[0].volume}`);
  check('静音不会停掉背景音乐（音乐仍在走）', music[0].paused === false);

  h6.clear();
  check('静音时 playClick() 返回 false', audioMod.playClick() === false);
  check('★ 静音时完全不去调播放（不是"播了但听不见"）',
    h6.calls('play').length === 0, `play 调用 ${h6.calls('play').length} 次`);

  // ---- 取消静音：两边一起恢复 ----
  audioMod.setMuted(false);
  check('取消静音后音效音量恢复',
    sfx.every((c) => c.volume === audioMod.CLICK_VOLUME));
  check('取消静音后背景音乐音量恢复', music[0].volume === 0.4, `实际 ${music[0].volume}`);

  // ---- 订阅机制 ----
  let notified = 0;
  const off = audioMod.onMuteChange(() => { notified++; });
  audioMod.toggleMute();
  check('开关变化会通知订阅者', notified === 1, `通知 ${notified} 次`);
  audioMod.toggleMute();
  check('再切一次再通知一次', notified === 2, `通知 ${notified} 次`);
  off();
  audioMod.toggleMute();
  check('取消订阅后不再收到通知', notified === 2, `通知 ${notified} 次`);
  audioMod.setMuted(false);

  // ---- 按钮行为 ----
  const W = 393;
  const H = 852;
  const r = muteButton.buttonRect(W, H);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;

  check('点在按钮外不会被它吃掉',
    muteButton.handleTap(200, 500, W, H) === false);
  check('点在按钮外不会改变开关', audioMod.isMuted() === false);

  h6.clear();
  const wasMuted = audioMod.isMuted();
  check('点按钮会被命中', muteButton.handleTap(cx, cy, W, H) === true);
  check('★ 点按钮翻转静音状态', audioMod.isMuted() !== wasMuted);
  check('★ 关掉之前先响一声（听觉反馈）', h6.calls('play').length === 1,
    `play ${h6.calls('play').length} 次`);

  h6.clear();
  check('再点一次能被命中', muteButton.handleTap(cx, cy, W, H) === true);
  check('★ 打开之后也响一声（此时才听得见）', h6.calls('play').length === 1,
    `play ${h6.calls('play').length} 次`);
  check('两次点击后回到未静音', audioMod.isMuted() === false);
}

// =================================================================
// [7] 点击音效资产体检
// =================================================================

section('[7] 点击音效资产体检');

{
  const rel = audioMod.CLICK_SRC;
  const abs = path.join(ROOT, rel);
  check(`音效文件存在：${rel}`, fs.existsSync(abs),
    '缺失！点击不会有任何声音，但模块逻辑测试全绿');

  if (fs.existsSync(abs)) {
    const buf = fs.readFileSync(abs);
    const wav = parseWav(buf);
    check('★ 是合法 WAV（RIFF/WAVE）', wav !== null, '文件头不是 RIFF/WAVE');

    if (wav) {
      check(`单声道（实际 ${wav.channels}）`, wav.channels === 1);
      check(`采样率 44100Hz（实际 ${wav.sampleRate}）`, wav.sampleRate === 44100);
      check(`16bit（实际 ${wav.bitsPerSample}）`, wav.bitsPerSample === 16);
      check(`时长在 30~120ms（实际 ${(wav.duration * 1000).toFixed(1)}ms）`,
        wav.duration > 0.03 && wav.duration < 0.12,
        `实际 ${(wav.duration * 1000).toFixed(1)}ms`);
      check('★ 起始延迟 < 2ms（点击音"慢半拍"的根源）',
        wav.leadMs < 2, `实际 ${wav.leadMs.toFixed(2)}ms`);
      check(`体积 < 20KB（实际 ${(buf.length / 1024).toFixed(1)}KB）`,
        buf.length < 20 * 1024);
      console.log(`  音效：${(buf.length / 1024).toFixed(1)} KB  ` +
        `${(wav.duration * 1000).toFixed(1)}ms  ${wav.sampleRate}Hz ` +
        `单声道 16bit  起始延迟 ${wav.leadMs.toFixed(2)}ms`);
    }
  }

  // ★ 为什么是 WAV 不是 MP3：短音效最怕编码器延迟
  check('★ 点击音效用 WAV 而不是 MP3（WAV 没有编码器延迟）',
    /\.wav$/i.test(rel), `实际 ${rel}`);
}

// =================================================================
// 收尾
// =================================================================

console.log(`\n=== 结果 ===`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  console.log('\n失败明细：');
  for (const f of fails) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('背景音乐诊断通过 ✓');
}

// =================================================================
// WAV 头解析 + 起始延迟测量
// =================================================================

/**
 * 解析 WAV，并量出**起始延迟**。
 *
 * 起始延迟是短音效最关键的指标：如果开头有一段静音，
 * 手感上就是"点了没反应"。这也是点击音效选 WAV 而不是 MP3 的原因 ——
 * MP3 的编码器延迟要靠播放器读 Xing 头才能剥掉，WAV 根本没这回事。
 */
function parseWav(buf) {
  if (buf.length < 44) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF') return null;
  if (buf.toString('latin1', 8, 12) !== 'WAVE') return null;

  let off = 12;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;

  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;

    if (id === 'fmt ' && size >= 16) {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(size, buf.length - body);
      break;
    }
    off = body + size + (size % 2); // 块按偶数字节对齐
  }

  if (!fmt || dataOff < 0 || !fmt.byteRate) return null;

  const n = Math.floor(dataLen / 2);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(buf.readInt16LE(dataOff + i * 2));
    if (v > peak) peak = v;
  }

  // 起始延迟：第一个超过峰值 2% 的采样之前有多少静音
  const thr = peak * 0.02;
  let lead = n;
  for (let i = 0; i < n; i++) {
    if (Math.abs(buf.readInt16LE(dataOff + i * 2)) > thr) {
      lead = i;
      break;
    }
  }

  return {
    ...fmt,
    dataLen,
    duration: dataLen / fmt.byteRate,
    peak,
    leadMs: (lead / fmt.sampleRate) * 1000,
  };
}

// =================================================================
// MP3 头解析（只认 MPEG1 Layer III，够本工程用）
// =================================================================

function parseMp3(buf) {
  const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const RATES = [44100, 48000, 32000];

  // 跳过 ID3v2（若有）
  let off = 0;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) |
      ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    off = 10 + size;
  }

  // 找帧同步：11 个 1
  while (off + 4 <= buf.length) {
    if (buf[off] === 0xff && (buf[off + 1] & 0xe0) === 0xe0) break;
    off++;
  }
  if (off + 4 > buf.length) return null;

  const b1 = buf[off + 1];
  const b2 = buf[off + 2];
  const b3 = buf[off + 3];

  const versionBits = (b1 >> 3) & 0x03; // 3 = MPEG1
  const layerBits = (b1 >> 1) & 0x03;   // 1 = Layer III
  if (versionBits !== 3 || layerBits !== 1) return null;

  const bitrateIdx = (b2 >> 4) & 0x0f;
  const rateIdx = (b2 >> 2) & 0x03;
  const channelMode = (b3 >> 6) & 0x03; // 3 = mono
  if (bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) return null;

  const bitRate = BITRATES[bitrateIdx] * 1000;
  const sampleRate = RATES[rateIdx];
  const stereo = channelMode !== 3;

  // Xing / Info 位于帧头 + 边信息之后
  const sideInfo = stereo ? 32 : 17;
  const xingOff = off + 4 + sideInfo;
  let xing = false;
  let frames = 0;
  if (xingOff + 8 <= buf.length) {
    const tag = buf.toString('latin1', xingOff, xingOff + 4);
    if (tag === 'Xing' || tag === 'Info') {
      xing = true;
      const flags = buf.readUInt32BE(xingOff + 4);
      if (flags & 0x01) frames = buf.readUInt32BE(xingOff + 8);
    }
  }

  const duration = frames ? (frames * 1152) / sampleRate : 0;
  return { bitRate, sampleRate, stereo, xing, frames, duration };
}
