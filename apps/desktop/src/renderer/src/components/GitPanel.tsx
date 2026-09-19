import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  GitBranchInfo,
  GitCommitEntry,
  GitCommitFileChange,
  GitCommitStats,
  GitHistoryResult,
  GitStatusEntry,
  GitStatusResult,
  PendingDiff,
  WorkspaceInfo,
} from '@deepseek-ide/shared';
import { RenderFileTreeIcon } from './FileTree';
import { GitCommitPreviewCard } from './GitCommitPreviewCard';

interface Props {
  workspaceInfo: WorkspaceInfo | null;
  onPreviewDiff: (diff: PendingDiff | null) => void;
  onDiscardPath?: (path: string | string[]) => void;
  onOpenFile?: (path: string) => void;
  onViewFileHistory?: (path: string) => void;
  onRevealInExplorer?: (path: string) => void;
  onBranchSwitched?: () => void;
  refreshNonce?: number;
  onShowToast?: (
    title: string,
    detail?: string,
    type?: 'success' | 'error' | 'info' | 'warn',
  ) => void;
}

function statusLabel(entry: GitStatusEntry): string {
  if (entry.untracked) return 'U';
  if (entry.staged) return entry.index.trim() || 'S';
  return entry.workTree.trim() || 'M';
}

interface GitTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  entry?: GitStatusEntry;
  children: GitTreeNode[];
}

function buildGitTree(entries: GitStatusEntry[]): GitTreeNode[] {
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

  // 紧凑目录合并（Compact Folders，如 VS Code）：当目录只有一个子目录且无同级文件时，合并层级为 a / b / c
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

function collectFolderFiles(node: GitTreeNode): string[] {
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

function GitTreeItemView({
  node,
  depth = 0,
  staged,
  selectedPath,
  onSelectPath,
  onPreview,
  onDiscard,
  onStage,
  onUnstage,
  onOpenFile,
  onContextMenu,
  onFolderContextMenu,
}: {
  node: GitTreeNode;
  depth?: number;
  staged: boolean;
  selectedPath?: string | null;
  onSelectPath?: (path: string) => void;
  onPreview: (entry: GitStatusEntry, staged: boolean) => void;
  onDiscard: (path: string) => void;
  onStage?: (path: string) => void;
  onUnstage?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  onContextMenu?: (e: React.MouseEvent, entry: GitStatusEntry, staged: boolean) => void;
  onFolderContextMenu?: (e: React.MouseEvent, node: GitTreeNode, staged: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [isFolderHovered, setIsFolderHovered] = useState(false);

  if (node.isDirectory) {
    const isFolderSelected = selectedPath === node.path;
    return (
      <div>
        <div
          onClick={() => setCollapsed(!collapsed)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onSelectPath?.(node.path);
            onFolderContextMenu?.(e, node, staged);
          }}
          onMouseEnter={() => setIsFolderHovered(true)}
          onMouseLeave={() => setIsFolderHovered(false)}
          style={{
            paddingLeft: 12 + depth * 14,
            paddingRight: 10,
            height: 24,
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            cursor: 'pointer',
            userSelect: 'none',
            background: isFolderSelected
              ? 'var(--bg-hover, rgba(255, 255, 255, 0.08))'
              : isFolderHovered
                ? 'rgba(255, 255, 255, 0.04)'
                : 'transparent',
            borderRadius: 4,
            transition: 'background 0.1s ease',
          }}
          className="search-result-item"
        >
          <span style={{ fontSize: 10, color: 'var(--muted)', width: 12, textAlign: 'center' }}>
            {collapsed ? '▸' : '▾'}
          </span>
          <RenderFileTreeIcon
            name={node.name.includes(' / ') ? node.name.split(' / ').pop()! : node.name}
            isDirectory={true}
          />
          <span
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: 'var(--text)',
            }}
          >
            {node.name}
          </span>

          {(isFolderHovered || isFolderSelected) && (
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 2 }}
              onClick={(e) => e.stopPropagation()}
            >
              {!staged && (
                <button
                  type="button"
                  title="放弃文件夹下所有更改"
                  onClick={() => {
                    onSelectPath?.(node.path);
                    onDiscard(node.path);
                  }}
                  className="panel-action-btn"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                </button>
              )}
              {!staged ? (
                <button
                  type="button"
                  title="暂存文件夹下所有更改"
                  onClick={() => {
                    onSelectPath?.(node.path);
                    onStage?.(node.path);
                  }}
                  className="panel-action-btn"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              ) : (
                <button
                  type="button"
                  title="取消暂存文件夹下所有更改"
                  onClick={() => {
                    onSelectPath?.(node.path);
                    onUnstage?.(node.path);
                  }}
                  className="panel-action-btn"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </div>
        {!collapsed &&
          node.children.map((child) => (
            <GitTreeItemView
              key={child.path}
              node={child}
              depth={depth + 1}
              staged={staged}
              selectedPath={selectedPath}
              onSelectPath={onSelectPath}
              onPreview={onPreview}
              onDiscard={onDiscard}
              onStage={onStage}
              onUnstage={onUnstage}
              onOpenFile={onOpenFile}
              onContextMenu={onContextMenu}
              onFolderContextMenu={onFolderContextMenu}
            />
          ))}
      </div>
    );
  }

  const f = node.entry;
  if (!f) return null;

  const isSelected = selectedPath === f.path;
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      onClick={() => {
        onSelectPath?.(f.path);
        onPreview(f, staged);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSelectPath?.(f.path);
        onContextMenu?.(e, f, staged);
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        paddingLeft: 12 + depth * 14 + 10,
        paddingRight: 10,
        height: 24,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        cursor: 'pointer',
        background: isSelected
          ? 'var(--bg-hover, rgba(255, 255, 255, 0.08))'
          : isHovered
            ? 'rgba(255, 255, 255, 0.04)'
            : 'transparent',
        borderRadius: 4,
        transition: 'background 0.1s ease',
        userSelect: 'none',
      }}
      className="search-result-item"
    >
      <RenderFileTreeIcon name={node.name} isDirectory={false} />
      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: isSelected ? 'var(--text-bright, #fff)' : 'var(--text)',
        }}
      >
        {node.name}
      </span>

      {/* 悬停或选中状态下显示操作按钮栏（打开文件、放弃更改、暂存/取消暂存） */}
      {(isHovered || isSelected) && (
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 2 }}
          onClick={(e) => e.stopPropagation()}
        >
          {onOpenFile && (
            <button
              type="button"
              title="打开文件"
              onClick={() => {
                onSelectPath?.(f.path);
                onOpenFile(f.path);
              }}
              className="panel-action-btn"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
            </button>
          )}

          {!staged && (
            <button
              type="button"
              title="放弃更改"
              onClick={() => {
                onSelectPath?.(f.path);
                onDiscard(f.path);
              }}
              className="panel-action-btn"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          )}

          {!staged ? (
            <button
              type="button"
              title="暂存更改"
              onClick={() => {
                onSelectPath?.(f.path);
                onStage?.(f.path);
              }}
              className="panel-action-btn"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              title="取消暂存"
              onClick={() => {
                onSelectPath?.(f.path);
                onUnstage?.(f.path);
              }}
              className="panel-action-btn"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          )}
        </div>
      )}

      <span
        style={{
          color: f.staged ? '#4caf50' : f.untracked ? '#34d399' : '#e5a54b',
          fontSize: 11,
          fontWeight: 600,
          width: 14,
          textAlign: 'center',
          marginLeft: 2,
        }}
      >
        {f.staged ? 'A' : f.untracked ? 'U' : statusLabel(f)}
      </span>
    </div>
  );
}

function GitFileListItemView({
  entry,
  staged,
  selectedPath,
  onSelectPath,
  onPreview,
  onDiscard,
  onStage,
  onUnstage,
  onOpenFile,
  onContextMenu,
}: {
  entry: GitStatusEntry;
  staged: boolean;
  selectedPath?: string | null;
  onSelectPath?: (path: string) => void;
  onPreview: (entry: GitStatusEntry, staged: boolean) => void;
  onDiscard: (path: string) => void;
  onStage?: (path: string) => void;
  onUnstage?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  onContextMenu?: (e: React.MouseEvent, entry: GitStatusEntry, staged: boolean) => void;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const isSelected = selectedPath === entry.path;
  const fileName = entry.path.split('/').pop() || entry.path;
  const dirName = entry.path.includes('/')
    ? entry.path.substring(0, entry.path.lastIndexOf('/'))
    : '';

  return (
    <div
      onClick={() => {
        onSelectPath?.(entry.path);
        onPreview(entry, staged);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSelectPath?.(entry.path);
        onContextMenu?.(e, entry, staged);
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        height: 24,
        padding: '0 10px 0 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        cursor: 'pointer',
        boxSizing: 'border-box',
        background: isSelected
          ? 'var(--bg-hover, rgba(255, 255, 255, 0.08))'
          : isHovered
            ? 'rgba(255, 255, 255, 0.04)'
            : 'transparent',
        borderRadius: 4,
        transition: 'background 0.1s ease',
        userSelect: 'none',
      }}
      className="search-result-item"
    >
      <RenderFileTreeIcon name={fileName} isDirectory={false} />
      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span style={{ color: isSelected ? 'var(--text-bright, #fff)' : 'var(--text)' }}>
          {fileName}
        </span>
        {dirName && (
          <span style={{ fontSize: 10.5, color: 'var(--muted)', opacity: 0.65 }}>{dirName}</span>
        )}
      </span>

      {(isHovered || isSelected) && (
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 2 }}
          onClick={(e) => e.stopPropagation()}
        >
          {onOpenFile && (
            <button
              type="button"
              title="打开文件"
              onClick={() => {
                onSelectPath?.(entry.path);
                onOpenFile(entry.path);
              }}
              className="panel-action-btn"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
            </button>
          )}

          {!staged && (
            <button
              type="button"
              title="放弃更改"
              onClick={() => {
                onSelectPath?.(entry.path);
                onDiscard(entry.path);
              }}
              className="panel-action-btn"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          )}

          {!staged ? (
            <button
              type="button"
              title="暂存更改"
              onClick={() => {
                onSelectPath?.(entry.path);
                onStage?.(entry.path);
              }}
              className="panel-action-btn"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              title="取消暂存"
              onClick={() => {
                onSelectPath?.(entry.path);
                onUnstage?.(entry.path);
              }}
              className="panel-action-btn"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          )}
        </div>
      )}

      <span
        style={{
          color: entry.staged ? '#4caf50' : entry.untracked ? '#34d399' : '#e5a54b',
          fontSize: 11,
          fontWeight: 600,
          width: 14,
          textAlign: 'center',
          marginLeft: 2,
        }}
      >
        {entry.staged ? 'A' : entry.untracked ? 'U' : statusLabel(entry)}
      </span>
    </div>
  );
}

const GRAPH_BRANCH_COLORS = [
  '#f57c00', // Orange (lane 0 - main track)
  '#00bcd4', // Cyan / Teal (lane 1 - feature branch)
  '#ab47bc', // Purple (lane 2 - secondary branch)
  '#42a5f5', // Sky Blue (lane 3)
  '#66bb6a', // Emerald Green (lane 4)
  '#ffa726', // Amber (lane 5)
  '#e91e63', // Magenta / Pink (lane 6)
];

interface GraphEdge {
  childRow: number;
  childLane: number;
  parentRow: number;
  parentLane: number;
  isPrimary: boolean;
  isDashed: boolean;
  color: string;
}

interface GraphAnalysis {
  commitLanes: Map<string, number>;
  edges: GraphEdge[];
  maxLane: number;
}

function analyzeGitGraph(commits: GitCommitEntry[]): GraphAnalysis {
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
        // 如果是合并提交的次级父提交，或是被合并分支上的提交连线，呈现为虚线（如参考截图左下轨道）
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

function GitGraphRowSvg({
  rowIndex,
  commit,
  analysis,
  totalRowHeight,
  isSelected,
}: {
  rowIndex: number;
  commit: GitCommitEntry;
  analysis: GraphAnalysis;
  totalRowHeight: number;
  isSelected?: boolean;
}) {
  const { commitLanes, edges } = analysis;
  const cLane = commitLanes.get(commit.hash) ?? 0;
  const cColor = GRAPH_BRANCH_COLORS[cLane % GRAPH_BRANCH_COLORS.length];
  const LANE_WIDTH = 12;
  const X_OFFSET = 10;
  const Y_MID = 13;
  const cx = X_OFFSET + cLane * LANE_WIDTH;
  const isMerge = (commit.parents?.length || 0) >= 2;

  const paths: React.ReactNode[] = [];

  // 计算当前行真正涉及的最大轨道编号（包括节点自身轨道，以及当前行所有连线的起点和终点轨道）
  let rowMaxLane = cLane;

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (e.childRow <= rowIndex && rowIndex <= e.parentRow) {
      rowMaxLane = Math.max(rowMaxLane, e.parentLane);
      if (rowIndex === e.childRow) {
        rowMaxLane = Math.max(rowMaxLane, e.childLane);
      }

      const childX = X_OFFSET + e.childLane * LANE_WIDTH;
      const parentX = X_OFFSET + e.parentLane * LANE_WIDTH;
      const dash = e.isDashed ? '4 3' : undefined;

      if (rowIndex === e.childRow) {
        if (e.childLane === e.parentLane) {
          paths.push(
            <line
              key={`c-${i}`}
              x1={childX}
              y1={Y_MID}
              x2={childX}
              y2={totalRowHeight}
              stroke={e.color}
              strokeWidth={2}
              strokeDasharray={dash}
            />,
          );
        } else {
          // 分支拐弯：从 child 节点水平向右弯折，以顺滑 90 度圆弧过渡进入目标轨道 parentLane（对齐参考截图）
          const cpx1 = childX + (parentX - childX) * 0.7;
          const cpy1 = Y_MID;
          const cpx2 = parentX;
          const cpy2 = Y_MID + (totalRowHeight - Y_MID) * 0.3;
          paths.push(
            <path
              key={`c-${i}`}
              d={`M ${childX} ${Y_MID} C ${cpx1} ${cpy1}, ${cpx2} ${cpy2}, ${parentX} ${totalRowHeight}`}
              fill="none"
              stroke={e.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={dash}
            />,
          );
        }
      } else if (rowIndex === e.parentRow) {
        if (e.childLane === e.parentLane) {
          paths.push(
            <line
              key={`p-${i}`}
              x1={parentX}
              y1={0}
              x2={parentX}
              y2={Y_MID}
              stroke={e.color}
              strokeWidth={2}
              strokeDasharray={dash}
            />,
          );
        } else if (e.parentRow === e.childRow + 1) {
          paths.push(
            <line
              key={`p-${i}`}
              x1={parentX}
              y1={0}
              x2={parentX}
              y2={Y_MID}
              stroke={e.color}
              strokeWidth={2}
              strokeDasharray={dash}
            />,
          );
        } else {
          paths.push(
            <line
              key={`p-${i}`}
              x1={parentX}
              y1={0}
              x2={parentX}
              y2={Y_MID}
              stroke={e.color}
              strokeWidth={2}
              strokeDasharray={dash}
            />,
          );
        }
      } else {
        // 中间行垂直向下延续轨道
        paths.push(
          <line
            key={`m-${i}`}
            x1={parentX}
            y1={0}
            x2={parentX}
            y2={totalRowHeight}
            stroke={e.color}
            strokeWidth={2}
            strokeDasharray={dash}
          />,
        );
      }
    }
  }

  // 紧凑自适应宽度：由当前行实际涉及的最大轨道决定，消除右侧无效空白，使提交说明紧贴分支轨道
  const svgWidth = X_OFFSET + rowMaxLane * LANE_WIDTH + 8;

  return (
    <svg
      width={svgWidth}
      height={totalRowHeight}
      style={{ overflow: 'visible', display: 'block', flexShrink: 0 }}
    >
      {paths}
      {isMerge ? (
        <g>
          <circle
            cx={cx}
            cy={Y_MID}
            r={5}
            fill="var(--bg-panel, #181818)"
            stroke={cColor}
            strokeWidth={1.8}
          />
          <circle cx={cx} cy={Y_MID} r={2} fill={cColor} />
          {isSelected && (
            <circle
              cx={cx}
              cy={Y_MID}
              r={7.5}
              fill="none"
              stroke={cColor}
              strokeWidth={1.2}
              strokeDasharray="2 2"
              opacity={0.85}
            />
          )}
        </g>
      ) : (
        <g>
          <circle
            cx={cx}
            cy={Y_MID}
            r={4}
            fill={cColor}
            stroke="var(--bg-panel, #181818)"
            strokeWidth={1.5}
          />
          {isSelected && (
            <circle
              cx={cx}
              cy={Y_MID}
              r={7}
              fill="none"
              stroke={cColor}
              strokeWidth={1.2}
              strokeDasharray="2 2"
              opacity={0.85}
            />
          )}
        </g>
      )}
    </svg>
  );
}

function GitGraphExpandSvg({ rowIndex, analysis }: { rowIndex: number; analysis: GraphAnalysis }) {
  const { edges } = analysis;
  const LANE_WIDTH = 12;
  const X_OFFSET = 10;

  // Active passing edges connecting through between rowIndex and rowIndex + 1
  const passingEdges = edges.filter((e) => e.childRow <= rowIndex && rowIndex < e.parentRow);
  const maxActiveLane =
    passingEdges.length > 0 ? Math.max(...passingEdges.map((e) => e.parentLane)) : 0;
  const svgWidth = X_OFFSET + maxActiveLane * LANE_WIDTH + 8;

  return (
    <div style={{ width: svgWidth, flexShrink: 0, position: 'relative', display: 'flex' }}>
      <svg
        width={svgWidth}
        style={{
          width: svgWidth,
          height: '100%',
          display: 'block',
          overflow: 'visible',
        }}
        viewBox={`0 0 ${svgWidth} 100`}
        preserveAspectRatio="none"
      >
        {passingEdges.map((e, idx) => {
          const x = X_OFFSET + e.parentLane * LANE_WIDTH;
          return (
            <line
              key={`exp-${idx}-${x}`}
              x1={x}
              y1={0}
              x2={x}
              y2={100}
              vectorEffect="non-scaling-stroke"
              stroke={e.color}
              strokeWidth={2}
              strokeDasharray={e.isDashed ? '4 3' : undefined}
            />
          );
        })}
      </svg>
    </div>
  );
}

interface GitContextMenuState {
  x: number;
  y: number;
  entry?: GitStatusEntry;
  folderNode?: GitTreeNode;
  isFolder?: boolean;
  staged: boolean;
}

function GitFileContextMenu({
  state,
  onClose,
  onOpenDiff,
  onOpenFile,
  onOpenHeadFile,
  onDiscard,
  onDiscardFolder,
  onToggleStage,
  onToggleStageFolder,
  onAddToGitignore,
  onShowInFolder,
  onRevealInExplorer,
  onViewFileHistory,
}: {
  state: GitContextMenuState;
  onClose: () => void;
  onOpenDiff: (entry: GitStatusEntry, staged: boolean) => void;
  onOpenFile: (path: string) => void;
  onOpenHeadFile: (path: string) => void;
  onDiscard: (path: string) => void;
  onDiscardFolder?: (paths: string[]) => void;
  onToggleStage: (entry: GitStatusEntry, staged: boolean) => void;
  onToggleStageFolder?: (paths: string[], staged: boolean) => void;
  onAddToGitignore: (path: string) => void;
  onShowInFolder: (path: string) => void;
  onRevealInExplorer: (path: string) => void;
  onViewFileHistory: (path: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { entry, folderNode, isFolder, staged } = state;

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const maxH = Math.max(180, window.innerHeight - 20);
    el.style.maxHeight = `${maxH}px`;
    el.style.overflowY = 'auto';

    const rect = el.getBoundingClientRect();
    let { x, y } = state;
    if (x + rect.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - rect.width - 8);
    if (y + rect.height > window.innerHeight - 8) {
      y = Math.max(8, window.innerHeight - rect.height - 8);
    }
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [state]);

  const item = (label: string, onClick: () => void, danger?: boolean) => (
    <button
      type="button"
      className={`ctx-item${danger ? ' danger' : ''}`}
      onClick={() => {
        onClose();
        onClick();
      }}
    >
      {label}
    </button>
  );

  const sep = (key: string) => <div key={key} className="ctx-sep" />;
  const isMac = navigator.userAgent.includes('Mac');

  if (isFolder && folderNode) {
    const folderFiles = collectFolderFiles(folderNode);
    return (
      <div className="ctx-menu" ref={ref} role="menu">
        {item('放弃文件夹下所有更改', () => onDiscardFolder?.(folderFiles), true)}
        {item(
          staged ? '取消暂存文件夹内更改' : '暂存文件夹内更改',
          () => onToggleStageFolder?.(folderFiles, staged),
        )}
        {item('添加到 .gitignore', () =>
          onAddToGitignore(folderNode.path.endsWith('/') ? folderNode.path : `${folderNode.path}/`),
        )}
        {sep('fs1')}
        {item(isMac ? '在访达中显示' : '在资源管理器中显示', () => onShowInFolder(folderNode.path))}
        {item('在资源管理器视图中显示', () => onRevealInExplorer(folderNode.path))}
      </div>
    );
  }

  if (!entry) return null;

  return (
    <div className="ctx-menu" ref={ref} role="menu">
      {item('打开更改', () => onOpenDiff(entry, staged))}
      {item('打开文件', () => onOpenFile(entry.path))}
      {item('打开文件 (HEAD)', () => onOpenHeadFile(entry.path))}
      {sep('s1')}
      {item('放弃更改', () => onDiscard(entry.path), true)}
      {item(staged ? '取消暂存更改' : '暂存更改', () => onToggleStage(entry, staged))}
      {item('添加到 .gitignore', () => onAddToGitignore(entry.path))}
      {sep('s2')}
      {item(isMac ? '在访达中显示' : '在资源管理器中显示', () => onShowInFolder(entry.path))}
      {item('在资源管理器视图中显示', () => onRevealInExplorer(entry.path))}
      {sep('s3')}
      {item('Git: View File History', () => onViewFileHistory(entry.path))}
    </div>
  );
}

export function GitPanel({
  workspaceInfo,
  onPreviewDiff,
  onDiscardPath,
  onOpenFile,
  onViewFileHistory,
  onRevealInExplorer,
  onBranchSwitched,
  refreshNonce,
  onShowToast,
}: Props) {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [commits, setCommits] = useState<GitCommitEntry[]>([]);
  const [historyResult, setHistoryResult] = useState<GitHistoryResult | null>(null);
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  const [selectedCommitFiles, setSelectedCommitFiles] = useState<GitCommitFileChange[]>([]);
  const [loadingDetails, setLoadingDetails] = useState(false);

  // Commit Hover Preview Card 状态
  const [hoveredCommitInfo, setHoveredCommitInfo] = useState<{
    commit: GitCommitEntry;
    rect: DOMRect;
  } | null>(null);
  const [commitDetailsCache, setCommitDetailsCache] = useState<
    Record<string, { stats?: GitCommitStats; body?: string }>
  >({});
  const [loadingPreviewHash, setLoadingPreviewHash] = useState<string | null>(null);
  const [hoveredRowHash, setHoveredRowHash] = useState<string | null>(null);

  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displayMode, setDisplayMode] = useState<'list' | 'tree'>('list');
  const [selectedStatusPath, setSelectedStatusPath] = useState<string | null>(null);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showCommitDropdown, setShowCommitDropdown] = useState(false);
  const [graphHeight, setGraphHeight] = useState(320);
  const [isGraphCollapsed, setIsGraphCollapsed] = useState(false);
  const [fileContextMenu, setFileContextMenu] = useState<GitContextMenuState | null>(null);
  const isMac = useMemo(
    () => typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent || navigator.platform),
    [],
  );

  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreMenuBtnRef = useRef<HTMLButtonElement>(null);
  const commitDropdownRef = useRef<HTMLDivElement>(null);
  const commitDropdownBtnRef = useRef<HTMLButtonElement>(null);

  const graphAnalysis = useMemo(() => analyzeGitGraph(commits), [commits]);

  const handleAutoGenerateCommit = useCallback(() => {
    const allEntries = status?.entries || [];
    if (allEntries.length === 0) {
      onShowToast?.('当前没有检测到工作区改动', undefined, 'info');
      return;
    }
    const files = allEntries.map((e) => e.path);
    const firstFile = files[0] || '';
    const ext = firstFile.split('.').pop() || '';
    const dir = firstFile.split('/')[0] || '';
    let autoMsg = '';
    if (allEntries.length === 1) {
      autoMsg = `chore(${dir || ext || 'core'}): update ${firstFile.split('/').pop()}`;
    } else {
      autoMsg = `feat(${dir || 'workspace'}): update ${allEntries.length} files (${files.slice(0, 2).map((f) => f.split('/').pop()).join(', ')}${allEntries.length > 2 ? ' etc.' : ''})`;
    }
    setMessage(autoMsg);
    onShowToast?.('已根据改动智能生成提交说明', autoMsg, 'success');
  }, [status?.entries, onShowToast]);

  useEffect(() => {
    const handleDocumentClick = (e: MouseEvent) => {
      const target = e.target as Node;

      if (
        showMoreMenu &&
        moreMenuRef.current &&
        !moreMenuRef.current.contains(target) &&
        moreMenuBtnRef.current &&
        !moreMenuBtnRef.current.contains(target)
      ) {
        setShowMoreMenu(false);
      }

      if (
        showCommitDropdown &&
        commitDropdownRef.current &&
        !commitDropdownRef.current.contains(target) &&
        commitDropdownBtnRef.current &&
        !commitDropdownBtnRef.current.contains(target)
      ) {
        setShowCommitDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleDocumentClick);
    return () => {
      document.removeEventListener('mousedown', handleDocumentClick);
    };
  }, [showMoreMenu, showCommitDropdown]);

  const handleCommitAction = async (opts: { amend?: boolean; push?: boolean; sync?: boolean }) => {
    setShowCommitDropdown(false);
    const hasChanges = (status?.entries.length || 0) > 0;
    if (!hasChanges) {
      onShowToast?.('没有需要提交的修改', '工作区非常干净', 'info');
      return;
    }

    setBusy(true);
    onShowToast?.('正在处理 Git 提交...', undefined, 'info');

    try {
      // 1. Auto stage if nothing is staged yet
      const stagedEntries = status?.entries.filter((e) => e.staged) || [];
      if (stagedEntries.length === 0) {
        const allPaths = status?.entries.map((e) => e.path) || [];
        await window.ide.gitStage(allPaths);
      }

      // 2. Commit message
      const msg = message.trim() || prompt('请输入提交信息 (Commit Message):') || 'Update';

      // 3. Perform Git Commit
      const res = await window.ide.gitCommit(msg, opts.amend);
      if (!res.ok) {
        onShowToast?.('✕ 提交失败', res.detail || 'Git commit 发生错误', 'error');
        return;
      }

      setMessage('');
      onPreviewDiff(null);

      // 4. Perform Push or Sync if requested
      if (opts.sync) {
        onShowToast?.('✓ 提交成功，正在同步 (Pull & Push)...', undefined, 'info');
        const p = await window.ide.gitPull();
        if (!p.ok) {
          onShowToast?.('⚠️ 拉取最新代码失败', p.detail, 'warn');
        }
        const pushRes = await window.ide.gitPush();
        if (pushRes.ok) {
          onShowToast?.('✓ 提交和同步完成', '代码已与远程仓库同步', 'success');
        } else {
          onShowToast?.('✕ 同步推送失败', pushRes.detail, 'error');
        }
      } else if (opts.push) {
        onShowToast?.('✓ 提交成功，正在推送...', undefined, 'info');
        const pushRes = await window.ide.gitPush();
        if (pushRes.ok) {
          onShowToast?.('✓ 提交和推送完成', '代码已成功推送至远程仓库', 'success');
        } else {
          onShowToast?.('✕ 推送失败', pushRes.detail, 'error');
        }
      } else {
        onShowToast?.('✓ 提交成功', `分支: ${status?.branch || 'master'}`, 'success');
      }

      await refresh();
    } catch (err: any) {
      onShowToast?.('✕ 提交异常', err.message || String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const runGitAction = async (
    title: string,
    action: () => Promise<{ ok: boolean; detail?: string }>,
    successMsg?: string,
  ) => {
    setShowMoreMenu(false);
    onShowToast?.(`正在执行: ${title}...`, undefined, 'info');
    setBusy(true);
    try {
      const res = await action();
      if (res.ok) {
        onShowToast?.(`✓ ${title}成功`, res.detail || successMsg || '操作已完成', 'success');
        await refresh();
        if (
          title.includes('分支') ||
          title.includes('签出') ||
          title.includes('Pull') ||
          title.includes('拉取')
        ) {
          onBranchSwitched?.();
        }
      } else {
        onShowToast?.(`✕ ${title}失败`, res.detail || '操作未能完成', 'error');
      }
    } catch (err: any) {
      onShowToast?.(`✕ ${title}异常`, err.message || String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async (target: string | string[]) => {
    if (typeof target === 'string') {
      setSelectedStatusPath(target);
    }
    setBusy(true);
    try {
      if (onDiscardPath) {
        await onDiscardPath(target);
      } else {
        const isArray = Array.isArray(target);
        const paths = isArray
          ? target
          : !target || target === '.' || target === 'ALL' || target === 'all'
            ? ['.']
            : [target];
        await window.ide.gitDiscard(paths);
      }
      onShowToast?.('✓ 已放弃更改', '已还原选定的修改', 'success');
      await refresh();
    } catch (err: any) {
      onShowToast?.('✕ 放弃更改失败', err.message || String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleGraphResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = graphHeight;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = startY - moveEvent.clientY;
      const newHeight = Math.max(80, Math.min(600, startHeight + deltaY));
      setGraphHeight(newHeight);
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleSelectCommit = async (hash: string) => {
    if (selectedCommitHash === hash) {
      setSelectedCommitHash(null);
      setSelectedCommitFiles([]);
      return;
    }
    setSelectedCommitHash(hash);
    setLoadingDetails(true);
    try {
      const detail = await window.ide.gitCommitDetails(hash);
      if (detail.ok) {
        setSelectedCommitFiles(detail.files);
        if (detail.stats || detail.commit?.body) {
          setCommitDetailsCache((prev) => ({
            ...prev,
            [hash]: {
              stats: detail.stats,
              body: detail.commit?.body,
            },
          }));
        }
      } else {
        setSelectedCommitFiles([]);
      }
    } catch {
      setSelectedCommitFiles([]);
    } finally {
      setLoadingDetails(false);
    }
  };

  const handleRowMouseEnter = (commit: GitCommitEntry, el: HTMLElement) => {
    setHoveredRowHash(commit.hash);
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
    }
    hoverTimerRef.current = setTimeout(async () => {
      const rect = el.getBoundingClientRect();
      const cached = commitDetailsCache[commit.hash];
      const enrichedCommit: GitCommitEntry = {
        ...commit,
        body: cached?.body || commit.body || commit.message,
        stats: cached?.stats || commit.stats,
      };
      setHoveredCommitInfo({ commit: enrichedCommit, rect });

      if (!cached?.stats && !commit.stats) {
        setLoadingPreviewHash(commit.hash);
        try {
          const detail = await window.ide.gitCommitDetails(commit.hash);
          if (detail.ok) {
            const newStats = detail.stats || {
              filesChanged: detail.files.length,
              insertions: 0,
              deletions: 0,
            };
            const newBody = detail.commit?.body || detail.commit?.message || commit.message;
            setCommitDetailsCache((prev) => ({
              ...prev,
              [commit.hash]: { stats: newStats, body: newBody },
            }));
            setHoveredCommitInfo((current) => {
              if (current && current.commit.hash === commit.hash) {
                return {
                  ...current,
                  commit: {
                    ...current.commit,
                    body: newBody,
                    stats: newStats,
                  },
                };
              }
              return current;
            });
          }
        } catch {
          // ignore
        } finally {
          setLoadingPreviewHash((cur) => (cur === commit.hash ? null : cur));
        }
      }
    }, 200);
  };

  const handleRowMouseLeave = (commit: GitCommitEntry) => {
    setHoveredRowHash((cur) => (cur === commit.hash ? null : cur));
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    closeTimerRef.current = setTimeout(() => {
      setHoveredCommitInfo(null);
    }, 180);
  };

  const handleCardMouseEnter = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const handleCardMouseLeave = () => {
    closeTimerRef.current = setTimeout(() => {
      setHoveredCommitInfo(null);
    }, 150);
  };

  const handlePreviewCommitFile = async (hash: string, filePath: string) => {
    const res = await window.ide.gitShowCommitDiff(hash, filePath);
    if (res.ok) {
      onPreviewDiff({
        id: `git:commit:${hash}:${filePath}`,
        path: res.path,
        original: res.original,
        modified: res.modified,
        description: `Commit ${hash.slice(0, 7)}`,
      });
    }
  };

  const refresh = useCallback(async () => {
    if (!workspaceInfo?.root) {
      setStatus(null);
      setBranches([]);
      setCommits([]);
      return;
    }
    const [st, br, hist] = await Promise.all([
      window.ide.gitStatus(),
      window.ide.gitBranches(),
      window.ide.gitHistory(),
    ]);

    setStatus(st);
    if (br.ok) setBranches(br.branches.filter((b) => !b.remote));
    else setBranches([]);

    setHistoryResult(hist);
    if (hist.ok) setCommits(hist.commits);
    else setCommits([]);

    if (!st.ok && st.detail) setError(st.detail);
    else if (!hist.ok && hist.detail && !hist.emptyRepo) setError(hist.detail);
    else setError(null);
  }, [workspaceInfo]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 8000);
    const unbind = window.ide.onGitBranchSwitched?.(() => {
      void refresh();
    });
    return () => {
      clearInterval(timer);
      unbind?.();
    };
  }, [refresh, refreshNonce]);

  const runOp = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const preview = async (entry: GitStatusEntry, staged: boolean) => {
    setSelectedStatusPath(entry.path);
    if (onOpenFile) {
      onOpenFile(entry.path);
    }
    const res = await window.ide.gitDiff(entry.path, staged);
    if (res.ok) {
      onPreviewDiff({
        id: `${staged ? 'staged' : 'working'}:${entry.path}`,
        path: entry.path,
        original: res.original,
        modified: res.modified,
        description: `${staged ? 'Staged' : 'Working'} — ${entry.path}`,
      });
    }
  };

  const handleContextMenu = (e: React.MouseEvent, entry: GitStatusEntry, staged: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedStatusPath(entry.path);
    setFileContextMenu({
      x: e.clientX,
      y: e.clientY,
      entry,
      isFolder: false,
      staged,
    });
  };

  const handleFolderContextMenu = (e: React.MouseEvent, node: GitTreeNode, staged: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedStatusPath(node.path);
    setFileContextMenu({
      x: e.clientX,
      y: e.clientY,
      folderNode: node,
      isFolder: true,
      staged,
    });
  };

  const handleOpenHeadFile = async (path: string) => {
    try {
      const res = await window.ide.gitDiff(path, false);
      if (res.ok) {
        onPreviewDiff({
          id: `head:${path}`,
          path,
          original: res.original,
          modified: res.original,
          description: `${path} (HEAD)`,
        });
      } else {
        onShowToast?.(`无法读取 HEAD 版本: ${res.detail || '未知错误'}`);
      }
    } catch (err: any) {
      onShowToast?.(`读取 HEAD 版本失败: ${err?.message || String(err)}`);
    }
  };

  const handleAddToGitignore = async (relPath: string) => {
    try {
      let current = '';
      try {
        current = await window.ide.readFile('.gitignore');
      } catch {
        current = '';
      }
      const lines = current.split(/\r?\n/).map((l) => l.trim());
      if (lines.includes(relPath)) {
        onShowToast?.(`${relPath} 已存在于 .gitignore 中`);
        return;
      }
      const updated = current.endsWith('\n') || current.length === 0 ? `${current}${relPath}\n` : `${current}\n${relPath}\n`;
      await window.ide.writeFile('.gitignore', updated);
      onShowToast?.(`已将 ${relPath} 添加到 .gitignore`);
      void refresh();
    } catch (err: any) {
      onShowToast?.(`添加 .gitignore 失败: ${err?.message || String(err)}`);
    }
  };

  const handleShowInNativeFolder = async (relPath: string) => {
    try {
      const absPath = await window.ide.resolveAbsolutePath(relPath);
      await window.ide.showItemInFolder(absPath);
    } catch (err: any) {
      onShowToast?.(`在资源管理器中显示失败: ${err?.message || String(err)}`);
    }
  };

  if (!workspaceInfo?.root) {
    return <div className="git-panel-empty">打开工作区以使用 Source Control</div>;
  }

  if (status && !status.isRepo) {
    return (
      <div
        className="git-panel"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          padding: '24px 20px',
          textAlign: 'center',
          boxSizing: 'border-box',
          gap: 16,
          userSelect: 'none',
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            background: 'var(--bg-elevated, rgba(255, 255, 255, 0.05))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px solid var(--border)',
            color: 'var(--accent, #6a4da2)',
          }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <circle cx="18" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <path d="M6 9v12" />
            <path d="M18 9a9 9 0 0 0-9 9" />
          </svg>
        </div>

        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
            {status.detail ? 'Git 访问或仓库检测异常' : '尚未启用 Git 版本控制'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5, maxWidth: 260 }}>
            {status.detail ? (
              <div
                style={{
                  color: '#e5a54b',
                  wordBreak: 'break-all',
                  background: 'rgba(229, 165, 75, 0.1)',
                  padding: '8px 10px',
                  borderRadius: 4,
                  border: '1px solid rgba(229, 165, 75, 0.25)',
                  textAlign: 'left',
                }}
              >
                {status.detail}
              </div>
            ) : (
              '当前工作区不是 Git 仓库。初始化仓库后即可享受版本回滚、差异比对、分支管理等全部功能。'
            )}
          </div>
        </div>

        <div
          style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 220 }}
        >
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await window.ide.gitInit();
                if (res.ok) {
                  await refresh();
                } else {
                  alert(res.detail || '初始化仓库失败');
                }
              } finally {
                setBusy(false);
              }
            }}
            style={{
              padding: '8px 14px',
              fontSize: 12,
              fontWeight: 600,
              background: 'var(--accent, #6a4da2)',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.6 : 1,
              transition: 'filter 0.15s ease',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.filter = 'brightness(1.15)')}
            onMouseLeave={(e) => (e.currentTarget.style.filter = 'none')}
          >
            {busy ? '正在初始化…' : '初始化 Git 仓库'}
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => void refresh()}
            style={{
              padding: '6px 14px',
              fontSize: 11,
              background: 'transparent',
              color: 'var(--muted)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--text)';
              e.currentTarget.style.borderColor = 'var(--accent)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--muted)';
              e.currentTarget.style.borderColor = 'var(--border)';
            }}
          >
            重新检查状态
          </button>
        </div>
      </div>
    );
  }

  const staged = status?.entries.filter((f: GitStatusEntry) => f.staged) || [];
  const working = status?.entries.filter((f: GitStatusEntry) => !f.staged && !f.untracked) || [];
  const untracked = status?.entries.filter((f: GitStatusEntry) => f.untracked) || [];

  return (
    <div
      className="git-panel"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        position: 'relative',
      }}
    >
      {/* 1. Header Line - Height 30px matching Search & Explorer */}
      <div
        className="git-panel-header"
        style={{
          padding: '0 10px',
          height: 30,
          boxSizing: 'border-box',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--text)',
            letterSpacing: '0.05em',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span className="chevron" style={{ fontSize: 12, color: 'rgba(255, 255, 255, 0.75)' }}>
            ▾
          </span>{' '}
          源代码
        </div>

        {/* Header Actions: 1. Tree structure toggle, 2. Refresh, 3. More (...) dropdown */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            className={`panel-action-btn ${displayMode === 'tree' ? 'active' : ''}`}
            title={displayMode === 'list' ? '按树结构显示' : '按列表显示'}
            onClick={() => setDisplayMode((m) => (m === 'list' ? 'tree' : 'list'))}
          >
            {displayMode === 'tree' ? (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 4h4v4H4zM12 16h4v4h-4zM12 8h8M12 8v12M8 6h4" />
              </svg>
            ) : (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="panel-action-btn"
            title="刷新"
            onClick={() => void refresh()}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
          <button
            ref={moreMenuBtnRef}
            type="button"
            className={`panel-action-btn ${showMoreMenu ? 'active' : ''}`}
            title="更多操作"
            onClick={() => setShowMoreMenu((v) => !v)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm8 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm8 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* 2. More (...) Dropdown Context Menu matching screenshot */}
      {showMoreMenu && (
        <div ref={moreMenuRef} onClick={() => setShowMoreMenu(false)} className="git-more-menu">
          <div
            className="git-more-menu-item"
            onClick={() => setDisplayMode((m) => (m === 'tree' ? 'list' : 'tree'))}
          >
            <span>查看和排序 ({displayMode === 'tree' ? '树状' : '列表'})</span>
            <span className="chev">▸</span>
          </div>
          <div className="git-more-menu-sep" />

          <div className="git-more-menu-heading">同步</div>

          {/* 拉取 */}
          <div
            className="git-more-menu-item"
            onClick={() => void runGitAction('Git 拉取', () => window.ide.gitPull())}
          >
            拉取
          </div>

          {/* 推送 */}
          <div
            className="git-more-menu-item"
            onClick={() => void runGitAction('Git 推送', () => window.ide.gitPush())}
          >
            推送
          </div>

          {/* 拉取，推送 */}
          <div
            className="git-more-menu-item"
            onClick={() =>
              void runGitAction('Git 同步 (Pull & Push)', async () => {
                const p = await window.ide.gitPull();
                if (!p.ok) return p;
                return window.ide.gitPush();
              })
            }
          >
            <span>拉取，推送</span>
            <span className="chev">▸</span>
          </div>

          {/* 抓取 */}
          <div
            className="git-more-menu-item"
            onClick={() => void runGitAction('Git 抓取 (Fetch)', () => window.ide.gitFetch())}
          >
            抓取
          </div>

          <div className="git-more-menu-sep" />

          <div className="git-more-menu-heading">仓库</div>

          {/* 克隆 */}
          <div
            className="git-more-menu-item"
            onClick={() =>
              void runGitAction('Git 克隆', async () => {
                const url = prompt('请输入 Git 远程仓库地址 (URL):');
                if (!url?.trim()) return { ok: false, detail: '取消输入' };
                return window.ide.cloneRepo({
                  url: url.trim(),
                  parentDir: workspaceInfo?.root || '',
                });
              })
            }
          >
            克隆
          </div>

          {/* 远程 */}
          <div
            className="git-more-menu-item"
            onClick={() =>
              void runGitAction('Git 远程仓库', async () => {
                const res = await window.ide.gitRemotes();
                if (!res.ok) return res;
                if (res.remotes.length === 0) {
                  return { ok: true, detail: '当前项目尚未配置任何远程仓库' };
                }
                const detail = res.remotes.map((r) => `${r.name} → ${r.url}`).join('\n');
                return { ok: true, detail };
              })
            }
          >
            <span>远程</span>
            <span className="chev">▸</span>
          </div>

          {/* 分支 */}
          <div
            className="git-more-menu-item"
            onClick={() =>
              void runGitAction('新建分支', async () => {
                const b = prompt('请输入新分支名称:');
                if (!b?.trim()) return { ok: false, detail: '取消输入' };
                return window.ide.gitCreateBranch(b.trim(), true);
              })
            }
          >
            <span>分支 (新建分支)</span>
            <span className="chev">▸</span>
          </div>

          {/* 签出到... */}
          <div
            className="git-more-menu-item"
            onClick={() =>
              void runGitAction('Git 切换分支', async () => {
                const br = prompt('请输入要签出的目标分支名:');
                if (!br?.trim()) return { ok: false, detail: '取消输入' };
                return window.ide.gitCheckout(br.trim());
              })
            }
          >
            签出到...
          </div>

          {/* 标记 */}
          <div
            className="git-more-menu-item"
            onClick={() =>
              void runGitAction('创建 Git Tag 标记', async () => {
                const tag = prompt('请输入标签名称 (Tag name, 如 v1.0.0):');
                if (!tag?.trim()) return { ok: false, detail: '取消输入' };
                const msg = prompt('请输入标签说明 (可选):');
                return window.ide.gitCreateTag(tag.trim(), msg?.trim() || undefined);
              })
            }
          >
            <span>标记 (Tag)</span>
            <span className="chev">▸</span>
          </div>

          <div className="git-more-menu-sep" />

          <div className="git-more-menu-heading">本地变更</div>

          {/* 提交 */}
          <div
            className="git-more-menu-item"
            onClick={() =>
              void runGitAction('Git 提交', async () => {
                const msg = message.trim() || prompt('请输入提交信息 (Commit Message):');
                if (!msg) return { ok: false, detail: '提交信息不能为空' };
                return window.ide.gitCommit(msg);
              })
            }
          >
            <span>提交</span>
            <span className="chev">▸</span>
          </div>

          {/* 存储 */}
          <div
            className="git-more-menu-item"
            onClick={() =>
              void runGitAction('Git 存储 (Stash)', async () => {
                const entries = status?.entries || [];
                if (entries.length === 0) {
                  return { ok: true, detail: '工作区干净，没有需要暂存 (stash) 的修改' };
                }
                const res = await window.ide.gitStash('push', message?.trim() || undefined);
                if (!res.ok) return res;
                const count = res.stashes?.length ?? 0;
                return { ok: true, detail: `已存入 ${count} 个 stash` };
              })
            }
          >
            <span>存储 (Stash)</span>
            <span className="chev">▸</span>
          </div>

          {/* 更改 */}
          <div
            className="git-more-menu-item"
            onClick={() =>
              void runGitAction('放弃全部修改', async () => {
                if (!confirm('确定要放弃工作区中的所有修改吗？此操作不可逆！')) {
                  return { ok: false, detail: '取消放弃修改' };
                }
                if (onDiscardPath) {
                  await onDiscardPath('');
                } else {
                  await window.ide.gitDiscard(['.']);
                }
                return { ok: true, detail: '已放弃所有本地修改' };
              })
            }
          >
            <span>更改 (放弃所有修改)</span>
            <span className="chev">▸</span>
          </div>

          {/* 工作树 */}
          <div
            className="git-more-menu-item"
            onClick={() =>
              void runGitAction('Git 工作树', async () => {
                const res = await window.ide.gitStatus();
                const detail = res.ok
                  ? `当前分支 ${res.branch || 'main'}，${
                      res.entries.length ? `有 ${res.entries.length} 项变动` : '工作树干净 (Clean)'
                    }`
                  : res.detail || '无法读取工作树状态';
                return { ok: res.ok, detail };
              })
            }
          >
            <span>工作树</span>
            <span className="chev">▸</span>
          </div>

          <div className="git-more-menu-sep" />

          {/* 显示 GIT 输出 */}
          <div
            className="git-more-menu-item"
            onClick={() =>
              void runGitAction('GIT 输出日志', async () => {
                const res = await window.ide.gitOutput(50);
                if (!res.ok) return res;
                if (res.lines.length === 0) return { ok: true, detail: '暂无 git 输出记录' };
                return { ok: true, detail: res.lines.join('\n') };
              })
            }
          >
            显示 GIT 输出
          </div>
        </div>
      )}

      {/* 3. Commit Input Box */}
      <div
        style={{
          padding: '8px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <input
            className="git-commit-input"
            style={{
              width: '100%',
              height: 32,
              boxSizing: 'border-box',
              padding: '4px 106px 4px 10px',
              background: 'var(--bg-lighter, #12161c)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: 'var(--text)',
              outline: 'none',
              fontSize: 12,
            }}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={`消息(${isMac ? '⌘Enter' : 'Ctrl+Enter'} 在“${status?.branch || 'main'}”提交)`}
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                void runOp(async () => {
                  const res = await window.ide.gitCommit(message);
                  if (res.ok) {
                    setMessage('');
                    onPreviewDiff(null);
                  }
                  return res;
                });
              }
            }}
          />
          <button
            type="button"
            className="git-ai-commit-btn"
            title="AI 智能生成规范 Commit 提交说明"
            onClick={handleAutoGenerateCommit}
          >
            <span>Generate</span>
            <svg
              className="git-ai-commit-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M11 2C11 6.5 14.5 10 19 10C14.5 10 11 13.5 11 18C11 13.5 7.5 10 3 10C7.5 10 11 6.5 11 2Z" />
              <path d="M19 15C19 17 20.5 18.5 22.5 18.5C20.5 18.5 19 20 19 22C19 20 17.5 18.5 15.5 18.5C17.5 18.5 19 17 19 15Z" strokeWidth="1.8" />
            </svg>
          </button>
        </div>

        <div style={{ display: 'flex', width: '100%', position: 'relative' }}>
          <button
            type="button"
            className="git-commit-btn"
            style={{
              flex: 1,
              height: 32,
              padding: '0 12px',
              background: 'var(--accent, #007acc)',
              border: 'none',
              borderRadius: '4px 0 0 4px',
              color: '#fff',
              cursor: busy || (status?.entries.length || 0) === 0 ? 'not-allowed' : 'pointer',
              opacity: busy || (status?.entries.length || 0) === 0 ? 0.6 : 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              fontSize: 13,
              fontWeight: 500,
            }}
            disabled={busy || (status?.entries.length || 0) === 0}
            onClick={() => void handleCommitAction({})}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>提交</span>
          </button>
          <button
            ref={commitDropdownBtnRef}
            type="button"
            className="git-commit-dropdown-btn"
            title="更多提交选项"
            onClick={(e) => {
              e.stopPropagation();
              setShowCommitDropdown((v) => !v);
            }}
            style={{
              height: 32,
              padding: '0 12px',
              background: 'var(--accent, #007acc)',
              border: 'none',
              borderLeft: '1px solid rgba(255, 255, 255, 0.4)',
              borderRadius: '0 4px 4px 0',
              color: '#fff',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {/* Commit Options Dropdown matching Screenshot 2 */}
          {showCommitDropdown && (
            <div
              ref={commitDropdownRef}
              style={{
                position: 'absolute',
                top: 36,
                right: 0,
                zIndex: 1000,
                background: 'var(--bg-lighter, #252526)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                width: 140,
                padding: 4,
                fontSize: 12,
                color: 'var(--text)',
              }}
            >
              <button
                type="button"
                className="git-commit-dropdown-item"
                onClick={() => void handleCommitAction({})}
              >
                提交
              </button>
              <button
                type="button"
                className="git-commit-dropdown-item"
                onClick={() => void handleCommitAction({ amend: true })}
              >
                提交 (修改)
              </button>
              <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
              <button
                type="button"
                className="git-commit-dropdown-item"
                onClick={() => void handleCommitAction({ push: true })}
              >
                提交和推送
              </button>
              <button
                type="button"
                className="git-commit-dropdown-item"
                onClick={() => void handleCommitAction({ sync: true })}
              >
                提交和同步
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Error Message Alert */}
      {error && (
        <div
          style={{
            padding: '6px 12px',
            background: 'rgba(244, 67, 54, 0.1)',
            color: '#f44336',
            fontSize: 11,
          }}
        >
          {error}
        </div>
      )}

      {/* 4. Scrollable Sections (Staged, Working, Untracked) */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {/* Staged Section */}
        {staged.length > 0 && (
          <div style={{ borderBottom: '1px solid var(--border)' }}>
            <div
              style={{
                padding: '4px 12px',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--muted)',
                background: 'rgba(255,255,255,0.02)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>已暂存的更改</span>
                <span className="git-count-badge staged">{staged.length}</span>
              </span>
              <button
                type="button"
                className="panel-text-btn"
                title="取消暂存当前所有更改"
                onClick={() =>
                  void runOp(() => window.ide.gitUnstage(staged.map((e: GitStatusEntry) => e.path)))
                }
              >
                取消暂存全部
              </button>
            </div>
            {displayMode === 'tree'
              ? buildGitTree(staged).map((node) => (
                  <GitTreeItemView
                    key={node.path}
                    node={node}
                    staged={true}
                    selectedPath={selectedStatusPath}
                    onSelectPath={setSelectedStatusPath}
                    onPreview={(f) => void preview(f, true)}
                    onDiscard={(p) => void handleDiscard(p)}
                    onUnstage={(p) => void runOp(() => window.ide.gitUnstage([p]))}
                    onOpenFile={onOpenFile}
                    onContextMenu={handleContextMenu}
                    onFolderContextMenu={handleFolderContextMenu}
                  />
                ))
              : staged.map((f: GitStatusEntry) => (
                  <GitFileListItemView
                    key={f.path}
                    entry={f}
                    staged={true}
                    selectedPath={selectedStatusPath}
                    onSelectPath={setSelectedStatusPath}
                    onPreview={(entry, s) => void preview(entry, s)}
                    onDiscard={(p) => void handleDiscard(p)}
                    onUnstage={(p) => void runOp(() => window.ide.gitUnstage([p]))}
                    onOpenFile={onOpenFile}
                    onContextMenu={handleContextMenu}
                  />
                ))}
          </div>
        )}

        {/* Working Section */}
        {working.length > 0 && (
          <div style={{ borderBottom: '1px solid var(--border)' }}>
            <div
              style={{
                padding: '4px 12px',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--muted)',
                background: 'rgba(255,255,255,0.02)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>更改</span>
                <span className="git-count-badge working">{working.length}</span>
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  title="放弃所有更改"
                  onClick={() => void handleDiscard(working.map((e: GitStatusEntry) => e.path))}
                  className="panel-action-btn"
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="panel-text-btn"
                  title="暂存当前所有更改"
                  onClick={() =>
                    void runOp(() =>
                      window.ide.gitStage(working.map((e: GitStatusEntry) => e.path)),
                    )
                  }
                >
                  暂存全部
                </button>
              </div>
            </div>

            {displayMode === 'tree'
              ? buildGitTree(working).map((node) => (
                  <GitTreeItemView
                    key={node.path}
                    node={node}
                    staged={false}
                    selectedPath={selectedStatusPath}
                    onSelectPath={setSelectedStatusPath}
                    onPreview={(f) => void preview(f, false)}
                    onDiscard={(p) => void handleDiscard(p)}
                    onStage={(p) => void runOp(() => window.ide.gitStage([p]))}
                    onOpenFile={onOpenFile}
                    onContextMenu={handleContextMenu}
                    onFolderContextMenu={handleFolderContextMenu}
                  />
                ))
              : working.map((f: GitStatusEntry) => (
                  <GitFileListItemView
                    key={f.path}
                    entry={f}
                    staged={false}
                    selectedPath={selectedStatusPath}
                    onSelectPath={setSelectedStatusPath}
                    onPreview={(entry, s) => void preview(entry, s)}
                    onDiscard={(p) => void handleDiscard(p)}
                    onStage={(p) => void runOp(() => window.ide.gitStage([p]))}
                    onOpenFile={onOpenFile}
                    onContextMenu={handleContextMenu}
                  />
                ))}
          </div>
        )}

        {/* Untracked Section */}
        {untracked.length > 0 && (
          <div style={{ borderBottom: '1px solid var(--border)' }}>
            <div
              style={{
                padding: '4px 12px',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--muted)',
                background: 'rgba(255,255,255,0.02)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span>未跟踪的文件 ({untracked.length})</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  title="放弃所有未跟踪更改"
                  onClick={() => void handleDiscard(untracked.map((e: GitStatusEntry) => e.path))}
                  className="panel-action-btn"
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="panel-text-btn"
                  title="暂存所有未跟踪文件"
                  onClick={() =>
                    void runOp(() =>
                      window.ide.gitStage(untracked.map((e: GitStatusEntry) => e.path)),
                    )
                  }
                >
                  暂存全部
                </button>
              </div>
            </div>

            {displayMode === 'tree'
              ? buildGitTree(untracked).map((node) => (
                  <GitTreeItemView
                    key={node.path}
                    node={node}
                    staged={false}
                    selectedPath={selectedStatusPath}
                    onSelectPath={setSelectedStatusPath}
                    onPreview={(f) => void preview(f, false)}
                    onDiscard={(p) => void handleDiscard(p)}
                    onStage={(p) => void runOp(() => window.ide.gitStage([p]))}
                    onOpenFile={onOpenFile}
                    onContextMenu={handleContextMenu}
                    onFolderContextMenu={handleFolderContextMenu}
                  />
                ))
              : untracked.map((f: GitStatusEntry) => (
                  <GitFileListItemView
                    key={f.path}
                    entry={f}
                    staged={false}
                    selectedPath={selectedStatusPath}
                    onSelectPath={setSelectedStatusPath}
                    onPreview={(entry, s) => void preview(entry, s)}
                    onDiscard={(p) => void handleDiscard(p)}
                    onStage={(p) => void runOp(() => window.ide.gitStage([p]))}
                    onOpenFile={onOpenFile}
                    onContextMenu={handleContextMenu}
                  />
                ))}
          </div>
        )}
      </div>

      {/* 5. Drag Splitter Handle */}
      <div
        className="splitter splitter-h"
        onMouseDown={handleGraphResizeStart}
        style={{ cursor: 'row-resize', height: 4, margin: 0, minHeight: 4 }}
        title="上下拖动调整图形高度"
      />

      {/* 6. Resizable 图形 Section - Git Commit Graph (VS Code Style) */}
      <div
        style={{
          height: isGraphCollapsed ? 'auto' : graphHeight,
          display: 'flex',
          flexDirection: 'column',
          minHeight: isGraphCollapsed ? 'auto' : 80,
        }}
      >
        <div
          onClick={() => setIsGraphCollapsed((v) => !v)}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0 10px',
            background: 'rgba(255, 255, 255, 0.02)',
            borderBottom: '1px solid var(--border)',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--muted)',
            height: 30,
            minHeight: 30,
            boxSizing: 'border-box',
            cursor: 'pointer',
            userSelect: 'none',
            position: 'relative',
            zIndex: 1,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="chevron" style={{ fontSize: 11, color: 'var(--muted)', width: 10 }}>
              {isGraphCollapsed ? '›' : '▾'}
            </span>
            <span style={{ color: 'var(--text)', fontWeight: 600 }}>图形</span>
            <span style={{ fontSize: 10, color: 'var(--muted)', opacity: 0.8 }}>
              ({commits.length})
            </span>
          </div>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 自动状态指示 */}
            <button
              type="button"
              className="panel-action-btn active"
              style={{
                height: 24,
                minWidth: 44,
                padding: '0 6px',
                fontSize: 11,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                color: 'var(--accent, #58a6ff)',
                fontWeight: 500,
              }}
              title="自动同步状态"
              onClick={() => void refresh()}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2m0 16v2M2 12h2m16 0h2" />
              </svg>
              自动
            </button>

            {/* 聚焦 HEAD 图标 */}
            <button
              type="button"
              onClick={() => {
                onShowToast?.('聚焦当前分支', `当前分支: ${status?.branch || 'HEAD'}`, 'info');
              }}
              title="聚焦当前分支"
              className="panel-action-btn"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="3" fill="currentColor" />
              </svg>
            </button>

            {/* 新建/切换分支图标 */}
            <button
              type="button"
              onClick={() =>
                void runGitAction('新建分支', async () => {
                  const b = prompt('请输入新分支名称:');
                  if (!b?.trim()) return { ok: false, detail: '取消输入' };
                  return window.ide.gitCreateBranch(b.trim(), true);
                })
              }
              title="新建分支"
              className="panel-action-btn"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
            </button>

            {/* 同步 / 拉取图标 */}
            <button
              type="button"
              onClick={() => void runGitAction('拉取更改 (Pull)', () => window.ide.gitPull())}
              title="拉取与同步 (Pull)"
              className="panel-action-btn"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M7 16V4m0 0L3 8m4-4l4 4" />
                <path d="M17 8v12m0 0l4-4m-4 4l-4-4" />
              </svg>
            </button>

            {/* 刷新图谱图标 */}
            <button
              type="button"
              onClick={() => void refresh()}
              title="刷新提交图谱"
              className="panel-action-btn"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>

            {/* 更多操作图标 */}
            <button
              type="button"
              ref={moreMenuBtnRef}
              onClick={(e) => {
                e.stopPropagation();
                setShowMoreMenu((v) => !v);
              }}
              title="更多操作..."
              className={`panel-action-btn ${showMoreMenu ? 'active' : ''}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="5" cy="12" r="2" />
                <circle cx="12" cy="12" r="2" />
                <circle cx="19" cy="12" r="2" />
              </svg>
            </button>
          </div>
        </div>

        {!isGraphCollapsed && (
          <div
            onScroll={() => {
              if (hoveredCommitInfo) setHoveredCommitInfo(null);
            }}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '2px 0',
              fontSize: 12,
              display: 'flex',
              flexDirection: 'column',
              position: 'relative',
            }}
          >
            {commits.length > 0 ? (
              commits.map((c, i) => {
                const isSelected = selectedCommitHash === c.hash;
                const isHovered = hoveredRowHash === c.hash;
                const isHead = i === 0;

                return (
                  <div key={c.hash} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                    <div
                      onClick={() => void handleSelectCommit(c.hash)}
                      onMouseEnter={(e) => handleRowMouseEnter(c, e.currentTarget)}
                      onMouseLeave={() => handleRowMouseLeave(c)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        height: 26,
                        cursor: 'pointer',
                        background: isSelected
                          ? 'var(--bg-hover, rgba(255, 255, 255, 0.08))'
                          : isHovered
                            ? 'rgba(255, 255, 255, 0.04)'
                            : 'transparent',
                        userSelect: 'none',
                        paddingRight: 10,
                        transition: 'background 0.1s ease',
                      }}
                      className="search-result-item"
                    >
                      {/* SVG Branch Rails & Nodes */}
                      <GitGraphRowSvg
                        rowIndex={i}
                        commit={c}
                        analysis={graphAnalysis}
                        totalRowHeight={26}
                        isSelected={isSelected}
                      />

                      {/* Commit Message */}
                      <span
                        style={{
                          color: isSelected ? 'var(--text-bright, #fff)' : 'var(--text)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          flex: 1,
                          whiteSpace: 'nowrap',
                          fontSize: 12,
                          marginLeft: 4,
                          letterSpacing: '0.1px',
                        }}
                      >
                        {c.message}
                      </span>

                      {/* Branch Badge (HEAD / Current Branch) */}
                      {isHead && (
                        <span
                          style={{
                            background: '#f57c00',
                            color: '#fff',
                            fontSize: 10,
                            padding: '1px 6px',
                            borderRadius: 10,
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                            marginLeft: 6,
                          }}
                        >
                          {status?.branch || 'HEAD'}
                        </span>
                      )}

                      {/* 悬停/选中时显示的快速查看变更图标小按钮 */}
                      {(isHovered || isSelected) && (
                        <button
                          type="button"
                          title="查看文件变更明细"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleSelectCommit(c.hash);
                          }}
                          className="panel-action-btn"
                          style={{
                            margin: '0 4px',
                            minWidth: 20,
                            height: 20,
                            padding: 2,
                          }}
                        >
                          <svg
                            width="13"
                            height="13"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                          >
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                            <line x1="16" y1="13" x2="8" y2="13" />
                            <line x1="16" y1="17" x2="8" y2="17" />
                            <line x1="10" y1="9" x2="8" y2="9" />
                          </svg>
                        </button>
                      )}

                      {/* Author */}
                      <span
                        style={{
                          color: 'var(--muted)',
                          fontSize: 11,
                          whiteSpace: 'nowrap',
                          marginLeft: 8,
                          opacity: 0.85,
                          maxWidth: 90,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {c.author}
                      </span>
                    </div>

                    {/* Expandable File Changes Detail for Selected Commit */}
                    {isSelected && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'stretch',
                          background: 'rgba(255, 255, 255, 0.015)',
                        }}
                      >
                        {/* 保持 Git 分支连线在展开区域连续不中断 */}
                        <GitGraphExpandSvg rowIndex={i} analysis={graphAnalysis} />

                        {/* 变更文件明细卡片 */}
                        <div
                          style={{
                            flex: 1,
                            minWidth: 0,
                            margin: '4px 8px 8px 4px',
                            background:
                              'color-mix(in srgb, var(--bg-elevated, #222) 80%, transparent)',
                            border: '1px solid var(--border, rgba(255, 255, 255, 0.08))',
                            borderRadius: 6,
                            overflow: 'hidden',
                            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
                          }}
                        >
                          <div
                            style={{
                              padding: '5px 10px',
                              background: 'rgba(255, 255, 255, 0.025)',
                              borderBottom: '1px solid var(--border, rgba(255, 255, 255, 0.06))',
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>
                                提交的文件变更明细
                              </span>
                              <span
                                style={{
                                  fontSize: 10,
                                  padding: '0 5px',
                                  borderRadius: 8,
                                  background: 'rgba(255, 255, 255, 0.08)',
                                  color: 'var(--muted)',
                                }}
                              >
                                {selectedCommitFiles.length}
                              </span>
                            </div>
                            <span
                              style={{
                                fontFamily: 'var(--font-mono, monospace)',
                                fontSize: 10,
                                color: 'var(--muted)',
                                background: 'rgba(255, 255, 255, 0.05)',
                                padding: '1px 6px',
                                borderRadius: 4,
                              }}
                            >
                              {c.shortHash}
                            </span>
                          </div>

                          <div style={{ maxHeight: 240, overflowY: 'auto', padding: '3px 5px' }}>
                            {loadingDetails ? (
                              <div
                                style={{
                                  fontSize: 11,
                                  color: 'var(--muted)',
                                  padding: '8px 4px',
                                  textAlign: 'center',
                                }}
                              >
                                加载文件明细中...
                              </div>
                            ) : selectedCommitFiles.length === 0 ? (
                              <div
                                style={{
                                  fontSize: 11,
                                  color: 'var(--muted)',
                                  padding: '8px 4px',
                                  textAlign: 'center',
                                }}
                              >
                                暂无文件变更
                              </div>
                            ) : (
                              selectedCommitFiles.map((f: GitCommitFileChange) => {
                                const fileName = f.path.split('/').pop() || f.path;
                                const dirPath = f.path.includes('/')
                                  ? f.path.slice(0, f.path.lastIndexOf('/') + 1)
                                  : '';
                                return (
                                  <div
                                    key={f.path}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handlePreviewCommitFile(c.hash, f.path);
                                    }}
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 6,
                                      padding: '3.5px 8px',
                                      borderRadius: 4,
                                      cursor: 'pointer',
                                      fontSize: 11.5,
                                      margin: '1px 0',
                                      transition: 'background 0.1s ease',
                                    }}
                                    className="search-result-item"
                                    title="点击查看对比 Diff"
                                  >
                                    <RenderFileTreeIcon name={fileName} isDirectory={false} />
                                    <span
                                      style={{
                                        flex: 1,
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                        display: 'flex',
                                        alignItems: 'baseline',
                                        gap: 4,
                                      }}
                                    >
                                      <span style={{ color: 'var(--text)' }}>{fileName}</span>
                                      {dirPath && (
                                        <span
                                          style={{
                                            color: 'var(--muted)',
                                            fontSize: 10.5,
                                            opacity: 0.65,
                                          }}
                                        >
                                          {dirPath}
                                        </span>
                                      )}
                                    </span>
                                    <span
                                      style={{
                                        color:
                                          f.status === 'A'
                                            ? '#4caf50'
                                            : f.status === 'D'
                                              ? '#f44336'
                                              : '#e5a54b',
                                        background:
                                          f.status === 'A'
                                            ? 'rgba(76, 175, 80, 0.14)'
                                            : f.status === 'D'
                                              ? 'rgba(244, 67, 54, 0.14)'
                                              : 'rgba(229, 165, 75, 0.14)',
                                        padding: '1px 5px',
                                        borderRadius: 3,
                                        fontWeight: 600,
                                        fontSize: 10,
                                        minWidth: 16,
                                        textAlign: 'center',
                                      }}
                                    >
                                      {f.status}
                                    </span>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <div
                style={{
                  padding: '24px 16px',
                  color: 'var(--muted)',
                  fontSize: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  alignItems: 'center',
                  textAlign: 'center',
                }}
              >
                {historyResult?.emptyRepo ? (
                  <>
                    <div style={{ fontSize: 20 }}>🌱</div>
                    <div style={{ fontWeight: 600, color: 'var(--text)' }}>
                      仓库已初始化，暂无提交记录
                    </div>
                    <div style={{ fontSize: 11, lineHeight: 1.5, opacity: 0.8, maxWidth: 260 }}>
                      当前分支尚未创建任何 commit。完成首次提交后，此处将自动展示完整的 Git
                      提交历史与分支图谱。
                    </div>
                  </>
                ) : historyResult && !historyResult.ok && historyResult.detail ? (
                  <>
                    <div style={{ fontSize: 20 }}>⚠️</div>
                    <div style={{ fontWeight: 600, color: '#f44336' }}>获取 Git 历史失败</div>
                    <div
                      style={{
                        fontSize: 11,
                        lineHeight: 1.4,
                        opacity: 0.9,
                        background: 'rgba(244, 67, 54, 0.1)',
                        border: '1px solid rgba(244, 67, 54, 0.25)',
                        padding: '6px 8px',
                        borderRadius: 4,
                        fontFamily: 'var(--font-mono)',
                        wordBreak: 'break-all',
                        maxWidth: 260,
                      }}
                    >
                      {historyResult.detail}
                    </div>
                  </>
                ) : (
                  <div>暂无提交记录</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Commit Floating Hover Preview Popover */}
      {hoveredCommitInfo && (
        <GitCommitPreviewCard
          commit={hoveredCommitInfo.commit}
          stats={
            commitDetailsCache[hoveredCommitInfo.commit.hash]?.stats ||
            hoveredCommitInfo.commit.stats
          }
          loadingStats={loadingPreviewHash === hoveredCommitInfo.commit.hash}
          targetRect={hoveredCommitInfo.rect}
          onMouseEnter={handleCardMouseEnter}
          onMouseLeave={handleCardMouseLeave}
          onSelectCommit={(hash) => void handleSelectCommit(hash)}
          onCopyHash={(hash) => {
            onShowToast?.('已复制提交哈希', hash.slice(0, 8), 'success');
          }}
        />
      )}

      {/* File Context Menu */}
      {fileContextMenu && (
        <GitFileContextMenu
          state={fileContextMenu}
          onClose={() => setFileContextMenu(null)}
          onOpenDiff={(entry, staged) => void preview(entry, staged)}
          onOpenFile={(p) => onOpenFile?.(p)}
          onOpenHeadFile={(p) => void handleOpenHeadFile(p)}
          onDiscard={(p) => void handleDiscard(p)}
          onDiscardFolder={(paths) => void handleDiscard(paths)}
          onToggleStage={(entry, staged) => {
            if (staged) {
              void runOp(() => window.ide.gitUnstage([entry.path]));
            } else {
              void runOp(() => window.ide.gitStage([entry.path]));
            }
          }}
          onToggleStageFolder={(paths, isStaged) => {
            if (isStaged) {
              void runOp(() => window.ide.gitUnstage(paths));
            } else {
              void runOp(() => window.ide.gitStage(paths));
            }
          }}
          onAddToGitignore={(p) => void handleAddToGitignore(p)}
          onShowInFolder={(p) => void handleShowInNativeFolder(p)}
          onRevealInExplorer={(p) => onRevealInExplorer?.(p)}
          onViewFileHistory={(p) => onViewFileHistory?.(p)}
        />
      )}
    </div>
  );
}
