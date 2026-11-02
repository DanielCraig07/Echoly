/**
 * 行内补全的 prompt 构造与响应解析。
 *
 * 为什么要把响应**结构化**：原来只让模型「输出要补全的代码」，于是同一件事有三处要靠猜 ——
 * 补全从哪开始、到哪结束、有没有把前缀或后缀里的代码抄一遍。模型一旦顺手把光标前的
 * 那半行也回一遍，插入后就变成重复代码；而这类错误在界面上表现为「补全有点怪」，
 * 很难归因。改成让模型显式回「要插入的那一段」，判定就从「猜」变成「读字段」。
 *
 * 但**结构化不能成为新的失败点**：模型偶尔会无视 JSON 要求、或在 JSON 外面裹一层
 * markdown 围栏、或先说一句「好的」。所以解析是逐级降级的（JSON → 抠出 JSON → 裸文本），
 * 最后一级与改造前的行为一致 —— 最差也只是回到老样子，不会比原来更糟。
 */

export interface CompletionPromptInput {
  prefix: string;
  suffix: string;
  language?: string;
  /** 最近的编辑，从旧到新。用来传达「我正在做什么」，而不只是「我停在哪里」。 */
  recentEdits?: readonly { inserted: string; deleted: string; path?: string }[];
}

/** 送进模型的前后缀长度上限。与调用方原来的取值一致。 */
const MAX_PREFIX_CHARS = 2000;
const MAX_SUFFIX_CHARS = 1000;

/** 单侧编辑文本进提示词的长度上限，比渲染层记录的上限更紧。 */
const MAX_EDIT_SIDE_CHARS = 160;

/** 把一段编辑文本压成单行短句：上下文要的是意图，不是缩进细节。 */
function condenseEditSide(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_EDIT_SIDE_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_EDIT_SIDE_CHARS)}…`;
}

/**
 * 把最近编辑渲染成提示词里的一小段。
 *
 * 用「删了什么/加了什么」的 diff 形式而不是整段代码：整段代码会把当前切片淹掉，
 * 而模型真正需要的是「他刚把 X 改成了 Y」这个动量。
 */
export function formatRecentEdits(
  edits: readonly { inserted: string; deleted: string; path?: string }[] | undefined,
): string {
  if (!edits || edits.length === 0) return '';
  const lines = edits.map((edit, index) => {
    const removed = condenseEditSide(edit.deleted);
    const added = condenseEditSide(edit.inserted);
    const parts: string[] = [];
    if (removed) parts.push(`删除「${removed}」`);
    if (added) parts.push(`插入「${added}」`);
    // 跨文件改动必须标出来源文件：不标的话，模型会以为这处改动就发生在光标所在的
    // 文件里，进而照抄另一个文件的上下文 —— 那比不带这条上下文更糟。
    const where = edit.path ? `[${edit.path}] ` : '';
    return `${index + 1}. ${where}${parts.join('，')}`;
  });
  return `\n用户最近的编辑（从旧到新，用来判断当前意图）：\n${lines.join('\n')}\n`;
}

export function buildCompletionPrompt(input: CompletionPromptInput): string {
  const language = input.language?.trim();
  return `你是一个极速代码补全引擎。根据光标前后的代码，预测光标处应当插入的代码。

只返回一个 JSON 对象，不要输出任何其他内容（不要 Markdown 代码围栏、不要解释、不要前后缀）：
{"insertText": "要插入到光标处的代码"}

规则：
- insertText 只包含**光标处需要新增**的代码。不要重复前缀里已经有的内容，也不要重复后缀里已经有的内容。
- 上下文足够明确时（例如刚写完一个 if 的条件、正在补一个函数体、写着一组并列的字段），
  可以给出多行补全；不确定时给最短的合理补全。多行时保持与前缀一致的缩进。
- 无需补全时返回 {"insertText": ""}。
- JSON 字符串里的换行写成 \\n，双引号写成 \\"。
${language ? `- 当前语言：${language}。\n` : ''}
${formatRecentEdits(input.recentEdits)}
前缀代码（光标之前）：
${input.prefix.slice(-MAX_PREFIX_CHARS)}

<CURSOR>

后缀代码（光标之后）：
${input.suffix.slice(0, MAX_SUFFIX_CHARS)}
`;
}

export interface ParsedCompletion {
  /** 应当插入到光标处的代码。已做首尾空白裁剪。 */
  insertText: string;
  /** 解析走的哪条路，便于观察模型是否遵守了结构化要求 */
  source: 'json' | 'embedded' | 'raw';
}

/** 剔除模型偶尔仍会带上的 markdown 围栏。 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n?/, '')
    .replace(/\r?\n?```\s*$/, '')
    .trim();
}

/**
 * 从一段文本里抠出第一个完整的 JSON 对象。
 *
 * 逐字符扫描而不是用正则：JSON 里的字符串可以包含 `{` `}` 和转义引号，
 * 正则要么漏要么错，而这类文本恰恰是模型最容易生成的。
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 从解析出的对象里取插入文本。接受 `insertText`，兼容旧字段名 `completion`。 */
function readInsertText(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['insertText', 'completion']) {
    const candidate = record[key];
    if (typeof candidate === 'string') return candidate;
  }
  return null;
}

function tryJson(text: string): ParsedCompletion | null {
  try {
    const insertText = readInsertText(JSON.parse(text));
    return insertText === null ? null : { insertText: insertText.trim(), source: 'json' };
  } catch {
    return null;
  }
}

/**
 * 解析补全响应。任何情况下都不抛错 —— 解析失败只意味着「这次没有建议」。
 *
 * 为空（`insertText: ""`）时返回 `insertText: ''` 而不是 `null`：
 * 「模型明确表示无需补全」与「响应根本没法解析」是两件事，前者是正常结论。
 */
export function parseCompletionResponse(raw: string): ParsedCompletion | null {
  if (typeof raw !== 'string') return null;
  const withoutFences = stripCodeFences(raw);
  if (!withoutFences) return null;

  // 1. 整段就是 JSON（提示词的正常预期）
  const direct = tryJson(withoutFences);
  if (direct) return direct;

  // 2. JSON 裹在解释文字里，把第一个对象抠出来
  const candidate = extractFirstJsonObject(withoutFences);
  if (candidate) {
    const embedded = tryJson(candidate);
    if (embedded) return { ...embedded, source: 'embedded' };
  }

  // 3. 回退：模型完全没按 JSON 来，就把它当成裸的插入文本。
  //    这一路与改造前的行为一致，所以最差也不会比原来更糟。
  return { insertText: withoutFences.trim(), source: 'raw' };
}
