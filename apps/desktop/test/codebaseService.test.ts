import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LocalFsBackend } from '@deepseek-ide/tools';
import { EmbeddingClient, type LocalEmbeddingHandle } from '@deepseek-ide/llm';
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

  /**
   * 测试默认注入的装配：语义一路关闭。
   *
   * 必须显式注入 —— 默认装配会去读环境变量、进而在首次搜索时尝试加载 / 下载真实的
   * onnx 模型。用例既不该联网，也不该因为跑了一次单测就往 HuggingFace 缓存里塞 25MB。
   */
  const disabledEmbedding = async (): Promise<LocalEmbeddingHandle> => ({
    source: { kind: 'unavailable', reason: '测试中已关闭' },
    client: null,
    describe: '测试中已关闭',
  });

  /**
   * 关键字驱动的假 embedding：向量完全由文本里出现的词决定，
   * 于是「语义召回」可以脱开真实模型被精确断言。
   *
   * `zzz` 是埋的暗号 —— 它不出现在任何被索引的文本里，只出现在查询里，
   * 用来验证「词面对不上、但语义相近」的块也能被召回。
   */
  const makeKeywordEmbedding = (): { handle: LocalEmbeddingHandle; embedCalls: string[][] } => {
    const embedCalls: string[][] = [];
    const embed = async (texts: string[]): Promise<number[][]> => {
      embedCalls.push([...texts]);
      return texts.map((text) => {
        const t = text.toLowerCase();
        if (t.includes('zzz') || t.includes('gamma')) return [0, 0, 1];
        if (t.includes('alpha')) return [1, 0, 0];
        if (t.includes('beta')) return [0, 1, 0];
        return [0, 0, 0];
      });
    };
    return {
      embedCalls,
      handle: {
        source: { kind: 'download', modelId: 'fake-model' },
        client: new EmbeddingClient({ backend: { embed } }),
        describe: '假模型（测试）',
      },
    };
  };

  /** 后台向量化是 fire-and-forget 的，用例需要等它补齐。 */
  const waitForVectors = async (svc: CodebaseService, timeoutMs = 3000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = svc.getStatus();
      if ((s.vectorizedChunks ?? 0) >= s.totalSymbols && s.totalSymbols > 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echoly-codebase-test-'));
    // 索引默认落在 ~/.echoly/indexes/<哈希>。测试里注入一个临时目录，
    // 否则跑一次用例就会往开发者的真实主目录里写文件。
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echoly-home-'));
    fakeWorkspace = {
      getRoot: () => tmpDir,
      getBackend: () => new LocalFsBackend(tmpDir),
    };
    service = new CodebaseService(
      () => fakeWorkspace,
      (root) => projectIndexDir(root, homeDir),
      disabledEmbedding,
    );
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
    const emptyService = new CodebaseService(
      () => emptyWorkspace as any,
      undefined,
      disabledEmbedding,
    );
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
    const reopened = new CodebaseService(
      () => fakeWorkspace,
      (root) => projectIndexDir(root, homeDir),
      disabledEmbedding,
    );
    const hits = await reopened.search('authenticateUser', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].name).toBe('authenticateUser');
    expect(reopened.getStatus().indexedFiles).toBe(1);
  });

  it('reuses unchanged files when indexing again', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'a.ts'),
      'export function alphaFn() { return 1; }\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'b.ts'),
      'export function betaFn() { return 2; }\n',
      'utf-8',
    );
    await service.buildIndex();

    // 只碰 a.ts，并且把 mtime 推到足以被察觉
    fs.writeFileSync(
      path.join(tmpDir, 'a.ts'),
      'export function alphaFn() { return 42; }\n',
      'utf-8',
    );
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
    fs.writeFileSync(
      path.join(tmpDir, 'gone.ts'),
      'export function vanishedFn() { return 1; }\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'stays.ts'),
      'export function remainsFn() { return 1; }\n',
      'utf-8',
    );
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
    fs.writeFileSync(
      path.join(tmpDir, 'a.ts'),
      'export function alphaFn() { return 1; }\n',
      'utf-8',
    );
    await service.buildIndex();
    const status = await service.buildIndex({ force: true });
    expect(status.progress?.reused).toBe(0);
    expect(status.indexedFiles).toBe(1);
  });

  it('skips oversized files instead of stalling the index', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'small.ts'),
      'export function smallFn() { return 1; }\n',
      'utf-8',
    );
    // 600KB > 500KB 上限
    fs.writeFileSync(
      path.join(tmpDir, 'huge.ts'),
      `export const big = "${'x'.repeat(600 * 1024)}";\n`,
      'utf-8',
    );
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

    const reopened = new CodebaseService(
      () => fakeWorkspace,
      (root) => projectIndexDir(root, homeDir),
      disabledEmbedding,
    );
    const hits = await reopened.search('authenticateUser', 5);
    expect(hits[0].name).toBe('authenticateUser');
  });

  it('reports progress while indexing', async () => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(
        path.join(tmpDir, `f${i}.ts`),
        `export function fn${i}() { return ${i}; }\n`,
        'utf-8',
      );
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

  it('recalls a chunk that has no lexical overlap with the query', async () => {
    // 这就是「语义检索」要解决的问题：用户问「在哪里刷新 token」，
    // 而代码里写的是 verifySession。字面对不上，BM25 一定搜不到。
    fs.writeFileSync(
      path.join(tmpDir, 'alpha.ts'),
      'export function alphaFn() { return 1; }\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'beta.ts'),
      'export function betaFn() { return 2; }\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'gamma.ts'),
      'export function gammaFn() { return 3; }\n',
      'utf-8',
    );

    const { handle } = makeKeywordEmbedding();
    const semantic = new CodebaseService(
      () => fakeWorkspace,
      (root) => projectIndexDir(root, homeDir),
      async () => handle,
    );
    await semantic.buildIndex();
    await semantic.search('alpha', 5); // 触发后台向量化
    await waitForVectors(semantic);
    expect(semantic.getStatus().vectorizedChunks).toBe(semantic.getStatus().totalSymbols);

    // 'zzz' 不在任何被索引的文本里 → BM25 一路必然为空，唯一能召回 gamma 的就是语义一路
    const hits = await semantic.search('zzz', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].filePath).toContain('gamma.ts');
    expect(hits.some((h) => h.name === 'gammaFn')).toBe(true);
  });

  it('persists vectors so a restart does not recompute them', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'alpha.ts'),
      'export function alphaFn() { return 1; }\n',
      'utf-8',
    );

    const first = makeKeywordEmbedding();
    const svc1 = new CodebaseService(
      () => fakeWorkspace,
      (root) => projectIndexDir(root, homeDir),
      async () => first.handle,
    );
    await svc1.buildIndex();
    await svc1.search('alpha', 5);
    await waitForVectors(svc1);
    await svc1.dispose();

    const second = makeKeywordEmbedding();
    const svc2 = new CodebaseService(
      () => fakeWorkspace,
      (root) => projectIndexDir(root, homeDir),
      async () => second.handle,
    );
    await svc2.searchCached('alpha', 5);

    // 向量从盘上读回来了
    expect(svc2.getStatus().vectorizedChunks).toBeGreaterThan(0);
    // 而且没有被重算：第二次装配只嵌入过查询词，没有嵌入过任何代码块
    const reembeddedChunks = second.embedCalls.flat().filter((t) => t.includes('alphaFn'));
    expect(reembeddedChunks).toEqual([]);
  });

  it('degrades to BM25 when the embedding loader throws', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'alpha.ts'),
      'export function alphaFn() { return 1; }\n',
      'utf-8',
    );
    const broken = new CodebaseService(
      () => fakeWorkspace,
      (root) => projectIndexDir(root, homeDir),
      async () => {
        throw new Error('模型下载失败');
      },
    );
    await broken.buildIndex();

    // 关键：语义一路挂掉之后，检索必须照常可用
    const hits = await broken.search('alphaFn', 5);
    expect(hits[0].name).toBe('alphaFn');
    await new Promise((r) => setTimeout(r, 20));
    expect(broken.getStatus().embedding).toContain('不可用');
    expect(broken.getStatus().vectorizedChunks).toBe(0);
  });

  it('honours ECHOLY_EMBEDDING_DISABLED=1 through the default loader', async () => {
    vi.stubEnv('ECHOLY_EMBEDDING_DISABLED', '1');
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'alpha.ts'),
        'export function alphaFn() { return 1; }\n',
        'utf-8',
      );
      // 不注入装配，走真实的默认装配 —— 验证环境变量真的接到了装配层
      const svc = new CodebaseService(
        () => fakeWorkspace,
        (root) => projectIndexDir(root, homeDir),
      );
      await svc.buildIndex();
      const hits = await svc.search('alphaFn', 5);
      expect(hits[0].name).toBe('alphaFn');
      await new Promise((r) => setTimeout(r, 20));
      expect(svc.getStatus().vectorizedChunks).toBe(0);
      expect(svc.getStatus().embedding).toMatch(/已关闭/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
