/**
 * 新闻插播调度
 *
 * 两个职责：
 *   1. 开局编排 —— 每回合从候选池抽 1 条，整局锁定
 *   2. 逐月播报 —— 按回合取本月新闻
 *
 * ============ 第二版：不再依赖关卡 newsDeck ============
 *
 * 旧版从 level.newsDeck 读固定分组；新版的分组由 setup.buildNewsDeck()
 * 在开局时按"抽到的三只股票"临时编排，然后传进来。
 *
 * ============ 行业匹配（替代旧的 target 代码匹配）============
 *
 * 一条新闻的 sector 命中本局某只股票的 sector 时，视为"相关"；
 * 否则视为"错配"（无关 / 利好但承压）。
 *
 * 影响是否真正生效，由 simulator 按 kind 判断：
 *   relevant   → 按 truth 正/负施加 drift
 *   pressured  → drift 取负（利好但跌）
 *   irrelevant → 不施加（但新闻照常展示，迷惑玩家）
 */

import { pickN } from '../core/random';
import { NEWS_POOL_MAP } from '../data/newspool';

export default class Dispatcher {
  constructor() {
    this.script = []; // 长度 = turns，每项是一条新闻对象
  }

  /**
   * 开局编排 —— 每回合从该回合的候选池中抽 1 条
   *
   * @param {Array<Array>} newsDeck 每回合的候选新闻 id 数组
   * @param {Array} stocks 本局三只股票（用于兜底构造降级新闻）
   * @param {object} [newsMap] id → news 映射（默认从数据层取）
   * @returns {Array} 编排好的新闻脚本
   */
  buildScript(newsDeck, stocks, newsMap) {
    const map = newsMap || NEWS_POOL_MAP;

    const script = [];
    const deck = newsDeck || [];
    const used = new Set(); // 本局已用过的新闻 id

    for (let t = 0; t < deck.length; t++) {
      const group = deck[t] || [];
      const candidates = group
        .map((id) => (typeof id === 'string' ? map[id] : id))
        .filter((n) => n && n.headline);

      // ★ 优先从未用过的候选里抽；全用过才允许重复（候选池特意留了余量，
      //   正常情况下 12 个月不会看到重样的新闻）
      const fresh = candidates.filter((n) => !used.has(n.id));
      const pickFrom = fresh.length ? fresh : candidates;

      if (!pickFrom.length) {
        // 极端兜底：该回合无可用新闻，构造一条"市场平静"
        const fb = stocks && stocks.length ? stocks[t % stocks.length] : null;
        const calm = {
          id: `calm_${t + 1}`,
          turn: t + 1,
          source: '盘面观察',
          headline: '本月盘面平静，无重大消息',
          body: '市场交投清淡，各板块窄幅震荡。',
          sector: fb ? fb.sector : 'macro',
          link: 'macro',
          truth: true,
          credibility: 0.5,
          kind: 'relevant',
          impact: { drift: 0, turns: 1 },
        };
        script.push(calm);
        used.add(calm.id);
        continue;
      }

      const chosen = pickN(pickFrom, 1)[0];
      used.add(chosen.id);
      script.push({ ...chosen, turn: t + 1 });
    }

    this.script = script;
    return script;
  }

  /**
   * 取指定回合的新闻（回合从 1 开始）
   */
  newsOf(turn) {
    return this.script[turn - 1] || null;
  }

  /**
   * 取全部编排结果
   */
  all() {
    return this.script;
  }

  /**
   * 调试用：返回编排出的新闻 id 序列
   */
  debugOrder() {
    return this.script.map((n) => n.id);
  }
}
