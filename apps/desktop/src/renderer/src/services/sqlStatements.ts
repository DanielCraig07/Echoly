/**
 * SQL 语句切分工具（纯函数，无 Electron 依赖，便于 vitest 直接单测）
 *
 * 用途：SQL 控制台的「全部行执行 / 选中行执行 / 光标所在语句执行」都建立在按 `;` 切分的结果之上。
 * 切分只在最外层进行，需要正确跳过字符串字面量、标识符引用、行注释、块注释（含 PG 嵌套）与 dollar-quoted 块。
 */

export interface SqlStatementRange {
  /** 语句在原文中的起始下标（已去掉前导空白） */
  start: number;
  /** 语句在原文中的结束下标（不含 `;`，已去掉尾部空白） */
  end: number;
  /** 去掉首尾空白后的语句文本 */
  text: string;
}

/** 判断一段文本是否只有空白与注释（无实际可执行内容） */
function isEffectivelyEmpty(text: string): boolean {
  return stripComments(text).trim().length === 0;
}

/** 去掉注释后的文本（仅用于「是否为空」判断，不参与执行） */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '-' && next === '-') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '#') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (text[i] === '*' && text[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      out += ' ';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 按 `;` 切分 SQL 脚本。返回的每段都去掉了首尾空白，纯注释/空白的片段会被丢弃。
 * 末尾没有 `;` 但有内容的语句同样会被保留。
 */
export function splitSqlStatements(sql: string): SqlStatementRange[] {
  const ranges: SqlStatementRange[] = [];
  const n = sql.length;
  let i = 0;
  let segStart = 0;

  const push = (from: number, to: number) => {
    const raw = sql.slice(from, to);
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (!text) return;
    if (isEffectivelyEmpty(text)) return;
    ranges.push({ start: from + leading, end: from + leading + text.length, text });
  };

  while (i < n) {
    const c = sql[i];

    // 单引号字符串：'' 与 \' 都是转义
    if (c === "'") {
      i += 1;
      while (i < n) {
        if (sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    // 双引号（标准 SQL 标识符）反引号（MySQL 标识符）
    if (c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    // 行注释
    if ((c === '-' && sql[i + 1] === '-') || c === '#') {
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }

    // 块注释（PG 支持嵌套）
    if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      continue;
    }

    // PostgreSQL dollar-quoted 块：$tag$ ... $tag$
    if (c === '$') {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const closeIdx = sql.indexOf(tag, i + tag.length);
        i = closeIdx === -1 ? n : closeIdx + tag.length;
        continue;
      }
    }

    if (c === ';') {
      push(segStart, i);
      i += 1;
      segStart = i;
      continue;
    }

    i += 1;
  }

  push(segStart, n);
  return ranges;
}

/**
 * 取光标（或选区起点）所在的语句。光标恰好落在某条语句的 `;` 之后时归属下一条语句。
 */
export function statementAtOffset(sql: string, offset: number): SqlStatementRange | null {
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) return null;
  const clamped = Math.max(0, Math.min(offset, sql.length));

  for (const stmt of statements) {
    if (clamped >= stmt.start && clamped <= stmt.end) return stmt;
  }
  // 落在语句之间的空白/注释里：取其后第一条，没有则取最后一条
  for (const stmt of statements) {
    if (stmt.start > clamped) return stmt;
  }
  return statements[statements.length - 1];
}

/**
 * 决定「运行」按钮到底该执行什么：
 * 1. 有非空选区 → 只执行选中内容
 * 2. 否则 → 执行光标所在的那条语句
 * 3. 都没有 → 执行整篇
 */
export function resolveExecutableSql(
  sql: string,
  selection: { start: number; end: number; text?: string } | null,
  cursorOffset?: number,
): string {
  const selected = selection?.text ?? (selection ? sql.slice(selection.start, selection.end) : '');
  if (selected && selected.trim()) return selected.trim();

  const offset = cursorOffset ?? selection?.start ?? 0;
  const stmt = statementAtOffset(sql, offset);
  if (stmt) return stmt.text;

  return sql.trim();
}
