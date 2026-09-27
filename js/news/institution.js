/**
 * 机构评级生成
 *
 * 每回合对三只股票各出一档评级，5 档：
 *   强烈看多 / 看多 / 中性 / 看空 / 强烈看空
 *
 * 计算（三因子加权，保持简单）：
 *   score = 走势因子 × 0.5 + 新闻因子 × 0.3 + 随机噪声 × 0.2
 *
 * ⚠️ 假消息不点破：新闻为假时，新闻因子取其反方向，
 *    使评级与新闻方向轻微背离 —— 老手能嗅出不协调。
 *
 * ⚠️ 新闻按 sector 匹配（第二版）：
 *    - 命中该股行业 → 正常参与
 *    - 不命中（船运利好 vs 陆运股）→ 不计入，只给微弱噪声
 *    - 利好但承压（pressured）→ 按**负向**计入（评级会背离新闻）
 */

import { random } from '../core/random';
import { STOCK } from '../styles/palette';

// 评级档位（顺序：从最高到最低）
export const RATINGS = [
  { key: 'strong_buy', label: '强烈看多', arrow: '↑', color: STOCK.upDark, min: 0.5 },
  { key: 'buy', label: '看多', arrow: '↑', color: STOCK.up, min: 0.15 },
  { key: 'hold', label: '中性', arrow: '—', color: STOCK.flat, min: -0.15 },
  { key: 'sell', label: '看空', arrow: '↓', color: STOCK.down, min: -0.5 },
  { key: 'strong_sell', label: '强烈看空', arrow: '↓', color: STOCK.downDark, min: -Infinity },
];

const WEIGHT_TREND = 0.5;
const WEIGHT_NEWS = 0.3;
const WEIGHT_NOISE = 0.2;

/**
 * 把 score 映射为评级档位
 */
export function ratingOf(score) {
  return RATINGS.find((r) => score > r.min) || RATINGS[RATINGS.length - 1];
}

export default class Institution {
  constructor() {
    // 记录最近的评级，避免三只股永远同步
    this.lastScores = {};
  }

  /**
   * 计算某只股票本回合的评级
   *
   * @param {object} stock 股票定义
   * @param {number} change 本回合涨跌幅（%）
   * @param {object|null} news 本回合新闻
   * @returns {object} { code, score, rating }
   */
  rate(stock, change, news) {
    // ---- 走势因子：涨跌幅归一到 -1 ~ +1（±5% 视为极值）----
    const trend = Math.max(-1, Math.min(1, change / 5));

    // ---- 新闻因子 ----
    // 第二版：按 sector 判定"是否与这只股票相关"
    let newsFactor = 0;
    if (news && news.sector && news.impact) {
      const matched = news.sector === 'macro' || news.sector === stock.sector;

      if (!matched) {
        // ★ 错配（船运利好 vs 陆运股）：消息面与本股无关，
        //   评级只给一点随机扰动，不体现消息方向
        newsFactor = (random() - 0.5) * 0.1;
      } else {
        const raw = Math.max(-1, Math.min(1, news.impact.drift / 5));
        if (news.kind === 'pressured') {
          // ★ 利好但业绩承压：消息面是利好，评级却应偏空
          newsFactor = -Math.abs(raw) * 0.8;
        } else if (news.sector === 'macro') {
          // 大盘消息：轻微影响
          newsFactor = (news.truth ? raw : -raw) * 0.5;
        } else {
          // 关键：假消息取反 —— 不点破，只让方向背离
          newsFactor = news.truth ? raw : -raw;
        }
      }
    }

    // ---- 随机噪声 ----
    const noise = random() * 2 - 1;

    const score =
      trend * WEIGHT_TREND + newsFactor * WEIGHT_NEWS + noise * WEIGHT_NOISE;

    const rating = ratingOf(score);
    this.lastScores[stock.code] = score;

    return { code: stock.code, score, rating };
  }

  /**
   * 一次给出三只股票的评级
   * @param {Array} stocks 股票定义数组
   * @param {object} changeMap { code: change }
   * @param {object|null} news 本回合新闻
   * @returns {Array} [{ code, name, score, rating }]
   */
  rateAll(stocks, changeMap, news) {
    return stocks.map((s) => {
      const change = changeMap[s.code] || 0;
      const r = this.rate(s, change, news);
      return { ...r, name: s.name, industry: s.industry };
    });
  }
}
