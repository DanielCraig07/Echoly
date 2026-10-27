import { describe, expect, it } from 'vitest';
import type { FileMutation, WorkspaceBackend } from '@deepseek-ide/tools';
import { CheckpointStore } from '../src/main/checkpointStore';

/** 只实现撤销路径会用到的几个方法，其余用不到。 */
function memBackend(files: Record<string, string>): WorkspaceBackend & {
  __store: Map<string, string>;
} {
  const store = new Map(Object.entries(files));
  const backend = {
    kind: 'local' as const,
    root: '/w',
    async exists(relPath: string) {
      return store.has(relPath);
    },
    async readFile(relPath: string) {
      const v = store.get(relPath);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    async writeFile(relPath: string, content: string) {
      store.set(relPath, content);
    },
    async mkdir() {},
    async rename(from: string, to: string) {
      const v = store.get(from);
      if (v === undefined) throw new Error('ENOENT');
      store.delete(from);
      store.set(to, v);
    },
    async remove(relPath: string) {
      store.delete(relPath);
    },
    __store: store,
  } as unknown as WorkspaceBackend & { __store: Map<string, string> };
  return backend;
}

const write = (path: string, original: string | null, written: string): FileMutation => ({
  kind: 'write',
  path,
  original,
  written,
});

describe('CheckpointStore', () => {
  it('reports no summary before anything is recorded', () => {
    const store = new CheckpointStore();
    store.begin('r1');
    expect(store.summary()).toBeNull();
    expect(store.latest()).toBeNull();
  });

  it('summarises the most recent run that has mutations', () => {
    const store = new CheckpointStore();
    store.begin('r1');
    store.record('r1', write('a.ts', 'v0', 'v1'));
    store.begin('r2'); // 开了新一轮但什么都没改（纯问答）
    expect(store.summary()?.runId).toBe('r1');
  });

  it('reverts only the requested run', async () => {
    const store = new CheckpointStore();
    const backend = memBackend({ 'a.ts': 'v1', 'b.ts': 'v1' });
    store.begin('r1');
    store.record('r1', write('a.ts', 'v0', 'v1'));
    store.begin('r2');
    store.record('r2', write('b.ts', 'v0', 'v1'));

    const out = await store.revert(backend, 'r1');
    expect('error' in out).toBe(false);
    expect(backend.__store.get('a.ts')).toBe('v0');
    // r2 的改动不属于被撤销的那一轮，必须原样留着
    expect(backend.__store.get('b.ts')).toBe('v1');
  });

  it('refuses a run containing an unrecordable operation instead of half-reverting', async () => {
    const store = new CheckpointStore();
    const backend = memBackend({ 'a.ts': 'v1' });
    store.begin('r1');
    store.record('r1', write('a.ts', 'v0', 'v1'));
    store.record('r1', { kind: 'unrecordable', path: 'big.bin', reason: '二进制' });

    const out = await store.revert(backend, 'r1');
    expect('error' in out && out.error).toContain('big.bin');
    // 文件必须没被动过：部分撤销比不撤销更危险
    expect(backend.__store.get('a.ts')).toBe('v1');
  });

  it('marks the summary incomplete when an unrecordable operation was seen', () => {
    const store = new CheckpointStore();
    store.begin('r1');
    store.record('r1', write('a.ts', 'v0', 'v1'));
    store.record('r1', { kind: 'unrecordable', path: 'big.bin', reason: '二进制' });
    const summary = store.summary('r1');
    expect(summary?.incomplete).toBe(true);
    expect(summary?.incompleteReason).toContain('big.bin');
  });

  it('cannot be reverted twice — the record is consumed on success', async () => {
    const store = new CheckpointStore();
    const backend = memBackend({ 'a.ts': 'v1' });
    store.begin('r1');
    store.record('r1', write('a.ts', 'v0', 'v1'));
    await store.revert(backend, 'r1');

    // 第二次点撤销必须失败：记录已失效，重放会把磁盘上的 v0 写回成 v0（无害），
    // 但更糟的情况是用户手改之后又被回退 —— 所以宁可报错
    const again = await store.revert(backend, 'r1');
    expect('error' in again).toBe(true);
  });

  it('errors when asked to revert a run that has no mutations', async () => {
    const store = new CheckpointStore();
    store.begin('r1');
    const out = await store.revert(memBackend({}), 'r1');
    expect('error' in out).toBe(true);
  });

  it('errors when there is nothing to revert at all', async () => {
    const store = new CheckpointStore();
    const out = await store.revert(memBackend({}));
    expect('error' in out && out.error).toContain('没有可撤销');
  });

  it('drops the oldest run once the retention limit is exceeded', () => {
    const store = new CheckpointStore();
    for (let i = 0; i < 12; i++) {
      store.begin(`r${i}`);
      store.record(`r${i}`, write(`f${i}.ts`, 'v0', 'v1'));
    }
    // 只留最近 10 轮：最早的 r0 / r1 的记录里带着被改文件的正文，不该长期驻留内存
    expect(store.summary('r0')).toBeNull();
    expect(store.summary('r11')?.runId).toBe('r11');
  });

  it('clears everything when the workspace root changes', () => {
    const store = new CheckpointStore();
    store.begin('r1');
    store.record('r1', write('a.ts', 'v0', 'v1'));
    store.clear();
    expect(store.summary()).toBeNull();
    expect(store.latest()).toBeNull();
  });

  it('ignores records for an unknown run', () => {
    const store = new CheckpointStore();
    store.record('never-started', write('a.ts', 'v0', 'v1'));
    expect(store.summary()).toBeNull();
  });

  it('re-opening the same runId starts a fresh record', () => {
    const store = new CheckpointStore();
    store.begin('r1');
    store.record('r1', write('a.ts', 'v0', 'v1'));
    store.begin('r1');
    expect(store.summary()).toBeNull();
  });

  it('aggregates multiple mutations on the same file and reports accurate fileCount', () => {
    const store = new CheckpointStore();
    store.begin('r1');
    // ua.txt written twice
    store.record('r1', write('ua.txt', 'v0', 'v1'));
    store.record('r1', write('ua.txt', 'v1', 'v2'));
    // _add_ua.py created, modified, then deleted
    store.record('r1', write('_add_ua.py', null, 'script_v1'));
    store.record('r1', write('_add_ua.py', 'script_v1', 'script_v2'));
    store.record('r1', {
      kind: 'delete',
      path: '_add_ua.py',
      snapshot: { dirs: [], files: [{ path: '_add_ua.py', content: 'script_v2' }] },
    });

    const summary = store.summary('r1');
    expect(summary?.mutations).toBe(5);
    expect(summary?.fileCount).toBe(2);

    const detail = store.detail('r1');
    expect(detail?.fileCount).toBe(2);
    expect(detail?.files.length).toBe(2);

    const ua = detail?.files.find((f) => f.path === 'ua.txt');
    expect(ua).toBeDefined();
    expect(ua?.kind).toBe('write');
    expect(ua?.original).toBe('v0');
    expect(ua?.written).toBe('v2');

    const script = detail?.files.find((f) => f.path === '_add_ua.py');
    expect(script).toBeDefined();
    expect(script?.kind).toBe('delete');
    expect(script?.original).toBeNull();
    expect(script?.written).toBeNull();
  });

  it('persists checkpoints to disk and reloads them after memory is cleared', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-test-'));

    try {
      const store = new CheckpointStore(tmpDir);
      store.begin('r100');
      store.record('r100', write('foo.txt', 'old', 'new'));

      // Checkpoint file should exist on disk
      const filePath = path.join(tmpDir, 'r100.json');
      expect(fs.existsSync(filePath)).toBe(true);

      // Clear memory (simulating session reload / restart)
      store.clear();

      // Now query summary and detail from disk
      const summary = store.summary('r100');
      expect(summary).not.toBeNull();
      expect(summary?.runId).toBe('r100');
      expect(summary?.fileCount).toBe(1);

      const detail = store.detail('r100');
      expect(detail).not.toBeNull();
      expect(detail?.files[0].path).toBe('foo.txt');

      // Now revert from disk
      const backend = memBackend({ 'foo.txt': 'new' });
      const rev = await store.revert(backend, 'r100');
      expect('error' in rev).toBe(false);
      expect(backend.__store.get('foo.txt')).toBe('old');

      // Checkpoint file should be cleaned up after full revert
      expect(fs.existsSync(filePath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
