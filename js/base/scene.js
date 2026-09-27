/**
 * 场景基类
 *
 * 场景 = 一个可独立运行的画面单元（菜单 / 交易 / 结算）。
 * 由 main.js 的场景调度器管理切换。
 */

import Emitter from '../libs/tinyemitter';

export default class Scene extends Emitter {
  constructor(name) {
    super();
    this.name = name;
    this.visible = false;
    this._touches = []; // 本场景注册的触摸区域 [{ rect, onTap }]
    this._layoutW = 0;  // layout() 时记录的画布尺寸
    this._layoutH = 0;
    this._layoutKey = null; // 用于判断布局是否失效（如回合数变化）
  }

  /**
   * 进入场景时调用
   * @param {object} params 切换时传入的参数
   */
  enter(params) {
    this.visible = true;
    this.invalidateLayout();
  }

  /**
   * 离开场景时调用 —— 清理触摸监听等
   */
  exit() {
    this.visible = false;
    this._touches = [];
  }

  /**
   * 标记布局失效 —— 下一帧 render 前会重跑 layout()
   *
   * 每次场景内数据发生变化（选股、改手数、结算、回合推进），
   * 都应调用本方法，让触摸热区与新布局保持一致。
   */
  invalidateLayout() {
    this._layoutW = 0;
    this._layoutH = 0;
    this._layoutKey = null;
  }

  /**
   * 计算布局并注册触摸热区 —— 只在尺寸或数据变化时执行
   *
   * 子类覆写本方法，负责：
   *   1. 计算所有控件几何
   *   2. 调用 addTouch() 注册热区
   *
   * 注意：**不要**在 render() 里注册热区。render 每帧都跑，
   * 会导致热区反复重建，且在首帧渲染前无法响应触摸。
   *
   * @param {number} w 逻辑宽
   * @param {number} h 逻辑高
   */
  layout(w, h) {}

  /**
   * 确保布局是最新的 —— 由渲染循环在 render 之前调用
   */
  ensureLayout(w, h) {
    const key = this.layoutKey(w, h);
    if (this._layoutW === w && this._layoutH === h && this._layoutKey === key) {
      return false; // 未失效
    }
    this._layoutW = w;
    this._layoutH = h;
    this._layoutKey = key;
    this._touches = [];
    this.layout(w, h);
    return true;
  }

  /**
   * 布局缓存键 —— 子类可覆写，把影响布局的数据（如回合数）纳入
   * @returns {string|number|null}
   */
  layoutKey(w, h) {
    return null;
  }

  /**
   * 每帧逻辑更新
   * @param {number} dt 距上一帧的毫秒数
   */
  update(dt) {}

  /**
   * 每帧绘制
   * @param {CanvasRenderingContext2D} ctx
   */
  render(ctx) {}

  /**
   * 注册一个可点击区域
   * @param {object} rect { x, y, w, h }
   * @param {Function} onTap 点击回调
   * @returns {object} rect（便于绘制复用）
   */
  addTouch(rect, onTap) {
    this._touches.push({ rect, onTap });
    return rect;
  }

  /**
   * 处理触摸按下 —— 由场景调度器统一转发
   * @returns {boolean} 是否命中某个可点区域
   */
  handleTouch(x, y) {
    if (!this.visible) return false;

    // 倒序遍历，后注册的在上层
    for (let i = this._touches.length - 1; i >= 0; i--) {
      const { rect, onTap } = this._touches[i];
      if (
        x >= rect.x &&
        x <= rect.x + rect.w &&
        y >= rect.y &&
        y <= rect.y + rect.h
      ) {
        onTap(x, y);
        return true;
      }
    }
    return false;
  }
}
