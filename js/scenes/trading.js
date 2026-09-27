/**
 * 交易主场景
 *
 * 布局（竖屏）：
 *   ┌─────────────────────────┐
 *   │ 顶栏：月份 / 现金 / 总资产  │
 *   ├─────────────────────────┤
 *   │ 三只股票卡片（各带"走势图"按钮）│
 *   ├─────────────────────────┤
 *   │ 机构评级面板              │
 *   ├─────────────────────────┤
 *   │ 操作区：选中股票 + 买/卖   │
 *   ├─────────────────────────┤
 *   │ 下月按钮                 │
 *   └─────────────────────────┘
 *
 * 走势图：不再在卡片里内嵌迷你 canvas。
 *   每张卡片右下角有一个按钮，点开弹出覆盖层，
 *   弹窗只画"该按钮所属那只股票"的走势（单序列）。
 *
 * 版面（第三版）：
 *   ① 顶部让出安全区 —— 顶栏内容从 contentTop() 之下开始，
 *      背景色块仍从 y=0 铺起，避免灵动岛 / 刘海遮住第一行文字。
 *   ② 纵向节奏由 tradeFlow() 统一计算，layout() 与 render() 共用同一份，
 *      彻底消除"热区与画面各算一遍、算歪了就点不中"的老毛病。
 *   ③ 间隙随屏高自适应：大屏放宽（不空）、小屏收紧（不挤）。
 */

import Scene from '../base/scene';
import { PALETTE, FONT, STOCK, PIXEL, monthName } from '../styles/palette';
import { contentTop, safeBottom } from '../styles/layout';
import { text, panel, button, rect, strokeRect } from '../styles/widgets';
import { lineChart, chartLegend, wavyPath } from '../styles/chart';
import { LOT_SIZE, validateBuy, validateSell, maxLots, costToBuy } from '../market/order';
import { SECTORS } from '../data/pool';

// ============ 版面度量 ============
//
// 基准值针对"内容刚好排得下"的中等屏幕；富余则放宽、不足则收紧。
// 字号不参与缩放 —— 可读性不能妥协，只调间距。
const L = {
  topBar: 48, // 顶栏内容高度（不含顶部安全区）
  cardH: 84, // 股票卡片基准高度
  gap: 8, // 段落间距基准
  ratingRowH: 20,
  ratingPadTop: 24,
  ratingPadBottom: 6,
  orderH: 160, // 操作面板基准高度
  nextH: 48,
  bottomPad: 12,
  minGap: 4,
  maxGap: 24,
  maxCardH: 108,
  minCardH: 80, // 再矮就会让"走势图"按钮撞上涨跌幅文字
  minOrderH: 148,
};

// 纵向间隙个数：每张卡片之后 ×3 + 卡片组后 + 评级后 + 操作区后
const GAPS = 6;

/**
 * 退市横幅的高度 —— 两行（含清算明细）优先，空间不够时退化为一行
 */
function bannerPlan(ev) {
  if (!ev) return { full: 0, compact: 0 };
  return { full: (ev.held ? 52 : 36) + 6, compact: 30 + 6 };
}

/**
 * 解出「间隙 / 卡片高 / 操作面板高」三个可调量
 *
 * 优先放宽（大屏不空），不足时依次收紧：间隙 → 操作面板 → 卡片。
 * 字号与卡片内文字位置不参与缩放 —— 可读性不妥协。
 *
 * @returns {{gap:number, cardH:number, orderH:number, overflow:number}}
 */
function solveHeights(avail, bannerH, ratingsH) {
  let gap = L.gap;
  let cardH = L.cardH;
  let orderH = L.orderH;

  const total = () => L.topBar + bannerH + 3 * cardH + ratingsH + orderH + GAPS * gap;
  let slack = avail - total();

  // ① 富余 → 放宽间隙
  if (slack > 0) {
    const add = Math.min(slack / GAPS, L.maxGap - gap);
    gap += add;
    slack -= add * GAPS;
  }
  // ② 仍富余 → 长高卡片
  if (slack > 0) {
    const addCard = Math.min(slack / 3, L.maxCardH - cardH);
    cardH += addCard;
    slack -= addCard * 3;
  }
  // ③ 不足 → 收紧间隙
  if (slack < 0) {
    const cut = Math.min(gap - L.minGap, -slack / GAPS);
    gap -= cut;
    slack += cut * GAPS;
  }
  // ④ 仍不足 → 压操作面板
  if (slack < 0) {
    const cut = Math.min(orderH - L.minOrderH, -slack);
    orderH -= cut;
    slack += cut;
  }
  // ⑤ 最后 → 压卡片高度
  if (slack < 0) {
    const cut = Math.min((cardH - L.minCardH) * 3, -slack);
    cardH -= cut / 3;
    slack += cut;
  }

  const g = Math.floor(gap);
  const c = Math.floor(cardH);
  const o = Math.floor(orderH);
  const used = L.topBar + bannerH + 3 * c + ratingsH + o + GAPS * g;

  return { gap: g, cardH: c, orderH: o, overflow: Math.max(0, used - avail) };
}

/**
 * 按给定的横幅高度，把纵向几何排出来
 */
function buildGeometry(w, h, top, bannerH, heights, ratingsH) {
  const { gap, cardH, orderH } = heights;

  const cards = [];
  let y = top + L.topBar + bannerH;
  for (let i = 0; i < 3; i++) {
    cards.push({ x: 10, y, w: w - 20, h: cardH });
    y += cardH + gap;
  }
  y += gap;
  const ratingsY = y;
  y += ratingsH + gap;
  const orderY = y;
  y += orderH + gap;
  const nextY = Math.min(y, h - L.nextH - L.bottomPad);

  return {
    top,
    topBarH: top + L.topBar,
    cardH,
    gap,
    ratingsH,
    ratingsY,
    orderY,
    orderH,
    nextY,
    nextH: L.nextH,
    cards,
  };
}

/**
 * 计算本帧的完整纵向版面 —— layout() 与 render() 必须共用
 *
 * @param {number} w 逻辑宽
 * @param {number} h 逻辑高
 * @param {number} ratingCount 机构评级条数（0 表示本回合没有评级）
 * @param {object|null} delistEvent 本回合的退市事件（用于给横幅留位）
 */
function tradeFlow(w, h, ratingCount, delistEvent) {
  const top = contentTop(); // 顶部安全区（灵动岛 / 状态栏）
  const ratingsH = ratingCount
    ? L.ratingPadTop + ratingCount * L.ratingRowH + L.ratingPadBottom
    : 0;
  const avail = h - top - L.nextH - L.bottomPad;
  const bp = bannerPlan(delistEvent);

  // 退市横幅优先**占位**（把卡片整体往下推，而不是盖住第一只股票）。
  // 从"两行"到"一行"到"不占位"逐级退化，取第一个排得下的方案。
  const options = bp.full > 0 ? [bp.full, bp.compact, 0] : [0];
  let best = null;
  for (const bh of options) {
    const heights = solveHeights(avail, bh, ratingsH);
    const cand = { bannerH: bh, heights };
    if (!best || heights.overflow < best.heights.overflow) best = cand;
    if (heights.overflow === 0) break;
  }

  const flow = buildGeometry(w, h, top, best.bannerH, best.heights, ratingsH);

  if (!delistEvent) {
    flow.banner = null;
  } else if (best.bannerH > 0) {
    // 已在版面里预留了高度
    flow.banner = {
      x: 8,
      y: flow.topBarH + 4,
      w: w - 16,
      h: best.bannerH - 6,
      reserved: true,
    };
  } else {
    // 屏幕太矮，挤不出位置 → 退化为覆盖层。
    // 优先盖住「机构评级」（本回合信息量最小的一块），
    // 没有评级时才退回盖住顶栏文字 —— **绝不盖住股票卡片**。
    const oy = ratingsH > 0 ? flow.ratingsY : top;
    flow.banner = { x: 8, y: oy, w: w - 16, h: bp.full - 6, reserved: false };
  }

  return flow;
}

/**
 * 卡片右下角"走势图"按钮的几何 —— 卡片高度变化时锚在卡片底部
 */
function chartButtonRect(card, w) {
  return { x: w - 96, y: card.y + card.h - 26, w: 82, h: 22 };
}

export default class TradingScene extends Scene {
  constructor(bus) {
    super('trading');
    this.bus = bus;
    this.selected = null; // 当前选中的股票代码
    this.orderLots = 1; // 待下单手数
    this.toast = null; // 临时提示 { text, until, color }
    this.cardRects = [];
    // 走势图：null = 未展开；否则存"要查看的那只股票代码"
    // （按钮挂在每张股票卡片上，所以弹窗只画这一只）
    this.chartCode = null;
    this.chartAnim = 0; // 走势图生长动画进度
    this.flow = null;
    this.h = 0;
    this.w = 0;
  }

  enter(params) {
    super.enter(params);
    this.selected = this.bus.stockDefs[0].code;
    this.orderLots = 1;
    this.toast = null;
    this.chartCode = null;
    this.chartAnim = 0;
    this.invalidateLayout();
  }

  /** 走势图是否已展开 */
  get showChart() {
    return this.chartCode !== null;
  }

  /**
   * 布局缓存键：影响控件几何的数据
   * 选股变化 / 手数变化 / 评级条数 / 价格与持仓变化 都会让布局失效
   */
  layoutKey() {
    const bus = this.bus;
    const ev = bus.latestDelistEvent();
    return [
      this.selected,
      this.orderLots,
      this.chartCode || '',
      bus.ratings.length,
      bus.portfolio.cash,
      // 退市横幅会占掉一段纵向空间 → 必须纳入布局键
      ev ? `${ev.name}:${ev.held ? 1 : 0}` : '',
      bus.stockDefs.map((d) => bus.priceMap[d.code]).join(','),
      bus.stockDefs.map((d) => bus.portfolio.sharesOf(d.code)).join(','),
    ].join('|');
  }

  /**
   * 打开某只股票的走势图弹窗
   */
  openChart(code) {
    this.chartCode = code;
    this.chartAnim = 0;
    this.invalidateLayout();
  }

  /** 关闭走势图弹窗 */
  closeChart() {
    this.chartCode = null;
    this.invalidateLayout();
  }

  /**
   * 计算所有控件的几何并注册触摸热区
   *
   * 几何全部来自 tradeFlow()，与 render() 同源 —— 不允许在这里
   * 另写一遍纵向累加，否则热区和画面迟早会错位。
   */
  layout(w, h) {
    const bus = this.bus;

    // 数据还没就绪（尚未开局或已重开）时不注册任何热区。
    // 否则 stockDefs 为空时 def 是 undefined，下面读 def.code 会崩。
    // 这在实际运行中不会出现（进入交易场景前一定已开局），
    // 但测试和异常时序下必须安全。
    if (!bus.stockDefs || !bus.stockDefs.length) {
      this.cardRects = [];
      this._chartBtns = {};
      this._orderDef = null;
      this._nextBtn = null;
      this._chartRect = null;
      this._chartClose = null;
      return;
    }

    const flow = tradeFlow(w, h, bus.ratings.length, bus.latestDelistEvent());
    this.flow = flow;

    // ---- 三只股票卡片 ----
    this.cardRects = [];
    // 每张卡片右下角一个"走势图"按钮 —— 点开只看这只股票
    this._chartBtns = {};

    bus.stockDefs.forEach((def, i) => {
      const r = flow.cards[i];
      this.cardRects.push(r);

      // 卡片整体：选中该股
      this.addTouch(r, () => {
        this.selected = def.code;
        this.orderLots = 1;
        this.invalidateLayout();
      });

      // 走势图按钮（压在卡片热区之上 —— 后注册优先命中）
      const cb = chartButtonRect(r, w);
      this._chartBtns[def.code] = cb;
      this.addTouch(cb, () => {
        this.openChart(def.code);
      });
    });

    // ---- 操作区 ----
    const def = bus.stockDefs.find((s) => s.code === this.selected) || bus.stockDefs[0];
    this._orderDef = def;

    const orderY = flow.orderY;
    const price = bus.priceMap[def.code];
    const holding = bus.portfolio.sharesOf(def.code);

    const rowY = orderY + 34;
    const btnW = 38;
    const btnH = 30;
    const minusX = 22;
    const plusX = 22 + btnW + 60;

    this._btnGeometry = {
      minus: { x: minusX, y: rowY, w: btnW, h: btnH },
      plus: { x: plusX, y: rowY, w: btnW, h: btnH },
      max: { x: plusX + btnW + 12, y: rowY, w: 48, h: btnH },
    };

    this.addTouch(this._btnGeometry.minus, () => {
      if (this.orderLots > 1) {
        this.orderLots -= 1;
        this.invalidateLayout();
      }
    });

    this.addTouch(this._btnGeometry.plus, () => {
      const cashLots = maxLots(price, bus.portfolio.cash);
      const holdLots = Math.floor(holding / LOT_SIZE);
      const cap = Math.max(cashLots, holdLots, 1);
      if (this.orderLots < cap) {
        this.orderLots += 1;
        this.invalidateLayout();
      } else {
        this.showToast('无法再加', PALETTE.textDim);
      }
    });

    this.addTouch(this._btnGeometry.max, () => {
      const n = maxLots(price, bus.portfolio.cash);
      if (n > 0) {
        this.orderLots = n;
        this.invalidateLayout();
      } else {
        this.showToast('资金不足一手', STOCK.down);
      }
    });

    const actY = orderY + flow.orderH - 40;
    const actW = (w - 20 - 36) / 2;
    const actH = 36;

    this._btnGeometry.buy = { x: 18, y: actY, w: actW, h: actH };
    this._btnGeometry.sell = { x: 18 + actW + 12, y: actY, w: actW, h: actH };

    // 退市股：不能买卖（热区不注册，点击提示）
    const delisted = bus.isDelisted(def.code);
    if (delisted) {
      this.addTouch(this._btnGeometry.buy, () => {
        this.showToast('该股已退市，无法买入', STOCK.down);
      });
      this.addTouch(this._btnGeometry.sell, () => {
        this.showToast('该股已退市，无法交易', STOCK.down);
      });
    } else {
      this.addTouch(this._btnGeometry.buy, () => {
        const shares = this.orderLots * LOT_SIZE;
        this._doBuy(def, bus.priceMap[def.code], shares);
      });

      this.addTouch(this._btnGeometry.sell, () => {
        const shares = this.orderLots * LOT_SIZE;
        this._doSell(def, bus.priceMap[def.code], shares);
      });
    }

    // ---- 下月按钮 ----
    this._nextBtn = { x: 18, y: flow.nextY, w: w - 36, h: flow.nextH };

    this.addTouch(this._nextBtn, () => {
      this.emit('nextTurn');
    });

    // ---- 走势图弹窗（覆盖层）----
    // 按钮已经挂在每张股票卡片上，这里只负责"打开后"的覆盖层。
    if (this.showChart) {
      // 先注册"点击任何地方关闭"，再注册具体交互（后注册优先命中）
      this.addTouch({ x: 0, y: 0, w, h }, () => {
        this.closeChart();
      });

      const cx = 10;
      const cy = flow.top + 4;
      const cw = w - 20;
      const ch = h - cy - safeBottom() - 6;
      this._chartRect = { x: cx, y: cy, w: cw, h: ch };

      // 关闭按钮 —— 放在**左上角**，与右上角的股价分居两侧，绝不重叠。
      this._chartClose = { x: cx + 12, y: cy + 12, w: 64, h: 24 };
      this.addTouch(this._chartClose, () => {
        this.closeChart();
      });
    } else {
      this._chartRect = null;
      this._chartClose = null;
    }
  }

  /**
   * 显示一条临时提示
   */
  showToast(msg, color = PALETTE.text) {
    this.toast = { text: msg, until: Date.now() + 1600, color };
  }

  update(dt) {
    if (this.toast && Date.now() > this.toast.until) {
      this.toast = null;
    }
    if (this.showChart) {
      // 生长动画：0 → 1，约 0.6 秒走完
      this.chartAnim = Math.min(1, this.chartAnim + dt / 600);
    }
  }

  // ============ 绘制 ============

  render(ctx, w, h) {
    this.w = w;
    this.h = h;

    // 数据未就绪（尚未开局 / 已重开）时只画底色，不碰 stockDefs。
    if (!this.bus.stockDefs || !this.bus.stockDefs.length) {
      rect(0, 0, w, h, PALETTE.bg);
      return;
    }

    const flow = tradeFlow(w, h, this.bus.ratings.length, this.bus.latestDelistEvent());
    this.flow = flow;

    // ---------- 顶栏 ----------
    this._renderTopBar(ctx, w, flow);

    // ---------- 三只股票卡片 ----------
    this._renderStocks(ctx, w, flow);

    // ---------- 机构评级 ----------
    this._renderRatings(ctx, w, flow);

    // ---------- 操作区 ----------
    this._renderOrderPanel(ctx, w, h, flow);

    // ---------- 下月按钮 ----------
    this._renderNextButton(ctx, w, h, flow);

    // ---------- 走势图弹窗 ----------
    if (this.showChart) {
      this._renderChartOverlay(ctx, w, h);
    }

    // ---------- 退市警示条 ----------
    this._renderDelistBanner(ctx, w, h, flow);

    // ---------- 提示 ----------
    if (this.toast) {
      this._renderToast(ctx, w, h, flow);
    }
  }

  /**
   * 退市警示条 —— 本回合有股票爆雷退市时，顶部弹一条醒目横幅
   *
   * 这是熊市关卡最关键的信息：玩家如果没跑，会在这里被告知
   * "你的持仓被强制清算了"。
   *
   * 位置来自 flow.banner（已在版面里**预留**了高度，把股票卡片整体下推），
   * 所以不会盖住第一只股票的卡片。
   */
  _renderDelistBanner(ctx, w, h, flow) {
    const ev = this.bus.latestDelistEvent();
    if (!ev || !flow.banner) return;

    const b = flow.banner;
    const compact = b.h < 40;
    const fill = ev.held ? 'rgba(168,42,24,0.94)' : 'rgba(60,50,30,0.92)';
    rect(b.x, b.y, b.w, b.h, fill);
    strokeRect(b.x, b.y, b.w, b.h, STOCK.up, 2);

    const title = ev.held
      ? `⚠ ${ev.name} 退市爆雷`
      : `${ev.name} 已退市（你未持仓）`;

    if (compact) {
      // 单行版：只保留最要紧的一句
      const tail = ev.held
        ? `持仓 ${ev.shares} 股被清算，亏 ¥${Math.abs(ev.profit).toFixed(0)}`
        : '你成功避开了这颗雷';
      text(`${title} · ${tail}`, b.x + 10, b.y + 20, {
        size: FONT.size.xs,
        color: '#FFFFFF',
        bold: true,
      });
      return;
    }

    text(title, b.x + 8, b.y + 20, {
      size: FONT.size.sm,
      color: '#FFFFFF',
      bold: true,
    });

    if (ev.held) {
      text(
        `持仓 ${ev.shares} 股被强制清算 @ ¥${ev.price.toFixed(2)}，亏损 ¥${Math.abs(ev.profit).toFixed(0)}`,
        b.x + 8,
        b.y + 40,
        { size: FONT.size.xs, color: '#FFD8D0' },
      );
    } else {
      text('该股已终止上市，你成功避开了这颗雷', b.x + 8, b.y + 34, {
        size: FONT.size.xs,
        color: '#E8E0C0',
      });
    }
  }

  /**
   * 卡片右下角的"走势图"小按钮
   *
   * 每个按钮只属于它所在的那只股票 —— 点开只画这一只的走势。
   */
  _renderCardChartButton(ctx, def) {
    const b = this._chartBtns && this._chartBtns[def.code];
    if (!b) return;

    const active = this.chartCode === def.code;

    rect(b.x, b.y, b.w, b.h, active ? PALETTE.accentDim : PALETTE.panelLight);
    strokeRect(b.x, b.y, b.w, b.h, active ? PALETTE.accent : PALETTE.borderLight);
    text('走势图 ▤', b.x + b.w / 2, b.y + 16, {
      size: FONT.size.xs,
      color: active ? PALETTE.textBright : PALETTE.text,
      align: 'center',
    });
  }

  /**
   * 单只股票的走势图弹窗
   *
   * 只画"按钮所在那只"股票的价格曲线：
   * 坐标轴 + 刻度 + 网格 + 末端箭头，颜色跟随该股当前涨跌（涨红跌绿）。
   */
  _renderChartOverlay(ctx, w, h) {
    const bus = this.bus;
    const def = bus.stockDefs.find((d) => d.code === this.chartCode);
    const r = this._chartRect || { x: 10, y: contentTop() + 4, w: w - 20, h: h - contentTop() - 40 };

    // 遮罩
    ctx.fillStyle = 'rgba(0,0,0,0.82)';
    ctx.fillRect(0, 0, w, h);

    // 面板
    panel(r.x, r.y, r.w, r.h, { fill: PALETTE.panel, border: PALETTE.accent });

    if (!def) return;

    const price = bus.priceMap[def.code];
    const change = bus.changeMap[def.code] || 0;
    const changeColor = change > 0 ? STOCK.up : change < 0 ? STOCK.down : STOCK.flat;

    // ---- 关闭按钮（左上角）----
    // 与右上角的股价分居左右两侧，彻底避免重叠。
    const cb = this._chartClose || { x: r.x + 12, y: r.y + 12, w: 64, h: 24 };
    rect(cb.x, cb.y, cb.w, cb.h, PALETTE.panelLight);
    strokeRect(cb.x, cb.y, cb.w, cb.h, PALETTE.borderLight);
    text('✕ 关闭', cb.x + cb.w / 2, cb.y + 17, {
      size: FONT.size.xs,
      color: PALETTE.text,
      align: 'center',
    });

    // ---- 标题：这只股票的名字（紧跟在关闭按钮右侧）----
    const titleX = cb.x + cb.w + 14;
    text(`${def.name} 走势`, titleX, r.y + 24, {
      size: FONT.size.md,
      color: PALETTE.accent,
      bold: true,
    });
    text(`${def.code} · ${SECTORS[def.sector] || def.sector || ''}`, titleX, r.y + 44, {
      size: FONT.size.xs,
      color: PALETTE.textDim,
    });

    // ---- 退市标记 ----
    if (bus.isDelisted(def.code)) {
      rect(titleX, r.y + 54, 70, 18, STOCK.up);
      text('已退市清算', titleX + 35, r.y + 67, {
        size: FONT.size.xs,
        color: '#FFFFFF',
        align: 'center',
        bold: true,
      });
    }

    // ---- 当前价 + 涨跌（右上角，涨红跌绿）----
    text(`¥${price.toFixed(2)}`, r.x + r.w - 14, r.y + 28, {
      size: FONT.size.lg,
      color: changeColor,
      align: 'right',
      bold: true,
    });
    text(`${change >= 0 ? '+' : ''}${change.toFixed(2)}%`, r.x + r.w - 14, r.y + 50, {
      size: FONT.size.sm,
      color: changeColor,
      align: 'right',
    });

    // ---- 折线图 ----
    const hist = bus.simulator.historyOf(def.code);
    if (hist.length < 2) {
      text('本月还没有走势数据', r.x + r.w / 2, r.y + r.h / 2, {
        size: FONT.size.sm,
        color: PALETTE.textDim,
        align: 'center',
      });
    } else {
      // 真实月度收盘价（结算价）—— 走势图的"骨架"
      const closes = hist.map((p) => p.price);

      // 颜色跟随整体涨跌：相对起始价（用真实收盘价判断，不受波动影响）
      const first = closes[0];
      const last = closes[closes.length - 1];
      const trendUp = last >= first;
      const lineColor = trendUp ? STOCK.up : STOCK.down;

      // ---- 展开成带月内波动的高密度路径 ----
      // INNER 个中间点 / 相邻两个收盘价；用股票代码做种子 → 每股恒定、跨局恒定。
      const INNER = 5;
      const wavy = wavyPath(closes, def.code, { inner: INNER });

      // 横轴归一化位置：第 i 个真实收盘价落在 i/(n-1)，
      // 月内波动点插在相邻收盘价之间（等分），于是月份标签仍对齐到正确位置。
      const positions = [];
      const labelAt = [];
      const monthLabels = [];
      for (let i = 0; i < closes.length; i++) {
        positions.push(i / (closes.length - 1));
        labelAt.push(positions.length - 1);
        monthLabels.push(i === 0 ? '开' : monthName(i));
        for (let k = 1; k <= INNER && i < closes.length - 1; k++) {
          positions.push((i + k / (INNER + 1)) / (closes.length - 1));
        }
      }

      // 纵轴范围：取**实际画出来的那条路径**的极值。
      //
      // 曾经只按月度收盘价定范围（理由是不想让月内抖动"撑大"纵轴），
      // 但当全年振幅本来就很小（横盘股）时，月内抖动的幅度会超过
      // 全年振幅 —— 折线会被线性外推，直接冲出绘图区甚至冲出面板。
      // 让范围跟着真实路径走，既不会冲出，波动也照样看得见。
      const minV = Math.min(...wavy);
      const maxV = Math.max(...wavy);

      // 「最高 / 最低」仍然报**真实收盘价** —— 那才是"这一年到过哪"的答案
      const hiClose = Math.max(...closes);
      const loClose = Math.min(...closes);

      const chartTop = r.y + 86;
      const chartH = Math.max(100, r.y + r.h - chartTop - 84);

      // 单序列图例（含区间统计）
      chartLegend(ctx, r.x + 14, chartTop - 20, r.w - 28, [{
        name: def.name,
        color: lineColor,
        change: first > 0 ? last / first - 1 : 0,
      }], { lineH: 18 });

      lineChart(ctx, {
        x: r.x + 10,
        y: chartTop,
        w: r.w - 24,
        h: chartH,
        series: [{
          name: def.name,
          color: lineColor,
          values: wavy,
        }],
        min: minV,
        max: maxV,
        yTicks: 4,
        xLabels: monthLabels,
        positions,
        labelAt,
        // 12 个月标签太挤，隔一个显示
        xTickEvery: closes.length > 8 ? 2 : 1,
        showGrid: true,
        endArrow: true,
        animate: this.chartAnim,
      });

      // 区间统计
      const statY = chartTop + chartH + 22;
      text(`最高 ¥${maxV.toFixed(2)}`, r.x + 14, statY, {
        size: FONT.size.xs,
        color: STOCK.up,
      });
      text(`最低 ¥${minV.toFixed(2)}`, r.x + r.w - 14, statY, {
        size: FONT.size.xs,
        color: STOCK.down,
        align: 'right',
      });
    }

    // ---- 底部关闭提示 ----
    text('点击任意处关闭', r.x + r.w / 2, r.y + r.h - 16, {
      size: FONT.size.xs,
      color: PALETTE.textDim,
      align: 'center',
    });
  }

  /**
   * 顶栏：月份、现金、总资产
   *
   * 底色从 y=0 铺起（盖住状态栏区域，不留白），
   * 但**文字**从 top 之下开始 —— 否则会被灵动岛遮住。
   */
  _renderTopBar(ctx, w, flow) {
    const barH = flow.topBarH;
    const top = flow.top;

    rect(0, 0, w, barH, PALETTE.panel);

    const bus = this.bus;
    const total = bus.portfolio.totalAssets(bus.priceMap);
    const isLast = bus.turn >= bus.level.turns;

    // 月份 —— 用中文月份名，避免玩家只看到 "12 / 12" 这种无感的数字
    text(`${monthName(bus.turn)}`, 14, top + 18, {
      size: FONT.size.md,
      color: isLast ? STOCK.up : PALETTE.accent,
      bold: true,
    });
    text(isLast ? '最后一个月 · 月末平仓' : `第 ${bus.turn} / ${bus.level.turns} 个月`, 14, top + 38, {
      size: FONT.size.xs,
      color: isLast ? STOCK.up : PALETTE.textDim,
    });

    // 现金
    text('现金', w - 14, top + 16, {
      size: FONT.size.xs,
      color: PALETTE.textDim,
      align: 'right',
    });
    text(`¥${bus.portfolio.cash.toFixed(0)}`, w - 14, top + 38, {
      size: FONT.size.md,
      color: PALETTE.text,
      align: 'right',
      bold: true,
    });

    // 总资产（居中）
    const profit = total - bus.level.initCash;
    const profitColor = profit > 0 ? STOCK.up : profit < 0 ? STOCK.down : STOCK.flat;
    text('总资产', w / 2 + 30, top + 16, {
      size: FONT.size.xs,
      color: PALETTE.textDim,
      align: 'center',
    });
    text(`¥${total.toFixed(0)}`, w / 2 + 30, top + 38, {
      size: FONT.size.md,
      color: profitColor,
      align: 'center',
      bold: true,
    });

    // 底线
    rect(0, barH, w, PIXEL, PALETTE.border);
  }

  /**
   * 三只股票卡片
   */
  _renderStocks(ctx, w, flow) {
    const bus = this.bus;

    bus.stockDefs.forEach((def, i) => {
      const card = flow.cards[i];
      if (!card) return;

      const y = card.y;
      const isSel = def.code === this.selected;
      const price = bus.priceMap[def.code];
      const change = bus.changeMap[def.code] || 0;
      const delisted = bus.isDelisted(def.code);

      // 卡片（退市股用暗色 + 红边）
      panel(10, y, w - 20, card.h, {
        fill: delisted ? '#241A1A' : isSel ? PALETTE.panelLight : PALETTE.panel,
        border: delisted ? STOCK.up : isSel ? PALETTE.accent : PALETTE.border,
      });

      // 退市徽章 —— 放在**左侧**、与股名同行。
      // （原先放在右上角，会和右对齐的股价撞在一起。）
      const nameX = delisted ? 84 : 22;
      if (delisted) {
        rect(22, y + 13, 50, 18, STOCK.up);
        text('已退市', 47, y + 26, {
          size: FONT.size.xs,
          color: '#FFFFFF',
          align: 'center',
          bold: true,
        });
      }

      // 名称 + 行业
      text(def.name, nameX, y + 26, {
        size: FONT.size.md,
        color: delisted ? PALETTE.textDim : PALETTE.text,
        bold: true,
      });
      const sectorName = SECTORS[def.sector] || def.sector || '';
      text(`${def.code} · ${sectorName}`, 22, y + 46, {
        size: FONT.size.xs,
        color: PALETTE.textDim,
      });

      // 持仓（锚在卡片底部，随自适应高度一起走）
      const shares = bus.portfolio.sharesOf(def.code);
      if (shares > 0) {
        const avg = bus.portfolio.avgCostOf(def.code);
        text(`持仓 ${shares} 股 · 成本 ${avg.toFixed(2)}`, 22, y + card.h - 16, {
          size: FONT.size.xs,
          color: delisted ? STOCK.up : PALETTE.accent,
        });
      } else {
        text(delisted ? '已强制清算' : '未持仓', 22, y + card.h - 16, {
          size: FONT.size.xs,
          color: PALETTE.textDim,
        });
      }

      // 价格 + 涨跌（涨红跌绿）
      const changeColor = delisted
        ? PALETTE.textDim
        : change > 0
          ? STOCK.up
          : change < 0
            ? STOCK.down
            : STOCK.flat;
      const arrow = change > 0 ? '↑' : change < 0 ? '↓' : '—';

      text(`¥${price.toFixed(2)}`, w - 22, y + 28, {
        size: FONT.size.lg,
        color: changeColor,
        align: 'right',
        bold: true,
      });
      text(
        delisted ? '退市清算' : `${arrow} ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`,
        w - 22,
        y + 50,
        {
          size: FONT.size.sm,
          color: changeColor,
          align: 'right',
        },
      );

      // 右下角"走势图"按钮 —— 已取代原来的内嵌迷你 canvas。
      this._renderCardChartButton(ctx, def);
    });
  }

  /**
   * 机构评级面板
   */
  _renderRatings(ctx, w, flow) {
    const bus = this.bus;
    if (!bus.ratings.length) return;

    const y = flow.ratingsY;
    panel(10, y, w - 20, flow.ratingsH);

    // 机构署名
    text('机构评级', 22, y + 18, {
      size: FONT.size.sm,
      color: PALETTE.accent,
      bold: true,
    });

    let ry = y + L.ratingPadTop;
    bus.ratings.forEach((r) => {
      const rt = r.rating;
      text(r.name, 22, ry + 14, {
        size: FONT.size.xs,
        color: PALETTE.text,
      });
      text(`${rt.label} ${rt.arrow}`, w - 22, ry + 14, {
        size: FONT.size.xs,
        color: rt.color,
        align: 'right',
        bold: true,
      });
      ry += L.ratingRowH;
    });
  }

  /**
   * 操作区：手数调整 + 买入/卖出
   */
  _renderOrderPanel(ctx, w, h, flow) {
    const bus = this.bus;
    const def = bus.stockDefs.find((s) => s.code === this.selected);
    if (!def) return;

    const y = flow.orderY;
    const panelH = flow.orderH;

    const price = bus.priceMap[def.code];
    const shares = this.orderLots * LOT_SIZE;
    const need = costToBuy(price, shares);
    const holding = bus.portfolio.sharesOf(def.code);
    const delisted = bus.isDelisted(def.code);

    panel(10, y, w - 20, panelH, {
      border: delisted ? STOCK.up : PALETTE.border,
    });

    // 当前标的
    const sectorName = SECTORS[def.sector] || def.sector || '';
    text(`交易：${def.name}`, 22, y + 22, {
      size: FONT.size.sm,
      color: delisted ? STOCK.up : PALETTE.accent,
      bold: true,
    });
    text(sectorName, w - 22, y + 22, {
      size: FONT.size.xs,
      color: PALETTE.textDim,
      align: 'right',
    });

    const actY = y + panelH - 40;
    const actW = (w - 20 - 36) / 2;
    const actH = 36;

    // ---- 退市股：整块替换为"已退市"说明 ----
    if (delisted) {
      text('该股已退市清算，无法继续交易', w / 2, y + 60, {
        size: FONT.size.sm,
        color: STOCK.up,
        align: 'center',
        bold: true,
      });
      text(
        holding > 0 ? `仍持有 ${holding} 股（将于年末结算）` : '你已不再持有该股',
        w / 2,
        y + 84,
        { size: FONT.size.xs, color: PALETTE.textDim, align: 'center' },
      );

      button(18, actY, actW, actH, '买 入', { size: FONT.size.sm, disabled: true });
      button(18 + actW + 12, actY, actW, actH, '卖 出', { size: FONT.size.sm, disabled: true });
      return;
    }

    // ---- 手数调节 ----
    const rowY = y + 34;
    const btnW = 38;
    const btnH = 30;
    const minusX = 22;
    const plusX = 22 + btnW + 60;

    button(minusX, rowY, btnW, btnH, '−', {
      size: FONT.size.md,
      disabled: this.orderLots <= 1,
    });

    text(`${this.orderLots} 手`, minusX + btnW + 32, rowY + 21, {
      size: FONT.size.md,
      color: PALETTE.text,
      align: 'center',
      bold: true,
    });

    button(plusX, rowY, btnW, btnH, '+', {
      size: FONT.size.md,
    });

    // 快捷：最大可买
    button(plusX + btnW + 12, rowY, 48, btnH, '满仓', {
      size: FONT.size.xs,
    });

    // ---- 信息行（不与买卖按钮重叠：按钮在 panelH-40 处）----
    const infoY = rowY + 54;
    text(`${shares} 股 · 需 ¥${need.toFixed(0)}`, 22, infoY, {
      size: FONT.size.xs,
      color: PALETTE.textDim,
    });
    text(`持仓 ${holding} 股`, w - 22, infoY, {
      size: FONT.size.xs,
      color: PALETTE.textDim,
      align: 'right',
    });

    // 梭哈预警 —— 买入后总资产会跌破一手成本时提示（不硬拦，只警告）
    const warn = bus.wouldBankruptAfterBuy(def.code, price, shares);
    if (warn.wouldBankrupt && bus.portfolio.cash >= need) {
      text(
        `⚠ 买后总资产 ¥${warn.afterTotal.toFixed(0)} < 破产线 ¥${warn.line.toFixed(0)}`,
        22,
        infoY + 22,
        { size: FONT.size.xs, color: STOCK.up },
      );
    }

    // ---- 买入 / 卖出 ----
    button(18, actY, actW, actH, '买 入', {
      color: STOCK.up,
      textColor: '#FFFFFF',
      border: '#FF6A50',
      size: FONT.size.sm,
    });

    button(18 + actW + 12, actY, actW, actH, '卖 出', {
      color: STOCK.down,
      textColor: '#FFFFFF',
      border: '#50E090',
      size: FONT.size.sm,
      disabled: holding <= 0,
    });
  }

  /**
   * 下月按钮
   *
   * 最后一个月要有明确的"结束"语义 —— 否则玩家点下去直接结算，
   * 会产生"关卡怎么突然结束了"的困惑。
   */
  _renderNextButton(ctx, w, h, flow) {
    const bh = flow.nextH;
    const by = flow.nextY;

    const isLast = this.bus.turn >= this.bus.level.turns;

    button(18, by, w - 36, bh, isLast ? '结束本年 ▶ 结算' : `进入${monthName(this.bus.turn + 1)} ▶`, {
      color: isLast ? STOCK.up : PALETTE.accentDim,
      textColor: isLast ? '#FFFFFF' : PALETTE.textBright,
      border: isLast ? '#FF6A50' : PALETTE.accent,
      size: FONT.size.md,
    });
  }

  /**
   * 临时提示
   */
  _renderToast(ctx, w, h, flow) {
    const t = this.toast;
    const tw = Math.min(w * 0.7, w - 32);
    const th = 36;
    const tx = (w - tw) / 2;
    const ty = Math.max(flow.topBarH + 24, h * 0.42);

    rect(tx, ty, tw, th, 'rgba(0,0,0,0.85)');
    rect(tx, ty, PIXEL, th, t.color);
    text(t.text, w / 2, ty + 23, {
      size: FONT.size.sm,
      color: t.color,
      align: 'center',
      bold: true,
    });
  }

  // ============ 交易动作 ============

  _doBuy(def, price, shares) {
    const bus = this.bus;
    const check = validateBuy(price, shares, bus.portfolio.cash);
    if (!check.ok) {
      this.showToast(check.reason, STOCK.down);
      return;
    }

    const r = bus.portfolio.buy(def.code, price, shares);
    bus.records.push({
      turn: bus.turn,
      code: def.code,
      name: def.name,
      action: 'buy',
      shares,
      price,
      fee: r.fee,
    });

    this.showToast(`买入 ${shares} 股，手续费 ¥${r.fee.toFixed(1)}`, STOCK.up);
    this.orderLots = 1;
    this.invalidateLayout(); // 持仓与现金变化 → 控件可用状态需刷新

    // 通知外部重新判定（买入后总资产几乎不变，通常不会触发破产，
    // 但仍走统一入口，保证判定逻辑只有一处）
    this.emit('afterTrade', { action: 'buy', code: def.code });
  }

  _doSell(def, price, shares) {
    const bus = this.bus;
    const holding = bus.portfolio.sharesOf(def.code);

    // 卖出数量不足一手时，允许全部卖出（零股清仓）
    let sellShares = shares;
    if (shares > holding) {
      if (holding > 0 && shares - holding < LOT_SIZE && this.orderLots === 1) {
        sellShares = holding;
      } else {
        this.showToast('持仓不足', STOCK.down);
        return;
      }
    }

    const check = validateSell(sellShares, holding);
    if (!check.ok) {
      this.showToast(check.reason, STOCK.down);
      return;
    }

    const r = bus.portfolio.sell(def.code, price, sellShares);
    bus.records.push({
      turn: bus.turn,
      code: def.code,
      name: def.name,
      action: 'sell',
      shares: sellShares,
      price,
      fee: r.fee,
      profit: r.profit,
    });

    const pc = r.profit >= 0 ? STOCK.up : STOCK.down;
    this.showToast(
      `卖出 ${sellShares} 股 ${r.profit >= 0 ? '盈利' : '亏损'} ¥${Math.abs(r.profit).toFixed(0)}`,
      pc,
    );
    this.orderLots = 1;
    this.invalidateLayout(); // 持仓与现金变化 → 控件可用状态需刷新

    // 卖出后重新判定破产：卖出会回笼现金，但若已无翻盘手段则在此出局
    this.emit('afterTrade', { action: 'sell', code: def.code });
  }
}
