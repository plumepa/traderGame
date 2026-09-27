/**
 * 走势图诊断 —— 验证 js/styles/chart.js 的绘制语义
 *
 * 为什么需要它：
 *   图表是纯绘制代码，最容易出的错是"能跑但画错"
 *   —— 坐标轴方向反了、全平线除零、动画中途越界、
 *      末端箭头指向反方向、图例涨跌配色违反"涨红跌绿"。
 *   这些错误渲染不会抛异常，冒烟测试的"渲染无异常"断言抓不到。
 *   因此这里用一个记录调用的假 ctx，从绘制指令层面反推几何正确性。
 */

import { lineChart, arrowLine, chartLegend } from '../js/styles/chart.js';
import { STOCK } from '../js/styles/palette.js';

let passed = 0;
let failed = 0;
const fails = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    fails.push(name + (detail ? `  -> ${detail}` : ''));
    console.log(`  FAIL ${name}${detail ? '  -> ' + detail : ''}`);
  }
}

function section(t) {
  console.log(`\n${t}`);
}

/**
 * 记录型 ctx：把每次绘制指令存下来，供之后做几何断言。
 * 同时保留状态（fillStyle / strokeStyle / lineWidth / font / textAlign），
 * 因为小游戏 ctx 是状态机，很多语义要靠状态推断。
 */
function makeCtx() {
  const calls = [];
  let pathId = 0; // 每次 beginPath 递增，用来把同一个路径的点归到一组
  const state = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    lineCap: 'butt',
    lineJoin: 'miter',
  };
  // 每条绘制指令都带上"执行当时的颜色状态 + 所属路径 id"，
  // 这样测试就能精确地按 (路径, 颜色) 分组，无需事后猜。
  const rec = (op) => (...args) =>
    calls.push({ op, args, pathId, state: { ...state } });
  return {
    calls,
    get fillStyle() { return state.fillStyle; },
    set fillStyle(v) { state.fillStyle = v; },
    get strokeStyle() { return state.strokeStyle; },
    set strokeStyle(v) { state.strokeStyle = v; },
    get lineWidth() { return state.lineWidth; },
    set lineWidth(v) { state.lineWidth = v; },
    get font() { return state.font; },
    set font(v) { state.font = v; },
    get textAlign() { return state.textAlign; },
    set textAlign(v) { state.textAlign = v; },
    get textBaseline() { return state.textBaseline; },
    set textBaseline(v) { state.textBaseline = v; },
    get lineCap() { return state.lineCap; },
    set lineCap(v) { state.lineCap = v; },
    get lineJoin() { return state.lineJoin; },
    set lineJoin(v) { state.lineJoin = v; },
    beginPath: () => { pathId++; calls.push({ op: 'beginPath', args: [], pathId, state: { ...state } }); },
    closePath: rec('closePath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    stroke: rec('stroke'),
    fill: rec('fill'),
    fillRect: rec('fillRect'),
    fillText: rec('fillText'),
    save: rec('save'),
    restore: rec('restore'),
  };
}

const labels = (calls) => calls.filter((c) => c.op === 'fillText').map((c) => String(c.args[0]));
const linePts = (calls) => {
  // 把所有 moveTo/lineTo 的点收集起来
  const pts = [];
  calls.forEach((c) => {
    if (c.op === 'moveTo' || c.op === 'lineTo') pts.push({ x: c.args[0], y: c.args[1] });
  });
  return pts;
};

/**
 * 取「某条序列的数据折线点」。
 *
 * 难点：同一条序列的颜色会出现两次路径 ——
 *   ① 主折线（beginPath + moveTo + (n-1)×lineTo + stroke）
 *   ② 末端箭头（arrowLine → 自己的 beginPath + 线段 2 点 + 三角 3 点）
 *   两者 strokeStyle 相同，因此只按颜色过滤会混入箭头的点。
 *
 * 破法：主折线是**点数最多**的那条同色路径。取"同色路径里点最多的"。
 * 这样天然排除末端箭头（最多 5 点：线段 2 + 三角 3），
 * 也排除网格线（颜色不同）与坐标轴（颜色 borderLight）。
 */
function ptsByColor(calls, color) {
  // 1. 按 pathId 分组，收集每组里颜色匹配的 moveTo/lineTo 点
  const groups = new Map();
  calls.forEach((c) => {
    if ((c.op === 'moveTo' || c.op === 'lineTo') && c.state.strokeStyle === color) {
      if (!groups.has(c.pathId)) groups.set(c.pathId, []);
      groups.get(c.pathId).push({ x: c.args[0], y: c.args[1] });
    }
  });

  // 2. 取点数最多的那组（= 主折线）
  let best = [];
  groups.forEach((pts) => {
    if (pts.length > best.length) best = pts;
  });
  return best;
}

/**
 * 统计箭头三角数量。
 * 三角形 = 独立路径内 closePath + fill，且填充色等于给定 color。
 * 坐标轴的箭头颜色是 borderLight，因此按序列色过滤即可排除。
 */
function triangleCount(calls, color) {
  const fillPaths = new Set();
  calls.forEach((c) => {
    if (c.op === 'closePath' && (!color || c.state.fillStyle === color)) fillPaths.add(c.pathId);
  });
  // 必须有对应的 fill 才算真正画出来的三角
  let n = 0;
  fillPaths.forEach((id) => {
    if (calls.some((c) => c.op === 'fill' && c.pathId === id)) n++;
  });
  return n;
}

console.log('\n=== 走势图诊断 · chart.js ===');

// ============================================================
section('[1] arrowLine 箭头指向');

{
  const ctx = makeCtx();
  // 向右的线：终点 x2 > x1，箭头三角应落在 x2 附近（x >= x2 - headSize）
  arrowLine(ctx, 0, 0, 100, 0, '#fff', 2, 8);
  const pts = linePts(ctx.calls);
  // 线段 2 点 + 箭头三角 3 点（moveTo + 2 lineTo）= 5 点
  check('arrowLine 画出了线段与箭头三角（共 5 个路径点）',
    pts.length === 5, `点数=${pts.length}`);
  check('arrowLine 线段从起点到终点',
    pts[0].x === 0 && pts[0].y === 0 && pts[1].x === 100 && pts[1].y === 0,
    JSON.stringify(pts.slice(0, 2)));
  // 三角：fill 之前的 moveTo/lineTo 应围绕终点 (100,0)
  check('arrowLine 箭头三角形心贴近终点',
    ctx.calls.some((c) => c.op === 'fill'), '缺少 fill');

  const ctx2 = makeCtx();
  // 向下的线（纵轴向下增长是画布惯例时用不到，但函数本身必须正确）
  arrowLine(ctx2, 50, 10, 50, 90, '#fff', 2, 8);
  const pts2 = linePts(ctx2.calls);
  check('arrowLine 竖直线正确（x 恒定）',
    pts2[0].x === 50 && pts2[1].x === 50 && pts2[0].y === 10 && pts2[1].y === 90,
    JSON.stringify(pts2));
}

// ============================================================
section('[2] lineChart 基本几何');

const S1 = {
  x: 40, y: 20, w: 200, h: 120,
  series: [{ name: 'A', color: '#FFB000', values: [10, 12, 11, 15, 14] }],
  xLabels: ['一', '二', '三', '四', '五'],
  yTicks: 4,
  animate: 1,
};
{
  const ctx = makeCtx();
  lineChart(ctx, S1);

  check('lineChart 绘制了纵轴刻度标签', labels(ctx.calls).some((l) => l.startsWith('¥')),
    JSON.stringify(labels(ctx.calls)));
  check('lineChart 绘制了横轴标签', labels(ctx.calls).includes('一'), JSON.stringify(labels(ctx.calls)));

  // ---- 只取数据折线的点（坐标轴/网格线会污染边界）----
  const plotX = S1.x + 40;              // 纵轴标签留白 40
  const plotRight = S1.x + S1.w;
  const plotTop = S1.y;
  const plotBottom = S1.y + S1.h - 14;  // 横轴标签留白 14

  const pts = ptsByColor(ctx.calls, '#FFB000');
  const ys = pts.map((p) => p.y);
  check('取到该序列的折线点（5 个）', pts.length === 5, `点数=${pts.length}`);

  check('折线点落在图区内（水平）',
    pts.every((p) => p.x >= plotX - 1 && p.x <= plotRight + 1),
    JSON.stringify(pts.map((p) => Math.round(p.x))));
  check('折线点落在图区内（垂直）',
    pts.every((p) => p.y >= plotTop - 1 && p.y <= plotBottom + 1),
    JSON.stringify(pts.map((p) => Math.round(p.y))));

  // 折线的点按数据顺序返回（moveTo/i=0 在前，lineTo/i=1.. 依次）
  // values = [10, 12, 11, 15, 14]
  check('折线点数量 = 数据点数（5）', pts.length === 5, `点数=${pts.length}`);
  check('折线有起伏（最高值与最低值 y 不等）',
    Math.max(...ys) - Math.min(...ys) > 4,
    `y 跨度=${(Math.max(...ys) - Math.min(...ys)).toFixed(1)}`);

  // 数值更大 → y 更小（画布 y 向下增长）
  // values[0]=10 vs values[1]=12：y(12) 必须小于 y(10)
  check('数值越大 y 越小（坐标轴方向正确，v=12 的 y < v=10 的 y）',
    pts.length === 5 && pts[1].y < pts[0].y,
    `v=10 -> y=${pts[0] && pts[0].y.toFixed(1)} / v=12 -> y=${pts[1] && pts[1].y.toFixed(1)}`);
  // 最强断言：全序列单调性与数据一致（15 是最大值，其 y 必须是最小）
  const maxValIdx = 3; // values[3] = 15
  check('数据最大值对应纵轴最上方（y 最小）',
    pts.length === 5 && Math.min(...ys) === pts[maxValIdx].y,
    `v=15 的 y=${pts.length === 5 ? pts[maxValIdx].y.toFixed(1) : 'n/a'} 最小 y=${Math.min(...ys).toFixed(1)}`);

  const dots = ctx.calls.filter((c) => c.op === 'fillRect');
  check('末端数据点有实心方块（fillRect）', dots.length >= 2, `fillRect 次数=${dots.length}`);
}

// ============================================================
section('[3] 全平线 / 单点 边界');

{
  const ctx = makeCtx();
  // 全部相同 → 不能除零、不能产生 NaN
  lineChart(ctx, {
    x: 0, y: 0, w: 100, h: 60,
    series: [{ color: '#fff', values: [5, 5, 5, 5] }],
    animate: 1,
  });
  const bad = [...linePts(ctx.calls), ...ctx.calls.filter((c) => c.op === 'fillText').map((c) => ({ x: c.args[1], y: c.args[2] }))]
    .some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y));
  check('全平线不产生 NaN/Infinity 坐标', !bad);
  check('全平线仍绘制出内容', ctx.calls.length > 0);

  const ctx2 = makeCtx();
  lineChart(ctx2, {
    x: 0, y: 0, w: 100, h: 60,
    series: [{ color: '#fff', values: [7] }],
    animate: 1,
  });
  const bad2 = linePts(ctx2.calls).some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y));
  check('单点序列不产生 NaN 坐标', !bad2);
}

// ============================================================
section('[4] 生长动画越界');

{
  const values = [10, 20, 15, 25, 30, 28, 33, 40];
  let ok = true;
  let detail = '';
  for (const t of [0, 0.3, 0.5, 0.99, 1]) {
    const ctx = makeCtx();
    lineChart(ctx, {
      x: 0, y: 0, w: 160, h: 80,
      series: [{ color: '#fff', values }],
      animate: t,
    });
    const pts = linePts(ctx.calls);
    const outside = pts.filter((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y));
    if (outside.length) { ok = false; detail = `animate=${t} 出现非法点`; }
  }
  check('任意动画进度下坐标均合法', ok, detail);

  // animate 超范围（>1 或 <0）应被夹紧而不是崩
  let clamped = true;
  try {
    const ctx = makeCtx();
    lineChart(ctx, { x: 0, y: 0, w: 160, h: 80, series: [{ color: '#fff', values }], animate: 3 });
    const ctx2 = makeCtx();
    lineChart(ctx2, { x: 0, y: 0, w: 160, h: 80, series: [{ color: '#fff', values }], animate: -2 });
  } catch (e) {
    clamped = false;
  }
  check('animate 越界被夹紧而非抛错', clamped);

  // animate=0 时末端不应画箭头的三角（closePath）。
  // ⚠️ 坐标轴的两个箭头也会 closePath，必须只统计序列色的三角。
  {
    const ctx = makeCtx();
    lineChart(ctx, { x: 0, y: 0, w: 160, h: 80, series: [{ color: '#FFB000', values }], animate: 0 });
    const seriesTri = triangleCount(ctx.calls, '#FFB000');
    check('animate=0 时不画折线末端箭头三角', seriesTri === 0, `序列三角数=${seriesTri}`);

    // 反之 animate=1 时必须恰好有一个末端箭头
    const ctx2 = makeCtx();
    lineChart(ctx2, { x: 0, y: 0, w: 160, h: 80, series: [{ color: '#FFB000', values }], animate: 1 });
    check('animate=1 时恰有 1 个末端箭头三角',
      triangleCount(ctx2.calls, '#FFB000') === 1,
      `序列三角数=${triangleCount(ctx2.calls, '#FFB000')}`);

    // endArrow=false 时不应有序列三角
    const ctx3 = makeCtx();
    lineChart(ctx3, { x: 0, y: 0, w: 160, h: 80, series: [{ color: '#FFB000', values }], animate: 1, endArrow: false });
    check('endArrow=false 时不画末端箭头',
      triangleCount(ctx3.calls, '#FFB000') === 0,
      `序列三角数=${triangleCount(ctx3.calls, '#FFB000')}`);
  }
}

// ============================================================
section('[5] 空数据 / 退化尺寸');

{
  let threw = false;
  const cases = [
    { label: '空 series', opts: { x: 0, y: 0, w: 100, h: 60, series: [] } },
    { label: '空 values', opts: { x: 0, y: 0, w: 100, h: 60, series: [{ color: '#fff', values: [] }] } },
    { label: '宽度不足', opts: { x: 0, y: 0, w: 10, h: 60, series: [{ color: '#fff', values: [1, 2] }] } },
    { label: '高度不足', opts: { x: 0, y: 0, w: 100, h: 5, series: [{ color: '#fff', values: [1, 2] }] } },
  ];
  for (const c of cases) {
    try {
      const ctx = makeCtx();
      lineChart(ctx, c.opts);
    } catch (e) {
      threw = true;
      console.log(`       ${c.label} 抛错: ${e.message}`);
    }
  }
  check('空数据/退化尺寸不抛异常', !threw);
}

// ============================================================
section('[6] chartLegend 涨红跌绿');

{
  const ctx = makeCtx();
  const h = chartLegend(ctx, 0, 0, 200, [
    { name: '涨', color: '#FFB000', change: 0.12 },
    { name: '跌', color: '#4A9EFF', change: -0.08 },
    { name: '平', color: '#C77DFF', change: 0 },
  ]);
  check('chartLegend 返回总高度', h === 3 * 16, `h=${h}`);

  const texts = ctx.calls.filter((c) => c.op === 'fillText');
  const up = texts.find((c) => String(c.args[0]) === '+12.0%');
  const down = texts.find((c) => String(c.args[0]) === '-8.0%');
  const flat = texts.find((c) => String(c.args[0]) === '0.0%');

  check('涨幅文案带 + 号', !!up, JSON.stringify(texts.map((t) => t.args[0])));
  check('跌幅文案带 - 号', !!down);
  check('平盘文案为 0.0%（不带 + 号）', !!flat, JSON.stringify(texts.map((t) => t.args[0])));
  check('★ 涨用红色（中国股市惯例）', up && up.state.fillStyle === STOCK.up,
    `实际 ${up && up.state.fillStyle} / 期望 ${STOCK.up}`);
  check('★ 跌用绿色（中国股市惯例）', down && down.state.fillStyle === STOCK.down,
    `实际 ${down && down.state.fillStyle} / 期望 ${STOCK.down}`);
  check('平盘用灰色', flat && flat.state.fillStyle === STOCK.flat);

  // 文字右对齐到 x+w
  check('涨跌幅右对齐到图例右边界',
    up && up.state.textAlign === 'right', up && up.state.textAlign);

  // 不显示涨跌幅时不应有百分比文案
  const ctx2 = makeCtx();
  chartLegend(ctx2, 0, 0, 200, [{ name: '甲', color: '#fff', change: 0.5 }], { showChange: false });
  check('showChange=false 时不输出百分比',
    !ctx2.calls.some((c) => c.op === 'fillText' && String(c.args[0]).includes('%')));
}

// ============================================================
section('[7] 多序列共存');

{
  const ctx = makeCtx();
  lineChart(ctx, {
    x: 0, y: 0, w: 200, h: 100,
    series: [
      { name: 'A', color: '#FFB000', values: [10, 20, 30] },
      { name: 'B', color: '#4A9EFF', values: [30, 20, 10] },
      { name: 'C', color: '#C77DFF', values: [20, 25, 22] },
    ],
    endArrow: true,
    animate: 1,
  });
  const strokes = ctx.calls.filter((c) => c.op === 'stroke');
  check('多序列各自绘制折线（stroke 次数足够）', strokes.length >= 3, `stroke=${strokes.length}`);

  const colors = new Set(ctx.calls.filter((c) => c.op === 'stroke' || c.op === 'fill').map((c) => c.state.strokeStyle || c.state.fillStyle));
  check('三个序列颜色均出现',
    colors.has('#FFB000') && colors.has('#4A9EFF') && colors.has('#C77DFF'));

  // 范围应覆盖全部数据：A 从 10 涨到 30，其首尾点 y 应有明显差距
  const aPts = ptsByColor(ctx.calls, '#FFB000');
  check('序列 A 折线取到 3 个点', aPts.length === 3, `点数=${aPts.length}`);
  check('序列 A 首点 y > 末点 y（10 → 30 上涨）',
    aPts.length === 3 && aPts[0].y > aPts[2].y,
    aPts.length === 3 ? `${aPts[0].y.toFixed(1)} -> ${aPts[2].y.toFixed(1)}` : 'n/a');

  // 序列 B 反向（30 → 10），首点 y < 末点 y
  const bPts = ptsByColor(ctx.calls, '#4A9EFF');
  check('序列 B 首点 y < 末点 y（30 → 10 下跌）',
    bPts.length === 3 && bPts[0].y < bPts[2].y,
    bPts.length === 3 ? `${bPts[0].y.toFixed(1)} -> ${bPts[2].y.toFixed(1)}` : 'n/a');

  // A 与 B 在同一 x 上应上下分离（一个涨一个跌）
  check('同 x 处 A 与 B 分居上下（两序列不重叠）',
    bPts.length === 3 && aPts.length === 3 && aPts[0].y > bPts[0].y && aPts[2].y < bPts[2].y);
}

// ============================================================
console.log('\n=== 结果 ===');
if (failed) {
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  console.log('走势图诊断未通过 ✗');
  process.exit(1);
} else {
  console.log(`通过 ${passed} 项，失败 0 项`);
  console.log('走势图诊断通过 ✓');
}
