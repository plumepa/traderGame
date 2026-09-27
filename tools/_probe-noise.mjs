// 临时：破产率的抽样噪声有多大？（同一策略、不同种子、大样本）
globalThis.wx = {
  createCanvas: () => ({ width: 375, height: 667, getContext: () => ({ scale() {} }) }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 3 }),
  onTouchStart() {},
};

const { default: DataBus } = await import('../js/core/databus.js');
const { LOT_SIZE, maxLots } = await import('../js/market/order.js');
const { setSeed } = await import('../js/core/random.js');

function pick(b, cmp) {
  return b.stockDefs.filter((d) => !b.isDelisted(d.code))
    .map((d) => ({ d, p: b.priceMap[d.code] })).sort(cmp)[0];
}

function holdPolicy(b) {
  if (!b.portfolio.hasPositions()) {
    const c = pick(b, (x, y) => x.p - y.p);
    const lots = maxLots(c.p, b.portfolio.cash);
    if (lots >= 1) b.portfolio.buy(c.d.code, c.p, lots * LOT_SIZE);
  }
}

function expensivePolicy(b) {
  if (!b.portfolio.hasPositions()) {
    const c = pick(b, (x, y) => y.p - x.p);
    const lots = maxLots(c.p, b.portfolio.cash);
    if (lots >= 1) b.portfolio.buy(c.d.code, c.p, lots * LOT_SIZE);
  }
}

function churnPolicy(b) {
  b.stockDefs.forEach((d) => {
    const sh = b.portfolio.sharesOf(d.code);
    if (sh > 0) b.portfolio.sell(d.code, b.priceMap[d.code], sh);
  });
  const c = pick(b, (x, y) => y.p - x.p);
  const lots = maxLots(c.p, b.portfolio.cash);
  if (lots >= 1) b.portfolio.buy(c.d.code, c.p, lots * LOT_SIZE);
}

const POLICIES = [['满仓死扛', holdPolicy], ['梭哈最贵', expensivePolicy], ['追高换手', churnPolicy]];

function rate(seed, levelId, N, policy, initCash, k) {
  setSeed(seed);
  let bk = 0;
  for (let i = 0; i < N; i++) {
    const b = new DataBus();
    b.startRun(levelId, initCash ? { initCash } : {});
    if (k && k !== 1) b.isBankrupt = () => b.portfolio.totalAssets(b.priceMap) < b.bankruptLine() * k;
    let guard = 0;
    while (b.phase !== 'OVER' && guard++ < 40) {
      b.nextTurn();
      b.settle();
      policy(b);
      if (b.isBankrupt()) { b.finish('bankrupt', 'x'); break; }
      if (b.isTermOver()) { b.settleTerm(); break; }
    }
    if (b.result.outcome === 'bankrupt') bk++;
  }
  return bk / N;
}

const N = 2000;
const ci = (r) => (Math.sqrt((r * (1 - r)) / N) * 1.96 * 100).toFixed(2);

console.log(`=== 满仓死扛 · lv_01 · 本金 ¥10000 · N=${N} ===\n`);
console.log('种子            破产率   ±95%CI');
console.log('─'.repeat(40));
for (const s of ['cap-v1', 'cap-v2', 'cap-v3', 'cap-v4']) {
  const r = rate(s, 'lv_01', N, holdPolicy);
  console.log(s.padEnd(15) + (r * 100).toFixed(2).padStart(6) + '%' + ci(r).padStart(9) + '%');
}

console.log('\n=== 三个策略各自 · lv_01 · 本金 ¥10000 · N=' + N + ' · 种子 cap-v1 ===\n');
for (const [name, p] of POLICIES) {
  const r = rate('cap-v1', 'lv_01', N, p);
  console.log(name.padEnd(10) + (r * 100).toFixed(2).padStart(6) + '%' + ci(r).padStart(9) + '%');
}

console.log('\n=== 同一策略 · 五个关卡 · N=' + N + '（种子 cap-v1）===\n');
for (const lv of ['lv_01', 'lv_02', 'lv_03', 'lv_04', 'lv_05']) {
  const r = rate('cap-v1', lv, N, holdPolicy);
  console.log(`  ${lv}  ${(r * 100).toFixed(2).padStart(6)}%  ±${ci(r)}%`);
}
