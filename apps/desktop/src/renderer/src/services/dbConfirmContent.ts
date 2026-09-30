/**
 * 数据库写操作确认弹窗的内容拼装。
 *
 * 弹窗正文是 Markdown（走 `MarkdownMessage` 渲染），因为要让每条 SQL 各自成为
 * 一个代码块 —— 这样每条都带自己的「复制」按钮，用户可以把其中一条单独拿去
 * 控制台执行或核对，而不是从一整段纯文本里手工圈选。
 *
 * 无 React 依赖，vitest 直接单测。
 */

/** 危险等级：决定弹窗配色与按钮文案 */
export type DbConfirmTone = 'normal' | 'danger';

export interface DbConfirmContentOptions {
  /** 一句话说明这次要做什么（支持行内 Markdown） */
  intro: string;
  /** 要执行的语句，每条单独一个代码块 */
  statements: readonly string[];
  /** 追加在语句后面的注意事项（例如「DDL 无法回滚」） */
  notes?: readonly string[];
  tone?: DbConfirmTone;
}

/**
 * 把一段用户数据（库名 / 表名 / 列名）安全地放进 Markdown 行内代码。
 *
 * 这些名字直接由用户和数据库决定，`*` / `_` / `` ` `` 都可能出现。
 * 不处理的话，一个叫 `a_b_c` 的表名会在弹窗里被渲染成 `a<em>b</em>c`，
 * 用户看到的名称就不是他要删的那个了 —— 在删除确认里这是要命的歧义。
 * 内容里含反引号时按 CommonMark 的规则用更长的围栏包住。
 */
export function mdCode(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(longest + 1);
  // 首尾是反引号或空格时需要各补一个空格，否则围栏与内容会粘在一起
  const pad = longest > 0 || text.startsWith(' ') || text.endsWith(' ') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * 把语句包进围栏代码块。
 *
 * 围栏长度要**比语句里出现的最长反引号串再长一个**：SQL 里完全可能出现
 * ``` 开头的注释或字符串内容，用固定的三个反引号会把代码块提前截断，
 * 后面的内容就漏成正文了（顺带说出用户看到的 SQL 也是错的）。
 */
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

export function buildSqlConfirmMarkdown({
  intro,
  statements,
  notes = [],
  tone = 'normal',
}: DbConfirmContentOptions): string {
  const parts: string[] = [];

  if (tone === 'danger') {
    parts.push(`> ⚠️ **危险操作**：${intro}`);
  } else {
    parts.push(intro);
  }

  // 语句为空时不要留下一句「共 0 条」的废话 —— 那种弹窗本身就是调用方的 bug
  if (statements.length > 0) {
    if (statements.length > 1) {
      parts.push(`共 **${statements.length}** 条语句，将按顺序执行：`);
    } else {
      parts.push('将执行以下语句：');
    }
    for (const sql of statements) {
      const fence = fenceFor(sql);
      parts.push(`${fence}sql\n${sql.replace(/\s+$/, '')}\n${fence}`);
    }
  }

  for (const note of notes) parts.push(`> ${note}`);

  return parts.join('\n\n');
}

/**
 * 「手输名称才能确认」的判定。
 *
 * 前后空白不算差异（用户从别处复制名称常带上一个空格，为此拦下只会让人恼火），
 * 但大小写**算**差异：MySQL 在部分平台上表名大小写敏感，认错一个大小写删掉的就是另一张表。
 */
export function isTypingConfirmed(expected: string, typed: string): boolean {
  return typed.trim() === expected.trim();
}

/** 确认按钮上该写什么（每种操作的动词不一样，别让用户去读正文猜） */
export function confirmLabelFor(action: 'execute' | 'drop' | 'truncate' | 'delete'): string {
  switch (action) {
    case 'drop':
      return '确认删除';
    case 'truncate':
      return '确认清空';
    case 'delete':
      return '确认删除';
    default:
      return '确认执行';
  }
}
