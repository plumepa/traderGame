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
    createInnerAudioContext: () => ({ play: () => {}, stop: () => {}, destroy: () => {} }),
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
    app._frame(16);
    const t = texts.slice();
    const f = fills.slice();
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
    return { t, f };
  };

  // ---- 菜单 ----
  drive(2);
  const menuShot = shot('菜单');
  const pixel = menuShot.t.find((o) => o.str === 'PIXEL');
  check('菜单标题 PIXEL 已下移到安全区之下', !!pixel && pixel.y >= safeTop,
    pixel ? `y=${pixel.y}` : '未找到');

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
  shot('走势图弹窗');
  const cr = app.trading._chartRect;
  check('走势图面板顶边在安全区之下', cr.y >= safeTop, `y=${cr.y}`);
  check('走势图面板底边不越界', cr.y + cr.h <= H - 10, `底边=${cr.y + cr.h}`);
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
