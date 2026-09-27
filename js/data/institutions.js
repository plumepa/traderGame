/**
 * 机构名表 —— 用于每月评级的署名轮换
 *
 * 名字带一点市井幽默感，但不过度嘲讽。
 * 每回合轮换一家，营造「有人在盯着你」的临场感。
 */

export const INSTITUTIONS = [
  '银河证券研究所',
  '中金研究部',
  '国泰君安策略组',
  '散户观察周刊',
  '老张说股',
  '韭菜互助会',
  '盘口异动监控室',
  '东方财富研报',
];

/**
 * 按回合数取机构名（循环轮换）
 * @param {number} turn 当前回合（从 1 开始）
 * @returns {string} 机构名
 */
export function institutionOf(turn) {
  const idx = (turn - 1) % INSTITUTIONS.length;
  return INSTITUTIONS[idx];
}
