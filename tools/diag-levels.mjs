/**
 * 诊断：五关流程 + 跨关不重复抽卡（第三版核心需求）
 *
 * 这一支测试是**面向玩家体验的不变量**，不是数值调参：
 *
 *   [1] 关卡结构与"年景隐藏"
 *       · 5 关、index 连续
 *       · 面向玩家的文案里没有年份 / 市场风格词
 *       · 关卡不再有 theme 字段
 *
 *   [2] 单关开局（真实走 DataBus.start）
 *       · 抽到 3 只股票、行业互不相同
 *       · 有 12 组候选新闻、每回合非空
 *       · 记录了 seasonId（内部），但玩家可见字段里不含它
 *
 *   [3] 跨关不重复
 *       · 连打 5 关：5 个年景互不相同
 *       · 连打 20 关（4 轮）：20 个年景互不相同（池子 20 个刚好够）
 *       · 第 21 关起才开始复用（刻意设计，不是 bug）
 *
 *   [4] 关卡的风格池生效
 *       · lv_02 只抽 smallBear / bear
 *       · lv_05 全放开，六种风格都可能出现
 */

globalThis.wx = {
  createCanvas: () => ({ width: 375, height: 667, getContext: () => ({ scale() {} }) }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 3 }),
  onTouchStart() {},
};

const { LEVELS, LEVEL_MAP, SEASON_MAP } = await import('../js/data/index.js');
const { MARKET_STYLE_KEYS } = await import('../js/market/pathgen.js');
const { default: DataBus } = await import('../js/core/databus.js');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

// ⚠️ DataBus 是**单例**：new DataBus() 永远返回同一个实例。
//    所以每个独立场景必须先 reset()，否则 usedSeasonIds 会串场。
const bus = new DataBus();
const fresh = () => { bus.reset(); return bus; };

// ---------- [1] 关卡结构与年景隐藏 ----------
console.log('[1] 关卡结构与"年景隐藏"');

ok(LEVELS.length === 5, `应为 5 关，实际 ${LEVELS.length}`);
LEVELS.forEach((lv, i) => {
  ok(lv.index === i + 1, `${lv.id} 的 index 应为 ${i + 1}`);
  ok(!lv.theme, `${lv.id} 不应有 theme 字段`);
  const visible = `${lv.title}\n${lv.intro}`;
  ok(!/19\d{2}|20\d{2}/.test(visible), `${lv.id} 的可见文案不应含年份`);
  ok(!/牛市|熊市|震荡|小牛|小熊|横盘|箱体/.test(visible), `${lv.id} 的可见文案不应含市场风格词`);
  ok(typeof lv.intro === 'string' && lv.intro.length > 10, `${lv.id} 应有开场文案`);
});

// 反向自检：确认正则真的能抓到年份/风格 —— 否则上面的断言等于没写
ok(/19\d{2}/.test('1996 · 全民炒股'), '★ 年份正则应能抓到 "1996"');
ok(/牛市|熊市/.test('牛市'), '★ 风格正则应能抓到 "牛市"');

// ---------- [2] 单关开局 ----------
console.log('[2] 单关开局（真实走 DataBus）');

{
  fresh();
  ok(bus.start('lv_01'), 'lv_01 开局应成功');
  ok(bus.errors.length === 0, `开局不应有数据错误：${bus.errors.join('; ')}`);

  ok(bus.stockDefs.length === 3, `应抽 3 只股票，实际 ${bus.stockDefs.length}`);
  const secs = bus.stockDefs.map((s) => s.sector);
  ok(new Set(secs).size === 3, `三只股票行业应互不相同：${secs.join('/')}`);
  ok(bus.newsDeck.length === 12, `应有 12 组候选新闻，实际 ${bus.newsDeck.length}`);
  bus.newsDeck.forEach((g, i) => ok(g.length > 0, `第 ${i + 1} 回合候选不应为空`));

  // seasonId 是内部字段，且必须真实存在于年景池
  ok(!!bus.seasonId, '开局应记录年景 id');
  ok(!!SEASON_MAP[bus.seasonId], `记录的 seasonId(${bus.seasonId}) 应存在于年景池`);

  // 玩家可见面：不该有任何地方暴露年景
  ok(!('seasonLabel' in bus.level), '关卡对象不应带 seasonLabel');
  ok(bus.levelPosition().total === 5, 'levelPosition().total 应为 5');
  ok(bus.levelPosition().index === 1, 'lv_01 的显示序号应为 1');
}

// ---------- [3] 跨关不重复 ----------
console.log('[3] 跨关不重复');

{
  // 连打 5 关（同一个 DataBus，usedSeasonIds 累积）
  fresh();
  const used = [];
  for (let i = 0; i < 5; i++) {
    const lv = LEVELS[i];
    ok(bus.start(lv.id), `${lv.id} 应能开局`);
    used.push(bus.seasonId);
  }
  ok(new Set(used).size === 5, `★ 连打 5 关应使用 5 个不同年景（实际 ${used.join(',')}）`);
  ok(bus.usedSeasonCount() === 5, `已用年景计数应为 5，实际 ${bus.usedSeasonCount()}`);

  // 开局时不能重复使用同一组股票组合（年景不同 → 组合不同）
  const combos = new Set();
  fresh();
  for (let i = 0; i < 5; i++) {
    bus.start(LEVELS[i].id);
    combos.add(bus.stockDefs.map((s) => s.code).sort().join(','));
  }
  ok(combos.size === 5, `★ 5 关的股票组合应各不相同（实际 ${combos.size} 种）`);
}

{
  // 连打 20 关 —— 池子正好 20 个，应全部用上且不重复
  fresh();
  const used = [];
  for (let i = 0; i < 20; i++) {
    bus.start(LEVELS[i % 5].id);
    used.push(bus.seasonId);
  }
  ok(new Set(used).size === 20, `★ 20 关应用满 20 个年景且不重复（实际去重 ${new Set(used).size} 个）`);
}

{
  // 第 21 关：池子已空 → 允许复用（这是刻意设计），但不应抛错
  fresh();
  for (let i = 0; i < 20; i++) bus.start(LEVELS[i % 5].id);
  const okStart = bus.start(LEVELS[0].id);
  ok(okStart, '★ 年景池用尽后第 21 关仍应能正常开局（退化为允许复用）');
  ok(!!bus.seasonId, '第 21 关仍应有年景 id');
}

{
  // reset 后应清空"已用年景"，开始新的一轮
  fresh();
  for (let i = 0; i < 5; i++) bus.start(LEVELS[i].id);
  ok(bus.usedSeasonCount() === 5, 'reset 前已用 5 个');
  bus.reset();
  ok(bus.usedSeasonCount() === 0, '★ reset 后已用年景应清空（新一轮开始）');
}

// ---------- [4] 关卡的风格池生效 ----------
console.log('[4] 关卡风格池生效');

{
  // lv_02：pool = ['smallBear','bear'] → 30 次开局只能出现这两种风格
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    fresh();
    bus.start('lv_02');
    seen.add(bus.seasonId ? SEASON_MAP[bus.seasonId].style : '?');
  }
  ok(
    [...seen].every((s) => s === 'smallBear' || s === 'bear'),
    `★ lv_02 只能抽到 smallBear/bear，实际 ${[...seen].join('/')}`,
  );
}

{
  // lv_05：pool = null → 全放开，六种风格都应有可能出现
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    fresh();
    bus.start('lv_05');
    if (bus.seasonId) seen.add(SEASON_MAP[bus.seasonId].style);
  }
  ok(seen.size === MARKET_STYLE_KEYS.length,
    `★ lv_05 全放开时应能覆盖 6 种风格，实际 ${seen.size}：${[...seen].join('/')}`);
}

// ---------- 汇总 ----------
console.log('\n=== 结果 ===');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
} else {
  console.log('五关流程与跨关不重复诊断通过 ✓');
}
