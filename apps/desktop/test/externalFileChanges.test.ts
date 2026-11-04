import { describe, expect, it } from 'vitest';
import {
  baseNameOf,
  decideDiskChange,
  mergePendingChange,
  planExternalChangeActions,
  summariseFileNames,
  type PendingExternalChange,
} from '../src/renderer/src/services/externalFileChanges';

/**
 * 「磁盘上的文件被改了」这件事的两条规则。
 *
 * 都是**写反了不会报错、只会静默出事**的那种，所以单独钉住：
 * - 写反第一条 → 用户每按一次保存就弹一条「文件已被改变」（噪音，最后谁也不看提示）；
 * - 写反第二条 → 代理一改盘就把用户正在敲的字盖掉（不可逆的数据丢失）。
 */
describe('decideDiskChange', () => {
  const base = { savedContent: 'old', freshContent: 'new' };

  it('没有未保存的编辑 → 直接换成磁盘上的新内容', () => {
    expect(decideDiskChange({ ...base, dirty: false })).toBe('reload');
  });

  it('有未保存的编辑 → 只提示，绝不覆盖用户的字', () => {
    expect(decideDiskChange({ ...base, dirty: true })).toBe('conflict');
  });

  it('磁盘内容与上次保存的基准一样 → 忽略（自己写盘的回声）', () => {
    // 用户按保存 / git 还原：磁盘变了，但那是我们自己造成的
    expect(decideDiskChange({ dirty: false, savedContent: 'same', freshContent: 'same' })).toBe(
      'ignore',
    );
    // 有未保存的编辑也一样：磁盘那一侧没真的变，不该报「也变了」
    expect(decideDiskChange({ dirty: true, savedContent: 'same', freshContent: 'same' })).toBe(
      'ignore',
    );
  });

  it('读不到 → 只提示（多半已被删除）', () => {
    expect(decideDiskChange({ dirty: false, savedContent: 'old', freshContent: null })).toBe(
      'deleted',
    );
  });

  it('savedContent 缺失时不误判成「一样」', () => {
    // 标签没设过基准（异常路径）：磁盘有内容就该按「变了」处理
    expect(decideDiskChange({ dirty: false, savedContent: undefined, freshContent: 'x' })).toBe(
      'reload',
    );
  });
});

describe('提示里的文件名', () => {
  it('取最后一段，Windows 分隔符也认', () => {
    expect(baseNameOf('/a/b/c.ts')).toBe('c.ts');
    expect(baseNameOf('C:\\proj\\src\\a.ts')).toBe('a.ts');
    expect(baseNameOf('plain.ts')).toBe('plain.ts');
  });

  it('最多列三个，多的用「等 N 个」带过', () => {
    expect(summariseFileNames(['a.ts'])).toBe('a.ts');
    expect(summariseFileNames(['a.ts', 'b.ts', 'c.ts'])).toBe('a.ts、b.ts、c.ts');
    expect(summariseFileNames(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'])).toBe(
      'a.ts、b.ts、c.ts 等 5 个',
    );
  });
});

/**
 * 「接受 / 拒绝」这两个按钮**什么时候能给、按下去意味着什么**。
 *
 * 写错的代价不对称：
 * - 把「不能还原」判成「能还原」→ 用户点「拒绝」得到一句莫名其妙的失败，或者更糟，
 *   拿一份**更早**的内容盖掉磁盘（把代理的改动和用户的中间改动一起丢掉）；
 * - 把「没有未保存编辑」判成「有」→ 用户被拦下来，多一步操作。
 * 所以这里优先钉住「还原不了」的那几种，绝不放行。
 */
describe('planExternalChangeActions', () => {
  const change = (over: Partial<PendingExternalChange> = {}): PendingExternalChange => ({
    path: 'src/a.ts',
    abs: '/proj/src/a.ts',
    name: 'a.ts',
    before: 'old',
    fresh: 'new',
    dirty: false,
    open: true,
    ...over,
  });

  it('开着、有改动前的内容 → 接受是重新载入，拒绝可以点', () => {
    expect(planExternalChangeActions(change())).toEqual({
      accept: 'reload',
      canReject: true,
      acceptLosesEdits: false,
    });
  });

  it('没记到改动前的内容 → 拒绝**不能**点（宁可说不出来，也不拿旧内容乱盖）', () => {
    const actions = planExternalChangeActions(change({ before: undefined }));
    expect(actions.canReject).toBe(false);
    expect(actions.accept).toBe('reload');
  });

  it('文件没开着 → 接受只是收起提示，没有可同步的编辑器内容', () => {
    const actions = planExternalChangeActions(change({ open: false }));
    expect(actions.accept).toBe('dismiss');
  });

  it('磁盘上已被删除 → 接受是「承认删除」（把标签关掉）', () => {
    const actions = planExternalChangeActions(change({ fresh: null }));
    expect(actions.accept).toBe('close');
    expect(actions.canReject).toBe(true);
  });

  it('有未保存的编辑 → 标出「接受会丢改动」，界面必须说清楚', () => {
    expect(planExternalChangeActions(change({ dirty: true })).acceptLosesEdits).toBe(true);
    // 文件没开着时谈不上「丢编辑器里的改动」
    expect(planExternalChangeActions(change({ dirty: true, open: false })).acceptLosesEdits).toBe(
      false,
    );
  });
});

describe('mergePendingChange', () => {
  const base: PendingExternalChange = {
    path: 'src/a.ts',
    abs: '/proj/src/a.ts',
    name: 'a.ts',
    before: 'v1',
    fresh: 'v2',
    dirty: false,
    open: true,
  };

  it('同一条路径又变了 → 磁盘内容取新的，「改动前」保留最早那一份', () => {
    const merged = mergePendingChange(base, { ...base, before: 'v2', fresh: 'v3' });
    expect(merged.fresh).toBe('v3');
    // 「拒绝」要的是「回到代理动手之前」，不是「回到上一次磁盘变动之前」
    expect(merged.before).toBe('v1');
  });

  it('已经接受过一次（旧的那份 before 没了）→ 以新的一份为准', () => {
    const merged = mergePendingChange(
      { ...base, before: undefined },
      { ...base, before: 'v2', fresh: 'v3' },
    );
    expect(merged.before).toBe('v2');
  });

  it('中途关掉了标签 → 「开着」这个事实要留住（只要前后任一时刻开着）', () => {
    expect(mergePendingChange(base, { ...base, open: false }).open).toBe(true);
    expect(mergePendingChange({ ...base, open: false }, base).open).toBe(true);
  });
});
