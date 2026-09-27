/**
 * 回合流转跟踪测试
 *
 * 目的：确定性验证一整局严格走过 12 个回合，
 * 且每个回合都完整执行「新闻 → 决策 → 结算 → 评级」四步。
 *
 * 运行：
 *   node --experimental-loader ./tools/register.mjs tools/turntrace.mjs
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- 最小 wx 打桩（本测试不渲染，只需 DataBus 能跑）----
globalThis.wx = {
  createCanvas: () => ({ width: 375, height: 667, getContext: () => ({ scale() {} }) }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 3 }),
  onTouchStart() {},
};

const { default: DataBus } = await import('../js/core/databus.js');
const { default: Simulator } = await import('../js/market/simulator.js');
const { LOT_SIZE, maxLots, costToBuy } = await import('../js/market/order.js');

const bus = new DataBus();

console.log('=== 回合流转跟踪 ===\n');

const ok = bus.start('lv_01');
if (!ok) {
  console.error('开局失败:', bus.errors);
  process.exit(1);
}

console.log(`关卡: ${bus.level.title}`);
console.log(`本金: ¥${bus.level.initCash}  （${bus.level.turns} 回合 · 无通关目标，到期结算）\n`);

const rows = [];
const seenTurns = new Set();
const seenNews = new Set();
let step = 0;

// 与主循环同构：先推进到下一回合 → 决策 → 结算 → 评级 → 判定
// 关键点：判定必须在"结算之后"，而不是在"推进之前"，
// 否则最后一个回合会只推进不结算，导致少记一个月。
while (bus.phase !== 'OVER' && step++ < 500) {
  // --- ① 进入新回合 ---
  bus.nextTurn();
  bus.phase = 'NEWS';
  seenTurns.add(bus.turn);
  if (bus.news) seenNews.add(bus.news.id);

  const newsId = bus.news ? bus.news.id : '(none)';
  const truth = bus.news ? (bus.news.truth ? '真' : '假') : '-';
  // 第二版：新闻按 sector 匹配（不再是股票代码 target）
  const sector = bus.news ? (bus.news.sector || '-') : '-';

  // --- ② 玩家决策：轻仓策略，每回合买 1 手最便宜的 ---
  let bought = 0;
  const cheapest = bus.stockDefs
    .map((d) => ({ code: d.code, price: bus.priceMap[d.code] }))
    .sort((a, b) => a.price - b.price)[0];

  if (cheapest) {
    const lots = maxLots(cheapest.price, bus.portfolio.cash);
    if (lots >= 1) {
      const n = 1 * LOT_SIZE;
      const r = bus.portfolio.buy(cheapest.code, cheapest.price, n);
      bought = n;
      bus.records.push({ turn: bus.turn, code: cheapest.code, action: 'buy', shares: n, fee: r.fee });
    }
  }

  // --- ③ 价格结算 ---
  bus.settle();
  bus.phase = 'TRADING';

  // --- ④ 机构评级 ---
  bus.generateRatings();

  const prices = bus.stockDefs
    .map((d) => `${d.name} ¥${bus.priceMap[d.code].toFixed(1)}`)
    .join('  ');

  rows.push({
    turn: bus.turn,
    newsId,
    truth,
    sector,
    bought,
    prices,
    cash: bus.portfolio.cash,
    total: bus.portfolio.totalAssets(bus.priceMap),
    ratings: bus.ratings.map((r) => r.rating.label).join('/'),
  });

  // --- ⑤ 判定（与 main.js 同序：到期优先，非末回合才判破产）---
  // 破产口径 = 总资产（现金 + 持仓市值）< 最低一手成本
  if (bus.isTermOver()) {
    bus.settleTerm(); // 内部先强制平仓，再用纯现金判 win/lose
    break;
  }
  if (bus.isBankrupt()) {
    bus.finish('bankrupt', `总资产 ¥${bus.portfolio.totalAssets(bus.priceMap).toFixed(0)} 低于一手成本 ¥${bus.bankruptLine().toFixed(0)}`);
    break;
  }
}

// ================= 输出 =================
console.log('月份  新闻      真假 板块      买入  行情                                  现金     总资产  评级');
console.log('─'.repeat(118));
for (const r of rows) {
  console.log(
    String(r.turn).padStart(3) + '   ' +
    r.newsId.padEnd(8) + ' ' + r.truth + '   ' +
    r.sector.padEnd(9) + ' ' +
    String(r.bought).padStart(4) + '  ' +
    r.prices.padEnd(46) +
    ('¥' + r.cash.toFixed(0)).padStart(9) +
    ('¥' + r.total.toFixed(0)).padStart(9) + '  ' +
    r.ratings,
  );
}

// ================= 断言 =================
const fails = [];
const passes = [];
function chk(desc, cond, extra) {
  if (cond) passes.push(desc);
  else fails.push(desc + (extra ? ' -> ' + extra : ''));
}

const roundsPlayed = rows.length;
const endedEarly = bus.result.outcome === 'bankrupt';

chk('每回合编号连续无跳号',
  [...seenTurns].sort((a, b) => a - b).every((t, i) => t === i + 1),
  'seen=' + [...seenTurns].sort((a, b) => a - b).join(','));
chk('回合数 = 实际结算次数',
  new Set(rows.map((r) => r.turn)).size === rows.length,
  'rows=' + rows.length + ' distinct=' + new Set(rows.map((r) => r.turn)).size);
chk(
  endedEarly
    ? `提前破产时回合数正确（${roundsPlayed} < 12）`
    : '完整走过 12 个回合',
  endedEarly ? roundsPlayed < 12 : roundsPlayed === 12,
  '回合=' + roundsPlayed + ' 结局=' + bus.result.outcome,
);
chk('每回合都有新闻', rows.every((r) => r.newsId !== '(none)'));
chk('每回合都生成了评级', rows.every((r) => r.ratings.length > 0));
chk('机构评级恰好覆盖三只股票', rows.every((r) => r.ratings.split('/').length === 3),
  rows.map((r) => r.ratings.split('/').length).join(','));
chk('新闻不重复', seenNews.size === rows.length, 'distinct=' + seenNews.size + ' rows=' + rows.length);
chk('结局明确', ['win', 'lose', 'bankrupt'].includes(bus.result.outcome), bus.result.outcome);
chk('破产判定成立时现金确实低于一手成本',
  bus.result.outcome !== 'bankrupt' || bus.portfolio.cash < bus.simulator.lowestPrice() * 100);
chk('到期结局与盈亏方向一致',
  bus.result.outcome === 'bankrupt' ||
    (bus.result.outcome === 'win') === (bus.result.profit > 0),
  'outcome=' + bus.result.outcome + ' profit=' + bus.result.profit.toFixed(2));

// 假消息比例
const fakeCount = rows.filter((r) => r.truth === '假').length;
console.log(`\n  假消息出现 ${fakeCount} 次 / 12 回合`);

console.log('\n=== 结果 ===');
console.log(`通过 ${passes.length} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('\n失败项:');
  fails.forEach((f) => console.log('  FAIL ' + f));
  process.exit(1);
}
console.log('回合流转验证通过 ✓');
console.log(`\n结局: ${bus.result.outcome}  —  ${bus.result.reason}`);
console.log(`最终资产 ¥${bus.result.total.toFixed(0)}  (${bus.result.returnRate >= 0 ? '+' : ''}${(bus.result.returnRate * 100).toFixed(1)}%)`);
