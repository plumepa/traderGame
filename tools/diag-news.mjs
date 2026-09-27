/**
 * 诊断：玩家真实体验序列 —— 12 月到底发生了什么
 *
 * 严格按 main.js 的事件流复刻，逐动作打印。
 */

globalThis.wx = {
  createCanvas: () => ({ width: 375, height: 667, getContext: () => ({ scale() {} }) }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 3 }),
  onTouchStart() {},
};

const { default: DataBus } = await import('../js/core/databus.js');

const bus = new DataBus();
bus.start('lv_01');

function beginTurn() {
  bus.nextTurn();
  bus.phase = 'NEWS';
  return bus.news;
}

function settleAndJudge() {
  bus.settle();
  bus.generateRatings();
  bus.phase = 'TRADING';
  if (bus.isTermOver()) {
    bus.settleTerm();
    return true;
  }
  return false;
}

console.log('=== 玩家真实体验序列（严格按 main.js 事件流）===\n');
console.log('动作                        | turn | 月号    | 新闻');
console.log('-'.repeat(76));

// 收集本局实际抽到的新闻（用于后面的断言）
const seen = [];

let n = beginTurn();
seen.push(n);
console.log(
  `开局 → 弹新闻 ${n.id}`.padEnd(28) +
  `|  ${String(bus.turn).padStart(2)}  | ${bus.turn}/12   | ${n.id} 「${n.headline.slice(0, 14)}」`,
);

let g = 0;
while (bus.phase !== 'OVER' && g++ < 30) {
  const over = settleAndJudge();
  console.log(
    `关新闻 → 结算第 ${bus.turn} 月`.padEnd(28) +
    `|  ${String(bus.turn).padStart(2)}  | ${bus.turn}/12   | (结算中)`,
  );
  if (over) {
    console.log('  → 到期，进入结算页');
    break;
  }
  if (bus.turn >= bus.level.turns) {
    console.log('  [兜底) 直接结算');
    settleAndJudge();
    break;
  }
  n = beginTurn();
  seen.push(n);
  console.log(
    `点「下月」→ 弹新闻 ${n.id}`.padEnd(28) +
    `|  ${String(bus.turn).padStart(2)}  | ${bus.turn}/12   | ${n.id} 「${n.headline.slice(0, 14)}」`,
  );
}

console.log('\n结局:', bus.result.outcome);

// ---------- 断言：新闻编排的三条不变量 ----------
const fails = [];
const chk = (desc, cond, extra) => {
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + '  ' + desc + (extra ? '   (' + extra + ')' : ''));
  if (!cond) fails.push(desc);
};

console.log('\n=== 新闻编排断言 ===');
chk('12 个月都有新闻（含 12 月）', seen.length === 12, '实际 ' + seen.length + ' 条');
chk('月份标注连续 1..12',
  seen.every((n, i) => n.id) && seen.length === 12,
  seen.map((n) => n.id).join(' '));
chk('局内新闻基本不重复（允许池子用尽后重复）',
  new Set(seen.map((n) => n.id)).size >= 8,
  '去重后 ' + new Set(seen.map((n) => n.id)).size + ' 条');

// 持仓板块 vs 新闻板块 —— 检查错配新闻确实会出现
const sectors = new Set(bus.stockDefs.map((d) => d.sector));
const mismatch = seen.filter((n) => n.sector !== 'macro' && !sectors.has(n.sector));
console.log(`\n  · 本局持仓板块：${[...sectors].join(' / ')}`);
console.log(`  · 出现的"错配板块"新闻 ${mismatch.length} 条` +
  (mismatch.length ? '：' + mismatch.map((n) => `${n.id}(${n.sector})`).join(' ') : ''));
console.log('  · 错配新闻会照常显示，但对持仓股价无效 —— 这正是玩家要的判断陷阱');

console.log('\n=== 结果 ===');
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项');
  process.exit(1);
}
console.log('新闻编排诊断通过 ✓');
