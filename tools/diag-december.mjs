/**
 * 十二月 UX 诊断 —— 验证"关卡提前结束"的错觉是否已修好
 *
 * 背景：玩家反馈"十二月就没有新闻了，关卡已经结束了"。
 * 实测新闻在 12 月**是播的**，真正的缺陷是末月缺乏提示：
 *   - 顶栏只写 "11 / 12 月"，玩家不知道下一下就是最后一月
 *   - 按钮永远写"进入下一个月 ▶"，看不出这一下会结束游戏
 *   - 新闻卡不标月份，十二月新闻和一月新闻长得一样
 *
 * 本工具跑到底、逐回合抓取渲染文案，断言：
 *   ① 12 月确实有新闻对象（不是被跳过）
 *   ② 新闻卡的月份标注 = 十二月
 *   ③ 末月顶栏/按钮出现"最后一个月 / 结束本年"
 */

import { createHash } from 'node:crypto';

const ROOT = new URL('..', import.meta.url);

let passed = 0, failed = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; fails.push(name + (detail ? '  -> ' + detail : '')); console.log(`  FAIL ${name}${detail ? '  -> ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// ---- 最小 canvas / wx 桩（与 smoketest 同构）----
//
// ⚠️ 关键：widgets.js 用**模块级**的 ctxRef（bindContext 绑定一次），
// 而不是 render(ctx) 传进来的那个 ctx。所以想抓"界面上真正画了哪些字"，
// 必须在 getContext('2d') 返回的**同一个**代理上钩 fillText ——
// 往 render() 传自己造的 ctx 是抓不到任何东西的（会得到空数组）。
const captured = [];

function makeCtx2D() {
  const noop = () => {};
  const target = {
    canvas: { width: 375, height: 667 },
    measureText: () => ({ width: 40 }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createLinearGradient: () => ({ addColorStop: noop }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    fillText: (s) => captured.push(String(s)),
  };
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      return typeof k === 'string' ? noop : undefined;
    },
    set() { return true; },
  });
}

function installWx() {
  const handlers = { touchstart: [], touchmove: [], touchend: [] };
  globalThis.wx = {
    createCanvas: () => ({ width: 375, height: 667, getContext: () => makeCtx2D() }),
    getSystemInfoSync: () => ({
      windowWidth: 375, windowHeight: 667, pixelRatio: 2,
      screenWidth: 375, screenHeight: 667, safeArea: { top: 0, bottom: 667 },
    }),
    onTouchStart: (cb) => handlers.touchstart.push(cb),
    onTouchMove: (cb) => handlers.touchmove.push(cb),
    onTouchEnd: (cb) => handlers.touchend.push(cb),
    setStorageSync: () => {}, getStorageSync: () => '',
    createInnerAudioContext: () => ({ play: () => {}, stop: () => {}, destroy: () => {} }),
  };
  // Renderer.start 会用 requestAnimationFrame 拉起主循环；
  // 我们自己手动 _frame() 驱动，所以这里给个不自动跑的实现。
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  return handlers;
}

const handlers = installWx();
const { default: Main } = await import(new URL('js/main.js', ROOT).href);
const app = new Main();

const W = 375, H = 667;
function drive(n = 1) { for (let i = 0; i < n; i++) app._frame(16); }
function tapAt(x, y) {
  handlers.touchstart.forEach((cb) => cb({ touches: [{ clientX: x, clientY: y, identifier: 0 }] }));
}
/** 点某个热区的中心 */
function tapRect(r) { tapAt(r.x + r.w / 2, r.y + r.h / 2); }
/** 点当前场景面积最大的热区（≈ 主按钮） */
function tapMain() {
  const s = app.current;
  if (!s || !s._touches || !s._touches.length) return false;
  const r = s._touches.reduce((a, b) =>
    (a.rect.w * a.rect.h >= b.rect.w * b.rect.h ? a : b)).rect;
  tapRect(r);
  return true;
}
/** 点"下月/结算"按钮（几何定位，不依赖注册顺序） */
function tapNext() {
  const r = app.current && app.current._nextBtn;
  if (!r) return false;
  tapRect(r);
  return true;
}

/** 驱动一帧，返回这一帧真正画出的所有文案 */
function captureTexts() {
  captured.length = 0;
  app._frame(16);
  return captured.slice();
}

console.log('\n=== 十二月 UX 诊断 ===');

section('[1] 开局到十二月');

// layout() 在首帧才跑，必须先驱动一帧再点，否则热区是空的
drive(1);
check('菜单已注册开始按钮', app.current._touches.length >= 1,
  `热区数=${app.current._touches.length}`);
tapMain();
drive(2);
check('已进入新闻场景（第 1 月）', app.current === app.scenes.newsflash,
  '当前=' + (app.current && app.current.name));

const monthTexts = [];
let lastMonthTexts = null;
let newsAtDec = null;
let guard = 0;

while (app.bus.phase !== 'OVER' && guard++ < 80) {
  if (app.current === app.scenes.newsflash) {
    const turn = app.current.turn;
    const texts = captureTexts();
    monthTexts.push({ turn, texts });
    if (turn === 12) newsAtDec = { turn, texts };
    tapMain();               // 关掉新闻
    drive(2);
  } else if (app.current === app.scenes.trading) {
    // captureTexts 会驱动一帧，顺带刷新 _nextBtn，所以先抓文案再取按钮
    const texts = captureTexts();
    if (app.bus.turn === 12) lastMonthTexts = texts;
    if (!tapNext()) break;   // 点"下月"或"结算"
    drive(2);
  } else if (app.current === app.scenes.result) {
    break;
  } else {
    break;
  }
}

check('新闻卡记录了 12 个月的月份标注', monthTexts.length === 12, `实际 ${monthTexts.length} 次`);
check('★ 十二月确实有新闻（未被跳过）', !!newsAtDec, newsAtDec ? 'ok' : '未捕获到 12 月新闻');

if (newsAtDec) {
  const all = newsAtDec.texts.join('|');
  check('★ 十二月新闻卡上写着"十二月"', all.includes('十二月'), all.slice(0, 140));
}

section('[2] 末月提示');

if (lastMonthTexts) {
  const all = lastMonthTexts.join('|');
  check('★ 末月顶栏出现"最后一个月"提示', all.includes('最后一个月'), all.slice(0, 160));
  check('★ 末月按钮文案为"结束本年"（而非"进入下一个月"）',
    all.includes('结束本年'), all.slice(0, 160));
  check('末月不再出现"进入下个月"诱导文案', !/进入.{0,2}月/.test(all), all.slice(0, 160));
} else {
  check('捕获到末月交易界面', false, 'lastMonthTexts 为空');
}

section('[3] 月份标注连续性');

{
  // 每个月的新闻卡都应带上对应中文月份名
  const NAMES = ['一月', '二月', '三月', '四月', '五月', '六月',
    '七月', '八月', '九月', '十月', '十一月', '十二月'];
  let mismatch = [];
  monthTexts.forEach(({ turn, texts }) => {
    const want = NAMES[(turn - 1) % 12];
    if (!texts.join('|').includes(want)) mismatch.push(`turn${turn} 缺 ${want}`);
  });
  check('12 个月的新闻卡月份标注全部正确', mismatch.length === 0, mismatch.join('; '));
}

// ============================================================
console.log('\n=== 结果 ===');
if (failed) {
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  console.log('十二月 UX 诊断未通过 ✗');
  process.exit(1);
} else {
  console.log(`通过 ${passed} 项，失败 0 项`);
  console.log('十二月 UX 诊断通过 ✓');
}
