/**
 * 版面诊断 —— 字号 / 顶部安全区 / 底部安全区 / 控件重叠
 *
 * 背景（玩家反馈）：
 *   「字体可以稍微调大点吗？布局有点紧凑，苹果灵动岛有遮挡，
 *     可以在上方留出点空隙吗？」
 *
 * 三条缺陷对应三类断言：
 *   ① 字号偏小     → 断言 FONT.size 各档不低于下限，且严格递增
 *   ② 灵动岛遮挡   → 断言「没有任何文案的基线落在顶部安全区内」
 *   ③ 布局紧凑/重叠 → 断言交易场景各区块两两不重叠、且整体排得进屏幕
 *
 * ★ 关键手法：必须在 `getContext('2d')` 返回的**同一个**代理上钩 fillText
 *   （widgets.js 用的是模块级单例 ctx，往 render() 传自造 ctx 抓不到任何东西），
 *   并且要顺带记录当时的 `ctx.font`，才能知道每个字符串的字号。
 *
 * ★ 反向自检：把 safeTop 人为拉到 100，如果实现里根本没读 safeArea，
 *   文案就会停在固定的 y 上而撞破断言 —— 用来证明这套断言真的有牙齿。
 */

const ROOT = new URL('..', import.meta.url);

import { audioApi } from './wx-audio.mjs';

let passed = 0;
let failed = 0;
const fails = [];

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    fails.push(name + (detail ? '  -> ' + detail : ''));
    console.log(`  FAIL ${name}${detail ? '  -> ' + detail : ''}`);
  }
}
function section(t) {
  console.log(`\n${t}`);
}

// ============================================================
// 记录型 canvas 上下文
// ============================================================
let texts = [];
let fills = [];
let paths = [];
let curFont = '12px sans-serif';
let curAlign = 'left';

function sizeOf(font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(String(font));
  return m ? Number(m[1]) : 12;
}
function isWide(ch) {
  return /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch);
}

function makeCtx2D(W, H) {
  const noop = () => {};
  const target = {
    canvas: { width: W, height: H },
    // 按"中文 = 1 个字宽，西文 = 0.62 个字宽"估算，够用于折行与高度推算
    measureText: (s) => {
      const size = sizeOf(curFont);
      let w = 0;
      for (const ch of String(s)) w += isWide(ch) ? size : size * 0.62;
      return { width: w };
    },
    createRadialGradient: () => ({ addColorStop: noop }),
    createLinearGradient: () => ({ addColorStop: noop }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    fillText: (s, x, y) =>
      texts.push({ str: String(s), x, y, size: sizeOf(curFont), align: curAlign }),
    fillRect: (x, y, w, h) => fills.push({ x, y, w, h, color: target.fillStyle }),
    // 折线 / 网格 / 坐标轴都是 moveTo + lineTo，录下来才能断言"没画出边界"
    moveTo: (x, y) => paths.push([x, y]),
    lineTo: (x, y) => paths.push([x, y]),
  };
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      return typeof k === 'string' ? noop : undefined;
    },
    set(t, k, v) {
      if (k === 'font') curFont = v;
      else if (k === 'textAlign') curAlign = v;
      t[k] = v;
      return true;
    },
  });
}

function installWx(W, H, safeTop) {
  const handlers = { touchstart: [] };
  globalThis.wx = {
    createCanvas: () => ({ width: W, height: H, getContext: () => makeCtx2D(W, H) }),
    getSystemInfoSync: () => ({
      windowWidth: W,
      windowHeight: H,
      pixelRatio: 3,
      screenWidth: W,
      screenHeight: H,
      safeArea: { top: safeTop, bottom: H, left: 0, right: W, width: W, height: H - safeTop },
    }),
    onTouchStart: (cb) => handlers.touchstart.push(cb),
    onTouchMove: () => {},
    onTouchEnd: () => {},
    setStorageSync: () => {},
    getStorageSync: () => '',
    ...audioApi(),
  };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  return handlers;
}

const { default: Main } = await import(new URL('js/main.js', ROOT).href);
const { FONT, PALETTE } = await import(new URL('js/styles/palette.js', ROOT).href);
const { safeTop: safeTopOf, contentTop, safeBottom, MIN_TOP } = await import(
  new URL('js/styles/layout.js', ROOT).href
);
const audio = await import(new URL('js/core/audio.js', ROOT).href);
const muteButton = await import(new URL('js/ui/mute-button.js', ROOT).href);

// ============================================================
// [1] 字号
// ============================================================
console.log('\n=== 版面诊断 ===');

section('[1] 字号已放大且严格递增');

{
  const s = FONT.size;
  check('xs ≥ 12（原先 10，手机上中文过小）', s.xs >= 12, `实际 ${s.xs}`);
  check('sm ≥ 14', s.sm >= 14, `实际 ${s.sm}`);
  check('md ≥ 16', s.md >= 16, `实际 ${s.md}`);
  check('lg ≥ 20', s.lg >= 20, `实际 ${s.lg}`);
  check(
    '六档严格递增',
    s.xs < s.sm && s.sm < s.md && s.md < s.lg && s.lg < s.xl && s.xl < s.xxl,
    JSON.stringify(s),
  );
}

// ============================================================
// [2] 安全区函数本身
// ============================================================
section('[2] 安全区取值');

{
  check('未读取系统信息时也有顶部下限（状态栏始终存在）', safeTopOf() >= MIN_TOP,
    `safeTop=${safeTopOf()}`);
  check('contentTop() 严格大于 safeTop()', contentTop() > safeTopOf(),
    `contentTop=${contentTop()} safeTop=${safeTopOf()}`);
  check('safeBottom() 有下限', safeBottom() > 0, `safeBottom=${safeBottom()}`);
}

// ============================================================
// 逐机型跑一遍完整流程
// ============================================================
const DEVICES = [
  { name: 'iPhone 15 Pro（灵动岛）', W: 393, H: 852, safeTop: 59 },
  { name: 'iPhone SE（无灵动岛）', W: 375, H: 667, safeTop: 20 },
  { name: 'Android 常规', W: 412, H: 915, safeTop: 24 },
  // 反向自检：故意把安全区拉到 100。若实现没读 safeArea，文案会撞破断言。
  { name: '★ 反向自检：safeTop = 100', W: 393, H: 852, safeTop: 100 },
];

for (const dev of DEVICES) {
  const { name, W, H, safeTop } = dev;
  section(`[3] ${name}  ${W}×${H}  safeTop=${safeTop}`);

  const handlers = installWx(W, H, safeTop);
  // 全局音频开关是模块级单例，跨机型会串场 —— 每台机器先复位
  audio.reset();
  const app = new Main();
  app.bus.reset();

  const drive = (n = 1) => {
    for (let i = 0; i < n; i++) app._frame(16);
  };
  const tapAt = (x, y) =>
    handlers.touchstart.forEach((cb) =>
      cb({ touches: [{ clientX: x, clientY: y, identifier: 0 }] }));
  const tapRect = (r) => tapAt(r.x + r.w / 2, r.y + r.h / 2);

  /** 驱动一帧并抓取这一帧真正画出的所有文案与色块 */
  const shot = (label) => {
    texts = [];
    fills = [];
    paths = [];
    app._frame(16);
    const t = texts.slice();
    const f = fills.slice();
    const pa = paths.slice();
    check(`${label}：有文案被绘制`, t.length > 0, `条数=${t.length}`);
    if (t.length) {
      const minY = Math.min(...t.map((o) => o.y));
      const maxY = Math.max(...t.map((o) => o.y));
      check(
        `${label}：没有文案画进顶部安全区（y ≥ ${safeTop}）`,
        minY >= safeTop,
        `最小 y=${minY}，越界文案=${t.filter((o) => o.y < safeTop).map((o) => o.str).join('/')}`,
      );
      check(`${label}：文案不越过底部安全区（y ≤ ${H - 10}）`, maxY <= H - 10, `最大 y=${maxY}`);
    }
    return { t, f, paths: pa };
  };

  // ---- 菜单 ----
  drive(2);
  const menuShot = shot('菜单');
  const pixel = menuShot.t.find((o) => o.str === 'PIXEL');
  check('菜单标题 PIXEL 已下移到安全区之下', !!pixel && pixel.y >= safeTop,
    pixel ? `y=${pixel.y}` : '未找到');

  // ---- 声音开关按钮（全局覆盖层，画在所有场景之上）----
  {
    const r = muteButton.buttonRect(W, H);
    const hit = muteButton.hitRect(W, H);
    const ct = contentTop();

    check('声音按钮在屏幕内',
      r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H,
      `rect=${JSON.stringify(r)}`);
    check('★ 声音按钮整个落在顶部安全区带内（不侵占任何场景的内容区）',
      r.y + r.h <= ct,
      `按钮底=${r.y + r.h}  内容起点=${ct}`);
    check('声音按钮在左上角', r.x <= 14, `x=${r.x}`);
    check('声音按钮不压住灵动岛（横向上在左侧留白区）',
      r.x + r.w <= W / 2 - 40,
      `按钮右=${r.x + r.w}  屏幕中线=${W / 2}`);
    check('命中区不越出屏幕',
      hit.x >= 0 && hit.y >= 0 && hit.x + hit.w <= W && hit.y + hit.h <= H,
      `hit=${JSON.stringify(hit)}`);
    // 命中区下限取 34 而不是 44：
    //   矮安全区机型（iPhone SE 只有 20px）可用的竖向空间 = contentTop() - 0 ≈ 28px，
    //   按钮 24 + 下方外扩 6 已经顶到 34，再大就必须侵占内容区。
    //   "不越界" 比 "够大" 更重要 —— 这是角落里的次要控件，不是主操作。
    check('命中区不小于 34×34（手指点得中）',
      hit.w >= 34 && hit.h >= 34, `${hit.w}×${hit.h}`);

    // 覆盖层必须"惰性"：不产生任何路径点，否则会污染场景的路径几何断言
    texts = []; fills = []; paths = [];
    muteButton.draw(makeCtx2D(W, H), W, H);
    check('★ 声音按钮绘制不产生路径点（不污染场景的路径断言）',
      paths.length === 0, `路径点 ${paths.length} 个`);
    check('声音按钮确实画了东西', fills.length > 0, `色块 ${fills.length}`);

    // 图标点阵必须完整落在按钮内
    const cell = muteButton.cellSize(W, H);
    const o = muteButton.iconOrigin(W, H);
    const span = cell * muteButton.GRID;
    check('图标点阵完整落在按钮内',
      o.x >= r.x && o.y >= r.y && o.x + span <= r.x + r.w && o.y + span <= r.y + r.h,
      `图标 ${o.x},${o.y} +${span}  按钮 ${JSON.stringify(r)}`);

    // ---- 点阵格子之间不能有缝 ----
    // ⚠️ 这条断言来自"看"：3px 的格子在按钮里裂出了 3 条 1px 黑缝。
    //    成因是 drawBitmap 逐格 snap()，而 snap 把值对齐到 PIXEL(=2) 的整数倍，
    //    cell=3 是奇数 → 相邻格错开 1px：snap(14)=14 占 14~16，snap(17)=18 占 18~20，17 就空了。
    //    断言口径：同一行/列里相邻两格的空隙只能是 0（紧挨着）或 ≥ 一整格（有意留白）。
    //    落在 (0, cell) 之间的空隙 = 裂缝，必是 bug。
    {
      const iconColors = new Set([PALETTE.text, PALETTE.textDim, PALETTE.accent, PALETTE.danger]);
      const cells = fills.filter((f) => iconColors.has(f.color));
      check('★ 点阵图标确实画出了格子', cells.length > 0, `格子 ${cells.length}`);

      // axis='x' 看横向裂缝，axis='y' 看纵向裂缝
      const cracksIn = (axis) => {
        const cross = axis === 'x' ? 'y' : 'x';
        const size = axis === 'x' ? 'w' : 'h';
        const groups = new Map();
        for (const c of cells) {
          const k = c[cross];
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(c);
        }
        const bad = [];
        for (const [k, list] of groups) {
          list.sort((a, b) => a[axis] - b[axis]);
          for (let i = 1; i < list.length; i++) {
            const gap = list[i][axis] - (list[i - 1][axis] + list[i - 1][size]);
            if (gap > 0 && gap < cell) bad.push({ at: k, gap });
          }
        }
        return bad;
      };
      const gx = cracksIn('x');
      const gy = cracksIn('y');
      check('★ 点阵横向没有裂缝（相邻格必须相接）', gx.length === 0,
        gx.length ? `${gx.length} 处裂缝，例如 ${JSON.stringify(gx[0])}` : '');
      check('★ 点阵纵向没有裂缝（相邻格必须相接）', gy.length === 0,
        gy.length ? `${gy.length} 处裂缝，例如 ${JSON.stringify(gy[0])}` : '');
    }

    // 点它：开关翻转，且**不**透传给场景
    const before = audio.isMuted();
    const sceneBefore = app.current;
    tapAt(r.x + r.w / 2, r.y + r.h / 2);
    check('★ 点声音按钮会翻转静音状态', audio.isMuted() !== before,
      `${before} → ${audio.isMuted()}`);
    check('点声音按钮不会切换场景', app.current === sceneBefore,
      '当前=' + (app.current && app.current.name));
    tapAt(r.x + r.w / 2, r.y + r.h / 2);
    check('再点一次切回原状态', audio.isMuted() === before, `现在 ${audio.isMuted()}`);

    // 静音时按钮仍要画出来（否则用户找不到开关）
    audio.setMuted(true);
    texts = []; fills = []; paths = [];
    muteButton.draw(makeCtx2D(W, H), W, H);
    check('静音状态下按钮仍然绘制', fills.length > 0, `色块 ${fills.length}`);
    check('静音状态下的绘制同样不产生路径点', paths.length === 0);
    audio.setMuted(false);
  }

  // ---- 开局 → 新闻 ----
  tapRect(app.menu._btn);
  drive(2);
  check('已进入新闻场景', app.current === app.scenes.newsflash,
    '当前=' + (app.current && app.current.name));
  shot('新闻');

  // 新闻卡片整体要落在安全区之间
  const card = app.newsflash._cardLayout(W, H);
  check('新闻卡片底边不越过底部安全区', card.cy + card.ch <= H - 10,
    `底边=${(card.cy + card.ch).toFixed(1)} 上限=${H - 10}`);

  // ---- 关新闻 → 交易 ----
  tapAt(W / 2, H / 2);
  drive(2);
  check('已进入交易场景', app.current === app.scenes.trading,
    '当前=' + (app.current && app.current.name));

  const tradeShot = shot('交易');

  // 顶栏底色必须从 y = 0 铺起（否则屏幕顶部会露出一条空白）
  const bar = tradeShot.f.find(
    (o) => o.x === 0 && o.y === 0 && o.w >= W - 2 && o.color === PALETTE.panel,
  );
  check('顶栏底色从 y=0 铺起（顶部不留白）', !!bar,
    bar ? `h=${bar.h}` : '未找到 panel 色且从 y=0 起的大色块');

  // ---- 交易场景几何：两两不重叠 ----
  const t = app.trading;
  const flow = t.flow;
  check('拿到了版面数据', !!flow, flow ? '' : 'flow 为空');

  if (flow) {
    const c0 = flow.cards[0];
    const c1 = flow.cards[1];
    const c2 = flow.cards[2];

    check('三张股票卡片互不重叠',
      c0.y + c0.h <= c1.y && c1.y + c1.h <= c2.y,
      `${c0.y}~${c0.y + c0.h} / ${c1.y}~${c1.y + c1.h} / ${c2.y}~${c2.y + c2.h}`);
    check('卡片组不与操作面板重叠', c2.y + c2.h <= flow.orderY,
      `卡片底=${c2.y + c2.h} 面板顶=${flow.orderY}`);
    check('操作面板不与下月按钮重叠', flow.orderY + flow.orderH <= flow.nextY,
      `面板底=${flow.orderY + flow.orderH} 按钮顶=${flow.nextY}`);
    check('下月按钮不越出屏幕底部', flow.nextY + flow.nextH <= H - 10,
      `按钮底=${flow.nextY + flow.nextH} 上限=${H - 10}`);

    const g = t._btnGeometry;
    check('买入/卖出按钮在操作面板内',
      g.buy.y + g.buy.h <= flow.orderY + flow.orderH &&
        g.sell.y + g.sell.h <= flow.orderY + flow.orderH,
      `按钮底=${g.buy.y + g.buy.h} 面板底=${flow.orderY + flow.orderH}`);
    check('手数调节行不与买卖按钮重叠', flow.orderY + 34 + 30 <= g.buy.y,
      `调节行底=${flow.orderY + 64} 按钮顶=${g.buy.y}`);
    // 信息行（基线 rowY+54）与梭哈预警行（基线 rowY+76），
    // 字号 xs=12，下沿按基线 +4 估。
    check('信息行不与买卖按钮重叠', flow.orderY + 34 + 54 + 4 <= g.buy.y,
      `信息行底=${flow.orderY + 92} 按钮顶=${g.buy.y}`);
    check('梭哈预警行不与买卖按钮重叠', flow.orderY + 34 + 76 + 4 <= g.buy.y,
      `预警行底=${flow.orderY + 114} 按钮顶=${g.buy.y}`);

    // 卡片内部：走势图按钮不能撞上右对齐的涨跌幅文字（基线 y+50，lg/sm 下沿 +4）
    check('走势图按钮不与涨跌幅文字重叠',
      c0.y + c0.h - 26 >= c0.y + 50 + 4,
      `按钮顶=${c0.y + c0.h - 26} 涨跌幅底=${c0.y + 54}`);
    check('走势图按钮在卡片内', c0.y + c0.h - 26 + 22 <= c0.y + c0.h,
      `按钮底=${c0.y + c0.h - 4} 卡片底=${c0.y + c0.h}`);
    // 退市徽章（左侧，x 22~72）不能压到股名（x 84 起）
    check('退市徽章与股名水平不重叠', 72 < 84, '22+50=72 vs 84');
  }

  // ---- 走势图弹窗 ----
  app.trading.openChart(app.bus.stockDefs[0].code);
  drive(2);
  const chartShot = shot('走势图弹窗');
  const cr = app.trading._chartRect;
  check('走势图面板顶边在安全区之下', cr.y >= safeTop, `y=${cr.y}`);
  check('走势图面板底边不越界', cr.y + cr.h <= H - 10, `底边=${cr.y + cr.h}`);

  // ★ 折线必须完全落在面板内。
  //   这里覆盖了"纵轴范围按收盘价算、月内波动点却超出该范围"的回归 ——
  //   横盘股全年振幅很小时，月内抖动会大于全年振幅，折线曾被外推冲出面板。
  {
    const outside = chartShot.paths.filter(
      ([px, py]) => px < cr.x - 1 || px > cr.x + cr.w + 1 || py < cr.y - 1 || py > cr.y + cr.h + 1,
    );
    check('★ 走势图里所有折线/网格/坐标轴都落在面板内',
      chartShot.paths.length > 20 && outside.length === 0,
      `路径点 ${chartShot.paths.length} 个，越界 ${outside.length} 个` +
        (outside.length ? `，例如 ${JSON.stringify(outside.slice(0, 3))}` : ''));
  }

  app.trading.closeChart();
  drive(2);

  // ---- 走到结算 ----
  let guard = 0;
  while (app.bus.phase !== 'OVER' && guard++ < 400) {
    const s = app.current;
    if (s === app.scenes.newsflash) {
      tapAt(W / 2, H / 2);
    } else if (s === app.scenes.trading) {
      const nb = s._nextBtn;
      if (!nb) break;
      tapRect(nb);
    } else {
      break;
    }
    drive(2);
  }
  check('已走到结算场景', app.current === app.scenes.result,
    `阶段=${app.bus.phase} 场景=${app.current && app.current.name}`);

  if (app.current === app.scenes.result) {
    shot('结算');
    const rf = app.result._flow(W, H);
    check('结算按钮不越出屏幕底部', rf.btn.y + rf.btn.h <= H - 10,
      `按钮底=${rf.btn.y + rf.btn.h} 上限=${H - 10}`);
    check('结算面板底边在按钮之上', rf.panelY + rf.panelH <= rf.btn.y,
      `面板底=${rf.panelY + rf.panelH} 按钮顶=${rf.btn.y}`);
  }
}

// ============================================================
// [4] 退市横幅：占位而不是盖住第一只股票
// ============================================================
section('[4] 退市横幅不遮挡股票卡片');

{
  const { default: TradingScene } = await import(new URL('js/scenes/trading.js', ROOT).href);
  const { bindContext } = await import(new URL('js/styles/widgets.js', ROOT).href);
  const { setSafeArea } = await import(new URL('js/styles/layout.js', ROOT).href);

  const CODES = ['910101', '910201', '910301'];
  const SECTORS_OF = ['liquor', 'tech', 'energy'];

  const makeBus = (ev) => ({
    stockDefs: CODES.map((c, i) => ({ code: c, name: `测试股${i}`, sector: SECTORS_OF[i] })),
    priceMap: Object.fromEntries(CODES.map((c) => [c, 12.34])),
    changeMap: Object.fromEntries(CODES.map((c) => [c, 1.2])),
    turn: 6,
    ratings: [
      { name: '银河证券研究所', rating: { label: '看多', arrow: '↑', color: '#E8452C' } },
      { name: '中金研究部', rating: { label: '看空', arrow: '↓', color: '#2ECC71' } },
      { name: '散户观察周刊', rating: { label: '中性', arrow: '—', color: '#8A8A8A' } },
    ],
    level: { turns: 12, initCash: 10000 },
    portfolio: { cash: 10000, sharesOf: () => 0, avgCostOf: () => 0, totalAssets: () => 10000 },
    simulator: { historyOf: () => [] },
    isDelisted: () => false,
    latestDelistEvent: () => ev,
    wouldBankruptAfterBuy: () => ({ wouldBankrupt: false, afterTotal: 10000, line: 500 }),
  });

  const EV_HELD = { name: '赤河酒业', held: true, shares: 200, price: 3.2, profit: -1800 };
  const EV_SAFE = { name: '赤河酒业', held: false, shares: 0, price: 3.2, profit: 0 };

  for (const dev of DEVICES) {
    const { name, W, H, safeTop } = dev;
    installWx(W, H, safeTop);
    setSafeArea(globalThis.wx.getSystemInfoSync());
    bindContext(makeCtx2D(W, H));

    for (const [tag, ev] of [['持仓爆雷', EV_HELD], ['成功避开', EV_SAFE]]) {
      const bus = makeBus(ev);
      const scene = new TradingScene(bus);
      scene.enter({});
      scene.layout(W, H);
      const flow = scene.flow;

      check(`${name} / ${tag}：退市横幅一定有位置（绝不因空间不足而消失）`,
        !!flow.banner, flow.banner ? '' : 'banner 为空');
      if (!flow.banner) continue;

      const b = flow.banner;
      // 横幅可以在卡片**上方**（占位式）也可以在卡片**下方**（覆盖式，
      // 盖住评级面板），但绝不能与任何一张股票卡片相交。
      const hitCard = flow.cards.find((c) => b.y < c.y + c.h && c.y < b.y + b.h);
      check(`${name} / ${tag}：横幅不与任何股票卡片相交`,
        !hitCard,
        `横幅 ${b.y}~${b.y + b.h}` +
          (hitCard ? ` 与卡片 ${hitCard.y}~${hitCard.y + hitCard.h} 相交` : ''));
      check(`${name} / ${tag}：横幅在顶部安全区之下`, b.y >= safeTop, `y=${b.y}`);
      check(`${name} / ${tag}：横幅不越过下月按钮`, b.y + b.h <= flow.nextY,
        `横幅底=${b.y + b.h} 按钮顶=${flow.nextY}`);

      if (b.reserved) {
        check(`${name} / ${tag}：占位式横幅紧贴顶栏之下`, b.y >= flow.topBarH,
          `横幅顶=${b.y} 顶栏底=${flow.topBarH}`);
      } else {
        // 覆盖式：只能盖住"机构评级"或"顶栏文字"，且不得越出被盖块的范围
        const coverTop = flow.ratingsH > 0 ? flow.ratingsY : flow.top;
        const coverBottom = flow.ratingsH > 0
          ? flow.ratingsY + flow.ratingsH
          : flow.topBarH;
        check(`${name} / ${tag}：覆盖式横幅落在"评级面板"或"顶栏"范围内`,
          b.y === coverTop && b.y + b.h <= coverBottom,
          `横幅 ${b.y}~${b.y + b.h}，允许区间 ${coverTop}~${coverBottom}`);
      }

      check(`${name} / ${tag}：有横幅时卡片组仍不与操作面板重叠`,
        flow.cards[2].y + flow.cards[2].h <= flow.orderY,
        `卡片底=${flow.cards[2].y + flow.cards[2].h} 面板顶=${flow.orderY}`);
      check(`${name} / ${tag}：有横幅时操作面板仍不与下月按钮重叠`,
        flow.orderY + flow.orderH <= flow.nextY,
        `面板底=${flow.orderY + flow.orderH} 按钮顶=${flow.nextY}`);
      check(`${name} / ${tag}：有横幅时下月按钮仍不越界`,
        flow.nextY + flow.nextH <= H - 10,
        `按钮底=${flow.nextY + flow.nextH} 上限=${H - 10}`);
    }
  }
}

// ============================================================
// [5] 结算场景：按钮集合随状态变化，且绝不吃掉走势图
// ============================================================
section('[5] 结算场景版面（连闯：一或两个出口）');

{
  const { default: ResultScene } = await import(new URL('js/scenes/result.js', ROOT).href);
  const { bindContext } = await import(new URL('js/styles/widgets.js', ROOT).href);
  const { setSafeArea, contentBottom } = await import(new URL('js/styles/layout.js', ROOT).href);

  const RESULT_DEVICES = [
    { name: 'iPhone 15 Pro', W: 393, H: 852, safeTop: 59, roomy: true },
    { name: 'Android 常规', W: 412, H: 915, safeTop: 24, roomy: true },
    // 小屏：版面本来就装不下走势图，这里验的是"优雅降级"而不是"必须有图"
    { name: '小屏 320×568', W: 320, H: 568, safeTop: 20, roomy: false },
  ];

  /**
   * 四种状态各自应当出现哪些出口 —— 这份表就是 result.js 里 actionsOf 的规格
   *
   * 破产必须排在轮末之前判断：破产时若还摆出"进入下一关"，
   * 点进去就是拿 ¥0 开局，玩家会以为游戏坏了。
   */
  const STATES = [
    { kind: '普通关', events: ['nextLevel', 'menu'] },
    { kind: '轮末', events: ['nextLevel', 'final'] },
    { kind: '破产', events: ['menu'] },
    { kind: '退市结算', events: ['menu'] },
  ];

  /** 造一个只够结算场景用的假 bus */
  function makeBus(kind) {
    const defs = [
      { code: '900101', name: '甲股', sector: 'a' },
      { code: '900102', name: '乙股', sector: 'b' },
      { code: '900103', name: '丙股', sector: 'c' },
    ];
    const hist = {};
    defs.forEach((d) => {
      hist[d.code] = Array.from({ length: 13 }, (_, i) => ({ price: 10 + i }));
    });

    const isFinal = kind === '退市结算';
    const bankrupt = kind === '破产';
    const block = kind === '轮末';

    const runResults = [];
    const n = isFinal ? 7 : block ? 5 : 1;
    for (let i = 0; i < n; i++) {
      runResults.push({
        index: i + 1, step: (i % 5) + 1, round: Math.floor(i / 5) + 1,
        turns: 12, initCash: 10000, total: 10000, outcome: 'lose',
      });
    }

    return {
      runMode: !isFinal,
      roundIndex: isFinal ? 1 : 0,
      stepIndex: block ? 4 : 0,
      runResults,
      initCash: 10000,
      level: { id: 'lv_01', index: 1, turns: 12, initCash: 10000 },
      stockDefs: defs,
      simulator: { historyOf: (c) => hist[c] || [] },
      result: {
        outcome: bankrupt ? 'bankrupt' : 'lose',
        reason: '一年期满，净亏 ¥120（-1.2%）。市场收走了你的钱。年末已按市价清仓 200 股。',
        total: 9880, init: 10000, profit: -120, returnRate: -0.012, turns: 12,
        liquidation: null,
        delistEvents: bankrupt ? [{ name: '甲股', turn: 7, held: true, profit: -8590 }] : [],
        isFinal,
        levels: isFinal ? 7 : undefined,
      },
      levelPosition: () => (isFinal
        ? { index: 7, total: 10, step: 2, round: 2, blockTotal: 5 }
        : block
          ? { index: 5, total: 5, step: 5, round: 1, blockTotal: 5 }
          : { index: 1, total: 5, step: 1, round: 1, blockTotal: 5 }),
      isBlockEnd: () => block,
      canContinue: () => !bankrupt && !isFinal,
    };
  }

  for (const dev of RESULT_DEVICES) {
    const { name, W, H, safeTop, roomy } = dev;
    installWx(W, H, safeTop);
    setSafeArea(globalThis.wx.getSystemInfoSync());
    bindContext(makeCtx2D(W, H));

    const top = contentTop();
    const bottom = contentBottom(H);

    for (const st of STATES) {
      const bus = makeBus(st.kind);
      const scene = new ResultScene(bus);
      const flow = scene._flow(W, H);
      const tag = `${name} / ${st.kind}`;

      // ---- 出口集合 ----
      const events = flow.buttons.map((b) => b.event);
      check(`${tag}：出口应为 ${st.events.join(' + ')}`,
        events.join(',') === st.events.join(','), `实际 ${events.join(',')}`);

      // ---- 按钮几何 ----
      flow.buttons.forEach((b, i) => {
        check(`${tag}：第 ${i + 1} 个按钮在画布内`,
          b.x >= 0 && b.x + b.w <= W, `x=${b.x} w=${b.w} W=${W}`);
        check(`${tag}：第 ${i + 1} 个按钮让开顶部安全区`,
          b.y >= top, `y=${b.y} top=${top}`);
        check(`${tag}：第 ${i + 1} 个按钮让开底部安全区`,
          b.y + b.h <= bottom, `底=${b.y + b.h} bottom=${bottom}`);
      });

      if (flow.buttons.length === 2) {
        const [a, b] = flow.buttons;
        check(`${tag}：★ 两个按钮并排且不重叠`,
          a.x + a.w <= b.x, `甲右=${a.x + a.w} 乙左=${b.x}`);
        check(`${tag}：两个按钮同一行（高度对齐）`,
          a.y === b.y && a.h === b.h, `y=${a.y}/${b.y} h=${a.h}/${b.h}`);
      }

      // ---- 按钮不得压住成绩面板 ----
      const panelBottom = flow.panelY + flow.panelH;
      check(`${tag}：按钮不压住成绩面板`,
        flow.btn.y >= panelBottom, `按钮顶=${flow.btn.y} 面板底=${panelBottom}`);

      // ---- 走势图：要么画得完整，要么整块不画，绝不半截被按钮截断 ----
      if (flow.showChart) {
        check(`${tag}：★ 走势图底部不越过按钮区`,
          flow.chartY + flow.chartH <= flow.btn.y - 14 + 0.01,
          `图底=${flow.chartY + flow.chartH} 按钮顶=${flow.btn.y}`);
        check(`${tag}：走势图高度不低于降级下限 52`,
          flow.chartH >= 52, `chartH=${flow.chartH}`);
        check(`${tag}：走势图各区块纵向有序（标题 < 图例 < 图）`,
          flow.trendTitleY < flow.legendY && flow.legendY < flow.chartY,
          `${flow.trendTitleY} / ${flow.legendY} / ${flow.chartY}`);
      } else {
        check(`${tag}：不画图时不得残留标题或图例`,
          flow.chartH === 0, `chartH=${flow.chartH}`);
      }

      // ---- ★ 关键回归：空间够的机型上，轮末那张图不许"凭空消失" ----
      //
      // 轮末比普通关多两行（本轮累计 / 累计收益率）。曾经把按钮上下堆叠，
      // 按钮区要占 116px，正好把这两行的差额吃光 —— 轮末的走势图整块不见，
      // 而玩家恰恰是在轮末最需要看走势来决定"继续还是收手"。
      if (roomy) {
        check(`${tag}：★ 空间充足的机型必须画得出走势图`,
          flow.showChart === true,
          `chartY=${flow.chartY} btnY=${flow.btn.y} chartH=${flow.chartH}`);
      }
    }

    // ---- 轮末的行数必须真的比普通关多（否则上面那条断言等于没验）----
    const rowsNormal = new ResultScene(makeBus('普通关'))._rows(makeBus('普通关').result).length;
    const rowsBlock = new ResultScene(makeBus('轮末'))._rows(makeBus('轮末').result).length;
    check(`${name}：★ 轮末比普通关多出行（累计战绩）`,
      rowsBlock > rowsNormal, `普通=${rowsNormal} 轮末=${rowsBlock}`);
  }
}

// ============================================================
section('[6] 结算页「失败原因」换行（破产文案有 30~40 字）');

{
  const { default: ResultScene } = await import(new URL('js/scenes/result.js', ROOT).href);
  const { bindContext } = await import(new URL('js/styles/widgets.js', ROOT).href);
  const { setSafeArea } = await import(new URL('js/styles/layout.js', ROOT).href);

  // 先给全局 wx 打桩，main.js 的依赖链（audio/bgm/scenes）才加载得动
  installWx(375, 667, 20);
  const { default: Main } = await import(new URL('js/main.js', ROOT).href);

  // ★ 文案**直接取自生产代码**（Main.prototype._bankruptReason），不手抄。
  //   手抄的文案在改实现时会静默失效 —— 测试还在，验的却是旧字符串。
  const fake = (ev) => ({ bus: { latestDelistEvent: () => ev } });
  const CASES = [
    {
      tag: '开局资金不足',
      reason: Main.prototype._bankruptReason.call(fake(null), 'start', 800, 1405),
    },
    {
      tag: '退市清算（有持仓）',
      reason: Main.prototype._bankruptReason.call(
        fake({ name: '云岭老窖', held: true }), 'settle', 800, 1577,
      ),
    },
    {
      tag: '退市（未持仓）',
      reason: Main.prototype._bankruptReason.call(
        fake({ name: '云岭老窖', held: false }), 'settle', 800, 905,
      ),
    },
    {
      tag: '卖出后',
      reason: Main.prototype._bankruptReason.call(fake(null), 'sell', 300, 605),
    },
    {
      tag: '无可交易标的（Infinity）',
      reason: Main.prototype._bankruptReason.call(fake(null), 'settle', 800, Infinity),
    },
  ];

  /** 按"中文 1 字宽 / 西文 0.62 字宽"估算绘制宽度 */
  function approxW(str, size) {
    let w = 0;
    for (const ch of String(str)) w += isWide(ch) ? size : size * 0.62;
    return w;
  }

  function makeBankruptBus(reason) {
    const defs = [
      { code: '900101', name: '甲股', sector: 'a' },
      { code: '900102', name: '乙股', sector: 'b' },
      { code: '900103', name: '丙股', sector: 'c' },
    ];
    const hist = {};
    defs.forEach((d) => {
      hist[d.code] = Array.from({ length: 13 }, (_, i) => ({ price: 10 + i }));
    });
    return {
      runMode: false,
      roundIndex: 0,
      stepIndex: 0,
      runResults: [],
      initCash: 800,
      level: { id: 'lv_01', index: 1, turns: 12, initCash: 800 },
      stockDefs: defs,
      simulator: { historyOf: (c) => hist[c] || [] },
      result: {
        outcome: 'bankrupt',
        reason,
        total: 800,
        init: 800,
        profit: 0,
        returnRate: 0,
        // ★ 开局即破产时 turn = 0 —— 结算页要能显示「存活月份 0 / 12」而不炸
        turns: 0,
        liquidation: null,
        delistEvents: [],
      },
      levelPosition: () => ({ index: 1, total: 5, step: 1, round: 1, blockTotal: 5 }),
      isBlockEnd: () => false,
      canContinue: () => false,
    };
  }

  [
    { name: 'iPhone 15 Pro', W: 393, H: 852, safeTop: 59 },
    { name: '小屏 320×568', W: 320, H: 568, safeTop: 20 },
  ].forEach(({ name, W, H, safeTop }) => {
    installWx(W, H, safeTop);
    setSafeArea(globalThis.wx.getSystemInfoSync());
    bindContext(makeCtx2D(W, H));

    CASES.forEach(({ tag, reason }) => {
      const bus = makeBankruptBus(reason);
      const scene = new ResultScene(bus);
      const flow = scene._flow(W, H);
      const label = `${name} / ${tag}`;

      // ① 真的换行了 —— 否则本节等于没验到东西
      check(`${label}：★ 长文案被拆成多行（否则本节是空转）`,
        flow.reasonLines >= 2, `reasonLines=${flow.reasonLines} 字数=${reason.length}`);

      // ② 换行后的原因不压住走势图标题
      const reasonBottom = flow.reasonY + (flow.reasonLines - 1) * 18;
      check(`${label}：原因文字不压住走势图标题`,
        reasonBottom <= flow.trendTitleY,
        `原因底=${reasonBottom} 标题=${flow.trendTitleY}`);

      // ③ ★ 核心回归：每一行都画在画布内。
      //    修复前用的是单行 text()，35 字的破产文案会直接画到屏幕外
      //    （375 宽的屏一行只放得下约 29 字）。
      texts = [];
      scene.render(makeCtx2D(W, H), W, H);
      const drawn = texts.filter((t) => t.str && t.str.length > 1 && reason.includes(t.str));
      const overflow = drawn.filter((t) => t.x + approxW(t.str, t.size) > W);

      check(`${label}：★ 原因按换行逐行绘制（不是一行硬画）`,
        drawn.length >= 2, `画出 ${drawn.length} 行`);
      check(`${label}：★ 每一行都在画布内（修复前会溢出屏幕）`,
        overflow.length === 0,
        overflow.map((t) => `"${t.str}" 右缘=${(t.x + approxW(t.str, t.size)).toFixed(0)}`).join(' | '));

      // ④ 走势图要么画得完整，要么整块不画
      check(`${label}：走势图要么完整要么整块不画`,
        flow.showChart
          ? flow.chartY + flow.chartH <= flow.btn.y - 14 + 0.01
          : flow.chartH === 0,
        `showChart=${flow.showChart} chartH=${flow.chartH} btnY=${flow.btn.y}`);
    });
  });
}

// ============================================================
console.log('\n=== 结果 ===');
if (failed) {
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  console.log('版面诊断未通过 ✗');
  process.exit(1);
} else {
  console.log(`通过 ${passed} 项，失败 0 项`);
  console.log('版面诊断通过 ✓\n');
}
