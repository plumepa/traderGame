/**
 * 开局编排 —— 抽年景 + 生成路径 + 编排新闻
 *
 * ============================================================
 * 第四版：从"全局池随机抽股"升级为"年景驱动"
 * ============================================================
 *
 * 旧版流程：从 34 只股票里随机抽 3 只（行业不重复），新闻从全局池随机配。
 * 问题：虽然是随机的，但**没有叙事的连贯性** —— 三只股票彼此无关，
 *       新闻也只是"恰好命中行业"，玩家感受不到"这一局有它的时代气息"。
 *
 * 新版流程：
 *   ① 从 20 个**年景**里抽若干个（同一批关卡内不重复）
 *   ② 每个年景自带 3 只股票（已保证行业不重复）与 6 条新闻
 *   ③ 用该年景的 style 生成确定性的价格路径
 *
 * 这样每局都是"一个完整的小时代"：同一年景里的股票与新闻是**共同设计过的**，
 * 新闻能精准命中该年景的股票，叙事连贯。
 *
 * ============================================================
 * ★ "不重复"的两层含义（需求："随机在不同类型的池子里抽卡，但是不要重复"）
 * ============================================================
 *
 * 第一层 —— **同一个年景内**：3 只股票行业互不重复（在 seasons/index.js
 *   构造期已强制校验）。
 *
 * 第二层 —— **同一批关卡内**：5 个关卡用的年景必须两两不同。
 *   否则玩家连玩 5 关碰到同一个年景，就失去了"每关都有新鲜感"的意义。
 *   实现见 pickSeasons()；由 DataBus 持有 usedSeasonIds 跨关累积。
 *
 * ⚠️ 注意：这里的"不重复"是**跨关**而非"永久不重复"。
 *   20 个年景 × 5 关 = 一局消耗 5 个，因此可以完整地玩 4 局不重样；
 *   第 5 局才会开始复用。这比"永久不重复"更合理 ——
 *   否则玩家玩 4 遍就把内容耗尽了，之后全是重复。
 *
 * ============================================================
 * 随机性与确定性
 * ============================================================
 * 抽取年景、编排新闻用随机（每局不同，这是玩家要的"每关随机"）。
 * 但路径生成是确定性的（同局同股恒定），所以走势图不会变。
 */

import { STOCK_POOL, POOL_MAP } from '../data/pool';
import { NEWS_POOL, NEWS_POOL_MAP, newsForSector } from '../data/newspool';
import { SEASONS, SEASON_MAP, stocksOfSeason, newsOfSeason } from '../data/seasons/index';
import { generatePath, rollDelist, MARKET_STYLE_KEYS } from '../market/pathgen';
import { shuffle, random } from '../core/random';

/**
 * 从股票池随机抽 N 只，行业互不重复（**没有年景可用时的兜底路径**）
 *
 * ⚠️ 这是降级方案。正常流程请用 pickSeasons() + stocksOfSeason()，
 *    因为年景里的股票是"和新闻一起设计过"的，叙事质量更高。
 *    只有在年景池被排除干净（理论上不会发生）时才会用到。
 *
 * @param {number} n 抽取数量
 * @param {object} opts
 * @param {string[]} [opts.exclude] 要排除的代码
 * @returns {Array} 抽中的股票定义
 */
export function pickStocks(n = 3, opts = {}) {
  const exclude = opts.exclude || [];
  const pool = STOCK_POOL.filter((s) => !exclude.includes(s.code));

  const shuffled = shuffle(pool);
  const picked = [];
  const usedSectors = new Set();

  for (const s of shuffled) {
    if (picked.length >= n) break;
    if (usedSectors.has(s.sector)) continue;
    usedSectors.add(s.sector);
    picked.push(s);
  }

  if (picked.length < n) {
    for (const s of shuffled) {
      if (picked.length >= n) break;
      if (picked.includes(s)) continue;
      picked.push(s);
    }
  }

  return picked;
}

/**
 * 生成一局的随机标识（seedKey）
 *
 * ⚠️ 这里**绝不能**掺 `Date.now()`。
 *
 * 曾经是 `g${Date.now()}_${random()}` —— 后果是 `setSeed()` 形同虚设：
 * 全局种子固定了，但 seedKey 每次运行都不同 → `generatePath` / `rollDelist`
 * 得到的路径和退市判定每次都不一样 → **平衡测试的"固定种子"根本没生效**，
 * 断言的观测值在阈值两侧随机跳动（实测破产率 1.0% ~ 2.3% 骑在 2% 的线上）。
 *
 * 现在改成**纯随机源**派生：调用 `setSeed()` 后整条链路完全可复现；
 * 不调 `setSeed()` 时 `random()` 就是 `Math.random()`，
 * 1e9 的取值空间对"一局一个 key"来说足够唯一。
 *
 * @returns {string}
 */
function makeSeedKey() {
  return `g${Math.floor(random() * 1e9)}`;
}

/**
 * 由「股票列表 + 风格」构造股票定义（含价格路径与退市判定）
 *
 * ★ 抽出来是因为这段逻辑在文件里原本**抄了 3 遍**，
 *   而且抄漏了一处 —— 旧的兜底路径（路径 3）**没有做"一局最多一只退市"的保底**，
 *   于是那条路上可能出现三只同时爆雷把玩家直接打死。
 *   合并成一个函数之后，四条路径的行为才真正一致。
 *
 * @param {Array} stocks 股票定义数组
 * @param {string} style 市场风格
 * @param {string} seedKey 随机种子键（同局同股恒定 → 走势图不会变）
 * @param {number} turns 回合数
 * @returns {Array} 带 path / delistAt / delistPrice 的股票定义
 */
function buildDefs(stocks, style, seedKey, turns) {
  const defs = stocks.map((s) => {
    const path = generatePath(s, style, seedKey, turns);
    const def = { ...s, path };

    const dl = rollDelist(s, style, seedKey, turns);
    if (dl) {
      def.delistAt = dl.delistAt;
      def.delistPrice = dl.delistPrice;
    }
    return def;
  });

  // 保底：一局最多一只股票退市（避免三只全爆雷把玩家直接打死）
  const delistable = defs.filter((d) => d.delistAt);
  if (delistable.length > 1) {
    const keeper = delistable.reduce((a, b) =>
      (a.profile.luck || 0) <= (b.profile.luck || 0) ? a : b);
    defs.forEach((d) => {
      if (d.delistAt && d !== keeper) {
        delete d.delistAt;
        delete d.delistPrice;
      }
    });
  }

  return defs;
}

/**
 * ★★ 构造一关 —— **跨关股票不重复**的编排入口
 *
 * ============================================================
 * 为什么需要这个函数（与 composeFromSeason 的区别）
 * ============================================================
 *
 * `composeFromSeason` 用「年景」开局：年景自带 3 只固定股票 + 6 条专属新闻。
 * 问题在于**年景之间大量共用股票**：36 只股票撑起 20 个年景（60 个股票位），
 * 平均每只股票出现在 1.7 个年景里，最多的出现 4 次。
 * 于是"跨关不重复"如果只做在**年景**层面，玩家照样会在第 3 关看到第 1 关的股票。
 *
 * 实测：要求"年景的三只股票全部未被用过"时，贪心只能撑 **约 7 关**
 * （2000 次模拟：6 关 17% / 7 关 51% / 8 关 32%）。
 * 而"五关一轮、可以一直继续"需要几十关 —— 年景这条路根本走不通。
 *
 * 所以本函数**直接从股票池抽股**：
 *   ① 从 STOCK_POOL 里剔除 excludeStocks（本局/本轮已用过的代码）
 *   ② 抽 3 只**行业互不相同**的股票
 *   ③ 风格在关卡允许的风格池里随机（不是取 pool[0]，见下方 ⚠️）
 *   ④ 新闻按这三只股票的实际行业生成（buildNewsDeck 本就是按 sector 匹配的）
 *
 * 这样「每关不重复同一只股票」是**构造性保证**，不靠概率。
 *
 * ============================================================
 * ⚠️ 为什么必须显式处理"风格池随机"
 * ============================================================
 * 关卡同时带 `style`（占位单值）与 `pool`（风格集合）。
 * 如果直接写 `style = opts.style`，占位值会把"全放开"压成单一风格 ——
 * 这个坑在 composeGame 里已经踩过一次（lv_05 的 400 次抽卡全是 flat）。
 * 所以这里**只认 styles 数组**，opts.style 仅在没有数组时兜底。
 *
 * @param {object} opts
 * @param {number} [opts.turns=12] 回合数
 * @param {number} [opts.initCash=6000] 本关起始资金（跑关时是上一关的期末资产）
 * @param {string[]|'all'} [opts.styles] 本关可抽的风格池
 * @param {string} [opts.style] 兜底单值（仅当没有 styles 数组时使用）
 * @param {string[]} [opts.excludeStocks] **必须排除**的股票代码（跨关不重复）
 * @param {string} [opts.seedKey]
 * @returns {object} 与 composeFromSeason 同构的一局配置
 */
export function composeFreshLevel(opts = {}) {
  const turns = opts.turns || 12;
  const initCash = typeof opts.initCash === 'number' ? opts.initCash : 6000;
  const seedKey = opts.seedKey || makeSeedKey();

  // ---- ① 风格：池内随机 ----
  let styles = null;
  if (Array.isArray(opts.styles) && opts.styles.length) styles = opts.styles.slice();
  else if (opts.styles === 'all') styles = MARKET_STYLE_KEYS.slice();
  else if (opts.style) styles = [opts.style];
  else styles = MARKET_STYLE_KEYS.slice();
  const style = styles[Math.floor(random() * styles.length)];

  // ---- ② 股票：排除已用 + 行业互不相同 ----
  //
  // ⚠️ 池子被掏空（可用 < 3 只）时**不能**返回不足 3 只 ——
  //   那正是玩家说的"最后一关只剩 1-2 只股票"。
  //   这里兜底为"清空排除集重新抽"，保证**永远恰好 3 只**。
  //   调用方（DataBus）通常已在关卡边界主动清空，这里是第二道保险。
  const exclude = Array.isArray(opts.excludeStocks) ? opts.excludeStocks : [];
  let stocks = pickStocks(3, { exclude });
  let recycled = false;
  if (stocks.length < 3) {
    stocks = pickStocks(3);
    recycled = true;
  }

  // ---- ③ 定义 + 新闻 ----
  const defs = buildDefs(stocks, style, seedKey, turns);
  const newsDeck = buildNewsDeck(defs, turns);

  return {
    seedKey,
    style,
    turns,
    initCash,
    stockDefs: defs,
    newsDeck,
    stockCodes: defs.map((d) => d.code),
    recycled, // 是否因为池子耗尽而重置了排除集（调试/统计用）
    seasonId: null,
    seasonLabel: null,
    seasonIntro: null,
  };
}

/**
 * ★ 抽取年景 —— 这是"随机在不同类型的池子里抽卡，但是不要重复"的实现
 *
 * 算法：
 *   ① 从 SEASONS 里剔除 exclude（已在本批用过的年景 id）
 *   ② 打乱剩余年景
 *   ③ 贪心地按"风格均衡"选 n 个：优先选**风格还没出现过的**，
 *      风格都用过之后再补任意
 *
 * 为什么要做风格均衡（而不是纯随机）？
 *   纯随机时，5 关里可能抽到 4 个牛市 —— 玩家的体验就是"这游戏怎么一直在涨"，
 *   感受不到市场类型的多样性。风格均衡保证 5 关尽量覆盖不同的市场性格。
 *   这是**加分项**：即使某风格没有年景可用，也不会失败，只是退化为任意补足。
 *
 * @param {number} n 需要几个年景
 * @param {object} opts
 * @param {string[]} [opts.exclude] 已用过的年景 id
 * @returns {Array} 年景对象数组（长度 ≤ n；池子不够时会返回不足数量）
 */
export function pickSeasons(n = 5, opts = {}) {
  const exclude = new Set(opts.exclude || []);
  const avail = SEASONS.filter((s) => !exclude.has(s.id));
  if (!avail.length) return [];

  const shuffled = shuffle(avail);
  const picked = [];
  const usedStyles = new Set();

  // 第一轮：每种风格最多取一个，保证类型多样
  for (const s of shuffled) {
    if (picked.length >= n) break;
    if (usedStyles.has(s.style)) continue;
    usedStyles.add(s.style);
    picked.push(s);
  }

  // 第二轮：风格都用过了（或不够），任意补足剩余名额
  if (picked.length < n) {
    for (const s of shuffled) {
      if (picked.length >= n) break;
      if (picked.includes(s)) continue;
      picked.push(s);
    }
  }

  return picked;
}

/**
 * 为一只股票生成"本局的有效新闻集合"
 *
 * 包含：
 *   · 该股所属行业的新闻（relevant 为主）
 *   · macro 通用新闻
 *   · 其他行业里 kind='irrelevant' 的错配新闻（船运利好 vs 陆运）
 *   · 其他行业里 kind='pressured' 的"利好但承压"新闻
 */
export function newsPoolForStock(stock) {
  return NEWS_POOL.filter(
    (n) =>
      n.sector === stock.sector ||
      n.sector === 'macro' ||
      n.kind === 'irrelevant' ||
      n.kind === 'pressured',
  );
}

/**
 * 编排整局新闻 —— 每回合一个候选池
 *
 * ============================================================
 * 第四版：优先使用**年景自带的 6 条新闻**
 * ============================================================
 *
 * 年景里指定的 6 条新闻是"与这三只股票一起设计过"的，优先全部用上；
 * 若 6 条不足以填满 turns 个回合（turns 通常 12），再用通用池补齐。
 *
 * ⚠️ 关键设计：候选池**允许跨回合重复**。
 *   起初我实现成"抽走即移除"，结果第 7 回合之后候选池就空了
 *   （新闻池里"错配"类只有 10 条，12 回合 × 2 条根本不够分）。
 *   正确做法：候选池有放回地抽；真正的"整局不重复"由 Dispatcher
 *   抽签时保证 —— 它跳过本局已用过的新闻，全用过才允许重复。
 *
 * @param {Array} stocks 本局三只股票
 * @param {number} turns 回合数
 * @param {object} [opts]
 * @param {string[]} [opts.seasonNews] 年景自带的新闻 id（优先使用）
 * @returns {Array<Array>} 长度 turns，每项是该回合的候选新闻 id 数组
 */
export function buildNewsDeck(stocks, turns = 12, opts = {}) {
  const sectors = stocks.map((s) => s.sector);
  const seasonNewsIds = (opts.seasonNews || []).filter((id) => !!NEWS_POOL_MAP[id]);

  // 本局"相关新闻"全集（本局股票的行业 + macro）
  const relevantPool = NEWS_POOL.filter(
    (n) => sectors.includes(n.sector) || n.sector === 'macro',
  );
  // 错配新闻全集（无关 / 利好但承压）—— 制造判断陷阱
  const mismatchPool = NEWS_POOL.filter((n) => n.kind !== 'relevant');

  const perTurn = 6;
  const buckets = Array.from({ length: turns }, () => []);

  const assign = (list) => {
    const bag = shuffle(list);
    bag.forEach((n, i) => {
      buckets[i % turns].push(n.id);
    });
  };

  // ★ 年景自带新闻优先铺满：每条都至少落进一个回合的候选池
  assign(seasonNewsIds.map((id) => NEWS_POOL_MAP[id]));
  assign(relevantPool);
  assign(mismatchPool);

  // 补齐：某些回合不足 perTurn 条时，从全集里有放回地补（允许跨回合重复）
  const allIds = NEWS_POOL.map((n) => n.id);
  const bucketsFixed = buckets.map((ids) => {
    const set = new Set(ids);
    let guard = 0;
    while (set.size < perTurn && guard++ < perTurn * 4) {
      set.add(allIds[Math.floor(random() * allIds.length)]);
    }
    return shuffle(Array.from(set));
  });

  return bucketsFixed;
}

/**
 * 由"年景"构造一局（不涉及关卡概念，纯粹是数据组装）
 *
 * @param {object} season 年景对象
 * @param {object} opts
 * @param {number} [opts.turns=12]
 * @param {string} [opts.seedKey]
 * @param {number} [opts.initCash=6000]
 * @returns {object} { seedKey, style, turns, initCash, stockDefs, newsDeck, seasonId, seasonLabel }
 */
export function composeFromSeason(season, opts = {}) {
  const turns = opts.turns || 12;
  const initCash = typeof opts.initCash === 'number' ? opts.initCash : 6000;
  const seedKey = opts.seedKey || makeSeedKey();
  const style = season.style;

  const stocks = stocksOfSeason(season);

  const defs = buildDefs(stocks, style, seedKey, turns);

  const newsDeck = buildNewsDeck(defs, turns, { seasonNews: season.news });

  return {
    seedKey,
    style,
    turns,
    initCash,
    stockDefs: defs,
    newsDeck,
    seasonId: season.id,
    seasonLabel: season.label, // 内部标签，UI 不应展示
    seasonIntro: season.intro, // 氛围文字，可以展示（不含年份）
  };
}

/**
 * 开局编排总入口
 *
 * 两种用法：
 *   A. 传 season（推荐）—— 用指定年景开局
 *   B. 不传 season —— 随机抽一个（可配合 exclude 实现跨关不重复）
 *
 * @param {object} opts
 * @param {object} [opts.season] 指定年景
 * @param {string} [opts.turns=12]
 * @param {string} [opts.style] 未指定 season 时，可限定市场风格（单值）
 * @param {string[]|'all'} [opts.styles] 未指定 season 时可限定的风格集合。
 *                               传 'all' 表示**显式全放开**（会忽略 opts.style）。
 *                               数组表示只在这些风格里抽（优先于 opts.style）。
 *                               关卡就是用它来表达"本关可抽哪几种年景"。
 * @param {string} [opts.seedKey]
 * @param {number} [opts.initCash=6000]
 * @param {Array}  [opts.stocks] 直接注入股票（测试用，绕过一切抽选）
 * @param {string[]} [opts.excludeSeasons] 排除的年景 id
 * @returns {object} 一局的完整配置（可直接交给 DataBus）
 */
export function composeGame(opts = {}) {
  const turns = opts.turns || 12;
  const initCash = typeof opts.initCash === 'number' ? opts.initCash : 6000;
  const seedKey = opts.seedKey || makeSeedKey();

  // ---- 路径 1：直接注入股票（测试用，跳过抽选）----
  if (opts.stocks && opts.stocks.length) {
    const style = opts.style || 'bull';
    const defs = buildDefs(opts.stocks, style, seedKey, turns);
    return {
      seedKey,
      style,
      turns,
      initCash,
      stockDefs: defs,
      newsDeck: buildNewsDeck(defs, turns),
      seasonId: null,
      seasonLabel: null,
      seasonIntro: null,
    };
  }

  // ---- 路径 2：指定年景 ----
  if (opts.season) {
    return composeFromSeason(opts.season, { turns, initCash, seedKey });
  }

  // ---- 路径 3：随机抽年景（可限定风格池 / 排除已用）----
  //
  // ⚠️ 风格筛选的优先级：styles（池）> style（单值）。
  //
  // 曾经这里是反过来的（先按 style 过滤，再按 styles 过滤），
  // 于是关卡 lv_05 的 `style: 'flat'` 占位值把"全放开"（pool = null）
  // 硬生生压成了「只能抽 flat 年景」—— 400 次抽卡全部是 flat。
  // 单值和池子同时存在时，**池子才是设计意图**，单值只是兜底默认值。
  //
  // styles 的三种取值语义（务必分清）：
  //   null / undefined  → 未指定，退回 style 单值限定（或全放开）
  //   'all'             → **显式全放开**，忽略 style（终局关"没有剧本"）
  //   string[]          → 只在这些风格里抽
  let candidates = SEASONS;
  if (opts.excludeSeasons && opts.excludeSeasons.length) {
    const ex = new Set(opts.excludeSeasons);
    candidates = candidates.filter((s) => !ex.has(s.id));
  }

  const poolIsAll = opts.styles === 'all';
  const poolArr = Array.isArray(opts.styles) && opts.styles.length > 0 ? opts.styles : null;

  if (poolIsAll) {
    // 显式全放开：不动 candidates
  } else if (poolArr) {
    // 池子优先：只在池子里挑
    const wanted = new Set(poolArr);
    const byPool = candidates.filter((s) => wanted.has(s.style));
    if (byPool.length) candidates = byPool;
  } else if (opts.style) {
    // 没有池子时才退回单值限定
    const byStyle = candidates.filter((s) => s.style === opts.style);
    if (byStyle.length) candidates = byStyle;
  }

  // ---- 池子被 exclude 掏空？允许复用，而不是退化 ----
  //
  // 20 个年景 / 每局 5 关 → 连玩 4 轮（20 关）不重样。
  // 第 21 关起池子必然耗尽 —— 此时**应该复用**（这是刻意的：
  // 与其在"没年景可用"时退回旧的随机抽股模式、丢掉年景的
  // 「3 股 + 6 条专属新闻」结构，不如直接从头再抽一遍年景）。
  // 只有连风格都被排除光了，才真的退化到 legacy 路径。
  if (!candidates.length) {
    const relax = () => {
      let c = SEASONS;
      if (poolIsAll) return c;
      if (poolArr) {
        const wanted = new Set(poolArr);
        const f = c.filter((s) => wanted.has(s.style));
        return f.length ? f : c;
      }
      if (opts.style) {
        const f = c.filter((s) => s.style === opts.style);
        return f.length ? f : c;
      }
      return c;
    };
    const relaxed = relax();
    if (relaxed.length) {
      return composeFromSeason(shuffle(relaxed)[0], { turns, initCash, seedKey });
    }
  }

  if (!candidates.length) {
    // 最后兜底：连风格都排光了 → 退回旧行为（随机抽股 + 全局新闻池）
    let style = opts.style;
    if (opts.styles === 'all' || !style) {
      const arr = Array.isArray(opts.styles) && opts.styles.length ? opts.styles : MARKET_STYLE_KEYS;
      style = shuffle(arr.slice())[0];
    }
    // ★ 这里原本漏了"一局最多一只退市"的保底（三处拷贝里唯一漏掉的一处），
    //   合并到 buildDefs 之后才补上。
    const defs = buildDefs(pickStocks(3), style, seedKey, turns);
    return {
      seedKey, style, turns, initCash,
      stockDefs: defs,
      newsDeck: buildNewsDeck(defs, turns),
      seasonId: null, seasonLabel: null, seasonIntro: null,
    };
  }

  const chosen = shuffle(candidates)[0];
  return composeFromSeason(chosen, { turns, initCash, seedKey });
}

export { POOL_MAP, newsForSector, SEASONS, SEASON_MAP, SEASON_MAP as seasonsById };
