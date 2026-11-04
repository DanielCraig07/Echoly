import { describe, expect, it } from 'vitest';
import { FileChangeSnapshots } from '../src/main/fileChangeSnapshots';

/**
 * 「改动前的内容」快照 —— 「拒绝 / 还原」唯一的原料。
 *
 * 这里的规则写错了**不会报错**，只会在用户最需要还原的时候给出一份错的内容：
 * - 取走不删 → 同一次改动被还原两次，第二次会拿一份早就过期的内容盖盘上较新的东西；
 * - 记太大的文件 → 快照变成「顺手备份整个仓库」，内存直接爆。
 */
describe('FileChangeSnapshots', () => {
  it('记得住，取得回', () => {
    const snapshots = new FileChangeSnapshots();
    snapshots.remember('/a/b.ts', 'old');
    expect(snapshots.claim('/a/b.ts')).toBe('old');
  });

  it('取走即删 —— 同一次改动只认一次', () => {
    const snapshots = new FileChangeSnapshots();
    snapshots.remember('/a/b.ts', 'old');
    snapshots.claim('/a/b.ts');
    // 第二次拿不到：与其拿一份更早的内容去盖，不如诚实地说「还原不了」
    expect(snapshots.claim('/a/b.ts')).toBeUndefined();
    expect(snapshots.size).toBe(0);
  });

  it('没见过这个文件 → 拿不到（还原不了）', () => {
    const snapshots = new FileChangeSnapshots();
    expect(snapshots.claim('/never/seen.ts')).toBeUndefined();
  });

  it('同一个文件再记一次 → 以最新的一份为准', () => {
    const snapshots = new FileChangeSnapshots();
    snapshots.remember('/a/b.ts', 'v1');
    snapshots.remember('/a/b.ts', 'v2');
    expect(snapshots.claim('/a/b.ts')).toBe('v2');
  });

  it('空路径 / 非字符串直接忽略，不占位置', () => {
    const snapshots = new FileChangeSnapshots();
    snapshots.remember('', 'x');
    snapshots.remember('/a/b.ts', undefined as unknown as string);
    expect(snapshots.size).toBe(0);
  });

  it('超过 2MB 的内容不记（快照是给还原用的，不是备份整个仓库）', () => {
    const snapshots = new FileChangeSnapshots();
    snapshots.remember('/a/big.bin', 'x'.repeat(2 * 1024 * 1024 + 1));
    expect(snapshots.claim('/a/big.bin')).toBeUndefined();
  });

  it('文件长大超过上限时，把旧的快照清掉（别留着一份过期的）', () => {
    const snapshots = new FileChangeSnapshots();
    snapshots.remember('/a/big.bin', 'small');
    snapshots.remember('/a/big.bin', 'x'.repeat(2 * 1024 * 1024 + 1));
    expect(snapshots.claim('/a/big.bin')).toBeUndefined();
  });

  it('forget / clear 能主动清掉（文件被删、切工作区）', () => {
    const snapshots = new FileChangeSnapshots();
    snapshots.remember('/a/b.ts', 'x');
    snapshots.forget('/a/b.ts');
    expect(snapshots.claim('/a/b.ts')).toBeUndefined();

    snapshots.remember('/a/b.ts', 'x');
    snapshots.remember('/a/c.ts', 'y');
    snapshots.clear();
    expect(snapshots.size).toBe(0);
  });
});
