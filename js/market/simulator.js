/**
 * 行情引擎
 *
 * 规则：
 *   最终涨跌幅 = 路径值（固定，来自 pathgen） + 新闻临时偏移（逐回合衰减）
 *   nextPrice = price * (1 + totalChange / 100)
 *   price = max(price, floor)   ← 保证破产判定有效
 *
 * 路径值逐回合生成（见 js/market/pathgen.js），
 * 由「市场风格 + 个股性格 + 确定性噪声」决定，保证难度可控、可复现。
 *
 * ============ 新闻影响的三种错配（第二版）============
 *
 * 新闻不再绑定股票代码，而是声明 sector + kind：
 *   relevant   → sector 命中该股：按 truth 施加 drift（真利好涨 / 假利好跌）
 *   pressured  → "利好但业绩承压"：drift 取**负**（消息面好看，股价照跌）
 *   irrelevant → sector 不命中（例：船运利好 vs 陆运股）：**不施加影响**
 *
 * 后两种是玩法核心 —— 新闻卡照样展示，玩家要自己判断"与我有关吗"。
 *
 * ============ 退市/破产清算 ============
 *   由 pathgen 在生成路径后，为"运气差"的股票标记 delistAt（可选），
 *   触发时价格直接砸到 delistPrice（远低于 floor），
 *   之后不再波动、不能买卖，玩家持仓被强制清算。
 *   这是**关卡设计**的一部分，不是随机事件（路径本身就是确定性的）。
 */

export default class Simulator {
  constructor() {
    // code -> { def, price, history: [{turn, price, change}] }
    this.states = {};
    // 活跃的新闻影响：{ sector, kind, drift, remain }
    this.effects = [];
    this.turn = 0;
    // 本局已退市的股票代码集合
    this.delisted = new Set();
  }

  /**
   * 初始化 —— 载入本局的三只股票
   * @param {Array} stockDefs 股票定义数组（来自 data/pool，经 setup.composeGame 生成路径）
   */
  init(stockDefs) {
    this.states = {};
    this.effects = [];
    this.turn = 0;
    this.delisted = new Set();

    stockDefs.forEach((def) => {
      this.states[def.code] = {
        def,
        price: def.basePrice,
        delisted: false,
        history: [{ turn: 0, price: def.basePrice, change: 0 }],
      };
    });
  }

  /**
   * 注入一条新闻的影响
   *
   * @param {object} news 新闻对象（含 sector / kind / truth / impact）
   */
  applyNews(news) {
    if (!news || !news.impact) return;
    const { drift, turns = 2 } = news.impact;
    if (typeof drift !== 'number') return;

    this.effects.push({
      sector: news.sector,
      kind: news.kind || 'relevant',
      truth: news.truth !== false,
      drift,
      remain: turns,
      newsId: news.id,
    });
  }

  /**
   * 累加所有生效中影响的总偏移量（针对某只股票）
   *
   * 匹配规则：
   *   ① 大盘消息（sector='macro'）：对所有股票按 β 生效（轻微）
   *   ② sector 命中该股：
   *        kind='relevant'  → 按 truth 正/负施加 drift
   *        kind='pressured' → drift 取负（利好但跌）
   *   ③ sector 不命中：kind='irrelevant' → 完全不施加
   *
   * @param {object} stock 股票定义
   * @returns {number} 总偏移（%）
   */
  _activeDrift(stock) {
    let sum = 0;
    this.effects.forEach((e) => {
      if (e.remain <= 0) return;

      if (e.sector === 'macro') {
        // 大盘消息对所有股票生效，但幅度打折
        sum += (e.truth ? e.drift : -e.drift) * 0.5;
        return;
      }

      if (e.sector !== stock.sector) {
        // ★ 错配：消息讲的不是这个行业（船运 vs 陆运）→ 无影响
        return;
      }

      if (e.kind === 'pressured') {
        // ★ 利好但业绩承压：消息面是正 drift，实际股价跌
        sum -= Math.abs(e.drift) * 0.7;
        return;
      }

      // relevant：真消息按原方向，假消息反向
      sum += e.truth ? e.drift : -e.drift;
    });
    return sum;
  }

  /**
   * 推进一个回合 —— 计算新价格
   * @returns {object} { [code]: { price, change, pathChange, newsChange, delisted, justDelisted } }
   */
  step() {
    this.turn += 1;
    const t = this.turn;
    const result = {};

    Object.keys(this.states).forEach((code) => {
      const st = this.states[code];
      const def = st.def;

      // ---- 已退市：价格冻结在退市价，不再波动 ----
      if (st.delisted) {
        st.history.push({
          turn: t,
          price: st.price,
          change: 0,
          pathChange: 0,
          newsChange: 0,
          delisted: true,
        });
        result[code] = {
          price: st.price,
          change: 0,
          pathChange: 0,
          newsChange: 0,
          delisted: true,
          justDelisted: false,
        };
        return;
      }

      // ---- 本回合触发退市？----
      const willDelist = typeof def.delistAt === 'number' && t >= def.delistAt;

      const pathChange = def.path[t - 1] || 0;
      const newsChange = this._activeDrift(def);
      const totalChange = pathChange + newsChange;

      const prevPrice = st.price;
      let next;
      if (willDelist) {
        // 爆雷：直接砸到退市价（可能远低于 floor）
        next = typeof def.delistPrice === 'number' ? def.delistPrice : def.floor;
        st.delisted = true;
        this.delisted.add(code);
      } else {
        const raw = st.price * (1 + totalChange / 100);
        next = Math.max(raw, def.floor);
      }

      st.price = Math.round(next * 100) / 100;

      // ---- ★ 上报**实际**涨跌幅，而不是"计划涨跌幅" ----
      //
      // 早先这里直接上报 totalChange（path + news），有两处会说谎：
      //   ① 退市爆雷：价格从 ¥8.5 砸到 ¥1.2，totalChange 却只有 -0.8%
      //      → 卡片上显示"↓-0.8%"，与价格对不上，玩家看不出这是爆雷
      //   ② 触底：next 被 def.floor 兜住时，实际跌幅小于 totalChange
      // 现在统一用「价格转移」反推，涨跌幅与价格**永远自洽**。
      // pathChange / newsChange 仍然原样带出去，它们表示"计划中的分量"，供诊断用。
      const actualChange = prevPrice > 0
        ? (st.price / prevPrice - 1) * 100
        : 0;

      st.history.push({
        turn: t,
        price: st.price,
        change: actualChange,
        pathChange,
        newsChange,
        delisted: willDelist,
      });

      result[code] = {
        price: st.price,
        change: actualChange,
        pathChange,
        newsChange,
        delisted: willDelist,
        justDelisted: willDelist,
      };
    });

    // 影响时长衰减
    this.effects.forEach((e) => {
      e.remain -= 1;
    });
    this.effects = this.effects.filter((e) => e.remain > 0);

    return result;
  }

  /**
   * 取某只股票当前价格
   */
  priceOf(code) {
    const st = this.states[code];
    return st ? st.price : 0;
  }

  /**
   * 取某只股票的历史序列（用于画柱状图）
   */
  historyOf(code) {
    const st = this.states[code];
    return st ? st.history : [];
  }

  /**
   * 某只股票是否已退市
   */
  isDelisted(code) {
    const st = this.states[code];
    return !!(st && st.delisted);
  }

  /**
   * 本局已退市的股票代码列表
   */
  delistedCodes() {
    return Array.from(this.delisted);
  }

  /**
   * 当前**还能买**的股票的价格列表（已退市的不算）
   *
   * 破产判定要问的是"玩家还能不能买到一手"，
   * 所以只应看**可交易**的标的。
   * @returns {number[]}
   */
  tradablePrices() {
    return Object.values(this.states)
      .filter((s) => !s.delisted)
      .map((s) => s.price);
  }

  /**
   * 取可交易股票中的最低价 —— 破产判定用
   *
   * ============================================================
   * ⚠️ 必须排除**已退市**的股票（这里曾经是一个把游戏判死的 bug）
   * ============================================================
   *
   * 早先的实现是 `Math.min(...所有 states 的 price)`，注释还振振有词地说
   * "退市价拉低破产线，更宽容，符合直觉"。**这是错的**，而且是致命的：
   *
   *   · 退市股的清算价由 pathgen 随机生成在 **¥0.50 ~ ¥1.70**（见 rollDelist）
   *   · 退市后它被冻结在 states 里不再波动，**但它已经买不到了**
   *   · 于是「破产线 = 最低价 × 100」被压到 ¥50~170
   *
   * 后果（玩家实测报告）：
   *   「手里剩 ¥800，三只票一手都买不起，却不触发破产」
   *   —— 总资产 ¥800 > ¥80，判定为"没破产"。**玩家永远不会破产。**
   *
   * 正确的口径是「**买得到**的最便宜一手」：退市股不在可买之列，
   * 它的价格也就与"一手成本"无关。
   *
   * 注意这个修正是**收紧**判定：退市后剩下的两只若都很贵，
   * 破产线反而会抬高 —— 这正是"退市爆雷把你打出局"该有的表现。
   *
   * @returns {number} 最低价；无可交易股票时返回 0（调用方需另行处理）
   */
  lowestPrice() {
    const prices = this.tradablePrices();
    return prices.length ? Math.min(...prices) : 0;
  }

  /**
   * 当前是否还有可买入的股票（即是否还有未退市的标的）
   * @returns {boolean}
   */
  hasTradable() {
    return this.tradablePrices().length > 0;
  }

  /**
   * 取某只股票本回合的涨跌方向
   * @returns {number} 1 涨 / -1 跌 / 0 平
   */
  directionOf(code) {
    const st = this.states[code];
    if (!st || st.history.length < 2) return 0;
    const last = st.history[st.history.length - 1];
    if (last.change > 0.01) return 1;
    if (last.change < -0.01) return -1;
    return 0;
  }
}
