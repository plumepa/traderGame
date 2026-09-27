/**
 * 交易撮合与手续费
 *
 * 规则（遵循 A 股）：
 *   - 最小交易单位 1 手 = 100 股，买入必须是 100 的整数倍
 *   - 卖出可零股（清仓场景允许不足 100 股）
 *   - 买入：佣金 万三，最低 5 元
 *   - 卖出：佣金 万三 + **印花税 千一（0.1%，单边）**，最低 5 元佣金
 *
 * ============ 为什么卖出要多收印花税 ============
 *
 * 起初两边都是万三、最低 5 元。结果 balance 测试发现：
 * **"每月追最贵那只"的换手策略几乎不输给"满仓持有"**（差距 < 1%，
 * 且哪边赢完全看随机数——跑 6 次，换手赢 3 次）。
 *
 * 原因：满仓 ¥10,000 的一次全换手，成本只有 6 + 6 = ¥12，约 0.12%。
 * 一年 12 次也才 1.4%，远低于追高带来的收益波动。**惩罚形同虚设。**
 *
 * 加入千一印花税（真实 A 股规则）后，单次全换手 ≈ 0.16%，一年 ≈ 2%，
 * 与"追高的负期望"叠加，才能稳定地把换手策略压在买入持有之下 ——
 * 也让"频繁交易是有代价的"这一课真正成立。
 */
export const LOT_SIZE = 100; // 一手 100 股
export const FEE_RATE = 0.0003; // 佣金 万三
export const FEE_MIN = 5; // 最低 5 元
export const STAMP_TAX_RATE = 0.001; // 印花税 千一（仅卖出）

/**
 * 计算手续费
 * @param {number} amount 成交金额
 * @param {'buy'|'sell'} [side='buy'] 买卖方向（卖出含印花税）
 * @returns {number} 手续费
 */
export function calcFee(amount, side = 'buy') {
  if (amount <= 0) return 0;
  const commission = Math.max(amount * FEE_RATE, FEE_MIN);
  return side === 'sell' ? commission + amount * STAMP_TAX_RATE : commission;
}

/**
 * 计算买入某数量所需的现金（含手续费）
 */
export function costToBuy(price, shares) {
  const amount = price * shares;
  return amount + calcFee(amount, 'buy');
}

/**
 * 计算卖出某数量能得到的现金（扣手续费 + 印花税）
 */
export function proceedsFromSell(price, shares) {
  const amount = price * shares;
  return amount - calcFee(amount, 'sell');
}

/**
 * 校验买入请求
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateBuy(price, shares, cash) {
  if (!Number.isInteger(shares) || shares <= 0) {
    return { ok: false, reason: '请输入股数' };
  }
  if (shares % LOT_SIZE !== 0) {
    return { ok: false, reason: `买入须为 ${LOT_SIZE} 股整数倍` };
  }
  const need = costToBuy(price, shares);
  if (need > cash) {
    return { ok: false, reason: '资金不足' };
  }
  return { ok: true };
}

/**
 * 校验卖出请求
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateSell(shares, holding) {
  if (!Number.isInteger(shares) || shares <= 0) {
    return { ok: false, reason: '请输入股数' };
  }
  if (shares > holding) {
    return { ok: false, reason: '持仓不足' };
  }
  return { ok: true };
}

/**
 * 计算给定现金最多能买几手
 * @returns {number} 手数（可能为 0）
 */
export function maxLots(price, cash) {
  if (price <= 0) return 0;
  // 逐手试算，避免手续费带来的边界误差
  let lots = Math.floor(cash / (price * LOT_SIZE));
  while (lots > 0 && costToBuy(price, lots * LOT_SIZE) > cash) {
    lots -= 1;
  }
  return lots;
}
