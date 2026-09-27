// 临时：在「价差比 ≥ 5」约束下，最低价最多能抬到多少 + 对应破产率
//   做法：只抬最低价到 lo，同时把最高价抬到 max(34, 5*lo) 以保住价差比。
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
const OMAX = Math.max(...ORIG.map((o) => o.basePrice));

/** 只抬最低价到 lo；同时把最高价抬到 max(OMAX, 5*lo) */
function surgical(lo) {
  const hi = Math.max(OMAX, 5 * lo);
  STOCK_POOL.forEach((s, i) => {
    const o = ORIG[i];
    let bp = Math.max(o.basePrice, lo);
    if (o.basePrice === OMAX) bp = hi;
    s.basePrice = bp;
    s.floor = Math.max(1, Math.round(o.floor * (bp / o.basePrice)));
  });
  return hi;
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

function stats(initCash, N) {
  const lines = [];
  setSeed('dist');
  for (let i = 0; i < 300; i++) {
    const b = new DataBus();
    b.startRun('lv_01', { initCash });
    lines.push(b.bankruptLine());
  }
  lines.sort((a, b) => a - b);
  const q = (p) => lines[Math.min(lines.length - 1, Math.floor(lines.length * p))];

  let bk = 0, tot = 0, rbk = 0, rtot = 0;
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
  for (let r = 0; r < 2; r++) {
    setSeed(`run-r${r}`);
    for (const policy of POLICIES) {
      for (let i = 0; i < N; i++) {
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
  const lvP = bk / tot;
  const runP = rbk / rtot;
  return {
    lineP50: q(0.5), ratio: q(0.5) / initCash,
    lv: lvP, lvCI: Math.sqrt((lvP * (1 - lvP)) / tot) * 1.96,
    run: runP, runCI: Math.sqrt((runP * (1 - runP)) / rtot) * 1.96,
  };
}

const N = 500;
console.log('=== 合规前沿：最低价抬到 lo，最高价抬到 max(34, 5·lo) ===\n');
console.log('最低价   最高价  价差比  本钱     破产线p50 占本金   单关    整轮    ±CI');
console.log('─'.repeat(84));
restore();
for (const cash of [10000, 6000]) {
  for (const lo of [null, 7, 8, 10, 12]) {
    const hi = lo === null ? OMAX : surgical(lo);
    const s = stats(cash, N);
    const minP = lo === null ? Math.min(...ORIG.map((o) => o.basePrice)) : lo;
    console.log(
      (lo === null ? '（现状）' : '¥' + lo).padStart(7)
      + ('¥' + hi).padStart(8)
      + (hi / minP).toFixed(1).padStart(8)
      + ('¥' + cash).padStart(9)
      + ('¥' + s.lineP50.toFixed(0)).padStart(10)
      + (s.ratio * 100).toFixed(1).padStart(7) + '%'
      + (s.lv * 100).toFixed(2).padStart(8) + '%'
      + (s.run * 100).toFixed(1).padStart(8) + '%'
      + ('±' + (s.runCI * 100).toFixed(1)).padStart(7),
    );
  }
  restore();
}
