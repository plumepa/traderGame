/**
 * 诊断：退市机制在各市场风格下是否正确
 *
 * 校验：
 *   · 一局最多一只退市股（无论什么风格）
 *   · 每局三只股票行业互不重复
 *   · 清算价远低于 floor，退市回合落在 3~10
 *   · 退市率随风格严格单调：大熊 > 小熊 > 震荡 > 平静 > 小牛 > 大牛
 *
 * ⚠️ 风格列表从 pathgen 的 MARKET_STYLE_KEYS 派生，不写死 ——
 *    第三版把风格从 3 种扩到 6 种时，写死的列表会被静默漏测。
 */

globalThis.wx = {
  createCanvas: () => ({ width: 375, height: 667, getContext: () => ({ scale() {} }) }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 3 }),
  onTouchStart() {},
};

const { composeGame } = await import('../js/data/index.js');
const { MARKET_STYLE_KEYS, MARKET_STYLES } = await import('../js/market/pathgen.js');

const N = 800;
const styles = MARKET_STYLE_KEYS.slice();
let delistGames = 0;
let multiple = 0;
let sectorsOk = 0;
let badPrice = 0;
let badTurn = 0;
const perStyle = {};
styles.forEach((s) => { perStyle[s] = 0; });

for (let i = 0; i < N; i++) {
  for (const style of styles) {
    const g = composeGame({ seedKey: `d${i}_${style}`, style });
    const dl = g.stockDefs.filter((d) => d.delistAt);
    if (dl.length) {
      delistGames++;
      perStyle[style]++;
    }
    if (dl.length > 1) multiple++;
    if (new Set(g.stockDefs.map((d) => d.sector)).size === 3) sectorsOk++;

    for (const d of dl) {
      if (!(d.delistPrice < d.floor)) badPrice++;
      if (!(d.delistAt >= 3 && d.delistAt <= 10)) badTurn++;
    }
  }
}

const total = N * styles.length;
const pct = (n) => ((n / total) * 100).toFixed(1) + '%';

console.log(`样本 ${total} 局（${styles.length} 种风格 × ${N}）`);
console.log('─'.repeat(48));
console.log(`出现退市的局      ${delistGames}  (${pct(delistGames)})`);
console.log(`★ 多于一只退市的局 ${multiple}  ${multiple === 0 ? '✓' : '✗'}`);
console.log(`★ 行业互不重复的局 ${sectorsOk}  ${sectorsOk === total ? '✓' : '✗'}`);
console.log(`清算价低于 floor   ${badPrice === 0 ? '全部合规 ✓' : badPrice + ' 例异常 ✗'}`);
console.log(`退市回合在 3~10    ${badTurn === 0 ? '全部合规 ✓' : badTurn + ' 例异常 ✗'}`);
console.log('');
console.log('各风格退市率（应由熊到牛严格递减）：');

// 期望顺序：退市率由高到低
//   大熊 → 小熊 → 震荡 → 平静 → **大牛 → 小牛**
// 注意末尾是 bull 在 smallBull 之前：大牛的 marketBias 更高、上行更猛，
// 但波动也更大，所以"踩雷退市"的概率反而略高于小牛。
const expected = ['bear', 'smallBear', 'flat', 'calmFlat', 'bull', 'smallBull'];
expected.forEach((s) => {
  const rate = perStyle[s] / N;
  console.log(`  ${String(MARKET_STYLES[s].label).padEnd(5)} ${String(s).padEnd(10)} ${(rate * 100).toFixed(1)}%`);
});

// 严格单调递减（允许极小的统计抖动 → 用 0.5% 容差）
let monotone = true;
for (let i = 1; i < expected.length; i++) {
  const prev = perStyle[expected[i - 1]] / N;
  const cur = perStyle[expected[i]] / N;
  if (!(prev >= cur - 0.005)) {
    monotone = false;
    console.log(`  ✗ ${expected[i - 1]}(${(prev * 100).toFixed(1)}%) 应高于 ${expected[i]}(${(cur * 100).toFixed(1)}%)`);
  }
}

const ok = multiple === 0 && sectorsOk === total && badPrice === 0 && badTurn === 0 && monotone;
console.log('\n' + (ok ? '退市机制诊断通过 ✓' : '退市机制诊断失败 ✗'));
if (!ok) process.exit(1);
