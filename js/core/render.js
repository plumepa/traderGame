/**
 * 渲染管线
 *
 * 负责：canvas 初始化、DPR 适配、CRT 扫描线滤镜、逐帧调度。
 */

import { PALETTE, PIXEL } from '../styles/palette';
import { setSafeArea } from '../styles/layout';
import { bindContext, rect } from '../styles/widgets';

export default class Renderer {
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.dpr = 1;
    this.width = 0; // 逻辑宽（CSS 像素）
    this.height = 0;
    this.rafId = null;

    this._setup();
    bindContext(ctx); // 把 ctx 交给 widgets，供各处绘制使用
  }

  /**
   * 屏幕适配 —— 用 DPR 缩放，保证高分屏不糊
   */
  _setup() {
    const info = wx.getSystemInfoSync();
    this.dpr = info.pixelRatio || 1;
    this.width = info.windowWidth;
    this.height = info.windowHeight;

    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;

    // 把绘制坐标系统一到逻辑像素，之后所有布局都用 width/height
    this.ctx.scale(this.dpr, this.dpr);

    // 记录安全区（灵动岛 / 刘海 / 状态栏 / Home 指示条）。
    // 各场景在 layout / render 里通过 styles/layout 的 contentTop() 取用，
    // 保证内容不会被顶部挖孔遮住。
    this.safe = setSafeArea(info);
  }

  /**
   * 清屏 —— 铺底色
   */
  clear() {
    this.ctx.fillStyle = PALETTE.bg;
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  /**
   * CRT 扫描线滤镜 —— 每 4px 加一条半透明暗线
   * 这是"复古终端感"的关键一笔
   */
  scanlines() {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
    for (let y = 0; y < this.height; y += 4) {
      ctx.fillRect(0, y, this.width, PIXEL);
    }
  }

  /**
   * 四角暗角，强化 CRT 球面感
   */
  vignette() {
    const ctx = this.ctx;
    const grad = ctx.createRadialGradient(
      this.width / 2,
      this.height / 2,
      Math.min(this.width, this.height) * 0.35,
      this.width / 2,
      this.height / 2,
      Math.max(this.width, this.height) * 0.75,
    );
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  /**
   * 启动逐帧循环
   * @param {Function} onFrame 每帧回调 (dt) => void
   */
  start(onFrame) {
    let last = Date.now();

    const loop = () => {
      const now = Date.now();
      const dt = now - last;
      last = now;

      this.clear();
      onFrame(dt);
      this.scanlines();
      this.vignette();

      this.rafId = requestAnimationFrame(loop);
    };

    this.rafId = requestAnimationFrame(loop);
  }

  stop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
