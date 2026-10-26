import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LocalFsBackend } from '@deepseek-ide/tools';
import { CodebaseService } from '../src/main/codebaseService';
import { projectIndexDir } from '../src/main/projectConfig';

/**
 * 代码库索引。
 *
 * 这些测试主要盯三件「错了也不会报错、只会让结果变差」的事：
 * 1. 索引必须**落盘**，且能从盘上读回来 —— 否则每次搜索都在重扫工作区。
 * 2. 增量必须真的省下读文件 —— 只改一个文件时，其余文件不该被重新解析。
 * 3. 排序必须是 BM25（带 idf），稀有词命中要强于烂大街的词。
 *
 * 之所以要专门测第 3 点：手工权重写错时，搜索结果**看起来仍然合理**，
 * 只是排序悄悄退化，靠肉眼试用是发现不了的。
 */

const TS_SAMPLE = `
/**
 * 校验用户登录凭证并生成 Token
 */
export async function authenticateUser(username: string, passwordHash: string) {
  if (!username) {
    throw new Error('用户名不能为空');
  }
  return { token: 'jwt-xyz', username };
}

export interface UserSessionPayload {
  userId: string;
  role: 'admin' | 'user';
}
`;

describe('CodebaseService', () => {
  let tmpDir: string;
  let homeDir: string;
  let fakeWorkspace: any;
  let service: CodebaseService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echoly-codebase-test-'));
    // 索引默认落在 ~/.echoly/indexes/<哈希>。测试里注入一个临时目录，
    // 否则跑一次用例就会往开发者的真实主目录里写文件。
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echoly-home-'));
    fakeWorkspace = {
      getRoot: () => tmpDir,
      getBackend: () => new LocalFsBackend(tmpDir),
    };
    service = new CodebaseService(() => fakeWorkspace, (root) => projectIndexDir(root, homeDir));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('initializes with idle status', () => {
    const status = service.getStatus();
    expect(status.isIndexing).toBe(false);
    expect(status.indexedFiles).toBe(0);
    expect(status.totalSymbols).toBe(0);
  });

  it('indexes source files and extracts symbols and chunks', async () => {
    fs.writeFileSync(path.join(tmpDir, 'authService.ts'), TS_SAMPLE, 'utf-8');

    // 建立一个应被忽略的 node_modules 目录
    const nmDir = path.join(tmpDir, 'node_modules', 'dep');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, 'ignored.ts'), 'export const secret = 123;', 'utf-8');

    const status = await service.buildIndex();
    expect(status.indexedFiles).toBe(1);
    expect(status.totalSymbols).toBeGreaterThanOrEqual(1);

    const hits = await service.search('用户登录 凭证 token');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].name).toBe('authenticateUser');
    expect(hits[0].filePath).toContain('authService.ts');
    expect(hits[0].content).toContain('authenticateUser');

    const interfaceHits = await service.search('UserSessionPayload');
    expect(interfaceHits.length).toBeGreaterThanOrEqual(1);
    expect(interfaceHits[0].name).toBe('UserSessionPayload');
    expect(interfaceHits[0].kind).toBe('interface');
  });

  it('handles empty workspace gracefully', async () => {
    const emptyWorkspace = {
      getRoot: () => null,
      getBackend: () => null,
    };
    const emptyService = new CodebaseService(() => emptyWorkspace as any);
    const status = await emptyService.buildIndex();
    expect(status.indexedFiles).toBe(0);
    const hits = await emptyService.search('test');
    expect(hits).toEqual([]);
  });

  it('ranks a rare symbol match above a common word', async () => {
    // `user` 在三个文件里都出现，`authenticateUser` 只在一个文件里。
    // 没有 idf 的实现会让「到处都是的 user」把真正的定义挤下去。
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(
        path.join(tmpDir, `noise${i}.ts`),
        `export function handleUserRequest${i}() { const user = 1; return user; }\n`,
        'utf-8',
      );
    }
    fs.writeFileSync(path.join(tmpDir, 'auth.ts'), TS_SAMPLE, 'utf-8');

    await service.buildIndex();
    const hits = await service.search('authenticateUser', 5);
    expect(hits[0].name).toBe('authenticateUser');
  });

  it('persists the index and reloads it without re-reading files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'auth.ts'), TS_SAMPLE, 'utf-8');
    await service.buildIndex();
    const original = service.getStatus();
    expect(original.totalSymbols).toBeGreaterThan(0);

    // 换一个实例，模拟「关掉应用再打开」：不重新 buildIndex 也应该能搜到东西
    const reopened = new CodebaseService(() => fakeWorkspace, (root) => projectIndexDir(root, homeDir));
    const hits = await reopened.search('authenticateUser', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].name).toBe('authenticateUser');
    expect(reopened.getStatus().indexedFiles).toBe(1);
  });

  it('reuses unchanged files when indexing again', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export function alphaFn() { return 1; }\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'export function betaFn() { return 2; }\n', 'utf-8');
    await service.buildIndex();

    // 只碰 a.ts，并且把 mtime 推到足以被察觉
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export function alphaFn() { return 42; }\n', 'utf-8');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(tmpDir, 'a.ts'), later, later);

    const status = await service.buildIndex();
    // progress 里带着复用数：这是「增量真的生效了」的唯一可观测证据
    expect(status.progress?.reused).toBe(1);
    expect(status.indexedFiles).toBe(2);
    // a.ts 的内容确实被重读了
    const hits = await service.search('alphaFn', 5);
    expect(hits[0].content).toContain('42');
  });

  it('drops chunks of a deleted file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'gone.ts'), 'export function vanishedFn() { return 1; }\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'stays.ts'), 'export function remainsFn() { return 1; }\n', 'utf-8');
    await service.buildIndex();
    expect((await service.search('vanishedFn', 5)).length).toBeGreaterThan(0);

    fs.rmSync(path.join(tmpDir, 'gone.ts'));
    await service.buildIndex();

    // 删掉的文件若不清理，搜索结果里会出现打不开的路径 —— 那比搜不到更糟。
    // 这里断言的是「没有任何一条命中指向 gone.ts」，而不是「结果为空」：
    // `vanishedFn` 会被切成 vanished + fn，而 `fn` 是个到处都是的短词，
    // 别的符号命中它属于正常现象，不该被当成回归。
    const after = await service.search('vanishedFn', 5);
    expect(after.some((h) => h.filePath.includes('gone.ts'))).toBe(false);
    expect(service.getStatus().indexedFiles).toBe(1);
  });

  it('forces a full re-read when asked', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export function alphaFn() { return 1; }\n', 'utf-8');
    await service.buildIndex();
    const status = await service.buildIndex({ force: true });
    expect(status.progress?.reused).toBe(0);
    expect(status.indexedFiles).toBe(1);
  });

  it('skips oversized files instead of stalling the index', async () => {
    fs.writeFileSync(path.join(tmpDir, 'small.ts'), 'export function smallFn() { return 1; }\n', 'utf-8');
    // 600KB > 500KB 上限
    fs.writeFileSync(path.join(tmpDir, 'huge.ts'), `export const big = "${'x'.repeat(600 * 1024)}";\n`, 'utf-8');
    const status = await service.buildIndex();
    expect(status.indexedFiles).toBe(1);
    expect(await service.search('big', 5)).toEqual([]);
  });

  it('survives a corrupt cache file', async () => {
    // 写到一半断电、或者版本串了，都会留下半份 JSON。
    // 这时必须能继续工作（重建一次），而不是让整个搜索功能永久不可用。
    fs.writeFileSync(path.join(tmpDir, 'auth.ts'), TS_SAMPLE, 'utf-8');
    await service.buildIndex();

    const cacheFile = path.join(projectIndexDir(tmpDir, homeDir), 'codebase.json');
    if (fs.existsSync(cacheFile)) fs.writeFileSync(cacheFile, '{ this is not json', 'utf-8');

    const reopened = new CodebaseService(() => fakeWorkspace, (root) => projectIndexDir(root, homeDir));
    const hits = await reopened.search('authenticateUser', 5);
    expect(hits[0].name).toBe('authenticateUser');
  });

  it('reports progress while indexing', async () => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tmpDir, `f${i}.ts`), `export function fn${i}() { return ${i}; }\n`, 'utf-8');
    }
    const phases: string[] = [];
    service.setProgressListener((p) => phases.push(p.phase));
    await service.buildIndex();
    expect(phases).toContain('scan');
    expect(phases).toContain('done');
  });

  it('searchCached returns immediately instead of blocking on a cold index', async () => {
    // Agent 的 codebase_search 工具走这条路径。冷启动时同步等一次全量索引
    // （大项目几十秒）在界面上表现为「模型卡住不动」，而它其实什么都没做错。
    fs.writeFileSync(path.join(tmpDir, 'auth.ts'), TS_SAMPLE, 'utf-8');
    const started = Date.now();
    const hits = await service.searchCached('authenticateUser', 5);
    expect(hits).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('searchCached serves from a warm index', async () => {
    fs.writeFileSync(path.join(tmpDir, 'auth.ts'), TS_SAMPLE, 'utf-8');
    await service.buildIndex();
    const hits = await service.searchCached('authenticateUser', 5);
    expect(hits[0].name).toBe('authenticateUser');
  });
});
