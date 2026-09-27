/**
 * 左上角的声音开关按钮
 *
 * 位置讲究：**贴着顶部安全区放**。
 *   灵动岛在屏幕正中，它的左右两侧是空的 —— 按钮就放在安全区这条带子的左下角，
 *   和灵动岛同一水平线，既不会被遮住，也不占用任何场景的内容区。
 *   安全区带太矮（无刘海机型）时按钮自动缩小并贴到 y=4，永远不越过 contentTop()。
 *
 * 图标用 10×10 点阵画，和整套复古点阵风格一致：
 *   喇叭锥体常驻，右侧画声波（开）或一个红叉（关）。
 *
 * 命中区比视觉区大一圈 —— 视觉上精致，手上好点。
 */

import { PALETTE, PIXEL, snap } from '../styles/palette';
import { rect, strokeRect, hitTest } from '../styles/widgets';
import { safeTop, contentTop } from '../styles/layout';
import * as audio from '../core/audio';

const BTN_MAX = 38; // 大屏（有灵动岛）上的视觉尺寸
const BTN_MIN = 24; // 安全区很矮时的下限
const MARGIN_X = 10;
const GAP = 6; // 与安全区下沿的间距
const HIT_PAD = 6; // 命中区外扩
const GRID = 10; // 点阵边长（格）

// ---- 10×10 点阵图标 ----
//
// 为什么是 10×10 而不是 8×8：
//   8×8 在 3px 的格子上画不出可辨认的喇叭 —— 斜边只剩"孤立的两三个点"。
//   10×10 多出 25% 分辨率，弧线和叉号才连得起来。
//
// 为什么喇叭必须有"箱体"（最左边那 3 格）：
//   只有"左尖右宽的三角"时，会被读成播放键 ▶。
//   加上左侧方正的箱体，才是喇叭。
//   箱体只给 1 格时三角仍然占主导，照样读成 ▶ —— 实测过，必须够宽。
const CONE = [
  '..........',
  '.....X....',
  '....XX....',
  '...XXX....',
  'XXXXXX....',
  'XXXXXX....',
  '...XXX....',
  '....XX....',
  '.....X....',
  '..........',
];
// 声波（开）：一道朝右的弧，中间鼓到最右一格才有"弧"的弧度
const WAVE = [
  '..........',
  '..........',
  '.......X..',
  '........X.',
  '.........X',
  '.........X',
  '........X.',
  '.......X..',
  '..........',
  '..........',
];
// 静音（关）：一个 4×4 的叉。
// ⚠️ 叉的对角线必须连起来（中心两格相交），否则小尺寸下会读成"三个点"。
const MUTE_X = [
  '..........',
  '..........',
  '..........',
  '......X..X',
  '.......XX.',
  '.......XX.',
  '......X..X',
  '..........',
  '..........',
  '..........',
];

/**
 * 按钮的视觉矩形
 *
 * 竖直位置贴着安全区下沿往上排。
 *
 * ⚠️ 硬约束：`y + h ≤ contentTop()`。
 *    这条保证按钮**永远不侵占任何场景的内容区** —— 它是全局覆盖层，
 *    一旦越界就会盖住某个场景的文案，而那个场景自己并不知道有这个东西。
 *    安全区带太矮（无刘海机型只有 20px）时按钮自动缩小，而不是往下挤。
 *
 * @param {number} w 画布逻辑宽
 * @param {number} h 画布逻辑高
 */
export function buttonRect(w, h) {
  const band = safeTop();
  const ct = contentTop();
  // 顶多长到 contentTop() 之下 4px 处，再大就装不下了
  const size = Math.max(BTN_MIN, Math.min(BTN_MAX, ct - 4));
  // 理想位置是"贴着安全区下沿"，但绝不越过 contentTop()
  const y = Math.max(4, Math.min(band - size - GAP, ct - size));
  return { x: MARGIN_X, y, w: size, h: size };
}

/** 命中矩形 —— 视觉区外扩一圈，且不越出屏幕 */
export function hitRect(w, h) {
  const r = buttonRect(w, h);
  const x = Math.max(0, r.x - HIT_PAD);
  const y = Math.max(0, r.y - HIT_PAD);
  return {
    x,
    y,
    w: r.w + (r.x - x) + HIT_PAD,
    h: r.h + (r.y - y) + HIT_PAD,
  };
}

/** 点阵里每个"亮格"的边长（整数，避免半像素把点阵糊掉） */
export function cellSize(w, h) {
  return Math.max(2, Math.floor(buttonRect(w, h).w / (GRID + 1)));
}

/** 点阵的左上角原点（在按钮里居中） */
export function iconOrigin(w, h) {
  const r = buttonRect(w, h);
  const s = cellSize(w, h) * GRID;
  return {
    x: r.x + Math.round((r.w - s) / 2),
    y: r.y + Math.round((r.h - s) / 2),
  };
}

/**
 * 画点阵
 *
 * ⚠️ 原点只对齐一次，**绝不能逐格 snap()**。
 *    `snap()` 把值对齐到 PIXEL(=2) 的整数倍；格边长 cell 若是奇数（比如 3），
 *    逐格对齐的结果会左右错开 1px：
 *      col0 → snap(14)=14  占 14,15,16
 *      col1 → snap(17)=18  占 18,19,20   ← 17 空了！
 *      col3 → snap(23)=24  占 24,25,26   ← 23 空了！
 *    实测 3px 格子在按钮里裂出了 3 条 1px 黑缝，看起来像"点阵没画满"。
 *    正确做法：原点对齐一次，之后按整数 cell 平移 —— 相邻格子必然相接。
 *    （背板是 dpr 倍，整数逻辑坐标天然落在像素中心，不需要额外对齐。）
 */
function drawBitmap(ctx, grid, ox, oy, cell, color) {
  const x0 = snap(ox);
  const y0 = snap(oy);
  ctx.fillStyle = color;
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== 'X') continue;
      ctx.fillRect(x0 + c * cell, y0 + r * cell, cell, cell);
    }
  }
}

/**
 * 画底板
 *
 * ⚠️ 这里**故意不用** widgets 的 `panel()`：
 *   `panel()` 的立体亮边是用 moveTo/lineTo 画的，会往当前路径里塞点。
 *   本按钮是画在所有场景之上的**全局覆盖层**，一旦发出路径操作，
 *   就会被场景级的"折线是否越界"这类断言误当成自己的路径点。
 *   全局覆盖层保持"惰性"（只 fillRect / strokeRect），互不干扰。
 *   亮边改用两条细矩形，视觉等价。
 */
function drawPlate(r, on) {
  // 底板要比顶栏亮一档 —— 顶栏本身就是 PALETTE.panel，
  // 同色的话按钮会完全糊进背景里，用户根本找不到开关。
  rect(r.x, r.y, r.w, r.h, PALETTE.panelLight);

  const inner = PIXEL;
  rect(r.x + inner, r.y + inner, r.w - inner * 2, inner, PALETTE.borderLight); // 顶亮线
  rect(r.x + inner, r.y + inner, inner, r.h - inner * 2, PALETTE.borderLight); // 左亮线

  strokeRect(r.x, r.y, r.w, r.h, on ? PALETTE.borderLight : PALETTE.danger);
}

/**
 * 绘制按钮
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w
 * @param {number} h
 */
export function draw(ctx, w, h) {
  const r = buttonRect(w, h);
  const on = !audio.isMuted();

  drawPlate(r, on);

  const cell = cellSize(w, h);
  const o = iconOrigin(w, h);

  // 喇叭本体：静音时变暗
  drawBitmap(ctx, CONE, o.x, o.y, cell, on ? PALETTE.text : PALETTE.textDim);
  // 声波 / 静音叉
  drawBitmap(ctx, on ? WAVE : MUTE_X, o.x, o.y, cell,
    on ? PALETTE.accent : PALETTE.danger);
}

/**
 * 处理一次点击
 *
 * 两个方向都给一声反馈：
 *   关掉时 —— 先响一声再静音，用户听到"咔"然后安静下来；
 *   打开时 —— 先静音再响一声（此时已不静音，才听得见）。
 * 少了任何一边，用户都会怀疑"按钮到底生效了没有"。
 *
 * @returns {boolean} 是否命中本按钮（命中后调用方不应再转发给场景）
 */
export function handleTap(x, y, w, h) {
  if (!hitTest(x, y, hitRect(w, h))) return false;

  const wasMuted = audio.isMuted();
  if (!wasMuted) audio.playClick(); // 关之前先响
  audio.toggleMute();
  if (wasMuted) audio.playClick(); // 开之后再响（静音时调它不会有声音）

  return true;
}

export { CONE, WAVE, MUTE_X, GRID };
