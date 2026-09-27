/**
 * 逻辑自检 —— 用 Node 跑一遍纯逻辑层（不涉及 Canvas / wx API）
 *
 * 用法：
 *   node _selftest.mjs
 *
 * 覆盖：数据校验、路径计算、整手校验、手续费、破产判定、目标判定、评级
 */

// ---------- 最小 wx 桩 ----------
globalThis.wx = {
  createCanvas: () => ({ getContext: () => ({}) }),
  getSystemInfoSync: () => ({ pixelRatio: 2, windowWidth: 375, windowHeight: 667 }),
  onTouchStart: () => {},
  createImage: () => ({}),
};

// ---------- 简易断言 ----------
let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function eq(actual, expected, msg) {
  // 数字走近似比较（容忍浮点误差），其它类型走严格相等
  const c =
    typeof actual === 'number' && typeof expected === 'number'
      ? Math.abs(actual - expected) < 0.011
      : actual === expected;
  ok(c, `${msg} (期望 ${expected}, 实际 ${actual})`);
}

console.log('=== 股票交易小游戏 · 逻辑自检 ===\n');

// ---------- 1. 数据层 ----------
console.log('[1] 数据校验');
const {
  validateData,
  STOCK_POOL,
  POOL_MAP,
  NEWS_POOL,
  NEWS_POOL_MAP,
  LEVELS,
  LEVEL_MAP,
  pickStocks,
  composeGame,
  buildNewsDeck,
} = await import('../js/data/index.js');

const errors = validateData();
ok(errors.length === 0, `validateData 应无错误，实际: ${errors.join('; ')}`);

ok(STOCK_POOL.length >= 9, `股票池应 ≥9 只，实际 ${STOCK_POOL.length}`);

// 行业覆盖：至少 8 个行业，且行业唯一性靠 sector 保证
const sectors = new Set(STOCK_POOL.map((s) => s.sector));
ok(sectors.size >= 8, `股票池应覆盖 ≥8 个行业，实际 ${sectors.size}`);

// 每只股票字段完整
STOCK_POOL.forEach((s) => {
  ok(!!s.code && !!s.name && !!s.sector, `${s.code || '?'} 应有 code/name/sector`);
  ok(s.basePrice > 0 && s.floor > 0, `${s.name} 应有合法 basePrice/floor`);
  ok(s.profile && typeof s.profile.trend === 'number', `${s.name} 应有 profile.trend`);
  ok(typeof s.profile.vol === 'number', `${s.name} 应有 profile.vol`);
});

// 行业多样性：能源/科技/运输 必须有（玩家点名要求的行业）
['energy', 'tech', 'transport'].forEach((sec) => {
  ok(
    STOCK_POOL.some((s) => s.sector === sec),
    `股票池应包含行业 ${sec}`,
  );
});

// 新闻池
ok(NEWS_POOL.length >= 40, `新闻池应 ≥40 条，实际 ${NEWS_POOL.length}`);
const newsIds = new Set(NEWS_POOL.map((n) => n.id));
ok(newsIds.size === NEWS_POOL.length, '新闻 id 应唯一');

// 三种错配类型都要有
['relevant', 'irrelevant', 'pressured'].forEach((kind) => {
  const n = NEWS_POOL.filter((x) => x.kind === kind).length;
  ok(n > 0, `应有 kind='${kind}' 的新闻（实际 ${n} 条）`);
});

// 关卡 —— 第三版是 5 关制，且**年份与市场主题对玩家隐藏**
ok(LEVELS.length === 5, `应为 5 个关卡，实际 ${LEVELS.length}`);
ok(!!LEVEL_MAP.lv_02, '应存在第 2 关 lv_02');
// ⚠️ 这里**不能**再断言 lv_02.style === 'bear' ——
// 第三版起，关卡不再固定一种风格，而是声明一个「可抽风格池」（pool），
// 由 setup 从池中随机取一种年景。lv_02 的池子是 ['smallBear','bear']。
ok(
  Array.isArray(LEVEL_MAP.lv_02.pool) && LEVEL_MAP.lv_02.pool.includes('smallBear'),
  `lv_02 可抽风格池应含 smallBear，实际 ${JSON.stringify(LEVEL_MAP.lv_02.pool)}`,
);
// 年景必须对玩家隐藏：不能有 theme 字段，标题里不能有年份/市场风格词
LEVELS.forEach((l) => {
  ok(!l.theme, `关卡 ${l.id} 不应有 theme 字段（年景对玩家隐藏）`);
  ok(
    !/19\d{2}|20\d{2}|牛市|熊市|震荡|小牛|小熊/.test(`${l.title}${l.intro}`),
    `关卡 ${l.id} 的文案不应出现年份或市场风格`,
  );
});
// 编号连续，供 UI 显示「第 N / 5 关」
LEVELS.forEach((l, i) => eq(l.index, i + 1, `关卡 ${l.id} 的 index 应为 ${i + 1}`));

const lv = LEVEL_MAP.lv_01;
const initCash = lv.initCash;
ok(lv.turns === 12, `关卡回合数应为 12，实际 ${lv.turns}`);

// ---------- 1b. 随机选股（核心需求）----------
console.log('[1b] 随机选股与新闻编排');

// ① 单次抽取：3 只、行业互不重复
{
  const picked = pickStocks(3);
  eq(picked.length, 3, '一次应抽出 3 只股票');
  const inds = picked.map((s) => s.sector);
  ok(new Set(inds).size === 3, `抽出的三只行业应互不重复: ${inds.join('/')}`);
  ok(picked.every((s) => STOCK_POOL.includes(s)), '抽出的股票应来自股票池');
}

// ② 多次抽取：组合应随机变化（每关不同）
{
  const combos = new Set();
  for (let i = 0; i < 60; i++) {
    combos.add(pickStocks(3).map((s) => s.code).join(','));
  }
  ok(combos.size >= 8, `60 次抽股应产生 ≥8 种组合，实际 ${combos.size} 种`);
}

// ③ 排除参数生效（用虚构代码，不再用真实 A 股代码）
{
  const exclude = STOCK_POOL.slice(0, 3).map((s) => s.code);
  const picked = pickStocks(3, { exclude });
  ok(
    !picked.some((s) => exclude.includes(s.code)),
    'exclude 参数应能排除指定股票',
  );
}

// ④ composeGame：完整一局配置
{
  const g = composeGame({ turns: 12, style: 'bull', seedKey: 'test_a' });
  eq(g.stockDefs.length, 3, 'composeGame 应给出 3 只股票');
  eq(g.newsDeck.length, 12, 'composeGame 应给出 12 组新闻候选');
  g.stockDefs.forEach((s) => {
    eq(s.path.length, 12, `${s.name} 的 path 应为 12 项`);
    ok(s.path.every((v) => typeof v === 'number' && !Number.isNaN(v)), `${s.name} 的 path 不应含 NaN`);
  });
  g.newsDeck.forEach((grp, i) => {
    ok(grp.length >= 4, `第 ${i + 1} 回合候选应 ≥4 条，实际 ${grp.length}`);
    ok(grp.every((id) => !!NEWS_POOL_MAP[id]), `第 ${i + 1} 回合候选 id 应都存在于新闻池`);
  });
}

// ⑤ 路径确定性：同 seedKey + 同股票 → 完全一致（走势图不会变）
//    用股票池里真实存在的三只（不重行业），不写死真实 A 股代码
const FIX3 = [STOCK_POOL[0], STOCK_POOL[1], STOCK_POOL[2]];
{
  const a = composeGame({ turns: 12, style: 'bull', seedKey: 'same', stocks: FIX3 });
  const b = composeGame({ turns: 12, style: 'bull', seedKey: 'same', stocks: FIX3 });
  const pa = a.stockDefs.map((s) => s.path.join(','));
  const pb = b.stockDefs.map((s) => s.path.join(','));
  eq(pa.join('|'), pb.join('|'), '★ 同种子同股票应生成完全相同的路径');
}

// ⑥ 不同股票路径不同（避免三只走势一模一样）
{
  const g = composeGame({ turns: 12, style: 'bull', seedKey: 'diff', stocks: FIX3 });
  const ps = g.stockDefs.map((s) => s.path.join(','));
  ok(new Set(ps).size === 3, '★ 三只股票的路径应互不相同');
}

// ⑦ 牛市与熊市风格方向不同
{
  const bull = composeGame({ turns: 12, style: 'bull', seedKey: 'style', stocks: FIX3 });
  const bear = composeGame({ turns: 12, style: 'bear', seedKey: 'style', stocks: FIX3 });
  const bullSum = bull.stockDefs[0].path.reduce((a, b) => a + b, 0);
  const bearSum = bear.stockDefs[0].path.reduce((a, b) => a + b, 0);
  ok(bullSum > bearSum, `★ 牛市路径总和应高于熊市（牛 ${bullSum.toFixed(1)} vs 熊 ${bearSum.toFixed(1)}）`);
}

// ---------- 1c. 年景层与跨关不重复（第三版核心）----------
console.log('[1c] 年景层与跨关不重复');
const {
  SEASONS,
  SEASON_MAP,
  seasonCountByStyle,
  stocksOfSeason,
  newsOfSeason,
  pickSeasons,
  composeFromSeason,
  poolOfLevel,
} = await import('../js/data/index.js');

// ① 年景池规模与风格分布
eq(SEASONS.length, 20, '年景池应为 20 个');
{
  const dist = seasonCountByStyle();
  const styles = Object.keys(dist);
  eq(styles.length, 6, `年景应覆盖 6 种市场风格，实际 ${styles.length}：${styles.join('/')}`);
  // 大牛/大熊 ≥ 3（要有多种选择），小牛/小熊/平静 ≥ 2
  ok((dist.bull || 0) >= 3, `大牛市年景应 ≥3，实际 ${dist.bull}`);
  ok((dist.bear || 0) >= 3, `大熊市年景应 ≥3，实际 ${dist.bear}`);
  ok((dist.smallBull || 0) >= 2, `小牛市年景应 ≥2，实际 ${dist.smallBull}`);
  ok((dist.smallBear || 0) >= 2, `小熊市年景应 ≥2，实际 ${dist.smallBear}`);
  ok((dist.calmFlat || 0) >= 2, `平静市年景应 ≥2，实际 ${dist.calmFlat}`);
}

// ② 每个年景：3 只股票（行业互不相同）+ 6 条真实存在的新闻
SEASONS.forEach((s) => {
  const stks = stocksOfSeason(s);
  eq(stks.length, 3, `年景 ${s.id} 应解析出 3 只股票`);
  ok(new Set(stks.map((x) => x.sector)).size === 3, `年景 ${s.id} 的三只股票行业应互不重复`);
  const ns = newsOfSeason(s);
  eq(ns.length, 6, `年景 ${s.id} 应解析出 6 条新闻`);
  // 每只股票至少有一条对口（本行业或宏观）新闻
  stks.forEach((st) => {
    ok(
      ns.some((n) => n.sector === st.sector || n.sector === 'macro'),
      `年景 ${s.id} 的 ${st.name}(${st.sector}) 应有对口新闻`,
    );
  });
});

// ③ composeFromSeason：指定年景开局，股票/新闻/风格三者自洽
{
  const s = SEASON_MAP[SEASONS[0].id];
  const g = composeFromSeason(s, { turns: 12, seedKey: 'season_a' });
  eq(g.seasonId, s.id, '开局应记录年景 id');
  eq(g.style, s.style, '开局风格应等于年景风格');
  eq(g.stockDefs.length, 3, '年景开局应 3 只股票');
  eq(g.newsDeck.length, 12, '年景开局应 12 组候选新闻');
  // 年景自带的 6 条新闻必须出现在牌堆里
  const flat = new Set(g.newsDeck.flat());
  s.news.forEach((nid) => ok(flat.has(nid), `年景专属新闻 ${nid} 应进入牌堆`));
}

// ④ 跨关不重复：pickSeasons(5) 应给出 5 个互不相同的年景，且风格尽量多样
{
  const picked = pickSeasons(5);
  eq(picked.length, 5, 'pickSeasons(5) 应返回 5 个年景');
  ok(new Set(picked.map((s) => s.id)).size === 5, '★ 5 个关卡的年景不应重复');
  // 风格多样性：抽样 20 次，至少要有一次拿到 ≥3 种不同风格
  let best = 0;
  for (let i = 0; i < 20; i++) {
    const p = pickSeasons(5);
    best = Math.max(best, new Set(p.map((s) => s.style)).size);
  }
  ok(best >= 3, `★ 抽卡应倾向于风格多样（20 次中最高 ${best} 种不同风格）`);
}

// ⑤ 跨关排除生效：模拟连打 5 关，验证不重样
{
  const used = [];
  for (let i = 0; i < 5; i++) {
    const p = pickSeasons(1, { exclude: used })[0];
    used.push(p.id);
  }
  eq(new Set(used).size, 5, `★ 连打 5 关应使用 5 个不同年景（实际 ${used.join(',')}）`);
}

// ⑥ 20 个年景足够连玩 4 轮（20 关）不重样
{
  const used = [];
  for (let i = 0; i < 20; i++) {
    const p = pickSeasons(1, { exclude: used })[0];
    used.push(p.id);
  }
  eq(new Set(used).size, 20, '★ 20 关应把 20 个年景全部用上且不重复');
}

// ⑦ 关卡的风格池被 composeGame 尊重（styles 参数）
{
  const lv1 = LEVEL_MAP.lv_02; // pool = ['smallBear','bear']
  ok(Array.isArray(poolOfLevel(lv1)), 'lv_02 应声明可抽风格池');
  for (let i = 0; i < 20; i++) {
    const g = composeGame({ turns: 12, styles: poolOfLevel(lv1), seedKey: `pool_${i}` });
    ok(
      ['smallBear', 'bear'].includes(g.style),
      `lv_02 抽出的年景风格应受限于池子，实际 ${g.style}`,
    );
  }
}

// ⑧ 终局关 pool = null → 六种风格全放开
//    ⚠️ poolOfLevel(null-pool) 返回的是哨兵值 'all'，不是 null ——
//    返回 null 会让调用方退化去用关卡那句占位的 style，
//    把"全放开"变成"只有某一种风格"（曾因此把 lv_05 压成只出 flat）。
{
  eq(poolOfLevel(LEVEL_MAP.lv_05), 'all', 'lv_05 全放开应返回哨兵 "all"');
  const styles = new Set();
  for (let i = 0; i < 120; i++) {
    styles.add(composeGame({ turns: 12, styles: poolOfLevel(LEVEL_MAP.lv_05), seedKey: `all_${i}` }).style);
  }
  ok(styles.size >= 5, `★ 全放开时应能抽到 ≥5 种风格，实际 ${styles.size}：${[...styles].join('/')}`);
}


// ---------- 2. 行情引擎 ----------
console.log('[2] 行情引擎');
const { default: Simulator } = await import('../js/market/simulator.js');

// 用固定路径的假股票做确定性验证
const fakeDefs = [
  { code: 'T1', name: '甲', sector: 'liquor', basePrice: 10, floor: 1, path: [3.2, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { code: 'T2', name: '乙', sector: 'energy', basePrice: 8, floor: 1, path: [-2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { code: 'T3', name: '丙', sector: 'tech', basePrice: 20, floor: 1, path: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
];
const sim = new Simulator();
sim.init(fakeDefs);

eq(sim.priceOf('T1'), 10, 'T1 初始价');

// 第 1 回合：路径 +3.2%，无新闻影响
sim.step();
eq(sim.priceOf('T1'), 10 * 1.032, 'T1 第 1 月 = 10 × (1+3.2%)');

// 相关新闻：命中 sector → 生效
sim.applyNews({ id: 'x1', sector: 'liquor', kind: 'relevant', truth: true, impact: { drift: 5, turns: 1 } });
const before = sim.priceOf('T1');
sim.step();
eq(sim.priceOf('T1'), before * (1 + (-1 + 5) / 100), '相关新闻偏移正确叠加');

// ★ 错配新闻：讲的是 transport，但股票是 liquor → 不影响
{
  const s = new Simulator();
  s.init(fakeDefs);
  s.applyNews({ id: 'x2', sector: 'transport', kind: 'irrelevant', truth: true, impact: { drift: 9, turns: 2 } });
  const p0 = s.priceOf('T1');
  s.step();
  eq(s.priceOf('T1'), p0 * 1.032, '★ 无关新闻不应影响股价（船运利好 vs 白酒股）');
}

// ★ 利好但承压：drift 为正，股价反而跌
{
  const s = new Simulator();
  s.init(fakeDefs);
  s.applyNews({ id: 'x3', sector: 'liquor', kind: 'pressured', truth: true, impact: { drift: 5, turns: 1 } });
  const p0 = s.priceOf('T1');
  s.step();
  ok(s.priceOf('T1') < p0 * 1.032, `★ 利好但承压：股价应低于无新闻时（实际 ${s.priceOf('T1').toFixed(2)}）`);
}

// ★ 假消息反向
{
  const s = new Simulator();
  s.init(fakeDefs);
  s.applyNews({ id: 'x4', sector: 'liquor', kind: 'relevant', truth: false, impact: { drift: 5, turns: 1 } });
  const p0 = s.priceOf('T1');
  s.step();
  ok(s.priceOf('T1') < p0, '★ 假利好消息应导致下跌（反向）');
}

// 价格下限
const sim2 = new Simulator();
sim2.init([{ ...fakeDefs[1], path: new Array(12).fill(-99) }]);
for (let i = 0; i < 12; i++) sim2.step();
eq(sim2.priceOf('T2'), 1, '价格不得跌破 floor');

ok(!Object.values(sim.states).some((s) => Number.isNaN(s.price)), '价格不应出现 NaN');

// ---------- 3. 交易规则 ----------
console.log('[3] 交易规则');
const order = await import('../js/market/order.js');

// 手续费：买入 万三最低 5 元；卖出 再加千一印花税
eq(order.calcFee(10000, 'buy'), Math.max(10000 * 0.0003, 5), '1 万买入的手续费');
eq(order.calcFee(100000, 'buy'), 30, '10 万买入的手续费 = 30');
eq(order.calcFee(1000, 'buy'), 5, '小额买入走最低 5 元');
eq(order.calcFee(10000, 'sell'), Math.max(10000 * 0.0003, 5) + 10, '1 万卖出含千一印花税');
eq(order.calcFee(100000, 'sell'), 30 + 100, '10 万卖出 = 佣金 30 + 印花税 100');
ok(order.calcFee(10000, 'sell') > order.calcFee(10000, 'buy'), '★ 卖出成本必须高于买入（印花税）');
ok(order.STAMP_TAX_RATE === 0.001, '印花税率 = 千一');

// 整手校验
ok(!order.validateBuy(30, 150, 999999).ok, '150 股（非整手）应被拒绝');
ok(order.validateBuy(30, 200, 999999).ok, '200 股应通过');
ok(!order.validateBuy(30, 200, 100).ok, '资金不足应被拒绝');

// 满仓手数（用数据里的价格，不写死）
const lotsCheap = order.maxLots(10, initCash);
ok(lotsCheap >= 5, `1 万元买 ¥10 的股票应能买 ≥5 手，实际 ${lotsCheap}`);
ok(order.costToBuy(10, lotsCheap * 100) <= initCash, '满仓金额不得超过现金');

// ---------- 4. 持仓与盈亏 ----------
console.log('[4] 持仓与盈亏');
const { default: Portfolio } = await import('../js/market/portfolio.js');

const pf = new Portfolio(10000);
const C_A = FIX3[0].code;
const buyR = pf.buy(C_A, 28, 200); // 5600 + 手续费
eq(pf.sharesOf(C_A), 200, '买入后持仓 200 股');
ok(pf.cash < 10000 - 5600, '现金应扣除本金与手续费');
eq(pf.avgCostOf(C_A), (5600 + buyR.fee) / 200, '平均成本含手续费');

// 涨到 30 卖出，应盈利
const sellR = pf.sell(C_A, 30, 200);
ok(sellR.profit > 0, '28 买 30 卖应盈利');
eq(pf.sharesOf(C_A), 0, '清仓后持仓归零');

// 部分卖出结转成本
const C_B = FIX3[1].code;
const pf2 = new Portfolio(10000);
pf2.buy(C_B, 22, 200);
pf2.sell(C_B, 22, 100);
eq(pf2.sharesOf(C_B), 100, '部分卖出后剩 100 股');
ok(pf2.positions[C_B].costAmount > 0, '剩余持仓应保留成本');

// 不足一手也能清仓（零股）
const C_C = FIX3[2].code;
const pf3 = new Portfolio(10000);
pf3.buy(C_C, 32, 100);
pf3.sell(C_C, 32, 50);
eq(pf3.sharesOf(C_C), 50, '零股卖出生效');

// ---------- 5. 破产判定 ----------
console.log('[5] 破产判定');
const busMod = await import('../js/core/databus.js');
const DataBus = busMod.default;

const bus = new DataBus();
ok(bus.start('lv_01'), '开局应成功');

// 初始不应破产：总资产 10000，远高于最低一手
ok(!bus.isBankrupt(), '初始状态不应破产');

// 花光现金 → 破产
bus.portfolio.cash = 1;
ok(bus.isBankrupt(), '总资产 ¥1 应破产');

bus.portfolio.cash = initCash;
ok(!bus.isBankrupt(), `总资产 ¥${initCash} 不应破产`);

// ⚠️ 核心回归：口径是"总资产"而不是"现金"
// 买入把现金换成股票，总资产几乎不变，**不应**被判破产
{
  const busB = new DataBus();
  busB.start('lv_01');
  busB.nextTurn();

  const cheapest = busB.stockDefs
    .map((d) => ({ code: d.code, price: busB.priceMap[d.code] }))
    .sort((a, b) => a.price - b.price)[0];
  const lots = order.maxLots(cheapest.price, busB.portfolio.cash);
  busB.portfolio.buy(cheapest.code, cheapest.price, lots * order.LOT_SIZE);

  ok(busB.portfolio.cash < busB.bankruptLine(),
    `满仓后现金 ¥${busB.portfolio.cash.toFixed(0)} 低于破产线 ¥${busB.bankruptLine().toFixed(0)}`);
  ok(busB.portfolio.totalAssets(busB.priceMap) > busB.bankruptLine(),
    '满仓后总资产仍高于破产线');
  ok(!busB.isBankrupt(), '★ 满仓买入不应被判破产（回归：曾只看现金）');
}

// 持仓市值不计入现金，但计入破产判定
{
  const busP = new DataBus();
  busP.start('lv_01');
  // ⚠️ 不能写死股票代码 —— 每局是随机抽的 3 只，写死的 code 很可能不在本局里，
  //    priceMap[code] 会是 undefined → 市值算 0 → 误判破产。
  //    正确做法：从本局实际的 stockDefs 里取第一只。
  const held = busP.stockDefs[0];
  const px = busP.priceMap[held.code];
  busP.portfolio.cash = 100;
  busP.portfolio.positions = { [held.code]: { shares: 100, costAmount: px * 100 } };
  const total = busP.portfolio.totalAssets(busP.priceMap);
  ok(total > busP.bankruptLine(),
    `现金 ¥100 + 市值 ¥${(total - 100).toFixed(0)} 应高于破产线`);
  ok(!busP.isBankrupt(), '有持仓时按总资产判定，不破产');
}

// ---------- 6. 到期结算 ----------
console.log('[6] 到期结算');
const bus2 = new DataBus();
bus2.start('lv_01');

// 未到期
bus2.turn = 5;
ok(!bus2.isTermOver(), '第 5 月不应到期');
bus2.turn = 12;
ok(bus2.isTermOver(), '第 12 月应到期（回合耗尽）');

// 到期结算：盈利 → win
const busW = new DataBus();
busW.start('lv_01');
busW.turn = 12;
busW.portfolio.cash = busW.level.initCash + 1500;
const rW = busW.settleTerm();
eq(rW.outcome, 'win', '到期时资产高于本金应判 win');
ok(rW.profit > 0, '应记录正收益');
ok(rW.reason.includes('净赚'), 'win 的说明应提到净赚');

// 到期结算：亏损 → lose
const busL = new DataBus();
busL.start('lv_01');
busL.turn = 12;
busL.portfolio.cash = busL.level.initCash - 800;
const rL = busL.settleTerm();
eq(rL.outcome, 'lose', '到期时资产低于本金应判 lose');
ok(rL.profit < 0, '应记录负收益');
ok(rL.reason.includes('净亏'), 'lose 的说明应提到净亏');

// 到期结算：持平 → lose
const busF = new DataBus();
busF.start('lv_01');
busF.turn = 12;
busF.portfolio.cash = busF.level.initCash;
eq(busF.settleTerm().outcome, 'lose', '持平应判 lose（未跑赢）');

// ---- 年末强制平仓 ----
{
  // 持有股票到期 → 必须被强制卖出，最终资产 = 纯现金
  const busQ = new DataBus();
  busQ.start('lv_01');
  busQ.turn = 12;
  busQ.portfolio.cash = 5000;
  // 用本局实际抽到的股票，不写死代码
  const holdQ = busQ.stockDefs[0].code;
  busQ.portfolio.positions = { [holdQ]: { shares: 300, costAmount: 3600 } };

  const beforeCash = busQ.portfolio.cash;
  const beforeTotal = busQ.portfolio.totalAssets(busQ.priceMap);
  const rQ = busQ.settleTerm();

  ok(!busQ.portfolio.hasPositions(), '★ 到期后不应残留任何持仓（强制平仓）');
  ok(Math.abs(busQ.portfolio.cash - rQ.total) < 0.011,
    `★ 平仓后最终资产应等于纯现金（现金 ¥${busQ.portfolio.cash.toFixed(2)} / 资产 ¥${rQ.total.toFixed(2)}）`);
  ok(rQ.liquidation && rQ.liquidation.details.length === 1,
    '结算结果应带平仓明细');
  eq(rQ.liquidation.details[0].shares, 300, '平仓股数应为 300');
  ok(rQ.liquidation.totalFee >= 5, `平仓应计手续费（¥${rQ.liquidation.totalFee.toFixed(1)}）`);
  ok(beforeTotal - rQ.total > 0 && beforeTotal - rQ.total < 100,
    '平仓仅损耗手续费，不应大幅改变资产');
  ok(/清仓|平仓|空仓/.test(rQ.reason), 'reason 应说明平仓情况');
}

{
  // 空仓到期 → 不产生平仓明细
  const busE = new DataBus();
  busE.start('lv_01');
  busE.turn = 12;
  busE.portfolio.cash = busE.level.initCash;
  const rE = busE.settleTerm();
  ok(rE.liquidation === null, '空仓到期不应有平仓明细');
  ok(/空仓/.test(rE.reason), '空仓到期文案应说明无需平仓');
}

// ---------- 7. 新闻编排 ----------
console.log('[7] 新闻编排');
const { default: Dispatcher } = await import('../js/news/dispatcher.js');

const deckA = buildNewsDeck(pickStocks(3), 12);
const d1 = new Dispatcher();
const s1 = d1.buildScript(deckA, pickStocks(3));
eq(s1.length, 12, '编排脚本长度应为 12');
s1.forEach((n, i) => {
  ok(n.turn === i + 1, `第 ${i + 1} 条新闻的 turn 字段应正确`);
  ok(!!n.sector, `第 ${i + 1} 条新闻应有 sector`);
});

// 同局内不重复
const ids = s1.map((n) => n.id);
ok(new Set(ids).size === ids.length, '同一局内新闻不应重复');

// 每局都随机：跑 30 次，应出现多种编排
{
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    const stk = pickStocks(3);
    const d = new Dispatcher();
    seen.add(d.buildScript(buildNewsDeck(stk, 12), stk).map((n) => n.id).join(','));
  }
  ok(seen.size > 1, `30 次开局应产生多种编排，实际 ${seen.size} 种`);
}

// ★ 抽到的三只股票，其行业新闻应能出现在候选池里（新闻按股票抽取）
{
  const stk = [
    STOCK_POOL.find((s) => s.sector === 'energy'),
    STOCK_POOL.find((s) => s.sector === 'tech'),
    STOCK_POOL.find((s) => s.sector === 'transport'),
  ].filter(Boolean);
  const deck = buildNewsDeck(stk, 12);
  const flat = deck.flat();
  const relHit = flat.filter((id) => {
    const n = NEWS_POOL_MAP[id];
    return n && n.sector === 'energy';
  }).length;
  ok(relHit > 0, '★ 抽到能源股时，能源类新闻应进入候选池');
}

// ---------- 8. 机构评级 ----------
console.log('[8] 机构评级');
const {
  default: Institution,
  RATINGS,
  WEIGHT_NEWS,
  WEIGHT_NOISE,
} = await import('../js/news/institution.js');

// 三只不同行业的股票 + 对应的涨跌幅映射（用股票池里的真实对象，不写死代码）
const rA = STOCK_POOL.find((s) => s.sector === 'liquor') || STOCK_POOL[0];
const rB = STOCK_POOL.find((s) => s.sector === 'tech') || STOCK_POOL[1];
const rC = STOCK_POOL.find((s) => s.sector === 'transport') || STOCK_POOL[2];
const rateDefs = [rA, rB, rC];
const CA = rA.code;
const CB = rB.code;
const CC = rC.code;
const inst = new Institution();
const ratings = inst.rateAll(rateDefs, { [CA]: 3.5, [CB]: -2, [CC]: 0.1 }, null);
eq(ratings.length, 3, '应给出 3 条评级');
ratings.forEach((r) => {
  ok(RATINGS.some((x) => x.key === r.rating.key), `${r.name} 的评级应为合法档位`);
  ok(!Number.isNaN(r.score), `${r.name} 的 score 不应为 NaN`);
});

// 明显上涨应偏多、明显下跌应偏空
//
// ⚠️ 口径说明（第四版）：这里同时断言**因子**与**总分**。
//    · parts.trend 是确定性的 —— 相对强弱 +6/−6 必然给出 ±1，可以断言到 0.9 以上
//    · score 含随机噪声，只能给一个宽松阈值。
//      噪声权重 0.60 时：score = 0.30·(±1) + 0.60·n，命中率 = P(0.30 + 0.60n > 0) = 75%，
//      即 40 次里期望 30 次。阈值取 22（z ≈ −2.9）留足余量；
//      trend 权重若被调没，命中率会掉回 50%（20 次），仍然拦得住。
//   只断言 score 会随噪声权重调整而误报；只断言 factor 又验证不到权重组合是否合理。
let upBull = 0;
let downBear = 0;
let trendOk = 0;
for (let i = 0; i < 40; i++) {
  const ii = new Institution();
  // 相对强弱：CA 最强、CB 最弱（三者均值 = 0）
  const rs = ii.rateAll(rateDefs, { [CA]: 6, [CB]: -6, [CC]: 0 }, null);
  const up = rs.find((r) => r.code === CA);
  const dn = rs.find((r) => r.code === CB);
  if (up.parts.trend > 0.9 && dn.parts.trend < -0.9) trendOk++;
  if (up.score > 0) upBull++;
  if (dn.score < 0) downBear++;
}
ok(trendOk === 40, `★ 相对强弱因子应饱和到 ±1（40 次中 ${trendOk} 次）`);
ok(upBull >= 22, `最强股评级应偏多（40 次中 ${upBull} 次为正，理论 30 次）`);
ok(downBear >= 22, `最弱股评级应偏空（40 次中 ${downBear} 次为负，理论 30 次）`);

// 假消息反向：同一 drift，真消息与假消息的新闻因子应相反
//
// ⚠️ 口径（第四版修订）：新闻方向**编码在因子里**（确定性，可精确断言），
//   但**不该可靠地体现在总分上** —— 这正是"假消息不点破"的设计。
//   新闻权重 0.10、噪声权重 0.60：强消息把总分推向正确方向的概率只有
//   P(0.10 + 0.60·n > 0) = 58%，也就是**四成时候看不出来**。
//   旧版新闻权重 0.30，总分能可靠跟着新闻走 = 等于把答案写在玩家脸上。
//   所以这里改成两条：
//     · 因子必须严格反向（确定性）
//     · 总分的"新闻倾向"必须**明显弱于可靠**（噪声话语权必须压过新闻话语权）
let truthPos = 0;
let fakeNeg = 0;
let newsOpposite = 0;
for (let i = 0; i < 40; i++) {
  const newsTrue = { id: 'x', sector: 'liquor', kind: 'relevant', impact: { drift: 5, turns: 1 }, truth: true };
  const newsFake = { id: 'x', sector: 'liquor', kind: 'relevant', impact: { drift: 5, turns: 1 }, truth: false };
  // 走势给 0，隔离新闻因子
  const rt = new Institution().rateAll(rateDefs, { [CA]: 0, [CB]: 0, [CC]: 0 }, newsTrue)[0];
  const rf = new Institution().rateAll(rateDefs, { [CA]: 0, [CB]: 0, [CC]: 0 }, newsFake)[0];
  if (rt.parts.news > 0.9 && rf.parts.news < -0.9) newsOpposite++;
  if (rt.score > 0) truthPos++;
  if (rf.score < 0) fakeNeg++;
}
ok(newsOpposite === 40, `★ 真/假消息的新闻因子必须严格反向（40 次中 ${newsOpposite} 次）`);
// 确定性：新闻的话语权必须低于噪声的一半。若 NEWS ≥ NOISE，
// 强消息（|factor| = 1）就能把总分推过噪声半幅，评级重新变成"照抄新闻"。
ok(WEIGHT_NEWS < WEIGHT_NOISE * 0.5,
  `★ 新闻话语权必须远低于噪声（NEWS ${WEIGHT_NEWS} < NOISE ${WEIGHT_NOISE} × 0.5）`);
// 统计：总分对新闻方向的倾向必须"弱"。理论值 58%，上限取 78%（z≈+4，几乎不会误报）。
const newsLean = (truthPos + fakeNeg) / 80;
ok(newsLean < 0.78,
  `★ 总分只该"轻微"体现新闻方向（实际 ${(newsLean * 100).toFixed(1)}% < 78%，理论 58%）`
  + ' —— 再高就等于把真假写在玩家脸上');

// ★ 错配新闻：sector 不命中该股 → 新闻因子不体现消息方向
//
// ⚠️ 断言口径是 **parts.news**，不是 score。
//    旧版断言的是"总分接近中性"，而总分里混着随机噪声 ——
//    一旦调高噪声权重（第四版把噪声从 0.2 提到 0.36），那条断言就误报，
//    看起来像"错配逻辑坏了"，其实是噪声变大了。
//    直接断言新闻因子，才与噪声权重解耦。
{
  let maxNews = 0;
  for (let i = 0; i < 40; i++) {
    const ii = new Institution();
    // 白酒股 + 运输利好（错配）
    const rs = ii.rateAll(
      rateDefs,
      { [CA]: 0, [CB]: 0, [CC]: 0 },
      { id: 'm', sector: 'transport', kind: 'irrelevant', impact: { drift: 5, turns: 1 }, truth: true },
    );
    maxNews = Math.max(maxNews, Math.abs(rs[0].parts.news));
  }
  ok(maxNews <= 0.05, `★ 错配新闻不体现方向（新闻因子最大 |${maxNews.toFixed(3)}| ≤ 0.05）`);
}

// ★ 利好但承压（= 财务造假 / 增收不增利）：机构应**跟着标题看多**
//
// 第四版**刻意反转**了旧行为。旧版让机构一眼识破（评级偏空），
// 等于免费送给玩家一个"暴雷预警"；实测暴雷前一月有 53.9% 被打成看空
// （全体基准 35.8%），玩家照着躲就行。
// 现在机构被"报表一片向好"骗到 —— 评级偏多，随后业绩暴雷。
// 玩家必须自己起疑："这么好的消息，股价为什么在跌？"
{
  let pressuredBull = 0;
  for (let i = 0; i < 40; i++) {
    const ii = new Institution();
    const rs = ii.rateAll(
      rateDefs,
      { [CA]: 0, [CB]: 0, [CC]: 0 },
      { id: 'p', sector: 'liquor', kind: 'pressured', impact: { drift: 5, turns: 1 }, truth: true },
    );
    if (rs[0].parts.news > 0) pressuredBull++;
  }
  ok(pressuredBull >= 35, `★ 利好但承压时机构被标题骗到（新闻因子为正：40 次中 ${pressuredBull} 次）`);
}

// ★★ 评级不得泄漏大盘方向（第四版核心修复）
//
// 走势因子用**绝对涨跌幅**时，评级会退化成"大盘方向指示器"：
// 实测大盘暴涨月里"看多档"下月上涨比例 97.8%、"看空档"只有 0.8%，
// 合并 IC = 0.307 —— 玩家扫一眼评级就知道"现在是牛是熊"，
// 而关卡设计明令**不告诉玩家**年份与风格。
//
// 判据：三只股票**同涨同跌**（= 纯大盘行情，相对强弱全为 0）时，
// 评级只能由噪声决定，因此**不该整齐划一地看空/看多**。
{
  const crashBear = []; // 齐跌时被判看空的比例
  const boomBull = []; // 齐涨时被判看多的比例
  for (let i = 0; i < 60; i++) {
    const a = new Institution().rateAll(rateDefs, { [CA]: -8, [CB]: -8, [CC]: -8 }, null);
    crashBear.push(a.filter((r) => r.rating.key === 'sell' || r.rating.key === 'strong_sell').length / 3);
    const b = new Institution().rateAll(rateDefs, { [CA]: 8, [CB]: 8, [CC]: 8 }, null);
    boomBull.push(b.filter((r) => r.rating.key === 'buy' || r.rating.key === 'strong_buy').length / 3);
  }
  const avgBear = crashBear.reduce((x, y) => x + y, 0) / crashBear.length;
  const avgBull = boomBull.reduce((x, y) => x + y, 0) / boomBull.length;
  // 旧版这两个数都是 1.0（齐跌 → 全部看空）。上限取 0.6 留出充足余量：
  // 齐跌时相对强弱全为 0，score = 0.60·n，判看空需 n ≤ -0.25 → 理论值 0.375。
  ok(avgBear < 0.6, `★ 三只齐跌时不得全部看空（实际 ${(avgBear * 100).toFixed(1)}% < 60%）`);
  ok(avgBull < 0.6, `★ 三只齐涨时不得全部看多（实际 ${(avgBull * 100).toFixed(1)}% < 60%）`);
}

// ★ 相对强弱必须真的起作用：三只涨跌互不相同时，评级应跟随相对强弱
//
// ⚠️ 口径（与第 624 行同一套）：parts.trend 确定性，可以精确断言；
//   score 含噪声，只能给宽松阈值。
//   算术：trend 差 2（±1 饱和）× 权重 0.30 = 0.60；
//   两侧噪声差是 (-2, 2) 上的三角分布，翻盘概率 = P(噪声差 < -1.0) = 12.5%。
//   所以 40 次里"总分正确排序"的期望是 35 次 —— 阈值取 27（z ≈ -3.8）。
//   这 12.5% 的翻盘率**就是设计**：机构会看走眼，玩家不能照抄。
{
  let trendOrder = 0;
  let relOk = 0;
  for (let i = 0; i < 40; i++) {
    // CA 最强、CB 最弱、CC 居中
    const rs = new Institution().rateAll(rateDefs, { [CA]: 9, [CB]: -9, [CC]: 0 }, null);
    const a = rs.find((r) => r.code === CA);
    const b = rs.find((r) => r.code === CB);
    if (a.parts.trend > b.parts.trend) trendOrder++;
    if (a.score > b.score) relOk++;
  }
  ok(trendOrder === 40, `★ 相对强弱因子应严格排序（最强 > 最弱：40 次中 ${trendOrder} 次）`);
  ok(relOk >= 27,
    `最强股总分应多数时候高于最弱股（40 次中 ${relOk} 次；理论 35 次，`
    + '约 12% 被噪声翻盘是设计而非缺陷）');
}

// ---------- 9. 数值平衡校验 ----------
console.log('[9] 数值平衡');
const basePrices = STOCK_POOL.map((s) => s.basePrice);
const cheapestLot = Math.min(...basePrices) * 100;

// 关键：初始资金应买得起「最便宜一手」很多次，否则一动就死
ok(
  cheapestLot <= initCash * 0.15,
  `最低一手成本 ¥${cheapestLot} 应 ≤ 初始资金的 15%（¥${(initCash * 0.15).toFixed(0)}）`,
);

// 买一手最贵的，剩余现金仍应高于最低一手成本
const priciestLot = Math.max(...basePrices) * 100;
ok(
  initCash - priciestLot > cheapestLot,
  `买一手最贵股票（¥${priciestLot}）后，剩余现金应仍高于最低一手成本（¥${cheapestLot}）`,
);

// 初始资金应能买 8 手以上最便宜的股票（留出分散调仓空间）
ok(
  order.maxLots(Math.min(...basePrices), initCash) >= 8,
  `初始资金应能买 ≥8 手最低价股票，实际 ${order.maxLots(Math.min(...basePrices), initCash)} 手`,
);

// 价格下限必须高于破产线的容错：floor × 100 不应超过初始资金
STOCK_POOL.forEach((s) => {
  ok(
    s.floor * 100 <= initCash * 0.2,
    `${s.name} 的 floor(¥${s.floor}) × 100 = ¥${s.floor * 100} 应 ≤ 初始资金的 20%`,
  );
});

// ---------- 10. 完整一局模拟 ----------
console.log('[10] 完整一局模拟');
const bus3 = new DataBus();
bus3.start('lv_01');

// 策略：每月用不超过 30% 现金买一手最便宜的股票 —— 模拟"轻仓"玩家
let survived = 0;
let bankrupted = false;
for (let t = 1; t <= 12; t++) {
  bus3.nextTurn();

  const cheapest = bus3.stockDefs
    .map((d) => ({ code: d.code, price: bus3.priceMap[d.code] }))
    .sort((a, b) => a.price - b.price)[0];

  if (cheapest && cheapest.price * 100 <= bus3.portfolio.cash * 0.3) {
    bus3.portfolio.buy(cheapest.code, cheapest.price, 100);
  }

  bus3.simulator.applyNews(bus3.news);
  bus3.settle();
  bus3.generateRatings();

  survived = t;

  if (bus3.isBankrupt()) {
    bankrupted = true;
    bus3.finish('bankrupt', '轻仓策略仍破产');
    break;
  }
}

// 一局自然地走完时，由 main.js 判定结局；这里手动补上，验证结算链路
if (!bankrupted) {
  bus3.settleTerm();
}

ok(bus3.turn >= 1, '至少推进了 1 个回合');
ok(bus3.result !== null, '应产生结算结果');
ok(!Number.isNaN(bus3.result.total), '结算总资产不应为 NaN');
ok(['win', 'lose', 'bankrupt'].includes(bus3.result.outcome), '结局类型应合法');

// 关键平衡断言：轻仓策略不应在 6 个月内破产
ok(
  survived >= 6,
  `轻仓玩家（每月最多买 1 手、单次不超 30% 现金）应能撑过 6 个月，实际 ${survived} 个月`,
);

console.log(`    （轻仓模拟：存活 ${survived} 个月，结局 ${bus3.result.outcome}，总资产 ¥${bus3.result.total.toFixed(0)}）`);

// ---------- 11. 回合流转：每个月都必须能交易（含 12 月）----------
//
// 回归背景：曾经 newsflash 的 closed 回调直接调 _settleAndJudge()，
// 而 _settleAndJudge 里含 isTermOver() 判定 —— 于是 12 月新闻一关掉
// 就立刻跳结算，玩家根本没机会做 12 月的交易，观感是"关卡提前结束了"。
// 这里从**逻辑层**锁死这个不变量：最后一个月也必须是"可交易回合"。
console.log('[11] 回合流转（每月可交易，含 12 月）');

{
  const busT = new DataBus();
  busT.start('lv_01');
  const turns = busT.level.turns;
  ok(turns === 12, `本关应为 12 个回合（实际 ${turns}）`);

  // 逐回合推进，断言每回合都处于"可交易"状态
  const tradable = [];
  for (let t = 1; t <= turns; t++) {
    busT.nextTurn();
    // 进入交易：结算价格 + 评级（与 main._enterTrading 同构）
    busT.settle();
    busT.generateRatings();
    busT.phase = 'TRADING';

    const canTrade =
      busT.phase === 'TRADING' &&
      !!busT.stockDefs.length &&
      busT.stockDefs.every((d) => typeof busT.priceMap[d.code] === 'number');
    tradable.push(canTrade);

    // 只有在**非**最后一回合才允许继续推进
    if (t < turns) {
      ok(!busT.isTermOver(), `第 ${t} 回合不应被判为到期`);
    }
  }

  ok(
    tradable.every(Boolean),
    `全部 ${turns} 个回合都应可交易（实际可交易 ${tradable.filter(Boolean).length} 个）`,
  );
  ok(tradable[turns - 1], '★ 第 12 月必须可交易（回归：不能一关新闻就结算）');

  // 第 12 回合：isTermOver 为真，但这是"该收尾了"，不是"不能交易"
  ok(busT.turn === turns && busT.isTermOver(), '第 12 回合 isTermOver 应为真');
  ok(
    busT.phase === 'TRADING',
    '第 12 回合结算前仍应处于 TRADING（而非被判定over）',
  );

  // 收尾：只有显式结算才产生结局
  busT.phase = 'SETTLE';
  busT.settleTerm();
  ok(busT.phase === 'OVER', '显式结算后 phase 才变为 OVER');
  ok(busT.result !== null, '显式结算后才有 result');
}

// ---------- 汇总 ----------
console.log('\n=== 结果 ===');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
} else {
  console.log('全部通过 ✓');
}
