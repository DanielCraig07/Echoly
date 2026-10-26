import { describe, expect, it } from 'vitest';
import {
  applyStatements,
  describeApplyResult,
} from '../src/renderer/src/services/dbStructureApply';
import { translate, translateWith, type Translate } from '../src/renderer/src/i18n';

// describeApplyResult 的 t 是必填的（返回值直接弹给用户），这里给一份 zh 的 t：
// 断言钉的是中文文案，顺带把「key → 字典条目」这条链走通，拼错 key 会在这里失败。
const zhT: Translate = (key, params) =>
  params ? translateWith(key, 'zh', params) : translate(key, 'zh');

/** 造一个「按语句表返回结果」的假执行器 */
function runner(map: Record<string, { ok: boolean; error?: string }>, log?: string[]) {
  return async (sql: string) => {
    log?.push(sql);
    return map[sql] ?? { ok: true };
  };
}

describe('applyStatements · 逐条执行', () => {
  it('全部成功时 applied 等于条数', async () => {
    const log: string[] = [];
    const out = await applyStatements(['a', 'b', 'c'], runner({}, log));
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(3);
    // 顺序必须保持：改名后再改类型，顺序错了就是改到别的列上
    expect(log).toEqual(['a', 'b', 'c']);
  });

  it('第一条就失败：applied 为 0，带回失败的那条语句与原因', async () => {
    const out = await applyStatements(
      ['a', 'b'],
      runner({ a: { ok: false, error: 'syntax error' } }),
    );
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(0);
    expect(out.failedSql).toBe('a');
    expect(out.error).toBe('syntax error');
  });

  it('中途失败即停，applied 如实反映已生效条数（这正是「部分生效」的依据）', async () => {
    const log: string[] = [];
    const out = await applyStatements(
      ['a', 'b', 'c', 'd'],
      runner({ c: { ok: false, error: 'boom' } }, log),
    );
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(2);
    expect(out.failedSql).toBe('c');
    // 失败之后不该再往下发
    expect(log).toEqual(['a', 'b', 'c']);
  });

  it('执行通道本身抛错等同于这条失败（连接断了也是这条没成功）', async () => {
    const out = await applyStatements(['a'], async () => {
      throw new Error('connection closed');
    });
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(0);
    expect(out.error).toBe('connection closed');
  });

  it('失败但没给原因时**不**在服务层塞兜底文案（渲染层用 db.unknownReason 补）', async () => {
    const out = await applyStatements(['a'], runner({ a: { ok: false } }));
    // 纯逻辑模块拿不到 i18n 上下文，在这里写死中文就等于把英文环境钉死在中文上
    expect(out.error).toBeUndefined();
    expect(zhT('db.unknownReason')).toBe('未知原因');
  });

  it('空语句表视为成功（调用方本就不该调，但不会崩）', async () => {
    const out = await applyStatements([], runner({}));
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(0);
  });
});

describe('describeApplyResult · 结果文案', () => {
  it('全部成功：标题带表名，多条时补一句执行条数', () => {
    const msg = describeApplyResult('mysql', 'cvm_location', { ok: true, applied: 3 }, 3, zhT);
    expect(msg.type).toBe('success');
    expect(msg.title).toContain('cvm_location');
    expect(msg.detail).toContain('3');
  });

  it('单条成功时不啰嗦「共执行 1 条」', () => {
    const msg = describeApplyResult('sqlite', 't', { ok: true, applied: 1 }, 1, zhT);
    expect(msg.detail).toBeUndefined();
  });

  it('一条都没成功：报失败并带上驱动名与原因', () => {
    const msg = describeApplyResult(
      'postgres',
      'orders',
      { ok: false, applied: 0, error: '权限不足' },
      2,
      zhT,
    );
    expect(msg.type).toBe('error');
    expect(msg.title).toContain('失败');
    expect(msg.detail).toContain('POSTGRES');
    expect(msg.detail).toContain('权限不足');
  });

  it('部分生效：绝不能混进「失败」，要说清已执行几条、第几条出错', () => {
    const msg = describeApplyResult('mysql', 't', { ok: false, applied: 2, error: 'boom' }, 5, zhT);
    expect(msg.type).toBe('error');
    expect(msg.title).toContain('部分生效');
    expect(msg.detail).toContain('已执行 2 / 5 条');
    expect(msg.detail).toContain('第 3 条');
    expect(msg.detail).toContain('boom');
  });
});
