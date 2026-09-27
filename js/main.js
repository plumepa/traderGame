/**
 * 游戏主入口 —— 场景调度器
 *
 * 回合流转（每个月都是同一套）：
 *   IDLE → [开始] → NEWS（插播本月新闻）
 *        → TRADING（关掉新闻后进入，玩家买卖 + 点"下月/结束本年"）
 *        → 下一回合 或 到期结算
 *
 * ⚠️ 关键：**每个月（含 12 月）都必须先进入 TRADING**。
 *   新闻关闭后只调 _enterTrading()（结算价格 + 生成评级），
 *   绝不做到期判定 —— 否则 12 月的交易界面会被瞬间跳过，
 *   玩家观感就是"关卡提前结束了"。
 *   到期结算只在玩家点"结束本年 ▶ 结算"（_advanceTurn）时触发。
 *
 * 破产判定口径：总资产（现金 + 持仓市值）< 最低一手成本。
 *   - 买入后不判（只是把钱换成股票，总资产几乎不变，给玩家整月调整）
 *   - 卖出后判
 * 到期结算：先强制平仓（持仓按市价卖出），再用纯现金判 win / lose。
 */

import DataBus from './core/databus';
import Renderer from './core/render';
import MenuScene from './scenes/menu';
import TradingScene from './scenes/trading';
import NewsFlashScene from './scenes/newsflash';
import ResultScene from './scenes/result';

export default class Main {
  constructor() {
    this.bus = new DataBus();

    // ---- canvas 初始化 ----
    this.canvas = wx.createCanvas();
    this.ctx = this.canvas.getContext('2d');

    this.renderer = new Renderer(this.canvas, this.ctx);

    // ---- 场景 ----
    this.scenes = {};
    this.menu = new MenuScene();
    this.trading = new TradingScene(this.bus);
    this.newsflash = new NewsFlashScene();
    this.result = new ResultScene(this.bus);

    this.scenes.menu = this.menu;
    this.scenes.trading = this.trading;
    this.scenes.newsflash = this.newsflash;
    this.scenes.result = this.result;

    this.current = null;

    this._bindEvents();
    this._bindTouch();

    this.switchTo('menu');
    this.renderer.start((dt) => this._frame(dt));
  }

  // ============ 事件绑定 ============

  _bindEvents() {
    // 菜单 → 开局
    this.menu.on('startGame', (levelId) => {
      if (this.bus.start(levelId)) {
        // 开局即进入第 1 月
        this._beginTurn();
      } else {
        console.error('开局失败，数据校验错误：', this.bus.errors);
      }
    });

    // 下月 → 插播新闻
    this.trading.on('nextTurn', () => {
      this._advanceTurn();
    });

    // 卖出后 → 重新判定（卖出可能让现金回升，也可能已无翻盘手段）
    this.trading.on('afterTrade', () => {
      this.checkBankrupt();
    });

    // 新闻关闭 → 回到交易
    this.newsflash.on('closed', () => {
      this.switchTo('trading');
      // ⚠️ 这里**只**做「进入本月交易」的准备工作，不做任何到期判定。
      //   曾经这里调用 _settleAndJudge()，导致 12 月新闻一关就立刻结算
      //   ——玩家根本没机会做 12 月的交易，观感上就是"关卡提前结束了"。
      //   到期判定改由 _advanceTurn()（玩家点"结束本年 ▶ 结算"）触发。
      this._enterTrading();
    });

    // 结算 → 重开
    this.result.on('restart', () => {
      this.bus.reset();
      this.switchTo('menu');
    });
  }

  _bindTouch() {
    wx.onTouchStart((e) => {
      const t = e.touches && e.touches[0];
      if (!t) return;
      if (this.current) {
        this.current.handleTouch(t.clientX, t.clientY);
      }
    });
  }

  // ============ 场景切换 ============

  switchTo(name, params) {
    if (this.current) this.current.exit();
    this.current = this.scenes[name];
    if (this.current) this.current.enter(params || {});
  }

  // ============ 回合流转 ============

  /**
   * 开始一个回合：先插播本月新闻
   */
  _beginTurn() {
    this.bus.nextTurn();
    this.bus.phase = 'NEWS';

    const news = this.bus.news;
    this.switchTo('newsflash', {
      news,
      turn: this.bus.turn,
      stocks: this.bus.stockDefs,
    });
  }

  /**
   * 玩家点"下月"：先做本回合结算，再进入下一回合
   */
  _advanceTurn() {
    const bus = this.bus;

    // 已是最后一回合 → 本回合交易已结束，进入到期结算
    if (bus.turn >= bus.level.turns) {
      this._endTerm();
      return;
    }

    this._beginTurn();
  }

  /**
   * 进入本回合的交易环节 —— 新闻关闭后调用
   *
   * 只负责价格结算 + 生成评级，让玩家开始操作。
   * **不做**到期/破产判定：那两件事属于"离开本回合"的时机，
   * 放在这里会让最后一个月的交易界面被瞬间跳过。
   */
  _enterTrading() {
    const bus = this.bus;

    bus.settle();            // ① 价格结算（本月涨跌）
    bus.generateRatings();   // ② 机构评级
    bus.phase = 'TRADING';
  }

  /**
   * 年末到期结算 —— 玩家在最后一个月点"结束本年 ▶ 结算"时调用
   *
   * 顺序：先强制平仓（持仓按市价卖出），再用纯现金判 win / lose。
   */
  _endTerm() {
    const bus = this.bus;
    bus.phase = 'SETTLE';
    bus.settleTerm();
    this.switchTo('result');
  }

  /**
   * 破产判定 —— 统一入口
   *
   * 判定口径：总资产（现金 + 持仓市值）< 最低一手成本。
   * 买入后**不**立即判定（买入只是把钱换成股票，总资产几乎不变，
   * 该给玩家一整月时间调整）；卖出后判定。
   *
   * @returns {boolean} 是否已判定破产并跳转
   */
  checkBankrupt() {
    const bus = this.bus;
    if (bus.phase === 'OVER') return false;
    if (!bus.isBankrupt()) return false;

    const total = bus.portfolio.totalAssets(bus.priceMap);
    const line = bus.bankruptLine();
    bus.finish(
      'bankrupt',
      `总资产 ¥${total.toFixed(0)} 已低于一手成本 ¥${line.toFixed(0)}，你被市场清出了牌桌。`,
    );
    this.switchTo('result');
    return true;
  }

  // ============ 主循环 ============

  _frame(dt) {
    const w = this.renderer.width;
    const h = this.renderer.height;

    if (this.current) {
      this.current.update(dt);
      // 布局与热区：仅在尺寸/数据变化时重建，避免每帧重复注册
      this.current.ensureLayout(w, h);
      this.current.render(this.ctx, w, h);
    }
  }
}
