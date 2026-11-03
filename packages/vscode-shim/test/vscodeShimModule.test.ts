import { describe, expect, it } from 'vitest';
import { buildVscodeShimModuleSources } from '../src/vscodeShimModule';

/**
 * 生成的 `vscode` shim 模块。
 *
 * 这份文件是**给 ESM 扩展解析用的**（`import 'vscode'` 绕不过 require 补丁）。
 * 它一旦语法坏了，后果是「所有 ESM 形式的扩展一律加载不了」，而报错发生在
 * 扩展那边，很难往生成器上想 —— 所以生成结果本身要被断言。
 */

const sources = buildVscodeShimModuleSources(['commands', 'window', 'not-a-name', 'commands']);

describe('buildVscodeShimModuleSources', () => {
  it('按运行时 API 的键生成具名导出（ESM 的名字导出必须是静态的）', () => {
    expect(sources.mjs).toContain('export const commands = api.commands;');
    expect(sources.mjs).toContain('export const window = api.window;');
    expect(sources.mjs).toContain('export default api;');
  });

  it('去掉重复与非法标识符，而不是生成一份坏文件', () => {
    expect(sources.mjs.match(/export const commands/g)).toHaveLength(1);
    // 非法名字只影响它自己 —— 不能因为它让整份文件语法错误
    expect(sources.mjs).not.toContain('not-a-name');
  });

  it('双入口都指向同一个运行时对象', () => {
    expect(sources.cjs).toContain('module.exports = api;');
    expect(sources.cjs).toContain('globalThis.__echolyVscodeApi');
    const pkg = JSON.parse(sources.packageJson);
    expect(pkg.exports['.'].require).toBe('./index.cjs');
    expect(pkg.exports['.'].import).toBe('./index.mjs');
  });
});
