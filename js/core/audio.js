/**
 * 全局音频开关 + 点击音效
 *
 * 为什么把"开关"单独拎出来：
 *   背景音乐（bgm.js）和点击音效是两个独立的播放器，但它们共享**同一个**开关。
 *   开关状态放在这里、两边都订阅它，就不会出现"音乐静了、点击还在响"这种不一致。
 *
 * 静音语义：**把音量压到 0，不停播**。
 *   这样取消静音时无缝接上，不会有断点，也不会从头重播。
 *
 * 音效实例复用：
 *   官方文档明确建议"对于相同的音效，应该复用已有的音频实例"。
 *   这里用一个小池子轮转 —— 连续点击时不会互相打断，也不会每次 new 一个。
 *
 * 关于格式：点击音效用 **WAV** 而不是 MP3。
 *   官方文档写明"两个平台完全支持的音频格式有 mp3、aac、wav"，
 *   而 WAV 没有编码器延迟 —— 50ms 的点击音如果被 MP3 的编码器延迟推后十几毫秒，
 *   手感上就是"点了没反应"。4.7 KB 的体积换一个确定的即时响应，值。
 *
 * 所有 wx API 都先做存在性检查 —— 无头测试环境没有这些 API，绝不能抛异常。
 */

const STORAGE_KEY = 'pixeltrader:audio-muted';
const CLICK_SRC = 'audio/click.wav';
const CLICK_VOLUME = 0.5;
const POOL_SIZE = 3;

let muted = false;
let loaded = false;
let pool = [];
let poolIdx = 0;
let clickVolume = CLICK_VOLUME;
let clickSrc = CLICK_SRC;
const listeners = [];

// ---------------------------------------------------------------- 内部

function api() {
  return typeof wx !== 'undefined' && wx ? wx : null;
}

function readStored() {
  const w = api();
  if (!w || typeof w.getStorageSync !== 'function') return false;
  try {
    return !!w.getStorageSync(STORAGE_KEY);
  } catch (e) {
    return false;
  }
}

function writeStored(flag) {
  const w = api();
  if (!w || typeof w.setStorageSync !== 'function') return;
  try {
    w.setStorageSync(STORAGE_KEY, !!flag);
  } catch (e) {
    /* 缓存写失败不影响播放 */
  }
}

function load() {
  if (loaded) return;
  muted = readStored();
  loaded = true;
}

function buildPool() {
  if (pool.length) return;
  const w = api();
  if (!w || typeof w.createInnerAudioContext !== 'function') return;

  for (let i = 0; i < POOL_SIZE; i++) {
    let ctx = null;
    try {
      ctx = w.createInnerAudioContext();
    } catch (e) {
      break; // 底层创建失败就少几个实例，不影响游戏
    }
    try {
      ctx.src = clickSrc;
      ctx.loop = false;
      ctx.volume = muted ? 0 : clickVolume;
      if (typeof ctx.onError === 'function') ctx.onError(() => {});
    } catch (e) {
      /* 忽略：部分环境属性只读 */
    }
    pool.push(ctx);
  }
}

function applyVolumes() {
  const v = muted ? 0 : clickVolume;
  for (const ctx of pool) {
    try {
      ctx.volume = v;
    } catch (e) {
      /* 忽略 */
    }
  }
}

function notify() {
  for (const fn of listeners) {
    try {
      fn(muted);
    } catch (e) {
      /* 订阅方自己的异常不该影响开关状态 */
    }
  }
}

// ---------------------------------------------------------------- 对外

/** 预建音效实例并读回开关状态。不调用也能工作（点击时懒加载） */
export function init(options = {}) {
  if (options.clickSrc) clickSrc = options.clickSrc;
  if (typeof options.clickVolume === 'number') clickVolume = options.clickVolume;
  load();
  buildPool();
  applyVolumes();
  return state();
}

/** 是否已静音 */
export function isMuted() {
  load();
  return muted;
}

/**
 * 静音 / 取消静音
 * @param {boolean} flag
 */
export function setMuted(flag) {
  load();
  muted = !!flag;
  writeStored(muted);
  applyVolumes();
  notify();
  return muted;
}

export function toggleMute() {
  return setMuted(!isMuted());
}

/**
 * 订阅开关变化（背景音乐用它同步音量）
 * @param {Function} fn (muted) => void
 * @returns {Function} 取消订阅
 */
export function onMuteChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/**
 * 播放点击音效
 *
 * 静音时直接返回 false，不产生任何播放调用。
 * @returns {boolean} 是否真的播了
 */
export function playClick() {
  if (isMuted()) return false;
  if (!pool.length) buildPool();
  if (!pool.length) return false;

  const ctx = pool[poolIdx];
  poolIdx = (poolIdx + 1) % pool.length;

  try {
    // 复用实例必须先归零，否则正在播时再 play() 会被忽略
    ctx.stop();
  } catch (e) {
    /* 忽略 */
  }
  try {
    ctx.play();
    return true;
  } catch (e) {
    return false;
  }
}

export function setClickVolume(v) {
  clickVolume = Math.max(0, Math.min(1, Number(v) || 0));
  applyVolumes();
  return clickVolume;
}

export function getClickVolume() {
  return clickVolume;
}

export function getClickSrc() {
  return clickSrc;
}

/** 状态快照 —— 给测试和调试用 */
export function state() {
  load();
  return {
    muted,
    loaded,
    poolSize: pool.length,
    clickSrc,
    clickVolume,
    effectiveVolume: muted ? 0 : clickVolume,
    listenerCount: listeners.length,
  };
}

/** 复位到初始状态 —— 仅供测试使用 */
export function reset() {
  for (const ctx of pool) {
    try {
      ctx.destroy();
    } catch (e) {
      /* 忽略 */
    }
  }
  pool = [];
  poolIdx = 0;
  muted = false;
  loaded = false;
  clickVolume = CLICK_VOLUME;
  clickSrc = CLICK_SRC;
  listeners.length = 0;
}

export { STORAGE_KEY, CLICK_SRC, CLICK_VOLUME, POOL_SIZE };
