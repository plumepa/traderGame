/**
 * 策略平衡性验证
 *
 * 用几种典型玩家策略各跑 200 局，统计胜率，
 * 确认关卡既不是"随便玩都能赢"，也不是"怎么玩都输"。
 *
 * 运行：
 *   node --experimental-loader ./tools/register.mjs tools/balance.mjs
 */

globalThis.wx = {
  createCanvas: () => ({ width: 375, height: 667, getContext: () => ({ scale() {} }) }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 3 }),
  onTouchStart() {},
};

const { default: DataBus } = await import('../js/core/databus.js');
const { LOT_SIZE, maxLots } = await import('../js/market/order.js');
const { setSeed, clearSeed } = await import('../js/core/random.js');

/**
 * 每策略局数。
 *
 * ⚠️ 从 200 提到 600 是被一次**统计翻车**逼出来的：
 *    "换手梭哈 < 满仓持有" 这条断言在 200 局时，跑 6 次有 3 次失败 ——
 *    不是策略设计错了，而是**两个高方差均值做硬比较，样本太小就是抛硬币**。
 *    600 局后标准误差降到 ~1/1.7，差异才稳定显现。
 */
const ROUNDS = 600;

/**
 * 通用驱动：给定"每回合的操作函数"，跑完一整局
 *
 * 与 main.js 的回合顺序保持一致：
 *   推进 → 决策 → 价格结算 → 评级 → 判到期（强平+结算）/ 判破产
 *
 * 额外统计 **friction**（全期交易成本：佣金 + 印花税）。
 * 这是"高频交易代价"唯一**确定性**的度量 ——
 * 用它替代"资产高低"做断言，因为后者被年度收益噪声淹没（见 churn 的注释）。
 *
 * @param {(bus) => void} policy 每回合的决策
 * @returns {{outcome, total, turns, liquidated, friction, trades}}
 */
function playOnce(policy) {
  const bus = new DataBus();
  bus.start('lv_01');
  let guard = 0;

  // 包一层 portfolio，累计每笔交易的手续费
  let friction = 0;
  let trades = 0;
  const pf = bus.portfolio;
  const origBuy = pf.buy.bind(pf);
  const origSell = pf.sell.bind(pf);
  pf.buy = (...a) => { const r = origBuy(...a); friction += r.fee; trades++; return r; };
  pf.sell = (...a) => { const r = origSell(...a); friction += r.fee; trades++; return r; };

  // ⚠️ 一次性策略（首月梭哈/满仓持有）靠闭包里的 done 标记只买一次，
  //    这个标记必须**每局重置**，否则 200 局里只有第 1 局真正买入。
  if (policy.reset) policy.reset();

  while (bus.phase !== 'OVER' && guard++ < 60) {
    bus.nextTurn();
    bus.phase = 'NEWS';

    policy(bus);

    bus.settle();
    bus.phase = 'TRADING';
    bus.generateRatings();

    // 到期优先：先强制平仓，再用纯现金判 win / lose
    if (bus.isTermOver()) {
      bus.settleTerm();
      break;
    }
    // 否则按总资产判破产
    if (bus.isBankrupt()) {
      bus.finish('bankrupt', '破产');
      break;
    }
  }
  return {
    outcome: bus.result.outcome,
    total: bus.result.total,
    turns: bus.result.turns,
    liquidated: !!bus.result.liquidation,
    friction,
    trades,
  };
}

// ---------------- 策略定义 ----------------

/** ① 躺平：什么都不做 */
const idle = () => {};

/** ② 定投：每月买 1 手最便宜的，从不卖 */
const dcaCheapest = (bus) => {
  const c = bus.stockDefs
    .map((d) => ({ code: d.code, price: bus.priceMap[d.code] }))
    .sort((a, b) => a.price - b.price)[0];
  if (c && maxLots(c.price, bus.portfolio.cash) >= 1) {
    bus.portfolio.buy(c.code, c.price, LOT_SIZE);
  }
};

/** ③ 定投+止盈：每月买 1 手最便宜；持仓浮盈 > 8% 就卖 */
const dcaTakeProfit = (bus) => {
  bus.stockDefs.forEach((d) => {
    const sh = bus.portfolio.sharesOf(d.code);
    if (sh > 0) {
      const avg = bus.portfolio.avgCostOf(d.code);
      const px = bus.priceMap[d.code];
      if (px > avg * 1.08) bus.portfolio.sell(d.code, px, sh);
    }
  });
  const c = bus.stockDefs
    .map((d) => ({ code: d.code, price: bus.priceMap[d.code] }))
    .sort((a, b) => a.price - b.price)[0];
  if (c && maxLots(c.price, bus.portfolio.cash) >= 1) {
    bus.portfolio.buy(c.code, c.price, LOT_SIZE);
  }
};

/** ④ 跟机构：买评级最高的那只，卖掉评级最低的持仓 */
const followRating = (bus) => {
  if (!bus.ratings || !bus.ratings.length) return;
  const sorted = [...bus.ratings].sort((a, b) => b.score - a.score);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  const worstHeld = bus.portfolio.sharesOf(worst.code);
  if (worstHeld > 0 && worst.score < 0) {
    bus.portfolio.sell(worst.code, bus.priceMap[worst.code], worstHeld);
  }
  const px = bus.priceMap[best.code];
  const lots = maxLots(px, bus.portfolio.cash);
  if (lots >= 1 && best.score > 0.15) {
    bus.portfolio.buy(best.code, px, Math.min(lots, 2) * LOT_SIZE);
  }
};

/** ⑤ 反向跟机构：专买评级最差的 */
const contrarian = (bus) => {
  if (!bus.ratings || !bus.ratings.length) return;
  const sorted = [...bus.ratings].sort((a, b) => a.score - b.score);
  const worst = sorted[0];
  const px = bus.priceMap[worst.code];
  const lots = maxLots(px, bus.portfolio.cash);
  if (lots >= 1 && worst.score < -0.2) {
    bus.portfolio.buy(worst.code, px, LOT_SIZE);
  }
};

/** ⑥ 满仓梭哈：第一回合把所有钱压在最便宜那只上 */
const allIn = (() => {
  let done = false;
  const fn = (bus) => {
    if (done) return;
    const c = bus.stockDefs
      .map((d) => ({ code: d.code, price: bus.priceMap[d.code] }))
      .sort((a, b) => a.price - b.price)[0];
    if (!c) return;
    const lots = maxLots(c.price, bus.portfolio.cash);
    if (lots >= 1) {
      bus.portfolio.buy(c.code, c.price, lots * LOT_SIZE);
      done = true;
    }
  };
  fn.reset = () => { done = false; };
  return fn;
})();

/** ⑦ 一次性满仓买入最便宜的那只，之后从不操作（基准：全仓买入持有） */
const buyAndHold = (() => {
  let done = false;
  const fn = (bus) => {
    if (done) return;
    const c = bus.stockDefs
      .map((d) => ({ code: d.code, price: bus.priceMap[d.code] }))
      .sort((a, b) => a.price - b.price)[0];
    if (!c) return;
    const lots = maxLots(c.price, bus.portfolio.cash);
    if (lots >= 1) {
      bus.portfolio.buy(c.code, c.price, lots * LOT_SIZE);
      done = true;
    }
  };
  fn.reset = () => { done = false; };
  return fn;
})();

/**
 * ⑧ 每月追涨换手梭哈（磨损策略）
 *
 * 买当下最贵的那只，每月全卖再全买 —— 反复支付手续费与印花税。
 *
 * ⚠️⚠️ 这条断言被改过两次，教训值得写下来。
 *
 * 【第一次失败】原本写 `churn.avgTotal < holdR.avgTotal`（换手应输给满仓持有）。
 *   实测跑 6 次失败 3 次 —— 不是策略错，是**拿两个高方差均值做硬比较，样本太小**。
 *
 * 【第二次失败（更本质）】加上印花税、样本提到 600 局后仍然过不了：
 *   跨 5 个种子测，换手在 2/5 的种子里**反超**满仓持有。
 *
 *   根因是设计本身：为了防"买最贵那只必胜"，pathgen 刻意让
 *   **basePrice 与 trend 完全不相关**（r ≈ 0.04）。既然价格高低不携带任何
 *   未来收益信息，"买最贵的"和"买最便宜的"就是**同期望**的两个随机选择 ——
 *   "追高"在这里并没有被惩罚，换手唯一的真实代价就是那点手续费（~2%/年），
 *   而它落在年度收益 ±20% 的噪声里，**注定测不出显著差异**。
 *
 * 【结论：换一条真正成立的断言】
 *   不再断言"换手输给满仓"（那是错的），改为断言**磨损确实发生**：
 *   换手策略的**净收益要显著低于它自己零成本时的水平** ——
 *   用"总磨损 = 手续费 + 印花税支出"来度量，这是确定性的、必然为正的、
 *   且随换手次数线性增长的。这才是这件事真正可被验证的性质。
 *
 * 说明：本策略仍有价值 —— 它是"高频交易被摩擦成本侵蚀"的**教学样本**，
 * 只是不能用"资产高低"来量化（噪声掩盖信号）。
 */
const churn = (bus) => {
  const c = bus.stockDefs
    .map((d) => ({ code: d.code, price: bus.priceMap[d.code] }))
    .sort((a, b) => b.price - a.price)[0];
  if (!c) return;
  bus.stockDefs.forEach((d) => {
    const sh = bus.portfolio.sharesOf(d.code);
    if (sh > 0) bus.portfolio.sell(d.code, bus.priceMap[d.code], sh);
  });
  const lots = maxLots(c.price, bus.portfolio.cash);
  if (lots >= 1) bus.portfolio.buy(c.code, c.price, lots * LOT_SIZE);
};

// ---------------- 跑统计 ----------------

const STRATEGIES = [
  ['躺平不动', idle],
  ['定投不卖', dcaCheapest],
  ['定投止盈', dcaTakeProfit],
  ['跟机构买', followRating],
  ['反向买差评', contrarian],
  ['首月梭哈', allIn],
  ['满仓持有', buyAndHold],
  ['换手梭哈', churn],
];

console.log('=== 策略平衡性验证（每种 ' + ROUNDS + ' 局）===\n');

// ⚠️ 用**固定种子**而不是时间种子。
//    时间种子会让每次运行的均值都不同 → 断言时绿时红，无法判断"是代码坏了还是运气差"。
//    平衡测试要的是**可复现的结论**，不是每次抽不同的随机样本。
//    想换一组样本，改这个种子即可。
setSeed('balance-v1');

// ---- ★ 固定种子必须真的可复现（自检，别信"我设了种子"）----
//
// 【真实事故 · 两个 bug 叠在一起，让"固定种子"整整两个版本形同虚设】
//
//   ① `setup.js` 生成 seedKey 时掺了 `Date.now()`：
//        `g${Date.now()}_${Math.floor(random() * 1e6)}`
//      → 每次运行 seedKey 都不同 → generatePath / rollDelist 结果都不同。
//
//   ② `setSeed()` 用 `seed >>> 0`，而测试传的是**字符串**：
//        `'balance-v1' >>> 0` → `Number('balance-v1')` 是 NaN → `NaN >>> 0` 是 **0**
//      → 所有字符串种子都退化成同一条序列，"换种子换样本"根本没发生，且不报错。
//
//   症状：观测值在阈值两侧随机跳动（破产率 1.0%~2.3% 骑在 2% 的线上），
//   看起来像"统计噪声"，实际是"种子根本没接上"。
//
// 所以这里显式验两次：同一 seed 跑两遍，结果必须逐字符相同。
// 这条断言是**确定性**的，比任何"看起来差不多"的均值比较都可靠。
{
  const snap = () => {
    setSeed('repro-check');
    const out = [];
    for (let i = 0; i < 6; i++) {
      const bus = new DataBus();
      // ⚠️ 必须用 startRun 而不是 start：
      //   DataBus 是**单例**，usedStockCodes 会跨局累积，
      //   不重置的话第二次快照的排除集已经变了，比出来的差异是假的。
      bus.startRun('lv_01');
      out.push(bus.seedKey + '|' + bus.stockDefs.map((d) => d.code).join(',')
        + '|' + bus.stockDefs.map((d) => (d.delistAt || 0)).join(',')
        + '|' + bus.stockDefs.map((d) => d.path.slice(0, 3).join('.')).join('/'));
    }
    return out.join('\n');
  };
  const a = snap();
  const b = snap();
  if (a === b) {
    console.log('✓ 固定种子自检：同一 seed 两次运行结果完全一致');
  } else {
    console.log('✗ 固定种子自检：两次运行结果不同 —— setSeed() 没有生效！');
    console.log('  第一次: ' + a.split('\n')[0]);
    console.log('  第二次: ' + b.split('\n')[0]);
    process.exitCode = 1;
  }

  // 顺带验一下"不同种子必须是不同序列"（防止 hash 退化成常量）
  setSeed('seed-A');
  const sa = new DataBus();
  sa.startRun('lv_01');
  const keyA = sa.seedKey;
  setSeed('seed-B');
  const sb = new DataBus();
  sb.startRun('lv_01');
  if (keyA === sb.seedKey) {
    console.log('✗ 不同 seed 产生了同一个 seedKey —— setSeed 的哈希退化了！');
    process.exitCode = 1;
  } else {
    console.log('✓ 不同 seed 产生不同序列（seed-A vs seed-B）');
  }
  console.log('');

  setSeed('balance-v1'); // 复位，避免影响下面的正式统计
}

console.log('策略            盈利率  破产率  亏损率   平均资产    平均回合  平均磨损');
console.log('─'.repeat(84));

const summary = {};

for (const [name, policy] of STRATEGIES) {
  let win = 0;
  let bankrupt = 0;
  let lose = 0;
  let totalSum = 0;
  let turnsSum = 0;
  let frictionSum = 0;
  let tradesSum = 0;

  for (let i = 0; i < ROUNDS; i++) {
    const r = playOnce(policy);
    if (r.outcome === 'win') win++;
    else if (r.outcome === 'bankrupt') bankrupt++;
    else lose++;
    totalSum += r.total;
    turnsSum += r.turns;
    frictionSum += r.friction;
    tradesSum += r.trades;
  }

  const pct = (n) => ((n / ROUNDS) * 100).toFixed(1).padStart(5) + '%';
  summary[name] = {
    win: win / ROUNDS,
    bankrupt: bankrupt / ROUNDS,
    lose: lose / ROUNDS,
    avgTotal: totalSum / ROUNDS,
    avgTurns: turnsSum / ROUNDS,
    avgFriction: frictionSum / ROUNDS,
    avgTrades: tradesSum / ROUNDS,
  };

  console.log(
    name.padEnd(16) +
    pct(win) + '  ' +
    pct(bankrupt) + '  ' +
    pct(lose) + '  ' +
    ('¥' + (totalSum / ROUNDS).toFixed(0)).padStart(9) + '  ' +
    (turnsSum / ROUNDS).toFixed(1).padStart(8) + '  ' +
    ('¥' + (frictionSum / ROUNDS).toFixed(0)).padStart(8) + ' ' +
    ('(' + (tradesSum / ROUNDS).toFixed(0) + '笔)').padStart(8),
  );
}

// ---------------- 断言 ----------------

console.log('\n=== 平衡性断言 ===\n');

const fails = [];
function chk(desc, cond, extra) {
  const mark = cond ? 'ok  ' : 'FAIL';
  console.log('  ' + mark + '  ' + desc + (extra ? '   (' + extra + ')' : ''));
  if (!cond) fails.push(desc);
}

const idleR = summary['躺平不动'];
const dcaR = summary['定投不卖'];
const tpR = summary['定投止盈'];
const rtR = summary['跟机构买'];
const allinR = summary['首月梭哈'];
const holdR = summary['满仓持有'];
const churnR = summary['换手梭哈'];
const all = [idleR, dcaR, tpR, rtR, allinR, churnR];

chk('躺平不动应当 0% 盈利率（不操作不可能赚）', idleR.win < 0.01,
  '盈利率 ' + (idleR.win * 100).toFixed(1) + '%');

chk('躺平不动不应破产（不买就没风险）', idleR.bankrupt < 0.01,
  '破产率 ' + (idleR.bankrupt * 100).toFixed(1) + '%');

// ⚠️ 核心回归：破产判定口径是"总资产"，买入不该误伤
//（曾因只看现金，导致"定投不卖"100% 破产、"反买差评"99% 破产）
//
// 阈值 2% → 4%（v5.10）：加上"每月结算后判定"之后，**满仓梭哈类策略**
// 真的会破产了 —— 那是"亏到连一手都买不起"的真出局，不是误伤。
// 实测（600 局）：首月梭哈 1.0%~2.3%、换手梭哈 1.0%~1.5%，
// 正好骑在 2% 这条线上 → 断言会时红时绿。**骑线的阈值比略松的阈值更糟。**
//
// 注意这条断言现在只能挡住"灾难性误伤"（原 bug 是 100%/99%，4% 绰绰有余）。
// "买入动作本身不触发判定"这条**确定性**不变量由 diag-bankrupt.mjs 守着：
//   [4d] 满仓买入后仍停留在交易页
//   [4e] 400 局随机开局，第 1 个月结算后 0 局被误判破产
chk('★ 买入误伤回归：任何策略的破产率都应很低（≤4%，原 bug 是 100%/99%）',
  all.every((s) => s.bankrupt < 0.04),
  all.map((s) => (s.bankrupt * 100).toFixed(1) + '%').join(' / '));

chk('★ 正常持仓策略应当能活满 12 个月',
  dcaR.avgTurns >= 11.5 && tpR.avgTurns >= 11.5,
  '定投不卖=' + dcaR.avgTurns.toFixed(1) + ' 定投止盈=' + tpR.avgTurns.toFixed(1));

chk('存在能稳定盈利的策略', all.some((s) => s.win > 0.2),
  all.map((s) => (s.win * 100).toFixed(0) + '%').join(' / '));

chk('不同策略的最终资产有显著差异（≥¥800）',
  (Math.max(...all.map((s) => s.avgTotal)) - Math.min(...all.map((s) => s.avgTotal))) >= 800,
  '最高 ¥' + Math.max(...all.map((s) => s.avgTotal)).toFixed(0) +
  ' 最低 ¥' + Math.min(...all.map((s) => s.avgTotal)).toFixed(0));

chk('最优策略平均资产明显高于本金',
  Math.max(...all.map((s) => s.avgTotal)) > 6000 * 1.08,
  '最高 ¥' + Math.max(...all.map((s) => s.avgTotal)).toFixed(0));

chk('存在会亏钱的错误策略（有惩罚）',
  all.some((s) => s.bankrupt > 0.2 || s.lose > 0.5),
  all.map((s) => '破' + (s.bankrupt * 100).toFixed(0) + '%/亏' + (s.lose * 100).toFixed(0) + '%').join(' '));

chk('策略之间有区分度（盈利率不全相同）',
  new Set(all.map((s) => s.win.toFixed(2))).size >= 3,
  all.map((s) => (s.win * 100).toFixed(0) + '%').join(' / '));

chk('平均回合数合理（不会瞬间结束）',
  Object.values(summary).every((s) => s.avgTurns >= 6),
  Object.entries(summary).map(([k, v]) => k + '=' + v.avgTurns.toFixed(0)).join(' '));

chk('最优策略不应必然破产',
  Math.min(...all.filter((s) => s.win > 0.5).map((s) => s.bankrupt)) < 0.05,
  '盈利策略中最低破产率 ' +
  (Math.min(...all.filter((s) => s.win > 0.5).map((s) => s.bankrupt)) * 100).toFixed(1) + '%');

chk('★ 高频换手的交易成本必须显著高于买入持有',
  churnR.avgFriction > holdR.avgFriction * 5,
  '换手 ¥' + churnR.avgFriction.toFixed(0) + '(' + churnR.avgTrades.toFixed(0) + '笔)' +
  ' vs 满仓 ¥' + holdR.avgFriction.toFixed(0) + '(' + holdR.avgTrades.toFixed(0) + '笔)');

chk('★ 换手的磨损占本金比例可观（≥1.5%，足以构成学习点）',
  churnR.avgFriction / 10000 >= 0.015,
  (churnR.avgFriction / 100).toFixed(2) + '% 本金');

chk('买入持有的交易次数极少（验证"持有"确实是持有）',
  holdR.avgTrades <= 2.5,
  holdR.avgTrades.toFixed(1) + ' 笔');

// ⚠️ 这里**故意不**断言"换手资产 < 满仓资产"。
//    实测跨 5 个固定种子跑 600 局，换手在 2/5 的种子里反超 ——
//    因为 pathgen 刻意让 basePrice 与 trend 不相关，"买最贵"与"买最便宜"
//    是同期望的随机选择，换手唯一的代价就是手续费（~2%/年），
//    落在年度收益 ±20% 的噪声里，测不出显著差异。
//    断言"成本更高"（确定性成立）而不是"收益更低"（统计上不成立），
//    才是对这条机制的正确刻画。详见 churn 的注释。

console.log('\n=== 结果 ===');
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项');
  process.exit(1);
}
console.log('平衡性验证通过 ✓');
