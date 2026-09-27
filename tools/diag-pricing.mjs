/**
 * 一次性诊断：为什么"换手梭哈"没有被惩罚？
 *
 * 关注的不是"贵的股票是否涨得多"（那是静态相关），
 * 而是**动态追高**：如果某只股票上月涨得最猛，
 * 它下个月是继续涨、还是均值回归（回调）？
 *
 * 均值回归成立 → "看到涨就追"必然买在阶段顶部 → 换手策略被惩罚。
 * 均值回归不成立（动量延续）→ 追高真的赚钱，平衡测试就会失败。
 *
 * 运行：
 *   node --experimental-loader ./tools/register.mjs tools/diag-pricing.mjs [style]
 */

globalThis.wx = {
  createCanvas: () => ({ width: 375, height: 667, getContext: () => ({ scale() {} }) }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 3 }),
  onTouchStart() {},
};

const { STOCK_POOL } = await import('../js/data/index.js');
const { generatePath } = await import('../js/market/pathgen.js');

const style = process.argv[2] || 'bull';
const GAMES = 120;
const TURNS = 12;

// 收集所有 (上月涨幅, 本月涨幅) 的样本对
const pairs = [];
// 也收集"上月最强的股票，本月表现"
let topNextSum = 0;
let allNextSum = 0;
let topCount = 0;
let allCount = 0;
// 分位分解：上月涨幅的 5 档 → 本月平均
const QUINT = 5;
const bins = Array.from({ length: QUINT }, () => []);

for (let g = 0; g < GAMES; g++) {
  const seed = `diag${g}`;
  const defs = STOCK_POOL.map((s) => ({
    code: s.code,
    name: s.name,
    price: s.basePrice,
    path: generatePath(s, style, seed, TURNS),
  }));

  for (let t = 1; t < TURNS; t++) {
    // 记录每一对 (prev, cur)
    const rows = defs.map((d) => ({
      code: d.code,
      prev: d.path[t - 1],
      cur: d.path[t],
    }));
    rows.forEach((r) => pairs.push(r));

    // 上月最强 vs 全体，在本月的表现
    const best = rows.reduce((a, b) => (a.prev >= b.prev ? a : b));
    topNextSum += best.cur;
    topCount++;
    rows.forEach((r) => {
      allNextSum += r.cur;
      allCount++;
    });

    // 分位：按上月涨幅排序切 5 档
    const sorted = [...rows].sort((a, b) => a.prev - b.prev);
    const n = sorted.length;
    for (let k = 0; k < QUINT; k++) {
      const lo = Math.floor((k * n) / QUINT);
      const hi = Math.floor(((k + 1) * n) / QUINT);
      for (let i = lo; i < hi; i++) bins[k].push(sorted[i]);
    }
  }
}

// 相关性：上月涨幅 → 本月涨幅
const n = pairs.length;
const mx = pairs.reduce((a, r) => a + r.prev, 0) / n;
const my = pairs.reduce((a, r) => a + r.cur, 0) / n;
let cov = 0;
let vx = 0;
let vy = 0;
pairs.forEach((r) => {
  cov += (r.prev - mx) * (r.cur - my);
  vx += (r.prev - mx) ** 2;
  vy += (r.cur - my) ** 2;
});
const corr = cov / Math.sqrt(vx * vy);

console.log(`style=${style}  ${GAMES} 局 × ${TURNS} 月，样本对 ${n}`);
console.log('─'.repeat(56));
console.log(`上月涨幅 → 本月涨幅 相关系数   r = ${corr.toFixed(3)}`);
console.log(`  （r > 0 表示动量延续，追高有效；r < 0 表示均值回归，追高被套）`);
console.log('');
console.log(`全体     本月平均涨幅 = ${my.toFixed(2)}%`);
console.log(`上月最强 本月平均涨幅 = ${(topNextSum / topCount).toFixed(2)}%`);
const edge = topNextSum / topCount - allNextSum / allCount;
console.log(`        追高相对全体超额 = ${edge >= 0 ? '+' : ''}${edge.toFixed(2)}%  ${edge < 0 ? '✓ 追高被惩罚' : '✗ 追高占便宜'}`);
console.log('');
console.log('上月涨幅分位 → 本月平均涨幅（均值回归应单调递减）：');
const labels = ['最弱 20%', '偏弱 20%', '中间 20%', '偏强 20%', '最强 20%'];
bins.forEach((b, k) => {
  const prevAvg = b.reduce((a, r) => a + r.prev, 0) / b.length;
  const curAvg = b.reduce((a, r) => a + r.cur, 0) / b.length;
  console.log(
    `  ${labels[k]}  上月${prevAvg >= 0 ? '+' : ''}${prevAvg.toFixed(1)}%  →  本月${curAvg >= 0 ? '+' : ''}${curAvg.toFixed(2)}%   (n=${b.length})`,
  );
});
const slope = bins[QUINT - 1].reduce((a, r) => a + r.cur, 0) / bins[QUINT - 1].length -
  bins[0].reduce((a, r) => a + r.cur, 0) / bins[0].length;
console.log(`\n最强档 − 最弱档 = ${slope >= 0 ? '+' : ''}${slope.toFixed(2)}%  ${slope < 0 ? '✓ 均值回归成立' : '✗ 动量延续'}`);
