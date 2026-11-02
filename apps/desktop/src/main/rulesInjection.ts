/**
 * 目录级规则注入 Agent prompt 的组装。
 *
 * 三档的由来：规则文件可能非常多（一个团队仓库几十上百条很正常），
 * 而**全部塞进每次对话**的代价是实打实的 —— 每条几百字，二三十条就把上下文吃掉一截，
 * 而且其中绝大多数与本次改动无关。所以按适用范围分流：
 *
 * - `alwaysApply`：常驻。这类规则的语义就是「任何对话都适用」。
 * - 带 `globs` 且命中了本次涉及的文件：注入全文。命中的判据是「当前打开的文件」——
 *   主进程拿不到真正的焦点文件，把所有打开的文件都算作上下文，宁可多注入一条，
 *   也不要让规则时有时无（那种不稳定比多花点 token 难排查得多）。
 * - 既无 `globs` 也非 `alwaysApply`：**只列目录，不注入正文**。
 *   给模型一份「有什么规则、大概讲什么、文件在哪」的索引，它需要时自己用 read_file 取。
 *   这一档正是 Cursor 所说的「按需引入」，代价从「每次对话都付」变成「用到才付」。
 */

import { selectRulesForContext, type RuleMeta } from '@deepseek-ide/tools';

export interface RuleForInjection {
  relPath: string;
  meta: RuleMeta;
  body: string;
}

export interface RuleInjectionContext {
  activePath?: string | null;
  changedPaths?: string[];
}

/** 规则在 prompt 里的标题头。空字符串表示没有任何可注入的内容。 */
export function formatRulesInjection(
  rules: readonly RuleForInjection[],
  context: RuleInjectionContext,
): string {
  if (rules.length === 0) return '';

  const { always, matched, deferred } = selectRulesForContext(rules as RuleForInjection[], context);
  const sections: string[] = [];

  const injectable = [...always, ...matched];
  if (injectable.length > 0) {
    sections.push(
      `【目录级规则 (${injectable.length} 条)】\n` +
        injectable.map((rule) => `--- ${rule.relPath} ---\n${rule.body}`).join('\n\n'),
    );
  }

  if (deferred.length > 0) {
    // 只给索引。描述缺失时退回 relPath，至少让模型知道有这么个东西存在。
    const listed = deferred
      .map(
        (rule) => `- ${rule.relPath}${rule.meta.description ? `：${rule.meta.description}` : ''}`,
      )
      .join('\n');
    sections.push(
      `【可按需查阅的规则 (${deferred.length} 条)】\n` +
        `这些规则与当前文件没有直接关联，因此没有展开。当你认为其中某条与当前任务有关时，` +
        `用 read_file 读取它再遵循：\n${listed}`,
    );
  }

  return sections.join('\n\n');
}
