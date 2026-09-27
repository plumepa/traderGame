/**
 * wx 音频 API 的可观测桩
 *
 * 真实 InnerAudioContext 有 play/pause/stop/destroy/seek 和一堆 onXxx 回调，
 * 还带 src / loop / volume / paused 这些**可读属性**。
 * 之前各测试里那句 `() => ({ play(){}, stop(){}, destroy(){} })` 太薄了：
 * 读 ctx.paused 拿到 undefined，读 ctx.loop 也拿不到，断言不了任何东西。
 * 这里给一个行为真实的版本，并把每次调用记进 log 供断言。
 */

/** 造一个 InnerAudioContext 桩 */
export function makeAudioContext(log = []) {
  const handlers = {};
  const fire = (name) => {
    const fn = handlers[name];
    if (typeof fn === 'function') fn();
  };
  // 每条日志都带上 ctx 自身 —— 断言"是哪个实例被播了"时才分辨得出来
  const rec = (type, extra) => log.push({ type, ctx, ...extra });

  const ctx = {
    src: '',
    loop: false,
    volume: 1,
    paused: true,
    currentTime: 0,
    duration: 0,
    destroyed: false,

    play() {
      rec('play');
      ctx.paused = false;
      fire('onPlay');
    },
    pause() {
      rec('pause');
      ctx.paused = true;
      fire('onPause');
    },
    stop() {
      rec('stop');
      ctx.paused = true;
      ctx.currentTime = 0;
      fire('onStop');
    },
    seek(t) {
      rec('seek', { t });
      ctx.currentTime = t;
    },
    destroy() {
      rec('destroy');
      ctx.destroyed = true;
      ctx.paused = true;
    },

    onPlay: (fn) => { handlers.onPlay = fn; },
    onPause: (fn) => { handlers.onPause = fn; },
    onStop: (fn) => { handlers.onStop = fn; },
    onEnded: (fn) => { handlers.onEnded = fn; },
    onError: (fn) => { handlers.onError = fn; },
    onCanplay: (fn) => { handlers.onCanplay = fn; },
    onTimeUpdate: (fn) => { handlers.onTimeUpdate = fn; },
  };

  return ctx;
}

/**
 * 可直接展开进 wx 桩的音频 API 片段。
 *
 *   globalThis.wx = { ...其他桩, ...audioApi(log) };
 */
export function audioApi(log = []) {
  return {
    createInnerAudioContext: () => {
      const c = makeAudioContext(log);
      log.push({ type: 'createInnerAudioContext', ctx: c });
      return c;
    },
    setInnerAudioOption: (opt) => {
      log.push({ type: 'setInnerAudioOption', opt });
    },
  };
}

/**
 * 完整测试台：自带 log / contexts，并附几个查询辅助。
 */
export function createAudioHarness() {
  const log = [];
  const contexts = [];
  const api = audioApi(log);
  const origCreate = api.createInnerAudioContext;
  api.createInnerAudioContext = () => {
    const c = origCreate();
    contexts.push(c);
    return c;
  };

  return {
    log,
    contexts,
    api,
    /** 最近一次创建出来的 context */
    last() {
      return contexts.length ? contexts[contexts.length - 1] : null;
    },
    /** 按类型筛日志 */
    calls(type) {
      return log.filter((e) => e.type === type);
    },
    clear() {
      log.length = 0;
    },
  };
}
