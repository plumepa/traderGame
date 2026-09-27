/**
 * 随机数封装 —— 预留种子接口，便于调试时复现同一局
 *
 * MVP 默认用 Math.random()。若调用 setSeed()，则切换到
 * mulberry32 伪随机算法，同一 seed 产生同一序列。
 */

let seeded = false;
let seedState = 0;

/**
 * FNV-1a 字符串哈希 —— 把任意字符串种子拍成 32 位整数
 *
 * ⚠️ 为什么不能直接 `seed >>> 0`：对**字符串**做位运算会先 `ToNumber`，
 *   而 `Number('balance-v1')` 是 `NaN`，`NaN >>> 0` 是 **0**。
 *   于是 `setSeed('balance-v1')` 与 `setSeed('repro-check')` 与
 *   `setSeed(0)` 得到的是**同一条随机序列** —— 测试里"换个种子换一组样本"
 *   实际上什么都没换（而且不会报错）。
 * @param {string} str
 * @returns {number} 32 位无符号整数
 */
function hashStr(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 设置随机种子 —— 使随机可复现（调试用）
 *
 * 接受**数字或字符串**。字符串会走 FNV-1a 哈希，
 * 所以 `setSeed('balance-v1')` 与 `setSeed('balance-v2')` 是两条不同序列。
 * @param {number|string} seed
 */
export function setSeed(seed) {
  seeded = true;
  seedState = typeof seed === 'number' ? seed >>> 0 : hashStr(String(seed));
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
