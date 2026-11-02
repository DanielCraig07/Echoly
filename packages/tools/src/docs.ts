/**
 * 文档源的纯逻辑层：解析 `llms.txt` + 对条目打分排序。
 *
 * 为什么从 `llms.txt` 入手而不是自己爬站：爬站要处理 sitemap、分页、动态渲染、
 * robots、限流，每一条都能让索引半死不活；而 `llms.txt` 是文档站**主动提供**的
 * 结构化清单（标题 + 链接 + 一句话说明），一个文件就把「有哪些页、分别讲什么」说清了。
 * 没有这个文件的站点，本层直接返回空 —— 明确不可用，好过爬出一份七零八落的索引，
 * 那种「索引里有但搜不到」比没有更让人困惑。
 *
 * 这一层不碰网络，因此可以完全被测覆盖 —— 而它最容易错的地方（相对链接没解析、
 * 中文没切词、排序不稳定）恰恰都不会报错，只表现为「搜出来不对」。
 */

export interface DocEntry {
  title: string;
  /** 绝对地址；`llms.txt` 里写相对路径时会按来源站解析 */
  url: string;
  description?: string;
  /** 所属的 `##` 小节名，作为分类线索参与打分 */
  section?: string;
}

export interface ParsedDocIndex {
  /** 文件里的一级标题 */
  title?: string;
  /** 一级标题下的引言（`llms.txt` 约定的站点简介） */
  summary?: string;
  entries: DocEntry[];
}

/** 单个文档源的条目上限，防止一个巨型清单把内存与提示词都撑爆。 */
export const MAX_DOC_ENTRIES = 500;

/**
 * 解析 `llms.txt`。
 *
 * 只认形如 `- [标题](链接)` 的列表项（允许后面跟 `: 说明`）。
 * 其它内容一律当噪音跳过：这不是一个通用 Markdown 解析器，
 * 越宽容越容易把正文里的普通链接也当成文档条目。
 */
export function parseLlmsTxt(text: string, baseUrl: string): ParsedDocIndex {
  const result: ParsedDocIndex = { entries: [] };
  if (!text) return result;

  let currentSection: string | undefined;
  const summaryLines: string[] = [];
  let seenH1 = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const h1 = /^#\s+(.*)$/.exec(line);
    if (h1) {
      result.title = h1[1].trim();
      seenH1 = true;
      continue;
    }
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) {
      currentSection = h2[1].trim();
      continue;
    }

    const item = /^[-*]\s+\[([^\]]+)\]\(([^)]+)\)\s*(?::\s*(.*))?$/.exec(line);
    if (item) {
      if (result.entries.length >= MAX_DOC_ENTRIES) break;
      const entry: DocEntry = {
        title: item[1].trim(),
        url: resolveDocUrl(item[2].trim(), baseUrl),
      };
      const description = item[3]?.trim();
      if (description) entry.description = description;
      if (currentSection) entry.section = currentSection;
      result.entries.push(entry);
      continue;
    }

    // 一级标题之后、第一个二级标题之前的引用块是站点简介
    if (seenH1 && !currentSection && summaryLines.length < 5) {
      summaryLines.push(line.replace(/^>\s*/, ''));
    }
  }

  const summary = summaryLines.join(' ').trim();
  if (summary) result.summary = summary;
  return result;
}

function resolveDocUrl(url: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    // 基址本身不合法时保持原样：留着让人能看出问题出在配置上
    return url;
  }
}

/**
 * 查询切词。
 *
 * 中英分开处理：英文按非字母数字切，中文按 2 字滑窗 —— 中文没有空格，
 * 不滑窗的话一整句会被当成一个 token，任何查询都匹配不上。
 */
export function tokenizeDocQuery(text: string): string[] {
  if (!text) return [];
  const tokens: string[] = [];
  const lower = text.toLowerCase();

  for (const word of lower.match(/[a-z0-9_]+/g) ?? []) {
    if (word.length >= 2) tokens.push(word);
  }
  for (const run of lower.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    if (run.length <= 2) tokens.push(run);
    else for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
  }

  return tokens;
}

/** 字段权重。标题最重要 —— 用户搜的往往就是那篇文章的名字。 */
const WEIGHT_TITLE = 6;
const WEIGHT_SECTION = 2;
const WEIGHT_DESCRIPTION = 2;
const WEIGHT_URL = 1;

export function scoreDocEntry(entry: DocEntry, query: string, tokens: readonly string[]): number {
  const title = entry.title.toLowerCase();
  const needles = tokens.length > 0 ? tokens : tokenizeDocQuery(query);
  if (needles.length === 0) return 0;

  const normalizedQuery = query.trim().toLowerCase();
  let score = 0;
  // 整体命中给一次额外奖励：搜「getting started」时，
  // 标题正好就叫这个的条目应当压过只分别命中两个词的条目。
  if (normalizedQuery && title === normalizedQuery) score += WEIGHT_TITLE * 4;
  else if (normalizedQuery && title.includes(normalizedQuery)) score += WEIGHT_TITLE * 2;

  const section = entry.section?.toLowerCase() ?? '';
  const description = entry.description?.toLowerCase() ?? '';
  const url = entry.url.toLowerCase();
  let matched = 0;

  for (const token of new Set(needles)) {
    let hit = false;
    if (title.includes(token)) {
      score += WEIGHT_TITLE;
      hit = true;
    }
    if (section.includes(token)) {
      score += WEIGHT_SECTION;
      hit = true;
    }
    if (description.includes(token)) {
      score += WEIGHT_DESCRIPTION;
      hit = true;
    }
    if (url.includes(token)) {
      score += WEIGHT_URL;
      hit = true;
    }
    if (hit) matched += 1;
  }

  // 命中覆盖率：搜两个词、只命中一个的条目不该和两个都命中的并排
  const coverage = matched / new Set(needles).size;
  return score * (0.5 + 0.5 * coverage);
}

export interface DocHit {
  entry: DocEntry;
  score: number;
}

/**
 * 打分排序。分数为 0 的条目直接丢掉 —— 返回一堆「都不太相关」的结果，
 * 只会让 Agent 以为真的没有匹配，从而放弃本来可行的检索。
 */
export function searchDocEntries(entries: readonly DocEntry[], query: string, limit = 8): DocHit[] {
  const tokens = tokenizeDocQuery(query);
  if (tokens.length === 0) return [];

  const hits: DocHit[] = [];
  for (const entry of entries) {
    const score = scoreDocEntry(entry, query, tokens);
    if (score > 0) hits.push({ entry, score });
  }

  // 同分时按标题稳定排序，保证同一个查询每次返回同样的顺序
  return hits
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title))
    .slice(0, Math.max(0, limit));
}
