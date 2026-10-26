import { describe, expect, it } from 'vitest';
import {
  revertMutations,
  snapshotPath,
  type FileMutation,
  type WorkspaceBackend,
} from '../src/index';

/**
 * 内存后端：撤销的核心是「逆序回放 + 冲突检测」，用真实文件系统测这些判断
 * 只会把测试变成对 fs 时序的依赖，用一张 Map 反而能把每条分支都断言清楚。
 */
function memBackend(files: Record<string, string>, dirs: string[] = []): WorkspaceBackend {
  const store = new Map(Object.entries(files));
  const dirSet = new Set(dirs);
  return {
    kind: 'local',
    root: '/w',
    async listDir(relPath: string = '.') {
      const prefix = relPath === '.' ? '' : `${relPath}/`;
      const names = new Set<string>();
      let isDir = false;
      for (const p of [...store.keys(), ...dirSet]) {
        if (prefix && !p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        if (!rest) continue;
        isDir = true;
        names.add(rest.split('/')[0]);
      }
      if (!isDir) throw new Error('ENOTDIR');
      return [...names].map((name) => ({ name, isDirectory: false }));
    },
    async readFile(relPath: string) {
      const v = store.get(relPath);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    async readFileLines() {
      throw new Error('unused');
    },
    async writeFile(relPath: string, content: string) {
      store.set(relPath, content);
    },
    async mkdir(relPath: string) {
      dirSet.add(relPath);
    },
    async rename(from: string, to: string) {
      const v = store.get(from);
      if (v === undefined) throw new Error('ENOENT');
      store.delete(from);
      store.set(to, v);
    },
    async remove(relPath: string) {
      for (const k of [...store.keys()]) {
        if (k === relPath || k.startsWith(`${relPath}/`)) store.delete(k);
      }
    },
    async copy() {},
    async exists(relPath: string) {
      if (store.has(relPath) || dirSet.has(relPath)) return true;
      // 目录不是 Map 里的键：只要有以它为前缀的文件，它就存在
      const prefix = `${relPath}/`;
      return [...store.keys(), ...dirSet].some((k) => k.startsWith(prefix));
    },
    resolveAbsolute: (p = '.') => `/w/${p}`,
    resolve: (p = '.') => `/w/${p}`,
    toRel: (p: string) => p,
    async runCommand() {
      return { stdout: '', stderr: '', code: 0 };
    },
    // 便于断言：`as unknown as` 已经绕过了类型检查，这里不需要（也不能）再写 @ts-expect-error
    __store: store,
  } as unknown as WorkspaceBackend & { __store: Map<string, string> };
}

const read = (b: WorkspaceBackend, p: string) =>
  (b as never as { __store: Map<string, string> }).__store.get(p);
const has = (b: WorkspaceBackend, p: string) =>
  (b as never as { __store: Map<string, string> }).__store.has(p);

describe('revertMutations', () => {
  it('restores the earliest content when a file was written several times in one turn', async () => {
    const backend = memBackend({ 'a.ts': 'v0' });
    const mutations: FileMutation[] = [
      { kind: 'write', path: 'a.ts', original: 'v0', written: 'v1' },
      { kind: 'write', path: 'a.ts', original: 'v1', written: 'v2' },
    ];
    const res = await revertMutations(backend, mutations);
    // 逆序回放：v2 -> v1 -> v0。正序回放会把 v1 留在文件里。
    expect(read(backend, 'a.ts')).toBe('v0');
    expect(res.reverted).toEqual(['a.ts']);
  });

  it('deletes a file the turn created instead of leaving an empty one', async () => {
    const backend = memBackend({});
    const res = await revertMutations(backend, [
      { kind: 'write', path: 'new.ts', original: null, written: 'hello' },
    ]);
    expect(has(backend, 'new.ts')).toBe(false);
    expect(res.reverted).toEqual(['new.ts']);
  });

  it('skips a file modified after the turn rather than clobbering the user edit', async () => {
    const backend = memBackend({ 'a.ts': 'user-edited' });
    const res = await revertMutations(backend, [
      { kind: 'write', path: 'a.ts', original: 'v0', written: 'ai-version' },
    ]);
    expect(read(backend, 'a.ts')).toBe('user-edited');
    expect(res.conflicts).toEqual(['a.ts']);
    expect(res.reverted).toEqual([]);
  });

  it('still reverts when the content matches what the turn wrote', async () => {
    const backend = memBackend({ 'a.ts': 'ai-version' });
    const res = await revertMutations(backend, [
      { kind: 'write', path: 'a.ts', original: 'v0', written: 'ai-version' },
    ]);
    expect(read(backend, 'a.ts')).toBe('v0');
    expect(res.conflicts).toEqual([]);
  });

  it('restores a deleted directory together with its files', async () => {
    const backend = memBackend({});
    await revertMutations(backend, [
      {
        kind: 'delete',
        path: 'src',
        snapshot: {
          dirs: ['src', 'src/nested'],
          files: [
            { path: 'src/index.ts', content: 'x' },
            { path: 'src/nested/deep.ts', content: 'y' },
          ],
        },
      },
    ]);
    expect(read(backend, 'src/index.ts')).toBe('x');
    expect(read(backend, 'src/nested/deep.ts')).toBe('y');
  });

  it('refuses to restore a delete when the path has been reoccupied', async () => {
    const backend = memBackend({ 'src/new.ts': 'brand new' });
    const res = await revertMutations(backend, [
      {
        kind: 'delete',
        path: 'src',
        snapshot: { dirs: ['src'], files: [{ path: 'src/old.ts', content: 'old' }] },
      },
    ]);
    expect(has(backend, 'src/old.ts')).toBe(false);
    expect(res.conflicts).toEqual(['src']);
  });

  it('reports a delete that could not be snapshotted instead of claiming success', async () => {
    const backend = memBackend({});
    const res = await revertMutations(backend, [
      { kind: 'delete', path: 'big.bin', snapshot: null },
    ]);
    expect(res.skipped).toEqual([{ path: 'big.bin', reason: '删除时未能留底，内容无法恢复' }]);
  });

  it('moves a renamed path back to its original location', async () => {
    const backend = memBackend({ 'b.ts': 'content' });
    const res = await revertMutations(backend, [{ kind: 'move', from: 'a.ts', to: 'b.ts' }]);
    expect(read(backend, 'a.ts')).toBe('content');
    expect(has(backend, 'b.ts')).toBe(false);
    expect(res.reverted).toEqual(['a.ts']);
  });

  it('will not move back over a file that now occupies the original path', async () => {
    const backend = memBackend({ 'a.ts': 'recreated', 'b.ts': 'moved' });
    const res = await revertMutations(backend, [{ kind: 'move', from: 'a.ts', to: 'b.ts' }]);
    expect(read(backend, 'a.ts')).toBe('recreated');
    expect(res.conflicts).toEqual(['a.ts']);
  });

  it('surfaces unrecordable operations as skipped', async () => {
    const backend = memBackend({});
    const res = await revertMutations(backend, [
      { kind: 'unrecordable', path: 'huge/', reason: '内容过大' },
    ]);
    expect(res.skipped).toEqual([{ path: 'huge/', reason: '内容过大' }]);
  });

  it('keeps going after one entry fails', async () => {
    const backend = memBackend({ 'a.ts': 'v1', 'b.ts': 'v1', 'boom.ts': 'v1' });
    const store = (backend as never as { __store: Map<string, string> }).__store;
    const originalWrite = backend.writeFile.bind(backend);
    backend.writeFile = async (p, c) => {
      if (p === 'boom.ts') throw new Error('EACCES: permission denied');
      await originalWrite(p, c);
    };

    const res = await revertMutations(backend, [
      { kind: 'write', path: 'a.ts', original: 'v0', written: 'v1' },
      { kind: 'write', path: 'boom.ts', original: 'v0', written: 'v1' },
      { kind: 'write', path: 'b.ts', original: 'v0', written: 'v1' },
    ]);

    // 单条失败不能中断整轮回放：剩下两个文件仍应被还原
    expect(store.get('a.ts')).toBe('v0');
    expect(store.get('b.ts')).toBe('v0');
    expect(store.get('boom.ts')).toBe('v1');
    expect(res.skipped.some((s) => s.path === 'boom.ts')).toBe(true);
  });

  it('treats a missing file as already reverted', async () => {
    const backend = memBackend({});
    const res = await revertMutations(backend, [
      { kind: 'write', path: 'gone.ts', original: null, written: 'x' },
    ]);
    expect(res.reverted).toEqual(['gone.ts']);
  });
});

describe('snapshotPath', () => {
  it('captures a single file', async () => {
    const backend = memBackend({ 'a.ts': 'hello' });
    const snap = await snapshotPath(backend, 'a.ts');
    expect(snap?.files).toEqual([{ path: 'a.ts', content: 'hello' }]);
    expect(snap?.dirs).toEqual([]);
  });

  it('captures a directory tree with its directories', async () => {
    const backend = memBackend({ 'src/a.ts': 'a', 'src/nested/b.ts': 'b' });
    const snap = await snapshotPath(backend, 'src');
    expect(snap?.dirs).toEqual(['src', 'src/nested']);
    expect(snap?.files?.map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/nested/b.ts']);
  });

  it('refuses to snapshot binary content so the turn is marked unrevertable', async () => {
    const backend = memBackend({ 'blob.bin': 'PNG\u0000\u0000binary' });
    expect(await snapshotPath(backend, 'blob.bin')).toBeNull();
  });

  it('returns null for a path that does not exist', async () => {
    expect(await snapshotPath(memBackend({}), 'nope.ts')).toBeNull();
  });
});
