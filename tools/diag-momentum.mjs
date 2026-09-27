/**
 * 受控实验：把 pathgen 的各个分量单独拿出来，
 * 分别测量它们的"上月→本月自相关"，找出动量到底是哪来的。
 *
 * 分量：
 *   ① fromMarket = marketSeries[t] * beta   （大盘 β）
 *   ② trendBias  = trend * K * (cos+cos)    （个股周期 α）
 *   ③ noise      = uniform(-3.2v, +3.2v)    （白噪声，理论自相关 0）
 */

globalThis.wx = {
  createCanvas: () => ({ width: 375, height: 667, getContext: () => ({ scale() {} }) }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 3 }),
  onTouchStart() {},
};

const { STOCK_POOL } = await import('../js/data/index.js');
const { hashStr, makeRng, MARKET_STYLES } = await import('../js/market/pathgen.js');

const style = process.argv[2] || 'bull';
const GAMES = 120;
const TURNS = 12;
const mkt = MARKET_STYLES[style];

const corrOf = (pairs) => {
  const n = pairs.length;
  if (!n) return NaN;
  const mx = pairs.reduce((a, r) => a + r.prev, 0) / n;
  const my = pairs.reduce((a, r) => a + r.cur, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  pairs.forEach((r) => {
    cov += (r.prev - mx) * (r.cur - my);
    vx += (r.prev - mx) ** 2;
    vy += (r.cur - my) ** 2;
  });
  if (vx === 0 || vy === 0) return NaN;
  return cov / Math.sqrt(vx * vy);
};

const seriesOf = { mkt: [], trend: [], noise: [] };

for (let g = 0; g < GAMES; g++) {
  const seed = `diag${g}`;
  // 大盘
  const mktRng = makeRng(hashStr(`market|${style}|${seed}`));
  const market = [];
  for (let t = 0; t < TURNS; t++) {
    const noise = (mktRng() * 2 - 1) * mkt.marketVol;
    const accel = (t / (TURNS - 1)) * mkt.marketBias * 0.6;
    market.push(mkt.marketBias + accel + noise);
  }
  seriesOf.mkt.push(market);

  // 个股各分量（与 pathgen.generatePath 保持同步！改 pathgen 记得同步这里）
  STOCK_POOL.forEach((s) => {
    const prof = s.profile;
    const rng = makeRng(hashStr(`stock|${style}|${seed}|${s.code}`));
    const period = 4 + Math.floor(rng() * 5);
    const phase = rng() * Math.PI * 2;
    const period2 = 2 + Math.floor(rng() * 2);
    const phase2 = rng() * Math.PI * 2;
    const levelAt = (t) =>
      Math.sin((t / period) * Math.PI * 2 + phase) +
      Math.sin((t / period2) * Math.PI * 2 + phase2) * 0.55;
    const tr = [];
    const no = [];
    for (let t = 0; t < TURNS; t++) {
      // 与 pathgen 一致：sin 作用于价格水平，涨幅取差分
      const dLevel =
        t === 0
          ? Math.cos(phase) * ((2 * Math.PI) / period) + Math.cos(phase2) * 0.55 * ((2 * Math.PI) / period2)
          : levelAt(t) - levelAt(t - 1);
      tr.push(prof.trend * (style === 'bear' ? -2.6 : 2.6) * 2.0 * dLevel);
      no.push((rng() * 2 - 1) * prof.vol * 3.2);
    }
    seriesOf.trend.push(tr);
    seriesOf.noise.push(no);
  });
}

const pairsOf = (seriesList) => {
  const out = [];
  seriesList.forEach((s) => {
    for (let t = 1; t < s.length; t++) out.push({ prev: s[t - 1], cur: s[t] });
  });
  return out;
};

console.log(`style=${style}`);
console.log('各分量自身的"上月→本月"自相关（找动量来源）：');
console.log(`  ① 大盘 β       r = ${corrOf(pairsOf(seriesOf.mkt)).toFixed(3)}`);
console.log(`  ② 个股周期 α   r = ${corrOf(pairsOf(seriesOf.trend)).toFixed(3)}`);
console.log(`  ③ 白噪声       r = ${corrOf(pairsOf(seriesOf.noise)).toFixed(3)}`);

// 各分量的月度标准差（看谁主导）
const std = (seriesList) => {
  const all = seriesList.flat();
  const m = all.reduce((a, v) => a + v, 0) / all.length;
  return Math.sqrt(all.reduce((a, v) => a + (v - m) ** 2, 0) / all.length);
};
console.log('\n各分量月度标准差（谁大谁主导涨跌）：');
console.log(`  ① 大盘 β       σ = ${std(seriesOf.mkt).toFixed(2)}   （未乘 β 系数）`);
console.log(`  ② 个股周期 α   σ = ${std(seriesOf.trend).toFixed(2)}`);
console.log(`  ③ 白噪声       σ = ${std(seriesOf.noise).toFixed(2)}`);

// 用"上月涨幅"分位法，单独看周期 α 自己有没回归
const alphaPairs = pairsOf(seriesOf.trend);
const bins = [[], [], []];
const sorted = [...alphaPairs].sort((a, b) => a.prev - b.prev);
const N = sorted.length;
for (let k = 0; k < 3; k++) {
  const lo = Math.floor((k * N) / 3);
  const hi = Math.floor(((k + 1) * N) / 3);
  for (let i = lo; i < hi; i++) bins[k].push(sorted[i]);
}
console.log('\n个股周期 α 自身的上月分位 → 本月平均：');
['弱 1/3', '中 1/3', '强 1/3'].forEach((lb, k) => {
  const prevAvg = bins[k].reduce((a, r) => a + r.prev, 0) / bins[k].length;
  const curAvg = bins[k].reduce((a, r) => a + r.cur, 0) / bins[k].length;
  console.log(`  ${lb}  上月${prevAvg >= 0 ? '+' : ''}${prevAvg.toFixed(2)}% → 本月${curAvg >= 0 ? '+' : ''}${curAvg.toFixed(2)}%`);
});
