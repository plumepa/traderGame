/**
 * 诊断：破产判定的三个时机（修复「玩家不会破产」）
 *
 * ============================================================
 * 玩家报的 bug（原文）
 * ============================================================
 *   「巨大bug，玩家不会破产，我现在剩余800块但是买不起任何一只股票，
 *     没有触发破产，触发破产1.股票退市后判定一次，2. 卖出判定
 *     3. 每关开始前是否有足够资金买入一股」
 *
 * ============================================================
 * 根因
 * ============================================================
 * `Simulator.lowestPrice()` 把**已退市**的股票也算进了"最低价"。
 *
 *   退市股的清算价由 pathgen 随机生成在 ¥0.50 ~ ¥1.70（见 rollDelist），
 *   触发退市后它被**冻结**在 states 里不再波动 —— 而它已经买不到了。
 *
 *   于是「破产线 = 最低价 × 100」被压到 ¥50~170：
 *     玩家手里剩 ¥800、三只票一手都买不起，总资产 ¥800 > ¥80 →
 *     判定为「没破产」。这就是"玩家不会破产"的机制原因。
 *
 * 另外两个时机当时**根本没有判定点**（全项目只有 2 处 checkBankrupt，
 * 都在"卖出之后"这条路上）：
 *   · 退市清算之后没有重新判定 —— 可买标的变少，一手成本反而抬高
 *   · 每关开始时没有判定 —— 连闯的本金是上一关的期末资产，可能已经不够
 *
 * ============================================================
 * 本文件的双重身份
 * ============================================================
 *   修复前：它是**复现脚本**，[1][5][6] 会红，把上面的分析钉死成证据。
 *   修复后：它是**回归测试**，保证三个判定点都真的接上了，
 *          并顺带量出"每月结算后判定"对平衡的实际影响（误杀率）。
 *
 * 运行：
 *   node --experimental-loader ./tools/register.mjs tools/diag-bankrupt.mjs
 */

import { makeAudioContext } from './wx-audio.mjs';

// =================================================================
// 0. 打桩（Part B 要真起 Main，必须给全 wx.*）
// =================================================================

const CTX_METHODS = [
  'save', 'restore', 'scale', 'translate', 'rotate', 'setTransform', 'resetTransform',
  'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo',
  'arc', 'arcTo', 'quadraticCurveTo', 'bezierCurveTo', 'rect', 'fill', 'stroke', 'clip',
  'fillText', 'strokeText', 'drawImage', 'setLineDash', 'getLineDash',
];

function makeCtx(canvas) {
  const ctx = {
    canvas,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    shadowBlur: 0,
    shadowColor: '#000',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
  };
  for (const m of CTX_METHODS) {
    ctx[m] = () => {
      if (m === 'measureText') return { width: 6 };
      return undefined;
    };
  }
  ctx.measureText = (s) => ({ width: String(s ?? '').length * 6 });
  const grad = () => ({ addColorStop() {} });
  ctx.createLinearGradient = grad;
  ctx.createRadialGradient = grad;
  ctx.createPattern = () => null;
  return ctx;
}

function makeCanvas() {
  const canvas = { width: 375, height: 667 };
  let ctx = null;
  canvas.getContext = (t) => {
    if (t !== '2d') return null;
    if (!ctx) ctx = makeCtx(canvas);
    return ctx;
  };
  return canvas;
}

globalThis.wx = {
  createCanvas: () => makeCanvas(),
  createImage: () => ({}),
  getSystemInfoSync: () => ({
    windowWidth: 375, windowHeight: 667, screenWidth: 375, screenHeight: 667,
    pixelRatio: 3, platform: 'devtools', system: 'iOS 16.0', brand: 'devtools',
    model: 'iPhone X', language: 'zh_CN', SDKVersion: '3.16.3',
  }),
  onTouchStart() {}, onTouchMove() {}, onTouchEnd() {}, onTouchCancel() {},
  onShow() {}, onHide() {}, onError() {}, offTouchStart() {},
  setPreferredFramesPerSecond() {}, request() {},
  setStorageSync() {}, getStorageSync() { return ''; },
  createInnerAudioContext: () => makeAudioContext(),
  setInnerAudioOption() {}, showToast() {}, vibrateShort() {},
};
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

// =================================================================
// 1. 断言框架
// =================================================================

let fails = 0;
let count = 0;
function chk(desc, cond, extra) {
  count++;
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + '  ' + desc + (extra ? '   (' + extra + ')' : ''));
  if (!cond) fails++;
}

// =================================================================
// 2. 加载
// =================================================================

const { default: DataBus } = await import('../js/core/databus.js');
const { LOT_SIZE, costToBuy, maxLots } = await import('../js/market/order.js');

/**
 * 造一个"手里只剩 cash、空仓"的局面，并把所有未退市股票的价格抬到 price。
 * 这样"最低一手成本"就是 price × 100 + 5，判定结果是确定性的。
 */
function trap(bus, cash, price) {
  bus.portfolio.cash = cash;
  bus.portfolio.positions = {};
  bus.stockDefs.forEach((d) => {
    if (!bus.isDelisted(d.code)) {
      bus.simulator.states[d.code].price = price;
      bus.priceMap[d.code] = price;
    }
  });
}

// =================================================================
console.log('=== 1. 破产线口径：必须排除已退市的股票 ===\n');

{
  const bus = new DataBus();
  bus.start('lv_01');
  bus.nextTurn();

  // 强制第 1 只在本回合爆雷退市
  const d0 = bus.stockDefs[0];
  d0.delistAt = 1;
  d0.delistPrice = 0.8;
  bus.settle();

  chk('本回合确实发生了退市', bus.isDelisted(d0.code) && !!bus.latestDelistEvent(),
    `delisted=${bus.isDelisted(d0.code)}`);

  // 另两只抬到 ¥15 → 一手 ¥1505；玩家手里只有 ¥800 且空仓
  trap(bus, 800, 15);

  const line = bus.bankruptLine();
  const lowest = bus.simulator.lowestPrice();
  const total = bus.portfolio.totalAssets(bus.priceMap);

  console.log(`    退市股清算价 ¥${bus.priceMap[d0.code].toFixed(2)}`);
  console.log(`    未退市两只  ¥${bus.priceMap[bus.stockDefs[1].code].toFixed(2)} / ¥${bus.priceMap[bus.stockDefs[2].code].toFixed(2)}`);
  console.log(`    lowestPrice() = ¥${lowest.toFixed(2)}   破产线 ¥${line.toFixed(0)}   总资产 ¥${total.toFixed(0)}`);

  chk('★ lowestPrice() 不含退市股（应 ≈ ¥15，而不是 ¥0.8）',
    lowest > 10, `lowestPrice=¥${lowest.toFixed(2)}`);
  chk('★ 破产线按"买得到的最便宜一手"算（应 ≈ ¥1505）',
    line > 1000, `line=¥${line.toFixed(0)}`);
  chk('★ 手里 ¥800 买不起任何一只 → 必须判破产',
    bus.isBankrupt(), `isBankrupt=${bus.isBankrupt()}`);
}

// =================================================================
console.log('\n=== 2. 破产线 = 一手成本（含 ¥5 最低佣金）===\n');

{
  const bus = new DataBus();
  bus.start('lv_01');
  const p = bus.simulator.lowestPrice();
  const expect = costToBuy(p, LOT_SIZE);
  console.log(`    最低价 ¥${p.toFixed(2)} → 一手 ¥${(p * 100).toFixed(0)} + 佣金 ¥5 = ¥${expect.toFixed(0)}`);
  chk('bankruptLine() 与 costToBuy(最低价, 一手) 一致',
    Math.abs(bus.bankruptLine() - expect) < 1e-6,
    `line=¥${bus.bankruptLine().toFixed(2)} expect=¥${expect.toFixed(2)}`);
  chk('破产线严格高于"裸价 × 100"（把佣金算进去才叫"买得起"）',
    bus.bankruptLine() > p * LOT_SIZE,
    `line=¥${bus.bankruptLine().toFixed(2)} vs ¥${(p * LOT_SIZE).toFixed(2)}`);
}

// =================================================================
console.log('\n=== 3. 开局资金不足一手 → 直接判破产（数据层）===\n');

{
  // 池子里最低 floor = ¥2 → 一手 ¥200 + ¥5 = ¥205。
  // 拿 ¥100 开局，无论抽到哪三只都买不起任何一只。
  const bus = new DataBus();
  bus.start('lv_01', { initCash: 100 });
  const line = bus.bankruptLine();
  console.log(`    起始资金 ¥100   破产线 ¥${line.toFixed(0)}（最低可能的一手成本 ¥205）`);
  chk('起始资金 ¥100 < 一手成本 → 判破产', bus.isBankrupt());
  chk('此时现金 = 总资产（空仓）',
    Math.abs(bus.portfolio.cash - bus.portfolio.totalAssets(bus.priceMap)) < 1e-6);
}

// =================================================================
console.log('\n=== 4. 主循环集成（真起 Main，走真实事件流）===\n');

const Main = (await import('../js/main.js')).default;
const app = new Main();
const bus = app.bus;

function sceneName() {
  if (app.current === app.scenes.menu) return 'menu';
  if (app.current === app.scenes.trading) return 'trading';
  if (app.current === app.scenes.newsflash) return 'newsflash';
  if (app.current === app.scenes.result) return 'result';
  return '(unknown)';
}

// ---------------------------------------------------------------
console.log('  [4a] 退市清算后立刻判定一次');

{
  app.menu.emit('startGame', 'lv_01');
  chk('开局后进入新闻页', app.current === app.scenes.newsflash, sceneName());

  // 摆好陷阱：手里 ¥800 空仓；第 1 只本月退市；另两只抬到 ¥15
  const d0 = bus.stockDefs[0];
  d0.delistAt = 1;
  d0.delistPrice = 0.8;
  bus.stockDefs.forEach((d) => {
    if (d.code !== d0.code) bus.simulator.states[d.code].price = 15;
  });
  bus.portfolio.cash = 800;
  bus.portfolio.positions = {};

  app.newsflash.emit('closed'); // ← 真实入口：关掉新闻 → settle → 判定

  console.log(`    退市事件 ${bus.latestDelistEvent() ? bus.latestDelistEvent().name : '无'}` +
    `   破产线 ¥${bus.bankruptLine().toFixed(0)}   总资产 ¥${bus.portfolio.totalAssets(bus.priceMap).toFixed(0)}`);
  console.log(`    当前场景 = ${sceneName()}   结局 = ${bus.result ? bus.result.outcome : '(无)'}`);

  chk('★ 退市当月关掉新闻后直接跳到结算页（不再进交易页）',
    app.current === app.scenes.result, sceneName());
  chk('★ 结局 = bankrupt', !!bus.result && bus.result.outcome === 'bankrupt',
    bus.result && bus.result.outcome);
  chk('reason 点明是退市清算导致的',
    !!bus.result && /退市/.test(bus.result.reason), bus.result && bus.result.reason);
}

// ---------------------------------------------------------------
console.log('\n  [4b] 每关开始前判定：起始资金够不够买一手');

{
  // 造一个"上一关期末只剩 ¥100"的局面，点"进入下一关"
  bus.startRun('lv_01');
  bus.runResults = [{
    index: 1, step: 1, round: 1, levelId: 'lv_01',
    initCash: 10000, total: 100, profit: -9900, turns: 12, outcome: 'lose',
  }];
  bus.result = {
    outcome: 'lose', reason: '测试用', total: 100, init: 10000, profit: -9900,
    returnRate: -0.99, turns: 12, liquidation: null, delistEvents: [],
  };
  bus.phase = 'OVER';
  app.switchTo('result');

  app.result.emit('nextLevel'); // ← 真实入口

  console.log(`    起始资金 ¥${bus.initCash.toFixed(0)}   破产线 ¥${bus.bankruptLine().toFixed(0)}` +
    `   场景 ${sceneName()}   结局 ${bus.result ? bus.result.outcome : '(无)'}`);

  chk('★ 下一关本金 ¥100 不够一手 → 开局即判破产',
    !!bus.result && bus.result.outcome === 'bankrupt', bus.result && bus.result.outcome);
  chk('★ 没有进入第 1 个月的新闻页（直接停在结算页）',
    app.current === app.scenes.result, sceneName());
  chk('reason 点明是开局资金不足',
    !!bus.result && /(起始资金|开局|买不起)/.test(bus.result.reason),
    bus.result && bus.result.reason);
  chk('破产后 canContinue() = false（不给出"下一关"按钮）', !bus.canContinue());
}

// ---------------------------------------------------------------
console.log('\n  [4c] 卖出后判定（原有行为，回归）');

{
  app.menu.emit('startGame', 'lv_01');
  app.newsflash.emit('closed');
  chk('正常开局进入交易页', app.current === app.scenes.trading, sceneName());

  trap(bus, 100, 15);
  app.trading.emit('afterTrade'); // ← 真实入口

  chk('★ 卖出后现金买不起一手 → 判破产',
    !!bus.result && bus.result.outcome === 'bankrupt', bus.result && bus.result.outcome);
  chk('场景切到结算页', app.current === app.scenes.result, sceneName());
}

// ---------------------------------------------------------------
console.log('\n  [4d] 不误杀：满仓买入 / 正常开局');

{
  app.menu.emit('startGame', 'lv_01');
  app.newsflash.emit('closed');

  const cheapest = bus.stockDefs
    .filter((d) => !bus.isDelisted(d.code))
    .map((d) => ({ def: d, price: bus.priceMap[d.code] }))
    .sort((a, b) => a.price - b.price)[0];
  const lots = maxLots(cheapest.price, bus.portfolio.cash);
  app.trading._doBuy(cheapest.def, cheapest.price, lots * LOT_SIZE);

  console.log(`    满仓 ${lots} 手 @¥${cheapest.price}   现金 ¥${bus.portfolio.cash.toFixed(0)}` +
    `   总资产 ¥${bus.portfolio.totalAssets(bus.priceMap).toFixed(0)}   破产线 ¥${bus.bankruptLine().toFixed(0)}`);

  chk('满仓买入后现金可能低于破产线（正常）',
    bus.portfolio.cash < bus.bankruptLine() || lots === 0);
  chk('★ 满仓买入后不判破产（总资产口径）', !bus.isBankrupt());
  chk('★ 仍停留在交易页（没被误判跳走）',
    app.current === app.scenes.trading, sceneName());
}

// ---------------------------------------------------------------
console.log('\n  [4e] 不误杀：初始 ¥6000 在任意关卡第 1 个月都不该破产');

{
  // 池子里 basePrice 最高 ¥34 → 一手成本上限 ¥3405 < ¥6000。
  // 所以"开局满仓现金 + 第一个月结算"这个组合永远不该破产。
  let bad = 0;
  let worst = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    const b = new DataBus();
    b.startRun('lv_01', { seedKey: `fp${i}` });
    b.nextTurn();
    b.settle();
    const line = b.bankruptLine();
    worst = Math.max(worst, line);
    if (b.isBankrupt()) bad++;
  }
  console.log(`    ${N} 局随机开局：误判破产 ${bad} 局；观测到的最高破产线 ¥${worst.toFixed(0)}（本金 ¥6000）`);
  chk('★ 无任何一局在开局第 1 个月被误判破产', bad === 0, `bad=${bad}`);
  chk('破产线上限远低于本金（留足安全边际）', worst < 6000 * 0.5,
    `worst=¥${worst.toFixed(0)}`);
}

// ---------------------------------------------------------------
console.log('\n  [4f] 平衡影响：每月结算后判定，会误杀多少局？');

{
  const N = 300;
  let bankrupt = 0;
  let fullRun = 0;
  const turnsOfBankrupt = [];
  for (let i = 0; i < N; i++) {
    const b = new DataBus();
    b.startRun('lv_01', { seedKey: `bal${i}` });
    let guard = 0;
    while (b.phase !== 'OVER' && guard++ < 40) {
      b.nextTurn();
      b.settle();
      if (b.isBankrupt()) { b.finish('bankrupt', 'x'); break; }
      if (b.isTermOver()) { b.settleTerm(); break; }
    }
    if (b.result.outcome === 'bankrupt') {
      bankrupt++;
      turnsOfBankrupt.push(b.result.turns);
    } else {
      fullRun++;
    }
  }
  const avgTurn = turnsOfBankrupt.length
    ? (turnsOfBankrupt.reduce((s, t) => s + t, 0) / turnsOfBankrupt.length).toFixed(1)
    : '-';
  console.log(`    ${N} 局第 1 关（不交易、纯持有现金）：破产 ${bankrupt} 局，走完 12 个月 ${fullRun} 局`);
  console.log(`    破产局平均存活 ${avgTurn} 个月`);
  chk('「空仓不动」不该被判破产（不买不亏，无理由出局）', bankrupt === 0,
    `bankrupt=${bankrupt}`);
}

// ---------------------------------------------------------------
console.log('\n  [4g] 平衡影响：加上"每月结算后判定"会不会把正常玩法玩死？');

{
  // 策略：每月满仓买入当时最便宜的未退市股票，然后一直持有。
  // 这是最容易被"判定过严"误杀的玩法（跌了就死扛），所以拿它当压力测试。
  function playHold(levelId, seedKey) {
    const b = new DataBus();
    b.startRun(levelId, { seedKey });
    let guard = 0;
    while (b.phase !== 'OVER' && guard++ < 40) {
      b.nextTurn();
      b.settle();
      if (b.isBankrupt()) { b.finish('bankrupt', 'x'); break; }
      if (!b.portfolio.hasPositions()) {
        const c = b.stockDefs.filter((d) => !b.isDelisted(d.code))
          .map((d) => ({ d, p: b.priceMap[d.code] }))
          .sort((x, y) => x.p - y.p)[0];
        const lots = maxLots(c.p, b.portfolio.cash);
        if (lots >= 1) b.portfolio.buy(c.d.code, c.p, lots * LOT_SIZE);
      }
      if (b.isTermOver()) { b.settleTerm(); break; }
    }
    return b.result;
  }

  const N = 200;
  let worstRate = 0;
  let worstLevel = '';
  const lines = [];
  ['lv_01', 'lv_02', 'lv_03', 'lv_04', 'lv_05'].forEach((lv) => {
    let bk = 0;
    let turns = 0;
    for (let i = 0; i < N; i++) {
      const r = playHold(lv, `bal${i}`);
      if (r.outcome === 'bankrupt') { bk++; turns += r.turns; }
    }
    const rate = bk / N;
    if (rate > worstRate) { worstRate = rate; worstLevel = lv; }
    lines.push(`    ${lv}  破产 ${String(bk).padStart(3)}/${N} (${(rate * 100).toFixed(1)}%)`
      + `  平均存活 ${bk ? (turns / bk).toFixed(1) : '-'} 个月`);
  });
  lines.forEach((l) => console.log(l));
  console.log(`    最高破产率 ${(worstRate * 100).toFixed(1)}%（${worstLevel}）`);

  // 破产线 = 最便宜的一手（¥205 ~ ¥2005 量级），本金 ¥6000。
  // 要被打到线下必须亏掉 87%+ —— 那是真·出局，不是误杀。
  chk('★ 满仓死扛玩法下破产率 ≤ 12%（判定没有过严）',
    worstRate <= 0.12, `worst=${(worstRate * 100).toFixed(1)}% @${worstLevel}`);
}

// =================================================================
console.log('\n=== 结果 ===');
console.log(`共 ${count} 项断言，失败 ${fails} 项`);
console.log(fails ? '破产判定诊断失败 ✗' : '破产判定诊断通过 ✓');
process.exit(fails ? 1 : 0);
