/**
 * 交易全局状态
 *
 * 单例 —— 整局游戏的唯一数据源。
 */

import Simulator from '../market/simulator';
import Portfolio from '../market/portfolio';
import Dispatcher from '../news/dispatcher';
import Institution from '../news/institution';
import { LEVEL_MAP, LEVEL_COUNT, poolOfLevel, validateData, composeGame } from '../data/index';

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
   * 开始一局
   *
   * 第三版：一关 = 一个「年景」（3 只股票 + 6 条专属新闻）。
   * 年景由 composeGame 从年景池里随机抽，**且不与本局已用过的重复**
   * （用 this.usedSeasonIds 排除）。
   *
   * 关卡只声明"本关可抽哪几类风格"（pool），年景本身的年份与主题
   * 对玩家完全隐藏 —— 玩家必须自己从价格与新闻里判断市场性质。
   *
   * @param {string} levelId 关卡 id
   * @param {object} [opts] 可选：{ stocks, seedKey, season, keepSeasons } —— 测试时可指定
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

    // ---- 开局编排：抽年景 → 生成路径 → 编排新闻 ----
    //
    // ⚠️ 先说清 style 与 styles 的关系：
    //   poolOfLevel 返回 'all' 时表示本关"没有剧本"（全放开）。
    //   此时**不能**把 level.style 传下去当限定 —— 那句占位的 'flat'
    //   会把"全放开"压成"只能抽 flat"。所以传 'all'，并把 style 设成
    //   null，让 composeGame 明白这不是单值限定。
    //   只有在 pool 是具体数组时才用 pool[0] 做兜底 style。
    const pool = poolOfLevel(level);
    const game = composeGame({
      turns: level.turns,
      style: pool === 'all' ? null : pool[0],
      styles: pool, // 'all' = 全放开；数组 = 只抽这些风格
      initCash: level.initCash,
      seedKey: opts.seedKey,
      stocks: opts.stocks,
      season: opts.season,
      excludeSeasons: opts.excludeSeasons || this.usedSeasonIds,
    });

    this.seedKey = game.seedKey;
    this.stockDefs = game.stockDefs;
    this.newsDeck = game.newsDeck;
    this.seasonId = game.seasonId || null;
    this.seasonLabel = game.seasonLabel || null;

    // 记录已用年景 —— 下一关抽卡时排除，实现"跨关不重复"
    if (this.seasonId && !opts.stocks && this.usedSeasonIds.indexOf(this.seasonId) < 0) {
      this.usedSeasonIds.push(this.seasonId);
    }

    this.portfolio = new Portfolio(level.initCash);
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
   * @returns {number} 新的回合数
   */
  nextTurn() {
    this.turn += 1;
    this.news = this.dispatcher.newsOf(this.turn);
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
   * 当前关卡的显示序号（1..5）与总关数
   *
   * 注意：这里返回的是**关卡编号**，不是年份、不是市场风格。
   * 年景（哪一年、什么市场）对玩家始终隐藏。
   *
   * @returns {{ index: number, total: number }}
   */
  levelPosition() {
    const idx = this.level && typeof this.level.index === 'number'
      ? this.level.index
      : LEVEL_MAP[this.level && this.level.id]
        ? LEVEL_MAP[this.level.id].index
        : 1;
    return { index: idx, total: LEVEL_COUNT };
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
    const init = this.level.initCash;
    this.result = {
      outcome,
      reason,
      total,
      init,
      profit: total - init,
      returnRate: (total - init) / init,
      turns: this.turn,
      liquidation: this.liquidation || null, // 年底强制平仓明细（若有）
      delistEvents: this.delistEvents.slice(), // 退市清算事件（若有）
    };
    this.phase = 'OVER';
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
    const init = this.level.initCash;
    const profit = total - init;
    const rate = ((profit / init) * 100).toFixed(1);

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
}

export default DataBus;
