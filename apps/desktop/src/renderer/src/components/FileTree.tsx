import {
  forwardRef,
  useImperativeHandle,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import type { FileTreeNode, GitStatusEntry, GitStatusResult } from '@deepseek-ide/shared';

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
  workspaceRoot: string | null | undefined
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
  const ref = useRef<HTMLDivElement>(null);
  const isBlank = state.target.kind === 'blank';
  const node = state.target.kind === 'node' ? state.target.node : null;
  const isDir = !!node?.isDirectory;
  const canPaste = !!clipboard;

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
    const rect = el.getBoundingClientRect();
    let { x, y } = state;
    if (x + rect.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - rect.width - 8);
    if (y + rect.height > window.innerHeight - 8)
      y = Math.max(8, window.innerHeight - rect.height - 8);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [state]);

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
    items.push(item('new-file', '新建文件...'));
    items.push(item('new-folder', '新建文件夹...'));
  }
  if (node) {
    items.push(item('open-terminal', '在集成终端中打开'));
    items.push(sep('s1'));
    items.push(item('add-chat', '添加到聊天'));
    items.push(item('add-new-chat', '在新对话中添加'));
    if (isDir) {
      items.push(sep('s2'));
      items.push(item('find-in-folder', '在文件夹中查找...'));
    }
    items.push(sep('s3'));
    items.push(item('cut', '剪切'));
    items.push(item('copy', '复制'));
  }
  items.push(item('paste', '粘贴', { disabled: !canPaste }));
  if (node && !isDir) {
    items.push(sep('s7'));
    items.push(item('git-history', 'Git: View File History'));
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
    items.push(sep('s-git'));
    items.push(item('git-discard', '放弃更改 (Discard Changes)...', { danger: true }));
  }
  if (node) {
    items.push(sep('s5'));
    items.push(item('copy-abs', '复制路径'));
    items.push(item('copy-rel', '复制相对路径'));
    items.push(sep('s6'));
    items.push(item('rename', '重命名...'));
    items.push(item('delete', '永久删除', { danger: true }));
  }

  return (
    <div className="ctx-menu" ref={ref} role="menu">
      {items}
    </div>
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

import { RenderFileTreeIcon } from './FileIcons';
export { RenderFileTreeIcon };


function getNodeGitStatus(
  nodePath: string,
  isDir: boolean,
  entries: GitStatusEntry[] = [],
): { label?: string; hasChanges?: boolean; color?: string } | null {
  if (
    !nodePath ||
    typeof nodePath !== 'string' ||
    !entries ||
    !Array.isArray(entries) ||
    !entries.length
  )
    return null;
  const norm = nodePath.replace(/\\/g, '/');

  try {
    if (!isDir) {
      const matched = entries.find((e) => e && e.path === norm);
      if (!matched) return null;
      if (matched.untracked) return { label: 'U', color: '#4caf50' };
      if (matched.staged) return { label: 'A', color: '#4caf50' };
      if (matched.workTree && matched.workTree.trim()) return { label: 'M', color: '#e5a54b' };
      return null;
    } else {
      const hasSubChanges = entries.some(
        (e) => e && e.path && (e.path.startsWith(norm + '/') || e.path === norm),
      );
      if (hasSubChanges) {
        return { hasChanges: true, color: '#e5a54b' };
      }
      return null;
    }
  } catch {
    return null;
  }
}

function TreeNode({
  node,
  depth,
  activePath,
  selectedNode,
  gitEntries = [],
  refreshKey,
  expandPath,
  inlineEdit,
  onOpenFile,
  onSelectNode,
  onContextNode,
  onInlineDone,
  onInlineCancel,
}: {
  node: FileTreeNode;
  depth: number;
  activePath: string | null;
  selectedNode: { path: string; isDirectory: boolean } | null;
  gitEntries?: GitStatusEntry[];
  refreshKey: number;
  expandPath: string | null;
  inlineEdit: InlineEdit | null;
  onOpenFile: (path: string) => void;
  onSelectNode?: (node: { path: string; isDirectory: boolean } | null) => void;
  onContextNode: (e: ReactMouseEvent, node: FileTreeNode) => void;
  onInlineDone: (edit: InlineEdit, name: string) => void;
  onInlineCancel: () => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const [children, setChildren] = useState<FileTreeNode[] | null>(null);

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
      (expandRel && nodeRel && (
        expandRel === nodeRel ||
        expandRel.startsWith(`${nodeRel}/`) ||
        nodeRel.startsWith(`${expandRel}/`)
      ))
    ) {
      setOpen(true);
    }
  }, [expandPath, node.isDirectory, node.path]);

  const gitMeta = getNodeGitStatus(node.path, node.isDirectory, gitEntries);

  const indents = [];
  for (let i = 1; i <= depth; i++) {
    indents.push(<div key={i} className="tree-indent-guide" style={{ left: 16 * i - 4 }} />);
  }

  if (node.isDirectory) {
    const stickyTop = (depth - 1) * 24;
    return (
      <div>
        {showRename ? (
          <InlineNameInput
            initial={node.name}
            placeholder="文件夹名"
            depth={depth}
            onSubmit={(name) => onInlineDone(inlineEdit, name)}
            onCancel={onInlineCancel}
          />
        ) : (
          <div
            className={`file-node file-node-dir ${selectedNode?.path === node.path ? 'active' : ''}`}
            style={{
              paddingLeft: 12 + depth * 16,
              position: 'sticky',
              top: stickyTop,
              zIndex: 50 - depth,
            }}
            onClick={() => {
              if (onSelectNode) onSelectNode({ path: node.path, isDirectory: node.isDirectory });
              setOpen((v) => !v);
            }}
            onContextMenu={(e) => onContextNode(e, node)}
          >
            {indents}
            <span
              style={{
                marginRight: 6,
                fontSize: 13,
                fontWeight: 'bold',
                width: 12,
                display: 'inline-block',
                textAlign: 'center',
                zIndex: 1,
              }}
            >
              {open ? '▾' : '▸'}
            </span>
            <span style={{ zIndex: 1, display: 'flex' }}>
              <RenderFileTreeIcon name={node.name} isDirectory={true} isOpen={open} />
            </span>
            <span
              className="file-node-name"
              style={{
                color: gitMeta?.hasChanges ? '#e5a54b' : undefined,
                paddingRight: gitMeta?.hasChanges ? 32 : 8,
              }}
              title={node.name}
            >
              {node.name}
            </span>
            {gitMeta?.hasChanges && <span className="git-dir-dot">●</span>}
          </div>
        )}
        {open && (
          <>
            {showCreateHere && (
              <InlineNameInput
                initial=""
                placeholder={inlineEdit.mode === 'create-file' ? '文件名' : '文件夹名'}
                depth={depth + 1}
                onSubmit={(name) => onInlineDone(inlineEdit, name)}
                onCancel={onInlineCancel}
              />
            )}
            {children?.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                selectedNode={selectedNode}
                gitEntries={gitEntries}
                refreshKey={refreshKey}
                expandPath={expandPath}
                inlineEdit={inlineEdit}
                onOpenFile={onOpenFile}
                onSelectNode={onSelectNode}
                onContextNode={onContextNode}
                onInlineDone={onInlineDone}
                onInlineCancel={onInlineCancel}
              />
            ))}
          </>
        )}
      </div>
    );
  }

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
      // Small timeout to allow directory expansion to finish rendering。
      // 用 'auto' 代替 'smooth'：smooth 滚动会在切换/刷新时产生长时间动画，拖慢感知。
      setTimeout(() => {
        nodeRef.current?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
      }, 50);
    }
  }, [isThisActive]);

  if (showRename) {
    return (
      <InlineNameInput
        initial={node.name}
        placeholder="文件名"
        depth={depth}
        onSubmit={(name) => onInlineDone(inlineEdit, name)}
        onCancel={onInlineCancel}
      />
    );
  }

  return (
    <div
      ref={nodeRef}
      className={`file-node ${selectedNode?.path === node.path || isThisActive ? 'active' : ''}`}
      style={{ paddingLeft: 12 + depth * 16 }}
      onClick={() => {
        if (onSelectNode) onSelectNode({ path: node.path, isDirectory: false });
        onOpenFile(node.path);
      }}
      onContextMenu={(e) => onContextNode(e, node)}
    >
      {indents}
      <span style={{ width: 14, zIndex: 1 }} />
      <span style={{ zIndex: 1, display: 'flex' }}>
        <RenderFileTreeIcon name={node.name} isDirectory={false} />
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
        <span className="git-file-status-tag" style={{ color: gitMeta.color }}>
          {gitMeta.label}
        </span>
      )}
    </div>
  );
}

function FindInFolderModal({
  folderPath,
  onOpenFile,
  onClose,
}: {
  folderPath: string;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}) {
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
          if (base === '.git' || base === 'node_modules' || base === '.next' || base === 'dist' || base === 'build') continue;
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

  return (
    <div className="settings-overlay find-folder-overlay" onClick={onClose}>
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
            <h2 className="find-folder-title">在文件夹中查找</h2>
            <span className="find-folder-path-tag" title={folderPath}>
              {folderPath}
            </span>
          </div>
          <button
            type="button"
            className="find-folder-close-btn"
            onClick={onClose}
            title="关闭 (Esc)"
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
            placeholder="按文件名或路径过滤…"
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
              title="清空"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
              <span>正在扫描文件夹文件…</span>
            </div>
          )}
          {!scanning && filtered.length === 0 && (
            <div className="find-folder-empty">
              <span>{query ? '未找到匹配文件' : '文件夹内暂无文件'}</span>
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
                    <RenderFileTreeIcon name={fileBase} isDirectory={false} />
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
              {scanning ? '扫描中…' : `共 ${filtered.length} 个文件`}
            </span>
            <span className="find-folder-tips">
              <kbd>↑↓</kbd> 导航 <kbd>↵</kbd> 打开 <kbd>Esc</kbd> 关闭
            </span>
          </div>
          <button type="button" className="find-folder-action-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

export type FileTreeHandle = {
  createFile: () => void;
  createFolder: () => void;
};

interface Props extends FileTreeHandlers {
  workspace: string | null;
  activePath: string | null;
  selectedNode?: { path: string; isDirectory: boolean } | null;
  gitStatus?: GitStatusResult | null;
  onViewFileHistory?: (path: string) => void;
  onDiscardPath?: (path: string) => void;
  refreshKey: number;
}

export const FileTree = forwardRef<FileTreeHandle, Props>(function FileTree(
  {
    workspace,
    activePath,
    selectedNode = null,
    gitStatus,
    onViewFileHistory,
    onDiscardPath,
    onOpenFile,
    onOpenTerminal,
    onAddToChat,
    onAddToNewChat,
    onSelectNode,
    refreshKey: extRefreshKey,
  }: Props,
  ref,
) {
  const [roots, setRoots] = useState<FileTreeNode[]>([]);
  const [localRefreshKey, setLocalRefreshKey] = useState(0);
  const refreshKey = (extRefreshKey ?? 0) + localRefreshKey;
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [clipboard, setClipboard] = useState<PathClipboard>(null);
  const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null);
  const [expandPath, setExpandPath] = useState<string | null>(null);
  const [findFolder, setFindFolder] = useState<string | null>(null);

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
          window.alert('已存在同名文件');
          return;
        }
        await window.ide.writeFile(path, '');
        setExpandPath(edit.parentPath === '.' ? path : edit.parentPath);
        bump();
        onOpenFile(path);
      } else if (edit.mode === 'create-folder') {
        const path = joinRel(edit.parentPath, name);
        if (await window.ide.pathExists(path)) {
          window.alert('已存在同名文件夹');
          return;
        }
        await window.ide.mkdir(path);
        setExpandPath(path);
        bump();
      } else if (edit.mode === 'rename') {
        const parent = parentOf(edit.node.path);
        const next = joinRel(parent, name);
        if (next === edit.node.path) return;
        if (await window.ide.pathExists(next)) {
          window.alert('目标已存在');
          return;
        }
        await window.ide.renamePath(edit.node.path, next);
        bump();
        if (!edit.node.isDirectory) onOpenFile(next);
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
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
          break;
        }
        case 'download':
          if (node && !node.isDirectory) {
            await window.ide.downloadFile(node.path);
          }
          break;
        case 'git-history':
          if (node) onViewFileHistory?.(node.path);
          break;
        case 'git-discard':
          if (node) {
            onDiscardPath?.(node.path);
            bump();
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
        case 'rename':
          if (node) setInlineEdit({ mode: 'rename', node });
          break;
        case 'delete':
          if (node) {
            const ok = window.confirm(`永久删除「${node.name}」？此操作不可撤销。`);
            if (!ok) return;
            await window.ide.removePath(node.path);
            bump();
          }
          break;
        default:
          break;
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  }

  if (!workspace) {
    return <div className="empty-state">打开一个工作区以浏览文件</div>;
  }

  const rootCreate =
    inlineEdit &&
    (inlineEdit.mode === 'create-file' || inlineEdit.mode === 'create-folder') &&
    inlineEdit.parentPath === '.';

  return (
    <div className="file-tree" onContextMenu={(e) => openMenu(e, { kind: 'blank' })}>
      {rootCreate && (
        <InlineNameInput
          initial=""
          placeholder={inlineEdit.mode === 'create-file' ? '文件名' : '文件夹名'}
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
          gitEntries={gitStatus?.entries ?? []}
          refreshKey={refreshKey}
          expandPath={expandPath}
          inlineEdit={inlineEdit}
          onOpenFile={onOpenFile}
          onSelectNode={onSelectNode}
          onContextNode={(e, n) => openMenu(e, { kind: 'node', node: n })}
          onInlineDone={(edit, name) => void handleInlineDone(edit, name)}
          onInlineCancel={() => setInlineEdit(null)}
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
    </div>
  );
});
