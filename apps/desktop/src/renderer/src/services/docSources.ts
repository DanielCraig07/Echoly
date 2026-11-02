/**
 * 文档源在设置页里的文本形态。
 *
 * 用「一行一条、名称|地址」而不是一个结构化编辑器：这是既有模式
 * （内网白名单也是多行文本），改动小、不易出交互问题；而且用户通常是一次性
 * 粘贴几行站点。
 *
 * 解析要**宽容**：用户会写全角竖线、会漏掉名称、会在地址后面多打一个斜杠。
 * 但宽容的边界要明确 —— 地址必须能被 `URL` 解析出来，否则配了个错地址
 * 只会在检索时表现为「搜不到」，而那是很难归因的。
 */

export interface DocSourceEntry {
  name: string;
  url: string;
}

/** 一行一条：`名称|地址`；也接受只写地址（名称退回用主机名）。 */
export function parseDocSourcesText(text: string): DocSourceEntry[] {
  const out: DocSourceEntry[] = [];
  const seen = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // 普通竖线、全角竖线都当分隔符 —— 中文输入法下很容易打出后者
    const parts = line.split(/[|｜]/);
    const rawUrl = (parts.length > 1 ? parts.slice(1).join('|') : parts[0]).trim();
    const rawName = (parts.length > 1 ? parts[0] : '').trim();

    const normalized = normalizeSourceUrl(rawUrl);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);

    out.push({ name: rawName || hostOf(normalized), url: normalized });
  }

  return out;
}

export function formatDocSourcesText(sources: readonly DocSourceEntry[] | undefined): string {
  return (sources ?? []).map((source) => `${source.name}|${source.url}`).join('\n');
}

/**
 * 规范化地址。
 *
 * 补 `https://` 是必要的：用户写 `react.dev` 的直觉很自然，而 `new URL('react.dev')`
 * 会直接抛错。但**不**做「猜测真实地址」这类事 —— 那是替用户决定信任谁。
 */
export function normalizeSourceUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes('.')) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
