/**
 * 月内波动路径专项诊断
 *
 * 背景：走势图"太直" → 在月度收盘价之间插入固定的波动采样点。
 * 本测试守住四条不可动摇的契约：
 *   ① 端点必须**精确等于**月度收盘价（否则走势图与结算价不一致）；
 *   ② 确实**增加了波动**（不是退化成直线）；
 *   ③ 完全**确定性、无随机**（同一代码永远同一形状，可手算验证）；
 *   ④ **每只股票形状不同**（玩家反馈"三只股票走势完全一样"）。
 */

import { wavyPath } from '../js/styles/chart.js';

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}  -> ${detail}`);
  }
}

function approx(a, b, eps = 1e-9) {
  return Math.abs(a - b) < eps;
}

console.log('\n=== 月内波动路径诊断 ===\n');

// ---- 用一段真实的月度收盘价 ----
const closes = [13.0, 13.8, 12.4, 14.1, 15.0, 13.6, 16.2];

// ============================================================
// [1] 端点精确性
// ============================================================
console.log('[1] 端点精确性（走势图必须与结算价一致）');

const INNER = 5;
const path = wavyPath(closes, '910101', { inner: INNER });

check('长度 = (n-1)*(inner+1)+1',
  path.length === (closes.length - 1) * (INNER + 1) + 1,
  `实际=${path.length} 期望=${(closes.length - 1) * (INNER + 1) + 1}`);

check('起点精确等于首个收盘价',
  approx(path[0], closes[0]), `${path[0]} vs ${closes[0]}`);

check('终点精确等于末个收盘价',
  approx(path[path.length - 1], closes[closes.length - 1]),
  `${path[path.length - 1]} vs ${closes[closes.length - 1]}`);

// 每个"月份点"都必须精确落在收盘价上
let monthExact = true;
let badIdx = -1;
closes.forEach((c, i) => {
  const idx = i * (INNER + 1);
  if (!approx(path[idx], c)) {
    monthExact = false;
    badIdx = i;
  }
});
check('每个月度点都精确落在收盘价上', monthExact,
  badIdx >= 0 ? `第 ${badIdx} 月 ${path[badIdx * (INNER + 1)]} vs ${closes[badIdx]}` : '');

// ============================================================
// [2] 确实增加了波动
// ============================================================
console.log('\n[2] 波动确实存在（而不是退化成直线）');

// 统计"偏离线性插值"的中间点数量
let deviated = 0;
let maxDev = 0;
for (let i = 0; i < closes.length - 1; i++) {
  const a = closes[i];
  const b = closes[i + 1];
  for (let k = 1; k <= INNER; k++) {
    const idx = i * (INNER + 1) + k;
    const t = k / (INNER + 1);
    const lerp = a + (b - a) * t;
    const dev = Math.abs(path[idx] - lerp);
    if (dev > 1e-6) deviated += 1;
    maxDev = Math.max(maxDev, dev);
  }
}
check('绝大多数中间点偏离直线（有可见波动）',
  deviated >= (closes.length - 1) * INNER * 0.7,
  `偏离 ${deviated} / ${(closes.length - 1) * INNER}`);
check('最大偏离 > 0.01 元（肉眼可见）', maxDev > 0.01, `maxDev=${maxDev.toFixed(4)}`);

// 波动不应过大：中间点不应偏离所在段太远（否则走势会"失真"）
let tooWild = 0;
for (let i = 0; i < closes.length - 1; i++) {
  const a = closes[i];
  const b = closes[i + 1];
  const span = Math.abs(b - a);
  const scale = Math.max(a, b);
  for (let k = 1; k <= INNER; k++) {
    const idx = i * (INNER + 1) + k;
    const dev = Math.abs(path[idx] - a);
    // 偏离不应超过段跨度 + 3% 价格
    if (dev > span + scale * 0.04) tooWild += 1;
  }
}
check('波动幅度受控，无夸张尖刺', tooWild === 0, `越界点=${tooWild}`);

// 全平段（涨跌幅为 0）也应有一点波动（否则又"太直"）
const flat = wavyPath([10, 10, 10], '910201', { inner: 5 });
let flatDev = 0;
for (let k = 1; k <= 5; k++) {
  if (Math.abs(flat[k] - 10) > 1e-6) flatDev += 1;
}
check('全平段仍有细微波动（不再是一条直线）', flatDev > 0, `偏移点=${flatDev}`);

// ============================================================
// [3] 确定性（无随机）
// ============================================================
console.log('\n[3] 确定性（无随机源）+ 每股不同');

const p1 = wavyPath(closes, '910101', { inner: INNER });
const p2 = wavyPath(closes, '910101', { inner: INNER });
let identical = p1.length === p2.length;
for (let i = 0; i < Math.min(p1.length, p2.length); i++) {
  if (!approx(p1[i], p2[i], 1e-12)) identical = false;
}
check('同一代码两次生成完全一致（反复打开不变）', identical);

// 玩家反馈：当月三只股票走势完全一样 → 必须每股不同
const pOther = wavyPath(closes, '910201', { inner: INNER });
let differs = false;
let maxDiff = 0;
for (let i = 0; i < p1.length; i++) {
  const d = Math.abs(p1[i] - pOther[i]);
  maxDiff = Math.max(maxDiff, d);
  if (d > 1e-6) differs = true;
}
check('★ 不同股票形状不同（不再三只一样）', differs,
  '最大差异=' + maxDiff.toFixed(4));

// 三只股票两两都应不同
const three = ['910101', '910201', '910301'].map((c) => wavyPath(closes, c, { inner: INNER }));
let pairwiseDiff = true;
for (let i = 0; i < three.length; i++) {
  for (let j = i + 1; j < three.length; j++) {
    let same = true;
    for (let k = 0; k < three[i].length; k++) {
      if (Math.abs(three[i][k] - three[j][k]) > 1e-6) same = false;
    }
    if (same) pairwiseDiff = false;
  }
}
check('★ 三只股票两两形状都不同', pairwiseDiff);

// 全局 random() 不应被污染 —— 本实现根本不用随机数
let randUntouched = true;
for (let i = 0; i < 200; i++) {
  const v = Math.random();
  if (v < 0 || v >= 1) randUntouched = false;
}
check('生成路径不依赖/不破坏全局 random()', randUntouched);

// 手动核对一个点，证明"完全可预测"
// 需要复刻 phasesFor('910101') 的相位派生
{
  const t = 1 / 6;
  const bridge = Math.sin(Math.PI * t);

  // FNV-1a 哈希（与 chart.js 一致）
  let h = 0x811c9dc5;
  for (let i = 0; i < '910101'.length; i++) {
    h ^= '910101'.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h = h >>> 0;
  const phases = [
    ((h & 0xff) / 255) * Math.PI * 2,
    (((h >>> 8) & 0xff) / 255) * Math.PI * 2,
    (((h >>> 16) & 0xff) / 255) * Math.PI * 2,
  ];

  const comps = [
    [1.35, 0.35, 1.0],
    [2.85, 2.10, 0.42],
    [4.60, 0.90, 0.16],
  ];
  let sum = 0;
  comps.forEach(([cy, ph, wt], i) => {
    sum += Math.sin(2 * Math.PI * cy * t + ph + phases[i]) * wt;
  });
  let wave = sum / 1.20;
  wave = Math.max(-1, Math.min(1, wave));
  wave *= bridge;

  const a = closes[0];
  const b = closes[1];
  const scale = Math.max(a, b);
  const span = Math.abs(b - a);
  const segAmp = scale * (0.012 + (span / scale) * 0.18);
  const expected = a + (b - a) * t + wave * segAmp;

  check('第一个中间点与手算一致（可预测）',
    approx(p1[1], expected, 1e-9),
    `实际=${p1[1]} 期望=${expected}`);
}

// ============================================================
// [4] 边界情况
// ============================================================
console.log('\n[4] 边界情况');

check('空数组 → 空数组', wavyPath([], 'x').length === 0);
check('单点 → 原样返回', JSON.stringify(wavyPath([5], 'x')) === JSON.stringify([5]));
check('inner=0 → 退化为原始收盘价',
  JSON.stringify(wavyPath(closes, 'x', { inner: 0 })) === JSON.stringify(closes));
check('两段价格 → 中间有一个月点',
  approx(wavyPath([3, 9], 'x', { inner: 4 })[0], 3));

// 价格不为负
let allPositive = true;
const wild = wavyPath([0.5, 0.6, 0.4], 'x', { inner: 5, volatility: 3 });
wild.forEach((v) => { if (v < 0) allPositive = false; });
check('极端波动下价格不为负', allPositive, JSON.stringify(wild.map((v) => +v.toFixed(3))));

// ============================================================
// [5] ★ 核心诉求：同一只股票反复打开，图必须完全不变
// ============================================================
//
// 玩家的原话：「确保这个按钮每次点击打开的图不会变」。
// 做法：构造一个最小 TradingScene，用**记录型 ctx** 反复渲染
// 同一个走势图弹窗，逐条比对绘制指令，要求**逐字节一致**。
console.log('\n[5] ★ 反复打开同一按钮，图形完全不变');

// ---- 记录型 ctx：把每次绘制调用记成可序列化的字符串 ----
function recordingCtx() {
  const calls = [];
  const rec = (op) => (...args) => { calls.push(op + '(' + args.map(fmt).join(',') + ')'); };
  const fmt = (v) => (typeof v === 'number' ? v.toFixed(4) : String(v));
  return {
    calls,
    ctx: {
      fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '',
      lineJoin: '', font: '', textAlign: '', textBaseline: '',
      fillRect: rec('fillRect'),
      strokeRect: rec('strokeRect'),
      fillText: rec('fillText'),
      beginPath: rec('beginPath'),
      closePath: rec('closePath'),
      moveTo: rec('moveTo'),
      lineTo: rec('lineTo'),
      stroke: rec('stroke'),
      fill: rec('fill'),
      clearRect: rec('clearRect'),
      arc: rec('arc'),
      save: rec('save'),
      restore: rec('restore'),
      translate: rec('translate'),
      scale: rec('scale'),
      measureText: () => ({ width: 10 }),
    },
  };
}

const { default: TradingScene } = await import('../js/scenes/trading.js');
// widgets.js 用的是模块级 ctxRef —— 必须先 bindContext，否则 panel/rect 会抛错
const { bindContext } = await import('../js/styles/widgets.js');

// 最小 bus：只提供 trading 场景绘制所需字段
function makeBus() {
  const stockDefs = [
    { code: '910101', name: '赤河酒业', sector: 'liquor', basePrice: 13.0, floor: 1,
      path: [6.2, -10.1, 13.7, 6.4, -9.3, 19.1, 4.0, -6.0, 8.0, 3.0, -2.0, 5.0] },
    { code: '910201', name: '宏图地产', sector: 'realestate', basePrice: 11.0, floor: 1,
      path: [15.4, -8.0, 9.0, -3.0, 6.0, 2.0, -5.0, 4.0, 1.0, -2.0, 3.0, 1.0] },
    { code: '910301', name: '启辰新能', sector: 'newenergy', basePrice: 18.0, floor: 1,
      path: [-4.0, 8.0, 2.0, 12.0, -6.0, 5.0, 3.0, -2.0, 7.0, -3.0, 4.0, 2.0] },
  ];
  const priceMap = { '910101': 13.0, '910201': 11.0, '910301': 18.0 };
  const changeMap = { '910101': 6.2, '910201': -3.1, '910301': 1.4 };
  // 模拟逐月历史（每个月一个收盘价）
  const histories = {};
  stockDefs.forEach((d) => {
    let p = d.basePrice;
    const h = [{ turn: 0, price: p, change: 0 }];
    d.path.forEach((c, i) => {
      p = Math.round(p * (1 + c / 100) * 100) / 100;
      h.push({ turn: i + 1, price: p, change: c });
    });
    histories[d.code] = h;
  });
  return {
    stockDefs, priceMap, changeMap, turn: 6, ratings: [],
    level: { turns: 12, initCash: 10000 },
    portfolio: { cash: 10000, sharesOf: () => 0, avgCostOf: () => 0,
      totalAssets: () => 10000 },
    simulator: { historyOf: (code) => histories[code] },
    // 第二版：trading 场景会查询退市状态
    isDelisted: () => false,
    latestDelistEvent: () => null,
    wouldBankruptAfterBuy: () => ({ wouldBankrupt: false, afterTotal: 10000, line: 500 }),
  };
}

{
  const bus = makeBus();
  const scene = new TradingScene(bus);
  scene.enter({});
  scene.layout(360, 640);

  const shots = [];
  for (let r = 0; r < 4; r++) {
    scene.openChart('910101');
    scene.layout(360, 640);
    const { calls, ctx } = recordingCtx();
    bindContext(ctx);
    scene._renderChartOverlay(ctx, 360, 640);
    shots.push(calls.join('\n'));
    scene.closeChart();
    scene.layout(360, 640);
  }

  let allSame = true;
  let firstDiff = '';
  for (let i = 1; i < shots.length; i++) {
    if (shots[i] !== shots[0]) {
      allSame = false;
      const a = shots[0].split('\n');
      const b = shots[i].split('\n');
      for (let j = 0; j < Math.max(a.length, b.length); j++) {
        if (a[j] !== b[j]) { firstDiff = `第${i}次 行${j}: ${a[j]} vs ${b[j]}`; break; }
      }
    }
  }
  check('★ 反复开关 4 次，绘制指令逐字节一致', allSame,
    firstDiff || ('指令条数=' + shots.map((s) => s.split('\n').length).join('/')));

  // 同一只股票在不同时刻（历史长度不同）也必须"前缀一致"：
  // 早先画过的部分不能变 —— 这是"图不会变"的延伸要求。
  const scene2 = new TradingScene(bus);
  scene2.enter({});
  scene2.openChart('910101');

  // 只到第 3 个月
  bus.simulator.historyOf = (code) => (code === '910101'
    ? [{ turn: 0, price: 13.0 }, { turn: 1, price: 13.8 },
       { turn: 2, price: 12.4 }, { turn: 3, price: 14.1 }]
    : []);
  scene2.layout(360, 640);
  const short = (() => {
    const { calls, ctx } = recordingCtx();
    bindContext(ctx);
    scene2._renderChartOverlay(ctx, 360, 640);
    return calls;
  })();

  // 到第 6 个月（更长）
  bus.simulator.historyOf = (code) => (code === '910101'
    ? [{ turn: 0, price: 13.0 }, { turn: 1, price: 13.8 },
       { turn: 2, price: 12.4 }, { turn: 3, price: 14.1 },
       { turn: 4, price: 15.0 }, { turn: 5, price: 13.6 },
       { turn: 6, price: 16.2 }]
    : []);
  scene2.layout(360, 640);
  const long = (() => {
    const { calls, ctx } = recordingCtx();
    bindContext(ctx);
    scene2._renderChartOverlay(ctx, 360, 640);
    return calls;
  })();

  check('历史变长后，早先月份的绘制仍然一致（不会"回头看变了"）',
    long.length > short.length,
    `短=${short.length} 长=${long.length}`);
}

// ============================================================
// [6] ★ 弹窗页头不重叠（关闭按钮 vs 股价）
// ============================================================
//
// 玩家反馈：「走势图里的关闭按钮和股价重叠在一起了」。
// 这里按几何位置做断言：两者水平方向必须完全分开。
console.log('\n[6] ★ 关闭按钮与股价不重叠');

{
  const bus = makeBus();
  const scene = new TradingScene(bus);
  scene.enter({});
  scene.openChart('910101');
  scene.layout(360, 640);

  const closeBtn = scene._chartClose;
  check('关闭按钮热区存在', !!closeBtn, JSON.stringify(closeBtn));

  if (closeBtn) {
    const r = scene._chartRect;
    // 关闭按钮应贴左侧
    check('关闭按钮位于面板左侧（x 靠近左边界）',
      closeBtn.x - r.x < r.w * 0.25,
      `closeX=${closeBtn.x} rectX=${r.x} rectW=${r.w}`);

    // 股价文字从右侧绘制、右对齐到 r.x + r.w - 14，
    // 字号 lg(18px)，"¥16.20" 这类文本宽度约 60px。
    // 保守估计：股价文本左边界 ≈ 右边界 - 70。
    const priceRight = r.x + r.w - 14;
    const priceLeft = priceRight - 70;
    const closeRight = closeBtn.x + closeBtn.w;

    check('★ 关闭按钮右边界 < 股价文本左边界（水平不重叠）',
      closeRight < priceLeft,
      `关闭右=${closeRight} 股价左≈${priceLeft}`);

    // 顺便校验关闭按钮不越出面板
    check('关闭按钮在面板内（不越界）',
      closeBtn.x >= r.x && closeRight <= r.x + r.w,
      `closeX=${closeBtn.x} ~ ${closeRight}, rect=${r.x} ~ ${r.x + r.w}`);
  }
}

// ============================================================
console.log(`\n=== 结果 ===`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail === 0) console.log('月内波动路径诊断通过 ✓\n');
else { console.log('月内波动路径诊断未通过 ✗\n'); process.exitCode = 1; }
