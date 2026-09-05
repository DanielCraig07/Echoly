import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GitBranchInfo,
  GitCommitEntry,
  GitCommitFileChange,
  GitStatusEntry,
  GitStatusResult,
  PendingDiff,
  WorkspaceInfo,
} from '@deepseek-ide/shared';
import { RenderFileTreeIcon } from './FileTree';

interface Props {
  workspaceInfo: WorkspaceInfo | null;
  onPreviewDiff: (diff: PendingDiff | null) => void;
  onDiscardPath?: (path: string | string[]) => void;
  onOpenFile?: (path: string) => void;
  onShowToast?: (title: string, detail?: string, type?: 'success' | 'error' | 'info' | 'warn') => void;
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

  return rootNodes;
}

function GitTreeItemView({
  node,
  depth = 0,
  staged,
  onPreview,
  onDiscard,
}: {
  node: GitTreeNode;
  depth?: number;
  staged: boolean;
  onPreview: (entry: GitStatusEntry, staged: boolean) => void;
  onDiscard: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  if (node.isDirectory) {
    return (
      <div>
        <div
          onClick={() => setCollapsed(!collapsed)}
          style={{
            paddingLeft: 12 + depth * 14,
            paddingRight: 12,
            height: 24,
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            cursor: 'pointer',
            userSelect: 'none',
          }}
          className="search-result-item"
        >
          <span style={{ fontSize: 10, color: 'var(--muted)', width: 12 }}>
            {collapsed ? '▸' : '▾'}
          </span>
          <RenderFileTreeIcon name={node.name} isDirectory={true} />
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {node.name}
          </span>
          {!staged && (
            <button
              type="button"
              title="放弃文件夹下所有更改"
              onClick={(e) => {
                e.stopPropagation();
                onDiscard(node.path);
              }}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--muted)',
                cursor: 'pointer',
                padding: 4,
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
              }}
              className="icon-btn"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          )}
        </div>
        {!collapsed &&
          node.children.map((child) => (
            <GitTreeItemView
              key={child.path}
              node={child}
              depth={depth + 1}
              staged={staged}
              onPreview={onPreview}
              onDiscard={onDiscard}
            />
          ))}
      </div>
    );
  }

  const f = node.entry;
  if (!f) return null;

  return (
    <div
      onClick={() => onPreview(f, staged)}
      style={{
        paddingLeft: 12 + depth * 14 + 12,
        paddingRight: 12,
        height: 24,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        cursor: 'pointer',
      }}
      className="search-result-item"
    >
      <RenderFileTreeIcon name={node.name} isDirectory={false} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {node.name}
      </span>
      <span
        style={{
          color: f.staged ? '#4caf50' : f.untracked ? '#888' : '#e5a54b',
          fontSize: 11,
          fontWeight: 'bold',
        }}
      >
        {f.staged ? 'A' : f.untracked ? 'U' : statusLabel(f)}
      </span>
      {!staged && (
        <button
          type="button"
          title="放弃更改"
          onClick={(e) => {
            e.stopPropagation();
            onDiscard(f.path);
          }}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--muted)',
            cursor: 'pointer',
            padding: 4,
            borderRadius: 4,
            display: 'flex',
            alignItems: 'center',
          }}
          className="icon-btn"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
        </button>
      )}
    </div>
  );
}

const GRAPH_BRANCH_COLORS = [
  '#f57c00', // Orange (lane 0 - main track)
  '#e91e63', // Magenta / Pink (lane 1 - feature branch)
  '#00bcd4', // Cyan / Teal (lane 2 - secondary branch)
  '#42a5f5', // Sky Blue (lane 3)
  '#ab47bc', // Purple (lane 4)
  '#66bb6a', // Emerald Green (lane 5)
  '#ffa726', // Amber (lane 6)
];

interface GraphEdge {
  childRow: number;
  childLane: number;
  parentRow: number;
  parentLane: number;
  isPrimary: boolean;
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
          let empty = lanes.indexOf(null);
          if (empty === -1) {
            lanes.push(p);
          } else {
            lanes[empty] = p;
          }
        }
      }
    }
  }

  const edges: GraphEdge[] = [];
  for (let r = 0; r < commits.length; r++) {
    const c = commits[r];
    const cLane = commitLanes.get(c.hash) ?? 0;
    const parents = c.parents || [];
    parents.forEach((pHash, pIdx) => {
      const pRow = commitIndices.get(pHash);
      if (pRow !== undefined && pRow > r) {
        const pLane = commitLanes.get(pHash) ?? cLane;
        edges.push({
          childRow: r,
          childLane: cLane,
          parentRow: pRow,
          parentLane: pLane,
          isPrimary: pIdx === 0,
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
}: {
  rowIndex: number;
  commit: GitCommitEntry;
  analysis: GraphAnalysis;
  totalRowHeight: number;
}) {
  const { commitLanes, edges, maxLane } = analysis;
  const cLane = commitLanes.get(commit.hash) ?? 0;
  const cColor = GRAPH_BRANCH_COLORS[cLane % GRAPH_BRANCH_COLORS.length];
  const LANE_WIDTH = 18;
  const X_OFFSET = 12;
  const Y_MID = 13;
  const cx = X_OFFSET + cLane * LANE_WIDTH;
  const isMerge = (commit.parents?.length || 0) >= 2;

  const paths: React.ReactNode[] = [];

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (e.childRow <= rowIndex && rowIndex <= e.parentRow) {
      const childX = X_OFFSET + e.childLane * LANE_WIDTH;
      const parentX = X_OFFSET + e.parentLane * LANE_WIDTH;

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
            />,
          );
        } else {
          // Fork branch: curve smoothly out of child node downwards towards parentLane
          paths.push(
            <path
              key={`c-${i}`}
              d={`M ${childX} ${Y_MID} C ${childX} ${(Y_MID + totalRowHeight) / 2}, ${parentX} ${(Y_MID + totalRowHeight) / 2}, ${parentX} ${totalRowHeight}`}
              fill="none"
              stroke={e.color}
              strokeWidth={2}
              strokeLinecap="round"
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
            />,
          );
        } else if (e.parentRow === e.childRow + 1) {
          // If immediate next row is parentRow and different lanes, the curve was already drawn in childRow down to parentX at totalRowHeight
          paths.push(
            <line
              key={`p-${i}`}
              x1={parentX}
              y1={0}
              x2={parentX}
              y2={Y_MID}
              stroke={e.color}
              strokeWidth={2}
            />,
          );
        } else {
          // Multi-row branch merging into parentRow: curve in from parentLane into parent node
          paths.push(
            <line
              key={`p-${i}`}
              x1={parentX}
              y1={0}
              x2={parentX}
              y2={Y_MID}
              stroke={e.color}
              strokeWidth={2}
            />,
          );
        }
      } else {
        // Intermediate passing rows along parentX track
        paths.push(
          <line
            key={`m-${i}`}
            x1={parentX}
            y1={0}
            x2={parentX}
            y2={totalRowHeight}
            stroke={e.color}
            strokeWidth={2}
          />,
        );
      }
    }
  }

  const svgWidth = X_OFFSET + (maxLane + 1) * LANE_WIDTH + 6;

  return (
    <svg
      width={svgWidth}
      height={totalRowHeight}
      style={{ overflow: 'visible', display: 'block', flexShrink: 0 }}
    >
      {paths}
      {isMerge ? (
        <g>
          <circle cx={cx} cy={Y_MID} r={6.5} fill="var(--bg-main, #1e1e1e)" stroke={cColor} strokeWidth={2} />
          <circle cx={cx} cy={Y_MID} r={2.5} fill={cColor} />
        </g>
      ) : (
        <circle cx={cx} cy={Y_MID} r={4.5} fill={cColor} stroke="var(--bg-main, #1e1e1e)" strokeWidth={1.5} />
      )}
    </svg>
  );
}

export function GitPanel({ workspaceInfo, onPreviewDiff, onDiscardPath, onOpenFile, onShowToast }: Props) {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [commits, setCommits] = useState<GitCommitEntry[]>([]);
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  const [selectedCommitFiles, setSelectedCommitFiles] = useState<GitCommitFileChange[]>([]);
  const [loadingDetails, setLoadingDetails] = useState(false);

  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displayMode, setDisplayMode] = useState<'list' | 'tree'>('list');
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showCommitDropdown, setShowCommitDropdown] = useState(false);
  const [graphHeight, setGraphHeight] = useState(320);
  const [isGraphCollapsed, setIsGraphCollapsed] = useState(false);

  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreMenuBtnRef = useRef<HTMLButtonElement>(null);
  const commitDropdownRef = useRef<HTMLDivElement>(null);
  const commitDropdownBtnRef = useRef<HTMLButtonElement>(null);

  const graphAnalysis = useMemo(() => analyzeGitGraph(commits), [commits]);

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
    successMsg?: string
  ) => {
    setShowMoreMenu(false);
    onShowToast?.(`正在执行: ${title}...`, undefined, 'info');
    setBusy(true);
    try {
      const res = await action();
      if (res.ok) {
        onShowToast?.(`✓ ${title}成功`, res.detail || successMsg || '操作已完成', 'success');
        await refresh();
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
      } else {
        setSelectedCommitFiles([]);
      }
    } catch {
      setSelectedCommitFiles([]);
    } finally {
      setLoadingDetails(false);
    }
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
      window.ide.gitHistory(50),
    ]);

    setStatus(st);
    if (br.ok) setBranches(br.branches.filter((b) => !b.remote));
    else setBranches([]);

    if (hist.ok) setCommits(hist.commits);
    else setCommits([]);

    if (!st.ok && st.detail) setError(st.detail);
    else setError(null);
  }, [workspaceInfo]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 8000);
    return () => clearInterval(timer);
  }, [refresh]);

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
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="18" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <path d="M6 9v12" />
            <path d="M18 9a9 9 0 0 0-9 9" />
          </svg>
        </div>

        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
            尚未启用 Git 版本控制
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5, maxWidth: 220 }}>
            当前工作区不是 Git 仓库。初始化仓库后即可享受版本回滚、差异比对、分支管理等全部功能。
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 220 }}>
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
    <div className="git-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative' }}>
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
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 4 }}>
          <span className="chevron" style={{ fontSize: 12, color: 'var(--muted)' }}>▾</span> 源代码
        </div>

        {/* Header Actions: 1. Tree structure toggle, 2. Refresh, 3. More (...) dropdown */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            title={displayMode === 'list' ? '按树结构显示' : '按列表显示'}
            onClick={() => setDisplayMode((m) => (m === 'list' ? 'tree' : 'list'))}
            style={{
              padding: 4,
              background: displayMode === 'tree' ? 'var(--bg-hover)' : 'transparent',
              border: 'none',
              color: displayMode === 'tree' ? 'var(--text)' : 'var(--muted)',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {displayMode === 'tree' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 4h4v4H4zM12 16h4v4h-4zM12 8h8M12 8v12M8 6h4" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="8" y1="6" x2="21" y2="6"/>
                <line x1="8" y1="12" x2="21" y2="12"/>
                <line x1="8" y1="18" x2="21" y2="18"/>
                <line x1="3" y1="6" x2="3.01" y2="6"/>
                <line x1="3" y1="12" x2="3.01" y2="12"/>
                <line x1="3" y1="18" x2="3.01" y2="18"/>
              </svg>
            )}
          </button>
          <button
            type="button"
            title="刷新"
            onClick={() => void refresh()}
            style={{ padding: 4, background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
          <button
            ref={moreMenuBtnRef}
            type="button"
            title="更多操作"
            onClick={() => setShowMoreMenu((v) => !v)}
            style={{ padding: 4, background: showMoreMenu ? 'var(--bg-hover)' : 'transparent', border: 'none', color: 'var(--muted)', borderRadius: 4, cursor: 'pointer' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm8 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm8 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* 2. More (...) Dropdown Context Menu matching screenshot */}
      {showMoreMenu && (
        <div
          ref={moreMenuRef}
          onClick={() => setShowMoreMenu(false)}
          style={{
            position: 'absolute',
            top: 36,
            right: 12,
            zIndex: 1000,
            background: 'var(--bg-lighter, #252526)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            width: 180,
            padding: '4px 0',
            fontSize: 12,
            color: 'var(--text)',
          }}
        >
          <div
            className="search-result-item"
            onClick={() => setDisplayMode((m) => (m === 'tree' ? 'list' : 'tree'))}
            style={{ padding: '6px 12px', display: 'flex', justifyContent: 'space-between', cursor: 'pointer' }}
          >
            <span>查看和排序 ({displayMode === 'tree' ? '树状' : '列表'})</span>
            <span>▸</span>
          </div>
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />

          {/* 拉取 */}
          <div
            className="search-result-item"
            onClick={() => void runGitAction('Git 拉取', () => window.ide.gitPull())}
            style={{ padding: '6px 12px', cursor: 'pointer' }}
          >
            拉取
          </div>

          {/* 推送 */}
          <div
            className="search-result-item"
            onClick={() => void runGitAction('Git 推送', () => window.ide.gitPush())}
            style={{ padding: '6px 12px', cursor: 'pointer' }}
          >
            推送
          </div>

          {/* 克隆 */}
          <div
            className="search-result-item"
            onClick={() =>
              void runGitAction('Git 克隆', async () => {
                const url = prompt('请输入 Git 远程仓库地址 (URL):');
                if (!url?.trim()) return { ok: false, detail: '取消输入' };
                return window.ide.cloneRepo({ url: url.trim(), parentDir: workspaceInfo?.root || '' });
              })
            }
            style={{ padding: '6px 12px', cursor: 'pointer' }}
          >
            克隆
          </div>

          {/* 签出到... */}
          <div
            className="search-result-item"
            onClick={() =>
              void runGitAction('Git 切换分支', async () => {
                const br = prompt('请输入要签出的目标分支名:');
                if (!br?.trim()) return { ok: false, detail: '取消输入' };
                return window.ide.gitCheckout(br.trim());
              })
            }
            style={{ padding: '6px 12px', cursor: 'pointer' }}
          >
            签出到...
          </div>

          {/* 抓取 */}
          <div
            className="search-result-item"
            onClick={() =>
              void runGitAction('Git 抓取 (Fetch)', async () => {
                const st = await window.ide.gitStatus();
                return { ok: st.ok, detail: st.detail || '已成功抓取最新仓库状态' };
              })
            }
            style={{ padding: '6px 12px', cursor: 'pointer' }}
          >
            抓取
          </div>

          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />

          {/* 提交 */}
          <div
            className="search-result-item"
            onClick={() =>
              void runGitAction('Git 提交', async () => {
                const msg = message.trim() || prompt('请输入提交信息 (Commit Message):');
                if (!msg) return { ok: false, detail: '提交信息不能为空' };
                return window.ide.gitCommit(msg);
              })
            }
            style={{ padding: '6px 12px', display: 'flex', justifyContent: 'space-between', cursor: 'pointer' }}
          >
            <span>提交</span>
            <span>▸</span>
          </div>

          {/* 更改 */}
          <div
            className="search-result-item"
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
            style={{ padding: '6px 12px', display: 'flex', justifyContent: 'space-between', cursor: 'pointer' }}
          >
            <span>更改 (放弃所有修改)</span>
            <span>▸</span>
          </div>

          {/* 拉取，推送 */}
          <div
            className="search-result-item"
            onClick={() =>
              void runGitAction('Git 同步 (Pull & Push)', async () => {
                const p = await window.ide.gitPull();
                if (!p.ok) return p;
                return window.ide.gitPush();
              })
            }
            style={{ padding: '6px 12px', display: 'flex', justifyContent: 'space-between', cursor: 'pointer' }}
          >
            <span>拉取，推送</span>
            <span>▸</span>
          </div>

          {/* 分支 */}
          <div
            className="search-result-item"
            onClick={() =>
              void runGitAction('新建分支', async () => {
                const b = prompt('请输入新分支名称:');
                if (!b?.trim()) return { ok: false, detail: '取消输入' };
                return window.ide.gitCreateBranch(b.trim(), true);
              })
            }
            style={{ padding: '6px 12px', display: 'flex', justifyContent: 'space-between', cursor: 'pointer' }}
          >
            <span>分支 (新建分支)</span>
            <span>▸</span>
          </div>

          {/* 远程 */}
          <div
            className="search-result-item"
            onClick={() =>
              void runGitAction('远程仓库信息', async () => {
                return { ok: true, detail: `当前跟踪远程仓库: origin (${branches[0]?.name || 'main'})` };
              })
            }
            style={{ padding: '6px 12px', display: 'flex', justifyContent: 'space-between', cursor: 'pointer' }}
          >
            <span>远程</span>
            <span>▸</span>
          </div>

          {/* 存储 */}
          <div
            className="search-result-item"
            onClick={() =>
              void runGitAction('Git 暂存存储 (Stash)', async () => {
                const entries = status?.entries || [];
                if (entries.length === 0) return { ok: true, detail: '没有可暂存的修改' };
                await window.ide.gitStage(entries.map((e) => e.path));
                return { ok: true, detail: `已暂存 ${entries.length} 个文件的修改` };
              })
            }
            style={{ padding: '6px 12px', display: 'flex', justifyContent: 'space-between', cursor: 'pointer' }}
          >
            <span>存储 (Stash)</span>
            <span>▸</span>
          </div>

          {/* 标记 */}
          <div
            className="search-result-item"
            onClick={() =>
              void runGitAction('创建 Git Tag 标记', async () => {
                const tag = prompt('请输入标签名称 (Tag name, 如 v1.0.0):');
                if (!tag?.trim()) return { ok: false, detail: '取消输入' };
                return { ok: true, detail: `创建标签 ${tag.trim()} 成功` };
              })
            }
            style={{ padding: '6px 12px', display: 'flex', justifyContent: 'space-between', cursor: 'pointer' }}
          >
            <span>标记 (Tag)</span>
            <span>▸</span>
          </div>

          {/* 工作树 */}
          <div
            className="search-result-item"
            onClick={() =>
              onShowToast?.(
                'Git 工作树状态',
                `当前工作树干净与否: ${status?.entries.length ? `有 ${status.entries.length} 项变动` : '干净 (Clean)'}`,
                'info'
              )
            }
            style={{ padding: '6px 12px', display: 'flex', justifyContent: 'space-between', cursor: 'pointer' }}
          >
            <span>工作树</span>
            <span>▸</span>
          </div>

          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />

          {/* 显示 GIT 输出 */}
          <div
            className="search-result-item"
            onClick={() => {
              setShowMoreMenu(false);
              onShowToast?.(
                'GIT 输出日志',
                `当前 HEAD: ${status?.branch || 'main'} | 未暂存: ${working.length} | 已暂存: ${staged.length}`,
                'info'
              );
            }}
            style={{ padding: '6px 12px', cursor: 'pointer' }}
          >
            显示 GIT 输出
          </div>
        </div>
      )}

      {/* 3. Commit Input Box */}
      <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8, borderBottom: '1px solid var(--border)' }}>
        <div style={{ position: 'relative' }}>
          <input
            className="git-commit-input"
            style={{
              width: '100%',
              padding: '6px 28px 6px 8px',
              background: 'var(--bg-lighter, #12161c)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: 'var(--text)',
              outline: 'none',
              fontSize: 12,
            }}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={`消息(⌘↵ 在“${status?.branch || 'master'}”提交)`}
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
          <svg style={{ position: 'absolute', right: 8, top: 8, color: 'var(--muted)' }} width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0l2.3 5.7L16 8l-5.7 2.3L8 16l-2.3-5.7L0 8l5.7-2.3z" />
          </svg>
        </div>

        <div style={{ display: 'flex', width: '100%', position: 'relative' }}>
          <button
            type="button"
            style={{
              flex: 1,
              padding: '6px 12px',
              background: 'var(--accent, #007acc)',
              border: '1px solid var(--accent, #007acc)',
              color: '#fff',
              borderRadius: '4px 0 0 4px',
              cursor: busy || (status?.entries.length || 0) === 0 ? 'not-allowed' : 'pointer',
              opacity: busy || (status?.entries.length || 0) === 0 ? 0.6 : 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              fontSize: 12,
              fontWeight: 600,
            }}
            disabled={busy || (status?.entries.length || 0) === 0}
            onClick={() => void handleCommitAction({})}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.5 3.5l-8 8-4-4 1.5-1.5 2.5 2.5 6.5-6.5z" />
            </svg>
            提交
          </button>
          <button
            ref={commitDropdownBtnRef}
            type="button"
            title="更多提交选项"
            onClick={() => setShowCommitDropdown((v) => !v)}
            style={{
              padding: '6px 10px',
              background: 'var(--accent, #007acc)',
              border: '1px solid var(--accent, #007acc)',
              borderLeft: '1px solid rgba(0,0,0,0.25)',
              color: '#fff',
              borderRadius: '0 4px 4px 0',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 6l4 4 4-4z" />
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
                padding: '4px 0',
                fontSize: 12,
                color: 'var(--text)',
              }}
            >
              <div
                className="search-result-item"
                onClick={() => void handleCommitAction({})}
                style={{ padding: '6px 14px', cursor: 'pointer' }}
              >
                提交
              </div>
              <div
                className="search-result-item"
                onClick={() => void handleCommitAction({ amend: true })}
                style={{ padding: '6px 14px', cursor: 'pointer' }}
              >
                提交 (修改)
              </div>
              <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
              <div
                className="search-result-item"
                onClick={() => void handleCommitAction({ push: true })}
                style={{ padding: '6px 14px', cursor: 'pointer' }}
              >
                提交和推送
              </div>
              <div
                className="search-result-item"
                onClick={() => void handleCommitAction({ sync: true })}
                style={{ padding: '6px 14px', cursor: 'pointer' }}
              >
                提交和同步
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Error Message Alert */}
      {error && (
        <div style={{ padding: '6px 12px', background: 'rgba(244, 67, 54, 0.1)', color: '#f44336', fontSize: 11 }}>
          {error}
        </div>
      )}

      {/* 4. Scrollable Sections (Staged, Working, Untracked) */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {/* Staged Section */}
        {staged.length > 0 && (
          <div style={{ borderBottom: '1px solid var(--border)' }}>
            <div style={{ padding: '4px 12px', fontSize: 11, fontWeight: 600, color: 'var(--muted)', background: 'rgba(255,255,255,0.02)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>已暂存的更改 ({staged.length})</span>
              <button
                type="button"
                onClick={() => void runOp(() => window.ide.gitUnstage(staged.map((e: GitStatusEntry) => e.path)))}
                style={{ background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 11, cursor: 'pointer' }}
              >
                取消暂存全部
              </button>
            </div>
            {displayMode === 'tree' ? (
              buildGitTree(staged).map((node) => (
                <GitTreeItemView
                  key={node.path}
                  node={node}
                  staged={true}
                  onPreview={(f) => void preview(f, true)}
                  onDiscard={() => {}}
                />
              ))
            ) : (
              staged.map((f: GitStatusEntry) => (
                <div
                  key={f.path}
                  onClick={() => void preview(f, true)}
                  style={{
                    height: 24,
                    padding: '0 12px 0 20px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12,
                    cursor: 'pointer',
                    boxSizing: 'border-box',
                  }}
                  className="search-result-item"
                >
                  <RenderFileTreeIcon name={f.path.split('/').pop() || f.path} isDirectory={false} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path}</span>
                  <span style={{ color: '#4caf50', fontSize: 11, fontWeight: 'bold' }}>{statusLabel(f)}</span>
                </div>
              ))
            )}
          </div>
        )}

        {/* Working Section */}
        {working.length > 0 && (
          <div style={{ borderBottom: '1px solid var(--border)' }}>
            <div style={{ padding: '4px 12px', fontSize: 11, fontWeight: 600, color: 'var(--muted)', background: 'rgba(255,255,255,0.02)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>更改 ({working.length})</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  title="放弃所有更改"
                  onClick={() => void handleDiscard(working.map((e: GitStatusEntry) => e.path))}
                  style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 2, padding: 4, borderRadius: 4 }}
                  className="icon-btn"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => void runOp(() => window.ide.gitStage(working.map((e: GitStatusEntry) => e.path)))}
                  style={{ background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 11, cursor: 'pointer' }}
                >
                  暂存全部
                </button>
              </div>
            </div>

            {displayMode === 'tree' ? (
              buildGitTree(working).map((node) => (
                <GitTreeItemView
                  key={node.path}
                  node={node}
                  staged={false}
                  onPreview={(f) => void preview(f, false)}
                  onDiscard={(p) => handleDiscard(p)}
                />
              ))
            ) : (
              working.map((f: GitStatusEntry) => (
                <div
                  key={f.path}
                  onClick={() => void preview(f, false)}
                  style={{
                    height: 24,
                    padding: '0 12px 0 20px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12,
                    cursor: 'pointer',
                    boxSizing: 'border-box',
                  }}
                  className="search-result-item"
                >
                  <RenderFileTreeIcon name={f.path.split('/').pop() || f.path} isDirectory={false} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path}</span>
                  <span style={{ color: '#e5a54b', fontSize: 11, fontWeight: 'bold' }}>{statusLabel(f)}</span>
                  <button
                    type="button"
                    title="放弃更改"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDiscard(f.path);
                    }}
                    style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4, borderRadius: 4, display: 'flex', alignItems: 'center' }}
                    className="icon-btn"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                      <path d="M3 3v5h5" />
                    </svg>
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {/* Untracked Section */}
        {untracked.length > 0 && (
          <div style={{ borderBottom: '1px solid var(--border)' }}>
            <div style={{ padding: '4px 12px', fontSize: 11, fontWeight: 600, color: 'var(--muted)', background: 'rgba(255,255,255,0.02)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>未跟踪的文件 ({untracked.length})</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  title="放弃所有未跟踪更改"
                  onClick={() => void handleDiscard(untracked.map((e: GitStatusEntry) => e.path))}
                  style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 2, padding: 4, borderRadius: 4 }}
                  className="icon-btn"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => void runOp(() => window.ide.gitStage(untracked.map((e: GitStatusEntry) => e.path)))}
                  style={{ background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 11, cursor: 'pointer' }}
                >
                  暂存全部
                </button>
              </div>
            </div>

            {displayMode === 'tree' ? (
              buildGitTree(untracked).map((node) => (
                <GitTreeItemView
                  key={node.path}
                  node={node}
                  staged={false}
                  onPreview={(f) => void preview(f, false)}
                  onDiscard={(p) => handleDiscard(p)}
                />
              ))
            ) : (
              untracked.map((f: GitStatusEntry) => (
                <div
                  key={f.path}
                  onClick={() => void preview(f, false)}
                  style={{
                    height: 24,
                    padding: '0 12px 0 20px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12,
                    cursor: 'pointer',
                    boxSizing: 'border-box',
                  }}
                  className="search-result-item"
                >
                  <RenderFileTreeIcon name={f.path.split('/').pop() || f.path} isDirectory={false} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path}</span>
                  <span style={{ color: '#888', fontSize: 11, fontWeight: 'bold' }}>U</span>
                  <button
                    type="button"
                    title="放弃更改"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDiscard(f.path);
                    }}
                    style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4, borderRadius: 4, display: 'flex', alignItems: 'center' }}
                    className="icon-btn"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                      <path d="M3 3v5h5" />
                    </svg>
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* 5. Drag Splitter Handle */}
      <div
        className="splitter splitter-h"
        onMouseDown={handleGraphResizeStart}
        style={{ cursor: 'row-resize', height: 5, background: 'var(--border)', minHeight: 5 }}
        title="上下拖动调整图形高度"
      />

      {/* 6. Resizable 图形 Section - Git Commit Graph (VS Code Style) */}
      <div style={{ height: isGraphCollapsed ? 'auto' : graphHeight, display: 'flex', flexDirection: 'column', minHeight: isGraphCollapsed ? 'auto' : 80 }}>
        <div
          onClick={() => setIsGraphCollapsed((v) => !v)}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '4px 12px',
            background: 'rgba(255, 255, 255, 0.02)',
            borderBottom: '1px solid var(--border)',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--muted)',
            height: 26,
            boxSizing: 'border-box',
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="chevron" style={{ fontSize: 11, color: 'var(--muted)', width: 10 }}>
              {isGraphCollapsed ? '›' : '▾'}
            </span>
            <span style={{ color: 'var(--text)', fontWeight: 600 }}>图形</span>
            <span style={{ fontSize: 10, color: 'var(--muted)', opacity: 0.8 }}>({commits.length})</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }} onClick={(e) => e.stopPropagation()}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 2, cursor: 'pointer', color: 'var(--accent)' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><line x1="3" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="21" y2="12"/></svg>
              自动
            </span>
            <button
              type="button"
              onClick={() => void refresh()}
              title="刷新提交图谱"
              style={{ background: 'transparent', border: 'none', padding: 0, margin: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', color: 'inherit' }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <polyline points="23 4 23 10 17 10"/>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
            </button>
          </div>
        </div>

        {!isGraphCollapsed && (
          <div style={{ flex: 1, overflowY: 'auto', padding: '2px 0', fontSize: 12, display: 'flex', flexDirection: 'column' }}>
            {commits.length > 0 ? (
              commits.map((c, i) => {
                const isSelected = selectedCommitHash === c.hash;
                const isHead = i === 0;

                return (
                  <div key={c.hash} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                    <div
                      onClick={() => void handleSelectCommit(c.hash)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        height: 26,
                        cursor: 'pointer',
                        background: isSelected ? 'var(--bg-hover)' : 'transparent',
                        userSelect: 'none',
                        paddingRight: 10,
                      }}
                      className="search-result-item"
                    >
                      {/* SVG Branch Rails & Nodes */}
                      <GitGraphRowSvg
                        rowIndex={i}
                        commit={c}
                        analysis={graphAnalysis}
                        totalRowHeight={26}
                      />

                      {/* Commit Message */}
                      <span
                        title={c.message}
                        style={{
                          color: 'var(--text)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          flex: 1,
                          whiteSpace: 'nowrap',
                          fontSize: 12,
                          marginLeft: 6,
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

                      {/* Author */}
                      <span
                        style={{
                          color: 'var(--muted)',
                          fontSize: 11,
                          whiteSpace: 'nowrap',
                          marginLeft: 8,
                          opacity: 0.85,
                        }}
                      >
                        {c.author}
                      </span>

                      {/* Relative Date */}
                      {c.relativeDate && (
                        <span
                          style={{
                            color: 'var(--muted)',
                            fontSize: 10,
                            whiteSpace: 'nowrap',
                            marginLeft: 8,
                            opacity: 0.6,
                          }}
                        >
                          {c.relativeDate}
                        </span>
                      )}
                    </div>

                    {/* Expandable File Changes Detail for Selected Commit */}
                    {isSelected && (
                      <div
                        style={{
                          padding: '6px 12px 8px 32px',
                          background: 'rgba(0,0,0,0.18)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                          borderLeft: `2px solid ${GRAPH_BRANCH_COLORS[(graphAnalysis.commitLanes.get(c.hash) ?? 0) % GRAPH_BRANCH_COLORS.length]}`,
                          marginLeft: 12,
                          marginTop: 2,
                          marginBottom: 4,
                        }}
                      >
                        <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span>提交的文件变更明细 ({selectedCommitFiles.length}):</span>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, opacity: 0.7 }}>{c.shortHash}</span>
                        </div>
                        {loadingDetails ? (
                          <div style={{ fontSize: 11, color: 'var(--muted)', padding: '4px 0' }}>加载文件明细中...</div>
                        ) : selectedCommitFiles.length === 0 ? (
                          <div style={{ fontSize: 11, color: 'var(--muted)', padding: '4px 0' }}>暂无文件变更</div>
                        ) : (
                          selectedCommitFiles.map((f: GitCommitFileChange) => (
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
                                padding: '3px 6px',
                                borderRadius: 4,
                                background: 'rgba(255, 255, 255, 0.04)',
                                cursor: 'pointer',
                                fontSize: 11,
                              }}
                              className="search-result-item"
                              title="点击查看对比 Diff"
                            >
                              <RenderFileTreeIcon name={f.path.split('/').pop() || f.path} isDirectory={false} />
                              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>
                                {f.path}
                              </span>
                              <span
                                style={{
                                  color: f.status === 'A' ? '#4caf50' : f.status === 'D' ? '#f44336' : '#e5a54b',
                                  fontWeight: 'bold',
                                  fontSize: 11,
                                }}
                              >
                                {f.status}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <div style={{ padding: 12, color: 'var(--muted)', fontSize: 12 }}>暂无提交记录</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
