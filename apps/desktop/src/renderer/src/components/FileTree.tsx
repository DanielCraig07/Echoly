import {
  forwardRef,
  memo,
  useImperativeHandle,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { FileTreeNode, GitStatusEntry, GitStatusResult } from '@deepseek-ide/shared';
import { createSafeOverlayHandlers } from '../hooks/useModalResize';
import { useDbConfirm } from '../hooks/useDbConfirm';
import { buildSqlConfirmMarkdown } from '../services/dbConfirmContent';
import { showGlobalToast } from '../services/toast';
import { validateMove } from '../utils/fileMoveValidation';
import { PanelChevron } from './PanelChevron';
import { useI18n } from '../i18n';

export type PathClipboard = {
  mode: 'cut' | 'copy';
  path: string;
  isDirectory: boolean;
} | null;

export type FileTreeHandlers = {
  onOpenFile: (path: string) => void;
  onOpenTerminal: (cwdRel: string) => void;
  onAddToChat: (path: string) => void;
  onAddToNewChat: (path: string) => void;
  onSelectNode?: (node: { path: string; isDirectory: boolean } | null) => void;
};

type MenuTarget = { kind: 'blank' } | { kind: 'node'; node: FileTreeNode };

type ContextMenuState = {
  x: number;
  y: number;
  target: MenuTarget;
};

type InlineEdit =
  | { mode: 'create-file' | 'create-folder'; parentPath: string }
  | { mode: 'rename'; node: FileTreeNode };

function parentOf(relPath: string): string {
  const norm = relPath.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  if (idx < 0) return '.';
  return norm.slice(0, idx) || '.';
}

function joinRel(parent: string, name: string): string {
  const p = parent === '.' || parent === '' ? '' : parent.replace(/\/$/, '');
  return p ? `${p}/${name}` : name;
}

function basename(relPath: string): string {
  const norm = relPath.replace(/\\/g, '/');
  const parts = norm.split('/');
  return parts[parts.length - 1] || norm;
}

export function normalizePathToRel(
  filePath: string | null | undefined,
  workspaceRoot: string | null | undefined,
): string {
  if (!filePath) return '';
  let p = filePath.replace(/\\/g, '/');
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  if (workspaceRoot) {
    const ws = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    if (p.startsWith(ws)) {
      p = p.slice(ws.length);
    }
  }
  return p.replace(/^\/+/, '');
}

interface MenuProps {
  state: ContextMenuState;
  clipboard: PathClipboard;
  gitStatus?: GitStatusResult | null;
  onClose: () => void;
  onAction: (action: string) => void;
}

function FileTreeContextMenu({ state, clipboard, gitStatus, onClose, onAction }: MenuProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const gitTriggerRef = useRef<HTMLDivElement>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [gitSubmenuOpen, setGitSubmenuOpen] = useState(false);
  const [gitSubmenuPos, setGitSubmenuPos] = useState<{ x: number; y: number } | null>(null);

  const isBlank = state.target.kind === 'blank';
  const node = state.target.kind === 'node' ? state.target.node : null;
  const isDir = !!node?.isDirectory;
  const canPaste = !!clipboard;

  const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
  const diffShortcut = isMac ? '⌘D' : 'Ctrl+D';
  const rollbackShortcut = isMac ? '⌥⌘Z' : 'Alt+Ctrl+Z';

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current && ref.current.contains(target)) {
        return;
      }
      if (submenuRef.current && submenuRef.current.contains(target)) {
        return;
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
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

  const openGitSubmenu = () => {
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    if (gitTriggerRef.current) {
      const rect = gitTriggerRef.current.getBoundingClientRect();
      const subWidth = 260;
      let x = rect.right + 2;
      if (x + subWidth > window.innerWidth - 8) {
        x = Math.max(8, rect.left - subWidth - 2);
      }
      let y = rect.top - 4;
      if (y + 280 > window.innerHeight - 8) {
        y = Math.max(8, window.innerHeight - 280 - 8);
      }
      setGitSubmenuPos({ x, y });
      setGitSubmenuOpen(true);
    }
  };

  const closeGitSubmenuWithDelay = () => {
    leaveTimerRef.current = setTimeout(() => {
      setGitSubmenuOpen(false);
    }, 180);
  };

  const item = (id: string, label: string, opts?: { disabled?: boolean; danger?: boolean }) => (
    <button
      key={id}
      type="button"
      className={`ctx-item${opts?.danger ? ' danger' : ''}`}
      disabled={opts?.disabled}
      onClick={() => {
        if (opts?.disabled) return;
        onAction(id);
      }}
    >
      {label}
    </button>
  );

  const sep = (key: string) => <div key={key} className="ctx-sep" />;

  const items: ReactNode[] = [];

  if (isBlank || node) {
    items.push(item('new-file', t('tree.newFile')));
    items.push(item('new-folder', t('tree.newFolder')));
  }
  if (node) {
    items.push(item('open-terminal', t('tree.openTerminal')));
    items.push(sep('s1'));
    items.push(item('add-chat', t('tree.addToChat')));
    items.push(item('add-new-chat', t('tree.addToNewChat')));
    if (isDir) {
      items.push(sep('s2'));
      items.push(item('find-in-folder', t('tree.findInFolder')));
    }
    items.push(sep('s3'));
    items.push(item('cut', t('tree.cut')));
    items.push(item('copy', t('tree.copy')));
  }
  items.push(item('paste', t('tree.paste'), { disabled: !canPaste }));

  // ── Git 专属级联菜单 ──
  if (node) {
    items.push(sep('s-git-trigger'));
    items.push(
      <div
        key="git-submenu-trigger"
        ref={gitTriggerRef}
        className={`ctx-item${gitSubmenuOpen ? ' active-trigger' : ''}`}
        onMouseEnter={openGitSubmenu}
        onMouseLeave={closeGitSubmenuWithDelay}
        onClick={() => {
          if (gitSubmenuOpen) setGitSubmenuOpen(false);
          else openGitSubmenu();
        }}
        style={{
          background: gitSubmenuOpen ? 'var(--accent, #007acc)' : undefined,
          color: gitSubmenuOpen ? '#ffffff' : undefined,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            style={{ color: gitSubmenuOpen ? '#ffffff' : '#38bdf8' }}
          >
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          <span style={{ fontWeight: 500 }}>Git</span>
        </span>
        <span className="ctx-submenu-arrow">›</span>
      </div>,
    );
  }

  const hasGitChange = Boolean(
    node &&
    gitStatus?.entries?.some((e) => {
      const ep = e.path.replace(/\\/g, '/');
      const np = node.path.replace(/\\/g, '/');
      return ep === np || (isDir && ep.startsWith(np + '/'));
    }),
  );
  if (hasGitChange) {
    items.push(item('git-rollback', t('tree.rollback'), { danger: true }));
  }
  if (node) {
    const isMac =
      typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);
    items.push(sep('s5'));
    items.push(item('copy-abs', t('tree.copyPath')));
    items.push(item('copy-rel', t('tree.copyRelativePath')));
    items.push(
      item('reveal-in-finder', isMac ? t('tree.revealInFinder') : t('tree.revealInExplorer')),
    );
    items.push(sep('s6'));
    items.push(item('rename', t('tree.rename')));
    items.push(item('delete', t('tree.deletePermanently'), { danger: true }));
  }

  const handleGitAction = (actionId: string, disabled?: boolean) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    onAction(actionId);
  };

  return (
    <>
      <div className="ctx-menu" ref={ref} role="menu" onMouseDown={(e) => e.stopPropagation()}>
        {items}
      </div>

      {/* Git 二级子菜单 (完全对齐用户附图结构及各项功能) */}
      {gitSubmenuOpen && gitSubmenuPos && (
        <div
          ref={submenuRef}
          className="ctx-menu ctx-git-submenu"
          style={{
            left: `${gitSubmenuPos.x}px`,
            top: `${gitSubmenuPos.y}px`,
            minWidth: 260,
            zIndex: 10002,
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseEnter={() => {
            if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
          }}
          onMouseLeave={closeGitSubmenuWithDelay}
        >
          {/* 1. Annotate with Git Blame */}
          <button
            type="button"
            className="ctx-item"
            disabled={isDir}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleGitAction('git-annotate', isDir)}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 16, display: 'inline-block' }} />
              {t('tree.gitAnnotate')}
            </span>
          </button>

          {/* 2. Show Diff */}
          <button
            type="button"
            className="ctx-item"
            disabled={isDir}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleGitAction('git-diff', isDir)}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                <rect
                  x="2"
                  y="2"
                  width="5.5"
                  height="12"
                  rx="1.5"
                  stroke="#f87171"
                  strokeWidth="1.5"
                />
                <rect
                  x="8.5"
                  y="2"
                  width="5.5"
                  height="12"
                  rx="1.5"
                  stroke="#38bdf8"
                  strokeWidth="1.5"
                />
                <line x1="4.5" y1="5" x2="6" y2="5" stroke="#f87171" strokeWidth="1.2" />
                <line x1="10" y1="5" x2="12" y2="5" stroke="#38bdf8" strokeWidth="1.2" />
                <line x1="4.5" y1="8" x2="6" y2="8" stroke="#f87171" strokeWidth="1.2" />
                <line x1="10" y1="8" x2="12" y2="8" stroke="#38bdf8" strokeWidth="1.2" />
              </svg>
              {t('tree.gitShowDiff')}
            </span>
            <kbd className="shortcut-badge">{diffShortcut}</kbd>
          </button>

          {/* 3. Compare with Revision... */}
          <button
            type="button"
            className="ctx-item"
            disabled={isDir}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleGitAction('git-compare-revision', isDir)}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 16, display: 'inline-block' }} />
              {t('tree.gitCompareRevision')}
            </span>
          </button>

          {/* 4. Compare with Branch or Tag... */}
          <button
            type="button"
            className="ctx-item"
            disabled={isDir}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleGitAction('git-compare-branch', isDir)}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 16, display: 'inline-block' }} />
              {t('tree.gitCompareBranch')}
            </span>
          </button>

          {/* 5. Show History */}
          <button
            type="button"
            className="ctx-item"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleGitAction('git-history')}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#fbbf24"
                strokeWidth="2"
                style={{ flexShrink: 0 }}
              >
                <circle cx="12" cy="12" r="9" />
                <polyline points="12 7 12 12 15 15" />
              </svg>
              {t('tree.gitHistory')}
            </span>
          </button>

          {/* 6. Show Current Revision */}
          <button
            type="button"
            className="ctx-item"
            disabled={isDir}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleGitAction('git-current-revision', isDir)}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 16, display: 'inline-block' }} />
              {t('tree.gitCurrentRevision')}
            </span>
          </button>

          {/* 7. Rollback... */}
          <button
            type="button"
            className="ctx-item"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleGitAction('git-rollback')}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                style={{ flexShrink: 0, color: 'var(--muted)' }}
              >
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              {t('tree.gitRollback')}
            </span>
            <kbd className="shortcut-badge">{rollbackShortcut}</kbd>
          </button>
        </div>
      )}
    </>
  );
}

function InlineNameInput({
  initial,
  placeholder,
  depth,
  onSubmit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  depth: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div className="file-node file-inline-edit" style={{ paddingLeft: 12 + depth * 16 }}>
      <span>·</span>
      <input
        ref={ref}
        className="file-inline-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const name = value.trim();
            if (name) onSubmit(name);
            else onCancel();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          const name = value.trim();
          if (name) onSubmit(name);
          else onCancel();
        }}
      />
    </div>
  );
}

import { RenderFileTreeIcon, detectCodeSubtype, type CodeSubtype } from './FileIcons';
export { RenderFileTreeIcon, detectCodeSubtype };

// 全局缓存探测到的代码文件子类型（如 Java 类、接口、枚举等）
const codeTypeCache = new Map<string, CodeSubtype>();

// 并发读取限制队列（最多 2 个并发任务），防止批量展开目录时瞬时产生巨量 I/O
let activeDetectCount = 0;
const detectQueue: Array<() => void> = [];
function scheduleDetect(task: () => Promise<void>): void {
  const run = () => {
    activeDetectCount++;
    task().finally(() => {
      activeDetectCount--;
      const next = detectQueue.shift();
      if (next) next();
    });
  };
  if (activeDetectCount < 2) {
    run();
  } else {
    detectQueue.push(run);
  }
}

/** 归一化：反斜杠转正斜杠、去掉开头的 `/`。索引与查询两侧都跑一遍，
 *  保证「索引里存的是什么、查的时候拿什么比」是同一套写法。 */
function normGitPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Git 状态的**预建索引**。
 *
 * 早先每个树节点都拿着完整的 `entries` 数组自己遍历一遍（`find` 找文件、
 * `some` 找目录子树）。可见 2000 个节点、状态里 5000 条改动时，每渲染一次就是
 * 上千万次路径比较 —— 而 `gitStatus` 每次刷新都是新对象，等于**每次刷新都把
 * 整个树重算一遍**。改成建一次索引、每个节点 O(1) 查表。
 *
 * 目录不能只存「有改动的目录路径」再去前缀匹配，那样又退回线性扫描了；
 * 所以建索引时把每个改动路径的**所有祖先目录**都展开进 `dirsWithChanges`，
 * 查询就退化成一次 `has()`。
 */
export type GitStatusIndex = {
  /** 精确路径 → 状态条目（给文件用） */
  files: Map<string, GitStatusEntry>;
  /** 自身或子孙有改动的目录路径 */
  dirsWithChanges: Set<string>;
  /**
   * 被 .gitignore 忽略的**条目**路径。
   *
   * 这里存的是「忽略规则命中的那个路径」本身（可能是目录），查询时沿节点的祖先
   * 链找 —— 而不能像 `dirsWithChanges` 那样在建立索引时把子孙展开：忽略项是
   * 目录时，我们并不知道它底下还有哪些文件（真要枚举就得先遍历一遍磁盘，
   * 那正是要避免的事）。
   */
  ignored: Set<string>;
};

/** 把一个路径的所有祖先目录（不含自身）逐个加进集合。 */
function addAncestors(target: Set<string>, normalizedPath: string): void {
  let idx = normalizedPath.indexOf('/');
  while (idx > 0) {
    target.add(normalizedPath.slice(0, idx));
    idx = normalizedPath.indexOf('/', idx + 1);
  }
}

/** 路径自身或其任一祖先命中集合时为真（即「在这个目录下面」）。 */
function inPathTree(set: Set<string>, normalizedPath: string): boolean {
  if (set.has(normalizedPath)) return true;
  let idx = normalizedPath.lastIndexOf('/');
  while (idx > 0) {
    if (set.has(normalizedPath.slice(0, idx))) return true;
    idx = normalizedPath.lastIndexOf('/', idx - 1);
  }
  return false;
}

export function buildGitStatusIndex(
  entries: GitStatusEntry[] = [],
  ignoredPaths: string[] = [],
): GitStatusIndex {
  const index: GitStatusIndex = {
    files: new Map(),
    dirsWithChanges: new Set(),
    ignored: new Set(),
  };

  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string' || !entry.path) continue;
    const p = normGitPath(entry.path);
    if (!p) continue;
    index.files.set(p, entry);
    // 自身也进集合：目录恰好与某条改动同路径时（子模块、被替换的目录链接），
    // 原实现靠 `e.path === norm` 命中，而展开祖先时不会包含自身。
    index.dirsWithChanges.add(p);
    addAncestors(index.dirsWithChanges, p);
  }

  for (const raw of ignoredPaths) {
    if (typeof raw !== 'string' || !raw) continue;
    const p = normGitPath(raw);
    if (p) index.ignored.add(p);
  }

  return index;
}

/** 导出只为测试：状态字母的判定逻辑必须在改动后保持逐字节一致。 */
export function getNodeGitStatus(
  nodePath: string,
  isDir: boolean,
  index: GitStatusIndex,
): { label?: string; hasChanges?: boolean; color?: string; isIgnored?: boolean } | null {
  if (!nodePath || typeof nodePath !== 'string') return null;
  const norm = normGitPath(nodePath);

  // 1. 优先检测是否被 .gitignore 忽略（浅色置灰）
  if (inPathTree(index.ignored, norm)) {
    return { isIgnored: true, color: 'var(--muted, #888888)' };
  }

  if (!isDir) {
    const matched = index.files.get(norm);
    if (!matched) return null;
    if (matched.untracked) return { label: 'U', color: '#4caf50' };
    if (matched.staged) return { label: 'A', color: '#4caf50' };
    if (matched.workTree && matched.workTree.trim()) return { label: 'M', color: '#e5a54b' };
    return null;
  }

  return index.dirsWithChanges.has(norm) ? { hasChanges: true, color: '#e5a54b' } : null;
}

interface TreeNodeProps {
  node: FileTreeNode;
  depth: number;
  activePath: string | null;
  selectedNode: { path: string; isDirectory: boolean } | null;
  /** 由 FileTree 顶层 useMemo 建一次，整棵树共用 —— 每个节点各建一份等于没优化。 */
  gitIndex: GitStatusIndex;
  refreshKey: number;
  collapseKey?: number;
  expandKey?: number;
  locateKey?: number;
  expandPath: string | null;
  inlineEdit: InlineEdit | null;
  isRemote?: boolean;
  onOpenFile: (path: string) => void;
  onSelectNode?: (node: { path: string; isDirectory: boolean } | null) => void;
  onContextNode: (e: ReactMouseEvent, node: FileTreeNode) => void;
  onInlineDone: (edit: InlineEdit, name: string) => void;
  onInlineCancel: () => void;
  onMoveNode?: (sourcePath: string, targetDirPath: string, sourceIsDir: boolean) => void;
}

function areTreeNodePropsEqual(prev: TreeNodeProps, next: TreeNodeProps): boolean {
  if (prev.refreshKey !== next.refreshKey) return false;
  if (prev.collapseKey !== next.collapseKey) return false;
  if (prev.expandKey !== next.expandKey) return false;
  if (prev.locateKey !== next.locateKey) return false;
  if (prev.isRemote !== next.isRemote) return false;

  // 节点元数据变动
  if (
    prev.node.path !== next.node.path ||
    prev.node.name !== next.node.name ||
    prev.node.isDirectory !== next.node.isDirectory
  ) {
    return false;
  }
  if (prev.depth !== next.depth) return false;

  // 激活态比对：仅在该节点从 active 变 inactive，或从 inactive 变 active 时重绘
  const wasActive = prev.activePath === prev.node.path;
  const isNowActive = next.activePath === next.node.path;
  if (wasActive !== isNowActive) return false;

  // 选中态比对：仅在该节点选中状态发生切换时重绘
  const wasSelected = prev.selectedNode?.path === prev.node.path;
  const isNowSelected = next.selectedNode?.path === next.node.path;
  if (wasSelected !== isNowSelected) return false;

  // 行内编辑状态比对：仅在该节点自身或其子级涉及新增/重命名时重绘
  const isNodeInvolvedInEdit = (edit: InlineEdit | null, p: string) => {
    if (!edit) return false;
    return edit.mode === 'rename' ? edit.node.path === p : edit.parentPath === p;
  };
  const prevInvolvedInEdit = isNodeInvolvedInEdit(prev.inlineEdit, prev.node.path);
  const nextInvolvedInEdit = isNodeInvolvedInEdit(next.inlineEdit, next.node.path);
  if (prevInvolvedInEdit !== nextInvolvedInEdit) return false;
  if (nextInvolvedInEdit && prev.inlineEdit !== next.inlineEdit) return false;

  // 路径展开比对：仅当 expandPath 命中当前目录或其祖先/子级时重绘
  if (prev.expandPath !== next.expandPath) {
    if (prev.node.isDirectory) {
      const prevAffects =
        prev.expandPath &&
        (prev.expandPath === prev.node.path || prev.expandPath.startsWith(`${prev.node.path}/`));
      const nextAffects =
        next.expandPath &&
        (next.expandPath === next.node.path || next.expandPath.startsWith(`${next.node.path}/`));
      if (prevAffects || nextAffects) return false;
    }
  }

  // Git 状态比对：通过 O(1) 预建索引快速判断当前节点的状态标识是否有实质变更
  if (prev.gitIndex !== next.gitIndex) {
    const prevStatus = getNodeGitStatus(prev.node.path, prev.node.isDirectory, prev.gitIndex);
    const nextStatus = getNodeGitStatus(next.node.path, next.node.isDirectory, next.gitIndex);
    if (
      prevStatus?.label !== nextStatus?.label ||
      prevStatus?.color !== nextStatus?.color ||
      prevStatus?.hasChanges !== nextStatus?.hasChanges ||
      prevStatus?.isIgnored !== nextStatus?.isIgnored
    ) {
      return false;
    }
  }

  return true;
}

function TreeNodeComponent({
  node,
  depth,
  activePath,
  selectedNode,
  gitIndex,
  refreshKey,
  collapseKey,
  expandKey,
  locateKey,
  expandPath,
  inlineEdit,
  isRemote,
  onOpenFile,
  onSelectNode,
  onContextNode,
  onInlineDone,
  onInlineCancel,
  onMoveNode,
}: TreeNodeProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(depth === 0);
  const [children, setChildren] = useState<FileTreeNode[] | null>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const dragHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (dragHoverTimerRef.current) clearTimeout(dragHoverTimerRef.current);
    };
  }, []);

  const isJava = !node.isDirectory && node.name.endsWith('.java');
  const [detectedType, setDetectedType] = useState<CodeSubtype>(() => {
    return codeTypeCache.get(node.path) || detectCodeSubtype(node.name);
  });

  useEffect(() => {
    if (!isJava) return;
    if (codeTypeCache.has(node.path)) {
      setDetectedType(codeTypeCache.get(node.path)!);
      return;
    }
    // 远程 SSH 工作区绝不发起批量 readFile 泛洪，直接信赖高精度智能文件名推断
    if (isRemote) return;

    let cancelled = false;
    if (window.ide?.readFile) {
      scheduleDetect(async () => {
        if (cancelled) return;
        try {
          const content = await window.ide.readFile(node.path);
          if (cancelled || !content) return;
          const resolved = detectCodeSubtype(node.name, content.slice(0, 800));
          codeTypeCache.set(node.path, resolved);
          setDetectedType(resolved);
        } catch {}
      });
    }
    return () => {
      cancelled = true;
    };
  }, [node.path, isJava, node.name, isRemote]);

  useEffect(() => {
    if (collapseKey && collapseKey > 0) {
      setOpen(false);
    }
  }, [collapseKey]);

  useEffect(() => {
    if (expandKey && expandKey > 0) {
      if (depth === 1) {
        setOpen(true);
      }
    }
  }, [expandKey, depth]);

  const showRename = inlineEdit?.mode === 'rename' && inlineEdit.node.path === node.path;
  const showCreateHere =
    inlineEdit &&
    (inlineEdit.mode === 'create-file' || inlineEdit.mode === 'create-folder') &&
    inlineEdit.parentPath === node.path;

  useEffect(() => {
    if (!node.isDirectory || !open) return;
    void window.ide.listDir(node.path).then(setChildren);
  }, [node.isDirectory, node.path, open, refreshKey]);

  useEffect(() => {
    if (!expandPath || !node.isDirectory) return;
    const expandRel = normalizePathToRel(expandPath, undefined);
    const nodeRel = normalizePathToRel(node.path, undefined);
    if (
      expandPath === node.path ||
      expandPath.startsWith(`${node.path}/`) ||
      node.path.startsWith(`${expandPath}/`) ||
      (expandRel &&
        nodeRel &&
        (expandRel === nodeRel ||
          expandRel.startsWith(`${nodeRel}/`) ||
          nodeRel.startsWith(`${expandRel}/`)))
    ) {
      setOpen(true);
    }
  }, [expandPath, node.isDirectory, node.path, locateKey]);

  const gitMeta = getNodeGitStatus(node.path, node.isDirectory, gitIndex);

  const indents = [];
  for (let i = 1; i <= depth; i++) {
    indents.push(<div key={i} className="tree-indent-guide" style={{ left: 16 * i - 4 }} />);
  }

  /**
   * 定位滚动用的 ref 与 effect。**必须放在下面 `if (node.isDirectory)` 之前**：
   * 那条分支会提前 return，把这对 hook 留在它后面时，同一个节点从目录变文件
   * （重命名、拖拽、或列表刷新后复用同一个 key）会让 hook 数量变化，React 直接抛
   * `Rendered more hooks than during the previous render`，整棵文件树变成错误页。
   * 目录节点只是拿不到 `nodeRef`（分支里没挂 `ref`），effect 自然什么都不做。
   */
  const nodeRef = useRef<HTMLDivElement>(null);

  const activeRel = normalizePathToRel(activePath, undefined);
  const nodeRel = normalizePathToRel(node.path, undefined);
  const isThisActive =
    activePath === node.path ||
    (activeRel && nodeRel && activeRel === nodeRel) ||
    (activeRel && activeRel.endsWith('/' + nodeRel)) ||
    (nodeRel && nodeRel.endsWith('/' + activeRel));

  useEffect(() => {
    if (isThisActive && nodeRef.current) {
      const el = nodeRef.current;
      const container = el.closest('.explorer-tree-body') as HTMLElement | null;
      if (!container) return;

      const triggerScroll = (smooth: boolean) => {
        const elRect = el.getBoundingClientRect();
        const cRect = container.getBoundingClientRect();
        if (elRect.top < cRect.top || elRect.bottom > cRect.bottom || smooth) {
          const targetScroll =
            container.scrollTop + (elRect.top - cRect.top) - cRect.height / 2 + elRect.height / 2;
          container.scrollTo({
            top: Math.max(0, targetScroll),
            behavior: smooth ? 'smooth' : 'auto',
          });
        }
      };

      if (locateKey && locateKey > 0) {
        const t = setTimeout(() => triggerScroll(true), 100);
        return () => clearTimeout(t);
      } else {
        const t = setTimeout(() => triggerScroll(false), 50);
        return () => clearTimeout(t);
      }
    }
  }, [isThisActive, locateKey]);

  if (node.isDirectory) {
    const stickyTop = (depth - 1) * 24;
    return (
      <div className="file-tree-dir-group" style={{ position: 'relative' }}>
        {showRename ? (
          <InlineNameInput
            initial={node.name}
            placeholder={t('tree.folderName')}
            depth={depth}
            onSubmit={(name) => onInlineDone(inlineEdit, name)}
            onCancel={onInlineCancel}
          />
        ) : (
          <div
            draggable={!showRename && !showCreateHere}
            onDragStart={(e) => {
              e.dataTransfer.setData(
                'application/json',
                JSON.stringify({ path: node.path, isDirectory: true }),
              );
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }}
            onDragEnter={(e) => {
              e.preventDefault();
              setIsDropTarget(true);
              if (!open) {
                if (dragHoverTimerRef.current) clearTimeout(dragHoverTimerRef.current);
                dragHoverTimerRef.current = setTimeout(() => {
                  setOpen(true);
                }, 500);
              }
            }}
            onDragLeave={() => {
              setIsDropTarget(false);
              if (dragHoverTimerRef.current) {
                clearTimeout(dragHoverTimerRef.current);
                dragHoverTimerRef.current = null;
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDropTarget(false);
              if (dragHoverTimerRef.current) {
                clearTimeout(dragHoverTimerRef.current);
                dragHoverTimerRef.current = null;
              }
              const raw = e.dataTransfer.getData('application/json');
              if (raw && onMoveNode) {
                try {
                  const data = JSON.parse(raw);
                  onMoveNode(data.path, node.path, !!data.isDirectory);
                } catch {}
              }
            }}
            className={`file-node file-node-dir ${isDropTarget ? 'drop-target-active' : ''} ${selectedNode?.path === node.path && !activePath ? 'active' : ''} ${gitMeta?.isIgnored ? 'is-git-ignored' : ''}`}
            style={{
              paddingLeft: 12 + depth * 16,
              position: 'sticky',
              top: stickyTop,
              zIndex: Math.max(1, 20 - depth),
            }}
            onClick={() => {
              if (onSelectNode) onSelectNode({ path: node.path, isDirectory: true });
              setOpen((v) => !v);
            }}
            onContextMenu={(e) => onContextNode(e, node)}
          >
            {indents}
            <PanelChevron
              expanded={open}
              size={12}
              style={{
                marginRight: 2,
                position: 'relative',
                zIndex: 1,
              }}
            />
            <span
              className="folder-icon"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                position: 'relative',
                zIndex: 1,
              }}
            >
              <RenderFileTreeIcon name={node.name} isDirectory={true} isOpen={open} />
            </span>
            <span
              className="file-node-name"
              style={{
                color: gitMeta?.hasChanges ? '#e5a54b' : gitMeta?.color || 'var(--text)',
                fontWeight: 500,
                position: 'relative',
                zIndex: 1,
              }}
              title={node.name}
            >
              {node.name}
            </span>
            {gitMeta?.hasChanges && <span className="git-dir-dot">●</span>}
          </div>
        )}

        {showCreateHere && (
          <InlineNameInput
            initial=""
            placeholder={
              inlineEdit.mode === 'create-file' ? t('tree.fileName') : t('tree.folderName')
            }
            depth={depth + 1}
            onSubmit={(name) => onInlineDone(inlineEdit, name)}
            onCancel={onInlineCancel}
          />
        )}

        {open && children && (
          <>
            {children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                selectedNode={selectedNode}
                gitIndex={gitIndex}
                refreshKey={refreshKey}
                collapseKey={collapseKey}
                expandKey={expandKey}
                locateKey={locateKey}
                expandPath={expandPath}
                inlineEdit={inlineEdit}
                onOpenFile={onOpenFile}
                onSelectNode={onSelectNode}
                onContextNode={onContextNode}
                onInlineDone={onInlineDone}
                onInlineCancel={onInlineCancel}
                onMoveNode={onMoveNode}
                isRemote={isRemote}
              />
            ))}
          </>
        )}
      </div>
    );
  }

  if (showRename) {
    return (
      <InlineNameInput
        initial={node.name}
        placeholder={t('tree.fileName')}
        depth={depth}
        onSubmit={(name) => onInlineDone(inlineEdit, name)}
        onCancel={onInlineCancel}
      />
    );
  }

  return (
    <div
      ref={nodeRef}
      draggable={!showRename}
      onDragStart={(e) => {
        e.dataTransfer.setData(
          'application/json',
          JSON.stringify({ path: node.path, isDirectory: false }),
        );
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => {
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'none';
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className={`file-node ${selectedNode?.path === node.path || isThisActive ? 'active' : ''} ${gitMeta?.isIgnored ? 'is-git-ignored' : ''}`}
      style={{
        paddingLeft: 12 + depth * 16,
        opacity: gitMeta?.isIgnored ? 0.52 : undefined,
      }}
      onClick={() => {
        if (onSelectNode) onSelectNode({ path: node.path, isDirectory: false });
        onOpenFile(node.path);
      }}
      onContextMenu={(e) => onContextNode(e, node)}
    >
      {indents}
      <span style={{ width: 14, zIndex: 1 }} />
      <span style={{ zIndex: 1, display: 'flex' }}>
        <RenderFileTreeIcon name={node.name} isDirectory={false} codeType={detectedType} />
      </span>
      <span
        className="file-node-name"
        style={{
          color: gitMeta?.color,
          paddingRight: gitMeta?.label ? 32 : 8,
        }}
        title={node.name}
      >
        {node.name}
      </span>
      {gitMeta?.label && (
        <span
          className={`git-file-status-tag ${gitMeta.label.toLowerCase()}`}
          style={{ color: gitMeta.color }}
        >
          <span className="git-status-dot" style={{ backgroundColor: gitMeta.color }} />
          <span>{gitMeta.label}</span>
        </span>
      )}
    </div>
  );
}

const TreeNode = memo(TreeNodeComponent, areTreeNodePropsEqual);

function FindInFolderModal({
  folderPath,
  onOpenFile,
  onClose,
}: {
  folderPath: string;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Esc key listener with capture phase
  useEffect(() => {
    const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    async function walk(dir: string, acc: string[]): Promise<void> {
      const entries = await window.ide.listDir(dir);
      for (const e of entries) {
        if (cancelled) return;
        const base = e.name || basename(e.path);
        if (e.isDirectory) {
          if (
            base === '.git' ||
            base === 'node_modules' ||
            base === '.next' ||
            base === 'dist' ||
            base === 'build'
          )
            continue;
          await walk(e.path, acc);
        } else {
          acc.push(e.path);
        }
      }
    }
    setScanning(true);
    void (async () => {
      const all: string[] = [];
      try {
        await walk(folderPath, all);
      } catch {
        /* ignore */
      }
      if (!cancelled) {
        setHits(all);
        setScanning(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [folderPath]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? hits.filter((p) => basename(p).toLowerCase().includes(q) || p.toLowerCase().includes(q))
    : hits.slice(0, 300);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Keep selected item visible
  useEffect(() => {
    if (!listRef.current) return;
    const activeItem = listRef.current.querySelector<HTMLElement>(
      `[data-index="${selectedIndex}"]`,
    );
    if (activeItem) {
      activeItem.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : Math.max(0, filtered.length - 1)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = filtered[selectedIndex];
      if (target) {
        onOpenFile(target);
        onClose();
      }
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  const safeOverlay = createSafeOverlayHandlers(onClose);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="settings-overlay find-folder-overlay" {...safeOverlay}>
      <div className="find-folder-modal" onClick={(e) => e.stopPropagation()}>
        <div className="find-folder-header">
          <div className="find-folder-title-row">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="find-folder-header-icon"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <circle cx="11" cy="11" r="3" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <h2 className="find-folder-title">{t('findInFolder.title')}</h2>
            <span className="find-folder-path-tag" title={folderPath}>
              {folderPath}
            </span>
          </div>
          <button
            type="button"
            className="panel-action-btn"
            onClick={onClose}
            title={t('findInFolder.close')}
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
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="find-folder-search-box">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="find-folder-search-icon"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            autoFocus
            type="text"
            className="find-folder-input"
            placeholder={t('findInFolder.filterPh')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          {query && (
            <button
              type="button"
              className="find-folder-clear-btn"
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
              title={t('findInFolder.clear')}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        <div className="find-folder-results" ref={listRef}>
          {scanning && (
            <div className="find-folder-empty">
              <span className="find-folder-spinner" />
              <span>{t('findInFolder.scanning')}</span>
            </div>
          )}
          {!scanning && filtered.length === 0 && (
            <div className="find-folder-empty">
              <span>{query ? t('findInFolder.noMatch') : t('findInFolder.noFiles')}</span>
            </div>
          )}
          {!scanning &&
            filtered.map((p, idx) => {
              const isSelected = idx === selectedIndex;
              const fileBase = basename(p);
              const parentDir = parentOf(p);
              return (
                <div
                  key={p}
                  data-index={idx}
                  className={`find-folder-hit ${isSelected ? 'selected' : ''}`}
                  onClick={() => {
                    onOpenFile(p);
                    onClose();
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  <span className="find-folder-hit-icon">
                    <RenderFileTreeIcon
                      name={fileBase}
                      isDirectory={false}
                      codeType={codeTypeCache.get(p) || detectCodeSubtype(fileBase)}
                    />
                  </span>
                  <span className="find-folder-hit-name" title={fileBase}>
                    {fileBase}
                  </span>
                  <span className="find-folder-hit-dir" title={p}>
                    {parentDir === '.' ? '' : parentDir}
                  </span>
                </div>
              );
            })}
        </div>

        <div className="find-folder-footer">
          <div className="find-folder-meta">
            <span className="find-folder-count">
              {scanning
                ? t('findInFolder.scanningShort')
                : t('findInFolder.count', { n: filtered.length })}
            </span>
            <span className="find-folder-tips">
              <kbd>↑↓</kbd> {t('findInFolder.navNav')} <kbd>↵</kbd> {t('findInFolder.navOpen')}{' '}
              <kbd>Esc</kbd> {t('findInFolder.navClose')}
            </span>
          </div>
          <button type="button" className="find-folder-action-btn" onClick={onClose}>
            {t('findInFolder.closeBtn')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export type FileTreeHandle = {
  createFile: () => void;
  createFolder: () => void;
  collapseAll: () => void;
  expandAll: () => void;
  locateActiveFile: (targetPath?: string) => void;
};

interface Props extends FileTreeHandlers {
  workspace: string | null;
  activePath: string | null;
  selectedNode?: { path: string; isDirectory: boolean } | null;
  gitStatus?: GitStatusResult | null;
  onViewFileHistory?: (path: string) => void;
  onDiscardPath?: (path: string) => void | Promise<void>;
  onPreviewGitDiff?: (path: string) => void;
  onAnnotateGitBlame?: (path: string) => void;
  onCompareWithRevision?: (path: string) => void;
  onCompareWithBranchOrTag?: (path: string) => void;
  onShowCurrentRevision?: (path: string) => void;
  onRollbackPath?: (path: string) => void;
  onFileMoved?: (oldPath: string, newPath: string) => void;
  onShowToast?: (
    title: string,
    detail?: string,
    type?: 'success' | 'error' | 'info' | 'warn',
  ) => void;
  refreshKey: number;
  isRemote?: boolean;
}

export const FileTree = forwardRef<FileTreeHandle, Props>(function FileTree(
  {
    workspace,
    activePath,
    selectedNode = null,
    gitStatus,
    isRemote,
    onViewFileHistory,
    onDiscardPath,
    onPreviewGitDiff,
    onAnnotateGitBlame,
    onCompareWithRevision,
    onCompareWithBranchOrTag,
    onShowCurrentRevision,
    onRollbackPath,
    onFileMoved,
    onShowToast,
    onOpenFile,
    onOpenTerminal,
    onAddToChat,
    onAddToNewChat,
    onSelectNode,
    refreshKey: extRefreshKey,
  }: Props,
  ref,
) {
  const { t } = useI18n();
  // 建一次索引给整棵树用。依赖只看 entries / ignoredPaths 这两个**数组本身**：
  // 外层每次 git 刷新都会给出新数组，索引随之重建（这正是需要的）；
  // 而不相关的状态变化（展开、选中、行内改名）不会改变这两个引用，
  // 于是整棵树的 O(1) 查表结果保持稳定。
  const gitIndex = useMemo(
    () => buildGitStatusIndex(gitStatus?.entries, gitStatus?.ignoredPaths),
    [gitStatus?.entries, gitStatus?.ignoredPaths],
  );
  const [roots, setRoots] = useState<FileTreeNode[]>([]);
  const [localRefreshKey, setLocalRefreshKey] = useState(0);
  const [collapseKey, setCollapseKey] = useState(0);
  const [expandKey, setExpandKey] = useState(0);
  const [locateKey, setLocateKey] = useState(0);
  const refreshKey = (extRefreshKey ?? 0) + localRefreshKey;
  const effectiveIsRemote =
    isRemote ?? Boolean(workspace && (workspace.startsWith('ssh:') || workspace.includes('@')));
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [clipboard, setClipboard] = useState<PathClipboard>(null);
  const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null);
  // 永久删除文件走应用内确认框：系统 window.confirm 不是应用主题色，也列不出完整路径与目录规模
  const confirm = useDbConfirm();
  const [expandPath, setExpandPath] = useState<string | null>(null);
  const [findFolder, setFindFolder] = useState<string | null>(null);
  const [isRootDropTarget, setIsRootDropTarget] = useState(false);

  const handleMoveNode = useCallback(
    async (sourcePath: string, targetDirPath: string, sourceIsDir: boolean) => {
      const check = validateMove(sourcePath, targetDirPath, sourceIsDir);
      if (!check.valid) {
        // 拖回原目录等于没动，用户没做错事，不该弹警告；其余拒绝原因要说明白
        if (check.code !== 'already-in-target') {
          onShowToast?.(t('tree.moveFailed'), t(`tree.moveReject.${check.code}`), 'warn');
        }
        return;
      }

      try {
        await window.ide.renamePath(sourcePath, check.newPath);
        onFileMoved?.(sourcePath, check.newPath);
        setLocalRefreshKey((k) => k + 1);
        const fileName = sourcePath.split(/[/\\]/).pop() || sourcePath;
        const targetLabel = targetDirPath === '.' ? t('tree.rootDir') : targetDirPath;
        onShowToast?.(
          t('tree.moveOk'),
          t('tree.moveOkDetail', { name: fileName, target: targetLabel }),
          'success',
        );
      } catch (err) {
        onShowToast?.(
          t('tree.moveFail'),
          err instanceof Error ? err.message : String(err),
          'error',
        );
      }
    },
    [onFileMoved, onShowToast, t],
  );

  const bump = () => setLocalRefreshKey((k) => k + 1);

  useImperativeHandle(ref, () => ({
    createFile: () => {
      const parent = selectedNode
        ? selectedNode.isDirectory
          ? selectedNode.path
          : selectedNode.path.includes('/')
            ? selectedNode.path.substring(0, selectedNode.path.lastIndexOf('/'))
            : '.'
        : activePath
          ? activePath.includes('/')
            ? activePath.substring(0, activePath.lastIndexOf('/'))
            : '.'
          : '.';
      setExpandPath(parent === '.' ? null : parent);
      setInlineEdit({ mode: 'create-file', parentPath: parent });
      bump();
    },
    createFolder: () => {
      const parent = selectedNode
        ? selectedNode.isDirectory
          ? selectedNode.path
          : selectedNode.path.includes('/')
            ? selectedNode.path.substring(0, selectedNode.path.lastIndexOf('/'))
            : '.'
        : activePath
          ? activePath.includes('/')
            ? activePath.substring(0, activePath.lastIndexOf('/'))
            : '.'
          : '.';
      setExpandPath(parent === '.' ? null : parent);
      setInlineEdit({ mode: 'create-folder', parentPath: parent });
      bump();
    },
    collapseAll: () => {
      setCollapseKey((k) => k + 1);
    },
    expandAll: () => {
      setExpandKey((k) => k + 1);
    },
    locateActiveFile: (targetPath?: string) => {
      const p = targetPath || activePath;
      if (!p || p === '.') return;
      const rel = normalizePathToRel(p, workspace) || p;
      setExpandPath(rel);
      setLocateKey((k) => k + 1);
      onSelectNode?.({ path: p, isDirectory: false });
    },
  }));

  useEffect(() => {
    if (!workspace) {
      setRoots([]);
      return;
    }
    void window.ide.listDir('.').then(setRoots);
  }, [workspace, refreshKey]);

  // Auto-reveal active file: set expandPath to activePath (normalized to workspace relative path)
  useEffect(() => {
    if (activePath && activePath !== '.') {
      const rel = normalizePathToRel(activePath, workspace);
      setExpandPath(rel || activePath);
    }
  }, [activePath, workspace]);

  const openMenu = (e: ReactMouseEvent, target: MenuTarget) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, target });
  };

  const dirForCreate = (target: MenuTarget): string => {
    if (target.kind === 'blank') return '.';
    if (target.node.isDirectory) return target.node.path;
    return parentOf(target.node.path);
  };

  const terminalCwd = (target: MenuTarget): string => {
    if (target.kind === 'blank') return '.';
    if (target.node.isDirectory) return target.node.path;
    return parentOf(target.node.path);
  };

  async function uniqueName(parent: string, base: string): Promise<string> {
    let name = base;
    let i = 1;
    while (await window.ide.pathExists(joinRel(parent, name))) {
      const dot = base.lastIndexOf('.');
      if (dot > 0) {
        name = `${base.slice(0, dot)} (${i})${base.slice(dot)}`;
      } else {
        name = `${base} (${i})`;
      }
      i += 1;
    }
    return name;
  }

  async function handleInlineDone(edit: InlineEdit, name: string): Promise<void> {
    setInlineEdit(null);
    try {
      if (edit.mode === 'create-file') {
        const path = joinRel(edit.parentPath, name);
        if (await window.ide.pathExists(path)) {
          showGlobalToast(t('tree.nameExistsFile'), 'warn');
          return;
        }
        await window.ide.writeFile(path, '');
        // 自动展开目标父目录并聚焦新文件
        setExpandPath(path);
        bump();
        window.dispatchEvent(new CustomEvent('echoly:refreshFileTree'));
        setTimeout(() => bump(), 60);
        onOpenFile(path);
      } else if (edit.mode === 'create-folder') {
        const path = joinRel(edit.parentPath, name);
        if (await window.ide.pathExists(path)) {
          showGlobalToast(t('tree.nameExistsFolder'), 'warn');
          return;
        }
        await window.ide.mkdir(path);
        // 自动展开新创建的文件夹
        setExpandPath(path);
        bump();
        window.dispatchEvent(new CustomEvent('echoly:refreshFileTree'));
        setTimeout(() => bump(), 60);
      } else if (edit.mode === 'rename') {
        const parent = parentOf(edit.node.path);
        const next = joinRel(parent, name);
        if (next === edit.node.path) return;
        if (await window.ide.pathExists(next)) {
          showGlobalToast(t('tree.targetExists'), 'warn');
          return;
        }
        await window.ide.renamePath(edit.node.path, next);
        setExpandPath(next);
        bump();
        window.dispatchEvent(new CustomEvent('echoly:refreshFileTree'));
        setTimeout(() => bump(), 60);
        if (!edit.node.isDirectory) onOpenFile(next);
      }
    } catch (err) {
      // 新建/重命名失败（权限不足、目标被占用、名字非法）必须让用户看到，
      // 否则输入框一关就好像什么都没发生，文件却并没有出现。
      showGlobalToast(
        t('tree.operationFailed'),
        'error',
        err instanceof Error ? err.message : String(err),
      );
      bump();
    }
  }

  async function handleAction(action: string): Promise<void> {
    if (!menu) return;
    const { target } = menu;
    setMenu(null);
    const node = target.kind === 'node' ? target.node : null;

    try {
      switch (action) {
        case 'new-file': {
          const parent = dirForCreate(target);
          setExpandPath(parent === '.' ? null : parent);
          setInlineEdit({ mode: 'create-file', parentPath: parent });
          if (parent === '.') bump();
          else setExpandPath(parent);
          bump();
          break;
        }
        case 'new-folder': {
          const parent = dirForCreate(target);
          setExpandPath(parent === '.' ? null : parent);
          setInlineEdit({ mode: 'create-folder', parentPath: parent });
          bump();
          break;
        }
        case 'open-terminal':
          onOpenTerminal(terminalCwd(target));
          break;
        case 'add-chat':
          if (node) onAddToChat(node.path);
          break;
        case 'add-new-chat':
          if (node) onAddToNewChat(node.path);
          break;
        case 'find-in-folder':
          if (node?.isDirectory) setFindFolder(node.path);
          break;
        case 'cut':
          if (node) setClipboard({ mode: 'cut', path: node.path, isDirectory: node.isDirectory });
          break;
        case 'copy':
          if (node) setClipboard({ mode: 'copy', path: node.path, isDirectory: node.isDirectory });
          break;
        case 'paste': {
          if (!clipboard) return;
          const destParent = dirForCreate(target);
          const name = await uniqueName(destParent, basename(clipboard.path));
          const dest = joinRel(destParent, name);
          if (clipboard.mode === 'copy') {
            await window.ide.copyPath(clipboard.path, dest);
          } else {
            await window.ide.renamePath(clipboard.path, dest);
            setClipboard(null);
          }
          setExpandPath(destParent === '.' ? dest : destParent);
          bump();
          window.dispatchEvent(new CustomEvent('echoly:refreshFileTree'));
          break;
        }
        case 'download':
          if (node && !node.isDirectory) {
            await window.ide.downloadFile(node.path);
          }
          break;
        case 'git-annotate':
          if (node && !node.isDirectory) onAnnotateGitBlame?.(node.path);
          break;
        case 'git-diff':
          if (node && !node.isDirectory) onPreviewGitDiff?.(node.path);
          break;
        case 'git-compare-revision':
          if (node && !node.isDirectory) onCompareWithRevision?.(node.path);
          break;
        case 'git-compare-branch':
          if (node && !node.isDirectory) onCompareWithBranchOrTag?.(node.path);
          break;
        case 'git-history':
          if (node) onViewFileHistory?.(node.path);
          break;
        case 'git-current-revision':
          if (node && !node.isDirectory) onShowCurrentRevision?.(node.path);
          break;
        case 'git-rollback':
          if (node) {
            if (onRollbackPath) onRollbackPath(node.path);
            else onDiscardPath?.(node.path);
          }
          break;
        case 'git-discard':
          if (node) {
            // 确认由 App 的 handleDiscardPath 统一负责（全应用放弃修改的收口点）；
            // 这里先 await 再刷新，否则用户取消后文件树仍会被刷一遍、看着像已经还原了
            await onDiscardPath?.(node.path);
            bump();
            window.dispatchEvent(new CustomEvent('echoly:refreshFileTree'));
          }
          break;
        case 'copy-abs':
          if (node) {
            const abs = await window.ide.resolveAbsolutePath(node.path);
            await navigator.clipboard.writeText(abs);
          }
          break;
        case 'copy-rel':
          if (node) await navigator.clipboard.writeText(node.path);
          break;
        case 'reveal-in-finder':
          if (node) {
            const abs = await window.ide.resolveAbsolutePath(node.path);
            await window.ide.showItemInFolder(abs);
          }
          break;
        case 'rename':
          if (node) setInlineEdit({ mode: 'rename', node });
          break;
        case 'delete':
          if (node) {
            const ok = await confirm.confirm({
              title: node.isDirectory ? t('tree.deleteFolderTitle') : t('tree.deleteFileTitle'),
              content: buildSqlConfirmMarkdown({
                t,
                intro: node.isDirectory ? t('tree.deleteFolderBody') : t('tree.deleteFileBody'),
                statements: [],
              }),
              details: [
                { label: t('tree.labelPath'), value: node.path },
                ...(node.isDirectory
                  ? [{ label: t('tree.labelType'), value: t('tree.typeFolderRecursive') }]
                  : []),
              ],
              tone: 'danger',
              confirmLabel: t('tree.confirmDelete'),
            });
            if (ok === null) return;
            await window.ide.removePath(node.path);
            bump();
            window.dispatchEvent(
              new CustomEvent('echoly:refreshFileTree', {
                detail: { deletedPath: node.path, isDirectory: node.isDirectory },
              }),
            );
          }
          break;
        default:
          break;
      }
    } catch (err) {
      showGlobalToast(
        t('tree.operationFailed'),
        'error',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (!workspace) {
    return <div className="empty-state">{t('tree.emptyOpen')}</div>;
  }

  const rootCreate =
    inlineEdit &&
    (inlineEdit.mode === 'create-file' || inlineEdit.mode === 'create-folder') &&
    inlineEdit.parentPath === '.';

  return (
    <div
      className={`file-tree ${isRootDropTarget ? 'drop-target-root-active' : ''}`}
      onDragOver={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        } else {
          setIsRootDropTarget(false);
        }
      }}
      onDragEnter={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          setIsRootDropTarget(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setIsRootDropTarget(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsRootDropTarget(false);
        if (e.target !== e.currentTarget) return;
        const raw = e.dataTransfer.getData('application/json');
        if (raw) {
          try {
            const data = JSON.parse(raw);
            void handleMoveNode(data.path, '.', !!data.isDirectory);
          } catch {}
        }
      }}
      onContextMenu={(e) => openMenu(e, { kind: 'blank' })}
    >
      {rootCreate && (
        <InlineNameInput
          initial=""
          placeholder={
            inlineEdit.mode === 'create-file' ? t('tree.fileName') : t('tree.folderName')
          }
          depth={0}
          onSubmit={(name) => void handleInlineDone(inlineEdit, name)}
          onCancel={() => setInlineEdit(null)}
        />
      )}
      {roots.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={1}
          activePath={activePath}
          selectedNode={selectedNode}
          gitIndex={gitIndex}
          refreshKey={refreshKey}
          collapseKey={collapseKey}
          expandKey={expandKey}
          locateKey={locateKey}
          expandPath={expandPath}
          inlineEdit={inlineEdit}
          onOpenFile={onOpenFile}
          onSelectNode={onSelectNode}
          onContextNode={(e, n) => openMenu(e, { kind: 'node', node: n })}
          onInlineDone={(edit, name) => void handleInlineDone(edit, name)}
          onInlineCancel={() => setInlineEdit(null)}
          onMoveNode={handleMoveNode}
          isRemote={effectiveIsRemote}
        />
      ))}
      {menu && (
        <FileTreeContextMenu
          state={menu}
          clipboard={clipboard}
          gitStatus={gitStatus}
          onClose={() => setMenu(null)}
          onAction={(a) => void handleAction(a)}
        />
      )}
      {findFolder && (
        <FindInFolderModal
          folderPath={findFolder}
          onOpenFile={onOpenFile}
          onClose={() => setFindFolder(null)}
        />
      )}
      {confirm.modal}
    </div>
  );
});
