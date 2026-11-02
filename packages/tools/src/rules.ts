/**
 * 规则文件的解析与匹配（纯逻辑）。
 *
 * 现状 `main/rulesService.ts` 只读工作区根目录下的一个 `.echolyrules` 或
 * `.cursorrules`，全项目共用一份。这里补上 Cursor 那套目录化规则的最小实现：
 * `.echoly/rules/*.md` + frontmatter 里的 `globs` / `alwaysApply`，让规则可以
 * 按文件范围生效，而不是要么全开要么全关。
 *
 * frontmatter 只实现**够用的子集**：`key: value`、逗号分隔列表、方括号列表、
 * 以及 `- item` 形式的块级列表。不引 YAML 解析器是因为规则文件的实际写法高度
 * 收敛，而一个完整 YAML 实现会带来锚点、多行标量这类这里根本用不到的行为差异。
 */

import { globToRegExp } from './search.js';

export interface RuleMeta {
  description?: string;
  /** 生效范围。为空且 alwaysApply 为 false 时，规则只在 Agent 检索命中时注入 */
  globs: string[];
  alwaysApply: boolean;
}

export interface ParsedRule {
  meta: RuleMeta;
  body: string;
}

/** 解析规则文件：分离 frontmatter 与正文。没有 frontmatter 时按 alwaysApply 处理。 */
export function parseRuleFile(content: string): ParsedRule {
  const text = (content ?? '').replace(/^\uFEFF/, '');

  if (!/^---\r?\n/.test(text)) {
    return { meta: { globs: [], alwaysApply: true }, body: text.trim() };
  }

  const end = text.indexOf('\n---', 3);
  if (end === -1) {
    // frontmatter 没闭合：按「无 frontmatter」处理而不是丢掉整份文件，
    // 否则一个手误的分隔线会让规则静默失效，用户完全看不出原因。
    return { meta: { globs: [], alwaysApply: true }, body: text.trim() };
  }

  const metaText = text.slice(text.indexOf('\n') + 1, end);
  const body = text.slice(end + 4).trim();
  return { meta: parseMeta(metaText), body };
}

function parseMeta(metaText: string): RuleMeta {
  const meta: RuleMeta = { globs: [], alwaysApply: false };
  let pendingListKey: string | null = null;

  for (const rawLine of metaText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // 块级列表项：归属上一行的 key
    const listItem = /^-\s+(.*)$/.exec(line);
    if (listItem && pendingListKey) {
      if (pendingListKey === 'globs') meta.globs.push(stripQuotes(listItem[1]));
      continue;
    }

    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;

    const key = pair[1].toLowerCase();
    const value = pair[2].trim();
    pendingListKey = value === '' ? key : null;

    if (key === 'description') {
      meta.description = stripQuotes(value);
    } else if (key === 'alwaysapply') {
      meta.alwaysApply = /^(true|yes|1)$/i.test(value);
    } else if (key === 'globs' || key === 'glob') {
      meta.globs.push(...splitList(value));
    }
  }

  return meta;
}

function splitList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((item) => stripQuotes(item))
      .filter(Boolean);
  }
  return trimmed
    .split(',')
    .map((item) => stripQuotes(item))
    .filter(Boolean);
}

function stripQuotes(value: string): string {
  const trimmed = (value ?? '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 规则是否作用于某个文件。
 *
 * `alwaysApply` 优先于 globs —— 一个规则同时写了 `alwaysApply: true` 和 globs 时，
 * 意图是「无论如何都生效」，globs 只是给阅读者看的说明，不应该反而把它限制住。
 */
export function ruleAppliesTo(meta: RuleMeta, relativePath: string): boolean {
  if (meta.alwaysApply) return true;
  if (meta.globs.length === 0) return false;

  const target = normalizePath(relativePath);
  return meta.globs.some((pattern) => globToRegExp(normalizePath(pattern)).test(target));
}

function normalizePath(input: string): string {
  return (input ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * 按当前上下文筛选要注入的规则。
 *
 * 三档：alwaysApply 常驻；带 globs 的看当前打开文件与本次改动文件是否命中；
 * 其余（既没 globs 也没 alwaysApply）交给 Agent 检索命中时按需注入。
 */
export function selectRulesForContext<T extends { meta: RuleMeta }>(
  rules: T[],
  context: { activePath?: string | null; changedPaths?: string[] },
): { always: T[]; matched: T[]; deferred: T[] } {
  const files = [context.activePath, ...(context.changedPaths ?? [])].filter(
    (item): item is string => Boolean(item),
  );

  const always: T[] = [];
  const matched: T[] = [];
  const deferred: T[] = [];

  for (const rule of rules) {
    if (rule.meta.alwaysApply) {
      always.push(rule);
    } else if (rule.meta.globs.length === 0) {
      deferred.push(rule);
    } else if (files.some((file) => ruleAppliesTo(rule.meta, file))) {
      matched.push(rule);
    }
  }

  return { always, matched, deferred };
}
