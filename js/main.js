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
 * 关卡流转（连闯）：
 *   菜单 startGame → startRun(levelId)    资金 = 该关默认初始资金
 *   结算 nextLevel → startNextLevel()     资金 = 上一关期末资产（延续）
 *   结算 final     → finalSettle()        汇总整轮战绩，runMode 关闭
 *   结算 menu      → reset() → 主菜单      放弃本轮
 *
 * 破产判定口径：总资产（现金 + 持仓市值）< 最低一手成本。
 *   - 买入后不判（只是把钱换成股票，总资产几乎不变，给玩家整月调整）
 *   - 卖出后判
 * 到期结算：先强制平仓（持仓按市价卖出），再用纯现金判 win / lose。
 */

import DataBus from './core/databus';
import Renderer from './core/render';
import * as audio from './core/audio';
import * as bgm from './core/bgm';
import * as muteButton from './ui/mute-button';
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

    // 音频：先起音效池与全局开关，再起背景音乐
    // （bgm 的初始音量取决于开关状态，所以顺序不能反）
    audio.init();
    bgm.init();

    this._bindEvents();
    this._bindTouch();

    this.switchTo('menu');
    this.renderer.start((dt) => this._frame(dt));
  }

  // ============ 事件绑定 ============

  _bindEvents() {
    // 菜单 → 开局（连闯第 1 关，资金取关卡默认初始资金）
    this.menu.on('startGame', (levelId) => {
      if (this.bus.startRun(levelId)) {
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

    // ---- 结算场景的三个出口（见 result.js 的 actionsOf）----

    // ① 进入下一关 —— **资金延续上一关的期末资产**
    //
    //    settleTerm() 已强制平仓，所以上一关期末是纯现金，
    //    startNextLevel() 直接把它当下一关的 initCash，不需要搬运持仓。
    this.result.on('nextLevel', () => {
      if (this.bus.startNextLevel()) {
        this._beginTurn();
      } else {
        console.error('进入下一关失败：', this.bus.errors);
      }
    });

    // ② 返回主界面 —— 放弃本轮连闯，进度清零
    this.result.on('menu', () => {
      this.bus.reset();
      this.switchTo('menu');
    });

    // ③ 退市结算 —— 轮末主动收手，把整轮战绩汇总成一份结算单
    //
    //    finalSettle() 会把 runMode 关掉，于是按钮只剩"返回主界面"，
    //    所以这里可以放心地重新进入 result（enter() 会强制重算布局）。
    this.result.on('final', () => {
      // 兜底：没有战绩就汇总不出东西。若不处理，结算页会原样重画，
      // 按钮还是"继续 / 退市结算" —— 点下去没有任何变化，看起来像卡死。
      if (!this.bus.finalSettle()) {
        this.bus.reset();
        this.switchTo('menu');
        return;
      }
      this.switchTo('result');
    });
  }

  _bindTouch() {
    wx.onTouchStart((e) => {
      // iOS 上首次用户交互前音频可能被系统拦下，这里兜一次"确保在播"
      bgm.ensurePlaying();

      const t = e.touches && e.touches[0];
      if (!t) return;

      // 声音开关是全局覆盖层，优先级高于任何场景
      const w = this.renderer.width;
      const h = this.renderer.height;
      if (muteButton.handleTap(t.clientX, t.clientY, w, h)) return;

      if (this.current) {
        // ★ 只在**真的命中了可点区域**时才响 —— 点空白处不该有反馈音
        const hit = this.current.handleTouch(t.clientX, t.clientY);
        if (hit) audio.playClick();
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

    // 声音开关画在所有场景之上 —— 它是全局控件，不属于任何一个场景
    muteButton.draw(this.ctx, w, h);
  }
}
