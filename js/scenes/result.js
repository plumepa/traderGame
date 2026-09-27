/**
 * 结算场景
 *
 * 无通关目标，结局由最终收益决定：
 *   win      —— 到期结算且盈利（年末已强制平仓）
 *   lose     —— 到期结算但亏损 / 持平
 *   bankrupt —— 总资产低于一手成本，提前出局
 *
 * 底部按钮随状态变化（见 actionsOf）：
 *   · 普通关：进入下一关 / 返回主界面
 *   · 轮末（第 5 / 10 / 15 … 关）：继续 · 再来五关 / 退市结算
 *   · 破产：只有 返回主界面
 *
 * 版面（第二版）：
 *   纵向骨架由 _flow() 统一计算，layout() 与 render() 共用；
 *   顶部从 contentTop() 之下开始（让开灵动岛），
 *   底部按钮夹在 contentBottom() 之上（让开 Home 指示条）。
 *
 * 版面（第三版 · 连闯）：
 *   按钮区**先分配**再让内容去挤，两个按钮**并排**而不是堆叠 ——
 *   堆叠要占 116px，会把走势图挤成负高度而整块消失。
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

/** 退市结算（连闯收手）的标题 —— 结局由总盈亏决定，但标题说的是"你收手了" */
const FINAL_TITLES = {
  win: '退 市 · 满 载 而 归',
  lose: '退 市 · 割 肉 离 场',
};

const SUBTITLES = {
  win: '一年到期，账户比当初更厚。有人开始叫你"股神"。',
  lose: '一年到期，你没能跑赢当初的自己。市场从不同情努力。',
  bankrupt: '总资产连一手都买不起了。营业部的门在你身后关上。',
};

const FINAL_SUBTITLES = {
  win: '你主动合上了账本。能带着钱走出赌场的人，从来都不多。',
  lose: '你主动合上了账本。至少，是你自己喊的停，不是被抬出去的。',
};

/** 成绩面板的行高 */
const ROW_H = 28;

/**
 * 本关结束时玩家能做什么
 *
 * 三档，互斥：
 *   · **轮末**（第 5 / 10 / 15 … 关）：继续（再来五关） / 退市结算
 *   · **普通关**：进入下一关 / 返回主界面
 *   · **破产**：只能返回主界面（连一手都买不起了，没有"下一关"可言）
 *
 * ⚠️ 破产分支必须放在最前面判断 —— 否则破产时还会显示"进入下一关"，
 *   点进去就是拿 ¥0 开局，玩家会觉得游戏坏了。
 *
 * @returns {Array<{label:string, event:string, primary:boolean}>}
 */
function actionsOf(bus, res) {
  if (!res) return [];
  const canGo = typeof bus.canContinue === 'function' ? bus.canContinue() : false;
  const runMode = !!bus.runMode;
  const blockEnd = typeof bus.isBlockEnd === 'function' && bus.isBlockEnd();

  if (canGo && runMode && blockEnd) {
    return [
      { label: '继续 · 再来五关', event: 'nextLevel', primary: true },
      { label: '退市结算', event: 'final', primary: false },
    ];
  }
  if (canGo) {
    return [
      { label: '进入下一关', event: 'nextLevel', primary: true },
      { label: '返回主界面', event: 'menu', primary: false },
    ];
  }
  return [{ label: '返回主界面', event: 'menu', primary: false }];
}

/**
 * 标题 / 副标题 —— 退市结算走另一套文案
 *
 * ⚠️ 退市结算的 outcome 是 win / lose（由总盈亏决定），但**不能**沿用
 *   "这一年赚了" —— 玩家可能连闯了 10 关，说"这一年"是错的。
 */
function titleOf(res) {
  if (res.isFinal) return FINAL_TITLES[res.outcome] || '退 市 结 算';
  return TITLES[res.outcome] || '结 算';
}

function subtitleOf(res) {
  if (res.isFinal) return FINAL_SUBTITLES[res.outcome] || SUBTITLES[res.outcome] || '';
  return SUBTITLES[res.outcome] || '';
}

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
      [res.isFinal ? '整轮本金' : '初始资金', `¥${res.init.toFixed(0)}`, PALETTE.textDim],
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
      // ⚠️ 退市结算的 turns 是**各关存活月份之和**（可能 60），
      //   不能写成 "60 / 12" —— 那是单关的回合数，量纲不对。
      res.isFinal
        ? ['累计月份', `${res.turns} 个月`, PALETTE.textDim]
        : ['存活月份', `${res.turns} / ${bus.level.turns}`, PALETTE.textDim],
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

    // ---- 连闯：本轮进度与累计战绩 ----
    //
    // 第 1 关不显示"累计"（累计就等于本关，重复且占地方）。
    //
    // ⚠️ 退市结算时 runMode 已被 finalSettle() 关掉（按钮要靠它消失），
    //   所以这里**不能**用 runMode 当条件，否则汇总单上反而没有"连闯几关"。
    if (res.isFinal) {
      rows.push(['连闯关数', `${res.levels} 关`, PALETTE.accent]);
    } else if (bus.runMode && typeof bus.levelPosition === 'function') {
      const pos = bus.levelPosition();
      rows.push(['本轮进度', `第 ${pos.step} / ${pos.blockTotal} 关`, PALETTE.accent]);

      const runs = bus.runResults || [];
      if (runs.length > 1) {
        const start = runs[0].initCash; // 本轮开局的本金
        const cum = res.total - start;
        rows.push([
          '本轮累计',
          `${cum >= 0 ? '+' : '−'}¥${Math.abs(cum).toFixed(0)}`,
          cum >= 0 ? STOCK.up : STOCK.down,
        ]);
        rows.push([
          '累计收益率',
          `${cum >= 0 ? '+' : ''}${start > 0 ? ((cum / start) * 100).toFixed(1) : '0.0'}%`,
          cum >= 0 ? STOCK.up : STOCK.down,
        ]);
      }
    }

    return rows;
  }

  /**
   * 成绩面板高度 —— 有年末平仓明细 / 退市事件时多几行
   */
  _panelHeight(res) {
    return 28 + this._rows(res).length * ROW_H + 12;
  }

  /**
   * 本关结束时的可选操作（layout / render / layoutKey 共用同一份）
   */
  _actions(res) {
    return actionsOf(this.bus, res);
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

    // ---- 底部按钮区：**先分配**，再让上面的内容去挤 ----
    //
    // ⚠️ 两个按钮必须**并排**，不能上下堆叠。
    //   堆叠时按钮区要占 2×52+12 = 116px，会把走势图挤掉 ——
    //   实测熊市关卡多出一行退市记录时，图表高度会被算成负数而整块消失。
    //   并排只占一行 52px，代价是每个按钮窄一半，所以文案也相应缩短。
    const actions = this._actions(res);
    const bh = 52;
    const gap = 12;
    const btnY = bottom - bh - 14;
    const bw = actions.length > 1
      ? Math.floor((pw - gap) / 2)
      : Math.min(220, w - 90);
    const btnX0 = actions.length > 1 ? px : w / 2 - bw / 2;
    const buttons = actions.map((a, i) => ({
      ...a,
      x: btnX0 + i * (bw + gap),
      y: btnY,
      w: bw,
      h: bh,
    }));

    const titleY = top + 30;
    const subY = titleY + 34;

    const subLines = Math.max(
      1,
      wrapLines(subtitleOf(res), w - 60, { size: FONT.size.xs }).length,
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

    // ---- 走势图高度：降级链（够 → 96 / 不够 → 压到刚好 / 实在没地方 → 整块不画）----
    //
    // 断言证明不了"没被压扁"，所以这里给出明确的三级降级，
    // 并让 diag-layout 断言"图表底部不越过按钮区顶部"。
    const chartY = y;
    const room = btnY - 14 - chartY;
    const chartH = room >= 96 ? 96 : room >= 52 ? room : 0;
    const showChart = chartH > 0 && seriesCount > 0;

    return {
      top, bottom, px, pw,
      titleY, subY, levelY, subLines,
      panelY, panelH,
      reasonY, trendTitleY, legendY,
      chartY, chartH, seriesCount, showChart,
      buttons,
      btn: buttons[0],
    };
  }

  /**
   * 布局：为**每一个**按钮注册热区
   *
   * ⚠️ 事件名来自 _flow() 算好的 b.event，**不能**写死成 'restart' ——
   *   轮末是"继续 / 退市"、普通关是"下一关 / 主界面"、破产只有"主界面"，
   *   三种状态的按钮集合完全不同，写死会让轮末点"退市结算"却重启本关。
   */
  layout(w, h) {
    const flow = this._flow(w, h);
    if (!flow) return;

    this._buttons = flow.buttons;
    flow.buttons.forEach((b) => {
      this.addTouch(b, () => {
        this.emit(b.event);
      });
    });
  }

  /**
   * 布局缓存键 —— 结局 / 平仓明细决定面板高度，连闯进度决定按钮集合
   *
   * ⚠️ 必须带上按钮集合（acts）：第 5 关与第 6 关的 outcome / 收益 / 面板高度
   *   可能**完全一致**，只有按钮从"下一关"变成"继续 · 再来五关"。
   *   不带上就会命中旧热区，轮末点不到"退市结算"。
   */
  layoutKey() {
    const res = this.bus.result;
    if (!res) return null;
    const bus = this.bus;
    const run = bus.runMode
      ? `${bus.roundIndex}:${bus.stepIndex}:${(bus.runResults || []).length}`
      : 'solo';
    const acts = this._actions(res).map((a) => a.event).join('+');
    return `${res.outcome}|${res.turns}|${res.total.toFixed(0)}|${this._panelHeight(res)}|${run}|${acts}`;
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
    text(titleOf(res), w / 2, flow.titleY, {
      size: FONT.size.xl,
      color: titleColor,
      align: 'center',
      bold: true,
    });

    // ---- 副标题 ----
    textWrap(subtitleOf(res), flow.px + 6, flow.subY, w - 60, 20, {
      size: FONT.size.xs,
      color: PALETTE.textDim,
    });

    // ---- 关卡进度 ----
    //
    // ⚠️ 只显示「第 N / 5 关」。**不要**在这里补上年份或市场风格
    //    （"1996 牛市"）—— 那等于把答案告诉玩家，也顺便剧透了下一关。
    //    玩家应当从盘面自己总结这一关是什么市场。
    if (res.isFinal) {
      text(`连闯 ${res.levels} 关 · 就此收手`, w / 2, flow.levelY, {
        size: FONT.size.xs,
        color: PALETTE.accent,
        align: 'center',
      });
    } else if (typeof bus.levelPosition === 'function') {
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
    //
    // ⚠️ 整块（标题 + 图例 + 折线）由 flow.showChart 统一开关。
    //   窄屏 / 熊市多一行退市记录时，降级链会把 chartH 算成 0；
    //   此时若还画"全年走势"标题和"开/2月/4月…"图例，屏幕上就只剩
    //   一堆没有图的刻度，比不画更糟。
    if (flow.showChart) {
      text(res.isFinal ? '末关走势' : '全年走势', flow.px + 4, flow.trendTitleY, {
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
    }

    // ---- 底部按钮（几何来自 _flow()，一或两个）----
    //
    // primary  = 主路径（下一关 / 继续），实心底 + 亮边，视觉上更"重"
    // secondary= 退出路径（主界面 / 退市结算），浅底 + 暗边
    // 两个并排时字宽只有一半，所以文案要短、字号要降一档。
    const many = flow.buttons.length > 1;
    flow.buttons.forEach((b) => {
      button(b.x, b.y, b.w, b.h, b.label, {
        color: b.primary ? PALETTE.accentDim : PALETTE.panelLight,
        textColor: b.primary ? PALETTE.textBright : PALETTE.text,
        border: b.primary ? PALETTE.accent : PALETTE.border,
        size: many ? FONT.size.sm : FONT.size.md,
      });
    });
  }
}
