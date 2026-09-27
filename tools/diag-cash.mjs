/**
 * 诊断：破产判定 & 现金负数（修复后验证）
 *
 * 验证三件事：
 *   1. 正常买入不会被误判破产（总资产口径）
 *   2. 真正亏光时能正确判破产
 *   3. 年底强制平仓生效，最终资产 = 纯现金
 *
 * 运行：
 *   node --experimental-loader ./tools/register.mjs tools/diag-cash.mjs
 */

globalThis.wx = {
  createCanvas: () => ({ width: 375, height: 667, getContext: () => ({ scale() {} }) }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 3 }),
  onTouchStart() {},
};

const { default: DataBus } = await import('../js/core/databus.js');
const { LOT_SIZE, maxLots } = await import('../js/market/order.js');

let fails = 0;
function chk(desc, cond, extra) {
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + '  ' + desc + (extra ? '   (' + extra + ')' : ''));
  if (!cond) fails++;
}

// =================================================================
console.log('=== 1. 买入后不再误判破产（总资产口径）===\n');

{
  const bus = new DataBus();
  bus.start('lv_01');
  bus.nextTurn();

  const cheapest = bus.stockDefs
    .map((d) => ({ code: d.code, price: bus.priceMap[d.code] }))
    .sort((a, b) => a.price - b.price)[0];

  const lots = maxLots(cheapest.price, bus.portfolio.cash);
  bus.portfolio.buy(cheapest.code, cheapest.price, lots * LOT_SIZE);

  const cash = bus.portfolio.cash;
  const total = bus.portfolio.totalAssets(bus.priceMap);
  const line = bus.bankruptLine();

  console.log(`  梭哈 ${lots} 手 @¥${cheapest.price}`);
  console.log(`    现金 ¥${cash.toFixed(0)}  总资产 ¥${total.toFixed(0)}  破产线 ¥${line.toFixed(0)}`);
  console.log(`    isBankrupt() = ${bus.isBankrupt()}  ← 满仓不应破产`);

  chk('满仓后现金低于破产线', cash < line, `现金 ¥${cash.toFixed(0)} < ¥${line.toFixed(0)}`);
  chk('满仓后总资产仍高于破产线', total > line, `总资产 ¥${total.toFixed(0)}`);
  chk('满仓后不被判破产', !bus.isBankrupt());
  chk('现金从不为负', cash >= 0, `现金 ¥${cash.toFixed(1)}`);
}

// =================================================================
console.log('\n=== 2. 真亏光时能正确判破产 ===\n');

{
  const bus = new DataBus();
  bus.start('lv_01');
  bus.nextTurn();

  // 人为把总资产压到破产线以下
  bus.portfolio.cash = 10;
  bus.portfolio.positions = {};

  const total = bus.portfolio.totalAssets(bus.priceMap);
  const line = bus.bankruptLine();

  console.log(`  现金 ¥${total.toFixed(0)}  破产线 ¥${line.toFixed(0)}`);
  chk('总资产低于破产线时判破产', bus.isBankrupt());
}

// =================================================================
console.log('\n=== 3. 年底强制平仓 ===\n');

{
  const bus = new DataBus();
  bus.start('lv_01');

  // 每回合末结算，最后一回合触发强制平仓
  let guard = 0;
  while (bus.phase !== 'OVER' && guard++ < 20) {
    bus.nextTurn();
    bus.settle();
    if (bus.isTermOver()) {
      bus.settleTerm();
      break;
    }
    if (bus.isBankrupt()) { bus.finish('bankrupt', 'b'); break; }
  }

  const res = bus.result;
  const leftover = bus.portfolio.hasPositions();

  console.log(`  结局: ${res.outcome}`);
  console.log(`  最终现金 ¥${bus.portfolio.cash.toFixed(0)}  总资产 ¥${res.total.toFixed(0)}`);
  console.log(`  平仓明细: ${res.liquidation ? res.liquidation.details.length + ' 只' : '无（空仓）'}`);

  chk('到期结局为 win 或 lose（非破产）', ['win', 'lose'].includes(res.outcome), res.outcome);
  chk('最终无残留持仓', !leftover, 'hasPositions=' + leftover);
  chk('最终资产 = 纯现金', Math.abs(bus.portfolio.cash - res.total) < 0.01,
    `现金 ¥${bus.portfolio.cash.toFixed(2)} vs 资产 ¥${res.total.toFixed(2)}`);
  chk('reason 文案含平仓说明', /平仓|空仓/.test(res.reason), res.reason.slice(0, 40) + '…');
}

// =================================================================
console.log('\n=== 4. 持有股票时到期（验证平仓真的执行）===\n');

{
  const bus = new DataBus();
  bus.start('lv_01');

  // 第 1 回合买一手，然后一路持有到年底
  let guard = 0;
  let bought = false;
  while (bus.phase !== 'OVER' && guard++ < 20) {
    bus.nextTurn();

    if (!bought) {
      const c = bus.stockDefs
        .map((d) => ({ code: d.code, price: bus.priceMap[d.code] }))
        .sort((a, b) => a.price - b.price)[0];
      if (maxLots(c.price, bus.portfolio.cash) >= 1) {
        bus.portfolio.buy(c.code, c.price, LOT_SIZE);
        bought = true;
      }
    }

    bus.settle();
    if (bus.isTermOver()) { bus.settleTerm(); break; }
    if (bus.isBankrupt()) { bus.finish('bankrupt', 'b'); break; }
  }

  const res = bus.result;
  const liq = res.liquidation;

  console.log(`  结局: ${res.outcome}  买过=${bought}`);
  console.log(`  平仓: ${liq ? liq.details.map((d) => `${d.code}×${d.shares}股`).join(', ') : '无'}`);
  console.log(`  平仓手续费 ¥${liq ? liq.totalFee.toFixed(1) : '0'}`);

  chk('持有过股票', bought);
  chk('到期时执行了平仓', !!liq && liq.details.length > 0);
  chk('平仓后无持仓', !bus.portfolio.hasPositions());
  chk('平仓损益已计入总资产',
    !!liq && Math.abs(res.total - (res.init + res.profit)) < 0.01);
}

console.log('\n=== 结果 ===');
console.log(fails ? `失败 ${fails} 项` : '全部通过 ✓');
process.exit(fails ? 1 : 0);
