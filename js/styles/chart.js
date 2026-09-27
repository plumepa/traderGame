/**
 * 折线走势图 —— 纯 Canvas 2D 手写，零依赖
 *
 * 为什么不用 wx-charts / ucharts / ec-canvas？
 *   微信小游戏**移除了 BOM 与 DOM**，没有 WXML，也没有 <canvas> 组件。
 *   以上库均硬编码 `wx.createCanvasContext(canvasId)`（小程序独有 API，
 *   靠 canvasId 字符串绑定 WXML 组件）并使用旧版异步绘制 API
 *   （setFillStyle / setStrokeStyle / setFontSize / .draw()），
 *   在小游戏里必然失败，且没有"注入现成 context"的入口。
 *   实测 wx-charts@1.0.0 dist 中：
 *     wx.createCanvasContext 出现 1 次且是 context 的唯一来源
 *     setFillStyle 24 次 / setStrokeStyle 12 次 / .draw() 1 次
 *   因此自己用标准 ctx API 画，是唯一可行且最轻的方案。
 *
 * 本模块只画，不做布局计算 —— 坐标轴范围由调用方给出。
 */

import { PALETTE, FONT, PIXEL, STOCK, snap } from './palette';

// ============================================================
// 月度内波动路径（让折线不再"一条直杆"）
// ============================================================
//
// ⚠️ 关键约束：这里**只生成画图用的采样点**，
//    绝不改动 simulator 的 price / history。
//    月度收盘价（= 结算价）必须精确落在路径的端点，
//    否则会与交易、破产判定、结算数据不一致。
//
// 做法：**确定性波形叠加**（不引入任何随机数）
//   在两个真实收盘价 A → B 之间插入 k 个中间点：
//     偏移 = Σ 若干条正弦波 × 桥形权重 w(t)   ← w(0)=w(1)=0，端点严格归零
//
// ✅ 每只股票形状**不同** —— 靠 seedKey（股票代码）派生一组固定相位。
//    注意：这**不是随机数**！相位由代码逐个字符算出哈希，是个纯函数：
//      wavyPath(同一 closes, 同一 code)  →  永远同一结果（可反复验证）
//      wavyPath(不同 code)               →  不同形状
//    两者同时成立，满足"每股不同"且"反复打开不变"。

/**
 * 字符串 → 稳定哈希（FNV-1a 变体），用于派生**固定的**每股相位。
 * 纯函数：同一字符串永远同一结果，不含任何随机源。
 */
function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// 波形基础参数：(频率 cycles, 基础相位 phase, 权重 weight)
// 频率非整数，避免与"每段长度"产生周期共振而显得机械。
const WAVE_COMPONENTS = [
  { cycles: 1.35, phase: 0.35, weight: 1.0 }, // 主波
  { cycles: 2.85, phase: 2.10, weight: 0.42 }, // 次波
  { cycles: 4.60, phase: 0.90, weight: 0.16 }, // 细波（锯齿感）
];

// 波形叠加后的"峰值归一化"系数 —— 保证 wave ∈ [−1, 1] 且不过冲。
// （若直接用权重绝对值之和做除数，主波与次波同相时会叠出很深的谷。）
const WAVE_NORM = 1.20;

/**
 * 由 seedKey 派生"每股固定"的三条波形相位偏移（0~2π）
 * 纯确定性：同一个 key 永远得到同一组相位。
 * @returns {number[]} 三个相位偏移
 */
function phasesFor(seedKey) {
  const h = hashStr(String(seedKey));
  // 用哈希的不同位段生成三个互不相关的相位
  return [
    ((h & 0xff) / 255) * Math.PI * 2,
    (((h >>> 8) & 0xff) / 255) * Math.PI * 2,
    (((h >>> 16) & 0xff) / 255) * Math.PI * 2,
  ];
}

/**
 * 归一化时间 t ∈ (0,1) → 波形值 ∈ [−1, 1]
 * 纯确定性：只跟 t 与相位有关，不含任何随机源。
 */
function waveAt(t, phases) {
  let sum = 0;
  for (let i = 0; i < WAVE_COMPONENTS.length; i++) {
    const c = WAVE_COMPONENTS[i];
    const ph = c.phase + (phases ? phases[i] : 0);
    sum += Math.sin(2 * Math.PI * c.cycles * t + ph) * c.weight;
  }
  // 除以经验峰值系数再夹紧，避免极端相位叠加时越界
  const v = sum / WAVE_NORM;
  return Math.max(-1, Math.min(1, v));
}

/**
 * 把一串月度收盘价展开成带固定波动的高密度路径
 *
 * @param {number[]} closes 月度收盘价（会精确落在路径上）
 * @param {string} [seedKey] 股票代码 —— 决定波形的"形状"（每股不同、跨局恒定）
 * @param {object} [opts]
 *   inner    每两个收盘价之间插入的中间点数（默认 5）
 *   volatility 波动幅度系数（默认 1）
 *   amp      基准振幅相对价格的比例（默认 0.012 = 1.2%）
 * @returns {number[]} 展开后的价格序列（长度 = (n-1)*(inner+1)+1）
 */
export function wavyPath(closes, seedKey = 'stock', opts = {}) {
  const { inner = 5, volatility = 1, amp = 0.012 } = opts;
  if (!closes || closes.length === 0) return [];
  if (closes.length === 1 || inner <= 0) return closes.slice();

  const phases = phasesFor(seedKey);
  const out = [];

  for (let i = 0; i < closes.length - 1; i++) {
    const a = closes[i];
    const b = closes[i + 1];
    const span = Math.abs(b - a);
    const scale = Math.max(a, b) || 1;

    // 本段振幅：基准 + 与真实涨跌幅成正比的那部分（系数克制），
    // 让"大涨大跌的月份"起伏稍明显，但不会出现夸张的尖刺/深谷。
    const segAmp = scale * (amp + (span / scale) * 0.18) * volatility;

    out.push(a);

    for (let k = 1; k <= inner; k++) {
      const t = k / (inner + 1);              // (0,1)
      const bridge = Math.sin(Math.PI * t);   // 两端 0、中间 1 → 端点不漂移
      const wave = waveAt(t, phases) * bridge; // 每股固定波形 × 桥形权重

      const lerp = a + (b - a) * t;
      // 保底：不低于 0.01 元
      out.push(Math.max(0.01, lerp + wave * segAmp));
    }
  }

  out.push(closes[closes.length - 1]);
  return out;
}

/**
 * 画一个带箭头的线段（箭头在终点）
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x1 起点 x
 * @param {number} y1 起点 y
 * @param {number} x2 终点 x
 * @param {number} y2 终点 y
 * @param {string} color
 * @param {number} lineWidth
 * @param {number} headSize 箭头边长
 */
export function arrowLine(ctx, x1, y1, x2, y2, color, lineWidth = PIXEL, headSize = 6) {
  const ang = Math.atan2(y2 - y1, x2 - x1);

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';

  // 线段
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // 箭头（实心三角，沿线段方向）
  const a1 = ang + Math.PI - 0.42;
  const a2 = ang + Math.PI + 0.42;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 + Math.cos(a1) * headSize, y2 + Math.sin(a1) * headSize);
  ctx.lineTo(x2 + Math.cos(a2) * headSize, y2 + Math.sin(a2) * headSize);
  ctx.closePath();
  ctx.fill();
}

/**
 * 画一个小方块（像素风的"数据点"）
 */
function pixelDot(ctx, x, y, size, color) {
  ctx.fillStyle = color;
  ctx.fillRect(snap(x) - size / 2, snap(y) - size / 2, size, size);
}

/**
 * 核心：绘制带坐标轴的多序列折线图
 *
 * @param {object} opts
 *   x           图区左上角 x（含轴标签区域外侧）
 *   y           图区左上角 y
 *   w           图区总宽
 *   h           图区总高
 *   series      [{ name, color, values: number[] }]
 *   min         可选。纵轴最小值；缺省取所有数据最小值
 *   max         可选。纵轴最大值；缺省取所有数据最大值
 *   yTicks      纵轴刻度数量（默认 4）
 *   xLabels     横轴标签（可选），长度应与 values 对齐
 *   xTickEvery  横轴每隔几格显示标签（默认 1）
 *   positions   可选。每个数据点归一化横坐标（0~1），用于"非均匀采样"
 *               —— 例如月度收盘价之间插入了月内波动点，
 *               此时横轴必须按真实时间比例展开，月份标签才落在正确位置。
 *   labelAt     可选。与 positions 配套：值为月份序号时，
 *               在这些索引处显示 xLabels。
 *   showGrid    是否画网格线（默认 true）
 *   endArrow    末端是否画箭头（默认 true）
 *   priceFormat 纵轴数值格式化（默认保留 1 位小数加 ¥）
 *   animate     可选 0~1 的进度，用于生长动画（默认 1 = 完整）
 */
export function lineChart(ctx, opts) {
  const {
    x,
    y,
    w,
    h,
    series = [],
    yTicks = 4,
    xLabels = null,
    xTickEvery = 1,
    positions = null,
    labelAt = null,
    showGrid = true,
    endArrow = true,
    priceFormat = (v) => `¥${v.toFixed(1)}`,
    animate = 1,
  } = opts;

  if (!series.length || !series[0].values.length) return;

  // ---- 计算数据范围 ----
  const all = series.flatMap((s) => s.values);
  let dataMin = opts.min !== undefined ? opts.min : Math.min(...all);
  let dataMax = opts.max !== undefined ? opts.max : Math.max(...all);

  if (dataMax - dataMin < 0.01) {
    // 全平线：人为撑开范围，避免除零
    dataMax += 1;
    dataMin -= 1;
  }
  // 上下留 8% 余量，折线不贴边
  const pad = (dataMax - dataMin) * 0.08;
  dataMin -= pad;
  dataMax += pad;

  // ---- 轴区域 ----
  const axisLabelW = 40; // 纵轴标签宽度
  const axisLabelH = 14; // 横轴标签高度
  const plotX = x + axisLabelW;
  const plotY = y;
  const plotW = w - axisLabelW - PIXEL;
  const plotH = h - axisLabelH;

  if (plotW <= 0 || plotH <= 0) return;

  const n = series[0].values.length;
  const stepX = n > 1 ? plotW / (n - 1) : 0;

  /**
   * 数据 → 画布坐标
   *
   * ⚠️ 必须夹在绘图区内。调用方可能传进来比数据更窄的 min/max
   * （例如"纵轴只按月度收盘价定范围，月内波动点不算数"），
   * 此时超出范围的点会被线性外推，直接冲出面板 —— 曾经真的发生过。
   * 图表库不能假设调用方永远给对范围，这里兜住最后一道。
   */
  const toY = (v) => {
    const t = (v - dataMin) / (dataMax - dataMin);
    const yy = plotY + plotH - t * plotH;
    if (yy < plotY) return plotY;
    if (yy > plotY + plotH) return plotY + plotH;
    return yy;
  };
  // 有 positions 时按真实时间比例定位；否则按索引等距
  const toX = (i) =>
    positions && positions.length === n
      ? plotX + positions[i] * plotW
      : plotX + i * stepX;

  // ---- 网格线 + 纵轴刻度 ----
  ctx.lineWidth = PIXEL;
  for (let i = 0; i <= yTicks; i++) {
    const ratio = i / yTicks;
    const gy = snap(plotY + plotH * ratio);
    const value = dataMax - (dataMax - dataMin) * ratio;

    if (showGrid) {
      ctx.strokeStyle = PALETTE.border;
      ctx.beginPath();
      ctx.moveTo(snap(plotX), gy);
      ctx.lineTo(snap(plotX + plotW), gy);
      ctx.stroke();
    }

    // 纵轴标签（右对齐到轴左侧）
    ctx.font = FONT.normal(FONT.size.xs);
    ctx.fillStyle = PALETTE.textDim;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(priceFormat(value), snap(plotX) - 4, gy);
  }

  // ---- 坐标轴（带箭头）----
  const ax = snap(plotX);
  const ay = snap(plotY + plotH);
  arrowLine(ctx, ax, ay, ax, snap(plotY) - 2, PALETTE.borderLight, PIXEL, 5);      // 纵轴向上
  arrowLine(ctx, ax, ay, snap(plotX + plotW) + 2, ay, PALETTE.borderLight, PIXEL, 5); // 横轴向右

  // ---- 横轴标签 ----
  if (xLabels && xLabels.length) {
    ctx.font = FONT.normal(FONT.size.xs);
    ctx.fillStyle = PALETTE.textDim;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    if (labelAt && labelAt.length) {
      // 非均匀采样：只在"月份点"上打标签，位置由 positions 决定
      labelAt.forEach((idx, li) => {
        if (idx < 0 || idx >= n) return;
        if (li % xTickEvery !== 0) return;
        const lb = xLabels[li] !== undefined ? xLabels[li] : xLabels[0];
        if (lb === undefined) return;
        ctx.fillText(String(lb), snap(toX(idx)), snap(ay) + 3);
      });
    } else {
      xLabels.forEach((lb, i) => {
        if (i % xTickEvery !== 0) return;
        ctx.fillText(String(lb), snap(toX(i)), snap(ay) + 3);
      });
    }
  }

  // ---- 折线 ----
  const maxIdx = Math.max(0, Math.round((n - 1) * Math.min(1, Math.max(0, animate))));

  series.forEach((s) => {
    const vals = s.values;
    const color = s.color || PALETTE.accent;

    ctx.strokeStyle = color;
    ctx.lineWidth = PIXEL;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    for (let i = 0; i <= maxIdx; i++) {
      const px = toX(i);
      const py = toY(vals[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // 起点方块
    pixelDot(ctx, toX(0), toY(vals[0]), PIXEL * 2, color);

    if (maxIdx >= 1) {
      // 末端箭头 —— 指示方向
      if (endArrow && maxIdx === n - 1) {
        const x1 = toX(maxIdx - 1);
        const y1 = toY(vals[maxIdx - 1]);
        const x2 = toX(maxIdx);
        const y2 = toY(vals[maxIdx]);
        arrowLine(ctx, x1, y1, x2, y2, color, PIXEL + 1, 7);

        // 末端方块
        pixelDot(ctx, x2, y2, PIXEL * 2, color);
      } else {
        // 动画中途：圆点表示当前位置
        pixelDot(ctx, toX(maxIdx), toY(vals[maxIdx]), PIXEL * 2, color);
      }
    }
  });
}

/**
 * 图例 —— 三个色块 + 名称 + 末端涨跌幅
 *
 * @param {Array} entries [{ name, color, change }]
 * @returns {number} 实际占用的高度
 */
export function chartLegend(ctx, x, y, w, entries, options = {}) {
  const { lineH = 16, showChange = true } = options;
  ctx.textBaseline = 'middle';

  entries.forEach((e, i) => {
    const ly = snap(y + i * lineH);

    // 色块
    ctx.fillStyle = e.color;
    ctx.fillRect(snap(x), snap(ly) - 3, PIXEL * 3, PIXEL * 3);

    // 名称
    ctx.font = FONT.normal(FONT.size.xs);
    ctx.fillStyle = PALETTE.text;
    ctx.textAlign = 'left';
    ctx.fillText(e.name, snap(x) + PIXEL * 3 + 6, ly);

    // 涨跌幅（中国股市：涨红跌绿；平盘不加号，避免出现误导性的 "+0.0%"）
    if (showChange && typeof e.change === 'number') {
      const pct =
        e.change === 0
          ? '0.0%'
          : `${e.change > 0 ? '+' : ''}${(e.change * 100).toFixed(1)}%`;
      ctx.fillStyle = e.change > 0 ? STOCK.up : e.change < 0 ? STOCK.down : STOCK.flat;
      ctx.textAlign = 'right';
      ctx.fillText(pct, snap(x + w), ly);
    }
  });

  return entries.length * lineH;
}
