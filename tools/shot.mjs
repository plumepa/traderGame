/**
 * 画面快照 —— 把无头渲染的真实绘制指令导出成可离线查看的 HTML
 *
 * 为什么要这个：
 *   改版面（字号 / 安全区 / 间距）之后，"测试全绿"只能证明**没有越界与重叠**，
 *   证明不了"好不好看"。而真机验证又慢又难（要开微信开发者工具、要挑机型）。
 *
 *   本工具的思路是：把渲染过程中所有 ctx 调用**原样录下来**，
 *   再在浏览器的真 canvas 上重放。因为重放用的就是同一套 Canvas 2D API，
 *   出来的画面与真机渲染逐指令一致 —— 可以离线肉眼验收。
 *
 * ★ 关键：必须钩 `getContext('2d')` 返回的那个对象（widgets.js 用的是
 *   模块级单例 ctx），并且要连**属性赋值**（fillStyle / font / lineWidth …）
 *   一起按顺序录下来，否则重放时颜色和字体全乱。
 *
 * 用法：
 *   node --experimental-vm-modules --experimental-loader ./tools/register.mjs tools/shot.mjs
 *   产出 preview/layout-preview.html
 */

import { mkdirSync, writeFileSync } from 'node:fs';

import { audioApi } from './wx-audio.mjs';

const ROOT = new URL('..', import.meta.url);

// ============================================================
// 录制型 ctx
// ============================================================
const RECORDED_PROPS = [
  'fillStyle', 'strokeStyle', 'lineWidth', 'font', 'textAlign',
  'textBaseline', 'globalAlpha', 'lineJoin', 'lineCap', 'miterLimit',
];

function sizeOf(font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(String(font));
  return m ? Number(m[1]) : 12;
}
function isWide(ch) {
  return /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch);
}

/**
 * 建一个"录制型"上下文：所有调用按发生顺序记进 ops
 */
function makeRecorder(W, H, sink) {
  const noop = () => {};
  let curFont = '12px sans-serif';
  let gradSeq = 0;

  const target = {
    canvas: { width: W, height: H },
    // ---- 有返回值、必须真算的方法 ----
    measureText: (s) => {
      const size = sizeOf(curFont);
      let w = 0;
      for (const ch of String(s)) w += isWide(ch) ? size : size * 0.62;
      return { width: w };
    },
    createLinearGradient: (...a) => {
      const id = `g${gradSeq++}`;
      sink.grads[id] = ['linear', a, []];
      return { __grad: id, addColorStop: (o, c) => sink.grads[id][2].push([o, c]) };
    },
    createRadialGradient: (...a) => {
      const id = `g${gradSeq++}`;
      sink.grads[id] = ['radial', a, []];
      return { __grad: id, addColorStop: (o, c) => sink.grads[id][2].push([o, c]) };
    },
    createPattern: () => null,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };

  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'string') {
        // 其余方法一律"录下来"，重放时再真正执行
        return (...args) => {
          sink.ops.push([k, args.map(plain)]);
        };
      }
      return noop;
    },
    set(t, k, v) {
      t[k] = v;
      if (k === 'font') curFont = v;
      if (RECORDED_PROPS.includes(k)) {
        sink.ops.push(['__set', [k, plain(v)]]);
      }
      return true;
    },
  });
}

/** 把参数转成可 JSON 化的形式（渐变对象换成引用标记） */
function plain(v) {
  if (v && typeof v === 'object' && v.__grad) return { __grad: v.__grad };
  return v;
}

// ============================================================
// wx 桩
// ============================================================
function installWx(W, H, safeTop, sink) {
  const handlers = { touchstart: [] };
  globalThis.wx = {
    createCanvas: () => ({ width: W, height: H, getContext: () => makeRecorder(W, H, sink) }),
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
const audio = await import(new URL('js/core/audio.js', ROOT).href);

// ============================================================
// 抓一个机型的五张画面
// ============================================================
const DEVICE = { W: 393, H: 852, safeTop: 59, label: 'iPhone 15 Pro（灵动岛 59px）' };

// 声音开关有两种外观（喇叭 + 声波 / 喇叭 + 红叉）。
// 只抓默认态的话，静音态画得对不对根本没人看得见 ——
// 用 MUTE_STATE=1 再跑一次就能肉眼比对。
const MUTED = process.env.MUTE_STATE === '1';

const sink = { ops: [], grads: {} };
const handlers = installWx(DEVICE.W, DEVICE.H, DEVICE.safeTop, sink);
const app = new Main();
app.bus.reset();
audio.setMuted(MUTED);

const frames = [];
function grab(label, note) {
  sink.ops = [];
  sink.grads = {};
  // 手动复刻 Renderer.start() 的一帧流水线：
  //   清屏（铺底色）→ 场景绘制 → CRT 扫描线 → 暗角
  // 无头环境里 requestAnimationFrame 是打桩的，主循环不会自己跑，
  // 少任何一步画面都会与真机不一样（比如少了底色与扫描线）。
  app.renderer.clear();
  app._frame(16);
  app.renderer.scanlines();
  app.renderer.vignette();
  frames.push({
    label: MUTED ? `${label}（静音）` : label,
    note,
    ops: sink.ops.slice(),
    grads: JSON.parse(JSON.stringify(sink.grads)),
  });
}

const tapAt = (x, y) =>
  handlers.touchstart.forEach((cb) => cb({ touches: [{ clientX: x, clientY: y, identifier: 0 }] }));
const tapRect = (r) => tapAt(r.x + r.w / 2, r.y + r.h / 2);

// 菜单
app._frame(16);
grab('主菜单', '标题整体下移，让开灵动岛');

// 开局 → 新闻
tapRect(app.menu._btn);
app._frame(16);
app._frame(16);
grab('盘面快讯', '报纸卡片在安全区之间垂直居中');

// 关新闻 → 交易
tapAt(DEVICE.W / 2, DEVICE.H / 2);
app._frame(16);
app._frame(16);
grab('交易主界面', '顶栏文字让开灵动岛；卡片/评级/操作区间距自适应放宽');

// 走势图弹窗
app.trading.openChart(app.bus.stockDefs[0].code);
app._frame(16);
app._frame(16);
// 走势图有 0 → 1 的生长动画（约 0.6 秒）。快照只驱动了一两帧，
// 直接抓会抓到"只画了 3%"的半成品 —— 这里把动画推到终点。
app.trading.chartAnim = 1;
app._frame(16);
grab('走势图弹窗', '面板整体落在安全区内；折线已长到完整状态');
app.trading.closeChart();
app._frame(16);

// 走到结算
let guard = 0;
while (app.bus.phase !== 'OVER' && guard++ < 400) {
  const s = app.current;
  if (s === app.scenes.newsflash) tapAt(DEVICE.W / 2, DEVICE.H / 2);
  else if (s === app.scenes.trading) {
    if (!s._nextBtn) break;
    tapRect(s._nextBtn);
  } else break;
  app._frame(16);
  app._frame(16);
}
app._frame(16);
grab('结算 · 普通关', '两个出口并排：进入下一关（主）/ 返回主界面（次）');

// ---- 快进到轮末，抓"继续 · 再来五关 / 退市结算"那一版 ----
//
// ⚠️ 必须真的抓一张轮末的图：轮末的按钮文案更长（"继续 · 再来五关"），
//   而两个按钮并排时字宽只有一半 —— 文案会不会溢出按钮，
//   只有画出来才知道，断言只能证明不越界。
let lv = 0;
while (!app.bus.isBlockEnd() && lv++ < 8) {
  const btn = (app.result._buttons || []).find((b) => b.event === 'nextLevel');
  if (!btn) break;
  tapRect(btn);
  app._frame(16);
  app._frame(16);

  // ⚠️ 必须**真的**把这 12 个月跑完，不能直接 settleTerm()。
  //   直接结算会让 simulator 的历史只有 1 个点 → 结算页的 seriesCount = 0
  //   → 走势图整块不画。第一次抓图就踩了这个坑：轮末那张没有图，
  //   看起来像版面退化，其实是"快进方式不真实"。
  for (let t = 0; t < app.bus.level.turns; t++) {
    app.bus.nextTurn();
    app.bus.settle();
  }
  app.bus.settleTerm();
  app.switchTo('result');
  app._frame(16);
  app._frame(16);
}
app._frame(16);
grab('结算 · 轮末', '轮末多两个选择：继续 · 再来五关（主）/ 退市结算（次）');

// ---- 破产页：手里只剩 ¥800，连一手都买不起 ----
//
// ⚠️ 这张图是「玩家不会破产」那个 bug 的**验收画面**。
//   修复前：退市股的清算价（¥0.8 的仙股）被算进"最低价"，
//   破产线被压到 ¥80，于是这一局根本不会出结算页 —— 抓不到这张图。
//   修复后：破产线 = 可交易股票里最便宜的一手（¥1577），¥800 < ¥1577 → 出局。
//
//   顺带验证失败原因**换行**：文案里要同时写出"总资产"和"一手成本"
//   两个数字，中文 35 字上下，单行会画到屏幕外。
app.bus.reset();
app.switchTo('menu');
app._frame(16);
tapRect(app.menu._btn);
app._frame(16);
app._frame(16);

const doomed = app.bus.stockDefs[0];
doomed.delistAt = 1;
doomed.delistPrice = 0.8;
app.bus.stockDefs.forEach((d) => {
  if (d.code !== doomed.code) app.bus.simulator.states[d.code].price = 15;
});
app.bus.portfolio.cash = 800;
app.bus.portfolio.positions = {};

tapAt(DEVICE.W / 2, DEVICE.H / 2); // 关新闻 → 本月结算（退市）→ 判定破产
app._frame(16);
app._frame(16);
grab('结算 · 破产', '失败原因换行显示总资产 vs 一手成本；出口只剩"返回主界面"');

// ============================================================
// 生成 HTML
// ============================================================
const { FONT } = await import(new URL('js/styles/palette.js', ROOT).href);

const payload = {
  W: DEVICE.W,
  H: DEVICE.H,
  safeTop: DEVICE.safeTop,
  dpr: 2,
  frames,
};

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>PIXEL TRADER 版面预览</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 28px 24px 60px;
    background: #101014; color: #E8E8E0;
    font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  h1 { font-size: 20px; margin: 0 0 6px; color: #FFB000; letter-spacing: .08em; }
  .sub { color: #9A9A90; margin-bottom: 26px; }
  .sub b { color: #FFB000; font-weight: 600; }
  .grid { display: flex; flex-wrap: wrap; gap: 26px; align-items: flex-start; }
  .card { background: #1A1A1E; border: 1px solid #33333a; padding: 14px; }
  .card h2 { font-size: 14px; margin: 0 0 2px; color: #E8E8E0; font-weight: 600; }
  .card p { margin: 0 0 10px; font-size: 12px; color: #8A8A82; max-width: 300px; }
  .stage { position: relative; display: inline-block; }
  canvas { display: block; border-radius: 16px; }
  .overlay { position: absolute; inset: 0; pointer-events: none; border-radius: 16px; }
  .island {
    position: absolute; left: 50%; transform: translateX(-50%);
    top: 9px; width: 96px; height: 26px;
    background: #000; border-radius: 13px;
  }
  .band {
    position: absolute; left: 0; right: 0; top: 0;
    background: rgba(232,69,44,.16);
    border-bottom: 1px dashed rgba(232,69,44,.75);
    display: flex; align-items: flex-end; justify-content: flex-end;
    padding: 0 6px 2px; font-size: 10px; color: #FF9C86;
  }
  .band b { font-weight: 600; }
  .meta { font-size: 11px; color: #6A6A62; margin-top: 8px; }
  .meta code { color: #B9B9AE; }
  .legend { margin-top: 34px; font-size: 12px; color: #8A8A82; }
  .legend b { color: #FFB000; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px;
            vertical-align: middle; margin: 0 4px 1px 0; }
</style>
</head>
<body>
  <h1>PIXEL TRADER · 版面预览</h1>
  <div class="sub">
    下面每一张都是<b>无头渲染的真实绘制指令</b>在浏览器 canvas 上原样重放的结果，
    与真机同源。机型：<b>${DEVICE.label}</b>，
    逻辑尺寸 <code>${DEVICE.W} × ${DEVICE.H}</code>，Dpr 2。
  </div>
  <div class="grid" id="grid"></div>
  <div class="legend">
    <span class="swatch" style="background:rgba(232,69,44,.35)"></span>
    红色虚线以下 = 顶部安全区（灵动岛 / 刘海 / 状态栏）——
    <b>所有文字都在虚线之下</b>，不再被挖孔遮挡。
    <br />
    <span class="swatch" style="background:#000;border-radius:6px"></span>
    黑色药丸是灵动岛的示意位置（真机上由系统绘制）。
  </div>
<script>
const DATA = ${JSON.stringify(payload)};

function replay(ctx, frame) {
  // 录制到的坐标全是**逻辑像素**（Renderer 在 _setup 里对 ctx 做了 scale(dpr)）。
  // 这里把 canvas 背板放大 dpr 倍，再补上同一个 scale，画面才与真机一致。
  ctx.scale(DATA.dpr, DATA.dpr);

  const grads = {};
  for (const [id, [type, args, stops]] of Object.entries(frame.grads)) {
    const g = type === 'linear'
      ? ctx.createLinearGradient(...args)
      : ctx.createRadialGradient(...args);
    for (const [o, c] of stops) g.addColorStop(o, c);
    grads[id] = g;
  }
  for (const [m, args] of frame.ops) {
    const a = args.map((v) => (v && v.__grad) ? grads[v.__grad] : v);
    if (m === '__set') { ctx[a[0]] = a[1]; continue; }
    const fn = ctx[m];
    if (typeof fn === 'function') { try { fn.apply(ctx, a); } catch (e) { /* 个别方法参数不合规，跳过 */ } }
  }
}

const grid = document.getElementById('grid');
// 支持 #画面名 只渲染单张（便于放大逐像素检查）
const only = decodeURIComponent(location.hash.replace(/^#/, ''));
if (only) document.title = 'PIXEL TRADER · ' + only;

DATA.frames.forEach((frame) => {
  if (only && frame.label !== only) return;
  const card = document.createElement('div');
  card.className = 'card';

  const h2 = document.createElement('h2');
  h2.textContent = frame.label;
  const p = document.createElement('p');
  p.textContent = frame.note;
  const stage = document.createElement('div');
  stage.className = 'stage';

  const cv = document.createElement('canvas');
  cv.width = DATA.W * DATA.dpr;
  cv.height = DATA.H * DATA.dpr;
  cv.style.width = DATA.W + 'px';
  cv.style.height = DATA.H + 'px';

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const band = document.createElement('div');
  band.className = 'band';
  band.style.height = DATA.safeTop + 'px';
  band.innerHTML = '<b>safeArea.top = ' + DATA.safeTop + 'px</b>';
  const island = document.createElement('div');
  island.className = 'island';
  overlay.appendChild(band);
  overlay.appendChild(island);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = '绘制指令 <code>' + frame.ops.length + '</code> 条 · 画布 <code>'
    + cv.width + '×' + cv.height + '</code>';

  stage.appendChild(cv);
  stage.appendChild(overlay);
  card.appendChild(h2);
  card.appendChild(p);
  card.appendChild(stage);
  card.appendChild(meta);
  grid.appendChild(card);

  replay(cv.getContext('2d'), frame);
});
</script>
</body>
</html>
`;

mkdirSync(new URL('preview/', ROOT), { recursive: true });
const out = new URL('preview/layout-preview.html', ROOT);
writeFileSync(out, html, 'utf8');

const total = frames.reduce((s, f) => s + f.ops.length, 0);
console.log('\n=== 画面快照 ===');
frames.forEach((f) => console.log(`  ${f.label.padEnd(12)} 绘制指令 ${String(f.ops.length).padStart(5)} 条`));
console.log(`\n共 ${frames.length} 张，${total} 条指令`);
console.log(`已写出 ${out.pathname.replace(/^\//, '')}`);
console.log(`字号：xs=${FONT.size.xs} sm=${FONT.size.sm} md=${FONT.size.md} lg=${FONT.size.lg} xl=${FONT.size.xl} xxl=${FONT.size.xxl}\n`);
