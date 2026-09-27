/**
 * 诊断：连闯流程 —— 资金延续 + 跨关股票不重复
 *
 * 这一支测试是**面向玩家体验的不变量**，不是数值调参：
 *
 *   [1] 关卡结构与"年景隐藏"
 *       · 5 关、index 连续
 *       · 面向玩家的文案里没有年份 / 市场风格词
 *       · 关卡不再有 theme 字段
 *
 *   [2] 单关开局（连闯路径，真实走 DataBus.startRun）
 *       · 抽到 3 只股票、行业互不相同
 *       · 有 12 组候选新闻、每回合非空
 *       · 风格落在本关允许的风格池里
 *       · 玩家可见面不暴露风格 / 年景
 *
 *   [3] ★ 跨关股票不重复（本轮核心需求）
 *       · 连打 5 关：15 只股票互不相同
 *       · 连打 10 关：30 只互不相同（"轮界补货"生效）
 *       · 第 11 关起才允许复用（刻意设计）
 *       · **每一关都恰好 3 只** —— 永远不会出现"最后一关只剩 1-2 只"
 *       · 股票池大小必须是 3 的倍数
 *
 *   [4] ★ 资金延续
 *       · initCash 可被显式注入
 *       · 下一关的起始资金 == 上一关的期末总资产
 *
 *   [5] 关卡的风格池生效
 *       · lv_02 只抽 smallBear / bear
 *       · lv_05 全放开，六种风格都可能出现
 *
 *   [6] 年景路径（显式指定 season 时）仍然可用
 *       · 供诊断脚本做受控实验用
 */

globalThis.wx = {
  createCanvas: () => ({ width: 375, height: 667, getContext: () => ({ scale() {} }) }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 3 }),
  onTouchStart() {},
};

const { LEVELS, SEASON_MAP, STOCK_POOL } = await import('../js/data/index.js');
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
//    所以每个独立场景必须先 reset()，否则状态会串场。
const bus = new DataBus();
const fresh = () => { bus.reset(); return bus; };

/** 把一关跑到期末（12 个月）并结算 */
function playToEnd(seed) {
  for (let t = 0; t < bus.level.turns; t++) {
    bus.nextTurn();
    bus.settle();
  }
  return bus.settleTerm();
}

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

// 股票池结构：必须是 3 的倍数，且够撑满一整轮
ok(STOCK_POOL.length % 3 === 0,
  `★ 股票池大小必须是 3 的倍数（实际 ${STOCK_POOL.length}）—— 否则清空点会落在关卡中间，最后一关只剩 1-2 只`);
ok(STOCK_POOL.length >= 3 * LEVELS.length,
  `股票池应够撑满一整轮（需 ≥ ${3 * LEVELS.length}，实际 ${STOCK_POOL.length}）`);

// ---------- [2] 单关开局 ----------
console.log('[2] 单关开局（连闯路径）');

{
  fresh();
  ok(bus.startRun('lv_01'), 'lv_01 开局应成功');
  ok(bus.errors.length === 0, `开局不应有数据错误：${bus.errors.join('; ')}`);
  ok(bus.runMode === true, '应处于连闯模式');

  ok(bus.stockDefs.length === 3, `应抽 3 只股票，实际 ${bus.stockDefs.length}`);
  const secs = bus.stockDefs.map((s) => s.sector);
  ok(new Set(secs).size === 3, `三只股票行业应互不相同：${secs.join('/')}`);
  ok(bus.newsDeck.length === 12, `应有 12 组候选新闻，实际 ${bus.newsDeck.length}`);
  bus.newsDeck.forEach((g, i) => ok(g.length > 0, `第 ${i + 1} 回合候选不应为空`));

  // 连闯路径没有年景，但风格必须是本关允许的
  const allowed = LEVELS[0].pool;
  ok(allowed.includes(bus.style), `lv_01 的风格应落在池内 ${allowed.join('/')}，实际 ${bus.style}`);
  ok(bus.seasonId === null, '连闯路径不应有年景 id');

  // 玩家可见面：不该有任何地方暴露年景 / 风格
  ok(!('seasonLabel' in bus.level), '关卡对象不应带 seasonLabel');
  ok(!('theme' in bus.level), '关卡对象不应带 theme');
  ok(bus.levelPosition().total === 5, 'levelPosition().total 应为 5');
  ok(bus.levelPosition().index === 1, '第 1 关的显示序号应为 1');
  ok(bus.levelPosition().step === 1, '第 1 关的轮内序号应为 1');
  ok(bus.levelPosition().round === 1, '应处于第 1 轮');
}

// ---------- [3] ★ 跨关股票不重复 ----------
console.log('[3] ★ 跨关股票不重复');

{
  fresh();
  bus.startRun('lv_01');

  const seen = [];
  const codesPerLevel = [];
  const posSeen = [];
  for (let i = 0; i < 12; i++) {
    const codes = bus.stockDefs.map((d) => d.code);
    codesPerLevel.push(codes);
    posSeen.push(bus.levelPosition().index);
    seen.push(...codes);

    if (i < 11) {
      playToEnd();
      if (!bus.canContinue()) break;
      bus.startNextLevel();
    }
  }

  // 每一关都恰好 3 只 —— 这是"股票池是 3 的倍数"要守住的东西
  codesPerLevel.forEach((c, i) => {
    ok(c.length === 3, `★ 第 ${i + 1} 关应恰好 3 只股票，实际 ${c.length}`);
    ok(new Set(c).size === 3, `第 ${i + 1} 关内部不应重复（${c.join(',')}）`);
  });

  // 前 10 关（两轮）必须完全不重复 —— "轮界补货"规则的效果
  const first10 = seen.slice(0, 30);
  ok(new Set(first10).size === 30,
    `★ 连打 10 关应出现 30 只互不相同的股票，实际去重 ${new Set(first10).size} 只`);

  // 第 11 关起允许复用（池子 36 只 / 每关 3 只 = 12 关才用满，但轮界会提前补货）
  ok(seen.length === 36, `应恰好打满 12 关（36 个股票位），实际 ${seen.length}`);

  // 进度编号：累计且连续
  posSeen.forEach((p, i) => ok(p === i + 1, `第 ${i + 1} 次开局的累计编号应为 ${i + 1}，实际 ${p}`));

  // usedStockCodes 自身不能有重复
  const u = bus.usedStockCodes;
  ok(new Set(u).size === u.length, `usedStockCodes 不应有重复项（${u.length} 项 / ${new Set(u).size} 唯一）`);
}

{
  // ★ 池子用尽后仍必须恰好 3 只（不能退化成 1-2 只）
  fresh();
  bus.startRun('lv_01');
  for (let i = 0; i < 20; i++) {
    ok(bus.stockDefs.length === 3, `第 ${i + 1} 关应恰好 3 只（实际 ${bus.stockDefs.length}）`);
    const secs = bus.stockDefs.map((s) => s.sector);
    ok(new Set(secs).size === 3, `第 ${i + 1} 关行业应互不相同`);
    playToEnd();
    if (!bus.canContinue()) break;
    if (!bus.startNextLevel()) { ok(false, `第 ${i + 2} 关应能开局`); break; }
  }
  ok(bus.roundIndex >= 3, `连打 20 关应进入第 4 轮，实际第 ${bus.roundIndex + 1} 轮`);
}

// ---------- [4] ★ 资金延续 ----------
console.log('[4] ★ 资金延续');

{
  // 显式注入起始资金
  fresh();
  ok(bus.start('lv_01', { initCash: 7777 }), 'lv_01 开局应成功');
  ok(bus.initCash === 7777, `initCash 应被注入（实际 ${bus.initCash}）`);
  ok(bus.portfolio.cash === 7777, `组合初始现金应为 7777（实际 ${bus.portfolio.cash}）`);
}

{
  // 期末资产 → 下一关起始资金（真跑一整关，且买入持仓让资产真的发生变化）
  fresh();
  bus.startRun('lv_01', { seedKey: 'run-cash-test' });

  const cheapest = bus.stockDefs.reduce((a, b) => (a.basePrice <= b.basePrice ? a : b));
  bus.portfolio.buy(cheapest.code, cheapest.basePrice, 100);
  const res1 = playToEnd();

  ok(Math.abs(res1.total - 6000) > 0.01,
    `★ 期末资产应因持仓涨跌而变化（实际 ¥${res1.total.toFixed(2)}，起始 ¥6000）`);
  ok(res1.init === 6000, `第 1 关的本金应是 ¥6000（实际 ¥${res1.init}）`);

  ok(bus.startNextLevel(), '应能进入第 2 关');
  ok(Math.abs(bus.initCash - res1.total) < 0.01,
    `★ 第 2 关起始资金应等于第 1 关期末资产（期望 ¥${res1.total.toFixed(2)}，实际 ¥${bus.initCash.toFixed(2)}）`);
  ok(Math.abs(bus.portfolio.cash - res1.total) < 0.01,
    '第 2 关组合现金应等于注入的起始资金');
  ok(bus.portfolio.positions && Object.keys(bus.portfolio.positions).length === 0,
    '★ 新一关应空仓开始（上一关年末已强制平仓，不搬持仓）');

  // 第 2 关的本金基准应是"上一关的钱"，不是关卡默认的 ¥6000
  const res2 = playToEnd();
  ok(Math.abs(res2.init - res1.total) < 0.01,
    `★ 第 2 关的收益率基准应继承第 1 关期末资产（期望 ¥${res1.total.toFixed(2)}，实际 ¥${res2.init.toFixed(2)}）`);

  // 跑关战绩应累计
  ok(bus.runResults.length === 2, `跑关战绩应有 2 条（实际 ${bus.runResults.length}）`);
  ok(bus.runResults[0].index === 1 && bus.runResults[1].index === 2,
    '跑关战绩的累计编号应为 1、2');
  ok(Math.abs(bus.runResults[1].initCash - res1.total) < 0.01,
    '战绩里第 2 关的本金应等于第 1 关期末资产');
}

{
  // 破产时不允许继续
  fresh();
  bus.startRun('lv_01');
  bus.finish('bankrupt', '测试用');
  ok(bus.canContinue() === false, '★ 破产后 canContinue() 应为 false（不给"下一关"）');
}

{
  // 轮末判定
  fresh();
  bus.startRun('lv_01');
  for (let i = 0; i < 5; i++) {
    const atEnd = bus.isBlockEnd();
    ok(atEnd === (i === 4), `第 ${i + 1} 关的 isBlockEnd 应为 ${i === 4}（实际 ${atEnd}）`);
    if (i < 4) { playToEnd(); bus.startNextLevel(); }
  }
  const info = bus.nextLevelInfo();
  ok(info.newRound === true, '第 5 关之后 nextLevelInfo 应标记 newRound');
  ok(info.stepIndex === 0, '新一轮应从轮内第 0 关（= 第 1 关）开始');
  ok(info.roundIndex === 1, '新一轮的 roundIndex 应为 1');
  ok(info.id === LEVELS[0].id, `新一轮应从第 1 关开始，实际 ${info.id}`);
}

// ---------- [5] 关卡的风格池生效 ----------
console.log('[5] 关卡风格池生效');

{
  // lv_02：pool = ['smallBear','bear'] → 30 次开局只能出现这两种风格
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    fresh();
    bus.start('lv_02');
    seen.add(bus.style);
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
    seen.add(bus.style);
  }
  ok(seen.size === MARKET_STYLE_KEYS.length,
    `★ lv_05 全放开时应能覆盖 6 种风格，实际 ${seen.size}：${[...seen].join('/')}`);
}

{
  // ★ 反向自检：确认"池子优先"真的生效。
  //    lv_02 的占位 style 是 'smallBear'，pool 是 ['smallBear','bear']。
  //    若实现退化去用占位单值，'bear' 就永远不会出现 —— 这里必须能抓到。
  const seen = new Set();
  for (let i = 0; i < 80; i++) {
    fresh();
    bus.start('lv_02');
    seen.add(bus.style);
  }
  ok(seen.has('bear'), '★ 反向自检：lv_02 必须能抽到 bear（否则说明用了占位单值）');
}

// ---------- [6] 年景路径仍可用 ----------
console.log('[6] 年景路径（显式指定 season 时）');

{
  // 诊断脚本（diag-rating / diag-styles）靠这条路径做受控实验
  fresh();
  const season = SEASON_MAP.y01;
  ok(bus.start('lv_01', { season }), '指定 season 时应能开局');
  ok(bus.seasonId === 'y01', `应记录指定的年景 id（实际 ${bus.seasonId}）`);
  ok(bus.style === season.style, `风格应取自年景（期望 ${season.style}，实际 ${bus.style}）`);
  const codes = bus.stockDefs.map((d) => d.code).sort().join(',');
  ok(codes === season.codes.slice().sort().join(','),
    `股票应取自年景（期望 ${season.codes.join(',')}，实际 ${codes}）`);
}

{
  // 年景路径也记录"已用年景"。
  //
  // ⚠️ 口径变化（连闯版）：`usedSeasonIds` 现在只在**显式指定年景**时累积，
  //   因为 `bus.start()` 的默认路径已经不走年景了（改走 composeFreshLevel）。
  //   "跨关不重复"由 `usedStockCodes` 负责，`usedSeasonIds` 退化为
  //   "这条受控实验路径用过哪些年景"的记录。
  fresh();
  bus.start(LEVELS[0].id, { season: SEASON_MAP.y01 });
  bus.start(LEVELS[1].id, { season: SEASON_MAP.y02 });
  ok(bus.usedSeasonCount() === 2, `年景路径应累积已用年景（实际 ${bus.usedSeasonCount()}）`);
  bus.start(LEVELS[2].id, { season: SEASON_MAP.y01 }); // 再指定一次同一个
  ok(bus.usedSeasonCount() === 2, '重复指定同一年景不应重复计数');
  bus.reset();
  ok(bus.usedSeasonCount() === 0, '★ reset 后已用年景应清空');
}

// ---------- [7] ★ 起点推导与退市结算 ----------
console.log('[7] ★ 起点推导与退市结算');

{
  // 菜单允许直接选第 3 关开打。stepIndex 必须由所选关卡推导，
  // 写死 0 会让 UI 显示"第 1 / 5 关"，而且打完第 3 关就当成打完了第 1 关。
  fresh();
  ok(bus.startRun('lv_03'), 'lv_03 开局应成功');
  ok(bus.stepIndex === 2, `★ 从第 3 关开局时 stepIndex 应为 2（实际 ${bus.stepIndex}）`);
  const pos = bus.levelPosition();
  ok(pos.index === 3, `★ 显示进度应为第 3 关（实际 index=${pos.index}）`);
  ok(pos.step === 3 && pos.round === 1, `轮内序号应为 3、第 1 轮（实际 ${pos.step}/${pos.round}）`);
  ok(bus.level.id === 'lv_03', `当前关卡应为 lv_03（实际 ${bus.level.id}）`);

  // 从第 5 关开局 → 打完就是轮末
  fresh();
  bus.startRun('lv_05');
  ok(bus.stepIndex === 4, `lv_05 的 stepIndex 应为 4（实际 ${bus.stepIndex}）`);
  ok(bus.isBlockEnd() === true, '★ 从第 5 关开局，本关结束即轮末');
}

{
  // ★ 退市结算：把整轮战绩汇总成一份结算单
  fresh();
  bus.startRun('lv_01', { seedKey: 'final-settle' });
  playToEnd();
  bus.startNextLevel();
  playToEnd();
  bus.startNextLevel();
  const r3 = playToEnd();

  ok(bus.runResults.length === 3, `跑关战绩应有 3 条（实际 ${bus.runResults.length}）`);
  ok(bus.runResults.every((r) => r.turns === 12),
    `★ 每条战绩都应记录存活月份（实际 ${bus.runResults.map((r) => r.turns).join('/')}）`);

  const fin = bus.finalSettle();
  ok(!!fin, 'finalSettle 应返回结算结果');
  ok(fin.isFinal === true, '结算结果应标记 isFinal');
  ok(fin.levels === 3, `应记录连闯关数 3（实际 ${fin.levels}）`);
  ok(Math.abs(fin.init - 6000) < 0.01,
    `★ 整轮本金应是第 1 关起始资金 ¥6000（实际 ¥${fin.init}）`);
  ok(Math.abs(fin.total - r3.total) < 0.01,
    `期末总资产应等于末关期末资产（期望 ¥${r3.total.toFixed(2)}，实际 ¥${fin.total.toFixed(2)}）`);
  ok(fin.turns === 36, `★ 累计月份应是各关之和 36（实际 ${fin.turns}）`);
  ok(Math.abs(fin.profit - (r3.total - 6000)) < 0.01,
    '★ 净盈亏应按"整轮本金"算，不是按末关本金算');
  ok(fin.outcome === (r3.total > 6000 ? 'win' : 'lose'),
    `结局应按整轮盈亏判定（实际 ${fin.outcome}）`);
  ok(typeof fin.reason === 'string' && fin.reason.includes('连闯 3 关'),
    `结算文案应写明连闯关数（实际 ${fin.reason}）`);

  // ★ 必须关掉"还能继续"的两个开关，否则结算页还会摆出"进入下一关"
  ok(bus.runMode === false, '★ 退市结算后 runMode 必须关闭');
  ok(bus.canContinue() === false, '★ 退市结算后 canContinue() 应为 false');
  ok(bus.startNextLevel() === false, '★ 退市结算后 startNextLevel() 应拒绝执行');
}

{
  // 没有战绩时不应造出假的结算单
  fresh();
  ok(bus.finalSettle() === null, '★ 无战绩时 finalSettle 应返回 null');
  ok(bus.canContinue() === false, '无结算结果时 canContinue() 应为 false');
}

// ---------- 汇总 ----------
console.log('\n=== 结果 ===');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
} else {
  console.log('连闯流程与跨关不重复诊断通过 ✓');
}
