/**
 * 版面安全区 —— 顶部留白（灵动岛 / 刘海 / 状态栏）
 *
 * 为什么需要这个文件：
 *   微信小游戏的 windowWidth / windowHeight 是**整屏**尺寸，包含状态栏
 *   以及 iPhone 灵动岛（Dynamic Island）所占的那一条。若从 y = 0 开始
 *   排版，顶部第一行文字就会被挖孔 / 药丸遮住。
 *
 *   所以所有「内容」都必须从 safeTop 之下开始。本文件统一提供这个偏移，
 *   由 Renderer 在初始化时用 wx.getSystemInfoSync() 写入。
 *
 * ⚠️ 两条不可动摇的约定：
 *   1. 即使系统没报 safeArea（老机型 / 测试桩），也要保留 MIN_TOP 的
 *      顶部留白 —— 状态栏始终存在。因此 safeTop() 自身就带下限，
 *      不依赖 setSafeArea 是否被调用过（测试里直接 new Scene 也成立）。
 *   2. 背景色块（如顶栏）仍然从 y = 0 铺起，只有**内容**下移 ——
 *      否则屏幕顶部会露出一条突兀的空白。
 */

/** 无安全区信息时的最小顶部留白（覆盖状态栏） */
export const MIN_TOP = 24;

/** 安全区之下再留的一点呼吸空间 */
export const TOP_GAP = 8;

/** 无安全区信息时的最小底部留白（覆盖 Home 指示条） */
export const MIN_BOTTOM = 10;

const state = {
  top: 0, // safeArea.top（逻辑像素）
  bottom: 0, // 屏幕底 → safeArea.bottom 的距离
  known: false,
};

/**
 * 写入安全区信息 —— 由 Renderer 初始化时调用
 * @param {object} info wx.getSystemInfoSync() 的返回值
 * @returns {{ top: number, bottom: number }} 生效后的留白
 */
export function setSafeArea(info) {
  const src = info || {};
  const sa = src.safeArea || {};

  const winH = Number(src.windowHeight);
  const screenH = Number(src.screenHeight);
  const totalH = Number.isFinite(winH) ? winH : screenH;

  // ---- 顶部 ----
  let top = Number(sa.top);
  if (!Number.isFinite(top) || top < 0) top = 0;
  // 部分机型 / 旧基础库只给 statusBarHeight
  if (top === 0) {
    const sb = Number(src.statusBarHeight);
    if (Number.isFinite(sb) && sb > 0) top = sb;
  }

  // ---- 底部 ----
  // safeArea.bottom 是「安全区底边」的 y 坐标，离屏底还有一段距离
  let bottom = 0;
  const saBottom = Number(sa.bottom);
  if (Number.isFinite(saBottom) && Number.isFinite(totalH) && totalH > saBottom) {
    bottom = totalH - saBottom;
  }

  state.top = top;
  state.bottom = bottom;
  state.known = true;

  return { top: safeTop(), bottom: safeBottom() };
}

/**
 * 顶部安全留白（含下限）—— 内容不得画在 y < safeTop() 的区域
 */
export function safeTop() {
  return Math.max(state.top, MIN_TOP);
}

/**
 * 内容起点 y —— 顶栏 / 标题等所有内容都应从这里开始
 */
export function contentTop() {
  return safeTop() + TOP_GAP;
}

/**
 * 底部安全留白（含下限）
 */
export function safeBottom() {
  return Math.max(state.bottom, MIN_BOTTOM);
}

/**
 * 底部内容边界 —— 内容不得越过这条线
 * @param {number} h 画布逻辑高
 */
export function contentBottom(h) {
  return h - safeBottom();
}

/**
 * 是否已从系统读到过安全区（仅用于诊断，不影响布局结果）
 */
export function safeAreaKnown() {
  return state.known;
}

/**
 * 复位 —— 测试用
 */
export function resetSafeArea() {
  state.top = 0;
  state.bottom = 0;
  state.known = false;
}
