/**
 * 「下一步编辑预测」的提示词与响应解析。
 *
 * 与行内补全的区别：补全是在**光标处**往下写，而这里要预测用户**接下来会去哪儿改**。
 * 典型场景是改完一处忘了改对应的另一处（改了参数名没改调用点、加了字段没加映射）。
 * 所以答案必须是一个可以**定位**的东西，而不是一段文本 —— 否则无从知道该改哪里。
 *
 * 用「行区间 + 新文本」而不是「字符偏移 + 新文本」：行号是模型最稳的输出形态
 * （字符偏移需要它精确计数，实测很容易差几个字符），而行区间也正好够表达
 * 「把这个函数的返回值改一下」这类预测。代价是无法预测行内的小改，
 * 但那种粒度本来就是补全该管的事。
 */

export interface NextEditPromptInput {
  /** 带行号的上下文，每行形如 `12| const a = 1;` */
  context: string;
  language?: string;
  /** 上下文覆盖的文件行号范围，用于校验模型给的行号是否落在里面 */
  firstLine: number;
  lastLine: number;
  recentEdits?: readonly { inserted: string; deleted: string; path?: string }[];
}

export interface PredictedEdit {
  /** 文件内的起始行号（1 起） */
  startLine: number;
  /** 文件内的结束行号（1 起，含） */
  endLine: number;
  /** 用来替换该区间的新文本 */
  newText: string;
}

const MAX_EDIT_SIDE_CHARS = 160;

function condense(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= MAX_EDIT_SIDE_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_EDIT_SIDE_CHARS)}…`;
}

function formatRecentEdits(
  edits: readonly { inserted: string; deleted: string; path?: string }[],
): string {
  if (edits.length === 0) return '';
  const lines = edits.map((edit) => {
    const removed = condense(edit.deleted);
    const added = condense(edit.inserted);
    const parts: string[] = [];
    if (removed) parts.push(`改前「${removed}」`);
    if (added) parts.push(`改后「${added}」`);
    // 标出来源文件：跨文件的改动是「该去改哪儿」最有力的线索（在 A 改了接口，
    // 下一步往往就是 B 里的调用点），但也必须说清它不在当前文件里。
    const where = edit.path ? `[${edit.path}] ` : '';
    return `- ${where}${parts.join('，')}`;
  });
  return `\n用户刚刚做过的修改（从旧到新）：\n${lines.join('\n')}\n`;
}

export function buildNextEditPrompt(input: NextEditPromptInput): string {
  const language = input.language?.trim();
  return `你是一个代码编辑助手。用户刚改完一处代码，请预测他接下来**最可能去改的另一处**，并给出修改内容。

只返回一个 JSON 对象，不要输出任何其他内容（不要 Markdown 代码围栏、不要解释）：
{"edit": {"startLine": 起始行号, "endLine": 结束行号, "newText": "替换这段区间的新代码"}}

规则：
- 行号必须是**文件里的真实行号**（下面每一行开头的数字），且落在 ${input.firstLine} 到 ${input.lastLine} 之间。
- endLine 含首尾；只改一行时 startLine 与 endLine 相同。
- newText 里保留原本正确的缩进。
- 只在**确有把握**时给出预测。没有值得预测的修改时返回 {"edit": null}。
- 不要预测用户光标附近的同一处修改（他正在那里改），要找**另一处**相关代码。
${language ? `- 当前语言：${language}。\n` : ''}${formatRecentEdits(input.recentEdits ?? [])}
文件内容（行号 | 代码）：
${input.context}
`;
}

/**
 * 解析预测结果。
 *
 * 这里的校验比补全那层严得多：补全解析错了最多是「补得不对」，用户一眼能看出来；
 * 而预测错了会**改到别的行**——那是最难察觉、也最伤信任的一类错误。
 * 所以行号越界、区间倒置、空文本一律判为无效，宁可什么都不显示。
 */
export function parseNextEditResponse(
  raw: string,
  bounds: { firstLine: number; lastLine: number },
): PredictedEdit | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  const candidate = extractJsonObject(text);
  if (!candidate) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const edit = (parsed as { edit?: unknown }).edit;
  if (edit === null || edit === undefined) return null; // 明确的「没有预测」
  if (typeof edit !== 'object') return null;

  const record = edit as Record<string, unknown>;
  const startLine = toLineNumber(record.startLine);
  const endLine = toLineNumber(record.endLine);
  const newText = typeof record.newText === 'string' ? record.newText : null;

  if (startLine === null || endLine === null || newText === null) return null;
  if (startLine > endLine) return null;
  if (!newText.trim()) return null;
  if (startLine < bounds.firstLine || endLine > bounds.lastLine) return null;

  return { startLine, endLine, newText };
}

function toLineNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  // 模型偶尔把行号写成字符串，这不是错误输出，收下就好
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** 从可能夹着解释文字或围栏的响应里抠出 JSON 对象。 */
function extractJsonObject(text: string): string | null {
  const stripped = text.startsWith('```')
    ? text
        .replace(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n?/, '')
        .replace(/\r?\n?```\s*$/, '')
        .trim()
    : text;

  const start = stripped.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return stripped.slice(start, i + 1);
    }
  }
  return null;
}
