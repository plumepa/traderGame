/**
 * 关卡定义（第三版 —— 五关制 / 隐藏年景）
 *
 * 为什么是 .js 而不是 .json？
 * 微信小游戏的打包器不支持 import JSON —— 它会把路径当模块名
 * 自动补 .js 后缀，去找 "xxx.json.js" 从而报错。
 * 因此数据一律以 .js 模块形式导出。
 *
 * ============ 与旧版的关键区别 ============
 *
 * 旧版：关卡里写死 stocks 与 newsDeck，还挂着 title: '1996 · 全民炒股'。
 * 第二版：关卡只决定市场风格与叙事，股票/新闻每局随机抽。
 * 第三版（本版）：**不再告诉玩家这是哪一年、哪种市场。**
 *
 * 为什么隐藏年景？
 *   ① 一旦标出"1996 全民炒股"，玩家就不用看盘了 —— 直接背答案。
 *      本作的核心乐趣是「从价格与新闻里自己判断市场性质」，
 *      所以年份只能是**内部编号**，不是给玩家看的标签。
 *   ② 顺便避免与真实历史行情挂钩带来的麻烦。
 *
 * 于是：
 *   title   → 只留「第 N 关」，不含年份/主题
 *   theme   → **已删除**（菜单页不再渲染风格标签）
 *   style   → 保留，但它是**内部分类**，只用于从年景池里抽卡，
 *             不写进任何面向玩家的文案
 *   pool    → 本关允许抽取的年景风格集合（数组）。
 *             有多个时随机取一种 → 同一关重玩也是不同年景。
 *             null 表示「六种风格全放开」（终局关，什么都可能遇上）。
 *
 * 难度爬升思路（不靠数值加码，靠"市场的可读性逐关变差"）：
 *   第 1 关：单一温和风格，最容易被读懂 —— 让玩家先学会看盘。
 *   第 2 关：反向风格，学会识别下跌。
 *   第 3 关：真正的中性震荡 —— 没有趋势可依赖。
 *   第 4 关：三种风格混合 —— 同一关里风格也是随机的。
 *   第 5 关：全放开，什么都可能遇上 —— 纯靠功力。
 *
 * 字段说明：
 *   id        关卡 id
 *   index     显示序号（1..5），菜单/结算页展示「第 N 关」
 *   title     面向玩家的标题（不含年份、不含市场风格）
 *   intro     开场白，只写氛围，绝不点破年景
 *   style     兼容字段 = pool[0]（旧代码/composeGame 的 style 兜底）
 *   pool      本关可抽的年景风格集合
 *   turns     回合数
 *   initCash  ★ **第 1 关**的初始资金。
 *             连闯时后续关卡的钱来自上一关期末资产（DataBus.startNextLevel
 *             把 result.total 当 initCash 传下去），这个字段**不再**代表
 *             本关的本金 —— 所以结算页显示的是 bus.initCash，不是 level.initCash。
 *   goal      目标（无硬性通关目标，到期结算）
 *
 * ⚠️ LEVELS 是**共享对象数组**，任何关卡代码都不得改写 level.initCash
 *   （曾经有版本把连闯资金写回 level.initCash，导致第 1 关的本金被永久污染，
 *    重开一轮时起始资金变成了上一轮的期末资产）。资金一律走 DataBus.initCash。
 */

export const LEVELS = [
  {
    id: 'lv_01',
    index: 1,
    title: '第 1 关 · 初入市场',
    intro:
      '营业部门口排着长队，连卖茶叶蛋的大妈都在谈论股票。\n你没做过功课，只揣着一万块钱挤进人群。\n\n没人告诉你这是什么时候，也没人告诉你接下来会怎样——\n自己看盘，自己判断。',
    style: 'smallBull',
    pool: ['smallBull', 'bull'],
    turns: 12,
    initCash: 10000,
    goal: { type: 'term', value: 0, desc: '先学会看盘：在一年的交易里尽量赚得更多' },
  },
  {
    id: 'lv_02',
    index: 2,
    title: '第 2 关 · 风向变了',
    intro:
      '同样的营业部，人却少了一半。\n论坛里还在喊"回调就是机会"，但报价牌上的绿色越来越多。\n\n有些股票，会一路跌到退市。\n分清"下跌"和"阴跌"——它们不是一回事。',
    style: 'smallBear',
    pool: ['smallBear', 'bear'],
    turns: 12,
    initCash: 10000,
    goal: { type: 'term', value: 0, desc: '在下跌中活下来，并尽量保住本金' },
  },
  {
    id: 'lv_03',
    index: 3,
    title: '第 3 关 · 原地打转',
    intro:
      '指数在原地打转，热点一天一换。\n昨天涨停的今天跌停，昨天没人要的今天成了香饽饽。\n\n没有趋势可依靠的时候，最容易亏钱的不是空仓，是手快。',
    style: 'flat',
    pool: ['flat', 'calmFlat'],
    turns: 12,
    initCash: 10000,
    goal: { type: 'term', value: 0, desc: '在没有趋势的市场里跑赢大盘' },
  },
  {
    id: 'lv_04',
    index: 4,
    title: '第 4 关 · 真假难辨',
    intro:
      '天气预报说今天有雨，出门却是大太阳。\n消息面忽冷忽热，昨天的利好今天成了利空。\n\n这一关，连"这是什么市场"都要你自己判断。\n你确定你读懂了吗？',
    style: 'flat',
    pool: ['smallBull', 'smallBear', 'flat', 'calmFlat'],
    turns: 12,
    initCash: 10000,
    goal: { type: 'term', value: 0, desc: '在风格不明的市场里做对判断' },
  },
  {
    id: 'lv_05',
    index: 5,
    title: '第 5 关 · 没有剧本',
    intro:
      '最后一关，没有提示，没有暗示，没有剧本。\n这一次，什么样的行情都可能遇上——\n上涨的、下跌的、还是原地打转的，你得自己看。\n\n你唯一能依靠的，是前四关里练出来的手感。\n祝你好运。',
    style: 'flat',
    // ⚠️ pool = null 表示「六种风格全放开」。
    //    注意此时 style 只是**兜底占位值**（当年景池被 exclude 掏空、
    //    退化到旧的"随机抽股"路径时才会用到），它**不是**对本关的风格限定。
    //    消费方（DataBus/composeGame）必须先看 pool：pool 非空则以 pool 为准，
    //    pool 为 null 时不得用 style 去缩小候选 —— 曾因此把本关压成"只能抽 flat"。
    pool: null,
    turns: 12,
    initCash: 10000,
    goal: { type: 'term', value: 0, desc: '什么都可能发生——尽力而为' },
  },
];

export const LEVEL_MAP = LEVELS.reduce((acc, l) => {
  acc[l.id] = l;
  return acc;
}, {});

/**
 * 关卡总数（UI 展示「第 N / 5 关」用）
 */
export const LEVEL_COUNT = LEVELS.length;

/**
 * 取某关的可抽风格池，供 composeGame 的 opts.styles 使用。
 *
 * 返回值语义：
 *   'all'      本关全放开（pool = null）—— **必须**显式传 'all'，
 *              不能返回 null，否则调用方会退化去用关卡那句占位的 style，
 *              把"没有剧本"变成"只有某一种风格"。
 *   string[]   只在这些风格里抽
 *
 * @param {object|string} level 关卡对象或 id
 * @returns {string[]|'all'}
 */
export function poolOfLevel(level) {
  const lv = typeof level === 'string' ? LEVEL_MAP[level] : level;
  if (!lv) return 'all';
  if (lv.pool === null) return 'all';
  if (Array.isArray(lv.pool) && lv.pool.length) return lv.pool.slice();
  return lv.style ? [lv.style] : 'all';
}

export default LEVELS;
