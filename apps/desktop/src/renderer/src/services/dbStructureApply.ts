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
import type { Translate } from '../i18n';

export interface DbApplyOutcome {
  ok: boolean;
  /** 成功执行的语句条数 */
  applied: number;
  /** 出错的那一条（失败时才有） */
  failedSql?: string;
  /**
   * 驱动报回来的原始错误文本。**可能为空** —— 通道没带原因时留空，
   * 不要在这里塞一句中文兜底：这个模块是纯逻辑（vitest 直接单测），
   * 兜底文案由渲染层用 `t('db.unknownReason')` 补。
   */
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
      return { ok: false, applied, failedSql: sql, error: res.error };
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
 *
 * `t` 必填：三条 title 与两条 detail 都会直接弹给用户，做成可选带中文兜底
 * 就等于把「英文环境显示中文」藏进类型系统看不见的地方。
 */
export function describeApplyResult(
  driver: DbDriverType,
  table: string,
  outcome: DbApplyOutcome,
  total: number,
  t: Translate,
): { title: string; detail?: string; type: 'success' | 'error' } {
  if (outcome.ok) {
    return {
      title: t('db.tableUpdated', { table }),
      detail: total > 1 ? t('db.applyStatementCount', { n: total }) : undefined,
      type: 'success',
    };
  }
  const reason = outcome.error || t('db.unknownReason');
  if (outcome.applied === 0) {
    return {
      title: t('db.structureChangeFailedFor', { table }),
      detail: t('db.applyDriverReason', { driver: driver.toUpperCase(), reason }),
      type: 'error',
    };
  }
  return {
    title: t('db.structureChangePartial', { table }),
    detail: t('db.applyPartialDetail', {
      applied: outcome.applied,
      total,
      failed: outcome.applied + 1,
      reason,
    }),
    type: 'error',
  };
}
