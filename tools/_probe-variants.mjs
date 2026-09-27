// 临时：几种"让破产更可达"的方案，实际破产率对比（大样本 + 置信区间）
globalThis.wx = {
  createCanvas: () => ({ width: 375, height: 667, getContext: () => ({ scale() {} }) }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 3 }),
  onTouchStart() {},
};

const { default: DataBus } = await import('../js/core/databus.js');
const { LOT_SIZE, maxLots } = await import('../js/market/order.js');
const { setSeed } = await import('../js/core/random.js');

const N = 1500; // 每策略局数

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
];

/**
 * @param {number} initCash 本钱
 * @param {number} k 破产线倍数（1 = 连一手都买不起）
 * @param {number} seedN 重复的种子轮数（每轮换一个种子 → 顺便看种子敏感性）
 */
function run(initCash, k, seedN) {
  let bankrupt = 0;
  let lose = 0;
  let win = 0;
  let total = 0;
  for (let r = 0; r < seedN; r++) {
    setSeed(`cap-r${r}`);
    for (const [, policy] of POLICIES) {
      for (let i = 0; i < N; i++) {
        const b = new DataBus();
        b.startRun('lv_01', { initCash });
        if (k !== 1) b.isBankrupt = () => b.portfolio.totalAssets(b.priceMap) < b.bankruptLine() * k;
        let guard = 0;
        while (b.phase !== 'OVER' && guard++ < 40) {
          b.nextTurn();
          b.settle();
          policy(b);
          if (b.isBankrupt()) { b.finish('bankrupt', 'x'); break; }
          if (b.isTermOver()) { b.settleTerm(); break; }
        }
        if (b.result.outcome === 'bankrupt') bankrupt++;
        else if (b.result.outcome === 'win') win++;
        else lose++;
        total++;
      }
    }
  }
  const p = bankrupt / total;
  return {
    bankrupt: p,
    ci: Math.sqrt((p * (1 - p)) / total) * 1.96,
    lose: lose / total,
    win: win / total,
    n: total,
  };
}

const SEED_N = 2;
console.log(`=== 方案对比（3 策略 × ${N} 局 × ${SEED_N} 个种子 = ${N * 3 * SEED_N} 局/方案，第 1 关）===\n`);
console.log('方案                          破产率    ±95%CI    亏损率   盈利率');
console.log('─'.repeat(72));

const VARIANTS = [
  ['现状（本钱 10000，k=1）', 10000, 1],
  ['本钱 6000', 6000, 1],
  ['本钱 5000', 5000, 1],
  ['本钱 4000', 4000, 1],
  ['k=2（连 2 手都买不起）', 10000, 2],
  ['k=3（连 3 手都买不起）', 10000, 3],
  ['本钱 6000 + k=2', 6000, 2],
  ['本钱 6000 + k=3', 6000, 3],
  ['本钱 4000 + k=2', 4000, 2],
];

for (const [name, cash, k] of VARIANTS) {
  const r = run(cash, k, SEED_N);
  console.log(
    name.padEnd(30)
    + (r.bankrupt * 100).toFixed(2).padStart(6) + '%'
    + ('±' + (r.ci * 100).toFixed(2) + '%').padStart(10)
    + (r.lose * 100).toFixed(1).padStart(9) + '%'
    + (r.win * 100).toFixed(1).padStart(8) + '%',
  );
}
