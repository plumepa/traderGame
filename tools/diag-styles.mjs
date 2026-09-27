/**
 * 诊断：六种市场风格是否真的"性格不同"
 *
 * 背景：第三版把 style 从 3 型扩到 6 型。pathgen 里原本有两处
 * 硬编码的 `style === 'bear'` 判断，新增风格时会静默失效。
 * 本诊断用**受控实验**（同一批股票、同一 seedKey，只换 style）
 * 量化每个风格的中枢收益、波动、退市率，确认六者两两可分。
 *
 * 运行：
 *   node --experimental-loader ./tools/register.mjs tools/diag-styles.mjs
 */

globalThis.wx = {
  createCanvas: () => ({ width: 375, height: 667, getContext: () => ({ scale() {} }) }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 3 }),
  onTouchStart() {},
};

const {
  MARKET_STYLES,
  MARKET_STYLE_KEYS,
  generatePath,
  rollDelist,
} = await import('../js/market/pathgen.js');
const { STOCK_POOL } = await import('../js/data/pool.js');
const { setSeed, clearSeed } = await import('../js/core/random.js');

let pass = 0;
let fail = 0;
const chk = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}  -> ${detail}`); }
};

console.log('\n=== 市场风格诊断（六型是否真的不同）===\n');

// ============================================================
// [1] 数据完整性：每个风格都必须把 pathgen 需要的字段填齐
// ============================================================
console.log('[1] 风格数据完整性');
chk('至少有 6 种市场风格', MARKET_STYLE_KEYS.length >= 6, MARKET_STYLE_KEYS.join('/'));
['bull', 'smallBull', 'bear', 'smallBear', 'flat', 'calmFlat'].forEach((k) => {
  const s = MARKET_STYLES[k];
  chk(`风格 ${k} 存在`, !!s);
  if (!s) return;
  ['marketBias', 'marketVol', 'luckScale', 'trendScale', 'delistBase', 'crashChance'].forEach((f) => {
    chk(`  ${k}.${f} 是数字`, typeof s[f] === 'number' && !Number.isNaN(s[f]), String(s[f]));
  });
  chk(`  ${k} 有中文 label`, typeof s.label === 'string' && s.label.length > 0, String(s.label));
});

// ★ trendScale 必须带符号：牛市正、熊市负 —— 这是"性格顺势/逆势"的开关
console.log('\n  · trendScale 符号（牛正熊负是设计契约）');
chk('★ 大牛 trendScale > 0', MARKET_STYLES.bull.trendScale > 0);
chk('★ 小牛 trendScale > 0', MARKET_STYLES.smallBull.trendScale > 0);
chk('★ 大熊 trendScale < 0', MARKET_STYLES.bear.trendScale < 0);
chk('★ 小熊 trendScale < 0', MARKET_STYLES.smallBear.trendScale < 0);
chk('★ 大熊比小熊更负', MARKET_STYLES.bear.trendScale < MARKET_STYLES.smallBear.trendScale);

// ============================================================
// [2] 受控实验：同一批股票 + 同一 seedKey，只换 style
// ============================================================
console.log('\n[2] 受控实验（同股同种子，只换风格）');

// 取 6 只 profile 中性的股票，避免 trend 极端主导结论
const probe = STOCK_POOL.filter((s) => Math.abs(s.profile.trend) < 0.4).slice(0, 40);
const SEED = 'styleprobe';
const REPS = 60; // 每个风格跑 60 个 seedKey，取平均

const stat = {};
MARKET_STYLE_KEYS.forEach((k) => {
  stat[k] = { sum: 0, n: 0, vol: 0, crash: 0, delist: 0, pathSum: 0, pathN: 0 };
});

clearSeed();
for (let r = 0; r < REPS; r++) {
  const seedKey = `${SEED}_${r}`;
  MARKET_STYLE_KEYS.forEach((k) => {
    probe.forEach((stk) => {
      const p = generatePath(stk, k, seedKey, 12);
      const sum = p.reduce((a, b) => a + b, 0);
      stat[k].sum += sum;
      stat[k].n += 1;
      stat[k].pathSum += sum;
      stat[k].pathN += 1;
      // 单月绝对值均值为"波动"代理
      stat[k].vol += p.reduce((a, b) => a + Math.abs(b), 0) / p.length;
      // 单月跌幅超过 12% 视为一次暴跌
      stat[k].crash += p.filter((v) => v <= -12).length;
      // 退市判定
      if (rollDelist(stk, k, seedKey, 12)) stat[k].delist += 1;
    });
  });
}

console.log('\n  风格        年均累计涨幅   月均绝对波动   暴跌月占比   退市率');
console.log('  ' + '-'.repeat(62));
const rows = {};
MARKET_STYLE_KEYS.forEach((k) => {
  const s = stat[k];
  const avgSum = s.sum / s.n;                 // 12 个月累计（%，近似年收益）
  const avgVol = s.vol / s.n;                 // 月均 |change|
  const crashRate = s.crash / s.n;            // 每 12 个月里暴跌月数占比
  const delistRate = s.delist / (REPS * probe.length);
  rows[k] = { avgSum, avgVol, crashRate, delistRate };
  console.log(
    '  ' + MARKET_STYLES[k].label.padEnd(10) +
    avgSum.toFixed(2).padStart(10) +
    avgVol.toFixed(2).padStart(14) +
    (crashRate * 100).toFixed(2).padStart(12) + '%' +
    (delistRate * 100).toFixed(1).padStart(9) + '%',
  );
});

console.log('\n  · 排序检验（中枢收益应严格：大牛 > 小牛 > 震荡 > 平静 > 小熊 > 大熊）');
// ⚠️ 注意：这里比的是**近似年收益**（12 个月涨幅的算术和），
//   不是几何复合收益 —— 熊市每月 -7% 累加出来会是个很夸张的负数
//   （实际净值会因 floor 与复利而非线性）。排序是可靠的，
//   绝对值只用于"谁更惨"的横向比较。
const order = ['bull', 'smallBull', 'flat', 'calmFlat', 'smallBear', 'bear'];
let monotone = true;
const bad = [];
for (let i = 1; i < order.length; i++) {
  if (rows[order[i - 1]].avgSum <= rows[order[i]].avgSum) {
    monotone = false;
    bad.push(`${order[i - 1]}(${rows[order[i - 1]].avgSum.toFixed(2)}) ≯ ${order[i]}(${rows[order[i]].avgSum.toFixed(2)})`);
  }
}
chk('★ 六种风格的中枢收益严格单调递减', monotone,
  bad.length ? bad.join('; ') : order.map((k) => `${k}=${rows[k].avgSum.toFixed(2)}`).join(' > '));

// 震荡市必须真正"中枢归零"：既不能是牛市也不能是熊市
chk('★ 震荡市中枢接近 0（不是伪装成震荡的牛/熊）',
  Math.abs(rows.flat.avgSum) < 12,
  `flat=${rows.flat.avgSum.toFixed(2)}`);

// 关键：小牛必须真的比大牛小，否则"新增风格"没意义
chk('★ 小牛收益显著低于大牛（不是大牛的别名）',
  rows.smallBull.avgSum < rows.bull.avgSum * 0.65,
  `小牛 ${rows.smallBull.avgSum.toFixed(2)} vs 大牛 ${rows.bull.avgSum.toFixed(2)}`);
chk('★ 小熊跌幅显著小于大熊（不是大熊的别名）',
  rows.smallBear.avgSum > rows.bear.avgSum * 0.6,
  `小熊 ${rows.smallBear.avgSum.toFixed(2)} vs 大熊 ${rows.bear.avgSum.toFixed(2)}`);
chk('★ 平静市波动显著低于大牛（"没行情"必须能被感知）',
  rows.calmFlat.avgVol < rows.bull.avgVol * 0.6,
  `平静 ${rows.calmFlat.avgVol.toFixed(2)} vs 大牛 ${rows.bull.avgVol.toFixed(2)}`);
chk('★ 大熊退市率显著高于大牛',
  rows.bear.delistRate > rows.bull.delistRate * 4,
  `大熊 ${(rows.bear.delistRate * 100).toFixed(1)}% vs 大牛 ${(rows.bull.delistRate * 100).toFixed(1)}%`);
chk('★ 大熊爆雷频率显著高于大牛',
  rows.bear.crashRate > rows.bull.crashRate * 3,
  `大熊 ${(rows.bear.crashRate * 100).toFixed(2)}% vs 大牛 ${(rows.bull.crashRate * 100).toFixed(2)}%`);

// ============================================================
// [3] 回归守门：旧的三型行为不能被这次重构改变
// ============================================================
//
// 我把硬编码分支换成了数据字段，等价性必须可验证：
// 用同样的输入，新的 trendScale/delistBase 应产出与旧常量一致的结果。
console.log('\n[3] ★ 重构等价性（旧三型行为不变）');

chk('bull.trendScale === 2.6（旧写死的牛值）', MARKET_STYLES.bull.trendScale === 2.6);
chk('bear.trendScale === -2.6（旧写死的熊值）', MARKET_STYLES.bear.trendScale === -2.6);
chk('bull.delistBase === 0.05（旧 else 分支）', MARKET_STYLES.bull.delistBase === 0.05);
chk('bear.delistBase === 0.55（旧熊值）', MARKET_STYLES.bear.delistBase === 0.55);
chk('flat.delistBase === 0.18（旧震荡值）', MARKET_STYLES.flat.delistBase === 0.18);

// bull 与 flat 在旧代码里都走“非熊”分支（2.6）——
// flat 这次故意改成 0.2（震荡市里个股性格本就不该顺势放大）
console.log('  · 说明：flat.trendScale 由旧的 2.6 调整为 0.2（设计改进，非回归）');
chk('flat.trendScale 已明确改为接近 0', Math.abs(MARKET_STYLES.flat.trendScale) < 0.5);

// 极端兜底：未知风格应退化为 bull，而不是崩溃
{
  const p = generatePath(probe[0], 'not_a_style', 'x', 12);
  chk('未知风格退化为 bull（不抛错）', Array.isArray(p) && p.length === 12);
}

console.log('\n=== 结果 ===');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail === 0) console.log('市场风格诊断通过 ✓\n');
else { console.log('市场风格诊断未通过 ✗\n'); process.exitCode = 1; }
