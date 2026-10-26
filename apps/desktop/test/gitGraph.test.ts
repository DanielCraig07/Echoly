import { describe, expect, it } from 'vitest';
import {
  analyzeGitGraph,
  buildGitTree,
  collectFolderFiles,
  statusLabel,
  GRAPH_BRANCH_COLORS,
} from '../src/renderer/src/services/gitGraph';
import type { GitCommitEntry, GitStatusEntry } from '@deepseek-ide/shared';

/**
 * 从 `GitPanel.tsx` 拆到 `services/gitGraph.ts` 的这段逻辑是**纯函数**，
 * 于是终于可以被直接测：提交图的轨道分配错一个 lane，画面上只是某条连线
 * 拐到了奇怪的位置 —— 不崩、不报错、没有日志，所以必须有断言钉住。
 */

const commit = (hash: string, parents: string[] = []): GitCommitEntry => ({
  hash,
  shortHash: hash.slice(0, 7),
  parents,
  message: hash,
  author: 'tester',
  date: '2026-01-01',
});

const entry = (path: string, over: Partial<GitStatusEntry> = {}): GitStatusEntry => ({
  path,
  index: ' ',
  workTree: ' ',
  staged: false,
  untracked: false,
  ...over,
});

describe('statusLabel', () => {
  it('未跟踪是 U，已暂存取 index 字母，否则取 workTree 字母', () => {
    expect(statusLabel(entry('a', { untracked: true, workTree: '?' }))).toBe('U');
    expect(statusLabel(entry('a', { staged: true, index: 'A' }))).toBe('A');
    expect(statusLabel(entry('a', { workTree: 'M' }))).toBe('M');
  });

  it('暂存但 index 为空时退化成 S 而不是空串', () => {
    // 返回空串会让界面上那一列整个塌掉，比给个占位符更难排查。
    expect(statusLabel(entry('a', { staged: true, index: ' ' }))).toBe('S');
  });
});

describe('buildGitTree', () => {
  it('把扁平路径折成目录树，目录在前文件在后', () => {
    const tree = buildGitTree([entry('src/b.ts'), entry('README.md')]);
    expect(tree.map((n) => n.name)).toEqual(['src', 'README.md']);
    expect(tree[0].children[0].name).toBe('b.ts');
    expect(tree[0].children[0].entry?.path).toBe('src/b.ts');
  });

  it('紧凑目录合并：单链目录折成 a / b / c 一行', () => {
    const tree = buildGitTree([entry('a/b/c/file.ts')]);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('a / b / c');
    // path 必须跟着最深的节点走，否则「右键这行 → 丢弃改动」会丢掉前缀
    expect(tree[0].path).toBe('a/b/c');
  });

  it('有同级文件时不合并', () => {
    const tree = buildGitTree([entry('a/b/file.ts'), entry('a/other.ts')]);
    expect(tree[0].name).toBe('a');
  });
});

describe('collectFolderFiles', () => {
  it('收集子树下所有文件路径', () => {
    const tree = buildGitTree([entry('src/a.ts'), entry('src/deep/b.ts')]);
    const files = collectFolderFiles(tree[0]);
    expect(files.sort()).toEqual(['src/a.ts', 'src/deep/b.ts']);
  });

  it('紧凑合并后的目录仍收集到真实路径', () => {
    const tree = buildGitTree([entry('a/b/c/x.ts')]);
    expect(collectFolderFiles(tree[0])).toEqual(['a/b/c/x.ts']);
  });
});

describe('analyzeGitGraph', () => {
  it('线性历史全部落在同一条轨道上', () => {
    const { commitLanes, edges } = analyzeGitGraph([
      commit('c3', ['c2']),
      commit('c2', ['c1']),
      commit('c1'),
    ]);
    expect([...commitLanes.values()]).toEqual([0, 0, 0]);
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.childLane === 0 && e.parentLane === 0)).toBe(true);
    expect(edges.every((e) => !e.isDashed)).toBe(true);
  });

  it('合并提交的次级父提交走新轨道，且连线为虚线', () => {
    // m 合并了 a（主线的父）与 b（支线的父）；b 在历史里排第二。
    const { commitLanes, edges, maxLane } = analyzeGitGraph([
      commit('m', ['a', 'b']),
      commit('b', ['base']),
      commit('a', ['base']),
      commit('base'),
    ]);
    expect(commitLanes.get('b')).not.toBe(commitLanes.get('a'));
    expect(maxLane).toBeGreaterThanOrEqual(1);

    const fromMerge = edges.filter((e) => e.childRow === 0);
    expect(fromMerge).toHaveLength(2);
    // 第一个父是主线（实线），第二个父属于被合并支线（虚线）
    expect(fromMerge[0].isDashed).toBe(false);
    expect(fromMerge[1].isDashed).toBe(true);
  });

  it('根提交（无父）不产生连线', () => {
    const { edges } = analyzeGitGraph([commit('only')]);
    expect(edges).toEqual([]);
  });

  it('连线颜色取自轨道配色表，且一定在表内', () => {
    const { edges } = analyzeGitGraph([
      commit('m', ['a', 'b']),
      commit('b', ['base']),
      commit('a', ['base']),
      commit('base'),
    ]);
    for (const e of edges) {
      expect(GRAPH_BRANCH_COLORS).toContain(e.color);
    }
  });

  it('空历史不抛错', () => {
    expect(analyzeGitGraph([])).toEqual({ commitLanes: new Map(), edges: [], maxLane: 0 });
  });
});
