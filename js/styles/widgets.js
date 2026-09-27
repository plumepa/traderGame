/**
 * 绘制工具封装 —— 按钮、面板、文本、柱状图
 *
 * 所有绘制都是纯 Canvas API，不依赖任何图片素材。
 */

import { PALETTE, FONT, PIXEL, snap, shadowOffset } from './palette';

const ctxRef = { current: null };

/**
 * 绑定 canvas 上下文（渲染器初始化时调用一次）
 */
export function bindContext(ctx) {
  ctxRef.current = ctx;
}

function getCtx() {
  const ctx = ctxRef.current;
  if (!ctx) throw new Error('[widgets] 未绑定 canvas 上下文，请先调用 bindContext(ctx)');
  return ctx;
}

/**
 * 绘制直角矩形（像素风不用圆角）
 */
export function rect(x, y, w, h, color) {
  const ctx = getCtx();
  ctx.fillStyle = color;
  ctx.fillRect(snap(x), snap(y), snap(w), snap(h));
}

/**
 * 绘制描边矩形
 */
export function strokeRect(x, y, w, h, color, lineWidth = PIXEL) {
  const ctx = getCtx();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  const o = lineWidth / 2;
  ctx.strokeRect(snap(x) + o, snap(y) + o, snap(w) - lineWidth, snap(h) - lineWidth);
}

/**
 * 绘制带边框的面板（复古终端风格）
 */
export function panel(x, y, w, h, options = {}) {
  const {
    fill = PALETTE.panel,
    border = PALETTE.border,
    borderLight = PALETTE.borderLight,
  } = options;

  rect(x, y, w, h, fill);
  strokeRect(x, y, w, h, border);

  // 左上角亮边 + 右下角暗边，制造立体像素感
  const ctx = getCtx();
  ctx.strokeStyle = borderLight;
  ctx.lineWidth = PIXEL;
  ctx.beginPath();
  ctx.moveTo(snap(x) + PIXEL, snap(y) + PIXEL);
  ctx.lineTo(snap(x + w) - PIXEL, snap(y) + PIXEL);
  ctx.moveTo(snap(x) + PIXEL, snap(y) + PIXEL);
  ctx.lineTo(snap(x) + PIXEL, snap(y + h) - PIXEL);
  ctx.stroke();
}

/**
 * 绘制文本
 * @param {string} text 内容
 * @param {number} x 起点 x
 * @param {number} y 基线 y
 * @param {object} options { size, color, align, bold, shadow }
 */
export function text(str, x, y, options = {}) {
  const ctx = getCtx();
  const {
    size = FONT.size.md,
    color = PALETTE.text,
    align = 'left',
    bold = false,
    shadow = true,
    baseline = 'alphabetic',
  } = options;

  ctx.font = bold ? FONT.bold(size) : FONT.normal(size);
  ctx.textAlign = align;
  ctx.textBaseline = baseline;

  // 像素风的 '投影' —— 偏移 1~2px 画一层暗色，制造点阵厚度感
  if (shadow) {
    const off = shadowOffset(size);
    ctx.fillStyle = PALETTE.shadow;
    ctx.fillText(str, snap(x) + off, snap(y) + off);
  }

  ctx.fillStyle = color;
  ctx.fillText(str, snap(x), snap(y));
}

/**
 * 测量一段文本的绘制宽度 —— 用于"按实际字宽排下一段文字"
 *
 * 不要在布局里写死偏移量：字号一改，写死的偏移就会让两段文字叠在一起。
 * @param {string} str 文本
 * @param {object} options { size, bold }
 * @returns {number} 宽度（逻辑像素）
 */
export function measure(str, options = {}) {
  const ctx = ctxRef.current;
  const { size = FONT.size.md, bold = false } = options;
  const s = String(str == null ? '' : str);
  // 未绑定上下文时按中文字宽估算，不抛异常
  if (!ctx) return s.length * size * 0.95;
  ctx.font = bold ? FONT.bold(size) : FONT.normal(size);
  return ctx.measureText(s).width;
}

/**
 * 把文本折成若干行（只测量，不绘制）
 *
 * Canvas 不会处理 '\n' —— 直接把带换行的字符串丢给 fillText，
 * 换行符会被静默吞掉，整段挤成一行。所以这里先按 '\n' 切段，
 * 再对每段按宽度折行，空段保留为空行（用于段间距）。
 *
 * @param {string} str 文本
 * @param {number} maxWidth 行宽上限
 * @param {object} options { size, bold }
 * @returns {string[]} 每行的文本（可能含空串表示空行）
 */
export function wrapLines(str, maxWidth, options = {}) {
  const { size = FONT.size.sm, bold = false } = options;
  const paragraphs = String(str == null ? '' : str).split('\n');
  const ctx = ctxRef.current;

  // 未绑定上下文（如纯布局期）时退化为按字数估算，不抛异常
  if (!ctx) {
    const perLine = Math.max(1, Math.floor(maxWidth / (size * 0.95)));
    const out = [];
    paragraphs.forEach((p) => {
      if (!p) { out.push(''); return; }
      for (let i = 0; i < p.length; i += perLine) out.push(p.slice(i, i + perLine));
    });
    return out;
  }

  ctx.font = bold ? FONT.bold(size) : FONT.normal(size);

  const lines = [];
  paragraphs.forEach((para) => {
    if (!para) { lines.push(''); return; }
    let line = '';
    // 中文按字符拆分，英文按空格拆分
    for (const ch of para) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = ch;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
  });
  return lines;
}

/**
 * 文本换行绘制 —— Canvas 没有自动换行，需手动拆
 * @returns {number} 实际占用的行数（含空行）
 */
export function textWrap(str, x, y, maxWidth, lineHeight, options = {}) {
  const lines = wrapLines(str, maxWidth, options);
  lines.forEach((l, i) => {
    if (l) text(l, x, y + i * lineHeight, options);
  });
  return lines.length;
}

/**
 * 绘制按钮
 * @param {object} btn { x, y, w, h, label, color, textColor }
 * @returns {object} 用于命中检测的矩形
 */
export function button(x, y, w, h, label, options = {}) {
  const {
    color = PALETTE.panelLight,
    textColor = PALETTE.text,
    border = PALETTE.borderLight,
    disabled = false,
    size = FONT.size.md,
  } = options;

  const fillColor = disabled ? PALETTE.panel : color;
  const labelColor = disabled ? PALETTE.textDim : textColor;

  // 阴影层（右下偏移）
  rect(x + PIXEL, y + PIXEL, w, h, PALETTE.shadow);
  // 主体
  rect(x, y, w, h, fillColor);
  strokeRect(x, y, w, h, disabled ? PALETTE.border : border);

  text(label, x + w / 2, y + h / 2 + size * 0.35, {
    size,
    color: labelColor,
    align: 'center',
    bold: true,
  });

  return { x: snap(x), y: snap(y), w: snap(w), h: snap(h) };
}

/**
 * 绘制像素柱状图（用于 K 线示意）
 * 涨红跌绿 —— 中国股市配色
 * @param {Array} bars [{ value, change }] change > 0 为涨（红）
 */
export function barChart(x, y, w, h, bars, options = {}) {
  const { upColor, downColor, flatColor, gap = 2, maxBars = 20 } = {
    upColor: '#E8452C',
    downColor: '#2ECC71',
    flatColor: '#8A8A8A',
    gap: 2,
    maxBars: 20,
    ...options,
  };

  if (!bars.length) return;

  // 只显示最近 maxBars 根
  const shown = bars.slice(-maxBars);
  const barW = Math.max(1, Math.floor((w - gap * (shown.length - 1)) / shown.length));

  // 找最大绝对值做归一化
  const maxAbs = Math.max(...shown.map((b) => Math.abs(b.change)), 0.01);
  const midY = y + h / 2;

  // 中轴线
  rect(x, midY - PIXEL / 2, w, PIXEL, PALETTE.border);

  shown.forEach((bar, i) => {
    const color = bar.change > 0 ? upColor : bar.change < 0 ? downColor : flatColor;
    // 柱高按 change 归一化，至少 2px 可见
    const barH = Math.max(2, (Math.abs(bar.change) / maxAbs) * (h / 2 - PIXEL));
    const bx = x + i * (barW + gap);

    if (bar.change >= 0) {
      // 涨：从中轴向上
      rect(bx, midY - barH, barW, barH, color);
    } else {
      // 跌：从中轴向下
      rect(bx, midY, barW, barH, color);
    }
  });
}

/**
 * 判断点是否落在矩形内
 */
export function hitTest(px, py, r) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}
