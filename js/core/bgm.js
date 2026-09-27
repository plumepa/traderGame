/**
 * 背景音乐（BGM）—— 一首曲子循环播放
 *
 * 设计要点：
 *  - 全程只用一个 InnerAudioContext，loop = true，不切歌、不排队
 *  - 静音 = 把 volume 压到 0，**不停播**；取消静音立刻恢复，没有断点
 *  - 静音状态由 core/audio.js 统一持有（背景音乐与点击音效共享同一个开关），
 *    本模块订阅它、同步自己的音量
 *  - src 可外部注入：传一个远程 URL 就能把这 704 KB 从代码包里摘出去
 *  - 所有 wx API 都先做存在性检查 —— 无头测试环境没有这些 API，绝不能抛异常
 *
 * 关于静音键（iOS 侧边开关）：
 *  默认 obeyMuteSwitch = false，即"手机静音也照放"。
 *  这是游戏类小程序的常见做法（否则用户一开静音就以为游戏没声音）。
 *  想改成"跟随系统静音"，把下面 OBEY_MUTE_SWITCH 改成 true 即可。
 */

import * as audio from './audio';

const DEFAULT_SRC = 'audio/bgm.mp3';
const DEFAULT_VOLUME = 0.4;
const OBEY_MUTE_SWITCH = false;

let ctx = null;
let src = DEFAULT_SRC;
let volume = DEFAULT_VOLUME;
let inited = false;
let unsubscribe = null;

// ---------------------------------------------------------------- 内部工具

function api() {
  return typeof wx !== 'undefined' && wx ? wx : null;
}

function applyVolume() {
  if (!ctx) return;
  try {
    ctx.volume = audio.isMuted() ? 0 : volume;
  } catch (e) {
    /* 忽略：部分环境 volume 只读 */
  }
}

// ---------------------------------------------------------------- 对外接口

/**
 * 初始化并开始播放。重复调用是安全的（幂等）。
 *
 * @param {object} [options]
 * @param {string} [options.src]    音频地址，默认包内 audio/bgm.mp3
 * @param {number} [options.volume] 0~1，默认 0.4
 */
export function init(options = {}) {
  if (inited) return state();

  const w = api();
  if (!w || typeof w.createInnerAudioContext !== 'function') {
    // 无头环境 / 极端降级：静默跳过，不影响游戏本体
    inited = true;
    return state();
  }

  if (options.src) src = options.src;
  if (typeof options.volume === 'number') volume = options.volume;

  // 让 iOS 静音键不影响游戏音效（见文件头说明）
  if (typeof w.setInnerAudioOption === 'function') {
    try {
      w.setInnerAudioOption({ obeyMuteSwitch: OBEY_MUTE_SWITCH });
    } catch (e) {
      /* 老版本基础库没有这个 API，忽略 */
    }
  }

  try {
    ctx = w.createInnerAudioContext();
  } catch (e) {
    ctx = null;
  }

  if (ctx) {
    ctx.src = src;
    ctx.loop = true;
    applyVolume();
    // 播放失败（比如 iOS 首次交互前被拦）不抛异常，交给 ensurePlaying 兜底
    if (typeof ctx.onError === 'function') {
      ctx.onError(() => {});
    }
    try {
      ctx.play();
    } catch (e) {
      /* 忽略 */
    }
  }

  // 开关一变就同步音量 —— 这样"音乐静了、点击还在响"不可能发生
  if (unsubscribe) unsubscribe();
  unsubscribe = audio.onMuteChange(() => applyVolume());

  inited = true;
  return state();
}

/** 开始/继续播放 */
export function play() {
  if (!ctx) return false;
  try {
    ctx.play();
    return true;
  } catch (e) {
    return false;
  }
}

/** 暂停（保留进度，下次 play 从这里继续） */
export function pause() {
  if (!ctx) return false;
  try {
    ctx.pause();
    return true;
  } catch (e) {
    return false;
  }
}

/** 停止（进度归零） */
export function stop() {
  if (!ctx) return false;
  try {
    ctx.stop();
    return true;
  } catch (e) {
    return false;
  }
}

/** 彻底释放。释放后再调 play/pause 都是空操作 */
export function destroy() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (!ctx) return;
  try {
    ctx.destroy();
  } catch (e) {
    /* 忽略 */
  }
  ctx = null;
  inited = false;
}

/**
 * 兜底：确保音乐在播。
 *
 * iOS 上首次用户交互前，音频可能被系统拦下不播。
 * 主循环在第一次触摸时调一次这个，就能把音乐"推"起来。
 * 已经在播时是空操作。
 */
export function ensurePlaying() {
  if (!ctx) return false;
  if (ctx.paused === false) return true;
  return play();
}

/**
 * 设置音量（0~1）。静音状态下只记录，不改实际音量。
 * @param {number} v
 */
export function setVolume(v) {
  volume = Math.max(0, Math.min(1, Number(v) || 0));
  applyVolume();
  return volume;
}

export function getVolume() {
  return volume;
}

// ---- 开关：统一委托给 core/audio.js（音乐与音效共享同一个开关）----

/** 静音/取消静音。静音只是把音量压到 0，音乐仍在走，取消后无缝接上 */
export function setMuted(flag) {
  return audio.setMuted(flag);
}

export function isMuted() {
  return audio.isMuted();
}

export function toggleMute() {
  return audio.toggleMute();
}

export function getSrc() {
  return src;
}

/** 当前状态快照 —— 给测试和调试用 */
export function state() {
  return {
    inited,
    hasCtx: !!ctx,
    src,
    volume,
    muted: audio.isMuted(),
    loop: ctx ? ctx.loop : null,
    paused: ctx ? ctx.paused : null,
    effectiveVolume: ctx ? ctx.volume : null,
  };
}

/**
 * 复位到初始状态 —— 仅供测试使用
 *
 * ⚠️ 同时会复位 core/audio.js 的开关状态与音效池。
 *    开关是全局共享的，只复位一边会留下跨用例的脏状态。
 */
export function reset() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (ctx) {
    try {
      ctx.destroy();
    } catch (e) {
      /* 忽略 */
    }
  }
  ctx = null;
  src = DEFAULT_SRC;
  volume = DEFAULT_VOLUME;
  inited = false;
  audio.reset();
}

export { DEFAULT_SRC, DEFAULT_VOLUME };
export { STORAGE_KEY } from './audio';
