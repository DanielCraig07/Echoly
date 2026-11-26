import { describe, expect, it } from 'vitest';
import { WRITE_TOOL_NAMES } from '@deepseek-ide/tools';
import {
  BATCH_CONFIRM_PATH_FIELDS,
  BatchApprovalGate,
  collectBatchWritePaths,
  normalizeConfirmPath,
} from '../src/batchConfirm';

/**
 * 合并确认的纯逻辑。
 *
 * 关键的失败模式是**静默的**：漏登记一个写文件的工具，表现为它照常单独弹一次确认 ——
 * 功能没坏，只是「这条回复的所有改动一次同意」悄悄少了一个文件，而用户以为已经全同意了。
 */
describe('collectBatchWritePaths', () => {
  const call = (name: string, args: unknown) => ({ name, args });

  it('收出多个写文件的路径，去重且保留出现次序', () => {
    const paths = collectBatchWritePaths([
      call('write_file', JSON.stringify({ path: 'src/b.ts' })),
      call('apply_patch', JSON.stringify({ path: 'src/a.ts' })),
      call('write_file', JSON.stringify({ path: 'src/b.ts' })),
    ]);
    expect(paths).toEqual(['src/b.ts', 'src/a.ts']);
  });

  it('反斜杠与大小写差异归为同一个路径', () => {
    const paths = collectBatchWritePaths([
      call('write_file', JSON.stringify({ path: 'src\\A.ts' })),
      call('apply_patch', JSON.stringify({ path: 'src/a.ts' })),
      call('write_file', JSON.stringify({ path: 'src/other.ts' })),
      call('apply_patch', JSON.stringify({ path: 'src/third.ts' })),
    ]);
    expect(paths.filter((p) => normalizeConfirmPath(p) === 'src/a.ts')).toHaveLength(1);
  });

  it('少于两个路径不合并：只有一处改动时多问一次没有意义', () => {
    const single = [call('write_file', JSON.stringify({ path: 'a.ts' }))];
    expect(collectBatchWritePaths(single)).toEqual([]);
    // 同一个文件被写两次仍算一处
    expect(collectBatchWritePaths([...single, ...single])).toEqual([]);
  });

  it('只读工具与终端命令不参与合并', () => {
    const paths = collectBatchWritePaths([
      call('read_file', JSON.stringify({ path: 'a.ts' })),
      call('run_terminal', JSON.stringify({ command: 'rm -rf build' })),
      call('web_search', JSON.stringify({ query: 'x' })),
    ]);
    expect(paths).toEqual([]);
  });

  it('参数是对象（降级解析的结果）也认', () => {
    const paths = collectBatchWritePaths([
      { name: 'write_file', args: { path: 'a.ts' } },
      { name: 'apply_patch', args: { path: 'b.ts' } },
    ]);
    expect(paths).toEqual(['a.ts', 'b.ts']);
  });

  it('参数写坏时跳过，不抛错', () => {
    const paths = collectBatchWritePaths([
      call('write_file', '{not json'),
      call('write_file', JSON.stringify({ path: '' })),
      call('apply_patch', JSON.stringify({ path: 'a.ts' })),
      call('write_file', JSON.stringify({ path: 'b.ts' })),
    ]);
    expect(paths).toEqual(['a.ts', 'b.ts']);
  });
});

describe('BatchApprovalGate', () => {
  it('同意后该路径在本轮内持续放行（模型微调同一批文件不再弹窗）', () => {
    const gate = new BatchApprovalGate();
    gate.resolve(['a.ts'], true);
    expect(gate.take('a.ts')).toBe(true);
    expect(gate.take('a.ts')).toBe(true);
  });

  it('拒绝只对这一次尝试有效：模型重试同一个文件要再问一次', () => {
    const gate = new BatchApprovalGate();
    gate.resolve(['a.ts', 'b.ts'], false);
    expect(gate.take('A.TS')).toBe(false);
    expect(gate.take('b.ts')).toBe(false);
    // 拒绝被消费掉之后回到「照常询问」——否则用户再也没有机会看到新方案后改口
    expect(gate.take('b.ts')).toBeNull();
  });

  it('没问过的路径返回 null（照常询问用户）', () => {
    const gate = new BatchApprovalGate();
    expect(gate.take('a.ts')).toBeNull();
    expect(gate.take(undefined)).toBeNull();
  });

  it('重新询问并改判时旧结论被覆盖', () => {
    // 一轮里第二次合并确认（新冒出的两个文件）不该把上一条记住的结论留着
    const gate = new BatchApprovalGate();
    gate.resolve(['a.ts'], true);
    gate.resolve(['a.ts'], false);
    expect(gate.take('a.ts')).toBe(false);
  });

  it('clear 之后回到「照常询问」', () => {
    const gate = new BatchApprovalGate();
    gate.resolve(['a.ts'], true);
    gate.clear();
    expect(gate.take('a.ts')).toBeNull();
  });

  it('beginStep 只作废上一步没消费掉的拒绝，保留同意', () => {
    const gate = new BatchApprovalGate();
    gate.resolve(['ok.ts'], true);
    gate.resolve(['failed.ts'], false);
    gate.beginStep();
    // 拒绝没人消费（那个工具在确认前就失败了）→ 下一步要重新问，而不是静默驳掉
    expect(gate.take('failed.ts')).toBeNull();
    // 同意仍然有效：用户批准的是这一轮这几个文件
    expect(gate.take('ok.ts')).toBe(true);
  });

  it('pending 只留下没问过的路径（同一轮里不重复列已同意的文件）', () => {
    const gate = new BatchApprovalGate();
    gate.resolve(['a.ts'], true);
    expect(gate.pending(['a.ts', 'b.ts'])).toEqual(['b.ts']);
    gate.resolve(['b.ts'], false);
    expect(gate.pending(['a.ts', 'b.ts'])).toEqual([]);
  });
});

describe('BATCH_CONFIRM_PATH_FIELDS', () => {
  it('覆盖写入类工具', () => {
    // 新加一个写文件的工具却忘了登记，表现是它单独弹一次确认 —— 不报错，只是漏合并
    expect(Object.keys(BATCH_CONFIRM_PATH_FIELDS)).toEqual(
      expect.arrayContaining(['write_file', 'apply_patch']),
    );
    for (const name of Object.keys(BATCH_CONFIRM_PATH_FIELDS)) {
      expect(WRITE_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  it('删除与移动不并入合并确认（风险不是一回事）', () => {
    expect(BATCH_CONFIRM_PATH_FIELDS.delete_path).toBeUndefined();
    expect(BATCH_CONFIRM_PATH_FIELDS.move_path).toBeUndefined();
  });
});
