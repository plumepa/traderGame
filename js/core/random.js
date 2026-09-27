/**
 * 随机数封装 —— 预留种子接口，便于调试时复现同一局
 *
 * MVP 默认用 Math.random()。若调用 setSeed()，则切换到
 * mulberry32 伪随机算法，同一 seed 产生同一序列。
 */

let seeded = false;
let seedState = 0;

/**
 * 设置随机种子 —— 使随机可复现（调试用）
 * @param {number} seed 任意整数
 */
export function setSeed(seed) {
  seeded = true;
  seedState = seed >>> 0;
}

/**
 * 清除种子，恢复真随机
 */
export function clearSeed() {
  seeded = false;
  seedState = 0;
}

/**
 * 生成 [0, 1) 的随机数
 */
export function random() {
  if (!seeded) return Math.random();

  // mulberry32
  seedState = (seedState + 0x6d2b79f5) >>> 0;
  let t = seedState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * 生成 [min, max) 的随机整数
 */
export function randInt(min, max) {
  return min + Math.floor(random() * (max - min));
}

/**
 * 从数组中随机取一个元素
 * @returns {*} 元素；数组为空时返回 null
 */
export function pick(arr) {
  if (!arr || !arr.length) return null;
  return arr[Math.floor(random() * arr.length)];
}

/**
 * 从数组中随机取 n 个不重复元素（洗牌法，不改动原数组）
 * @returns {Array} 抽取结果
 */
export function pickN(arr, n) {
  if (!arr || !arr.length) return [];
  const pool = arr.slice();
  const count = Math.min(n, pool.length);
  const result = [];

  for (let i = 0; i < count; i++) {
    const idx = Math.floor(random() * pool.length);
    result.push(pool.splice(idx, 1)[0]);
  }

  return result;
}

/**
 * 原地洗牌（Fisher-Yates），返回新数组
 */
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
