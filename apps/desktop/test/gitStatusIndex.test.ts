import { describe, expect, it } from 'vitest';
import { buildGitStatusIndex, getNodeGitStatus } from '../src/renderer/src/components/FileTree';
import type { GitStatusEntry } from '@deepseek-ide/shared';

/**
 * `buildGitStatusIndex` 是文件树里「这个节点要不要标 M/U」的判据。
 *
 * 之所以单独测：早先每个节点都拿着整份 `entries` 自己线性扫一遍，改成预建索引后
 * **判断结果必须逐个字节保持一致** —— 索引建错的表现不是崩，而是文件树里
 * 少几个状态字母、目录不再变黄，界面上看起来只像「git 状态没刷新」。
 */

const entry = (path: string, over: Partial<GitStatusEntry> = {}): GitStatusEntry => ({
  path,
  index: ' ',
  workTree: ' ',
  staged: false,
  untracked: false,
  ...over,
});

describe('buildGitStatusIndex', () => {
  it('文件按精确路径命中', () => {
    const idx = buildGitStatusIndex([entry('src/a.ts', { workTree: 'M' })]);
    expect(idx.files.get('src/a.ts')?.workTree).toBe('M');
    expect(idx.files.get('src/b.ts')).toBeUndefined();
  });

  it('反斜杠与开头斜杠会被归一化', () => {
    const idx = buildGitStatusIndex([entry('src\\win\\a.ts')]);
    expect(idx.files.get('src/win/a.ts')).toBeDefined();
  });

  it('改动路径的所有祖先目录都标记为「有改动」', () => {
    const idx = buildGitStatusIndex([entry('src/deep/nested/a.ts', { workTree: 'M' })]);
    // 原实现的目录判定是 `e.path.startsWith(norm + '/')`，所以祖先链上每一级
    // 都必须为真。少展开一级，最外层的目录就不变黄了。
    expect(idx.dirsWithChanges.has('src/deep/nested')).toBe(true);
    expect(idx.dirsWithChanges.has('src/deep')).toBe(true);
    expect(idx.dirsWithChanges.has('src')).toBe(true);
    // 兄弟目录不能误伤
    expect(idx.dirsWithChanges.has('sr')).toBe(false);
    expect(idx.dirsWithChanges.has('src/other')).toBe(false);
  });

  it('路径与改动同名时自身也算命中（子模块 / 目录被整体替换）', () => {
    const idx = buildGitStatusIndex([entry('vendor/lib', { workTree: 'M' })]);
    expect(idx.dirsWithChanges.has('vendor/lib')).toBe(true);
    expect(idx.dirsWithChanges.has('vendor')).toBe(true);
  });

  it('忽略项只登记自身，由查询侧沿祖先链判断', () => {
    const idx = buildGitStatusIndex([], ['node_modules/', 'dist']);
    expect(idx.ignored.has('node_modules')).toBe(true);
    expect(idx.ignored.has('dist')).toBe(true);
    // 忽略的是目录本身，不展开子孙：枚举子孙要先全盘遍历，那正是要避免的
    expect(idx.ignored.has('node_modules/pkg/index.js')).toBe(false);
  });

  it('空输入与脏数据不抛错', () => {
    expect(buildGitStatusIndex().files.size).toBe(0);
    expect(
      buildGitStatusIndex([{ path: '' } as GitStatusEntry, null as unknown as GitStatusEntry]).files
        .size,
    ).toBe(0);
    expect(buildGitStatusIndex([], ['', null as unknown as string]).ignored.size).toBe(0);
  });
});

describe('getNodeGitStatus', () => {
  const idx = buildGitStatusIndex(
    [
      entry('src/a.ts', { workTree: 'M' }),
      entry('src/new.ts', { untracked: true }),
      entry('src/staged.ts', { staged: true }),
      entry('src/deep/b.ts', { workTree: 'M' }),
    ],
    ['node_modules', 'dist'],
  );

  it('文件的三种状态字母与颜色', () => {
    expect(getNodeGitStatus('src/a.ts', false, idx)).toEqual({ label: 'M', color: '#e5a54b' });
    expect(getNodeGitStatus('src/new.ts', false, idx)).toEqual({ label: 'U', color: '#4caf50' });
    expect(getNodeGitStatus('src/staged.ts', false, idx)).toEqual({ label: 'A', color: '#4caf50' });
  });

  it('未改动的文件没有标记', () => {
    expect(getNodeGitStatus('src/untouched.ts', false, idx)).toBeNull();
  });

  it('目录只要有子孙改动就标黄', () => {
    expect(getNodeGitStatus('src', true, idx)).toEqual({ hasChanges: true, color: '#e5a54b' });
    expect(getNodeGitStatus('src/deep', true, idx)).toEqual({
      hasChanges: true,
      color: '#e5a54b',
    });
    expect(getNodeGitStatus('lib', true, idx)).toBeNull();
  });

  it('被忽略的路径及其子树置灰，且优先级高于改动标记', () => {
    expect(getNodeGitStatus('node_modules', true, idx)?.isIgnored).toBe(true);
    // 子树：忽略项是目录时，底下的文件也要跟着灰掉。这条靠查询侧沿祖先链找，
    // 而不是建索引时展开子孙 —— 展开要先遍历磁盘。
    expect(getNodeGitStatus('node_modules/pkg/index.js', false, idx)?.isIgnored).toBe(true);
    expect(getNodeGitStatus('dist/bundle.js', false, idx)?.isIgnored).toBe(true);
    expect(getNodeGitStatus('src', true, idx)?.isIgnored).toBeUndefined();
  });

  it('前缀相似的目录不算命中', () => {
    // `node_modules-x` 与 `node_modules` 共享前缀但不是同一棵子树：
    // 早先靠字符串 `startsWith` 就能做错这件事。
    expect(getNodeGitStatus('node_modules-x/a.js', false, idx)?.isIgnored).toBeUndefined();
    expect(getNodeGitStatus('dis', true, idx)).toBeNull();
  });

  it('空路径与非字符串返回 null', () => {
    expect(getNodeGitStatus('', false, idx)).toBeNull();
    expect(getNodeGitStatus(undefined as unknown as string, false, idx)).toBeNull();
  });
});
