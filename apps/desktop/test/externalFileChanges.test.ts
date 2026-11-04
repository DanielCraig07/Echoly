import { describe, expect, it } from 'vitest';
import {
  baseNameOf,
  decideDiskChange,
  summariseFileNames,
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
