/**
 * 数据注册表
 *
 * ⚠️ 两个平台约束决定了本文件必须手写注册：
 *
 * 1. 微信小游戏没有读取工程源码目录的文件系统能力 ——
 *    wx.getFileSystemManager() 只能操作【用户数据目录】，
 *    无法 readdir 打包进来的 js/data/ 目录。所以不能自动遍历。
 *
 * 2. 打包器不支持 import JSON —— 会把 "xxx.json" 当模块名
 *    自动补 .js 后缀去找 "xxx.json.js" 从而报错。
 *    因此数据文件一律是 .js 模块（export default {...}）。
 *
 * ============ 第三版结构 ============
 *
 *   pool.js             股票池（34 只虚构股票，覆盖 12 个行业）
 *   newspool.js         新闻池（按 sector 匹配，支持无关/利好但承压三种错配）
 *   seasons/index.js    年景池（20 个年景 × 3 股票 × 6 新闻，带构造期校验）
 *   levels.js           关卡（5 关，只描述可抽风格池，**不告诉玩家年景**）
 *   setup.js            开局编排（按年景抽股 + 随机抽新闻）
 *
 * 关键变化（第三版）：
 *   · 股票名/代码全部虚构（9xxxxx 前缀），避免与真实 A 股冲突
 *   · 市场风格由 3 种扩展为 6 种：bull / smallBull / bear / smallBear / flat / calmFlat
 *   · 新增"年景"数据层：20 个年景，每个绑定 3 只股票 + 6 条专属新闻
 *   · 关卡扩展为 5 关，且**年份与主题对玩家完全隐藏**
 *
 * 旧的 per-file 股票/新闻数据（stocks/*.js、news/*.js）保留在仓库里
 * 作为历史数据与备份素材，但**不再被本注册表引用**。
 */

import { STOCK_POOL } from './pool';
import { SECTORS } from './pool';
import { NEWS_POOL } from './newspool';
import { LEVELS } from './levels';
import { SEASONS } from './seasons/index';
import { MARKET_STYLE_KEYS } from '../market/pathgen';
import { composeGame } from '../market/setup';

// ============ 股票池 ============
export { STOCK_POOL, POOL_MAP, SECTORS, stocksOfSector, stockOfCode } from './pool';

// ============ 新闻池 ============
export { NEWS_POOL, NEWS_POOL_MAP, newsForSector, newsByKind } from './newspool';

// ============ 年景 ============
export {
  SEASONS,
  SEASON_MAP,
  seasonsOfStyle,
  seasonCountByStyle,
  stocksOfSeason,
  newsOfSeason,
} from './seasons/index';

// ============ 关卡 ============
export { LEVELS, LEVEL_MAP, LEVEL_COUNT, poolOfLevel } from './levels';

// ============ 开局编排 ============
export {
  composeGame,
  composeFromSeason,
  pickSeasons,
  pickStocks,
  buildNewsDeck,
  newsPoolForStock,
} from '../market/setup';

// ============ 机构 ============
export { INSTITUTIONS, institutionOf } from './institutions';

/**
 * 数据自检 —— 启动时调用，尽早发现数据错误
 *
 * 第三版校验重点：
 *   ① 股票池非空、代码唯一、行业合法、basePrice/floor 合法、profile 完整
 *   ② 新闻池非空、id 唯一、sector 合法、impact.drift 是数字
 *   ③ 关卡共 5 关、字段合法（可抽风格池里的风格合法、turns > 0、initCash > 0）
 *      —— 并且**不得**包含面向玩家的年份/市场主题字段
 *   ④ 年景池 20 个：风格合法、三只股票行业互不相同、
 *      六条新闻都在新闻池里、且每只股票至少有一条对口新闻
 *   ⑤ 编排一次开局，验证能抽出 3 只不同行业的股票
 *      且 12 个回合每回合都有非空候选新闻
 *
 * @returns {string[]} 错误信息列表，空数组表示全部通过
 */
export function validateData() {
  const errors = [];

  const pool = STOCK_POOL;
  const sectors = SECTORS;
  const news = NEWS_POOL;
  const levels = LEVELS;
  const seasons = SEASONS;

  const validStyles = MARKET_STYLE_KEYS; // ['bull','smallBull','bear','smallBear','flat','calmFlat']

  // ① 股票池
  if (!pool || !pool.length) errors.push('股票池为空');
  const codes = new Set();
  const validSectors = new Set(Object.keys(sectors || {}));
  (pool || []).forEach((s) => {
    if (!s.code) errors.push('存在无 code 的股票');
    if (codes.has(s.code)) errors.push(`股票代码重复: ${s.code}`);
    codes.add(s.code);
    if (!s.name) errors.push(`股票 ${s.code} 缺少 name`);
    if (!validSectors.has(s.sector)) errors.push(`股票 ${s.code} 行业非法: ${s.sector}`);
    if (typeof s.basePrice !== 'number' || s.basePrice <= 0) {
      errors.push(`股票 ${s.code} 的 basePrice 非法: ${s.basePrice}`);
    }
    if (typeof s.floor !== 'number' || s.floor <= 0) {
      errors.push(`股票 ${s.code} 的 floor 非法: ${s.floor}`);
    }
    if (!s.profile || typeof s.profile.trend !== 'number') {
      errors.push(`股票 ${s.code} 缺少 profile`);
    }
    // 真实 A 股代码前缀黑名单 —— 代码虚构是为了避免与真实市场挂钩
    if (/^(600|601|603|605|000|001|002|300|301|688)/.test(s.code)) {
      errors.push(`股票代码 ${s.code} 与真实 A 股代码前缀冲突`);
    }
  });

  // 至少要覆盖 3 个行业，否则抽不出 3 只不重行业的股票
  const sectorSet = new Set((pool || []).map((s) => s.sector));
  if (sectorSet.size < 3) errors.push(`股票池覆盖行业数 < 3（实际 ${sectorSet.size}）`);

  // ② 新闻池
  if (!news || !news.length) errors.push('新闻池为空');
  const newsIds = new Set();
  (news || []).forEach((n) => {
    if (!n.id) errors.push('存在无 id 的新闻');
    if (newsIds.has(n.id)) errors.push(`新闻 id 重复: ${n.id}`);
    newsIds.add(n.id);
    if (n.sector !== 'macro' && !validSectors.has(n.sector)) {
      errors.push(`新闻 ${n.id} sector 非法: ${n.sector}`);
    }
    if (!n.headline) errors.push(`新闻 ${n.id} 缺少 headline`);
    if (!n.impact || typeof n.impact.drift !== 'number') {
      errors.push(`新闻 ${n.id} 缺少 impact.drift`);
    }
  });

  // ③ 关卡 —— 5 关制，且不暴露年景
  if (!levels || !levels.length) errors.push('关卡列表为空');
  if (levels.length !== 5) errors.push(`关卡应为 5 关，实际 ${levels.length}`);
  (levels || []).forEach((lv) => {
    const pl = lv.pool === null ? validStyles : Array.isArray(lv.pool) ? lv.pool : [lv.style];
    pl.forEach((st) => {
      if (!validStyles.includes(st)) errors.push(`关卡 ${lv.id} 可抽风格非法: ${st}`);
    });
    if (!(lv.turns > 0)) errors.push(`关卡 ${lv.id} turns 非法: ${lv.turns}`);
    if (!(lv.initCash > 0)) errors.push(`关卡 ${lv.id} initCash 非法: ${lv.initCash}`);
    if (typeof lv.index !== 'number') errors.push(`关卡 ${lv.id} 缺少 index`);
    if (!lv.title) errors.push(`关卡 ${lv.id} 缺少 title`);
    // ⚠️ 关键：面向玩家的文案里不得出现年份或市场主题标签
    if (lv.theme) errors.push(`关卡 ${lv.id} 不应有 theme 字段（年景对玩家隐藏）`);
    if (/19\d{2}|20\d{2}/.test(String(lv.title) + String(lv.intro))) {
      errors.push(`关卡 ${lv.id} 的文案里出现了年份（应隐藏年景）`);
    }
    if (/牛市|熊市|震荡|小牛|小熊/.test(String(lv.title))) {
      errors.push(`关卡 ${lv.id} 的标题里出现了市场风格（应隐藏年景）`);
    }
  });

  // ④ 年景池
  if (!seasons || !seasons.length) {
    errors.push('年景池为空');
  } else {
    if (seasons.length !== 20) errors.push(`年景应为 20 个，实际 ${seasons.length}`);
    const sids = new Set();
    const sidCodes = new Set();
    seasons.forEach((s) => {
      if (!s.id) errors.push('存在无 id 的年景');
      if (sids.has(s.id)) errors.push(`年景 id 重复: ${s.id}`);
      sids.add(s.id);

      if (!validStyles.includes(s.style)) errors.push(`年景 ${s.id} 风格非法: ${s.style}`);
      if (!s.label) errors.push(`年景 ${s.id} 缺少 label`);
      if (!Array.isArray(s.codes) || s.codes.length !== 3) {
        errors.push(`年景 ${s.id} 应有 3 只股票，实际 ${s.codes ? s.codes.length : 'null'}`);
      }
      if (!Array.isArray(s.news) || s.news.length !== 6) {
        errors.push(`年景 ${s.id} 应有 6 条新闻，实际 ${s.news ? s.news.length : 'null'}`);
      }

      const secs = [];
      (s.codes || []).forEach((c) => {
        const st = (pool || []).find((x) => x.code === c);
        if (!st) {
          errors.push(`年景 ${s.id} 引用了不存在的股票 ${c}`);
          return;
        }
        if (sidCodes.has(`${c}`)) sidCodes.add(c); // 允许跨年景复用，仅记录
        secs.push(st.sector);
      });
      if (new Set(secs).size !== secs.length) {
        errors.push(`年景 ${s.id} 的股票行业重复: ${secs.join('/')}`);
      }

      const sNews = [];
      (s.news || []).forEach((nid) => {
        const n = (news || []).find((x) => x.id === nid);
        if (!n) {
          errors.push(`年景 ${s.id} 引用了不存在的新闻 ${nid}`);
          return;
        }
        sNews.push(n);
      });

      // 每只股票至少有 1 条对口新闻（否则该股票在本年景里"没有故事"）
      (s.codes || []).forEach((c) => {
        const st = (pool || []).find((x) => x.code === c);
        if (!st) return;
        const hasMatch = sNews.some(
          (n) => n.sector === st.sector || n.sector === 'macro',
        );
        if (!hasMatch) {
          errors.push(`年景 ${s.id} 的股票 ${c}(${st.sector}) 没有对口新闻`);
        }
      });
    });
  }

  // ⑤ 编排一次开局（用固定种子，保证自检可复现）
  if (pool && pool.length && news && news.length) {
    try {
      const game = composeGame({ turns: 12, style: 'bull', seedKey: 'validate' });
      if (game.stockDefs.length !== 3) {
        errors.push(`开局应抽 3 只股票，实际 ${game.stockDefs.length}`);
      }
      const inds = game.stockDefs.map((s) => s.sector);
      if (new Set(inds).size !== inds.length) {
        errors.push(`开局三只股票行业重复: ${inds.join('/')}`);
      }
      game.stockDefs.forEach((s) => {
        if (!Array.isArray(s.path) || s.path.length !== 12) {
          errors.push(`开局股票 ${s.code} 的 path 长度应为 12，实际 ${s.path ? s.path.length : 'null'}`);
        }
      });
      if (game.newsDeck.length !== 12) {
        errors.push(`开局 newsDeck 应 12 组，实际 ${game.newsDeck.length}`);
      }
      game.newsDeck.forEach((g, i) => {
        if (!g.length) errors.push(`开局第 ${i + 1} 回合候选新闻为空`);
      });
    } catch (e) {
      errors.push(`开局编排异常: ${e.message}`);
    }
  }

  return errors;
}
