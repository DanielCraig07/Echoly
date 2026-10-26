import type { GitCommitEntry, GitStatusEntry } from '@deepseek-ide/shared';

/**
 * Git 面板的**纯逻辑**部分：提交图轨道分析、状态树构建、状态字母。
 *
 * 从 `GitPanel.tsx` 里搬出来，原因是那份文件已经三千多行，而这一段的特征是
 * 「不碰 React、不碰 DOM、输入输出都是普通对象」—— 混在组件里它既无法被单测直接
 * 覆盖，也没法在阅读组件渲染结构时跳过。搬出来之后组件只剩渲染与交互。
 *
 * 这里**不返回任何文案**：状态字母 `M` / `U` / `A` 是 Git 的记号不是文案，
 * 而目录名、错误提示一律由调用方查字典。
 */

/** 提交图各条轨道的配色。索引按 lane 取模，所以顺序即优先级。 */
export const GRAPH_BRANCH_COLORS = [
  '#f57c00', // Orange (lane 0 - main track)
  '#00bcd4', // Cyan / Teal (lane 1 - feature branch)
  '#ab47bc', // Purple (lane 2 - secondary branch)
  '#42a5f5', // Sky Blue (lane 3)
  '#66bb6a', // Emerald Green (lane 4)
  '#ffa726', // Amber (lane 5)
  '#e91e63', // Magenta / Pink (lane 6)
];

export interface GraphEdge {
  childRow: number;
  childLane: number;
  parentRow: number;
  parentLane: number;
  isPrimary: boolean;
  isDashed: boolean;
  color: string;
}

export interface GraphAnalysis {
  commitLanes: Map<string, number>;
  edges: GraphEdge[];
  maxLane: number;
}

/**
 * 为提交列表分配轨道并算出父子连线。
 *
 * 输入**必须**按「新 → 旧」排列（`git log` 的天然顺序）：整个算法基于
 * 「父提交的行号一定大于子提交」这一前提，顺序反了会得到一堆指向过去的箭头，
 * 画面不报错但完全读不懂。
 */
export function analyzeGitGraph(commits: GitCommitEntry[]): GraphAnalysis {
  const commitIndices = new Map<string, number>();
  commits.forEach((c, idx) => commitIndices.set(c.hash, idx));

  const lanes: (string | null)[] = [];
  const commitLanes = new Map<string, number>();

  for (let r = 0; r < commits.length; r++) {
    const c = commits[r];
    let lane = lanes.indexOf(c.hash);
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(c.hash);
      } else {
        lanes[lane] = c.hash;
      }
    }
    commitLanes.set(c.hash, lane);

    const parents = c.parents || [];
    if (parents.length === 0) {
      lanes[lane] = null;
    } else if (parents.length === 1) {
      const p = parents[0];
      if (lanes.includes(p)) {
        lanes[lane] = null;
      } else {
        lanes[lane] = p;
      }
    } else {
      lanes[lane] = parents[0];
      for (let i = 1; i < parents.length; i++) {
        const p = parents[i];
        if (!lanes.includes(p)) {
          const empty = lanes.indexOf(null);
          if (empty === -1) {
            lanes.push(p);
          } else {
            lanes[empty] = p;
          }
        }
      }
    }
  }

  // 识别属于被合并分支（Merge commit 的次级父提交及其专属祖先提交集合）
  const dashedCommits = new Set<string>();
  for (let r = 0; r < commits.length; r++) {
    const c = commits[r];
    const parents = c.parents || [];
    if (parents.length >= 2) {
      for (let i = 1; i < parents.length; i++) {
        dashedCommits.add(parents[i]);
      }
    }
  }

  // 向下传播虚线状态（若提交属于被合并支线且其父提交单一，向下延续虚线轨道）
  for (let r = 0; r < commits.length; r++) {
    const c = commits[r];
    if (dashedCommits.has(c.hash)) {
      const parents = c.parents || [];
      if (parents.length === 1) {
        dashedCommits.add(parents[0]);
      }
    }
  }

  const edges: GraphEdge[] = [];
  for (let r = 0; r < commits.length; r++) {
    const c = commits[r];
    const cLane = commitLanes.get(c.hash) ?? 0;
    const parents = c.parents || [];
    const isChildDashed = dashedCommits.has(c.hash);

    parents.forEach((pHash, pIdx) => {
      const pRow = commitIndices.get(pHash);
      if (pRow !== undefined && pRow > r) {
        const pLane = commitLanes.get(pHash) ?? cLane;
        // 如果是合并提交的次级父提交，或是被合并分支上的提交连线，呈现为虚线
        const isDashed = pIdx > 0 || isChildDashed;
        edges.push({
          childRow: r,
          childLane: cLane,
          parentRow: pRow,
          parentLane: pLane,
          isPrimary: pIdx === 0,
          isDashed,
          color: GRAPH_BRANCH_COLORS[(pIdx === 0 ? cLane : pLane) % GRAPH_BRANCH_COLORS.length],
        });
      }
    });
  }

  const maxLane = Math.max(0, ...Array.from(commitLanes.values()));
  return { commitLanes, edges, maxLane };
}

export interface GitTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  entry?: GitStatusEntry;
  children: GitTreeNode[];
}

/** Git 状态字母。`M` / `U` / `A` 是 Git 自己的记号，不进字典。 */
export function statusLabel(entry: GitStatusEntry): string {
  if (entry.untracked) return 'U';
  if (entry.staged) return entry.index.trim() || 'S';
  return entry.workTree.trim() || 'M';
}

/**
 * 把扁平的改动列表折成目录树，并做 VS Code 式的**紧凑目录合并**
 * （`a / b / c`：链上每级都只有一个子目录时合成一行）。
 */
export function buildGitTree(entries: GitStatusEntry[]): GitTreeNode[] {
  const rootNodes: GitTreeNode[] = [];
  const map = new Map<string, GitTreeNode>();

  for (const entry of entries) {
    const parts = entry.path.split('/');
    let currentPath = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (!map.has(currentPath)) {
        const node: GitTreeNode = {
          name: part,
          path: currentPath,
          isDirectory: !isLast,
          entry: isLast ? entry : undefined,
          children: [],
        };
        map.set(currentPath, node);

        if (i === 0) {
          rootNodes.push(node);
        } else {
          const parentPath = parts.slice(0, i).join('/');
          const parentNode = map.get(parentPath);
          if (parentNode) {
            parentNode.children.push(node);
          }
        }
      }
    }
  }

  // 排序：文件夹在前，文件在后，按字母序排列
  const sortNodes = (nodes: GitTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.isDirectory && n.children.length > 0) {
        sortNodes(n.children);
      }
    }
  };
  sortNodes(rootNodes);

  const compactNodes = (nodes: GitTreeNode[]): GitTreeNode[] => {
    return nodes.map((node) => {
      if (!node.isDirectory) return node;

      const compactedChildren = compactNodes(node.children);
      let cur: GitTreeNode = { ...node, children: compactedChildren };

      while (cur.isDirectory && cur.children.length === 1 && cur.children[0].isDirectory) {
        const onlyChild = cur.children[0];
        cur = {
          name: `${cur.name} / ${onlyChild.name}`,
          path: onlyChild.path,
          isDirectory: true,
          entry: undefined,
          children: onlyChild.children,
        };
      }

      return cur;
    });
  };

  return compactNodes(rootNodes);
}

/**
 * 收集一棵子树下的全部文件路径。
 *
 * 注意走的是**合并后**的树：紧凑目录把中间层级折掉了，但 `path` 始终跟着最深的
 * 那个节点走，所以这里拿到的仍是磁盘上的真实相对路径。
 */
export function collectFolderFiles(node: GitTreeNode): string[] {
  const result: string[] = [];
  function traverse(n: GitTreeNode) {
    if (n.entry) {
      result.push(n.entry.path);
    }
    if (n.children) {
      for (const c of n.children) traverse(c);
    }
  }
  traverse(node);
  return result;
}
