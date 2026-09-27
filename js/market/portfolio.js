/**
 * 持仓与盈亏
 */

import { calcFee } from './order';

export default class Portfolio {
  constructor(cash = 0) {
    this.cash = cash;
    // code -> { shares, costAmount }  costAmount = 累计买入成本（含手续费）
    this.positions = {};
  }

  /**
   * 买入 —— 更新现金与持仓
   * @returns {object} { amount, fee, shares, price }
   */
  buy(code, price, shares) {
    const amount = price * shares;
    const fee = calcFee(amount, 'buy');
    this.cash -= amount + fee;

    const pos = this.positions[code] || { shares: 0, costAmount: 0 };
    pos.shares += shares;
    pos.costAmount += amount + fee;
    this.positions[code] = pos;

    return { amount, fee, shares, price };
  }

  /**
   * 卖出 —— 更新现金与持仓（按比例扣减成本）
   * @returns {object} { amount, fee, shares, price, profit }
   */
  sell(code, price, shares) {
    const pos = this.positions[code];
    if (!pos || pos.shares < shares) {
      throw new Error(`[portfolio] 持仓不足: ${code}`);
    }

    const amount = price * shares;
    const fee = calcFee(amount, 'sell');
    const net = amount - fee;
    this.cash += net;

    // 按卖出比例结转成本，剩余成本保留
    const costOut = pos.shares > 0 ? (pos.costAmount * shares) / pos.shares : 0;
    const profit = net - costOut;

    pos.shares -= shares;
    pos.costAmount -= costOut;
    if (pos.shares === 0) {
      pos.costAmount = 0;
    }

    return { amount, fee, shares, price, profit };
  }

  /**
   * 取某只股票持仓股数
   */
  sharesOf(code) {
    return this.positions[code] ? this.positions[code].shares : 0;
  }

  /**
   * 取某只股票的平均成本价
   */
  avgCostOf(code) {
    const pos = this.positions[code];
    if (!pos || pos.shares === 0) return 0;
    return pos.costAmount / pos.shares;
  }

  /**
   * 计算持仓总市值
   * @param {object} priceMap { code: price }
   */
  marketValue(priceMap) {
    return Object.keys(this.positions).reduce((sum, code) => {
      const shares = this.positions[code].shares;
      const price = priceMap[code] || 0;
      return sum + shares * price;
    }, 0);
  }

  /**
   * 总资产 = 现金 + 持仓市值
   */
  totalAssets(priceMap) {
    return this.cash + this.marketValue(priceMap);
  }

  /**
   * 浮盈（持仓部分的账面盈亏）
   */
  unrealizedProfit(priceMap) {
    return Object.keys(this.positions).reduce((sum, code) => {
      const pos = this.positions[code];
      if (pos.shares === 0) return sum;
      return sum + (priceMap[code] || 0) * pos.shares - pos.costAmount;
    }, 0);
  }

  /**
   * 单只股票强制清算（退市爆雷）
   *
   * 与 liquidateAll 的区别：只清一只，且返回明细供 UI 提示。
   * 退市是**被迫**的，按退市价成交（通常远低于成本），
   * 玩家只能接受这笔亏损 —— 这是熊市关卡的核心风险。
   *
   * @param {string} code 股票代码
   * @param {number} price 退市清算价
   * @returns {object|null} { code, shares, price, amount, fee, profit }；
   *                        无持仓时返回 null
   */
  liquidateCode(code, price) {
    const pos = this.positions[code];
    if (!pos || pos.shares <= 0) return null;

    const shares = pos.shares;
    const r = this.sell(code, price, shares);
    return {
      code,
      shares,
      price,
      amount: r.amount,
      fee: r.fee,
      profit: r.profit,
    };
  }

  /**
   * 全部持仓按市价卖出（年底强制平仓）
   *
   * 持仓是"账面富贵"，不卖出就只是数字。年底结算前强制清仓，
   * 让最终资产变成实打实的现金，杜绝"死扛不卖躺过终点"。
   *
   * @param {object} priceMap { code: price }
   * @returns {{ totalAmount: number, totalFee: number, totalProfit: number, details: Array }}
   */
  liquidateAll(priceMap) {
    const details = [];
    let totalAmount = 0;
    let totalFee = 0;
    let totalProfit = 0;

    // 先收集再执行 —— 避免在遍历中改动 this.positions
    const codes = Object.keys(this.positions).filter(
      (code) => this.positions[code].shares > 0,
    );

    codes.forEach((code) => {
      const shares = this.positions[code].shares;
      const price = priceMap[code] || 0;
      const r = this.sell(code, price, shares);
      totalAmount += r.amount;
      totalFee += r.fee;
      totalProfit += r.profit;
      details.push({
        code,
        shares,
        price,
        amount: r.amount,
        fee: r.fee,
        profit: r.profit,
      });
    });

    return { totalAmount, totalFee, totalProfit, details };
  }

  /**
   * 是否还持有任何股票
   */
  hasPositions() {
    return Object.keys(this.positions).some((code) => this.positions[code].shares > 0);
  }
}
