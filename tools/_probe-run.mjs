// 临时：一整轮「连闯 5 关」的破产概率（玩家真实体验的那个数）
globalThis.wx = {
  createCanvas: () => ({ width: 375, height: 667, getContext: () => ({ scale() {} }) }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 3 }),
  onTouchStart() {},
};

const { default: DataBus } = await import('../js/core/databus.js');
const { LOT_SIZE, maxLots } = await import('../js/market/order.js');
const { LEVELS } = await import('../js/data/levels.js');
const { setSeed } = await import('../js/core/random.js');

const N = 1200;

function pick(b, cmp) {
  return b.stockDefs.filter((d) => !b.isDelisted(d.code))
    .map((d) => ({ d, p: b.priceMap[d.code] })).sort(cmp)[0];
}
function buyBest(b, cmp) {
  const c = pick(b, cmp);
  if (!c) return;
  const lots = maxLots(c.p, b.portfolio.cash);
  if (lots >= 1) b.portfolio.buy(c.d.code, c.p, lots * LOT_SIZE);
}

const POLICIES = [
  ['满仓死扛', (b) => { if (!b.portfolio.hasPositions()) buyBest(b, (x, y) => x.p - y.p); }],
  ['梭哈最贵', (b) => { if (!b.portfolio.hasPositions()) buyBest(b, (x, y) => y.p - x.p); }],
  ['追高换手', (b) => {
    b.stockDefs.forEach((d) => {
      const sh = b.portfolio.sharesOf(d.code);
      if (sh > 0) b.portfolio.sell(d.code, b.priceMap[d.code], sh);
    });
    buyBest(b, (x, y) => y.p - x.p);
  }],
  ['半仓分散', (b) => {
    if (b.portfolio.hasPositions()) return;
    const cands = b.stockDefs.filter((d) => !b.isDelisted(d.code))
      .map((d) => ({ d, p: b.priceMap[d.code] })).sort((x, y) => x.p - y.p).slice(0, 2);
    const each = Math.floor(b.portfolio.cash / 2 / (cands.length || 1));
    cands.forEach((c) => {
      const lots = maxLots(c.p, each);
      if (lots >= 1) b.portfolio.buy(c.d.code, c.p, lots * LOT_SIZE);
    });
  }],
];

function playLevel(b, levelId, first, initCash, policy, k) {
  if (!b.startRun(levelId, first ? { initCash } : {}) && first) return 'error';
  if (k !== 1) b.isBankrupt = () => b.portfolio.totalAssets(b.priceMap) < b.bankruptLine() * k;
  if (b.isBankrupt()) { b.finish('bankrupt', 'x'); return 'bankrupt'; }
  let guard = 0;
  while (b.phase !== 'OVER' && guard++ < 60) {
    b.nextTurn();
    b.settle();
    policy(b);
    if (b.isBankrupt()) { b.finish('bankrupt', 'x'); return 'bankrupt'; }
    if (b.isTermOver()) { b.settleTerm(); break; }
  }
  return b.result.outcome;
}

/** 打一整轮：第 1 关用 initCash，之后 startNextLevel 把期末资产传下去 */
function playRun(initCash, k, policy) {
  const b = new DataBus();
  for (let li = 0; li < LEVELS.length; li++) {
    const first = li === 0;
    if (first) {
      if (!b.startRun(LEVELS[0].id, { initCash })) return 'error';
    } else {
      if (!b.startNextLevel()) return 'error';
    }
    if (k !== 1) b.isBankrupt = () => b.portfolio.totalAssets(b.priceMap) < b.bankruptLine() * k;
    if (b.isBankrupt()) { b.finish('bankrupt', 'x'); return 'bankrupt'; }
    let guard = 0;
    while (b.phase !== 'OVER' && guard++ < 60) {
      b.nextTurn();
      b.settle();
      policy(b);
      if (b.isBankrupt()) { b.finish('bankrupt', 'x'); return 'bankrupt'; }
      if (b.isTermOver()) { b.settleTerm(); break; }
    }
  }
  return 'survived';
}

function run(initCash, k) {
  let bk = 0;
  let total = 0;
  for (let r = 0; r < 2; r++) {
    setSeed(`run-r${r}`);
    for (const [, policy] of POLICIES) {
      for (let i = 0; i < N; i++) {
        if (playRun(initCash, k, policy) === 'bankrupt') bk++;
        total++;
      }
    }
  }
  const p = bk / total;
  return { p, ci: Math.sqrt((p * (1 - p)) / total) * 1.96, n: total };
}

console.log('=== 一整轮「连闯 5 关」的破产概率（4 策略 × ' + N + ' 局 × 2 种子）===\n');
console.log('方案                                破产率     ±95%CI     局数');
console.log('─'.repeat(68));
const VARIANTS = [
  ['现状（本钱 10000，k=1）', 10000, 1],
  ['本钱 6000', 6000, 1],
  ['本钱 4000', 4000, 1],
  ['k=2', 10000, 2],
  ['k=3', 10000, 3],
  ['本钱 6000 + k=2', 6000, 2],
  ['本钱 6000 + k=3', 6000, 3],
];
for (const [name, cash, k] of VARIANTS) {
  const r = run(cash, k);
  console.log(
    name.padEnd(34)
    + (r.p * 100).toFixed(2).padStart(6) + '%'
    + ('±' + (r.ci * 100).toFixed(2) + '%').padStart(11)
    + String(r.n).padStart(9),
  );
}
