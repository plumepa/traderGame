// 临时：验证「股票初始价格离散度太大」这个假设
//   做法：把股票池的 basePrice 做各种变换，看破产线和破产率怎么动。
//   关键对照：**均价相同、离散度不同** —— 如果破产率差很多，说明离散度本身是元凶。
globalThis.wx = {
  createCanvas: () => ({ width: 375, height: 667, getContext: () => ({ scale() {} }) }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 3 }),
  onTouchStart() {},
};

const { default: DataBus } = await import('../js/core/databus.js');
const { LOT_SIZE, maxLots, costToBuy } = await import('../js/market/order.js');
const { STOCK_POOL } = await import('../js/data/pool.js');
const { setSeed } = await import('../js/core/random.js');

const ORIG = STOCK_POOL.map((s) => ({ basePrice: s.basePrice, floor: s.floor }));
const BMIN = Math.min(...ORIG.map((o) => o.basePrice));
const BMAX = Math.max(...ORIG.map((o) => o.basePrice));

/** 把 basePrice 从 [BMIN,BMAX] 线性映射到 [lo,hi]，floor 按同比例缩放 */
function band(lo, hi) {
  STOCK_POOL.forEach((s, i) => {
    const o = ORIG[i];
    const t = (o.basePrice - BMIN) / (BMAX - BMIN);
    const bp = Math.round(lo + t * (hi - lo));
    s.basePrice = bp;
    s.floor = Math.max(1, Math.round(o.floor * (bp / o.basePrice)));
  });
}
function restore() {
  STOCK_POOL.forEach((s, i) => { s.basePrice = ORIG[i].basePrice; s.floor = ORIG[i].floor; });
}
/** 只抬最低价：basePrice < lo 的一律抬到 lo */
function raiseMin(lo) {
  STOCK_POOL.forEach((s, i) => {
    const o = ORIG[i];
    const bp = Math.max(o.basePrice, lo);
    s.basePrice = bp;
    s.floor = Math.max(1, Math.round(o.floor * (bp / o.basePrice)));
  });
}

function pick(b, cmp) {
  return b.stockDefs.filter((d) => !b.isDelisted(d.code))
    .map((d) => ({ d, p: b.priceMap[d.code] })).sort(cmp)[0];
}
const POLICIES = [
  (b) => { if (!b.portfolio.hasPositions()) { const c = pick(b, (x, y) => x.p - y.p); if (c) { const L = maxLots(c.p, b.portfolio.cash); if (L >= 1) b.portfolio.buy(c.d.code, c.p, L * LOT_SIZE); } } },
  (b) => { if (!b.portfolio.hasPositions()) { const c = pick(b, (x, y) => y.p - x.p); if (c) { const L = maxLots(c.p, b.portfolio.cash); if (L >= 1) b.portfolio.buy(c.d.code, c.p, L * LOT_SIZE); } } },
  (b) => {
    b.stockDefs.forEach((d) => { const sh = b.portfolio.sharesOf(d.code); if (sh > 0) b.portfolio.sell(d.code, b.priceMap[d.code], sh); });
    const c = pick(b, (x, y) => y.p - x.p); if (c) { const L = maxLots(c.p, b.portfolio.cash); if (L >= 1) b.portfolio.buy(c.d.code, c.p, L * LOT_SIZE); }
  },
];

/** 破产线 + 破产率 */
function measure(initCash, N) {
  // --- 破产线分布（只抽第 1 关，不改任何东西）---
  const lines = [];
  const minLots = [];
  setSeed('dist');
  for (let i = 0; i < 400; i++) {
    const b = new DataBus();
    b.startRun('lv_01', { initCash });
    lines.push(b.bankruptLine());
    const ps = b.simulator.tradablePrices();
    minLots.push(costToBuy(Math.min(...ps), LOT_SIZE));
  }
  lines.sort((a, b) => a - b);
  minLots.sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];

  // --- 破产率 ---
  let bk = 0;
  let total = 0;
  for (let r = 0; r < 2; r++) {
    setSeed(`band-r${r}`);
    for (const policy of POLICIES) {
      for (let i = 0; i < N; i++) {
        const b = new DataBus();
        b.startRun('lv_01', { initCash });
        let guard = 0;
        while (b.phase !== 'OVER' && guard++ < 40) {
          b.nextTurn(); b.settle(); policy(b);
          if (b.isBankrupt()) { b.finish('bankrupt', 'x'); break; }
          if (b.isTermOver()) { b.settleTerm(); break; }
        }
        if (b.result.outcome === 'bankrupt') bk++;
        total++;
      }
    }
  }
  const p = bk / total;
  return {
    lineP50: q(lines, 0.5),
    lineP90: q(lines, 0.9),
    ratioP50: q(lines, 0.5) / initCash,
    lotP50: q(minLots, 0.5),
    bankrupt: p,
    ci: Math.sqrt((p * (1 - p)) / total) * 1.96,
  };
}

const N = 900;
const CASES = [
  ['现状（¥5~34，均价 ¥14.4）', () => restore()],
  ['窄带 ¥12~20（均价 ¥16，离散度 ↓）', () => band(12, 20)],
  ['窄带 ¥13~17（均价 ¥15，离散度 ↓↓）', () => band(13, 17)],
  ['窄带 ¥20~28（均价 ¥24，整体抬价）', () => band(20, 28)],
  ['只抬最低价到 ¥14', () => raiseMin(14)],
  ['只抬最低价到 ¥20', () => raiseMin(20)],
  ['放宽 ¥2~40（离散度 ↑）', () => band(2, 40)],
];

console.log('=== 本金固定 ¥10000，只动股票池的价格分布 ===\n');
console.log('价格分布                              破产线p50  占本金  最低一手p50   破产率   ±CI');
console.log('─'.repeat(92));
for (const [name, apply] of CASES) {
  apply();
  const r = measure(10000, N);
  console.log(
    name.padEnd(34)
    + ('¥' + r.lineP50.toFixed(0)).padStart(9)
    + (r.ratioP50 * 100).toFixed(1).padStart(7) + '%'
    + ('¥' + r.lotP50.toFixed(0)).padStart(12)
    + (r.bankrupt * 100).toFixed(2).padStart(9) + '%'
    + ('±' + (r.ci * 100).toFixed(2)).padStart(7),
  );
}
restore();

console.log('\n=== 对照：不动股票池，只降本钱 ===\n');
for (const cash of [10000, 6000, 4000]) {
  const r = measure(cash, N);
  console.log(
    ('本钱 ¥' + cash).padEnd(34)
    + ('¥' + r.lineP50.toFixed(0)).padStart(9)
    + (r.ratioP50 * 100).toFixed(1).padStart(7) + '%'
    + ('¥' + r.lotP50.toFixed(0)).padStart(12)
    + (r.bankrupt * 100).toFixed(2).padStart(9) + '%'
    + ('±' + (r.ci * 100).toFixed(2)).padStart(7),
  );
}
