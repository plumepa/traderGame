/**
 * 配色与字体设定 —— 80 年代像素风 + 中国股市配色
 *
 * ⚠️ 中国股市配色（强制）：涨 = 红，跌 = 绿。与欧美相反，不可颠倒。
 */

// ============ 股市配色（涨红跌绿）============
export const STOCK = {
  up: '#E8452C', // 涨 —— 红
  down: '#2ECC71', // 跌 —— 绿
  flat: '#8A8A8A', // 平盘 —— 灰
  upDark: '#A82A18', // 深红（强烈看多）
  downDark: '#1E8C4C', // 深绿（强烈看空）
};

// ============ 像素风基础色板 ============
export const PALETTE = {
  bg: '#1A1A1A', // 深底色（CRT 屏幕黑）
  panel: '#242424', // 面板底
  panelLight: '#2E2E2E', // 高亮面板
  border: '#4A4A4A', // 边框
  borderLight: '#6A6A6A',
  text: '#E8E8E0', // 主文字（米白）
  textDim: '#9A9A90', // 次要文字
  textBright: '#FFFFFF',
  accent: '#FFB000', // 强调色（琥珀色，复古终端）
  accentDim: '#8A6000',
  danger: '#E8452C',
  success: '#2ECC71',
  shadow: 'rgba(0,0,0,0.5)',
};

// ============ 字体 ============
// 微信小游戏 Canvas 无法直接渲染中文点阵字体，
// 因此用系统等宽字体并把字号设为偶数，配合下面的 shadow 制造像素感。
//
// 第二版整体放大约 20%：
//   手机屏幕上的 10px 中文已经低于舒适阅读下限，尤其在深底 + 扫描线滤镜
//   （render.js 每 4px 压一条暗线）之后更糊。所有档位统一上调，保持比例关系。
export const FONT = {
  // 主字体：等宽，营造终端感
  family: '"Courier New", "Heiti SC", monospace',
  size: {
    xs: 12, // 次要说明、代码、单位
    sm: 14, // 正文、按钮
    md: 16, // 小标题、数值
    lg: 20, // 价格、大按钮
    xl: 28, // 结算标题
    xxl: 38, // 封面 logo
  },
  bold: (size) => `bold ${size}px ${FONT.family}`,
  normal: (size) => `${size}px ${FONT.family}`,
};

/**
 * 投影偏移 —— 字号越大越需要更厚的投影，否则"点阵厚度感"消失
 * @param {number} size 字号
 */
export function shadowOffset(size) {
  return size >= 18 ? 2 : 1;
}

// ============ 像素单位 ============
// 所有布局尺寸取该值的整数倍，保证对齐到"像素网格"
export const PIXEL = 2;

/**
 * 把数值对齐到像素网格
 * @param {number} v 原始值
 * @returns {number} 对齐后的值
 */
export function snap(v) {
  return Math.round(v / PIXEL) * PIXEL;
}

// ============ 月份 ============

const MONTH_NAMES = [
  '一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月',
];

/**
 * 回合号 → 中文月份名（回合 1 = 一月）
 * @param {number} turn 回合号（从 1 开始）
 * @returns {string}
 */
export function monthName(turn) {
  return MONTH_NAMES[(turn - 1) % 12] || `${turn}月`;
}

/**
 * 回合号 → 数字月份（回合 1 = 1）
 */
export function monthNumber(turn) {
  return ((turn - 1) % 12) + 1;
}

export { MONTH_NAMES };

