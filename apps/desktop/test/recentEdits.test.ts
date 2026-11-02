import { describe, it, expect, beforeEach } from 'vitest';
import {
  MAX_RECENT_EDITS,
  attachRecentEditRecorder,
  clearRecentEdits,
  getRecentEdits,
  recordEdit,
  type EditableModel,
} from '../src/renderer/src/services/recentEdits';

/**
 * 最近编辑记录。
 *
 * 这里最值得盯的是「被删掉的文本能不能取回来」：Monaco 的变更事件只给
 * 变更范围与新文本，被删的原文本不在事件里，而它正是 diff 里信息量的一半。
 * 实现靠一份文本快照 + 事件里的偏移量反查 —— 偏移量的基准（变更前还是变更后）
 * 一旦搞错，取回来的就是牛头不对马嘴的一段，而且不会报错。
 */

/** 用真实字符串模拟 monaco 模型：事件里给出的是相对**变更前**文档的偏移。 */
function makeModel(initial: string): {
  model: EditableModel;
  type(from: number, to: number, text: string): void;
  value(): string;
} {
  let value = initial;
  const listeners: Array<
    (e: { changes: { rangeOffset: number; rangeLength: number; text: string }[] }) => void
  > = [];
  const model: EditableModel = {
    uri: { toString: () => 'file:///a.ts' },
    getValue: () => value,
    onDidChangeContent: (listener) => {
      listeners.push(listener);
      return { dispose: () => {} };
    },
  };
  return {
    model,
    value: () => value,
    type(from, to, text) {
      value = value.slice(0, from) + text + value.slice(to);
      for (const listener of listeners) {
        listener({ changes: [{ rangeOffset: from, rangeLength: to - from, text }] });
      }
    },
  };
}

describe('recentEdits', () => {
  beforeEach(() => clearRecentEdits());

  it('纯输入时只记插入内容', () => {
    const { model, type } = makeModel('const a = ;');
    attachRecentEditRecorder(model);
    type(10, 10, '1');
    expect(getRecentEdits('file:///a.ts')).toEqual([{ inserted: '1', deleted: '' }]);
  });

  it('删除时能从快照里取回被删的原文', () => {
    const { model, type } = makeModel('const userName = 1;');
    attachRecentEditRecorder(model);
    type(6, 14, 'account'); // 把 userName 换成 account
    expect(getRecentEdits('file:///a.ts')).toEqual([{ inserted: 'account', deleted: 'userName' }]);
  });

  it('连续编辑时偏移量基准始终跟着最新内容走', () => {
    // 这是最容易写错的地方：第二次变更的偏移量是相对「已经改过」的文档算的，
    // 若快照没跟着更新，取回的被删文本就会整体错位。
    const { model, type } = makeModel('abcdef');
    attachRecentEditRecorder(model);
    type(0, 0, 'XX'); // XXabcdef
    type(2, 4, 'yy'); // XXyycdef —— 删除的是 "ab"
    expect(getRecentEdits('file:///a.ts')).toEqual([
      { inserted: 'XX', deleted: '' },
      { inserted: 'yy', deleted: 'ab' },
    ]);
  });

  it('只保留最近三次，且顺序是从旧到新', () => {
    const uri = 'file:///b.ts';
    for (const ch of ['a', 'b', 'c', 'd']) recordEdit(uri, { inserted: ch, deleted: '' });
    const edits = getRecentEdits(uri);
    expect(edits).toHaveLength(MAX_RECENT_EDITS);
    expect(edits.map((e) => e.inserted)).toEqual(['b', 'c', 'd']);
  });

  it('空编辑不入账', () => {
    recordEdit('file:///c.ts', { inserted: '', deleted: '' });
    expect(getRecentEdits('file:///c.ts')).toEqual([]);
  });

  it('不同文件各记各的', () => {
    recordEdit('file:///x.ts', { inserted: 'x', deleted: '' });
    recordEdit('file:///y.ts', { inserted: 'y', deleted: '' });
    expect(getRecentEdits('file:///x.ts')).toEqual([{ inserted: 'x', deleted: '' }]);
    expect(getRecentEdits('file:///y.ts')).toEqual([{ inserted: 'y', deleted: '' }]);
  });

  it('超长文本被截断，避免一次粘贴把上下文撑爆', () => {
    recordEdit('file:///d.ts', { inserted: 'z'.repeat(5000), deleted: '' });
    expect(getRecentEdits('file:///d.ts')[0].inserted.length).toBe(400);
  });

  it('超大文件不做快照，于是只记到插入的那一半', () => {
    const { model, type } = makeModel('x'.repeat(200_000));
    attachRecentEditRecorder(model);
    type(100, 102, 'q');
    const edits = getRecentEdits('file:///a.ts');
    expect(edits[0].inserted).toBe('q');
    expect(edits[0].deleted).toBe('');
  });

  it('clearRecentEdits 不带参数时清空全部', () => {
    recordEdit('file:///x.ts', { inserted: 'a', deleted: '' });
    recordEdit('file:///y.ts', { inserted: 'b', deleted: '' });
    clearRecentEdits();
    expect(getRecentEdits('file:///x.ts')).toEqual([]);
    expect(getRecentEdits('file:///y.ts')).toEqual([]);
  });

  it('getRecentEdits 返回副本，外部改动不影响内部状态', () => {
    recordEdit('file:///e.ts', { inserted: 'a', deleted: '' });
    getRecentEdits('file:///e.ts').push({ inserted: 'fake', deleted: '' });
    expect(getRecentEdits('file:///e.ts')).toHaveLength(1);
  });
});
