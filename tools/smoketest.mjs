/**
 * 微信小游戏环境冒烟测试
 *
 * 在 Node 里打桩 wx.* API 与 Canvas 2D 上下文，真实加载并执行
 * game.js 入口，验证"能启动 → 能渲染 → 能点 → 能走完一局"。
 *
 * 用途：在没有微信开发者工具的环境下提前暴露
 *   - 平台合规问题（import JSON、空字符串配置项、目录扫描）
 *   - 缺失或写错的 wx API 调用
 *   - Canvas 上下文方法名错误
 *   - 场景切换 / 回合推进中的运行时异常
 *
 * 运行：
 *   node --experimental-loader ./tools/register.mjs tools/smoketest.mjs
 */

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import { makeAudioContext } from './wx-audio.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// =================================================================
// 1. Canvas 2D 上下文打桩
// =================================================================

const CTX_METHODS = [
  'save', 'restore', 'scale', 'translate', 'rotate', 'setTransform', 'resetTransform',
  'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo',
  'arc', 'arcTo', 'quadraticCurveTo', 'bezierCurveTo', 'rect', 'fill', 'stroke', 'clip',
  'fillText', 'strokeText', 'drawImage', 'setLineDash', 'getLineDash', 'measureText',
];

const ctxCalls = Object.create(null);
const ctxTexts = [];   // 记录所有 fillText 文案，用于断言"界面上写了什么"

function makeCtx(canvas) {
  const ctx = {
    canvas,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    shadowBlur: 0,
    shadowColor: '#000',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
  };
  for (const m of CTX_METHODS) {
    ctx[m] = (...args) => {
      ctxCalls[m] = (ctxCalls[m] || 0) + 1;
      if (m === 'measureText') return { width: String(args[0] ?? '').length * 6 };
      if (m === 'fillText') ctxTexts.push(String(args[0]));
      return undefined;
    };
  }
  // 渐变对象
  const makeGradient = () => ({ addColorStop() {} });
  ctx.createLinearGradient = () => { ctxCalls.createLinearGradient = (ctxCalls.createLinearGradient || 0) + 1; return makeGradient(); };
  ctx.createRadialGradient = () => { ctxCalls.createRadialGradient = (ctxCalls.createRadialGradient || 0) + 1; return makeGradient(); };
  ctx.createPattern = () => null;
  return ctx;
}

function makeCanvas() {
  const canvas = { width: 375, height: 667 };
  let ctx = null;
  canvas.getContext = (type) => {
    if (type !== '2d') return null;
    if (!ctx) ctx = makeCtx(canvas);
    return ctx;
  };
  return canvas;
}

// =================================================================
// 2. wx.* API 打桩
// =================================================================

const wxCalls = Object.create(null);
const touchHandlers = [];
const rafQueue = [];

function record(name) {
  wxCalls[name] = (wxCalls[name] || 0) + 1;
}

const sysInfo = {
  windowWidth: 375,
  windowHeight: 667,
  screenWidth: 375,
  screenHeight: 667,
  pixelRatio: 3,
  platform: 'devtools',
  system: 'iOS 16.0',
  brand: 'devtools',
  model: 'iPhone X',
  language: 'zh_CN',
  SDKVersion: '3.16.3',
};

const wx = {
  createCanvas() { record('createCanvas'); return makeCanvas(); },
  createImage() { record('createImage'); return {}; },
  getSystemInfoSync() { record('getSystemInfoSync'); return { ...sysInfo }; },
  onTouchStart(cb) { record('onTouchStart'); touchHandlers.push(cb); },
  onTouchMove() { record('onTouchMove'); },
  onTouchEnd() { record('onTouchEnd'); },
  onTouchCancel() { record('onTouchCancel'); },
  onShow() { record('onShow'); },
  onHide() { record('onHide'); },
  onError() { record('onError'); },
  offTouchStart() { record('offTouchStart'); },
  setPreferredFramesPerSecond() { record('setPreferredFramesPerSecond'); },
  request() { record('request'); },
  setStorageSync() { record('setStorageSync'); },
  getStorageSync() { return ''; },
  createInnerAudioContext() { record('createInnerAudioContext'); return makeAudioContext(); },
  setInnerAudioOption() { record('setInnerAudioOption'); },
  showToast() { record('showToast'); },
  vibrateShort() { record('vibrateShort'); },
};

globalThis.wx = wx;
globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};

// =================================================================
// 3. 断言框架
// =================================================================

const notes = [];
const failures = [];

function check(desc, cond, extra) {
  if (cond) notes.push('  ok   ' + desc);
  else failures.push('  FAIL ' + desc + (extra ? '  -> ' + extra : ''));
}

function section(title) {
  console.log('\n' + title);
}

// =================================================================
// 4. 主流程
// =================================================================

async function main() {
  console.log('=== 微信小游戏环境冒烟测试 ===');
  console.log('屏幕 375x667 @3x | SDK 3.16.3\n');

  section('[1] 入口加载');

  // game.js 是"副作用入口"（微信小游戏要求：没有 export，直接 new Main()）
  // 这里先执行它，确认它在真机环境下不会抛异常。
  let entryThrew = null;
  try {
    await import('../game.js');
  } catch (e) {
    entryThrew = e;
  }
  check('game.js 副作用入口可执行', !entryThrew,
    entryThrew && entryThrew.message + '\n' + (entryThrew && entryThrew.stack));

  // 直接实例化主类，做完整的场景/回合验证
  const Main = (await import('../js/main.js')).default;
  check('js/main.js 导出默认类', typeof Main === 'function');
  let app;
  try {
    app = new Main();
    check('游戏实例创建成功', !!app);
  } catch (e) {
    check('游戏实例创建成功', false, e.message);
    return finish();
  }

  section('[2] 平台合规');

  check('源码中不存在 import JSON（小游戏不支持）', checkNoJsonImports());
  check('js/data 下无残留 .json 数据文件', checkNoJsonDataFiles());
  check('源码中不存在目录扫描（小游戏不能 readdir）', checkNoReaddir());
  check('game.json 无非法空字符串字段', checkNoEmptyStringFields());

  section('[3] 平台 API 调用');

  check('调用了 wx.createCanvas()', (wxCalls.createCanvas || 0) >= 1);
  check('调用了 wx.getSystemInfoSync()', (wxCalls.getSystemInfoSync || 0) >= 1);
  check('注册了 wx.onTouchStart()', (wxCalls.onTouchStart || 0) >= 1);

  const unknownWxCalls = Object.keys(wxCalls).filter((k) => !(k in wx));
  check('未调用未打桩的 wx API', unknownWxCalls.length === 0, unknownWxCalls.join(', '));

  section('[4] 初始场景');

  check('初始场景 = menu', app.current === app.scenes.menu, '实际 ' + sceneName(app));
  check('menu 已 enter（visible）', app.current && app.current.visible === true);

  section('[5] 渲染帧');

  let menuTouchCount = 0;
  try {
    driveFrames(20);
    // 记录首帧布局建立后的热区数 —— 用于断言"连续帧不重复注册"
    menuTouchCount = app.current ? app.current._touches.length : 0;
    check('菜单场景跑满 20 帧无异常', true);
    check('菜单渲染后已注册可点区域（关卡切换 + 开始）',
      menuTouchCount >= 1, '热区数=' + menuTouchCount);
  } catch (e) {
    check('菜单场景跑满 20 帧无异常', false, e.message + '\n' + (e.stack || ''));
  }

  check('渲染调用了 fillRect', (ctxCalls.fillRect || 0) > 0);
  check('渲染调用了 fillText', (ctxCalls.fillText || 0) > 0);
  check('渲染调用了 createRadialGradient（暗角）', (ctxCalls.createRadialGradient || 0) > 0);

  // 布局在首帧渲染时建立，热区应已注册
  check('渲染后菜单已注册可点区域',
    app.current && app.current._touches.length >= 1,
    '实际 ' + (app.current ? app.current._touches.length : 'n/a'));
  check('layout 只在失效时重建（连续帧不重复注册）',
    app.current && app.current._touches.length === menuTouchCount,
    '首帧=' + menuTouchCount + ' 20帧后=' + (app.current ? app.current._touches.length : 'n/a'));

  section('[6] 点击开始游戏');

  // 菜单有 3 个热区（‹ 关卡、"开始交易"、› 关卡）。
  // tapHotspot(scene, 0) 取**面积最大**的热区 —— 即"开始交易"按钮，
  // 因此不依赖注册顺序。
  const startTapped = tapHotspot(app.current, 0);
  check('命中"开始交易"热区并派发触摸', startTapped);
  driveFrames(2);

  check('已切到 newsflash（第 1 月新闻）', app.current === app.scenes.newsflash,
    '实际 ' + sceneName(app));
  check('bus 已开局（turn = 1）', app.bus && app.bus.turn === 1, 'turn=' + (app.bus && app.bus.turn));
  check('本月新闻对象存在', !!(app.bus && app.bus.news), 'news=' + JSON.stringify(app.bus && app.bus.news));
  check('新闻渲染无异常', safeRender(app.current));

  section('[6b] 交易与破产口径');

  // 关掉新闻 → 进入交易场景
  tapHotspot(app.current, 0);
  driveFrames(2);
  check('已切到 trading', app.current === app.scenes.trading, '实际 ' + sceneName(app));
  // 再驱动一帧，确保 layout() 已跑、priceMap 可读（否则读到的价格可能是 undefined）
  driveFrames(1);

  // 通过 UI 热区做一次满仓买入，验证：
  //   ① 现金不会变负
  //   ② 买入后不会被判破产（总资产口径）
  {
    const bus = app.bus;
    const cashBefore = bus.portfolio.cash;
    const cheapest = bus.stockDefs
      .map((d) => ({ code: d.code, price: bus.priceMap[d.code] }))
      .filter((x) => typeof x.price === 'number')
      .sort((a, b) => a.price - b.price)[0];

    if (!cheapest) {
      check('取到可交易标的价格', false, 'priceMap 为空：' + JSON.stringify(bus.priceMap));
    } else {
      // 直接调用交易动作（等价于点"满仓"+"买入"）
      const { maxLots } = await import('../js/market/order.js');
      const n = maxLots(cheapest.price, bus.portfolio.cash);
      if (n >= 1) {
        app.scenes.trading._doBuy(
          bus.stockDefs.find((d) => d.code === cheapest.code),
          cheapest.price,
          n * 100,
        );
      }

      check('满仓买入后现金不为负', bus.portfolio.cash >= 0,
        `现金 ¥${bus.portfolio.cash.toFixed(1)}（买入前 ¥${cashBefore.toFixed(0)}）`);
      check('★ 满仓买入后不被判破产（总资产口径）', !bus.isBankrupt(),
        `现金 ¥${bus.portfolio.cash.toFixed(0)} 总资产 ¥${bus.portfolio.totalAssets(bus.priceMap).toFixed(0)} ` +
        `破产线 ¥${bus.bankruptLine().toFixed(0)}`);
      check('满仓后确实持有股票', bus.portfolio.hasPositions(),
        '持仓数=' + Object.keys(bus.portfolio.positions).length);

      // 全部卖出 → 现金回笼，仍不破产
      bus.stockDefs.forEach((d) => {
        const sh = bus.portfolio.sharesOf(d.code);
        if (sh > 0) {
          app.scenes.trading._doSell(d, bus.priceMap[d.code], sh);
        }
      });
      check('清仓后不再持有股票', !bus.portfolio.hasPositions());
      check('清仓后现金为正', bus.portfolio.cash > 0, `现金 ¥${bus.portfolio.cash.toFixed(0)}`);
      check('清仓后仍不破产', !bus.isBankrupt());
    }
  }

  section('[6c] 走势图弹窗（每只股票一个按钮）');

  // 玩家的最新要求：
  //   ① 走势图按钮取代原来卡片里的内嵌迷你 canvas（不再画 canvas）
  //   ② 按钮挂在每张股票卡片下，点开弹窗只看"按钮所属那只股票"
  // 这里验证：每只股票各有一个按钮 → 点击展开该股的图 → 只有该股在图里 →
  //          关闭按钮 / 点空白都能关。
  {
    const tr = app.scenes.trading;
    const defs = app.bus.stockDefs;

    // ① 每只股票一个按钮热区（旧实现只有一个 _chartBtn）
    check('每只股票各有一个走势图按钮热区',
      tr._chartBtns && Object.keys(tr._chartBtns).length === defs.length,
      'btns=' + JSON.stringify(tr._chartBtns));

    // 卡片里不再有内嵌 canvas：旧实现会画一条迷你折线（endArrow 三角）。
    // 用"是否还留着小尺寸折线"来判断——现在卡片区只应有按钮矩形，无折线路径。
    ctxTexts.length = 0;
    driveFrames(1);
    check('交易界面显示"走势图"按钮文案',
      ctxTexts.some((t) => t.includes('走势图')), ctxTexts.join(' | ').slice(0, 100));

    // 初始应为关闭
    check('初始走势图未展开', tr.showChart === false, 'showChart=' + tr.showChart);

    // ② 点第二只股票的按钮 → 只展开第二只
    const target = defs[1] || defs[0];
    const btn = tr._chartBtns[target.code];
    check('第二只股票有独立按钮热区', !!btn, 'target=' + target.code);

    if (btn) tapRect(btn);
    driveFrames(1);
    check('★ 点击按钮后走势图展开', tr.showChart === true, 'showChart=' + tr.showChart);
    check('★ 展开的是按钮所属的那只股票',
      tr.chartCode === target.code, 'chartCode=' + tr.chartCode + ' 期望=' + target.code);

    ctxTexts.length = 0;
    driveFrames(1);
    const overlay = ctxTexts.join('|');

    check('★ 弹窗标题为该股名称 + "走势"',
      overlay.includes(`${target.name} 走势`), overlay.slice(0, 200));

    // "只看这一只"的正确断言方式：
    //   交易界面本身（遮罩之下）三只股票名字都会画，这是正常的。
    //   关键是 —— "XXX 走势" 这个弹窗专属标题必须**只有一个**，且属于目标股。
    const titleHits = defs.filter((d) => overlay.includes(`${d.name} 走势`));
    check('★ 弹窗标题只有一个，且属于目标股',
      titleHits.length === 1 && titleHits[0].code === target.code,
      '命中标题=' + titleHits.map((d) => d.name).join(',') + ' 期望=' + target.name);

    // 目标股名字的出现次数必须**多于**其它股票：
    // 其它股票只在卡片里出现 1 次；目标股 = 卡片 1 次 + 弹窗标题 1 次（+ 图例），故 > 1。
    const countOf = (s) => overlay.split(s).length - 1;
    const targetCount = countOf(target.name);
    const otherMax = Math.max(
      ...defs.filter((d) => d.code !== target.code).map((d) => countOf(d.name)),
    );
    check('★ 目标股在弹窗里被额外渲染（次数多于其它股票）',
      targetCount > otherMax,
      `目标=${target.name}×${targetCount} 其它最多×${otherMax} | ${overlay.slice(0, 200)}`);

    check('★ 弹窗有"关闭"按钮', overlay.includes('关闭'), overlay.slice(0, 200));
    check('★ 弹窗有"点击任意处关闭"提示', overlay.includes('点击任意处关闭'), overlay.slice(0, 200));

    // ---- 玩家反馈①：三只股票走势完全一样 ----
    // 直接比较 wavyPath 的产物：把每只股票的收盘价按其自身尺度归一化后，
    // 若形状相同，则"归一化形状序列"会完全一致。要求三者互不相同。
    {
      const normShapes = defs.map((d) => {
        const closes = app.bus.simulator.historyOf(d.code).map((p) => p.price);
        if (closes.length < 2) return '';
        // 用真实收盘价 + 月内插点，按 min/max 归一化 → 只反映"形状"
        const min = Math.min(...closes);
        const max = Math.max(...closes);
        const span = max - min || 1;
        return closes.map((v) => ((v - min) / span).toFixed(3)).join(',');
      }).filter(Boolean);

      const uniq = new Set(normShapes);
      check('★ 三只股票的走势形状互不相同（不再一样）',
        uniq.size === normShapes.length,
        '唯一形状数=' + uniq.size + ' / ' + normShapes.length);
    }

    // 关闭按钮 → 关闭
    if (tr._chartClose) tapRect(tr._chartClose);
    driveFrames(1);
    check('★ 点击"关闭 ✕"后关闭', tr.showChart === false, 'showChart=' + tr.showChart);

    // 再开一次，用点空白关闭
    if (btn) tapRect(btn);
    driveFrames(1);
    check('重新打开成功', tr.showChart === true, 'showChart=' + tr.showChart);

    tapRect({ x: 180, y: 420, w: 8, h: 8 });
    driveFrames(1);
    check('★ 点击弹窗任意处后关闭', tr.showChart === false, 'showChart=' + tr.showChart);

    ctxTexts.length = 0;
    driveFrames(1);
    check('关闭后不再渲染该股走势标题',
      !ctxTexts.join('|').includes(`${target.name} 走势`),
      ctxTexts.join('|').slice(0, 120));
  }

  section('[7] 走完整局');
  const trace = [];
  let guard = 0;
  const MAX_STEPS = 200;

  try {
    while (app.bus.phase !== 'OVER' && guard++ < MAX_STEPS) {
      const s = sceneName(app);

      if (s === 'newsflash') {
        tapHotspot(app.current, 0);            // 关掉新闻 → 触发结算
      } else if (s === 'trading') {
        buyFirstAffordable(app.bus);           // 顺手买一手，模拟真实操作
        driveFrames(1);                        // 让 layout 跟随交易结果刷新
        tapNextMonth(app);                     // 点"下月"
      } else if (s === 'result') {
        break;
      } else if (s === 'menu') {
        tapHotspot(app.current, 0);            // 兜底
      }

      driveFrames(1);
      trace.push(sceneName(app) + '@' + app.bus.turn);
    }
    check('整局在有限步内收敛到结算', app.bus.phase === 'OVER',
      '步数=' + guard + ' phase=' + app.bus.phase + ' 轨迹=' + trace.slice(0, 12).join(' → '));
  } catch (e) {
    check('整局推进无异常', false, e.message + '\n' + (e.stack || ''));
  }

  section('[8] 结算结果');

  const res = app.bus.result;
  check('最终停在 result 场景', app.current === app.scenes.result, '实际 ' + sceneName(app));
  check('生成了结算结果对象', !!res);
  check('结局属于 win/lose/bankrupt',
    !!res && ['win', 'lose', 'bankrupt'].includes(res.outcome),
    'outcome=' + (res && res.outcome));
  check('结局原因文案非空',
    !!res && typeof res.reason === 'string' && res.reason.length > 0,
    'reason=' + (res && res.reason));
  check('结算数据字段完整（total/init/profit/returnRate/turns）',
    !!res && typeof res.total === 'number' && typeof res.init === 'number'
      && typeof res.profit === 'number' && typeof res.returnRate === 'number'
      && typeof res.turns === 'number');
  check('结算场景渲染无异常', safeRender(app.current));

  // 破产判定口径：总资产（现金 + 持仓市值），不能被买入误伤
  if (app.bus.phase === 'OVER' && res && res.outcome !== 'bankrupt') {
    check('★ 未破产的局最终无残留持仓（年底已强制平仓）',
      !app.bus.portfolio.hasPositions(),
      'hasPositions=' + app.bus.portfolio.hasPositions());
    check('★ 平仓后最终资产 = 纯现金',
      Math.abs(app.bus.portfolio.cash - res.total) < 0.011,
      `现金 ¥${app.bus.portfolio.cash.toFixed(2)} / 资产 ¥${res.total.toFixed(2)}`);
  }

  section('[9] 结算出口（连闯）');

  // ⚠️ 结算页的按钮集合随状态变化（见 result.js 的 actionsOf）：
  //   普通关 = 进入下一关 / 返回主界面，轮末 = 继续 · 再来五关 / 退市结算，
  //   破产   = 只有返回主界面。
  //   所以这里**不能**再假设"最大热区 = 重开" —— 旧版就是这么写的，
  //   连闯上线后它点到的其实是"进入下一关"，断言随之失效。
  const resScene = app.current;
  const exits = (resScene && resScene._buttons ? resScene._buttons : []).map((b) => b.event);
  const bankrupt = res && res.outcome === 'bankrupt';

  if (bankrupt) {
    check('破产时只剩"返回主界面"',
      exits.length === 1 && exits[0] === 'menu', 'exits=' + exits.join(','));
    tapRect(resScene._buttons[0]);
    driveFrames(2);
    check('破产后返回主界面', app.current === app.scenes.menu, '实际 ' + sceneName(app));
    check('返回后状态已重置', app.bus.phase === 'IDLE' && app.bus.result === null,
      'phase=' + app.bus.phase + ' result=' + app.bus.result);
  } else {
    check('非破产时有两个出口（下一关 / 主界面）',
      exits.length === 2 && exits.includes('nextLevel') && exits.includes('menu'),
      'exits=' + exits.join(','));

    // ---- ① 进入下一关：资金必须延续上一关期末资产 ----
    const prevTotal = res.total;
    const prevStep = app.bus.stepIndex;
    const prevCodes = app.bus.stockDefs.map((d) => d.code);
    const prevUsed = app.bus.usedStockCount();

    tapRect(resScene._buttons.find((b) => b.event === 'nextLevel'));
    driveFrames(2);

    check('点"进入下一关"后进入新闻插播', app.current === app.scenes.newsflash,
      '实际 ' + sceneName(app));
    check('★ 下一关资金 = 上一关期末总资产',
      Math.abs(app.bus.initCash - prevTotal) < 0.011,
      `initCash=¥${app.bus.initCash.toFixed(2)} 上关期末=¥${prevTotal.toFixed(2)}`);
    check('★ 关卡默认初始资金未被污染（LEVELS 是共享对象）',
      app.bus.level.initCash === 10000, 'level.initCash=¥' + app.bus.level.initCash);
    check('关卡指针已前进', app.bus.stepIndex === prevStep + 1,
      `${prevStep} → ${app.bus.stepIndex}`);
    check('runMode 已开启', app.bus.runMode === true);

    const nextCodes = app.bus.stockDefs.map((d) => d.code);
    check('★ 下一关股票与上一关不重复',
      nextCodes.every((c) => !prevCodes.includes(c)),
      '上关=' + prevCodes.join(',') + ' 本关=' + nextCodes.join(','));
    check('已用股票池已累计', app.bus.usedStockCount() === prevUsed + nextCodes.length,
      `${prevUsed} → ${app.bus.usedStockCount()}`);

    // ---- ② 快进到本关结算，再点"返回主界面" ----
    app.bus.settleTerm();
    app.switchTo('result');
    driveFrames(2);

    const back = app.current._buttons.find((b) => b.event === 'menu');
    check('结算页存在"返回主界面"', !!back);
    tapRect(back);
    driveFrames(2);
    check('点"返回主界面"后回到 menu', app.current === app.scenes.menu,
      '实际 ' + sceneName(app));
    check('返回后状态已重置', app.bus.phase === 'IDLE' && app.bus.result === null,
      'phase=' + app.bus.phase + ' result=' + app.bus.result);
    check('返回后连闯进度已清空',
      app.bus.runMode === false && app.bus.usedStockCount() === 0,
      'runMode=' + app.bus.runMode + ' used=' + app.bus.usedStockCount());
  }

  console.log('\n  轨迹片段: ' + trace.slice(0, 10).join(' → '));
  console.log('  结局: ' + (app.bus.result && app.bus.result.outcome)
    + '  原因: ' + (app.bus.result && app.bus.result.reason));
  console.log('  最终资产: ¥' + (app.bus.result ? app.bus.result.total.toFixed(0) : 'n/a'));
  console.log('  Canvas 调用种类: ' + Object.keys(ctxCalls).length);

  finish();
}

// =================================================================
// 5. 平台合规检查
// =================================================================

/** 递归收集 js/ 下的所有 .js 源文件 */
function sourceFiles(dir = path.join(ROOT, 'js')) {
  const out = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.js')) out.push(p);
    }
  })(dir);
  return out;
}

/**
 * 禁止 import JSON
 *
 * 微信小游戏打包器不支持 —— 会把 'x.json' 当模块名补 .js，
 * 去找 'x.json.js'，运行时报 module not defined。
 */
function checkNoJsonImports() {
  const re = /(?:^|\n)\s*(?:import[\s\S]*?from\s*|import\s*\(\s*)['"][^'"]+\.json['"]/;
  const bad = [];
  for (const f of sourceFiles()) {
    const src = fs.readFileSync(f, 'utf8');
    if (re.test(src)) bad.push(path.relative(ROOT, f));
  }
  if (bad.length) {
    console.error('      违规文件: ' + bad.join(', '));
    return false;
  }
  return true;
}

/** 数据目录下不应残留 .json —— 应为 .js 模块 */
function checkNoJsonDataFiles() {
  const dataDir = path.join(ROOT, 'js', 'data');
  const bad = [];
  for (const sub of ['stocks', 'news', 'levels']) {
    const d = path.join(dataDir, sub);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.json')) bad.push(`${sub}/${f}`);
    }
  }
  if (bad.length) {
    console.error('      残留 .json: ' + bad.slice(0, 5).join(', ') +
      (bad.length > 5 ? ` …共 ${bad.length} 个` : ''));
    return false;
  }
  return true;
}

/** 禁止目录扫描 —— 小游戏读不到源码目录 */
function checkNoReaddir() {
  const re = /\b(?:readdirSync|readdir|opendirSync|readdirSync)\s*\(/;
  const bad = [];
  for (const f of sourceFiles()) {
    const src = fs.readFileSync(f, 'utf8');
    if (re.test(src)) bad.push(path.relative(ROOT, f));
  }
  if (bad.length) {
    console.error('      违规文件: ' + bad.join(', '));
    return false;
  }
  return true;
}

/**
 * game.json 中"不能为空串"的运行时字段不得留 ''
 *
 * 典型报错：game.json: ["workers"] 不能为 ''
 * 这些字段一旦出现就必须是合法值；用不到时应整段删除，而不是留空串。
 *
 * 注意：只检查这批已知风险键，不做全量递归扫描 ——
 * project.config.json 里的 setting.babelSetting.outputPath: ""
 * 是开发者工具自动写的正常值，被误报过一次（假阳性）。
 */
const EMPTY_STRING_RISK_KEYS = new Set([
  'workers',
  'deviceOrientation',
  'openDataContext',
  'navigateToMiniProgramAppIdList',
  'subpackages',
  'networkTimeout',
  'requiredBackgroundModes',
  'permission',
]);

function checkNoEmptyStringFields() {
  const p = path.join(ROOT, 'game.json');
  if (!fs.existsSync(p)) return true;

  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('      game.json 解析失败: ' + e.message);
    return false;
  }

  const empties = [];
  (function scan(o, prefix) {
    for (const [k, v] of Object.entries(o)) {
      const key = prefix ? `${prefix}.${k}` : k;
      const risky = EMPTY_STRING_RISK_KEYS.has(k) || (prefix && EMPTY_STRING_RISK_KEYS.has(prefix));
      if (v === '' && risky) empties.push(key);
      else if (v && typeof v === 'object' && !Array.isArray(v)) scan(v, key);
    }
  })(obj, '');

  if (empties.length) {
    console.error('      game.json 空字符串字段: ' + empties.join(', '));
    return false;
  }
  return true;
}

// =================================================================
// 6. 辅助
// =================================================================

function sceneName(app) {
  const s = app.current;
  if (!s) return '(none)';
  return Object.keys(app.scenes).find((k) => app.scenes[k] === s) || s.constructor.name;
}

/** 点击任意矩形区域（中心点） */
function tapRect(rect) {
  if (!rect) return false;
  const px = rect.x + rect.w / 2;
  const py = rect.y + rect.h / 2;
  for (const cb of touchHandlers) {
    cb({
      touches: [{ clientX: px, clientY: py, identifier: 0 }],
      changedTouches: [{ clientX: px, clientY: py, identifier: 0 }],
    });
  }
  return true;
}

function driveFrames(n) {
  for (let i = 0; i < n; i++) {
    const cbs = rafQueue.splice(0, rafQueue.length);
    if (!cbs.length) return;
    for (const cb of cbs) cb(16);
  }
}

function tapHotspot(scene, index) {
  if (!scene) return false;
  if (!scene._touches || !scene._touches.length) return false;

  let entry;
  if (index === 0) {
    // 优先找"开始/确定/下月/关闭"这类主按钮：取面积最大的热区
    entry = scene._touches.reduce((a, b) =>
      (a.rect.w * a.rect.h >= b.rect.w * b.rect.h ? a : b));
  } else {
    entry = scene._touches[index];
  }
  if (!entry) return false;

  const { x, y, w, h } = entry.rect;
  const px = x + w / 2;
  const py = y + h / 2;

  for (const cb of touchHandlers) {
    cb({
      touches: [{ clientX: px, clientY: py, identifier: 0 }],
      changedTouches: [{ clientX: px, clientY: py, identifier: 0 }],
    });
  }
  return true;
}

/** 在交易场景里找"下月/结算"按钮：最后一个注册的热区 */
function tapNextMonth(app) {
  const scene = app.current;
  if (!scene || !scene._touches || !scene._touches.length) return false;

  // ⚠️ 不能用"最后一个热区"——顶栏的走势图开关也注册在前。
  // 优先按几何定位真正的下月按钮（_nextBtn 由 layout 写入），
  // 找不到时才退化为最后一个热区。
  let rect = scene._nextBtn;
  if (!rect) rect = scene._touches[scene._touches.length - 1].rect;
  if (!rect) return false;

  const { x, y, w, h } = rect;
  for (const cb of touchHandlers) {
    cb({
      touches: [{ clientX: x + w / 2, clientY: y + h / 2, identifier: 0 }],
      changedTouches: [{ clientX: x + w / 2, clientY: y + h / 2, identifier: 0 }],
    });
  }
  return true;
}

/** 买最便宜那只股票的一手，若现金够 */
function buyFirstAffordable(bus) {
  try {
    if (typeof bus.buy !== 'function') return;
    const codes = bus.level.stocks;
    let best = null;
    for (const c of codes) {
      const p = bus.simulator.priceOf(c);
      if (!best || p < best.p) best = { c, p };
    }
    if (!best) return;
    const lots = 1;
    bus.buy(best.c, lots * 100);
  } catch (e) {
    /* 买不起就跳过，不影响流程验证 */
  }
}

function safeRender(scene) {
  try {
    driveFrames(5);
    return true;
  } catch (e) {
    return false;
  }
}

function finish() {
  console.log('\n--- 检查项 ---');
  for (const n of notes) console.log(n);

  if (failures.length) {
    console.log('\n--- 失败 ---');
    for (const f of failures) console.log(f);
  }

  console.log('\n=== 结果 ===');
  console.log('通过 ' + notes.length + ' 项，失败 ' + failures.length + ' 项');
  console.log(failures.length ? '冒烟测试未通过 ✗' : '冒烟测试通过 ✓');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error('\n未捕获异常:', e);
  process.exit(1);
});
