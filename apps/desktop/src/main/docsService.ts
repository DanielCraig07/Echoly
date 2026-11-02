/**
 * 文档源服务：取 `llms.txt`、落盘缓存、按查询检索、按链接读全文。
 *
 * 取数一律走已有的 `fetchWebPage`：它带着 SSRF 防护、逐跳重定向校验、
 * 超时与边读边卡的字节上限。这里如果自己 `fetch`，那套防护就得再做一遍 ——
 * 而「再做的这一遍漏了一条」不会有任何报错，只会安静地多出一个可被提示注入利用的入口。
 *
 * 缓存落在 `~/.echoly/docs/`，按来源 URL 哈希分文件。缓存的意义不只是省流量：
 * 文档站的清单动辄几百 KB，每轮对话都去取一次会让 Agent 的第一次工具调用明显变慢，
 * 用户看到的是「模型卡了一下」。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  parseLlmsTxt,
  searchDocEntries,
  type DocEntry,
  type ParsedDocIndex,
} from '@deepseek-ide/tools';

export interface DocSourceConfig {
  /** 显示名，出现在结果里，帮助模型理解「这是哪个站点的文档」 */
  name: string;
  /** 站点基址，或 `llms.txt` 的完整地址 */
  url: string;
}

export interface PageFetcher {
  (url: string): Promise<{
    ok: boolean;
    url: string;
    title?: string;
    content?: string;
    truncated?: boolean;
    error?: string;
  }>;
}

export interface DocsServiceOptions {
  fetchPage: PageFetcher;
  /** 缓存目录 */
  cacheDir: string;
  /** 缓存有效期。文档站更新不频繁，默认一天。 */
  ttlMs?: number;
  now?: () => number;
}

/** 默认缓存有效期：24 小时。 */
export const DOCS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 单次读全文的会话内缓存条数。同一轮对话里反复读同一页很常见。 */
const MAX_PAGE_CACHE = 32;

interface SourceCache {
  url: string;
  fetchedAt: number;
  index: ParsedDocIndex;
}

export interface DocSearchHit {
  source: string;
  title: string;
  url: string;
  description?: string;
  section?: string;
  score: number;
}

export interface DocSourceStatus {
  name: string;
  url: string;
  ok: boolean;
  entries: number;
  /** 清单的缓存时间；本次新取的为 null */
  cachedAt: number | null;
  error?: string;
}

export class DocsService {
  private readonly fetchPage: PageFetcher;
  private readonly cacheDir: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly pageCache = new Map<
    string,
    { title?: string; content?: string; truncated?: boolean }
  >();

  constructor(options: DocsServiceOptions) {
    this.fetchPage = options.fetchPage;
    this.cacheDir = options.cacheDir;
    this.ttlMs = options.ttlMs ?? DOCS_CACHE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 取某个来源的清单，优先用未过期的缓存。
   *
   * 取不到时**返回缓存里那份过期的**而不是直接失败：文档站偶尔抽风
   * （限流、证书轮换、临时 5xx）很常见，而「昨天那份清单」绝大多数情况下
   * 仍然有用。宁可给一份略旧的索引，也不要让检索整个不可用。
   */
  async loadIndex(
    source: DocSourceConfig,
    options: { force?: boolean } = {},
  ): Promise<{
    index: ParsedDocIndex;
    cachedAt: number | null;
    error?: string;
  }> {
    const manifestUrl = toManifestUrl(source.url);
    const cacheFile = this.cacheFileFor(manifestUrl);
    const cached = await this.readCache(cacheFile);

    const fresh = cached && this.now() - cached.fetchedAt < this.ttlMs;
    if (cached && fresh && !options.force) {
      return { index: cached.index, cachedAt: cached.fetchedAt };
    }

    const fetched = await this.fetchManifest(manifestUrl, source.url);
    if (!fetched.index) {
      if (cached) return { index: cached.index, cachedAt: cached.fetchedAt, error: fetched.error };
      return { index: { entries: [] }, cachedAt: null, error: fetched.error };
    }

    const record: SourceCache = {
      url: manifestUrl,
      fetchedAt: this.now(),
      index: fetched.index,
    };
    await this.writeCache(cacheFile, record);
    return { index: fetched.index, cachedAt: null };
  }

  /** 跨来源检索，按分数合并。取不到清单的来源会被跳过（其错误在 status 里能查到）。 */
  async search(
    sources: readonly DocSourceConfig[],
    query: string,
    limit = 8,
  ): Promise<DocSearchHit[]> {
    const hits: DocSearchHit[] = [];
    for (const source of sources) {
      const { index } = await this.loadIndex(source);
      for (const hit of searchDocEntries(index.entries, query, limit)) {
        hits.push({
          source: source.name,
          title: hit.entry.title,
          url: hit.entry.url,
          description: hit.entry.description,
          section: hit.entry.section,
          score: hit.score,
        });
      }
    }
    return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
  }

  /** 读某一页的正文。走 `fetchPage`（HTML 已转 Markdown、带字节上限）。 */
  async read(url: string): Promise<{
    ok: boolean;
    url: string;
    title?: string;
    content?: string;
    truncated?: boolean;
    error?: string;
  }> {
    const cached = this.pageCache.get(url);
    if (cached) return { ok: true, url, ...cached };

    const result = await this.fetchPage(url);
    if (!result.ok) {
      return { ok: false, url: result.url || url, error: result.error ?? '抓取失败' };
    }
    if (!result.content) {
      return { ok: false, url: result.url, error: '页面没有可读正文（可能是纯 JS 渲染的站点）' };
    }

    const entry = { title: result.title, content: result.content, truncated: result.truncated };
    // 简单 FIFO 淘汰：读全文的结果体积大，留住的条数要小
    if (this.pageCache.size >= MAX_PAGE_CACHE) {
      const oldest = this.pageCache.keys().next();
      if (!oldest.done) this.pageCache.delete(oldest.value);
    }
    this.pageCache.set(url, entry);
    return { ok: true, url: result.url, ...entry };
  }

  /** 各来源的可用状态，供设置页展示「配的这个站有没有 llms.txt」。 */
  async statuses(
    sources: readonly DocSourceConfig[],
    options: { force?: boolean } = {},
  ): Promise<DocSourceStatus[]> {
    const out: DocSourceStatus[] = [];
    for (const source of sources) {
      const manifestUrl = toManifestUrl(source.url);
      const cached = await this.readCache(this.cacheFileFor(manifestUrl));
      const { index, cachedAt, error } = await this.loadIndex(source, options);
      out.push({
        name: source.name,
        url: source.url,
        ok: index.entries.length > 0,
        entries: index.entries.length,
        cachedAt: cachedAt ?? cached?.fetchedAt ?? null,
        error: index.entries.length > 0 ? undefined : error,
      });
    }
    return out;
  }

  private async fetchManifest(
    manifestUrl: string,
    baseUrl: string,
  ): Promise<{ index?: ParsedDocIndex; error?: string }> {
    // 先试 llms.txt，再试 llms-full.txt：后者是「全文版」，
    // 有些站点只提供它。两者格式一致，解析器可以共用。
    const candidates = [manifestUrl];
    if (manifestUrl.endsWith('/llms.txt')) {
      candidates.push(manifestUrl.replace(/\/llms\.txt$/, '/llms-full.txt'));
    }

    let lastError = '';
    for (const candidate of candidates) {
      const result = await this.fetchPage(candidate);
      if (!result.ok || !result.content) {
        lastError = result.error ?? '抓取失败';
        continue;
      }
      const index = parseLlmsTxt(result.content, result.url || candidate);
      if (index.entries.length === 0) {
        lastError = '该地址没有可解析的 llms.txt 条目（站点可能未提供此文件）';
        continue;
      }
      void baseUrl;
      return { index };
    }
    return { error: lastError || '抓取失败' };
  }

  private cacheFileFor(manifestUrl: string): string {
    const hash = createHash('sha1').update(manifestUrl).digest('hex').slice(0, 16);
    return path.join(this.cacheDir, `${hash}.json`);
  }

  private async readCache(file: string): Promise<SourceCache | null> {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as SourceCache;
      if (!parsed || typeof parsed.fetchedAt !== 'number' || !parsed.index?.entries) return null;
      return parsed;
    } catch {
      // 没缓存是常态
      return null;
    }
  }

  private async writeCache(file: string, record: SourceCache): Promise<void> {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      // 先写临时文件再改名：中途失败不会留下半份 JSON 让下次启动读到坏缓存
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(record), 'utf8');
      await fs.rename(tmp, file);
    } catch {
      // 落盘失败只是下次要重新取，不影响本次检索
    }
  }
}

/**
 * 把用户填的地址规范成 `llms.txt` 的地址。
 *
 * 允许两种填法：直接给 `https://x.dev/llms.txt`，或只给站点根 `https://x.dev/docs`。
 * 后者更符合直觉，但不做这一步的话会去取站点首页的 HTML 当清单，
 * 结果是一条条目都解析不出来 —— 而错误信息只会说「没有条目」。
 */
export function toManifestUrl(input: string): string {
  const url = input.trim();
  if (!url) return url;
  if (/llms(-full)?\.txt$/i.test(url)) return url;
  return `${url.replace(/\/+$/, '')}/llms.txt`;
}

/** 供工具层拼「可用来源」提示。 */
export function describeDocSources(sources: readonly DocSourceConfig[]): string {
  if (sources.length === 0) return '';
  return sources.map((s) => `- ${s.name}：${s.url}`).join('\n');
}

/**
 * 地址是否落在已配置的文档源上。
 *
 * `read_doc` 收的是模型给的任意字符串 —— 不设边界的话，它就是一个没有名字的
 * 万能抓取器，用户「只登记了几个文档站」的授权就形同虚设。这里按**同源**
 * （协议 + 主机 + 端口）判断：比按路径前缀宽松，因为文档站常把正文放在另一个
 * 子域（`docs.x.dev` 与 `x.dev`），按路径判会大面积误伤。
 */
export function isUnderSources(url: string, sources: readonly DocSourceConfig[]): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  return sources.some((source) => {
    try {
      return new URL(source.url).origin === target.origin;
    } catch {
      return false;
    }
  });
}

export type { DocEntry };
