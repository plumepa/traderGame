/**
 * 主菜单场景 —— 关卡选择 + 开始交易
 *
 * 第三版：**不告诉玩家年景**。
 * 菜单只显示「第 N 关」与一段氛围文案，年份与市场风格
 * （牛/熊/震荡）都是内部信息 —— 玩家必须自己从价格与新闻里判断。
 *
 * 股票与新闻同样每局随机（由 DataBus.start → composeGame 抽取）。
 *
 * 版面（第二版）：
 *   ① 顶部让出安全区 —— 标题从 contentTop() 之下开始，不会被灵动岛遮住
 *   ② 底部让出安全区 —— "涨=红 跌=绿"提示不会被 Home 指示条压住
 *   ③ 面板高度按开场白实际行数算（开场白里有 '\n'，必须真的换行）
 */

import Scene from '../base/scene';
import { PALETTE, FONT, PIXEL } from '../styles/palette';
import { contentTop, contentBottom } from '../styles/layout';
import { text, textWrap, wrapLines, panel, button, rect } from '../styles/widgets';
import { LEVELS } from '../data/levels';

/** 关卡标题里的「第 N 关 · 」前缀 —— 面板上已有编号徽章，这里去掉避免重复 */
function shortTitle(title) {
  return String(title || '').replace(/^第\s*\d+\s*关\s*[·・]\s*/, '');
}

/**
 * 菜单版面 —— layout() 与 render() 共用
 * @param {number} w 逻辑宽
 * @param {number} h 逻辑高
 * @param {number} introLines 开场白折行后的行数
 */
function menuFlow(w, h, introLines) {
  const top = contentTop();
  const bottom = contentBottom(h);

  const px = 68;
  const pw = w - 136;

  // ---- 标题块 ----
  const titleY = top + 26; // 'PIXEL' 基线
  const title2Y = titleY + 48; // 'TRADER' 基线
  const subY = title2Y + 46; // 副标题基线

  // ---- 关卡面板（高度跟着开场白走）----
  const ph = 54 + introLines * 18 + 30;
  const py = Math.max(subY + 30, h * 0.30);

  // 左右箭头：与面板垂直居中
  const arrowY = py + ph / 2 - 22;

  // ---- 开始按钮：夹在"说明文字之后"与"底部安全区之前"之间 ----
  const bh = 52;
  const bw = Math.min(220, w - 90);
  const infoY1 = py + ph + 28;
  const infoY2 = infoY1 + 22;
  const infoY3 = infoY2 + 20;

  const lo = infoY3 + 30;
  const hi = bottom - bh - 50;
  const by = Math.max(lo, Math.min(lo + (hi - lo) * 0.5, hi));

  return {
    top,
    bottom,
    px,
    pw,
    ph,
    py,
    titleY,
    title2Y,
    subY,
    arrowY,
    prev: { x: 20, y: arrowY, w: 44, h: 44 },
    next: { x: w - 64, y: arrowY, w: 44, h: 44 },
    infoY1,
    infoY2,
    infoY3,
    btn: { x: w / 2 - bw / 2, y: by, w: bw, h: bh },
  };
}

export default class MenuScene extends Scene {
  constructor() {
    super('menu');
    this.levelIndex = 0; // 当前选中的关卡下标
    this.blink = 0;
  }

  enter(params) {
    super.enter(params);
    this.blink = 0;
  }

  get level() {
    return LEVELS[this.levelIndex] || LEVELS[0];
  }

  /** 布局失效键：关卡切换时按钮文案/热区要重建 */
  layoutKey() {
    return this.levelIndex;
  }

  /** 当前关卡开场白的折行结果（面板高度依赖它） */
  _introLines(w) {
    const pw = w - 136;
    return wrapLines(this.level.intro, pw - 28, { size: FONT.size.xs });
  }

  /**
   * 布局：注册关卡左右切换 + 开始按钮
   */
  layout(w, h) {
    const flow = menuFlow(w, h, this._introLines(w).length);
    this.flow = flow;

    this._prev = flow.prev;
    this._next = flow.next;

    this.addTouch(this._prev, () => {
      this.levelIndex = (this.levelIndex - 1 + LEVELS.length) % LEVELS.length;
      this.invalidateLayout();
    });
    this.addTouch(this._next, () => {
      this.levelIndex = (this.levelIndex + 1) % LEVELS.length;
      this.invalidateLayout();
    });

    this._btn = flow.btn;
    this.addTouch(this._btn, () => {
      this.emit('startGame', this.level.id);
    });
  }

  update(dt) {
    this.blink += dt;
  }

  render(ctx, w, h) {
    const level = this.level;
    const flow = menuFlow(w, h, this._introLines(w).length);
    this.flow = flow;

    const cx = w / 2;

    // ---- 标题 ----
    text('PIXEL', cx, flow.titleY, {
      size: FONT.size.xxl,
      color: PALETTE.accent,
      align: 'center',
      bold: true,
    });
    text('TRADER', cx, flow.title2Y, {
      size: FONT.size.xxl,
      color: PALETTE.accent,
      align: 'center',
      bold: true,
    });
    text('股 市 生 存 模 拟', cx, flow.subY, {
      size: FONT.size.sm,
      color: PALETTE.textDim,
      align: 'center',
    });

    // ---- 左右箭头 ----
    button(flow.prev.x, flow.prev.y, flow.prev.w, flow.prev.h, '‹', {
      color: PALETTE.panelLight,
      textColor: PALETTE.text,
      border: PALETTE.border,
      size: FONT.size.lg,
    });
    button(flow.next.x, flow.next.y, flow.next.w, flow.next.h, '›', {
      color: PALETTE.panelLight,
      textColor: PALETTE.text,
      border: PALETTE.border,
      size: FONT.size.lg,
    });

    // ---- 关卡面板 ----
    const { px, py, pw, ph } = flow;
    panel(px, py, pw, ph, { fill: PALETTE.panel, border: PALETTE.accent });

    // 关卡序号标签
    //
    // ⚠️ 这里**绝不能**显示年份或市场风格（牛市/熊市/震荡）。
    // 一旦告诉玩家"这是 1996 全民炒股"，他就不用看盘了 —— 直接背答案。
    // 本作的乐趣在于「从价格与新闻里自己判断市场性质」，
    // 所以玩家看到的只有关卡编号，年景是内部信息。
    rect(px + 12, py + 16, 56, 20, PALETTE.accent);
    text(`第 ${level.index} 关`, px + 40, py + 31, {
      size: FONT.size.xs,
      color: '#FFFFFF',
      align: 'center',
      bold: true,
    });

    text(shortTitle(level.title), px + 80, py + 32, {
      size: FONT.size.md,
      color: PALETTE.text,
      bold: true,
    });

    textWrap(level.intro, px + 14, py + 56, pw - 28, 18, {
      size: FONT.size.xs,
      color: PALETTE.textDim,
    });

    // 关卡指示点
    const dotY = py + ph - 20;
    const dotTotal = LEVELS.length;
    const dotGap = 18;
    const dotStart = px + pw / 2 - ((dotTotal - 1) * dotGap) / 2;
    for (let i = 0; i < dotTotal; i++) {
      const on = i === this.levelIndex;
      rect(dotStart + i * dotGap - 3, dotY - 3, 6, 6, on ? PALETTE.accent : PALETTE.border);
    }

    // ---- 说明 ----
    text(`初始资金 ¥${level.initCash} · 交易 ${level.turns} 个月后结算`, px, flow.infoY1, {
      size: FONT.size.xs,
      color: PALETTE.accent,
    });
    text('每局随机抽出 3 只不同行业的股票', px, flow.infoY2, {
      size: FONT.size.xs,
      color: PALETTE.textDim,
    });
    text('新闻真假难辨 · 看清消息与股票是否相关', px, flow.infoY3, {
      size: FONT.size.xs,
      color: PALETTE.textDim,
    });

    // ---- 开始按钮 ----
    const b = flow.btn;
    button(b.x, b.y, b.w, b.h, '开 始 交 易', {
      color: PALETTE.accentDim,
      textColor: PALETTE.textBright,
      border: PALETTE.accent,
      size: FONT.size.lg,
    });

    if (Math.floor(this.blink / 600) % 2 === 0) {
      text('点击按钮开始你的一年', cx, b.y + b.h + 26, {
        size: FONT.size.xs,
        color: PALETTE.textDim,
        align: 'center',
      });
    }

    // ---- 配色说明（教学）—— 让开底部安全区 ----
    text('涨 = 红    跌 = 绿', cx, flow.bottom - 6, {
      size: FONT.size.xs,
      color: PALETTE.textDim,
      align: 'center',
    });
  }
}
