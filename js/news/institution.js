/**
 * 机构评级生成
 *
 * 每回合对三只股票各出一档评级，5 档：
 *   强烈看多 / 看多 / 中性 / 看空 / 强烈看空
 *
 * ============ 第四版：走势因子改用「相对强弱」 ============
 *
 * 【问题】旧版走势因子取的是**本股绝对涨跌幅**，而涨跌幅里大部分是**大盘**成分。
 *   于是评级退化成了「大盘方向指示器」：实测大盘暴涨月里"看多档"下月上涨比例 97.8%、
 *   "看空档"只有 0.8%；大盘暴跌月里"看多档"跌到 25.2%。
 *   合并所有风格算 IC = 0.307 —— 玩家照着评级做就能显著跑赢，
 *   更糟的是它**泄漏了本该隐藏的市场风格**（关卡设计明令"不告诉玩家年份与风格"）。
 *
 * 【修法】走势因子改成**相对强弱**：本股涨跌幅 − 同回合三只股票的均值。
 *   均值就是玩家能自己算出来的"大盘代理"。减掉之后评级与大盘方向脱钩，
 *   只剩"这只股比另外两只强/弱"的横截面信息 —— 这才是"选股建议"该有的样子。
 *   实测：合并 IC 由 0.307 降到 0.036，看多档命中率由 65.7% 降到 50.3%，
 *   大盘暴涨月的看多命中率由 97.8% 回到 ~50%（相对基准的超额只剩 +3.0pp）。
 *
 * 【为什么噪声要占大头】
 *   评级的设计定位是「玩家的镜子 —— 把冰冷的价格变化翻译成有人味的评判」，
 *   不是能照着抄的信号。所以刻意让噪声占到六成：
 *   机构**经常看走眼**，玩家必须自己判断。这是玩法，不是缺陷。
 *
 * ⚠️ 假消息不点破：新闻为假时，新闻因子取其反方向，
 *    使评级与新闻方向轻微背离 —— 老手能嗅出不协调。
 *
 * ⚠️ 新闻按 sector 匹配（第二版）：
 *    - 命中该股行业 → 正常参与
 *    - 不命中（船运利好 vs 陆运股）→ 不计入，只给微弱噪声
 *    - 利好但承压（pressured）→ 机构**跟着标题看多**，随后业绩暴雷
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

// ============ 权重怎么定的 ============
//
// 【★ 先说判据：不要用「跟评级 − 等权」衡量评级准不准】
//   市场本身有动量溢价。实测「每月全仓本月涨最多的那只」这条**玩家自己就能跑**
//   （行情面板上就写着本月涨跌，见 trading.js 股票卡片的 changeMap）的策略，
//   月均收益比等权高 +0.557%。
//   而「每月全仓评级最高的那只」是 +0.514% —— 两个数几乎一样。
//   真正的判据是「跟评级 − 跟动量」= 评级的**独占**价值，实测 −0.043%，
//   也就是**评级没有给玩家任何额外信息**。这才是"评级不准"的正确定义。
//   （诊断脚本 tools/diag-rating.mjs 的 [4] 段落会把三个基线并排列出。）
//
// 【走势因子为什么是"相对强弱"，以及它必然导致"评级像复述行情"】
//   走势因子取 `change - marketChange`，而 marketChange 是三只股票的**均值** ——
//   给三只股票减同一个常数**不改变它们的排序**。所以评级的排序天然等于
//   "本月涨幅排序"，实测排序一致率 70.9%（100% = 完全复述）。
//   这是**刻意接受**的代价：不这么做，评级就退回成"大盘方向指示器"（旧版 IC=0.307、
//   大盘暴涨月看多命中率 97.8%），会泄漏本该隐藏的市场风格。
//   宁可让评级"只是在复述公开行情"，也不能让它当预言机。
//
// 【新闻权重为什么是 0.10】
//   接通 `applyNews` 之后新闻会真的推动价格（且持续 2 个月），而评级会读新闻 ——
//   于是评级重新变得"能预测"：新闻权重 0.14 时 IC 0.047、档位极差 2.78%；
//   压到 0.10 时 IC 0.036、极差 2.07%。新闻权重必须压住，
//   否则等于绕个弯把"照抄信号"又送回来了。
//
// 【为什么又不能压到 0】
//   本作的**核心爽点**是"假消息不点破"：新闻说重大利好，机构却只给中性，
//   老手能从这丝不协调里嗅出假消息。新闻权重为 0 的话，
//   评级与新闻永远不会背离，这个爽点就没了。
//   0.10 是实测的平衡点 —— 强消息（|raw|≈1）能推动 ±0.10，
//   刚好够把边界上的评级推过一档（档宽 0.15~0.35），又不足以让玩家直接照抄。
//
// 【为什么噪声占最大头（0.60）】
//   评级的定位是「玩家的镜子 —— 把冰冷的价格变化翻译成有人味的评判」，
//   不是能照着抄的信号。机构**经常看走眼**，玩家必须自己判断。这是玩法，不是缺陷。
//
// 【为什么停在 0.60 而不再往上加】
//   实测继续加噪声（0.68 / 0.79）会让「看多档下月上涨比例」掉到 50% 以下
//   （49.4% / 48.9%），也就是评级从"不准"变成"反着准" ——
//   玩家会发现反着做更赚，那是另一种更糟的作弊。
//   0.60 时看多 50.3% / 看空 51.2%，是"抛硬币"的水平，且没有倒挂。
const WEIGHT_TREND = 0.30; // 相对强弱
const WEIGHT_NEWS = 0.10; // 新闻面（读得到标题，但判断不准真假）
const WEIGHT_NOISE = 0.60; // 机构也会看走眼

// 相对强弱的归一化尺度（%）：±REL_SCALE 视为极值
const REL_SCALE = 4;

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
   * @param {number} marketChange 同回合三只股票的均值涨跌幅（%），作为"大盘代理"
   * @returns {object} { code, score, rating }
   */
  rate(stock, change, news, marketChange = 0) {
    // ---- 走势因子：**相对强弱**，归一到 -1 ~ +1 ----
    //
    // ★ 一定要减掉 marketChange。用绝对涨跌幅会让评级变成"大盘方向指示器"，
    //   既让玩家白拿信息，又泄漏了本该隐藏的市场风格。详见文件头注释。
    const rel = change - marketChange;
    const trend = Math.max(-1, Math.min(1, rel / REL_SCALE));

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
          // ★ 利好但业绩承压（= 财务造假 / 增收不增利）：
          //   机构**跟着标题看多** —— 报表一片向好，它看不出利润是假的。
          //   随后股价下跌，评级被打脸。这正是"财务造假暴雷"的叙事：
          //   **评级不该提前看穿暴雷**，玩家必须自己怀疑"这么好的消息为什么跌"。
          //   （旧版这里取负号 = 机构一眼识破，等于给了玩家免费预警，已改掉。）
          newsFactor = Math.abs(raw) * 0.9;
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

    // ★ 把三个因子原样带出去。
    //   为什么必须暴露：早先测试只能断言"总分接近中性"，而总分里混着噪声 ——
    //   一旦调高噪声权重，那条断言就误报（噪声把总分推离中性）。
    //   把因子拆开之后，测试可以直接断言"新闻因子是否体现了消息方向"，
    //   与噪声权重解耦，调参不会再误伤测试。
    return {
      code: stock.code,
      score,
      rating,
      parts: { trend, news: newsFactor, noise, marketChange },
    };
  }

  /**
   * 一次给出三只股票的评级
   * @param {Array} stocks 股票定义数组
   * @param {object} changeMap { code: change }
   * @param {object|null} news 本回合新闻
   * @returns {Array} [{ code, name, score, rating }]
   */
  rateAll(stocks, changeMap, news) {
    // ★ 先算"大盘代理" = 本回合三只股票的均值涨跌幅。
    //   用均值而不是某个指数，是因为玩家在界面上就能算出这个数 ——
    //   评级用的信息不该超过玩家自己能看到的东西。
    const changes = stocks.map((s) => changeMap[s.code] || 0);
    const marketChange = changes.length
      ? changes.reduce((a, b) => a + b, 0) / changes.length
      : 0;

    return stocks.map((s) => {
      const change = changeMap[s.code] || 0;
      const r = this.rate(s, change, news, marketChange);
      return { ...r, name: s.name, industry: s.industry };
    });
  }
}

export { WEIGHT_TREND, WEIGHT_NEWS, WEIGHT_NOISE, REL_SCALE };
