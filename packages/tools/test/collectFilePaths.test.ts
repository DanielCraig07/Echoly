import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { collectFilePathsLocal } from '../src/search';

/**
 * `collectFilePathsLocal` 走三级降级：`git ls-files` → `rg --files` → `find`。
 *
 * 之所以专门测它：这条路径**每一步失败都是静默的**（catch 之后 fall through），
 * 三级全挂时函数正常返回 `[]`，看起来和「空工作区」一模一样。而它的调用方
 * 是全局搜索与代码库索引 —— 索引悄悄变空，界面上只是「搜不到东西」。
 *
 * 测试目录**不初始化 git**，于是前两级必然失败，被迫走 `find` 分支，
 * 这样 `find` 的参数数组（`-prune` 表达式）才有真实覆盖。
 */
describe('collectFilePathsLocal', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'echoly-collect-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const write = async (rel: string, body = 'x') => {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  };

  it('非 git 目录下仍能通过 find 兜底收集到文件', async () => {
    await write('src/a.ts');
    await write('src/deep/b.ts');
    await write('README.md');

    const files = await collectFilePathsLocal(root);

    expect(files).toContain('src/a.ts');
    expect(files).toContain('src/deep/b.ts');
    expect(files).toContain('README.md');
  });

  it('跳过 node_modules / dist 等重型目录', async () => {
    await write('src/a.ts');
    await write('node_modules/pkg/index.js');
    await write('dist/bundle.js');

    const files = await collectFilePathsLocal(root);

    expect(files).toContain('src/a.ts');
    // 这两个目录会被 `-prune` 剪掉：一旦剪枝表达式写错（比如 `-o` 与 `(` 的位置颠倒），
    // 它们会以绝对数量的形式涌进来，把 maxFiles 配额吃光。
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false);
    expect(files.some((f) => f.startsWith('dist/'))).toBe(false);
  });

  it('返回的是相对路径且用正斜杠，不带 ./ 前缀', async () => {
    await write('src/a.ts');

    const files = await collectFilePathsLocal(root);

    for (const f of files) {
      expect(f.startsWith('./')).toBe(false);
      expect(f.startsWith('/')).toBe(false);
      expect(f).not.toContain('\\');
    }
  });

  it('遵守 maxFiles 上限', async () => {
    for (let i = 0; i < 20; i++) {
      await write(`src/f${i}.ts`);
    }

    const files = await collectFilePathsLocal(root, 5);

    expect(files.length).toBeLessThanOrEqual(5);
  });

  it('目录不存在时返回空数组而不是抛错', async () => {
    // 调用方（全局搜索、代码库索引）没有 try/catch 包着这一句：
    // 这里抛出去会让整个搜索流程炸掉，而不是「这个工作区搜不到东西」。
    await expect(collectFilePathsLocal(path.join(root, 'nope'))).resolves.toEqual([]);
  });
});
