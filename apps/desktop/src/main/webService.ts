/**
 * 联网抓取层（主进程）。
 *
 * 与 `@deepseek-ide/tools` 里的 `web.ts` 分工明确：那边是纯逻辑（URL 校验、
 * HTML→Markdown、字节截断），这边只负责真正把字节抓回来。所有安全判断都复用
 * 那边的实现，这里不重复一遍规则 —— 两处各写一套迟早会分叉。
 *
 * 两个容易踩空的地方在这里显式处理：
 *
 * 1. **重定向不能交给 fetch 自己跟。** `redirect: 'follow'` 意味着第一跳合法、
 *    第二跳打到 `169.254.169.254` 这种元数据地址也会被自动跟随。所以这里手动
 *    跟随，每一跳都重新过一遍校验。
 * 2. **响应体必须边读边卡上限。** 先 `await response.text()` 再判断大小，
 *    等于把攻击者给的那个 500MB 响应体先完整读进内存了。
 */

import {
  DEFAULT_URL_POLICY,
  decodeEntities,
  htmlToMarkdown,
  parseDuckDuckGoHtml,
  truncateUtf8,
  validateFetchUrl,
  type UrlPolicy,
  type WebSearchHit,
} from '@deepseek-ide/tools';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;
const USER_AGENT = 'Echoly/1.0 (+https://github.com/DanielCraig07/Echoly)';
const ACCEPT_HEADER = 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5';

export interface WebFetchOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  policy?: UrlPolicy;
  /** 返回**原始响应体**而不是渲染后的正文。搜索这类需要解析 DOM 结构的场景用得上 ——
     一旦经 HTML→Markdown，class 名就没了，解析器也就无从下手。 */
  rawBody?: boolean;
}

export interface WebFetchResult {
  ok: boolean;
  /** 跟随重定向后的最终地址 */
  url: string;
  status?: number;
  contentType?: string;
  title?: string;
  /** 供模型阅读的正文（HTML 已转 Markdown） */
  content?: string;
  truncated?: boolean;
  error?: string;
}

export async function fetchWebPage(
  rawUrl: string,
  options: WebFetchOptions = {},
): Promise<WebFetchResult> {
  const policy = options.policy ?? DEFAULT_URL_POLICY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let currentUrl = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const checked = validateFetchUrl(currentUrl, policy);
    if (!checked.ok) {
      return { ok: false, url: currentUrl, error: checked.reason };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(checked.url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, accept: ACCEPT_HEADER },
      });
    } catch (err) {
      const aborted = controller.signal.aborted;
      return {
        ok: false,
        url: currentUrl,
        error: aborted
          ? `请求超时（${timeoutMs}ms）：${currentUrl}`
          : `请求失败：${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }

    // 手动跟随重定向：位置头是相对的，且下一跳要重新校验
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) {
        return {
          ok: false,
          url: currentUrl,
          status: response.status,
          error: '重定向缺少 Location 头',
        };
      }
      try {
        currentUrl = new URL(location, checked.url).toString();
      } catch {
        return { ok: false, url: currentUrl, error: `无法解析重定向目标：${location}` };
      }
      continue;
    }

    const contentType = response.headers.get('content-type') ?? '';
    const { text, truncated } = await readBodyWithCap(response, policy.maxBytes);

    if (options.rawBody) {
      return {
        ok: response.ok,
        url: checked.url.toString(),
        status: response.status,
        contentType,
        content: text,
        truncated,
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    }

    const rendered = renderBody(text, contentType, checked.url.toString());
    const content = truncateUtf8(rendered.content, policy.maxBytes);

    return {
      ok: response.ok,
      url: checked.url.toString(),
      status: response.status,
      contentType,
      title: rendered.title,
      content,
      truncated: truncated || content.length < rendered.content.length,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  }

  return { ok: false, url: currentUrl, error: `重定向次数超过上限（${maxRedirects}）` };
}

/**
 * 边读边卡上限。
 *
 * 超过上限时截断并取消剩余流，而不是把整个响应体读进内存再判大小。
 */
async function readBodyWithCap(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return { text, truncated: false };
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    if (total + value.byteLength >= maxBytes) {
      chunks.push(Buffer.from(value.subarray(0, maxBytes - total)));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }

    chunks.push(Buffer.from(value));
    total += value.byteLength;
  }

  // 统一按 UTF-8 解码：Content-Type 里的 charset 在真实网页上错标率很高，
  // 与其信任它，不如让乱码在少数页面上可见，也好过按错误编码整体读花。
  return { text: new TextDecoder('utf-8').decode(Buffer.concat(chunks)), truncated };
}

function renderBody(
  text: string,
  contentType: string,
  baseUrl: string,
): { content: string; title?: string } {
  const type = contentType.toLowerCase();

  if (type.includes('json')) {
    return { content: '```json\n' + text.trim() + '\n```' };
  }

  if (type.includes('html') || /^\s*<(!doctype|html)/i.test(text)) {
    const title = extractTitle(text);
    const markdown = htmlToMarkdown(text, { baseUrl });
    return { content: markdown, title };
  }

  return { content: text.trim() };
}

function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return undefined;
  const title = decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
  return title || undefined;
}

const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/?q=';

export interface WebToolHostConfig {
  /** 联网总开关。关闭时返回 undefined，工具会报「未启用」 */
  enabled: boolean;
  /** 用户显式放行的内网主机 */
  allowedPrivateHosts?: string[];
  timeoutMs?: number;
}

/**
 * 按用户配置构造注入给 Agent 的联网能力。
 *
 * 白名单在这里落进 policy —— 工具层拿到的每一个请求都会带上它，
 * 包括重定向的后续跳转。
 */
export function createWebToolHost(config: WebToolHostConfig) {
  if (!config.enabled) return undefined;

  const policy: UrlPolicy = {
    ...DEFAULT_URL_POLICY,
    allowedPrivateHosts: config.allowedPrivateHosts ?? [],
  };

  const options: WebFetchOptions = { policy, timeoutMs: config.timeoutMs };

  return {
    fetchPage: (url: string) => fetchWebPage(url, options),
    search: (query: string, limit?: number) =>
      searchWeb(query, limit ?? 8, options).then((result) => ({
        ok: result.ok,
        hits: result.hits,
        error: result.error,
      })),
  };
}

export interface WebSearchResult {
  ok: boolean;
  hits: WebSearchHit[];
  error?: string;
}

/**
 * 联网搜索。
 *
 * 走 DuckDuckGo 的 html 端点（无需 API key），抓原始 HTML 交给解析器 ——
 * 必须先 `rawBody`，否则 HTML 已经被转成 Markdown，class 名丢光就解析不出来了。
 */
export async function searchWeb(
  query: string,
  limit = 8,
  options: WebFetchOptions = {},
): Promise<WebSearchResult> {
  const trimmed = (query ?? '').trim();
  if (!trimmed) return { ok: false, hits: [], error: '查询为空' };

  const page = await fetchWebPage(`${SEARCH_ENDPOINT}${encodeURIComponent(trimmed)}`, {
    ...options,
    rawBody: true,
  });

  if (!page.ok) return { ok: false, hits: [], error: page.error ?? '搜索请求失败' };

  const hits = parseDuckDuckGoHtml(page.content ?? '', limit);
  if (hits.length === 0) {
    // 解析不到不代表没结果，很可能是搜索源改版了。明确说出来，
    // 让 Agent 回落到「请用户直接给 URL」，而不是假装搜过了。
    return { ok: false, hits: [], error: '未解析到搜索结果（搜索源可能已改版）' };
  }

  return { ok: true, hits };
}
