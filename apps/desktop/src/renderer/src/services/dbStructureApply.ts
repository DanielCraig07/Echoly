/**
 * 表结构「应用」时的执行与结果汇报。
 *
 * 无 React / electron 依赖，便于 vitest 直接单测。
 *
 * ## 为什么坚持逐条下发
 *
 * `buildAlterTableStatements` 按「改名 / 改类型 / 非空 / 默认值」逐项生成语句，
 * 同一列可能产出多条（MySQL 会生成若干条内容重复的 MODIFY，模块内部已去重；
 * PostgreSQL 则是三条各自独立的 `ALTER COLUMN`）。这里**逐条执行**而不是合并成一条：
 * DDL 不进事务，合并后任何一项失败会让整条回滚，用户看到的是「什么都没改」，
 * 而实际上别的列可能已经改成功了 —— 逐条执行 + 如实报告失败位置，
 * 与既有 `TableStructureModal` 的口径一致。
 */

import type { DbDriverType } from './dbIdentifiers';

export interface DbApplyOutcome {
  ok: boolean;
  /** 成功执行的语句条数 */
  applied: number;
  /** 出错的那一条（失败时才有） */
  failedSql?: string;
  error?: string;
}

/**
 * 逐条下发一批 DDL，遇到第一条失败即停。
 *
 * 返回 `applied`（成功条数）**而不是让调用方自己数**：「部分生效」是这里最需要如实告知的事实，
 * 任何一方的估算都可能与之不符。
 */
export async function applyStatements(
  statements: string[],
  run: (sql: string) => Promise<{ ok: boolean; error?: string }>,
): Promise<DbApplyOutcome> {
  let applied = 0;
  for (const sql of statements) {
    let res: { ok: boolean; error?: string };
    try {
      res = await run(sql);
    } catch (err: any) {
      // 通道本身抛错（连接断了等）与「语句执行失败」对用户是同一件事：这条没成功
      res = { ok: false, error: err?.message || String(err) };
    }
    if (!res.ok) {
      return { ok: false, applied, failedSql: sql, error: res.error || '未知原因' };
    }
    applied += 1;
  }
  return { ok: true, applied };
}

/**
 * 结果文案（用于 toast）。
 *
 * 三种情形分开说：全部成功 / 第一条就失败 / 中途失败（部分生效）。
 * 「部分生效」尤其不能混进「失败」—— 用户据此判断要不要手工收拾残局。
 */
export function describeApplyResult(
  driver: DbDriverType,
  table: string,
  outcome: DbApplyOutcome,
  total: number,
): { title: string; detail?: string; type: 'success' | 'error' } {
  if (outcome.ok) {
    return {
      title: `已更新表 ${table} 的结构`,
      detail: total > 1 ? `共执行 ${total} 条语句` : undefined,
      type: 'success',
    };
  }
  if (outcome.applied === 0) {
    return {
      title: `表 ${table} 结构变更失败`,
      detail: `${driver.toUpperCase()}：${outcome.error}`,
      type: 'error',
    };
  }
  return {
    title: `表 ${table} 结构变更部分生效`,
    detail: `已执行 ${outcome.applied} / ${total} 条，第 ${outcome.applied + 1} 条出错：${outcome.error}`,
    type: 'error',
  };
}
