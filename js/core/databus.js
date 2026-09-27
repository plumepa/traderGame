/**
 * 交易全局状态
 *
 * 单例 —— 整局游戏的唯一数据源。
 */

import Simulator from '../market/simulator';
import Portfolio from '../market/portfolio';
import Dispatcher from '../news/dispatcher';
import Institution from '../news/institution';
import {
  LEVELS,
  LEVEL_MAP,
  LEVEL_COUNT,
  STOCK_POOL,
  poolOfLevel,
  validateData,
  composeGame,
  composeFreshLevel,
} from '../data/index';

let instance;

class DataBus {
  constructor() {
    if (instance) return instance;
    instance = this;

    this.reset();
  }

  /**
   * 重置为初始状态
   */
  reset() {
    this.level = null;
    this.simulator = new Simulator();
    this.portfolio = new Portfolio(0);
    this.dispatcher = new Dispatcher();
    this.institution = new Institution();

    this.turn = 0; // 当前回合（0 = 尚未开始，1~12 为进行中）
    this.stockDefs = []; // 本关三只股票定义
    this.priceMap = {}; // code -> 当前价
    this.changeMap = {}; // code -> 本回合涨跌幅
    this.news = null; // 本回合新闻
    this.ratings = []; // 本回合三只股票评级
    this.records = []; // 每回合交易记录

    // ---- 连闯（run）状态 ----
    //
    // 玩家可以在每关结束时选择"进入下一关"，**资金延续**；
    // 每 5 关为"一轮"，一轮结束后可选择"再来五关"或"退市结算"。
    //
    // ⚠️ `usedStockCodes` **不是每轮清空的** —— 那样第 6 关就会撞上第 1 关的股票。
    //   实际规则是"轮界补货"：只有当剩下的没用过的股票不够撑满一整轮时才清空。
    //   36 只时连闯 10 关不重样，且每轮内部绝对不重样。见 startNextLevel()。
    this.runMode = false; // 是否处于连闯模式（影响 levelPosition 的编号口径）
    this.roundIndex = 0; // 第几轮（0 起）
    this.stepIndex = 0; // 本轮第几关（0..LEVEL_COUNT-1）
    this.usedStockCodes = []; // 已经出现过的股票代码（跨关不重复，轮界补货）
    this.runResults = []; // 每关结算摘要 [{ index, step, round, ... }]
    this.initCash = 0; // **本关**起始资金（连闯时是上一关的期末资产）
    this.style = null; // 本关市场风格（内部字段，绝不展示给玩家）
    this.stockRecycled = false; // 本关是否因池子耗尽而重置了排除集（调试用）

    // ---- 跨关不重复用过的年景 ----
    //
    // 一局 5 关，每关抽一个"年景"（= 一组 3 股票 + 6 新闻）。
    // 年景池共 20 个，所以连玩 4 轮（20 关）都不会重样；
    // 第 5 轮起池子耗尽，才会开始复用 —— 这是刻意设计，不是 bug。
    this.usedSeasonIds = []; // 已用过的年景 id（本局内累积）
    this.seasonId = null; // 当前关卡实际使用的年景 id
    this.seasonLabel = null; // 年景的内部标签（**不对玩家展示**，仅供调试/日志）

    this.phase = 'IDLE'; // IDLE | NEWS | TRADING | SETTLE | OVER
    this.result = null; // 结算结果
    this.liquidation = null; // 年底强制平仓明细
    this.delistEvents = []; // 本局发生的退市清算事件 [{ turn, code, name, shares, price, profit }]
    this.errors = []; // 数据自检错误
  }

  /**
   * 开始一关
   *
   * 两条编排路径，按 `opts` 自动选择：
   *
   *   A. **连闯路径（默认）** —— `composeFreshLevel`
   *      从股票池抽 3 只「本轮还没出现过」且行业互不相同的股票。
   *      这是"每关不重复同一只股票"的**构造性保证**，
   *      也是玩家从主菜单开局、以及"进入下一关"时走的路径。
   *
   *   B. **年景路径（显式指定时）** —— `composeGame`
   *      传了 `opts.season` 或 `opts.stocks` 时走这条。
   *      年景自带 3 只固定股票 + 6 条专属新闻，供测试与诊断做受控实验
   *      （例如 diag-rating 要用指定风格的年景跑几百局）。
   *
   * ⚠️ 为什么默认不再是年景路径：年景之间**大量共用股票**
   *   （36 只股票撑起 20 个年景 = 60 个股票位），
   *   所以"跨关不重复"做在年景层面根本挡不住股票重复。
   *   详见 `composeFreshLevel` 的注释。
   *
   * @param {string} levelId 关卡 id
   * @param {object} [opts] 可选：
   *   · `initCash`      本关起始资金（连闯时 = 上一关期末资产）
   *   · `excludeStocks` 要排除的股票代码（默认用 this.usedStockCodes）
   *   · `seedKey` / `season` / `stocks` / `excludeSeasons` —— 测试与诊断用
   * @returns {boolean} 是否成功开始
   */
  start(levelId, opts = {}) {
    // 启动即自检，尽早暴露数据错误
    this.errors = validateData();
    if (this.errors.length) {
      console.error('[databus] 数据校验未通过:', this.errors);
      return false;
    }

    const level = LEVEL_MAP[levelId];
    if (!level) {
      console.error('[databus] 关卡不存在:', levelId);
      return false;
    }

    this.level = level;

    // 测试注入股票时清空"跨关不重复"记录（否则会串味）
    if (opts.resetSeasons) this.usedSeasonIds = [];

    // ★ 起始资金：连闯时由上一关的期末资产注入，否则用关卡默认值。
    //   注意**不能**再依赖 this.level.initCash —— level 是 LEVELS 里的**共享对象**，
    //   改它会把"上一关的钱"写进关卡定义，污染后续所有局。
    const initCash = typeof opts.initCash === 'number' ? opts.initCash : level.initCash;
    this.initCash = initCash;

    // ---- 开局编排 ----
    //
    // ⚠️ 先说清 style 与 styles 的关系：
    //   poolOfLevel 返回 'all' 时表示本关"没有剧本"（全放开）。
    //   此时**不能**把 level.style 传下去当限定 —— 那句占位的 'flat'
    //   会把"全放开"压成"只能抽 flat"。所以传 'all'，并把 style 设成
    //   null，让编排层明白这不是单值限定。
    //   只有在 pool 是具体数组时才用 pool[0] 做兜底 style。
    const pool = poolOfLevel(level);
    const legacy = !!(opts.stocks || opts.season);
    const excludeStocks = opts.excludeStocks || this.usedStockCodes;

    const game = legacy
      ? composeGame({
        turns: level.turns,
        style: pool === 'all' ? null : pool[0],
        styles: pool, // 'all' = 全放开；数组 = 只抽这些风格
        initCash,
        seedKey: opts.seedKey,
        stocks: opts.stocks,
        season: opts.season,
        excludeSeasons: opts.excludeSeasons || this.usedSeasonIds,
      })
      : composeFreshLevel({
        turns: level.turns,
        initCash,
        styles: pool,
        style: pool === 'all' ? null : pool[0],
        excludeStocks,
        seedKey: opts.seedKey,
      });

    this.seedKey = game.seedKey;
    this.stockDefs = game.stockDefs;
    this.newsDeck = game.newsDeck;
    this.style = game.style;
    this.seasonId = game.seasonId || null;
    this.seasonLabel = game.seasonLabel || null;
    this.stockRecycled = !!game.recycled;

    // 编排层因为"可用股票不足 3 只"自行重置了排除集 → 本地记录也必须跟着清空，
    // 否则 usedStockCodes 会与实际抽到的股票脱节（后面算剩余量就不准了）。
    if (game.recycled) this.usedStockCodes = [];

    // 记录已用年景 —— 下一关抽卡时排除，实现"跨关不重复"（年景路径）
    if (this.seasonId && !opts.stocks && this.usedSeasonIds.indexOf(this.seasonId) < 0) {
      this.usedSeasonIds.push(this.seasonId);
    }

    // ★ 记录本关用掉的股票 —— 连闯路径下，下一关会排除它们。
    //   年景路径也照记（无副作用），这样两条路径的不重复语义一致。
    if (!opts.stocks) {
      this.stockDefs.forEach((d) => {
        if (this.usedStockCodes.indexOf(d.code) < 0) this.usedStockCodes.push(d.code);
      });
    }

    this.portfolio = new Portfolio(initCash);
    this.simulator.init(this.stockDefs);

    // 初始价格
    this.stockDefs.forEach((s) => {
      this.priceMap[s.code] = s.basePrice;
      this.changeMap[s.code] = 0;
    });

    // 开局编排新闻 —— 每局都随机，局内固定
    this.dispatcher.buildScript(this.newsDeck, this.stockDefs);

    this.turn = 0;
    this.records = [];
    this.result = null;
    this.liquidation = null;
    this.delistEvents = [];
    this.phase = 'IDLE';
    return true;
  }

  /**
   * 进入下一回合
   *
   * ⚠️ 这里必须把本月新闻**注入行情引擎**（`applyNews`）。
   *
   * 【曾经的严重缺陷】早先只设置了 `this.news`，从没调用过 `simulator.applyNews()`，
   *   于是 `simulator.effects` 永远是空数组 → `_activeDrift()` 恒返回 0 →
   *   **新闻对价格零影响**（实测 newsChange 恒为 0.000，effects 长度恒为 0）。
   *   后果是"消息面"整条链路是死的：
   *     · `pressured`（利好但业绩承压 / 财务造假）这个为"暴雷"设计的机制从未生效
   *     · 假消息反向（本作的"核心爽点"：老手从评级与新闻的背离里嗅出假消息）
   *       根本没有可背离的对象 —— 新闻不动价格，评级背离了也没意义
   *     · 玩家读新闻做判断，但新闻其实什么都没影响
   *
   * 时序：新闻在回合 t 播报 → 玩家读完关闭 → 才结算价格。
   *   所以新闻的 drift 会落在**本月**（玩家刚读完就开盘反应）与**下月**
   *   （`impact.turns` 默认 2）。玩家能吃到的是"下月"那一段 ——
   *   这正好构成玩法：读新闻 → 判断真假 → 提前布局。
   *
   * @returns {number} 新的回合数
   */
  nextTurn() {
    this.turn += 1;
    this.news = this.dispatcher.newsOf(this.turn);
    // 注入本月新闻影响（无新闻 / 无 impact 时是空操作）
    this.simulator.applyNews(this.news);
    return this.turn;
  }

  /**
   * 结算当前回合的价格
   *
   * 附加处理：若本回合有股票**退市爆雷**，立即强制清算玩家持有的该股，
   * 并记入 delistEvents（供 UI 弹提示 + 结算页展示）。
   *
   * @returns {object} 价格变化结果
   */
  settle() {
    const changes = this.simulator.step();
    this.changeMap = {};
    Object.keys(changes).forEach((code) => {
      this.priceMap[code] = changes[code].price;
      this.changeMap[code] = changes[code].change;

      // ---- 退市清算 ----
      if (changes[code].justDelisted) {
        const def = this.stockDefs.find((s) => s.code === code);
        const liq = this.portfolio.liquidateCode(code, changes[code].price);
        this.delistEvents.push({
          turn: this.turn,
          code,
          name: def ? def.name : code,
          shares: liq ? liq.shares : 0,
          price: changes[code].price,
          profit: liq ? liq.profit : 0,
          // 玩家是否真的持有 → 决定 UI 是"警告"还是"爆雷"
          held: !!liq,
        });
        if (liq) {
          this.records.push({
            turn: this.turn,
            code,
            name: def ? def.name : code,
            action: 'delist',
            shares: liq.shares,
            price: liq.price,
            fee: liq.fee,
            profit: liq.profit,
          });
        }
      }
    });
    return changes;
  }

  /**
   * 某只股票是否已退市
   */
  isDelisted(code) {
    return this.simulator.isDelisted(code);
  }

  /**
   * 本回合是否有新的退市事件（用于交易页弹提示）
   */
  latestDelistEvent() {
    const t = this.turn;
    for (let i = this.delistEvents.length - 1; i >= 0; i--) {
      if (this.delistEvents[i].turn === t) return this.delistEvents[i];
    }
    return null;
  }

  /**
   * 生成本回合的机构评级
   */
  generateRatings() {
    this.ratings = this.institution.rateAll(
      this.stockDefs,
      this.changeMap,
      this.news,
    );
    return this.ratings;
  }

  /**
   * 破产判定：总资产 < 最低股价 × 100（连一手都买不起）
   *
   * ⚠️ 判定口径是**总资产**（现金 + 持仓市值），不是现金。
   *
   * 早先版本只看现金，导致玩家一买股票（哪怕只买一手）现金就跌破线，
   * 回合末立刻被判破产 —— 等于惩罚正常买入。持仓是能卖成钱的，
   * 必须计入。只有总资产连一手都买不起，才真的无翻盘手段。
   *
   * @returns {boolean}
   */
  isBankrupt() {
    const lowest = this.simulator.lowestPrice();
    const total = this.portfolio.totalAssets(this.priceMap);
    return total < lowest * 100;
  }

  /**
   * 破产线金额（最低一手成本）
   */
  bankruptLine() {
    return this.simulator.lowestPrice() * 100;
  }

  /**
   * 预设：买入后是否会把总资产压到破产线以下
   *
   * 用于交易界面的软提示（不是硬拦截 —— 玩家有权利梭哈，
   * 但应该被告知后果）。判定口径与 isBankrupt 一致：总资产。
   *
   * @param {string} code 股票代码
   * @param {number} price 成交价
   * @param {number} shares 股数
   * @returns {{ afterTotal: number, line: number, wouldBankrupt: boolean }}
   */
  wouldBankruptAfterBuy(code, price, shares) {
    const amount = price * shares;
    const fee = Math.max(amount * 0.0003, amount > 0 ? 5 : 0);
    const afterTotal = this.portfolio.totalAssets(this.priceMap) - fee;
    const line = this.bankruptLine();
    return { afterTotal, line, wouldBankrupt: afterTotal < line };
  }

  /**
   * 是否已到期（回合耗尽）
   * @returns {boolean}
   */
  isTermOver() {
    return this.turn >= this.level.turns;
  }

  /**
   * 当前关卡的显示序号
   *
   * 两种口径：
   *   · **连闯模式**（runMode）：累计编号。
   *     第 1 轮第 1 关 = 「第 1 / 5 关」，第 2 轮第 3 关 = 「第 8 / 10 关」。
   *     分母是"到本轮结束为止的总关数"，让玩家知道自己在一段一段地往上走。
   *   · **单关模式**（测试/诊断）：沿用关卡自带的 index，行为与旧版一致。
   *
   * 注意：这里返回的是**关卡编号**，不是年份、不是市场风格。
   * 年景（哪一年、什么市场）对玩家始终隐藏。
   *
   * @returns {{ index:number, total:number, step:number, round:number, blockTotal:number }}
   */
  levelPosition() {
    if (this.runMode) {
      const step = this.stepIndex; // 0 起
      const round = this.roundIndex; // 0 起
      return {
        index: round * LEVEL_COUNT + step + 1, // 累计第几关
        total: (round + 1) * LEVEL_COUNT, // 到本轮末为止共几关
        step: step + 1, // 本轮第几关（1..5）
        round: round + 1, // 第几轮（1 起）
        blockTotal: LEVEL_COUNT,
      };
    }
    const idx = this.level && typeof this.level.index === 'number'
      ? this.level.index
      : LEVEL_MAP[this.level && this.level.id]
        ? LEVEL_MAP[this.level.id].index
        : 1;
    return {
      index: idx,
      total: LEVEL_COUNT,
      step: idx,
      round: 1,
      blockTotal: LEVEL_COUNT,
    };
  }

  /**
   * 本关是否是一"轮"的最后一关（第 5 / 10 / 15 … 关）
   *
   * 一轮 = 5 关。轮末是玩家做"再来五关 / 退市结算"决定的时刻。
   * @returns {boolean}
   */
  isBlockEnd() {
    return this.stepIndex >= LEVEL_COUNT - 1;
  }

  /**
   * 下一关的信息（**纯计算，不改状态**）
   * @returns {{ id:string, roundIndex:number, stepIndex:number, newRound:boolean }}
   */
  nextLevelInfo() {
    const nextStep = this.stepIndex + 1;
    const newRound = nextStep >= LEVEL_COUNT;
    const step = newRound ? 0 : nextStep;
    const round = newRound ? this.roundIndex + 1 : this.roundIndex;
    return {
      id: LEVELS[step].id,
      roundIndex: round,
      stepIndex: step,
      newRound,
    };
  }

  /**
   * 本关是否还能继续（没破产，且没有退市结算）
   * @returns {boolean}
   */
  canContinue() {
    if (!this.result) return false;
    // 退市结算是玩家主动收手 —— 账本已经合上，不该再摆出"下一关"
    if (this.result.isFinal) return false;
    // 破产就没有"下一关"可言 —— 连一手都买不起了
    return this.result.outcome !== 'bankrupt';
  }

  /**
   * 开始一轮新的连闯（从主菜单进入）
   *
   * 清空进度与"已出现过的股票"，资金回到第 1 关的默认初始资金。
   *
   * ⚠️ stepIndex 必须由**所选关卡**推导，不能写死 0：
   *   菜单允许直接选第 3 关开打，写死 0 会让 UI 显示"第 1 / 5 关"，
   *   而且打完第 3 关就当成打完了第 1 关，第 4、5 关的位置全错位。
   *
   * @param {string} levelId 起始关卡（通常是第 1 关）
   * @param {object} [opts] 透传给 start()（测试用 seedKey 等）
   * @returns {boolean}
   */
  startRun(levelId, opts = {}) {
    const lv = LEVEL_MAP[levelId];
    const idx = lv && typeof lv.index === 'number' ? lv.index - 1 : 0;

    this.runMode = true;
    this.roundIndex = 0;
    this.stepIndex = Math.max(0, Math.min(LEVEL_COUNT - 1, idx));
    this.usedStockCodes = [];
    this.runResults = [];
    return this.start(levelId, opts);
  }

  /**
   * ★ 进入下一关 —— **资金延续上一关的期末资产**
   *
   * 上一关结束时 `settleTerm()` 已强制平仓，所以期末状态是**纯现金**，
   * 直接把 `result.total` 作为下一关的起始资金即可，不需要搬运持仓。
   *
   * ============================================================
   * "什么时候允许重新出现用过的股票"
   * ============================================================
   *
   * 这是本功能唯一需要权衡的地方，三种做法都试过：
   *
   *   ✗ 每轮清空 → 只保证"一轮五关不重样"，第 6 关立刻撞上第 1 关的股票。
   *     太保守，浪费了 36 只的池子（一轮只用掉 15 只）。
   *   ✗ 用完才清（< 3 只剩余）→ 能连闯 12 关不重样，但**清空点落在第 13 关**，
   *     而轮界在 11 关 —— 于是第 3 轮（11~15 关）内部会撞车，
   *     "一轮五关不重样"这个更好向玩家解释的保证就没了。
   *   ✓ **轮界补货**（本实现）→ 在轮界检查"剩下的没用过的股票够不够撑满一整轮"，
   *     不够才清空。36 只时：第 1 轮用 15 只、剩 21 只够 → 不清；
   *     第 2 轮再用 15 只、剩 6 只不够 → 第 3 轮清空。
   *     结果：**连闯 10 关都不会看到重复股票**，且每一轮内部都绝对不重样。
   *
   * 为什么"够不够"要用 `3 × LEVEL_COUNT`：一轮 5 关、每关 3 只 = 15 只。
   * 这也是"股票池必须是 3 的倍数"的意义所在 —— 它保证任何一次清空
   * 都落在**关卡边界**上，永远不会出现"最后一关只剩 1-2 只股票"。
   *
   * @returns {boolean} 是否成功进入下一关
   */
  startNextLevel() {
    if (!this.result) return false;
    // ★ 必须先过 canContinue()：
    //   · 破产时没有下一关（总资产 < 一手成本，拿 ¥0 开局）
    //   · 退市结算后账本已合上（result.isFinal），不能靠残留状态再开一关
    if (!this.canContinue()) return false;

    const info = this.nextLevelInfo();
    const cash = this.result.total;

    this.runMode = true;
    this.roundIndex = info.roundIndex;
    this.stepIndex = info.stepIndex;

    if (info.newRound) {
      const remain = STOCK_POOL.length - this.usedStockCodes.length;
      if (remain < 3 * LEVEL_COUNT) this.usedStockCodes = [];
    }

    return this.start(info.id, { initCash: cash });
  }

  /**
   * 本关已用过的股票数量（调试/统计用，不面向玩家）
   * @returns {number}
   */
  usedStockCount() {
    return this.usedStockCodes.length;
  }

  /**
   * 本局已用过的年景数量（调试/统计用，不面向玩家）
   * @returns {number}
   */
  usedSeasonCount() {
    return this.usedSeasonIds.length;
  }

  /**
   * 结束本局并生成结算结果
   *
   * 无通关目标 —— 结局由「是否破产」和「到期时的收益」共同决定：
   *   bankrupt : 总资产低于一手成本，提前出局
   *   win      : 到期结算，且资产高于初始资金
   *   lose     : 到期结算，且资产不高于初始资金
   *
   * @param {'win'|'lose'|'bankrupt'} outcome 结局类型
   * @param {string} reason 说明
   */
  finish(outcome, reason) {
    const total = this.portfolio.totalAssets(this.priceMap);
    // ★ 用 this.initCash（本关起始资金），**不是** this.level.initCash。
    //   连闯时本关是从上一关的期末资产起步的，关卡默认的 ¥10000 已经不代表本金。
    const init = this.initCash;
    this.result = {
      outcome,
      reason,
      total,
      init,
      profit: total - init,
      returnRate: init > 0 ? (total - init) / init : 0,
      turns: this.turn,
      liquidation: this.liquidation || null, // 年底强制平仓明细（若有）
      delistEvents: this.delistEvents.slice(), // 退市清算事件（若有）
    };
    this.phase = 'OVER';

    // ---- 连闯：把本关结果记进跑关战绩 ----
    if (this.runMode) {
      const pos = this.levelPosition();
      this.runResults.push({
        index: pos.index, // 累计第几关
        step: pos.step, // 本轮第几关
        round: pos.round,
        levelId: this.level.id,
        initCash: init,
        total,
        profit: total - init,
        turns: this.turn, // ★ 退市结算要按"累计月份"汇总，必须逐关留底
        outcome,
      });
    }
    return this.result;
  }

  /**
   * 到期自动结算
   *
   * 步骤：
   *   ① 强制平仓 —— 所有持仓按当前市价卖出（含手续费）
   *   ② 用平仓后的纯现金判定 win / lose
   *
   * 为什么要强制平仓：持仓是"账面富贵"，不卖出只是数字。
   * 年末清仓后最终资产变成实打实的现金，结算数字才真实，
   * 也杜绝"死扛不卖躺过终点"。
   *
   * @returns {object} 结算结果
   */
  settleTerm() {
    const liq = this.portfolio.liquidateAll(this.priceMap);
    this.liquidation = liq.details.length ? liq : null;

    const total = this.portfolio.totalAssets(this.priceMap);
    const init = this.initCash; // ★ 同 finish()：本关起始资金，不是关卡默认值
    const profit = total - init;
    const rate = init > 0 ? ((profit / init) * 100).toFixed(1) : '0.0';

    const liqNote = liq.details.length
      ? `年末已按市价清仓 ${liq.details.reduce((s, d) => s + d.shares, 0)} 股（手续费 ¥${liq.totalFee.toFixed(0)}）。`
      : '年末空仓，无需平仓。';

    if (profit > 0) {
      return this.finish(
        'win',
        `一年期满，净赚 ¥${profit.toFixed(0)}（${rate}%）。你跑赢了本金。${liqNote}`,
      );
    }
    if (profit < 0) {
      return this.finish(
        'lose',
        `一年期满，净亏 ¥${Math.abs(profit).toFixed(0)}（${rate}%）。市场收走了你的钱。${liqNote}`,
      );
    }
    return this.finish('lose', `一年期满，不赚不亏。你白忙了一场。${liqNote}`);
  }

  /**
   * ★ 退市结算 —— 玩家在轮末主动收手，把整轮战绩汇总成一份结算单
   *
   * 汇总口径：
   *   · init  = 第 1 关的起始资金（整轮的本金）
   *   · total = 最后一关的期末总资产（settleTerm 已强制平仓，是纯现金）
   *   · turns = 各关存活月份之和（"累计月份"，不是单关的 12）
   *
   * ⚠️ 必须把 runMode 关掉。否则 actionsOf() 看到 runMode && canContinue
   *   仍会摆出"进入下一关"，玩家点一下就真的继续了 ——
   *   退市结算必须是一锤子买卖，点完只剩"返回主界面"。
   *
   * @returns {object|null} 汇总后的结算结果（无战绩时返回 null）
   */
  finalSettle() {
    const runs = (this.runResults || []).slice();
    if (!runs.length) return null;

    const last = this.result;
    const start = runs[0].initCash; // 整轮本金 = 第 1 关起始资金
    const total = last ? last.total : this.portfolio.totalAssets(this.priceMap);
    const profit = total - start;
    const rate = start > 0 ? ((profit / start) * 100).toFixed(1) : '0.0';
    const turns = runs.reduce((s, r) => s + (r.turns || 0), 0);
    const wins = runs.filter((r) => r.outcome === 'win').length;

    this.runMode = false; // ★ 见上：不关掉按钮就还会出现"下一关"
    this.result = {
      outcome: profit > 0 ? 'win' : 'lose',
      reason:
        `连闯 ${runs.length} 关（其中 ${wins} 关盈利），累计净`
        + `${profit >= 0 ? '赚' : '亏'} ¥${Math.abs(profit).toFixed(0)}（${rate}%）。`
        + '你选择在此退市结算。',
      total,
      init: start,
      profit,
      returnRate: start > 0 ? profit / start : 0,
      turns,
      // 平仓明细 / 退市事件沿用最后一关的 —— 它们描述的是"刚才这一关"发生了什么
      liquidation: last ? last.liquidation : null,
      delistEvents: last ? last.delistEvents : [],
      isFinal: true,
      levels: runs.length,
    };
    this.phase = 'OVER';
    return this.result;
  }
}

export default DataBus;
