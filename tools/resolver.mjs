/**
 * Node ESM 解析钩子 —— 让本地自检贴近微信小游戏的真实解析行为
 *
 * 两个平台事实（踩过坑，务必遵守）：
 *
 * 1. 微信小游戏打包器允许 `import x from './foo'`（自动补 .js 后缀），
 *    但 Node 的 ESM 要求写全扩展名 —— 这里补上，避免改动游戏源码。
 *
 * 2. ⚠️ 微信小游戏**不支持 import JSON**。打包器会把
 *    './stocks/600519.json' 当模块名并自动补 .js，去找
 *    '600519.json.js'，运行时报：
 *        module 'js/data/stocks/600519.json.js' is not defined
 *    因此本钩子**故意不提供 JSON 加载能力** —— 一旦源码里出现
 *    .json import，这里会直接报错，而不是悄悄帮它加载成功。
 *
 *    早期版本曾提供一个 JSON load 钩子，结果掩盖了真实平台缺陷，
 *    让 168 项测试全绿却上线即崩。**不要再把它加回来。**
 *
 * 数据文件一律使用 .js 模块（export default {...}）。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/** 允许自动补全的扩展名 —— 注意：不含 .json */
const CANDIDATES = ['.js', '.mjs'];
const INDEX_FILES = ['index.js'];

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) {
    const baseDir = context.parentURL
      ? path.dirname(fileURLToPath(context.parentURL))
      : process.cwd();
    const target = path.resolve(baseDir, specifier);

    // 显式写了 .json —— 直接拦下，模拟真实平台的失败
    if (specifier.endsWith('.json')) {
      throw new Error(
        `[平台约束] 微信小游戏不支持 import JSON：'${specifier}'\n` +
        `  打包器会去找 '${specifier}.js' 从而运行时报错 module not defined。\n` +
        `  请把数据文件改成 .js 模块（export default {...}），` +
        `import 时去掉 .json 后缀。`,
      );
    }

    // 已经是完整且存在的文件
    if (existsSync(target) && statSync(target).isFile() && path.extname(target)) {
      return nextResolve(specifier, context);
    }

    // 补扩展名
    for (const ext of CANDIDATES) {
      const candidate = `${target}${ext}`;
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }

    // 目录 index
    for (const idx of INDEX_FILES) {
      const candidate = path.join(target, idx);
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
  }

  return nextResolve(specifier, context);
}

/**
 * 加载钩子 —— 只用于 .js 源码，不碰 .json
 *
 * 这里不实现 JSON 加载是**有意为之**：让 .json import 在测试阶段就暴露，
 * 而不是等到微信开发者工具里才报错。
 */
export async function load(url, context, nextLoad) {
  if (url.endsWith('.json')) {
    throw new Error(
      `[平台约束] 试图加载 JSON 模块：${url}\n` +
      `  微信小游戏不支持 import JSON，请改用 .js 数据模块。`,
    );
  }
  return nextLoad(url, context);
}
