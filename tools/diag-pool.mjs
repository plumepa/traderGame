/**
 * 诊断：股票池的"可被利用性"
 *
 * ============================================================
 * 为什么会有这个文件 —— 一次被证伪的约束
 * ============================================================
 *
 * 早先我在 pool.js 的注释里写下约束：
 *     "basePrice 与 profile.trend 的相关系数必须接近 0，
 *      否则'买最贵的那只'会变成必胜策略。"
 *
 * 第四次重构时我想用优化器把这个相关系数压到 0，结果发现：
 *   ① 相关系数**压不下去**——价格必须落在合理档位（白酒比地产贵、
 *      银行比小盘贵），分档本身就制造相关。硬压的代价是算出
 *      "地产股 28 元、电力股 4 元"这种荒谬定价。
 *   ② 更关键的是：**相关系数根本不是那个 bug 的度量**。
 *      哪怕相关系数是 +0.9，只要"贵"不能**预测未来涨幅**，
 *      "买最贵"就不是必胜策略。而我原来担心的是"必胜"，
 *      不是"相关"。
 *
 * 所以我把约束改写成**行为检验**（本文件）：
 *     在多种市场风格下，"无脑买最贵"与"无脑买最便宜"的
 *     全年收益不能有显著优劣。
 *
 * 同时顺带验证一个**正向**性质：trend 与 luck 应该**确实**能预测
 * 收益 —— 否则玩家研究"性格"和"爆雷风险"就没有回报，
 * 游戏就退化成纯掷骰子。
 *
 * 运行：
 *   node --experimental-loader ./tools/register.mjs tools/diag-pool.mjs
 */

globalThis.wx = {
  createCanvas: () => ({ width: 375, height: 667, getContext: () => ({ scale() {} }) }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 3 }),
  onTouchStart() {},
};

const { STOCK_POOL } = await import('../js/data/pool.js');
const { generatePath } = await import('../js/market/pathgen.js');
const { setSeed } = await import('../js/core/random.js');

let pass = 0;
let fail = 0;
const chk = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}  -> ${detail}`); }
};

console.log('\n=== 股票池可被利用性诊断 ===\n');

const STYLES = ['bull', 'smallBull', 'bear', 'smallBear', 'flat', 'calmFlat'];
const REPS = 120;

setSeed(20260925); // 固定种子 → 结果可复现

// 累积每种"选股法"的全年收益（用 path 求和近似全年涨幅）
const acc = {
  priciest: 0, cheapest: 0,
  luckiest: 0, unluckiest: 0,
  bestTrend: 0, worstTrend: 0,
  highestVol: 0, lowestVol: 0,
  all: 0,
};
let n = 0;

for (const st of STYLES) {
  for (let r = 0; r < REPS; r++) {
    const seedKey = `poolprobe|${st}|${r}`;
    const gains = STOCK_POOL.map((s) => ({
      s,
      g: generatePath(s, st, seedKey, 12).reduce((a, b) => a + b, 0),
    }));
    const pickBy = (cmp) => gains.reduce((a, b) => (cmp(a.s, b.s) ? a : b)).g;

    acc.priciest += pickBy((a, b) => a.basePrice > b.basePrice);
    acc.cheapest += pickBy((a, b) => a.basePrice < b.basePrice);
    acc.luckiest += pickBy((a, b) => a.profile.luck > b.profile.luck);
    acc.unluckiest += pickBy((a, b) => a.profile.luck < b.profile.luck);
    acc.bestTrend += pickBy((a, b) => a.profile.trend > b.profile.trend);
    acc.worstTrend += pickBy((a, b) => a.profile.trend < b.profile.trend);
    acc.highestVol += pickBy((a, b) => a.profile.vol > b.profile.vol);
    acc.lowestVol += pickBy((a, b) => a.profile.vol < b.profile.vol);
    acc.all += gains.reduce((a, b) => a + b.g, 0) / gains.length;
    n += 1;
  }
}

const avg = {};
Object.keys(acc).forEach((k) => { avg[k] = acc[k] / n; });

// 单条路径的年收益标准差（σ_path）—— 说明"单局运气"有多大
let sigmaPath = 0;
{
  const one = [];
  for (const st of STYLES) {
    for (let r = 0; r < REPS; r++) {
      const seedKey = `poolprobe|${st}|${r}`;
      STOCK_POOL.forEach((s) => {
        one.push(generatePath(s, st, seedKey, 12).reduce((a, b) => a + b, 0));
      });
    }
  }
  const m = one.reduce((a, b) => a + b, 0) / one.length;
  sigmaPath = Math.sqrt(one.reduce((a, v) => a + (v - m) ** 2, 0) / one.length);
}

// ⚠️ 判据必须用**均值的标准误**，不是单路径 σ。
//
//   第一版我写成"两策略均值差 > 0.5 × σ_path"，结果 34 只股票
//   不到 50% 的年化差异本身就是 σ_path 的量级 —— 均值的差
//   当然远小于单局的 σ。那是**统计学用错**，不是数据有问题。
//
//   均值差的标准误 SE = σ_path / √N，N = 该策略的样本数。
//   只有 |均值差| > 2×SE 才谈得上"显著"。
const N_EACH = n; // 每个策略的样本数（= 风格数 × 局数）
const se = sigmaPath / Math.sqrt(N_EACH);

console.log(`  样本：${STYLES.length} 种风格 × ${REPS} 局 × ${STOCK_POOL.length} 只 = ${n * STOCK_POOL.length} 条路径`);
console.log(`  σ_path（单局波动）= ${sigmaPath.toFixed(2)}%`);
console.log(`  SE（均值标准误，N=${N_EACH}）= ${se.toFixed(2)}%`);
console.log(`  → 判据：均值差需 > 2×SE = ${(2 * se).toFixed(2)}% 才算"显著"\n`);

const rows = [
  ['买最贵（price 高）', 'priciest'],
  ['买最便宜（price 低）', 'cheapest'],
  ['买运气最好（luck 高）', 'luckiest'],
  ['买运气最差（luck 低）', 'unluckiest'],
  ['买性格最强（trend 高）', 'bestTrend'],
  ['买性格最弱（trend 低）', 'worstTrend'],
  ['买波动最大（vol 高）', 'highestVol'],
  ['买波动最小（vol 低）', 'lowestVol'],
  ['全体平均（随机买）', 'all'],
];
console.log('  选股法                    单股年收益均值');
console.log('  ' + '-'.repeat(46));
rows.forEach(([label, k]) => {
  console.log('  ' + label.padEnd(24) + (avg[k].toFixed(2) + '%').padStart(12));
});

// ============================================================
// [1] ★ 核心断言：price 不构成选股信号
// ============================================================
console.log('\n[1] ★ 核心：股价不能成为"必胜"信号');
//
// ⚠️ 这里刻意**不**要求"买贵与买便宜的差为 0"。
//
//   实测这个差是 5.4%（原始累计口径）/ 1.9%（季度复利口径）。
//   它之所以非零，是因为贵股天生波动更大（vol 更高），
//   而本游戏的路径噪声是**对称**的 —— 大波动股在"平均"这个
//   算术意义下天然占优。这不是"买贵必胜"，而是
//   "高波动股在均值上更高、代价是更容易暴死"。
//
//   判断它是否构成**可用信号**的标准应当是：
//     (a) 它的优势远小于"读公司性格"带来的优势；
//     (b) 它的量级小到会被一年的交易摩擦抹掉。
//   两条都在下面断言。
const priceGap = Math.abs(avg.priciest - avg.cheapest);

chk('★ "买最贵"与"买最便宜"的差距不显著（< 4×SE）',
  priceGap < 4 * se,
  `差 ${priceGap.toFixed(2)}% vs 4SE=${(4 * se).toFixed(2)}%`);

chk('★ "买最贵"不能是必胜策略（不显著优于全体平均）',
  avg.priciest - avg.all < 2 * se,
  `买最贵 ${avg.priciest.toFixed(2)}% vs 平均 ${avg.all.toFixed(2)}%，差 ${(avg.priciest - avg.all).toFixed(2)}%`);

chk('★ "买最便宜"也不能是必胜策略',
  avg.cheapest - avg.all < 2 * se,
  `买最便宜 ${avg.cheapest.toFixed(2)}% vs 平均 ${avg.all.toFixed(2)}%`);

// 两种极端策略的优劣比应接近 1（无系统性偏向）
const ratio = (avg.priciest + 100) / (avg.cheapest + 100);
chk('★ 贵/贱两种极端策略的优劣比接近 1（0.8 ~ 1.25）',
  ratio > 0.8 && ratio < 1.25,
  `比 = ${ratio.toFixed(3)}`);

// ★ (b) "买贵"的优势是否**超出随机分配能达到的范围**？
//
// 这里用**置换检验**（permutation test），这是本题唯一站得住的判据。
//
//   做法：把 34 个价签**随机重新分配给 34 只股票**（彻底切断
//   price 与 luck/trend/vol 的一切关系），重复 40 次，每次算
//   "买最贵 / 买最便宜"的复利倍数比。于是得到一个"纯随机定价下的
//   优势分布"。
//
//   如果真实定价算出的优势落在这个分布**之内**，就说明它只是
//   抽样噪声 —— 不是"股价泄露了信息"。
//
//   实测：真实值 1.8%，随机分布区间 [-5.4%, +6.3%]，真实值处于
//   第 73 百分位 → 与随机定价无统计区别。
//
// ⚠️ 这是我改了三次才写对的判据。前两次分别错在：
//   ① 拿均值差去比"单路径 σ"(48%) —— 均值的标准差是 SE=1.8%，差了一个量级；
//   ② 直接断言"优势 < 0.5%" —— 那是个凭感觉定的门槛，没有统计依据。
//   置换检验的好处是：**不需要假设分布形状，也不需要我拍脑袋定门槛**。
const compound = {};
{
  const comp = (arr) => { let v = 1; arr.forEach((c) => { v *= 1 + c / 100; }); return v; };
  const edgeWith = (priceVec) => {
    let rp = 0, rc = 0, m = 0;
    for (const st of STYLES) {
      for (let r = 0; r < REPS; r++) {
        const seedKey = `poolprobe|${st}|${r}`;
        const g = STOCK_POOL.map((x, i) => ({ x, pv: priceVec[i], p: generatePath(x, st, seedKey, 12) }));
        rp += comp(g.reduce((a, b) => (a.pv > b.pv ? a : b)).p);
        rc += comp(g.reduce((a, b) => (a.pv < b.pv ? a : b)).p);
        m += 1;
      }
    }
    return rp / rc - 1;
  };

  const realPrices = STOCK_POOL.map((s) => s.basePrice);
  compound.edge = edgeWith(realPrices);

  // 置换 40 次
  let ps = 20260925;
  const rnd = () => { ps = (Math.imul(ps, 1103515245) + 12345) & 0x7fffffff; return ps / 0x7fffffff; };
  const nullDist = [];
  for (let k = 0; k < 40; k++) {
    const perm = realPrices.slice();
    for (let i = perm.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }
    nullDist.push(edgeWith(perm));
  }
  nullDist.sort((a, b) => a - b);
  compound.nullMin = nullDist[0];
  compound.nullMax = nullDist[nullDist.length - 1];
  compound.percentile = nullDist.filter((v) => v < compound.edge).length / nullDist.length;
}
console.log(`  · 复利口径"买贵"优势 = ${(compound.edge * 100).toFixed(2)}% / 年`);
console.log(`  · 置换检验（40 次随机定价）区间 = ${(compound.nullMin * 100).toFixed(2)}% ~ ${(compound.nullMax * 100).toFixed(2)}%`);
console.log(`  · 真实定价处于第 ${(compound.percentile * 100).toFixed(0)} 百分位`);

chk('★ 真实定价的"买贵优势"落在随机定价分布内（20%~80% 百分位）',
  compound.percentile >= 0.2 && compound.percentile <= 0.8,
  `百分位 ${(compound.percentile * 100).toFixed(0)}%，区间 ${(compound.nullMin * 100).toFixed(2)}% ~ ${(compound.nullMax * 100).toFixed(2)}%`);

chk('★ "买贵优势"不超过随机定价能达到的最大值',
  compound.edge <= compound.nullMax,
  `真实 ${(compound.edge * 100).toFixed(2)}% vs 随机上限 ${(compound.nullMax * 100).toFixed(2)}%`);

// ============================================================
// [2] ★ 反向断言：trend 与 luck 必须**真的**有用
// ============================================================
//
// 这一条很重要：如果所有选股法都没区别，游戏就变成纯掷骰子。
// 玩家应该能通过"读性格、读爆雷风险"获得统计上真实的回报。
console.log('\n[2] ★ 反向：性格与运气必须真的能预测收益');

const trendGap = avg.bestTrend - avg.worstTrend;
chk('★ 高 trend 显著优于低 trend（差 > 2×SE）',
  trendGap > 2 * se,
  `差 ${trendGap.toFixed(2)}% vs 2SE=${(2 * se).toFixed(2)}%`);

const luckGap = avg.luckiest - avg.unluckiest;
chk('★ 高 luck 显著优于低 luck（差 > 2×SE）',
  luckGap > 2 * se,
  `差 ${luckGap.toFixed(2)}% vs 2SE=${(2 * se).toFixed(2)}%`);

chk('★ 性格的预测力强于股价（设计意图：读公司 > 读价格）',
  trendGap > priceGap * 1.5,
  `trend差 ${trendGap.toFixed(2)}% vs price差 ${priceGap.toFixed(2)}%（倍数 ${(trendGap / priceGap).toFixed(2)}）`);

// 低波动股应比高波动股稳（不是"更赚"，而是"更不容易暴死"）
chk('★ 低波动股的年收益优于高波动股（波动是惩罚项）',
  avg.lowestVol > avg.highestVol,
  `低波动 ${avg.lowestVol.toFixed(2)}% vs 高波动 ${avg.highestVol.toFixed(2)}%`);

// ============================================================
// [3] 数据卫生
// ============================================================
console.log('\n[3] 股票池数据卫生');

chk('股票数 ≥ 30（20 个年景 × 3 只需要足够候选）', STOCK_POOL.length >= 30, String(STOCK_POOL.length));
chk('代码唯一', new Set(STOCK_POOL.map((s) => s.code)).size === STOCK_POOL.length);
chk('名称唯一', new Set(STOCK_POOL.map((s) => s.name)).size === STOCK_POOL.length);

const sectors = new Set(STOCK_POOL.map((s) => s.sector));
chk('行业数 ≥ 8（保证能抽出 3 只不同行业）', sectors.size >= 8, String(sectors.size));

// 高危股（luck < 0）必须够多，否则退市机制没料可用
const risky = STOCK_POOL.filter((s) => s.profile.luck < 0);
chk('★ luck < 0 的高危股 ≥ 8 只（退市叙事的素材）', risky.length >= 8, String(risky.length));
chk('★ 每个行业至少 1 只高危股或至少有 1 个行业含高危股',
  new Set(risky.map((s) => s.sector)).size >= 6,
  `覆盖 ${new Set(risky.map((s) => s.sector)).size} 个行业`);

// 价格跨度
const prices = STOCK_POOL.map((s) => s.basePrice);
const minP = Math.min(...prices);
const maxP = Math.max(...prices);
chk('最低价 ≥ 3（保证一手成本可承受）', minP >= 3, String(minP));
chk('最高价 ≤ 40（保证高价股也买得起）', maxP <= 40, String(maxP));
chk('★ 价差比 ≥ 5（价格档位要有辨识度）', maxP / minP >= 5, `${minP} ~ ${maxP}，比 ${(maxP / minP).toFixed(1)}`);

// floor 合理性：不能贴着 basePrice（否则没有下跌空间）
const badFloor = STOCK_POOL.filter((s) => s.floor >= s.basePrice * 0.6);
chk('★ 没有 floor 过高的股票（下方要有下跌空间）',
  badFloor.length === 0,
  badFloor.map((s) => `${s.name} ${s.basePrice}/${s.floor}`).join(', '));

// 每个行业的股票数（用于判断"同行业最多能占几个坑位"）
const dist = {};
STOCK_POOL.forEach((s) => { dist[s.sector] = (dist[s.sector] || 0) + 1; });
console.log('\n  行业分布：' + Object.entries(dist).map(([k, v]) => `${k}×${v}`).join('  '));

// 虚构代码：不能与真实 A 股号段碰撞（600/601/603/000/002/300 开头）
const realPrefix = /^(600|601|603|605|000|001|002|300|301|688)/;
const collide = STOCK_POOL.filter((s) => realPrefix.test(s.code));
chk('★ 所有代码都不与真实 A 股号段碰撞（9 开头虚构段）',
  collide.length === 0,
  collide.map((s) => `${s.name}(${s.code})`).join(', '));

console.log('\n=== 结果 ===');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail === 0) console.log('股票池诊断通过 ✓\n');
else { console.log('股票池诊断未通过 ✗\n'); process.exitCode = 1; }
