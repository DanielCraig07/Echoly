/**
 * 输入框里 `@` 与 `/` 触发符的解析。
 *
 * 单独成模块而不是内联在 ChatPanel 的 onChange 里，是因为**它必须和别处的规则完全一致**：
 *
 * - `/` 的分词规则要和 `normalizeCommandName()`（skills 包）一致，否则会出现
 *   「下拉里看得见、敲进去匹配不到」——用户完全无从判断是哪一步不对。
 * - 提取命令参数时要知道 `/name` 的边界，这个边界同时被「选中后替换」用到。
 *
 * 放在渲染进程（而不是 skills 包）是因为它要在每次按键时跑；
 * skills 包依赖 node:fs，拖进 renderer 会把 Node 内置模块打进 bundle。
 */

export interface SlashTrigger {
  /** 触发符 `/` 的下标 */
  start: number;
  /** 已输入的命令名片段（不含 `/`） */
  query: string;
}

export interface MentionTrigger {
  /** 触发符 `@` 的下标 */
  start: number;
  /** 已输入的查询片段（不含 `@`） */
  query: string;
}

/**
 * 匹配行首的 `/命令名`。
 *
 * 严格限制在**行首**（或整个输入的开头）：斜杠在正文里到处都是（`src/a.ts`、日期、除法），
 * 允许它出现在任意位置会让每写一个路径都弹一次下拉。
 *
 * 命令名字符集限定为字母、数字、下划线、连字符 —— 与 `normalizeCommandName()` 的产出
 * 对齐。多出的字符（比如空格）意味着用户已经进入「写参数」阶段，此时应当收起下拉。
 */
export function matchSlashTrigger(textBeforeCursor: string): SlashTrigger | null {
  const m = /(?:^|\n)\/([A-Za-z0-9_-]*)$/.exec(textBeforeCursor);
  if (!m) return null;
  return { start: textBeforeCursor.length - m[1].length - 1, query: m[1] };
}

/**
 * 匹配 `@查询`。
 *
 * 与 `/` 不同，`@` 允许出现在行内任意位置（`看看 @authService.ts 这个文件`），
 * 但要求前面是空白或行首 —— 否则邮箱地址 `a@b.com` 会弹出文件列表。
 */
export function matchMentionTrigger(textBeforeCursor: string): MentionTrigger | null {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(textBeforeCursor);
  if (!m) return null;
  return { start: textBeforeCursor.length - m[1].length - 1, query: m[1] };
}

export interface CommandExpansion {
  /** 替换后的完整输入 */
  next: string;
  /** 替换后光标应当落在的位置 */
  cursor: number;
}

/**
 * 把 `/name args` 展开成模板正文。
 *
 * 参数取的是 `/name` 所在行的**剩余文本**，而不是整段输入。用户常常先写一句需求，
 * 再另起一行敲 `/review src/a.ts`；按整段取会把前面那句也当成参数塞进模板。
 */
export function expandCommandSelection(options: {
  input: string;
  cursorIndex: number;
  /** 展开后的正文（由 shared 的 renderCommand 产出） */
  expanded: string;
}): CommandExpansion {
  const { input, cursorIndex, expanded } = options;
  const textBefore = input.slice(0, cursorIndex);
  const textAfter = input.slice(cursorIndex);
  const slashIdx = textBefore.lastIndexOf('/');
  if (slashIdx < 0) return { next: input, cursor: cursorIndex };

  const lineStart = textBefore.lastIndexOf('\n', slashIdx - 1) + 1;
  const prefix = textBefore.slice(0, lineStart);
  const newlineAt = textAfter.indexOf('\n');
  // 换行之后的既有内容原样保留（用户可能是插在一段已写好的文字中间）
  const rest = newlineAt < 0 ? '' : textAfter.slice(newlineAt);
  // 展开后留一个空格：正文是给人继续编辑的，光标落在末尾时紧接着打字才自然
  const next = `${prefix}${expanded}${rest || ' '}`;
  return { next, cursor: prefix.length + expanded.length + 1 };
}
