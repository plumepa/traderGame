// 临时：量化"破产可达性"—— 本钱 / 破产线 / 最大可承受亏损
globalThis.wx = {
  createCanvas: () => ({ width: 375, height: 667, getContext: () => ({ scale() {} }) }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 3 }),
  onTouchStart() {},
};

const { default: DataBus } = await import('../js/core/databus.js');
const { LOT_SIZE, maxLots, costToBuy } = await import('../js/market/order.js');
const { LEVELS } = await import('../js/data/levels.js');
const { setSeed } = await import('../js/core/random.js');

const N = 500;
const INIT = LEVELS[0].initCash;

// ---------- 1. 破产线分布 ----------
const lines = [];
const perLevel = {};
LEVELS.forEach((l) => { perLevel[l.id] = []; });
const cheapestPrices = [];

setSeed('analyze-1');
for (let i = 0; i < N; i++) {
  const lv = LEVELS[i % LEVELS.length];
  const b = new DataBus();
  b.startRun(lv.id);
  const line = b.bankruptLine();
  lines.push(line);
  perLevel[lv.id].push(line);
  const prices = b.stockDefs.map((d) => b.priceMap[d.code]);
  cheapestPrices.push(Math.min(...prices));
}

const q = (arr, p) => {
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

console.log(`=== 1. 破产线（= 最便宜的一手成本）分布，本金 ¥${INIT} ===\n`);
console.log(`  最低价（每股）  p10 ¥${q(cheapestPrices, 0.1).toFixed(2)}  p50 ¥${q(cheapestPrices, 0.5).toFixed(2)}  p90 ¥${q(cheapestPrices, 0.9).toFixed(2)}`);
console.log(`  破产线        min ¥${Math.min(...lines).toFixed(0)}  p10 ¥${q(lines, 0.1).toFixed(0)}  p50 ¥${q(lines, 0.5).toFixed(0)}  p90 ¥${q(lines, 0.9).toFixed(0)}  max ¥${Math.max(...lines).toFixed(0)}`);
console.log(`  破产线 / 本金   p10 ${(q(lines, 0.1) / INIT * 100).toFixed(1)}%  p50 ${(q(lines, 0.5) / INIT * 100).toFixed(1)}%  p90 ${(q(lines, 0.9) / INIT * 100).toFixed(1)}%`);
console.log(`  ★ 需要亏掉多少才破产：p10 ${((1 - q(lines, 0.9) / INIT) * 100).toFixed(0)}%  p50 ${((1 - q(lines, 0.5) / INIT) * 100).toFixed(0)}%  p90 ${((1 - q(lines, 0.1) / INIT) * 100).toFixed(0)}%`);

console.log('\n  各关破产线中位数：');
LEVELS.forEach((l) => {
  const a = perLevel[l.id];
  console.log(`    ${l.id}  ¥${q(a, 0.5).toFixed(0)}  (占本金 ${(q(a, 0.5) / INIT * 100).toFixed(1)}%，需亏 ${((1 - q(a, 0.5) / INIT) * 100).toFixed(0)}%)`);
});

// ---------- 2. 股价分布 & 可买性 ----------
console.log('\n=== 2. 股票价格分布（决定"本钱降到多少会买不起"）===\n');
const { STOCK_POOL } = await import('../js/data/pool.js');
const bp = STOCK_POOL.map((s) => s.basePrice).sort((a, b) => a - b);
const fl = STOCK_POOL.map((s) => s.floor).sort((a, b) => a - b);
console.log(`  basePrice  min ¥${bp[0]}  p25 ¥${q(bp, 0.25)}  p50 ¥${q(bp, 0.5)}  p75 ¥${q(bp, 0.75)}  max ¥${bp[bp.length - 1]}`);
console.log(`  floor      min ¥${fl[0]}  p50 ¥${q(fl, 0.5)}  max ¥${fl[fl.length - 1]}`);
console.log(`  一手成本（按 basePrice）  最低 ¥${(bp[0] * 100 + 5).toFixed(0)}  中位 ¥${(q(bp, 0.5) * 100 + 5).toFixed(0)}  最高 ¥${(bp[bp.length - 1] * 100 + 5).toFixed(0)}`);
console.log(`  ★ 三只股票中"最贵那只"的一手中位成本 ≈ ¥${(q(bp, 0.75) * 100 + 5).toFixed(0)}（抽 3 只，最贵的大约落在 p75 附近）`);

// ---------- 3. 不同本钱下的"破产所需亏损率" ----------
console.log('\n=== 3. 若把本钱改成 X，破产所需亏损率 ===\n');
console.log('  本钱    破产线/本钱(中位)   需亏      能买得起最贵那只吗');
[10000, 8000, 6000, 5000, 4000, 3000, 2500, 2000].forEach((cash) => {
  const mid = q(lines, 0.5);
  // 能买得起"最贵那只"？—— 用 p90 的最贵一手成本估
  const expensiveLot = q(bp, 0.9) * 100 + 5;
  const ok = cash >= expensiveLot;
  console.log(`  ¥${String(cash).padEnd(6)} ${(mid / cash * 100).toFixed(1).padStart(6)}%        ${((1 - mid / cash) * 100).toFixed(0).padStart(3)}%      ${ok ? '✓' : '✗（贵的那只一手 ' + expensiveLot.toFixed(0) + '）'}`);
});

// ---------- 4. 实际能亏到多深？（满仓死扛，看最低点） ----------
console.log('\n=== 4. 满仓死扛能亏到多深（观测到的最低总资产 / 本金）===\n');
function worstDrawdown(levelId, seed) {
  const b = new DataBus();
  b.startRun(levelId, { seedKey: seed });
  let minRatio = 1;
  let guard = 0;
  while (b.phase !== 'OVER' && guard++ < 40) {
    b.nextTurn();
    b.settle();
    if (!b.portfolio.hasPositions()) {
      const c = b.stockDefs.filter((d) => !b.isDelisted(d.code))
        .map((d) => ({ d, p: b.priceMap[d.code] })).sort((x, y) => x.p - y.p)[0];
      const lots = maxLots(c.p, b.portfolio.cash);
      if (lots >= 1) b.portfolio.buy(c.d.code, c.p, lots * LOT_SIZE);
    }
    const total = b.portfolio.totalAssets(b.priceMap);
    minRatio = Math.min(minRatio, total / b.initCash);
    if (b.isTermOver()) break;
  }
  return minRatio;
}

LEVELS.forEach((l) => {
  const ratios = [];
  let hitLine = 0;
  for (let i = 0; i < 300; i++) {
    const r = worstDrawdown(l.id, `dd${i}`);
    ratios.push(r);
    if (r * INIT < q(perLevel[l.id], 0.5)) hitLine++;
  }
  console.log(`  ${l.id}  最低总资产/本金  p10 ${(q(ratios, 0.1) * 100).toFixed(0)}%  p50 ${(q(ratios, 0.5) * 100).toFixed(0)}%  最惨 ${(Math.min(...ratios) * 100).toFixed(0)}%  ← 破线 ${hitLine}/300`);
});

// ---------- 5. 备选口径：破产线 = k × 最便宜一手 ----------
console.log('\n=== 5. 若破产线改成「k 手都买不起」===\n');
[1, 2, 3, 4, 5].forEach((k) => {
  const kLines = lines.map((x) => x * k);
  console.log(`  k=${k}  破产线中位 ¥${q(kLines, 0.5).toFixed(0)}  (占本金 ${(q(kLines, 0.5) / INIT * 100).toFixed(1)}%)  需亏 ${((1 - q(kLines, 0.5) / INIT) * 100).toFixed(0)}%`);
});
