/**
 * 新闻插播弹层 —— 复古报纸排版
 *
 * 覆盖在交易场景之上。玩家点任意处关闭。
 * 这是每月的强制信息停顿，让玩家有机会重新评估局面。
 *
 * 版面（第二版）：
 *   卡片高度按正文实际行数算（正文里有 '\n'，必须真的换行），
 *   并在 contentTop / contentBottom 之间垂直居中 —— 不会被灵动岛或
 *   Home 指示条压住。
 */

import Scene from '../base/scene';
import { PALETTE, FONT, monthName } from '../styles/palette';
import { contentTop, contentBottom } from '../styles/layout';
import { text, textWrap, wrapLines, measure, rect, strokeRect } from '../styles/widgets';
import { SECTORS } from '../data/pool';

const HEAD_TITLE = '盘 面 快 讯';

export default class NewsFlashScene extends Scene {
  constructor() {
    super('newsflash');
    this.news = null;
    this.turn = 0;
    this.holdings = []; // 本局三只股票（用于"相关/无关"提示）
    this.appearAt = 0;
    this.elapsed = 0;
  }

  enter(params) {
    super.enter(params);
    this.news = params && params.news ? params.news : null;
    // 回合号用于报头显示月份（十二月 → 玩家知道自己打到哪了）
    this.turn = params && params.turn ? params.turn : 0;
    // 本局三只股票 —— 让玩家能自己对照"这条新闻跟我的股有关吗"
    this.holdings = (params && params.stocks) || [];
    this.elapsed = 0;
  }

  /**
   * 布局：整屏可点关闭
   */
  layout(w, h) {
    this.addTouch({ x: 0, y: 0, w, h }, () => {
      this.emit('closed');
    });
  }

  update(dt) {
    this.elapsed += dt;
  }

  /**
   * 报纸卡片的纵向骨架 —— 高度跟着实际行数走
   */
  _cardLayout(w, h) {
    const news = this.news;
    const cw = w - 40;
    const cx = 20;
    const innerW = cw - 28;

    const hlLines = wrapLines(news ? news.headline : '', innerW, {
      size: FONT.size.md,
      bold: true,
    });
    const bodyLines = wrapLines((news && news.body) || '', innerW, { size: FONT.size.sm });

    const hlCount = Math.max(1, hlLines.length);
    const bodyCount = Math.max(1, bodyLines.length);
    const tagCount = this.holdings.length ? 3 : 1;

    const HEAD_BASE = 34; // 报头基线（相对卡片顶）
    const RULE_Y = 48; // 报头分隔线
    const HL_TOP = 78; // 标题首行基线
    const HL_LINE = 26;
    const BODY_GAP = 14;
    const BODY_LINE = 20;
    const TAG_GAP = 18;
    const TAG_LINE = 20;
    const FOOT = 36;

    const hlBottom = HL_TOP + (hlCount - 1) * HL_LINE;
    const bodyTop = hlBottom + BODY_GAP + 20;
    const bodyBottom = bodyTop + (bodyCount - 1) * BODY_LINE;
    const tagRule = bodyBottom + TAG_GAP;
    const tagTop = tagRule + 24;
    const tagBottom = tagTop + (tagCount - 1) * TAG_LINE;
    const ch = tagBottom + FOOT;

    // 在安全区之间垂直居中
    const top = contentTop();
    const bottom = contentBottom(h);
    const cy = Math.max(top + 8, top + (bottom - top - ch) / 2);

    return {
      cx, cw, ch, cy, innerW,
      headBase: cy + HEAD_BASE,
      ruleY: cy + RULE_Y,
      hlTop: cy + HL_TOP,
      hlLine: HL_LINE,
      bodyTop: cy + bodyTop,
      bodyLine: BODY_LINE,
      tagRule: cy + tagRule,
      tagTop: cy + tagTop,
      tagLine: TAG_LINE,
      footY: cy + ch - 18,
    };
  }

  render(ctx, w, h) {
    const news = this.news;
    if (!news) return;

    // ---- 遮罩 ----
    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.fillRect(0, 0, w, h);

    const L = this._cardLayout(w, h);

    // ---- 报纸卡片 ----
    // 纸张底色（米黄，制造旧报纸质感）
    rect(L.cx, L.cy, L.cw, L.ch, '#E8E0C8');
    strokeRect(L.cx, L.cy, L.cw, L.ch, '#8A7A50', 2);

    // 报头
    text(HEAD_TITLE, L.cx + 14, L.headBase, {
      size: FONT.size.lg,
      color: '#3A3020',
      bold: true,
      shadow: false,
    });

    // 月份（紧跟报头右侧）—— 让玩家知道当前是几月，尤其是"十二月"
    // 位置用实际字宽算，避免报头字号变化后与月份叠在一起
    if (this.turn > 0) {
      const isLast = this.turn % 12 === 0;
      const titleW = measure(HEAD_TITLE, { size: FONT.size.lg, bold: true });
      text(monthName(this.turn), L.cx + 14 + titleW + 16, L.headBase - 2, {
        size: FONT.size.sm,
        color: isLast ? '#A82A18' : '#6A5A3A',
        bold: isLast,
        shadow: false,
      });
    }

    // 来源（右上角小字）
    text(news.source || '消息', L.cx + L.cw - 14, L.headBase - 4, {
      size: FONT.size.xs,
      color: '#6A5A3A',
      align: 'right',
      shadow: false,
    });

    // 分隔线
    rect(L.cx + 12, L.ruleY, L.cw - 24, 2, '#8A7A50');

    // 标题
    textWrap(news.headline, L.cx + 14, L.hlTop, L.innerW, L.hlLine, {
      size: FONT.size.md,
      color: '#1A1408',
      bold: true,
      shadow: false,
    });

    // 正文
    const bodyLines = textWrap(news.body || '', L.cx + 14, L.bodyTop, L.innerW, L.bodyLine, {
      size: FONT.size.sm,
      color: '#3A3020',
      shadow: false,
    });

    // 关联标的提示（复古报纸的"相关报道"感）
    // 新闻按行业匹配，这里显示**消息所属行业**，
    // 并列出本局三只股票的行业 —— 让玩家自己判断"跟我有关吗"。
    rect(L.cx + 14, L.tagRule, L.cw - 28, 2, '#B8A878');

    const newsSector = news.sector === 'macro'
      ? '大盘'
      : SECTORS[news.sector] || news.sector;
    text(`消息板块：${newsSector}`, L.cx + 14, L.tagTop, {
      size: FONT.size.xs,
      color: '#5A4A2A',
      shadow: false,
    });

    // 你的持仓行业（用于对照）
    if (this.holdings.length) {
      const held = this.holdings
        .map((s) => SECTORS[s.sector] || s.sector)
        .join(' / ');
      text(`你的持仓行业：${held}`, L.cx + 14, L.tagTop + L.tagLine, {
        size: FONT.size.xs,
        color: '#3A3020',
        shadow: false,
      });

      // 相关性提示（不告诉玩家真假，只提示"消息板块是否命中"）
      const hit = news.sector === 'macro'
        || this.holdings.some((s) => s.sector === news.sector);
      text(
        hit ? '※ 该消息涉及你的持仓板块' : '※ 该消息未涉及你的持仓板块',
        L.cx + 14,
        L.tagTop + L.tagLine * 2,
        { size: FONT.size.xs, color: hit ? '#A82A18' : '#6A5A3A', shadow: false },
      );
    }

    // ---- 关闭提示 ----
    if (Math.floor(this.elapsed / 600) % 2 === 0) {
      text('点击任意处继续 →', L.cx + L.cw / 2, L.footY, {
        size: FONT.size.xs,
        color: '#5A4A2A',
        align: 'center',
        shadow: false,
      });
    }
  }
}
