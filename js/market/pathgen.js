/**
 * 价格路径生成器
 *
 * 旧设计：每只股票的 12 项月度涨跌幅写死在数据文件里。
 * 新设计：股票池里只存"性格"（profile），路径由本模块生成。
 *
 * ============ 为什么要有这个模块 ============
 *
 * 需求：「每关随机选择三只股票」——既然股票每局都不同，
 * 就不能再给每只股票写死一条路径（那样要么写 15×N 条，
 * 要么路径与性格脱节）。改为：
 *
 *   月度涨跌幅 = 市场风格(牛/熊) + 个股性格 + 确定性噪声
 *
 * ============ 关键约束：确定性 ============
 *
 * 与走势图波形（wavyPath）同理，本模块**不使用 Math.random()**。
 * 同一局、同一只股票，无论重新生成多少次，路径完全一致 ——
 * 这样"退出重进来看走势图"不会变，"结算页复盘"也不会变。
 *
 * 随机性来自**开局时抽到的股票组合与局号**（seedKey），
 * 一旦这局开始，中间过程就是纯函数。
 */

/**
 * 字符串哈希（FNV-1a）—— 把 seedKey 拍成一个 32 位整数
 */
function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 由 seed 派生的确定性伪随机序列（mulberry32）
 * —— 只在"生成路径"这一步用，生成完即丢弃，
 *    不影响游戏其余部分的随机（新闻抽取等）。
 */
function makeRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 市场风格定义
 *
 * ============ 第三版：从 3 型扩到 6 型 ============
 *
 * 需求："拓展市场，加入小牛、小熊、平静震荡等多种类型"。
 *
 * 早先的 pathgen 把两个地方**硬编码成了 style 字符串比较**：
 *     trendBias = prof.trend * (style === 'bear' ? -2.6 : 2.6) * ...
 *     const base = style === 'bear' ? 0.55 : style === 'flat' ? 0.18 : 0.05;
 * 一旦新增风格，这两处就会静默地按"非熊即牛"处理 —— 小牛会被
 * 当成大牛、小熊会被当成牛市。因此这一版把它们提成**数据字段**：
 *
 *   trendScale : 个股 α（性格）的缩放，**带符号** —— 牛市为正（性格顺势放大），
 *                熊市为负（好性格也扛不住大盘），震荡/平静接近 0（性格失效）。
 *   delistBase : 该风格下的基础退市概率（再按 luck 调整）。
 *
 * 其余字段：
 *   marketBias : 每月的基础涨跌中枢（%）—— 牛市正、熊市负
 *   marketVol  : 大盘自身的波动（%）
 *   luckScale  : 个股"命运"的放大系数（熊市里爆雷更狠）
 *   crashChance: 每月发生个股暴跌（黑天鹅）的概率
 *
 * ============ 六种性格的意图 ============
 *
 *   bull      大牛 —— 单边向上，追涨也能赚，但换手仍被手续费磨损
 *   smallBull 小牛 —— 温和上行、波动更小，考验"拿得住"
 *   bear      大熊 —— 单边向下 + 高频爆雷，考验"空仓的勇气"
 *   smallBear 小熊 —— 阴跌 + 偶尔反弹，"抢反弹"是主要陷阱
 *   flat      震荡 —— 中枢 0、靠波动制造机会与陷阱
 *   calmFlat  平静 —— 波动极小，几乎没有交易机会（最考验耐心）
 */
export const MARKET_STYLES = {
  // 牛市：整体向上（长期持有有正期望）。个股分化 + 阶段回调，
  // 让"追涨杀跌/频繁换手"仍然会亏。
  // crashChance 很低 —— 牛市里爆雷是黑天鹅，不是常态。
  bull: {
    marketBias: 2.0, marketVol: 3.4, luckScale: 1.0,
    trendScale: 2.6, delistBase: 0.05,
    label: '牛市', crashChance: 0.035,
  },
  // 小牛：温和上行。中枢只有大牛的一半，波动也更小 ——
  // 涨停板少、赚钱慢，玩家容易"手痒换股"把利润磨掉。
  smallBull: {
    marketBias: 1.0, marketVol: 2.2, luckScale: 0.8,
    trendScale: 1.5, delistBase: 0.03,
    label: '小牛', crashChance: 0.02,
  },
  // 熊市：整体向下，杀跌凶狠，爆雷频发
  bear: {
    marketBias: -3.0, marketVol: 3.6, luckScale: 1.8,
    trendScale: -2.6, delistBase: 0.55,
    label: '熊市', crashChance: 0.20,
  },
  // 小熊：阴跌 + 频繁反弹。跌得不深，但"抄底抄在半山腰"
  // 是主要亏损来源 —— trendScale 仍为负，好股票也扛不住。
  smallBear: {
    marketBias: -1.4, marketVol: 2.6, luckScale: 1.4,
    trendScale: -1.4, delistBase: 0.22,
    label: '小熊', crashChance: 0.10,
  },
  // 震荡：中枢为 0，靠波动制造机会与陷阱。
  //   ★ 这一版对震荡市做了两处**故意的平衡修正**（旧值存疑）：
  //     ① trendScale 由旧代码沿用的 2.6 降到 0.2 —— 震荡市里
  //        个股性格不该"顺势放大"，否则就不叫震荡了。
  //     ② marketBias 由 0.2 提到 1.4 —— 实测旧值整年累计期望
  //        是负十几个百分点（见 tools/diag-styles.mjs 的受控实验），
  //        那是"戴着震荡帽子的熊市"，会把稳健玩家无故洗出去。
  //     现在中枢真正落在 0 附近：赚赔全看择时，不看运气。
  flat: {
    marketBias: 1.4, marketVol: 3.6, luckScale: 1.3,
    trendScale: 0.2, delistBase: 0.18,
    label: '震荡市', crashChance: 0.07,
  },
  // 平静：波动被压到很低，指数几乎一条直线。
  //   这是最"反直觉"的一种 —— 没有行情时，任何操作都是负期望
  //   （手续费 + 一点点噪声）。教会玩家"不做也是一种操作"。
  //   ★ 中枢刻意给一点点正漂移（0.15）：一潭死水会让玩家怀疑
  //     游戏卡死了；保留极微弱的上行，观感更像"横盘微升"。
  calmFlat: {
    marketBias: 0.15, marketVol: 1.1, luckScale: 0.9,
    trendScale: 0.1, delistBase: 0.10,
    label: '平静市', crashChance: 0.02,
  },
};

/** 合法风格 key 列表（供 validateData 与 UI 复用） */
export const MARKET_STYLE_KEYS = Object.keys(MARKET_STYLES);

/**
 * 取风格定义（带兜底）
 * @param {string} style
 * @returns {object}
 */
export function styleOf(style) {
  return MARKET_STYLES[style] || MARKET_STYLES.bull;
}

/**
 * 生成一条 12 项月度涨跌幅路径（%）
 *
 * 组成：
 *   ① 大盘 β：所有股票共享同一条"大盘曲线"（同涨同跌，符合真实市场）
 *   ② 个股 α：由 profile.trend 决定的方向性偏移
 *   ③ 噪声：确定性抖动，逐股不同
 *   ④ 极端事件：luck 低 + 熊市 → 某月出现暴跌（-15% ~ -30%）
 *
 * @param {object} stock 股票定义（含 code / profile）
 * @param {string} style 市场风格（见 MARKET_STYLES，如 bull/smallBull/bear/smallBear/flat/calmFlat）
 * @param {string} seedKey 局标识（保证同局同股结果一致）
 * @param {number} turns 回合数（默认 12）
 * @returns {number[]} 长度 = turns 的月度涨跌幅数组
 */
export function generatePath(stock, style = 'bull', seedKey = 'game', turns = 12) {
  const mkt = styleOf(style);
  const prof = stock.profile || { trend: 0, vol: 1, luck: 0 };

  // 大盘曲线：整局共享（seedKey 里不含 code → 所有股票拿到同一条）
  const mktRng = makeRng(hashStr(`market|${style}|${seedKey}`));
  const marketSeries = [];
  // 大盘也有"故事"：先给一个方向性漂移，再叠波动
  for (let t = 0; t < turns; t++) {
    const noise = (mktRng() * 2 - 1) * mkt.marketVol;
    // 牛市中后段加速、熊市中后段加速下跌（趋势自我强化）
    const accel = (t / Math.max(1, turns - 1)) * mkt.marketBias * 0.6;
    marketSeries.push(mkt.marketBias + accel + noise);
  }

  // 个股噪声（含 code → 每股不同）
  const rng = makeRng(hashStr(`stock|${style}|${seedKey}|${stock.code}`));

  // ③′ 均值回归周期 —— 全篇最容易做错的一步，务必读懂再动。
  //
  // 【问题背景】
  //   最初 trendBias 是**恒定值**：高 trend 的股票每月稳定上涨，
  //   于是"每月追最贵那只"的换手策略稳赚不赔（balance 测试抓出来了）。
  //
  // 【第一次尝试：sin（失败）】
  //   我把恒定值换成 sin((t/period)·2π + phase)。看起来"方向会翻转"，
  //   但用受控实验一测 —— 个股周期分量的自相关居然 **r = +0.158（正！）**，
  //   也就是说它非但没惩罚追高，反而在**奖励**追高。
  //
  //   原因：价格是"涨幅的积分"，涨幅是价格的导数。
  //   若把 sin 直接当作**涨幅**，则价格 ≈ −cos，涨幅曲线在半个周期内
  //   近似一条**平顶（plateau）** —— 连续几个月都是同一个大正值。
  //   于是"上月涨得多"几乎等价于"下月还涨得多"，妥妥的动量。
  //
  // 【正确做法：sin 作用于**价格水平**，涨幅取其差分（≈cos）】
  //   令 价格水平 ∝ sin(θ)，则 涨幅 ∝ sin(θ_t) − sin(θ_{t−1}) ≈ cos(θ)·(2π/period)。
  //   涨幅曲线是余弦：**在一个周期内会完整地由正转负**，峰值之后立刻衰减。
  //   这样"上月最猛"→ 恰好落在余弦的下降段 → 次月涨幅显著低于均值。
  //   （受控实验中，该分量的自相关因此由 +0.158 翻成负值。）
  //
  // 【为什么要双周期叠加】
  //   单周期时"由正转负"只发生在周期的 1/2 处，一年里回归窗口太稀疏。
  //   叠加一个 2~3 个月的短周期后，回归点变密，追高更容易被套。
  const period = 4 + Math.floor(rng() * 5); // 主周期 4~8 个月
  const phase = rng() * Math.PI * 2;
  const period2 = 2 + Math.floor(rng() * 2); // 副周期 2~3 个月
  const phase2 = rng() * Math.PI * 2;

  // 价格水平的周期分量（sin 作用于水平，不做差分 —— 见上）
  const levelAt = (t) =>
    Math.sin((t / period) * Math.PI * 2 + phase) +
    Math.sin((t / period2) * Math.PI * 2 + phase2) * 0.55;

  const path = [];
  for (let t = 0; t < turns; t++) {
    // ① 大盘 β（该股对大盘的敏感度 ≈ 0.6 + vol*0.5）
    const beta = 0.6 + prof.vol * 0.5;
    const fromMarket = marketSeries[t] * beta;

    // ② 个股 α：价格水平做 sin 后**取一阶差分**得到月度涨幅。
    //    差分≈cos → 涨幅在一个周期内完整地由正转负 → "刚涨完就回调"。
    //    首月没有"上个月"可差分，用一个等价相位的解析值兜底。
    const dLevel =
      t === 0
        ? Math.cos(phase) * ((2 * Math.PI) / period) + Math.cos(phase2) * 0.55 * ((2 * Math.PI) / period2)
        : levelAt(t) - levelAt(t - 1);
    // dLevel 的典型量级 ≈ 2π/period ≈ 1.0~1.6，乘 2.0 与后续噪声匹配
    //   ★ trendScale 来自 MARKET_STYLES（带符号）：牛市正、熊市负。
    //     早先这里写的是 `style === 'bear' ? -2.6 : 2.6` —— 新增风格后
    //     会静默地把小牛当大牛、把小熊当牛市，所以必须走数据。
    const trendBias = prof.trend * mkt.trendScale * 2.0 * dLevel;

    // ③ 确定性噪声
    const noise = (rng() * 2 - 1) * prof.vol * 3.2;

    let change = fromMarket + trendBias + noise;

    // ④ 极端事件：运气差的股票在熊市里可能爆雷
    const lucky = rng();
    // luck<0 的股票更容易触发；熊市把概率放大
    const crashP = mkt.crashChance * (1 - prof.luck * 0.5);
    if (lucky < crashP && t >= 2 && t <= turns - 1) {
      const severity = 12 + rng() * 18; // -12% ~ -30%
      change -= severity;
    }

    // 夹到合理区间，避免单月 ±60% 这种失真数字
    change = Math.max(-32, Math.min(28, change));
    path.push(Math.round(change * 10) / 10);
  }

  return path;
}

/**
 * 判定某只股票本局是否"退市爆雷"，并给出退市回合与清算价
 *
 * 规则：
 *   · 只有 luck 明显为负的"高危股"才可能退市
 *   · 熊市把概率放大；牛市基本不会退市
 *   · 用确定性随机（seedKey + code）判定 —— 同局同股结果恒定
 *
 * @param {object} stock 股票定义
 * @param {string} style 市场风格（见 MARKET_STYLES，如 bull/smallBull/bear/smallBear/flat/calmFlat）
 * @param {string} seedKey 局标识
 * @param {number} turns 回合数
 * @returns {{ delistAt: number, delistPrice: number }|null}
 */
export function rollDelist(stock, style, seedKey, turns = 12) {
  const prof = stock.profile || { luck: 0 };
  const mkt = styleOf(style);

  // 基础退市概率来自风格数据（熊市显著更高）；luck 越负越高。
  //   ★ 早先是 `style === 'bear' ? 0.55 : style === 'flat' ? 0.18 : 0.05`，
  //     新增风格会落到 else 分支（当成牛市）—— 已改为 mkt.delistBase。
  const base = typeof mkt.delistBase === 'number' ? mkt.delistBase : 0.05;
  const p = Math.max(0, Math.min(0.95, base * (1 - prof.luck * 0.8)));
  if (p <= 0) return null;

  const rng = makeRng(hashStr(`delist|${style}|${seedKey}|${stock.code}`));
  if (rng() >= p) return null;

  // 第 6~10 个月之间爆雷（给玩家足够的"逃生窗口"）
  const lo = Math.max(3, Math.floor(turns * 0.5));
  const hi = Math.max(lo + 1, turns - 2);
  const delistAt = lo + Math.floor(rng() * (hi - lo + 1));

  // 清算价：跌到 1 元上下的仙股，远低于 floor
  const delistPrice = Math.round((0.5 + rng() * 1.2) * 100) / 100;

  return { delistAt, delistPrice };
}

export { hashStr, makeRng };
