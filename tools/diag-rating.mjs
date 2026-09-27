/**
 * 机构评级"准不准"专项诊断
 *
 * ============ 为什么要测这个 ============
 *
 * 评级的公式是「相对强弱 0.30 + 新闻面 0.10 + 噪声 0.60」，而**走势因子取的是本回合已实现的涨跌幅**。
 * 也就是说评级本质是"事后描述"，但玩家会拿它当"事前预测"用：
 *
 *   回合 t：结算价格（用 path[t-1]）→ 生成评级(t) → 玩家按评级买入 → 持有一个月
 *   回合 t+1：结算价格（用 path[t]）→ 玩家收益 = path[t]
 *
 * 所以「评级(t) 能不能预测 path[t]」才是玩家真正体验到的"准不准"。
 * 评级若显得准，只可能来自一件事：**月度收益存在正自相关（动量）**。
 *
 * ============ 测什么 ============
 *
 *   [1]  方向命中率 —— 看多档里，下月真的涨的比例（50% = 无预测力）
 *   [1b] 排序一致率 —— 评级排序 vs 本月涨跌排序（≈100% = 评级只是在复述公开行情）
 *   [2]  IC        —— corr(score(t), 下月涨跌幅)（0 = 无预测力）
 *   [3]  档位单调性 —— 五档评级 → 下月平均涨幅，单调递减才算有预测力
 *   [4]  策略收益 —— 跟评级 / 等权 / 跟动量 / 反评级，四者对照
 *   [5]  原始月度自相关 + 分风格 IC
 *   [6]  暴雷前一月评级分布（能预警 = 评级"作弊"了）
 *   [7]  剧烈波动月命中率（含基准率对照）
 *
 * ============ 判据 ============
 *
 *   命中率 ≈ 50%、IC ≈ 0、档位极差 ≈ 0、跟评级跑不赢基线 → 评级"不准"，符合设计意图。
 *
 *   ⚠️ 最容易搞错的一条：不能用「跟评级 − 等权」当判据。市场本身有动量溢价，
 *      「每月买本月涨最多的那只」这条**玩家自己就能跑**的策略同样赚钱。
 *      真正的判据是「跟评级 − 跟动量」——评级的**独占**价值。
 *      这个值接近 0，才说明评级没给玩家额外信息。
 *
 * 运行：
 *   node --experimental-loader ./tools/register.mjs tools/diag-rating.mjs
 *   node --experimental-loader ./tools/register.mjs tools/diag-rating.mjs bull   # 只测某风格
 */

globalThis.wx = {
  createCanvas: () => ({ width: 375, height: 667, getContext: () => ({ scale() {} }) }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 3 }),
  onTouchStart() {},
};

const { default: DataBus } = await import('../js/core/databus.js');
const { setSeed } = await import('../js/core/random.js');
const { MARKET_STYLE_KEYS } = await import('../js/market/pathgen.js');
const { seasonsOfStyle } = await import('../js/data/seasons/index.js');

const onlyStyle = process.argv[2] || null;
const styles = (onlyStyle ? [onlyStyle] : MARKET_STYLE_KEYS.slice()).filter(
  (s) => seasonsOfStyle(s).length > 0,
);
const GAMES = 36; // 每风格 36 局 × 11 个有效配对 × 3 股 ≈ 1188 个样本

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const samples = []; // { style, score, ratingKey, cur, next }
// ★ follow/contra 是"照抄评级"；followMom/contraMom 是**朴素动量**（玩家自己看行情就能算）。
//   评级若只是复述本月涨跌，两者的收益就该几乎相同 —— 那评级就没有"独占信息"。
const strat = { follow: [], contra: [], equal: [], followMom: [], contraMom: [] };
// 附加诊断用
const rawPairs = []; // { prev, cur } 原始月度涨跌幅的相邻对
const preDelist = []; // 暴雷前一个月的评级 { style, score, ratingKey, next, crash }
const perStyle = {}; // style -> samples
const groups = []; // 每回合一组 { score, cur }[]，用于算"评级排序是否只是复述本月涨跌"
const rankPairs = []; // { score, cur } 全体样本，用于 Spearman

for (const style of styles) {
  const pool = seasonsOfStyle(style);
  perStyle[style] = [];
  for (let g = 0; g < GAMES; g++) {
    const season = pool[g % pool.length];
    const seedKey = `rating|${style}|${g}`;
    setSeed(hash(seedKey));

    const bus = new DataBus();
    bus.reset();
    if (!bus.start('lv_05', { seedKey, season })) continue;

    const turns = bus.level.turns;
    let pending = []; // 上一回合的评级，本回合结算
    // 每只股票的退市回合（若有）
    const delistAt = {};
    bus.stockDefs.forEach((d) => {
      if (typeof d.delistAt === 'number') delistAt[d.code] = d.delistAt;
    });

    for (let t = 1; t <= turns; t++) {
      bus.nextTurn();
      const changes = bus.settle(); // 本月价格（path[t-1]）
      const ratings = bus.generateRatings(); // 评级基于本月已实现涨跌

      // ---- 原始涨跌幅自相关：change(t-1) → change(t) ----
      if (t >= 2) {
        const prevCh = bus.simulator.states;
        Object.keys(changes).forEach((c) => {
          const h = prevCh[c].history;
          if (h.length >= 2) {
            rawPairs.push({ prev: h[h.length - 2].change, cur: h[h.length - 1].change });
          }
        });
      }

      // ---- 先结算上一回合的押注（收益 = 本月 path[t-1]）----
      if (pending.length) {
        const retOf = {};
        Object.keys(changes).forEach((c) => {
          retOf[c] = changes[c].change;
        });
        // 本回合"大盘"（用三只股票的均值当代理）—— 用来判定"剧烈波动月"
        const codes = Object.keys(changes);
        const mktChg = codes.reduce((a, c) => a + changes[c].change, 0) / codes.length;
        const best = pending.reduce((a, b) => (a.score >= b.score ? a : b));
        const worst = pending.reduce((a, b) => (a.score <= b.score ? a : b));
        // ★ 朴素动量：直接挑"本月涨得最多/最少"的那只。玩家看行情就能算，不需要评级。
        const bestMom = pending.reduce((a, b) => (a.cur >= b.cur ? a : b));
        const worstMom = pending.reduce((a, b) => (a.cur <= b.cur ? a : b));
        strat.follow.push(retOf[best.code] || 0);
        strat.contra.push(retOf[worst.code] || 0);
        strat.followMom.push(retOf[bestMom.code] || 0);
        strat.contraMom.push(retOf[worstMom.code] || 0);
        strat.equal.push(
          pending.reduce((a, r) => a + (retOf[r.code] || 0), 0) / pending.length,
        );
        groups.push(pending.map((p) => ({ score: p.score, cur: p.cur })));
        pending.forEach((r) => {
          const rec = {
            style, score: r.score, ratingKey: r.ratingKey, cur: r.cur,
            next: retOf[r.code] || 0, mkt: mktChg,
          };
          samples.push(rec);
          perStyle[style].push(rec);
          rankPairs.push({ score: r.score, cur: r.cur });
          // 本回合就是该股的退市回合？→ 上一回合的评级就是"最后一次预警机会"
          if (delistAt[r.code] === t) {
            preDelist.push({ ...rec, crash: changes[r.code].justDelisted });
          }
        });
      }

      // ---- 记录本回合评级 ----
      pending = ratings
        .filter((r) => !bus.isDelisted(r.code))
        .map((r) => ({
          code: r.code,
          score: r.score,
          ratingKey: r.rating.key,
          cur: (changes[r.code] || {}).change || 0, // 评级所依据的本月涨跌幅
        }));
    }
  }
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const std = (a) => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
};
const cum = (a) => a.reduce((p, r) => p * (1 + r / 100), 1) - 1;

console.log(`机构评级诊断  ${onlyStyle ? 'style=' + onlyStyle : '全风格'}`
  + `  局数/风格=${GAMES}  样本=${samples.length}`);

// ============ [1] 方向命中率 ============
const BULL = new Set(['strong_buy', 'buy']);
const BEAR = new Set(['strong_sell', 'sell']);
const bullS = samples.filter((s) => BULL.has(s.ratingKey));
const bearS = samples.filter((s) => BEAR.has(s.ratingKey));
const holdS = samples.filter((s) => s.ratingKey === 'hold');

const rate = (arr, wantUp) => {
  if (!arr.length) return NaN;
  return arr.filter((s) => (wantUp ? s.next > 0 : s.next < 0)).length / arr.length;
};

const bullHit = rate(bullS, true);
const bearHit = rate(bearS, false);
const holdUp = rate(holdS, true);
const allUp = rate(samples, true);

console.log('\n[1] 方向命中率（下月真的朝评级方向走吗）');
console.log(`  看多档  n=${String(bullS.length).padStart(5)}  下月涨的比例 ${(bullHit * 100).toFixed(1)}%`
  + `   下月均涨 ${mean(bullS.map((s) => s.next)).toFixed(2)}%`);
console.log(`  看空档  n=${String(bearS.length).padStart(5)}  下月跌的比例 ${(bearHit * 100).toFixed(1)}%`
  + `   下月均涨 ${mean(bearS.map((s) => s.next)).toFixed(2)}%`);
console.log(`  中性档  n=${String(holdS.length).padStart(5)}  下月涨的比例 ${(holdUp * 100).toFixed(1)}%`
  + `   下月均涨 ${mean(holdS.map((s) => s.next)).toFixed(2)}%   ← 对照组`);
console.log(`  全体    n=${String(samples.length).padStart(5)}  下月涨的比例 ${(allUp * 100).toFixed(1)}%`
  + `   下月均涨 ${mean(samples.map((s) => s.next)).toFixed(2)}%`);

// ============ [1b] 评级排序 vs 本月涨跌排序 ============
// ★ 这是最关键的一组数。评级公式里的"走势因子"取的是 `change - marketChange`，
//   而 marketChange 是三只股票的**均值** —— 给三只股票减同一个常数**不改变它们的排序**。
//   所以只要走势因子占主导，评级的排序就等于"本月涨幅排序"，
//   而"本月涨幅"玩家在行情面板上**本来就看得到**。
//   一致率 ≈ 100% ⇒ 评级没有半点独占信息，只是一个把公开行情翻译成文字的"镜子"。
console.log('\n[1b] 评级排序 vs 本月涨跌排序（≈100% = 评级只是在复述玩家已经看得到的行情）');
let conc = 0;
let concN = 0;
groups.forEach((g) => {
  for (let i = 0; i < g.length; i++) {
    for (let j = i + 1; j < g.length; j++) {
      const ds = g[i].score - g[j].score;
      const dc = g[i].cur - g[j].cur;
      if (ds === 0 || dc === 0) continue;
      concN += 1;
      if (ds > 0 === dc > 0) conc += 1;
    }
  }
});
const concord = concN ? conc / concN : NaN;
console.log(`  排序一致率 = ${(concord * 100).toFixed(1)}%   n=${concN} 组内配对`
  + `   （50% = 完全无关，100% = 完全复述）`);
// Spearman：score 与本月涨跌幅的秩相关
const rankOf = (arr, key) => {
  const idx = arr.map((v, i) => i).sort((a, b) => arr[a][key] - arr[b][key]);
  const r = new Array(arr.length);
  idx.forEach((v, k) => { r[v] = k; });
  return r;
};
const rScore = rankOf(rankPairs, 'score');
const rCur = rankOf(rankPairs, 'cur');
let sp = 0;
let sa = 0;
let sb = 0;
const smS = mean(rScore);
const smC = mean(rCur);
for (let i = 0; i < rankPairs.length; i++) {
  sp += (rScore[i] - smS) * (rCur[i] - smC);
  sa += (rScore[i] - smS) ** 2;
  sb += (rCur[i] - smC) ** 2;
}
console.log(`  Spearman(score, 本月涨跌幅) = ${(sp / Math.sqrt(sa * sb)).toFixed(3)}`);

// ============ [2] IC ============
const mx = mean(samples.map((s) => s.score));
const my = mean(samples.map((s) => s.next));
let cov = 0;
let vx = 0;
let vy = 0;
samples.forEach((s) => {
  cov += (s.score - mx) * (s.next - my);
  vx += (s.score - mx) ** 2;
  vy += (s.next - my) ** 2;
});
const ic = vx && vy ? cov / Math.sqrt(vx * vy) : NaN;
console.log('\n[2] IC = corr(评级score, 下月涨跌幅) = ' + ic.toFixed(4));
console.log('    0 = 完全无预测力；|IC| > 0.10 就算"能靠它赚钱"了');

// ============ [3] 档位单调性 ============
const ORDER = ['strong_buy', 'buy', 'hold', 'sell', 'strong_sell'];
const LABEL = {
  strong_buy: '强烈看多', buy: '看多', hold: '中性', sell: '看空', strong_sell: '强烈看空',
};
console.log('\n[3] 五档评级 → 下月平均涨幅（单调递减才算有预测力）');
const bucketMeans = [];
ORDER.forEach((k) => {
  const arr = samples.filter((s) => s.ratingKey === k);
  const m = mean(arr.map((s) => s.next));
  bucketMeans.push(m);
  const se = arr.length ? std(arr.map((s) => s.next)) / Math.sqrt(arr.length) : NaN;
  const bar = '#'.repeat(Math.max(0, Math.round((m + 6) * 3)));
  console.log(`  ${LABEL[k]}  n=${String(arr.length).padStart(5)}  下月 ${m >= 0 ? '+' : ''}${m.toFixed(2)}%`
    + `  (标准误 ${se.toFixed(2)})  ${bar}`);
});
// 极差：最强档 − 最弱档。理论上应为正（有预测力），越接近 0 越"不准"
const spread = bucketMeans[0] - bucketMeans[4];
console.log(`  极差（强烈看多 − 强烈看空）= ${spread >= 0 ? '+' : ''}${spread.toFixed(2)}%`);

// ============ [5] 原始涨跌幅自相关（评级"准"的根源）============
const corrOf = (pairs) => {
  const n = pairs.length;
  if (n < 3) return NaN;
  const ax = mean(pairs.map((p) => p.prev));
  const ay = mean(pairs.map((p) => p.cur));
  let c = 0;
  let a = 0;
  let b = 0;
  pairs.forEach((p) => {
    c += (p.prev - ax) * (p.cur - ay);
    a += (p.prev - ax) ** 2;
    b += (p.cur - ay) ** 2;
  });
  return a && b ? c / Math.sqrt(a * b) : NaN;
};
console.log('\n[5] 原始月度涨跌幅的自相关 corr(本月, 下月)');
console.log(`  全体   r = ${corrOf(rawPairs).toFixed(4)}   n=${rawPairs.length}`);
styles.forEach((st) => {
  // 分风格的 IC —— 看是不是只有某几种风格在"作弊"
  const arr = perStyle[st];
  const mxx = mean(arr.map((s) => s.score));
  const myy = mean(arr.map((s) => s.next));
  let cc = 0;
  let aa = 0;
  let bb = 0;
  arr.forEach((s) => {
    cc += (s.score - mxx) * (s.next - myy);
    aa += (s.score - mxx) ** 2;
    bb += (s.next - myy) ** 2;
  });
  const icS = aa && bb ? cc / Math.sqrt(aa * bb) : NaN;
  console.log(`  ${st.padEnd(10)} IC = ${icS >= 0 ? '+' : ''}${icS.toFixed(3)}   n=${arr.length}`);
});

// ============ [6] 暴雷预警能力（评级能不能提前看出财务造假）============
console.log('\n[6] 暴雷前一个月的评级分布（能预警 = 评级"作弊"了）');
if (!preDelist.length) {
  console.log('  样本不足');
} else {
  const cnt = {};
  preDelist.forEach((r) => {
    cnt[r.ratingKey] = (cnt[r.ratingKey] || 0) + 1;
  });
  ORDER.forEach((k) => {
    const n = cnt[k] || 0;
    const pct = (n / preDelist.length) * 100;
    console.log(`  ${LABEL[k].padEnd(5)} ${String(n).padStart(4)}  (${pct.toFixed(1)}%)  `
      + '#'.repeat(Math.round(pct / 2)));
  });
  const warn = preDelist.filter((r) => BEAR.has(r.ratingKey)).length;
  console.log(`  → 暴雷前一月给出"看空"的比例 = ${((warn / preDelist.length) * 100).toFixed(1)}%`);
  console.log(`     对照：全体样本里看空档占比 = ${(((bearS.length) / samples.length) * 100).toFixed(1)}%`);
  console.log('     两者接近 → 评级没有预警能力（符合设计）；明显更高 → 评级提前看穿了暴雷');
}

// ============ [7] 剧烈波动月：评级会不会被大盘压过 ============
// 用户要的现象：「市场剧烈波动的时候虽然看多，但受整体趋势影响还是下跌」。
// 判定：把实现月按大盘涨跌分三档，看"看多档下月真的涨"的比例。
//   剧烈下跌月里，看多档的命中率应当**明显低于** 50%（大盘把它们全拖下去了）。
console.log('\n[7] 剧烈波动月里的评级命中率（大盘能不能压过个股评级）');
const bands = [
  { name: '大盘暴跌月 (≤ -4%)', test: (m) => m <= -4, wantUp: true, key: BULL },
  { name: '大盘温和 (-4~+4%)', test: (m) => m > -4 && m < 4, wantUp: true, key: BULL },
  { name: '大盘暴涨月 (≥ +4%)', test: (m) => m >= 4, wantUp: true, key: BULL },
];
bands.forEach((b) => {
  const arr = samples.filter((s) => b.test(s.mkt) && b.key.has(s.ratingKey));
  const all = samples.filter((s) => b.test(s.mkt));
  if (!arr.length) {
    console.log(`  ${b.name.padEnd(20)} 无样本`);
    return;
  }
  const hit = arr.filter((s) => s.next > 0).length / arr.length;
  // ★ 基准率：同一批月份里"全体股票"的上涨比例。
  //   没有这个数，98% 这种数字没法解释 —— 大盘暴涨月里本来就几乎全涨。
  const base = all.filter((s) => s.next > 0).length / all.length;
  console.log(`  ${b.name.padEnd(20)} n=${String(arr.length).padStart(4)}`
    + `  看多档命中率 ${(hit * 100).toFixed(1)}%`
    + `  (基准 ${(base * 100).toFixed(1)}%, 超额 ${((hit - base) * 100 >= 0 ? '+' : '')}${((hit - base) * 100).toFixed(1)}pp)`
    + `  下月均涨 ${mean(arr.map((s) => s.next)).toFixed(2)}%`);
});
// 反向：大盘暴涨月里看空档会不会被打脸
const bearUp = samples.filter((s) => s.mkt >= 4 && BEAR.has(s.ratingKey));
if (bearUp.length) {
  const hit = bearUp.filter((s) => s.next < 0).length / bearUp.length;
  console.log(`  大盘暴涨月里的看空档      n=${String(bearUp.length).padStart(4)}`
    + `  命中率 ${(hit * 100).toFixed(1)}%  下月均涨 ${mean(bearUp.map((s) => s.next)).toFixed(2)}%`);
}

// ============ [8] 策略收益 ============
console.log('\n[4] 策略收益（每月一个收益点）');
const label = (name, arr) => {
  console.log(`  ${name.padEnd(12)} 月均 ${mean(arr) >= 0 ? '+' : ''}${mean(arr).toFixed(3)}%`
    + `   累计 ${(cum(arr) * 100).toFixed(1)}%   n=${arr.length}`);
};
label('跟评级全仓', strat.follow);
label('等权三只', strat.equal);
label('跟本月涨幅最高', strat.followMom);
label('跟本月涨幅最低', strat.contraMom);
label('反评级全仓', strat.contra);
const edge = mean(strat.follow) - mean(strat.equal);
const edgeMom = mean(strat.followMom) - mean(strat.equal);
const edgeOwn = mean(strat.follow) - mean(strat.followMom);
console.log(`  → 跟评级 − 等权     = ${edge >= 0 ? '+' : ''}${edge.toFixed(3)}% / 月`);
console.log(`  → 跟动量 − 等权     = ${edgeMom >= 0 ? '+' : ''}${edgeMom.toFixed(3)}% / 月   ← 玩家自己看行情就能拿到的`);
console.log(`  → ★ 评级 − 动量     = ${edgeOwn >= 0 ? '+' : ''}${edgeOwn.toFixed(3)}% / 月`
  + '   ← 这才是评级的**独占**价值');

// ============ 结论 ============
console.log('\n=== 判据 ===');
const bad = [];
if (bullHit > 0.55) bad.push(`看多命中率 ${(bullHit * 100).toFixed(1)}% > 55%`);
if (bearHit > 0.55) bad.push(`看空命中率 ${(bearHit * 100).toFixed(1)}% > 55%`);
if (Math.abs(ic) > 0.1) bad.push(`|IC| = ${Math.abs(ic).toFixed(3)} > 0.10`);
// ★ 判"评级是否作弊"要看**独占**价值，不能只看"跟评级 − 等权"。
//   "跟本月涨幅最高"这条基线玩家自己就能跑（行情面板上就有本月涨跌），
//   如果评级打不赢它，说明评级只是把公开行情翻译成了文字，没有额外信息。
if (edgeOwn > 0.15) {
  bad.push(`★ 评级比朴素动量多赚 ${edgeOwn.toFixed(3)}%/月 > 0.15% —— 评级有独占信息`);
}
// 档位极差：**放宽到 4%**，只当回归哨兵用。
//   为什么不用 1.5% 那种紧阈值：极差里混着市场自身的动量溢价（跟动量策略本身就
//   有约 ±1% 的极差），紧阈值会一直误报。真正该看的是上面的「评级 − 动量」。
//   4% 只在有人把噪声权重调回去（评级变回预言机）时才会响。
if (spread > 4.0) bad.push(`档位极差 ${spread.toFixed(2)}% > 4.0%（评级退化成预言机了？）`);
if (bad.length) {
  console.log('  ⚠️ 评级偏准：');
  bad.forEach((s) => console.log('     · ' + s));
} else {
  console.log('  ✓ 评级"不准"，符合设计意图');
}
console.log(`  （注：跟动量 − 等权 = ${edgeMom >= 0 ? '+' : ''}${edgeMom.toFixed(3)}%/月 是市场自身的动量溢价，`
  + '玩家不用评级也能拿到，不算评级的问题）');
console.log(`  （注：档位极差 ${spread.toFixed(2)}% 里同样混着这份动量溢价 —— 所以它只是哨兵，不是判据）`);
