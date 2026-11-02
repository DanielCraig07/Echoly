/**
 * 目录化规则的收集。
 *
 * `rulesService` 负责的是工作区根目录下的单文件规则（`.echolyrules` / `.cursorrules`），
 * 全项目共用一份。这里补上 Cursor 那套目录化规则：`.echoly/rules/*.md`，并且**从工作区根
 * 逐级向下收集到目标文件所在目录**，子目录规则排在后面 —— 排序即优先级，越靠后的越具体。
 *
 * 同时识别 `.cursor/rules`，让从 Cursor 迁移过来的项目不用改名就能被读到。
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseRuleFile, type RuleMeta } from '@deepseek-ide/tools';

export interface DirectoryRule {
  /** 相对工作区根的路径，例如 `.echoly/rules/api.md` */
  relPath: string;
  meta: RuleMeta;
  body: string;
}

const RULE_DIRS = ['.echoly/rules', '.cursor/rules'];
const RULE_FILE_PATTERN = /\.(md|mdc)$/i;
/** 保护上限：避免一个装满规则文件的仓库把每次对话都拖慢 */
const MAX_RULE_FILES = 100;

export async function collectDirectoryRules(
  workspaceRoot: string,
  activePath?: string | null,
): Promise<DirectoryRule[]> {
  if (!workspaceRoot) return [];

  const root = path.resolve(workspaceRoot);
  const rules: DirectoryRule[] = [];

  for (const dir of ruleChain(root, activePath)) {
    for (const sub of RULE_DIRS) {
      const abs = path.join(dir, sub);
      let entries: string[];
      try {
        entries = await fs.promises.readdir(abs);
      } catch {
        continue; // 该层级没有规则目录是常态，不是错误
      }

      for (const name of entries.sort()) {
        if (!RULE_FILE_PATTERN.test(name)) continue;
        if (rules.length >= MAX_RULE_FILES) return rules;
        try {
          const content = await fs.promises.readFile(path.join(abs, name), 'utf8');
          const parsed = parseRuleFile(content);
          // 只有 frontmatter 没有正文的规则没有注入价值，跳过
          if (!parsed.body) continue;
          rules.push({
            relPath: toPosix(path.relative(root, path.join(abs, name))),
            meta: parsed.meta,
            body: parsed.body,
          });
        } catch {
          // 单个文件读失败（权限、编码、并发删除）不影响其余规则
        }
      }
    }
  }

  return rules;
}

/**
 * 工作区根到目标文件所在目录的层级链，根部在前。
 *
 * `activePath` 越出工作区时只返回根 —— 路径来自渲染层，不能默认它一定合法。
 */
function ruleChain(root: string, activePath?: string | null): string[] {
  if (!activePath) return [root];

  const abs = path.resolve(root, activePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return [root];

  const chain: string[] = [];
  let current = path.dirname(abs);
  while (current !== root && current.startsWith(root + path.sep)) {
    chain.unshift(current);
    current = path.dirname(current);
  }

  return [root, ...chain];
}

function toPosix(input: string): string {
  return input.split(path.sep).join('/');
}
