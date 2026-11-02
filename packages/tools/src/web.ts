/**
 * 联网工具的纯逻辑层。
 *
 * 这里刻意只放**不碰网络**的部分：URL 安全校验与 HTML→Markdown 转换。
 * 真正的 HTTP 抓取放在主进程（`apps/desktop/src/main/webService.ts`），
 * 于是这一层可以脱离 Electron 与网络被单测完全覆盖 —— 而抓取层里最容易出错、
 * 最难测的恰恰是「哪些 URL 不许访问」和「抓回来的 HTML 怎么变成模型能读的正文」。
 */

/** 抓取策略。默认禁止访问私有网段，避免 Agent 被诱导去打内网接口。 */
export interface UrlPolicy {
  /** 允许的最大响应体字节数，超出即截断 */
  maxBytes: number;
  /** 是否允许私有 / 回环 / 链路本地地址。默认 false（SSRF 防护） */
  allowPrivateHosts?: boolean;
  /**
   * 内网白名单：显式放行的私有主机（域名或 IP）。
   *
   * 只对**私有地址**生效 —— 公网地址本来就不需要白名单。命中规则是
   * 「主机名相等，或它是白名单条目的子域」，所以填 `corp.local` 就能覆盖
   * `wiki.corp.local`，但不会误放行 `evilcorp.local`（后缀必须是 `.corp.local`）。
   */
  allowedPrivateHosts?: string[];
}

export const DEFAULT_URL_POLICY: UrlPolicy = { maxBytes: 2_000_000 };

export type UrlCheckResult = { ok: true; url: URL } | { ok: false; reason: string };

const PRIVATE_V4_PATTERNS: RegExp[] = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
];

/** 内网惯用后缀。`.local` 是 mDNS 保留的，其余是企业内网常见约定。 */
const INTERNAL_TLDS = ['.local', '.internal', '.lan', '.intranet', '.home.arpa', '.corp'];

/** 判断主机名是否指向私有 / 回环 / 链路本地地址。 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // 单标签主机名（`http://wiki/`）走的是公司 DNS 或 mDNS，一律按内网处理
  if (!host.includes('.')) return true;
  // 常见内网 TLD：.local 是 mDNS 保留后缀，其余是企业内网的惯用后缀
  if (INTERNAL_TLDS.some((tld) => host.endsWith(tld))) return true;
  if (host === '::1' || host === '::') return true;
  // fc00::/7（唯一本地地址）与 fe80::/10（链路本地）
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
  if (PRIVATE_V4_PATTERNS.some((re) => re.test(host))) return true;
  return false;
}

/**
 * 主机名是否命中白名单。
 *
 * 归一化时去掉 IPv6 的方括号、统一小写，并清掉条目里可能被顺手粘进来的
 * 协议前缀或路径 —— 用户从浏览器地址栏复制 `https://wiki.corp.local/docs`
 * 进来是很常见的操作，直接拿整串去比会永远匹配不上。
 */
export function isHostAllowedByList(hostname: string, allowList?: string[]): boolean {
  if (!allowList || allowList.length === 0) return false;
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return allowList.some((entry) => {
    const normalized = normalizeAllowEntry(entry);
    if (!normalized) return false;
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

function normalizeAllowEntry(entry: string): string {
  let value = (entry ?? '').trim().toLowerCase();
  if (!value) return '';
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // 去掉协议前缀
  value = value.split('/')[0].split('?')[0];

  // IPv6 要单独走：按冒号切会把 `fd00::1` 切成 `fd00`
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) return bracketed[1];
  if (value.includes('::')) return value;

  return value.split(':')[0]; // 去掉普通主机名后面的端口
}

/**
 * 校验待抓取的 URL。
 *
 * 只放行 http / https —— `file:`、`data:`、`javascript:` 这些协议在
 * 「把 URL 交给抓取器」的语境下都是越权读取本地或注入的入口。
 */
export function validateFetchUrl(
  raw: string,
  policy: UrlPolicy = DEFAULT_URL_POLICY,
): UrlCheckResult {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'URL 为空' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: `无法解析的 URL：${trimmed}` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `仅支持 http/https，收到 ${url.protocol}` };
  }

  if (!url.hostname) return { ok: false, reason: 'URL 缺少主机名' };

  if (!policy.allowPrivateHosts && isPrivateHostname(url.hostname)) {
    if (!isHostAllowedByList(url.hostname, policy.allowedPrivateHosts)) {
      return { ok: false, reason: `默认禁止访问私有或回环地址：${url.hostname}` };
    }
  }

  return { ok: true, url };
}

/**
 * 按 UTF-8 字节数截断，且不切断多字节字符。
 *
 * 响应体上限是按字节卡的，但直接对字符串 slice 会切出半个汉字 ——
 * 那半个字符送进模型就是乱码，所以退到最后一个完整码点边界。
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  // 避免切在代理对中间
  let cut = lo;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    const key = body.toLowerCase();
    if (key in ENTITIES) return ENTITIES[key];
    if (key.startsWith('#x')) {
      const code = parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (key.startsWith('#')) {
      const code = parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

export interface HtmlToMarkdownOptions {
  /** 用于把相对链接补成绝对链接；缺省时保留原始 href */
  baseUrl?: string;
}

/**
 * 把 HTML 正文转成 Markdown。
 *
 * 目标不是「还原网页」，而是「让模型读到正文」：第一刀砍掉
 * script / style / 导航 / 页脚这类纯噪声，第二刀把正文结构映射成 Markdown，
 * 最后压掉多余空行 —— 模型对 token 的敏感度远高于对排版的。
 */
export function htmlToMarkdown(html: string, options: HtmlToMarkdownOptions = {}): string {
  let text = html ?? '';

  // 1. 整块丢弃：这些内容要么是代码噪声，要么是导航噪声
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(
    /<(script|style|noscript|template|svg|canvas|iframe|head|nav|footer|form)\b[^>]*>[\s\S]*?<\/\1>/gi,
    '',
  );

  // 2. 代码块要在其它标签处理之前先摘出来，否则 <pre> 里的尖括号会被后续规则吃掉
  const codeBlocks: string[] = [];
  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    const cleaned = decodeEntities(
      inner
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/^\n+|\n+$/g, ''),
    );
    codeBlocks.push('```\n' + cleaned + '\n```');
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });

  // 3. 行内与块级结构
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_m, level: string, inner: string) =>
      `\n\n${'#'.repeat(Number(level))} ${stripTags(inner)}\n\n`,
  );
  text = text.replace(
    /<li\b[^>]*>([\s\S]*?)<\/li>/gi,
    (_m, inner: string) => `\n- ${stripTags(inner).trim()}`,
  );
  text = text.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
    const body = stripTags(inner).trim();
    return body ? `**${body}**` : '';
  });
  text = text.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
    const body = stripTags(inner).trim();
    return body ? `*${body}*` : '';
  });
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => {
    const body = stripTags(inner).trim();
    return body ? `\`${body}\`` : '';
  });
  text = text.replace(
    /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, inner: string) => {
      const label = stripTags(inner).trim() || href;
      const resolved = resolveHref(href, options.baseUrl);
      return resolved ? `[${label}](${resolved})` : label;
    },
  );

  // 4. 剩下的是块级分隔与纯文本
  text = text.replace(/<\/(p|div|section|article|ul|ol|table|tr|blockquote|dd|dt)>/gi, '\n\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);

  // 5. 压空行：正文里连续 3 个以上换行对模型没有信息量
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // 6. 放回代码块
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx: string) => codeBlocks[Number(idx)] ?? '');

  return text;
}

function stripTags(input: string): string {
  return decodeEntities(input.replace(/<[^>]+>/g, ''));
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet?: string;
}

/**
 * 解析 DuckDuckGo 的 HTML 端点结果。
 *
 * 为什么不引搜索 API：内网网关没有搜索接口，而 DDG 的 html 端点不需要 key。
 * 代价是**结构性依赖** —— 这是解析它家的 DOM class，对方改版就会失效。
 * 所以解析失败时返回空数组而不是抛错，调用方据此回落到「让用户直接给 URL」，
 * 而不是把异常抛进 Agent 的推理链里。
 *
 * 两个必须处理的现实细节：结果链接常被包成 `//duckduckgo.com/l/?uddg=<encoded>`，
 * 要还原出真正的目标地址；标题与摘要里带标签和实体，要清洗。
 */
export function parseDuckDuckGoHtml(html: string, limit = 10): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  const seen = new Set<string>();
  const anchor = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html)) !== null) {
    if (hits.length >= limit) break;
    const url = unwrapDuckDuckGoRedirect(match[1]);
    if (!url || seen.has(url)) continue;
    const title = stripTags(match[2]).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    seen.add(url);
    hits.push({ title, url });
  }

  // 摘要单独扫一遍：它和标题不在同一个锚点里，按出现顺序对齐
  const snippetPattern = /<a\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  while ((match = snippetPattern.exec(html)) !== null) {
    snippets.push(stripTags(match[1]).replace(/\s+/g, ' ').trim());
  }
  snippets.forEach((snippet, index) => {
    if (index < hits.length && snippet) hits[index].snippet = snippet;
  });

  return hits;
}

/** 把 `//duckduckgo.com/l/?uddg=<encoded>` 还原成真实目标地址。 */
function unwrapDuckDuckGoRedirect(href: string): string {
  let raw = (href ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('//')) raw = `https:${raw}`;

  try {
    const url = new URL(raw);
    const target = url.searchParams.get('uddg');
    if (target) return target;
    return url.toString();
  } catch {
    return raw;
  }
}

function resolveHref(href: string, baseUrl?: string): string {
  const raw = (href ?? '').trim();
  if (!raw) return '';
  if (/^(https?:|mailto:|#)/i.test(raw)) return raw;
  if (!baseUrl) return raw;
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return raw;
  }
}
