/**
 * 结算场景
 *
 * 无通关目标，结局由最终收益决定：
 *   win      —— 到期结算且盈利（年末已强制平仓）
 *   lose     —— 到期结算但亏损 / 持平
 *   bankrupt —— 总资产低于一手成本，提前出局
 *
 * 版面（第二版）：
 *   纵向骨架由 _flow() 统一计算，layout() 与 render() 共用；
 *   顶部从 contentTop() 之下开始（让开灵动岛），
 *   底部按钮夹在 contentBottom() 之上（让开 Home 指示条）。
 */

import Scene from '../base/scene';
import { PALETTE, FONT, STOCK, monthName } from '../styles/palette';
import { contentTop, contentBottom } from '../styles/layout';
import { text, textWrap, wrapLines, panel, button, rect } from '../styles/widgets';
import { lineChart, chartLegend, wavyPath } from '../styles/chart';

const TITLES = {
  win: '这 一 年 赚 了',
  lose: '这 一 年 亏 了',
  bankrupt: '宣 告 破 产',
};

const SUBTITLES = {
  win: '一年到期，账户比当初更厚。有人开始叫你"股神"。',
  lose: '一年到期，你没能跑赢当初的自己。市场从不同情努力。',
  bankrupt: '总资产连一手都买不起了。营业部的门在你身后关上。',
};

/** 成绩面板的行高 */
const ROW_H = 28;

export default class ResultScene extends Scene {
  constructor(bus) {
    super('result');
    this.bus = bus;
    this.blink = 0;
  }

  enter(params) {
    super.enter(params);
    this.blink = 0;
  }

  /**
   * 成绩面板的所有行 —— 高度与绘制必须来自同一份数据
   */
  _rows(res) {
    const bus = this.bus;
    const rows = [
      ['初始资金', `¥${res.init.toFixed(0)}`, PALETTE.textDim],
      ['期末总资产', `¥${res.total.toFixed(0)}`, PALETTE.textBright],
      [
        '净盈亏',
        `${res.profit >= 0 ? '+' : '−'}¥${Math.abs(res.profit).toFixed(0)}`,
        res.profit >= 0 ? STOCK.up : STOCK.down,
      ],
      [
        '收益率',
        `${res.returnRate >= 0 ? '+' : ''}${(res.returnRate * 100).toFixed(1)}%`,
        res.returnRate >= 0 ? STOCK.up : STOCK.down,
      ],
      ['存活月份', `${res.turns} / ${bus.level.turns}`, PALETTE.textDim],
    ];

    // 年末强制平仓明细
    const liq = res.liquidation;
    if (liq && liq.details.length) {
      const soldShares = liq.details.reduce((s, d) => s + d.shares, 0);
      const liqProfit = liq.totalProfit;
      rows.push([
        '年末平仓',
        `${soldShares} 股 → ¥${liq.totalAmount.toFixed(0)}`,
        PALETTE.accent,
      ]);
      rows.push([
        '平仓盈亏',
        `${liqProfit >= 0 ? '+' : '−'}¥${Math.abs(liqProfit).toFixed(0)}`,
        liqProfit >= 0 ? STOCK.up : STOCK.down,
      ]);
    }

    // 退市事件（熊市关卡的关键复盘）
    (res.delistEvents || []).forEach((ev) => {
      rows.push([
        `${ev.name} 退市`,
        ev.held
          ? `第 ${ev.turn} 月爆雷 · 亏 ¥${Math.abs(ev.profit).toFixed(0)}`
          : `第 ${ev.turn} 月退市 · 你已避开`,
        STOCK.down,
      ]);
    });

    return rows;
  }

  /**
   * 成绩面板高度 —— 有年末平仓明细 / 退市事件时多几行
   */
  _panelHeight(res) {
    return 28 + this._rows(res).length * ROW_H + 12;
  }

  /**
   * 纵向骨架 —— layout() 与 render() 共用，绝不允许各算一遍
   */
  _flow(w, h) {
    const bus = this.bus;
    const res = bus.result;
    if (!res) return null;

    const top = contentTop();
    const bottom = contentBottom(h);
    const px = 24;
    const pw = w - 48;

    const titleY = top + 30;
    const subY = titleY + 34;

    const subLines = Math.max(
      1,
      wrapLines(SUBTITLES[res.outcome] || '', w - 60, { size: FONT.size.xs }).length,
    );
    const levelY = subY + (subLines - 1) * 20 + 28;

    const panelY = levelY + 24;
    const panelH = this._panelHeight(res);
    let y = panelY + panelH + 18;

    const reasonY = res.reason ? y + 4 : null;
    if (res.reason) y += 26;

    const trendTitleY = y + 4;
    y += 20;

    const seriesCount = bus.stockDefs.filter(
      (d) => bus.simulator.historyOf(d.code).length > 1,
    ).length;
    const legendY = y + 10;
    y += seriesCount ? seriesCount * 18 + 12 : 12;

    const chartY = y;
    const chartH = 96;
    y += chartH + 16;

    const bh = 52;
    const bw = Math.min(220, w - 90);
    const by = Math.min(y + 18, bottom - bh - 16);

    return {
      top, bottom, px, pw,
      titleY, subY, levelY, subLines,
      panelY, panelH,
      reasonY, trendTitleY, legendY,
      chartY, chartH, seriesCount,
      btn: { x: w / 2 - bw / 2, y: by, w: bw, h: bh },
    };
  }

  /**
   * 布局：注册"再来一局"热区
   */
  layout(w, h) {
    const flow = this._flow(w, h);
    if (!flow) return;

    this._btn = flow.btn;
    this.addTouch(this._btn, () => {
      this.emit('restart');
    });
  }

  /**
   * 布局缓存键 —— 结局与平仓明细决定面板高度
   */
  layoutKey() {
    const res = this.bus.result;
    if (!res) return null;
    return `${res.outcome}|${res.turns}|${res.total.toFixed(0)}|${this._panelHeight(res)}`;
  }

  update(dt) {
    this.blink += dt;
  }

  render(ctx, w, h) {
    const bus = this.bus;
    const res = bus.result;
    if (!res) return;

    const flow = this._flow(w, h);
    if (!flow) return;

    const titleColor =
      res.outcome === 'win' ? STOCK.up : res.outcome === 'bankrupt' ? STOCK.down : PALETTE.accent;

    // ---- 标题 ----
    text(TITLES[res.outcome] || '结 算', w / 2, flow.titleY, {
      size: FONT.size.xl,
      color: titleColor,
      align: 'center',
      bold: true,
    });

    // ---- 副标题 ----
    textWrap(SUBTITLES[res.outcome] || '', flow.px + 6, flow.subY, w - 60, 20, {
      size: FONT.size.xs,
      color: PALETTE.textDim,
    });

    // ---- 关卡进度 ----
    //
    // ⚠️ 只显示「第 N / 5 关」。**不要**在这里补上年份或市场风格
    //    （"1996 牛市"）—— 那等于把答案告诉玩家，也顺便剧透了下一关。
    //    玩家应当从盘面自己总结这一关是什么市场。
    if (typeof bus.levelPosition === 'function') {
      const pos = bus.levelPosition();
      text(`第 ${pos.index} / ${pos.total} 关 · 本局市场已收官`, w / 2, flow.levelY, {
        size: FONT.size.xs,
        color: PALETTE.accent,
        align: 'center',
      });
    }

    // ---- 成绩面板 ----
    const rows = this._rows(res);
    panel(flow.px, flow.panelY, flow.pw, flow.panelH);

    let ry = flow.panelY + 28;
    rows.forEach(([label, value, color]) => {
      text(label, flow.px + 14, ry, {
        size: FONT.size.sm,
        color: PALETTE.textDim,
      });
      text(value, flow.px + flow.pw - 14, ry, {
        size: FONT.size.sm,
        color,
        align: 'right',
        bold: true,
      });
      ry += ROW_H;
    });

    // ---- 失败原因 ----
    if (res.reason && flow.reasonY !== null) {
      text(res.reason, flow.px + 4, flow.reasonY, {
        size: FONT.size.xs,
        color: PALETTE.textDim,
      });
    }

    // ---- 三只股票全年走势（折线图 + 末端箭头）----
    text('全年走势', flow.px + 4, flow.trendTitleY, {
      size: FONT.size.xs,
      color: PALETTE.accent,
    });

    // 三条折线叠在同一坐标系里，才能比较相对强弱
    const palette = ['#FFB000', '#4A9EFF', '#C77DFF'];
    const INNER = 5;

    // 展开成带月内波动的路径（每股用代码做种子 → 与交易场景的走势图一致）
    const series = bus.stockDefs.map((def, i) => {
      const hist = bus.simulator.historyOf(def.code);
      const closes = hist.map((p) => p.price);
      return {
        name: def.name,
        color: palette[i % palette.length],
        values: wavyPath(closes, def.code, { inner: INNER }),
        closes,
      };
    }).filter((s) => s.values.length > 1);

    if (series.length) {
      // 图例（涨跌幅用真实收盘价算，不受波动影响）
      chartLegend(ctx, flow.px + 4, flow.legendY, flow.pw - 8, series.map((s) => ({
        name: s.name,
        color: s.color,
        change: s.closes[0] > 0 ? s.closes[s.closes.length - 1] / s.closes[0] - 1 : 0,
      })), { lineH: 18 });

      // 横轴位置：月份点均分，月内波动点插在中间
      const monthCount = series[0].closes.length;
      const positions = [];
      const labelAt = [];
      const monthLabels = [];
      for (let i = 0; i < monthCount; i++) {
        positions.push(i / (monthCount - 1));
        labelAt.push(positions.length - 1);
        monthLabels.push(i === 0 ? '开' : monthName(i));
        for (let k = 1; k <= INNER && i < monthCount - 1; k++) {
          positions.push((i + k / (INNER + 1)) / (monthCount - 1));
        }
      }

      lineChart(ctx, {
        x: flow.px + 4,
        y: flow.chartY,
        w: flow.pw - 8,
        h: flow.chartH,
        series,
        yTicks: 3,
        xLabels: monthLabels,
        positions,
        labelAt,
        xTickEvery: 2,
        showGrid: true,
        endArrow: true,
      });
    }

    // ---- 再来一局（几何来自 _flow()）----
    const b = flow.btn;
    button(b.x, b.y, b.w, b.h, '再 来 一 局', {
      color: PALETTE.accentDim,
      textColor: PALETTE.textBright,
      border: PALETTE.accent,
      size: FONT.size.md,
    });
  }
}
