import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeTool, type ToolContext } from '../src/index';
import { LocalFsBackend } from '../src/backend';

/**
 * apply_patch / delete_path / move_path 的行为回归。
 *
 * 重点在 apply_patch 的唯一性校验：旧的实现用 String.replace 只换第一处，
 * 模型给一个在文件里出现多次的片段时会静默改错位置，而返回的文本看起来还是「成功」的。
 */
async function makeCtx(
  files: Record<string, string> = {},
  overrides: Partial<ToolContext> = {},
): Promise<{ ctx: ToolContext; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echoly-patch-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  const ctx: ToolContext = {
    workspaceRoot: root,
    backend: new LocalFsBackend(root),
    permissionMode: 'allow_all',
    requireConfirmForWrites: false,
    requestConfirm: async () => true,
    enqueueDiff: (d) => ({ id: 'diff-1', ...d }),
    ...overrides,
  };
  return { ctx, root };
}

function parse(args: unknown): string {
  return JSON.stringify(args);
}

describe('apply_patch', () => {
  it('applies a single old_text/new_text pair (legacy shape)', async () => {
    const { ctx, root } = await makeCtx({ 'a.txt': 'hello world\n' });
    const res = await executeTool(
      'apply_patch',
      parse({ path: 'a.txt', old_text: 'world', new_text: 'there' }),
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('hello there\n');
  });

  it('applies several edits from the edits array in one call', async () => {
    const { ctx, root } = await makeCtx({ 'a.txt': 'one\ntwo\nthree\n' });
    const res = await executeTool(
      'apply_patch',
      parse({
        path: 'a.txt',
        edits: [
          { old_text: 'one', new_text: '1' },
          { old_text: 'three', new_text: '3' },
        ],
      }),
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('2 edit(s)');
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('1\ntwo\n3\n');
  });

  it('rejects a non-unique old_text instead of silently patching the first hit', async () => {
    const { ctx, root } = await makeCtx({ 'a.txt': 'return null;\nreturn null;\n' });
    const res = await executeTool(
      'apply_patch',
      parse({ path: 'a.txt', old_text: 'return null;', new_text: 'return 0;' }),
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain('not unique');
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe(
      'return null;\nreturn null;\n',
    );
  });

  it('replaces every occurrence when replace_all is set', async () => {
    const { ctx, root } = await makeCtx({ 'a.txt': 'x\nx\nx\n' });
    const res = await executeTool(
      'apply_patch',
      parse({
        path: 'a.txt',
        edits: [{ old_text: 'x', new_text: 'y', replace_all: true }],
      }),
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('y\ny\ny\n');
  });

  it('reports which edit in the array failed', async () => {
    const { ctx, root } = await makeCtx({ 'a.txt': 'alpha\n' });
    const res = await executeTool(
      'apply_patch',
      parse({
        path: 'a.txt',
        edits: [
          { old_text: 'alpha', new_text: 'beta' },
          { old_text: 'missing', new_text: 'gamma' },
        ],
      }),
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain('edits[1]');
    // 第二条失败意味着整次调用不落盘，第一条也不该被写进去（要么全成要么全不成）
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('alpha\n');
  });

  it('rejects an empty old_text and points at write_file', async () => {
    const { ctx } = await makeCtx({ 'a.txt': 'alpha\n' });
    const res = await executeTool(
      'apply_patch',
      parse({ path: 'a.txt', old_text: '', new_text: 'beta' }),
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain('write_file');
  });

  it('requires either edits or old_text/new_text', async () => {
    const { ctx } = await makeCtx({ 'a.txt': 'alpha\n' });
    const res = await executeTool('apply_patch', parse({ path: 'a.txt' }), ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('edits');
  });
});

describe('delete_path', () => {
  it('deletes a file', async () => {
    const { ctx, root } = await makeCtx({ 'a.txt': 'x' });
    const res = await executeTool('delete_path', parse({ path: 'a.txt' }), ctx);
    expect(res.isError).toBeFalsy();
    await expect(fs.stat(path.join(root, 'a.txt'))).rejects.toThrow();
  });

  it('refuses to delete a non-empty directory without recursive', async () => {
    const { ctx, root } = await makeCtx({ 'dir/a.txt': 'x' });
    const res = await executeTool('delete_path', parse({ path: 'dir' }), ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('recursive');
    expect((await fs.readdir(path.join(root, 'dir'))).length).toBe(1);
  });

  it('deletes a non-empty directory with recursive: true', async () => {
    const { ctx, root } = await makeCtx({ 'dir/a.txt': 'x' });
    const res = await executeTool('delete_path', parse({ path: 'dir', recursive: true }), ctx);
    expect(res.isError).toBeFalsy();
    await expect(fs.stat(path.join(root, 'dir'))).rejects.toThrow();
  });

  it('errors on a missing path instead of silently succeeding', async () => {
    const { ctx } = await makeCtx({});
    const res = await executeTool('delete_path', parse({ path: 'nope.txt' }), ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('not found');
  });
});

describe('move_path', () => {
  it('renames within the workspace', async () => {
    const { ctx, root } = await makeCtx({ 'a.txt': 'x' });
    const res = await executeTool('move_path', parse({ from: 'a.txt', to: 'b/c.txt' }), ctx);
    expect(res.isError).toBeFalsy();
    expect(await fs.readFile(path.join(root, 'b/c.txt'), 'utf8')).toBe('x');
    await expect(fs.stat(path.join(root, 'a.txt'))).rejects.toThrow();
  });

  it('rejects identical from/to', async () => {
    const { ctx } = await makeCtx({ 'a.txt': 'x' });
    const res = await executeTool('move_path', parse({ from: 'a.txt', to: 'a.txt' }), ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('identical');
  });

  it('rejects a missing source with a clear message', async () => {
    const { ctx } = await makeCtx({});
    const res = await executeTool('move_path', parse({ from: 'ghost.txt', to: 'x.txt' }), ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('does not exist');
  });
});

describe('host-provided tools', () => {
  it('search_symbols finds declarations in the workspace', async () => {
    const { ctx } = await makeCtx({
      'src/a.ts': 'export function alphaFn() {}\nexport class BetaClass {}\n',
    });
    const res = await executeTool('search_symbols', parse({ query: 'alpha' }), ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('alphaFn');
    expect(res.content).toContain('src/a.ts:1');
  });

  it('get_diagnostics says it is unavailable when no provider is wired', async () => {
    const { ctx } = await makeCtx({});
    const res = await executeTool('get_diagnostics', parse({}), ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('unavailable');
  });

  it('get_diagnostics formats provided entries and counts errors', async () => {
    const { ctx } = await makeCtx(
      {},
      {
        getDiagnostics: async () => [
          { path: 'src/a.ts', line: 3, column: 1, severity: 'error', message: 'boom' },
          { path: 'src/a.ts', line: 9, severity: 'warning', message: 'meh' },
        ],
      },
    );
    const res = await executeTool('get_diagnostics', parse({}), ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('2 diagnostic(s), 1 error(s)');
    expect(res.content).toContain('ERROR\tsrc/a.ts:3:1\tboom');
  });

  it('codebase_search says it is unavailable when no provider is wired', async () => {
    const { ctx } = await makeCtx({});
    const res = await executeTool('codebase_search', parse({ query: 'auth' }), ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('unavailable');
  });
});
