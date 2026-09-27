/**
 * 注册解析钩子（配合 resolver.mjs）
 * 仅用于本地自检，不参与小游戏打包。
 *
 * 用法（在项目根目录执行）：
 *   node --import ./tools/register.mjs tools/selftest.mjs
 */

import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const resolverPath = path.join(here, 'resolver.mjs');

register(pathToFileURL(resolverPath).href);
