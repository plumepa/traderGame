// 临时：在「价差比 ≥ 5」约束下能做到什么 + 各组合的单关/整轮破产率
globalThis.wx = {
  createCanvas: () => ({ width: 375, height: 667, getContext: () => ({ scale() {} }) }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 3 }),
  onTouchStart() {},
};

const { default: DataBus } = await import('../js/core/databus.js');
const { LOT_SIZE, maxLots, costToBuy } = await import('../js/market/order.js');
const { STOCK_POOL } = await import('../js/data/pool.js');
const { LEVELS } = await import('../js/data/levels.js');
const { setSeed } = await import('../js/core/random.js');

const ORIG = STOCK_POOL.map((s) => ({ basePrice: s.basePrice, floor: s.floor }));
const BMIN = Math.min(...ORIG.map((o) => o.basePrice));
const BMAX = Math.max(...ORIG.map((o) => o.basePrice));

/** 只抬最低价（floor 按比例缩放） */
function raiseMin(lo) {
  STOCK_POOL.forEach((s, i) => {
    const o = ORIG[i];
    const bp = Math.max(o.basePrice, lo);
    s.basePrice = bp;
    s.floor = Math.max(1, Math.round(o.floor * (bp / o.basePrice)));
  });
}
/** 抬最低价 + 抬最高价（保持价差比） */
function reshape(lo, hi) {
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

function pick(b, cmp) {
  return b.stockDefs.filter((d) => !b.isDelisted(d.code))
    .map((d) => ({ d, p: b.priceMap[d.code] })).sort(cmp)[0];
}
function buyBest(b, cmp) {
  const c = pick(b, cmp);
  if (!c) return;
  const L = maxLots(c.p, b.portfolio.cash);
  if (L >= 1) b.portfolio.buy(c.d.code, c.p, L * LOT_SIZE);
}
const POLICIES = [
  (b) => { if (!b.portfolio.hasPositions()) buyBest(b, (x, y) => x.p - y.p); },
  (b) => { if (!b.portfolio.hasPositions()) buyBest(b, (x, y) => y.p - x.p); },
  (b) => {
    b.stockDefs.forEach((d) => { const sh = b.portfolio.sharesOf(d.code); if (sh > 0) b.portfolio.sell(d.code, b.priceMap[d.code], sh); });
    buyBest(b, (x, y) => y.p - x.p);
  },
  (b) => {
    if (b.portfolio.hasPositions()) return;
    const c = b.stockDefs.filter((d) => !b.isDelisted(d.code))
      .map((d) => ({ d, p: b.priceMap[d.code] })).sort((x, y) => x.p - y.p).slice(0, 2);
    const each = Math.floor(b.portfolio.cash / 2 / (c.length || 1));
    c.forEach((x) => { const L = maxLots(x.p, each); if (L >= 1) b.portfolio.buy(x.d.code, x.p, L * LOT_SIZE); });
  },
];

function stats(initCash, N, runN) {
  // 破产线 / 一手成本分布
  const lines = [];
  setSeed('dist');
  for (let i = 0; i < 400; i++) {
    const b = new DataBus();
    b.startRun('lv_01', { initCash });
    lines.push(b.bankruptLine());
  }
  lines.sort((a, b) => a - b);
  const q = (p) => lines[Math.min(lines.length - 1, Math.floor(lines.length * p))];

  // 单关破产率
  let bk = 0;
  let tot = 0;
  for (let r = 0; r < 2; r++) {
    setSeed(`lv-r${r}`);
    for (const policy of POLICIES) {
      for (let i = 0; i < N; i++) {
        const b = new DataBus();
        b.startRun('lv_01', { initCash });
        let g = 0;
        while (b.phase !== 'OVER' && g++ < 40) {
          b.nextTurn(); b.settle(); policy(b);
          if (b.isBankrupt()) { b.finish('bankrupt', 'x'); break; }
          if (b.isTermOver()) { b.settleTerm(); break; }
        }
        if (b.result.outcome === 'bankrupt') bk++;
        tot++;
      }
    }
  }
  const lvP = bk / tot;
  const lvCI = Math.sqrt((lvP * (1 - lvP)) / tot) * 1.96;

  // 整轮连闯 5 关破产率
  let rbk = 0;
  let rtot = 0;
  for (let r = 0; r < 2; r++) {
    setSeed(`run-r${r}`);
    for (const policy of POLICIES) {
      for (let i = 0; i < runN; i++) {
        const b = new DataBus();
        let dead = false;
        for (let li = 0; li < LEVELS.length && !dead; li++) {
          if (li === 0) { if (!b.startRun(LEVELS[0].id, { initCash })) { dead = true; break; } }
          else if (!b.startNextLevel()) { dead = true; break; }
          if (b.isBankrupt()) { b.finish('bankrupt', 'x'); dead = true; break; }
          let g = 0;
          while (b.phase !== 'OVER' && g++ < 60) {
            b.nextTurn(); b.settle(); policy(b);
            if (b.isBankrupt()) { b.finish('bankrupt', 'x'); dead = true; break; }
            if (b.isTermOver()) { b.settleTerm(); break; }
          }
        }
        if (dead || b.result.outcome === 'bankrupt') rbk++;
        rtot++;
      }
    }
  }
  const runP = rbk / rtot;
  return {
    lineP50: q(0.5), ratio: q(0.5) / initCash,
    lv: lvP, lvCI,
    run: runP, runCI: Math.sqrt((runP * (1 - runP)) / rtot) * 1.96,
  };
}

const CASES = [
  ['现状池 ¥5~34', () => restore(), 10000],
  ['合规上界 ¥8~40（价差比 5.0）', () => reshape(8, 40), 10000],
  ['合规上界 ¥8~40 + 本钱 6000', () => reshape(8, 40), 6000],
  ['现状池 + 本钱 6000（你选的）', () => restore(), 6000],
  ['破规 ¥14~40（价差比 2.9）', () => reshape(14, 40), 10000],
  ['破规 ¥14~40 + 本钱 6000', () => reshape(14, 40), 6000],
];

console.log('=== 单关 / 整轮破产率（4 策略）===\n');
console.log('方案                                破产线p50 占本金   单关破产率   ±CI     整轮破产率   ±CI');
console.log('─'.repeat(96));
for (const [name, apply, cash] of CASES) {
  apply();
  const s = stats(cash, 700, 700);
  console.log(
    name.padEnd(32)
    + ('¥' + s.lineP50.toFixed(0)).padStart(9)
    + (s.ratio * 100).toFixed(1).padStart(7) + '%'
    + (s.lv * 100).toFixed(2).padStart(11) + '%'
    + ('±' + (s.lvCI * 100).toFixed(2)).padStart(7)
    + (s.run * 100).toFixed(1).padStart(11) + '%'
    + ('±' + (s.runCI * 100).toFixed(1)).padStart(7),
  );
}
restore();
