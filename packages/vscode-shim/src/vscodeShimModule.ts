/**
 * 把 `vscode` 模块**落到磁盘上**，供扩展解析。
 *
 * 为什么光靠 `Module.prototype.require` 打补丁不够：那只拦得住 CommonJS 的 `require`。
 * 现在越来越多的扩展以 ESM 发布（`import * as vscode from 'vscode'`），
 * 走的是 Node 的 ESM 解析器 —— 补丁完全看不见它，报的是
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'vscode'`，而这条失败以前只打日志，
 * 界面上就是「装上了但什么都不会发生」。
 *
 * 做法与 VS Code 自己的做法一致：在扩展目录旁边放一个真的 `node_modules/vscode`。
 * ESM 与 CJS 的裸模块解析都会沿目录往上找 `node_modules`，所以放在扩展根目录的上一层，
 * 所有扩展都能解析到；两个入口（`index.cjs` / `index.mjs`）都从这里取**运行时**的 API 对象 ——
 * 名字导出必须是静态的，所以按真实 API 的键生成一份。
 */

import * as fs from 'fs/promises';
import * as path from 'node:path';

/**
 * 生成 shim 模块的三个文件内容。
 *
 * 纯函数：给一批键名，产出可写盘的源码。这样「生成的模块长什么样」能直接被断言，
 * 不用真去起一个 Node 进程 import 它。
 */
export function buildVscodeShimModuleSources(apiKeys: string[]): {
  packageJson: string;
  cjs: string;
  mjs: string;
} {
  // 只保留合法标识符：API 上挂的键都是标识符，但真出现怪名字时宁可少导出一个，
  // 也不要让整份生成文件语法错误（那会让**所有**扩展都解析不到 vscode）。
  const names = [...new Set(apiKeys)].filter((k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)).sort();

  const packageJson = JSON.stringify(
    {
      name: 'vscode',
      version: '1.0.0',
      // 双入口：CJS 走 index.cjs、ESM 走 index.mjs，都指向同一个运行时 API 对象
      main: 'index.cjs',
      exports: { '.': { require: './index.cjs', import: './index.mjs' } },
    },
    null,
    2,
  );

  const cjs = `// 由 Echoly 生成，请勿手工修改（每次启动会重写）
const api = globalThis.__echolyVscodeApi;
if (!api) {
  throw new Error('Echoly: vscode 扩展宿主尚未初始化');
}
module.exports = api;
`;

  const mjs = `// 由 Echoly 生成，请勿手工修改（每次启动会重写）
const api = globalThis.__echolyVscodeApi;
if (!api) {
  throw new Error('Echoly: vscode 扩展宿主尚未初始化');
}
${names.map((n) => `export const ${n} = api.${n};`).join('\n')}
export default api;
`;

  return { packageJson, cjs, mjs };
}

/**
 * 把 shim 写到 `<parentDir>/vscode/` 下（调用方传的应是 `node_modules` 目录）。
 * 内容每次启动重写：API 的键会随版本变化，旧文件留着会让新键解析不到。
 */
export async function writeVscodeShimModule(
  nodeModulesDir: string,
  apiKeys: string[],
): Promise<string> {
  const dir = path.join(nodeModulesDir, 'vscode');
  await fs.mkdir(dir, { recursive: true });
  const { packageJson, cjs, mjs } = buildVscodeShimModuleSources(apiKeys);
  await fs.writeFile(path.join(dir, 'package.json'), packageJson, 'utf8');
  await fs.writeFile(path.join(dir, 'index.cjs'), cjs, 'utf8');
  await fs.writeFile(path.join(dir, 'index.mjs'), mjs, 'utf8');
  return dir;
}
