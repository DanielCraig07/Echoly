import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DocsService,
  describeDocSources,
  isUnderSources,
  toManifestUrl,
} from '../src/main/docsService';

/**
 * 文档源服务。
 *
 * 重点在两件「错了也只是变慢或变哑」的事：
 * 缓存该命中时命中（否则每轮对话都重取几百 KB），
 * 以及取不到时**退回过期缓存**而不是整个不可用。
 */

const SOURCE = { name: 'Acme', url: 'https://docs.acme.dev' };

const MANIFEST = `# Acme Docs

> Acme 平台文档

## 快速开始

- [Getting Started](https://docs.acme.dev/start): 五分钟跑通
- [认证](https://docs.acme.dev/auth): 令牌与签名
`;

describe('toManifestUrl', () => {
  it('站点根补上 /llms.txt', () => {
    expect(toManifestUrl('https://x.dev')).toBe('https://x.dev/llms.txt');
    expect(toManifestUrl('https://x.dev/docs/')).toBe('https://x.dev/docs/llms.txt');
  });

  it('已经是 llms.txt 就原样保留', () => {
    expect(toManifestUrl('https://x.dev/llms.txt')).toBe('https://x.dev/llms.txt');
    expect(toManifestUrl('https://x.dev/llms-full.txt')).toBe('https://x.dev/llms-full.txt');
  });

  it('空串原样返回，交给上层判空', () => {
    expect(toManifestUrl('   ')).toBe('');
  });
});

describe('describeDocSources', () => {
  it('列出名称与地址；没有来源时为空串', () => {
    expect(describeDocSources([SOURCE])).toContain('Acme');
    expect(describeDocSources([SOURCE])).toContain('https://docs.acme.dev');
    expect(describeDocSources([])).toBe('');
  });
});

describe('DocsService', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echoly-docs-'));
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  const fetchReturning = (content: string) =>
    vi.fn(async (url: string) => ({ ok: true, url, content, title: 'Acme Docs' }));

  it('首次取清单会落盘，第二次不再请求', async () => {
    const fetchPage = fetchReturning(MANIFEST);
    const service = new DocsService({ fetchPage, cacheDir });

    const first = await service.loadIndex(SOURCE);
    expect(first.index.entries).toHaveLength(2);
    expect(fetchPage).toHaveBeenCalledTimes(1);

    const second = await service.loadIndex(SOURCE);
    expect(second.index.entries).toHaveLength(2);
    // 缓存命中：不再发第二次请求（否则每轮对话都要重取几百 KB）
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(second.cachedAt).not.toBeNull();
  });

  it('缓存过期后重新取', async () => {
    const fetchPage = fetchReturning(MANIFEST);
    let now = 1_000;
    const service = new DocsService({ fetchPage, cacheDir, ttlMs: 100, now: () => now });
    await service.loadIndex(SOURCE);
    now += 500;
    await service.loadIndex(SOURCE);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('取不到时退回过期缓存，而不是整个不可用', async () => {
    // 文档站偶尔抽风（限流、证书轮换、临时 5xx）很常见，
    // 「昨天那份清单」绝大多数情况下仍然有用
    const ok = fetchReturning(MANIFEST);
    let now = 1_000;
    const first = new DocsService({ fetchPage: ok, cacheDir, ttlMs: 100, now: () => now });
    await first.loadIndex(SOURCE);

    now += 10_000; // 缓存早已过期
    const failing = new DocsService({
      fetchPage: vi.fn(async () => ({ ok: false, url: SOURCE.url, error: '503' })),
      cacheDir,
      ttlMs: 100,
      now: () => now,
    });
    const result = await failing.loadIndex(SOURCE);
    expect(result.index.entries).toHaveLength(2);
    expect(result.error).toContain('503');
  });

  it('完全没有缓存且抓取失败时返回空索引与原因', async () => {
    const service = new DocsService({
      fetchPage: vi.fn(async () => ({ ok: false, url: SOURCE.url, error: '连不上' })),
      cacheDir,
    });
    const result = await service.loadIndex(SOURCE);
    expect(result.index.entries).toEqual([]);
    expect(result.error).toContain('连不上');
    expect(result.cachedAt).toBeNull();
  });

  it('站点只提供 llms-full.txt 时也能取到', async () => {
    const fetchPage = vi.fn(async (url: string) =>
      url.endsWith('llms-full.txt')
        ? { ok: true, url, content: MANIFEST }
        : { ok: false, url, error: '404' },
    );
    const service = new DocsService({ fetchPage, cacheDir });
    const result = await service.loadIndex({ name: 'X', url: 'https://x.dev' });
    expect(result.index.entries).toHaveLength(2);
  });

  it('抓到的不是 llms.txt 内容时给出可读原因', async () => {
    const service = new DocsService({
      fetchPage: fetchReturning('<html>站点首页</html>'),
      cacheDir,
    });
    const result = await service.loadIndex(SOURCE);
    expect(result.index.entries).toEqual([]);
    expect(result.error).toContain('llms.txt');
  });

  it('force 会绕过未过期的缓存', async () => {
    const fetchPage = fetchReturning(MANIFEST);
    const service = new DocsService({ fetchPage, cacheDir });
    await service.loadIndex(SOURCE);
    await service.loadIndex(SOURCE, { force: true });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('search 跨来源合并并按分数排序', async () => {
    const service = new DocsService({ fetchPage: fetchReturning(MANIFEST), cacheDir });
    const hits = await service.search([SOURCE], '认证');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ source: 'Acme', title: '认证' });
  });

  it('某个来源取不到时不影响其他来源', async () => {
    const fetchPage = vi.fn(async (url: string) =>
      url.includes('bad.dev')
        ? { ok: false, url, error: '404' }
        : { ok: true, url, content: MANIFEST },
    );
    const service = new DocsService({ fetchPage, cacheDir });
    const hits = await service.search([{ name: 'Bad', url: 'https://bad.dev' }, SOURCE], '认证');
    expect(hits.map((h) => h.source)).toEqual(['Acme']);
  });

  it('read 命中会话内缓存，失败时带上原因', async () => {
    const fetchPage = vi.fn(async (url: string) => ({
      ok: true,
      url,
      title: '认证',
      content: '# 认证\n\n用 Bearer 令牌。',
    }));
    const service = new DocsService({ fetchPage, cacheDir });

    const first = await service.read('https://docs.acme.dev/auth');
    expect(first.ok).toBe(true);
    expect(first.content).toContain('Bearer');

    await service.read('https://docs.acme.dev/auth');
    expect(fetchPage).toHaveBeenCalledTimes(1);

    const failing = new DocsService({
      fetchPage: vi.fn(async () => ({ ok: false, url: 'x', error: '超时' })),
      cacheDir,
    });
    expect(await failing.read('https://docs.acme.dev/x')).toMatchObject({
      ok: false,
      error: '超时',
    });
  });

  it('read 遇到没有正文的页面时明确说明（纯 JS 渲染的站点）', async () => {
    const service = new DocsService({
      fetchPage: vi.fn(async (url: string) => ({ ok: true, url, content: '' })),
      cacheDir,
    });
    const result = await service.read('https://docs.acme.dev/spa');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('正文');
  });

  it('statuses 报告每个来源的条目数，取不到时带上原因', async () => {
    const fetchPage = vi.fn(async (url: string) =>
      url.includes('bad.dev')
        ? { ok: false, url, error: '404' }
        : { ok: true, url, content: MANIFEST },
    );
    const service = new DocsService({ fetchPage, cacheDir });
    const statuses = await service.statuses([SOURCE, { name: 'Bad', url: 'https://bad.dev' }]);
    expect(statuses[0]).toMatchObject({ name: 'Acme', ok: true, entries: 2 });
    expect(statuses[1]).toMatchObject({ name: 'Bad', ok: false, entries: 0 });
    expect(statuses[1].error).toBeTruthy();
  });

  it('缓存文件损坏时当作没有缓存，而不是抛错', async () => {
    const service = new DocsService({ fetchPage: fetchReturning(MANIFEST), cacheDir });
    await service.loadIndex(SOURCE);
    for (const file of fs.readdirSync(cacheDir)) {
      fs.writeFileSync(path.join(cacheDir, file), '{ 坏掉的', 'utf8');
    }
    const again = new DocsService({ fetchPage: fetchReturning(MANIFEST), cacheDir });
    expect((await again.loadIndex(SOURCE)).index.entries).toHaveLength(2);
  });
});

describe('isUnderSources', () => {
  const sources = [{ name: 'Acme', url: 'https://docs.acme.dev' }];

  it('同源放行（含路径与查询）', () => {
    expect(isUnderSources('https://docs.acme.dev/auth', sources)).toBe(true);
    expect(isUnderSources('https://docs.acme.dev/a/b?c=1', sources)).toBe(true);
  });

  it('不同主机一律拦住', () => {
    // 不设这个边界，read_doc 就是一个没有名字的万能抓取器，
    // 用户「只登记了几个文档站」的授权就形同虚设
    expect(isUnderSources('https://evil.example.com/auth', sources)).toBe(false);
    expect(isUnderSources('https://docs.acme.dev.evil.com/x', sources)).toBe(false);
  });

  it('协议或端口不同也算不同源', () => {
    expect(isUnderSources('http://docs.acme.dev/auth', sources)).toBe(false);
    expect(isUnderSources('https://docs.acme.dev:8443/auth', sources)).toBe(false);
  });

  it('非法地址与非法来源配置都不抛错', () => {
    expect(isUnderSources('not-a-url', sources)).toBe(false);
    expect(isUnderSources('https://x.dev/a', [{ name: 'x', url: '不是地址' }])).toBe(false);
    expect(isUnderSources('https://x.dev/a', [])).toBe(false);
  });

  it('多个来源时命中任意一个即可', () => {
    const many = [
      { name: 'A', url: 'https://a.dev' },
      { name: 'B', url: 'https://b.dev' },
    ];
    expect(isUnderSources('https://b.dev/x', many)).toBe(true);
    expect(isUnderSources('https://c.dev/x', many)).toBe(false);
  });
});
