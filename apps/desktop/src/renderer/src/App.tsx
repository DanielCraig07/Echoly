import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type {
  AgentEvent,
  AppSettings,
  ChatSession,
  ChatSessionMessage,
  GitCommitEntry,
  GitStatusResult,
  LayoutSettings,
  OpenTab,
  PendingDiff,
  PermissionMode,
  RecentWorkspaceItem,
  UiTheme,
  WorkspaceInfo,
  ModelProfile,
  DapBreakpoint,
} from '@deepseek-ide/shared';
import { DEFAULT_LAYOUT, DEFAULT_SETTINGS, DEFAULT_MODELS } from '@deepseek-ide/shared';
import { FileTree, type FileTreeHandle } from './components/FileTree';
import { EditorPane } from './components/EditorPane';
import { ChatPanel, type ChatPanelHandle } from './components/ChatPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { ComposerModal } from './components/ComposerModal';
import { DebugPanel } from './components/DebugPanel';
import { SettingsModal } from './components/SettingsModal';
import { OpenWorkspaceModal } from './components/OpenWorkspaceModal';
import { NewProjectWizardModal } from './components/NewProjectWizardModal';
import { CloneRepoModal } from './components/CloneRepoModal';
import { SshConnectModal } from './components/SshConnectModal';
import {
  SwitchWorkspaceModal,
  type SwitchWorkspaceTarget,
} from './components/SwitchWorkspaceModal';
import { BranchSwitchModal } from './components/BranchSwitchModal';
import { FileHistoryModal } from './components/FileHistoryModal';
import {
  TopSearchBar,
  type TopSearchBarHandle,
  type CommandAction,
} from './components/TopSearchBar';
import { RunWidget } from './components/RunWidget';
import { ExtensionModal } from './components/ExtensionPanel';
import { ClaudeChatPanel } from './components/ClaudeChatPanel';
import { GitPanel } from './components/GitPanel';
import { SearchPanel } from './components/SearchPanel';
import { MavenPanel } from './components/MavenPanel';
import { ProblemsPanel } from './components/ProblemsPanel';
import { StatusBar } from './components/StatusBar';
import { GlobalTooltip } from './components/GlobalTooltip';
import { PROJECT_TEMPLATES } from './utils/projectTemplates';
import {
  isImagePath,
  isUntitledPath,
  languageFromPath,
  uid,
  buildSessionWorkspaceMeta,
} from './utils';
import {
  clearWorkspaceOpenFiles,
  loadWorkspaceOpenFiles,
  saveWorkspaceOpenFiles,
} from './workspaceSession';
import { setupSymbolNavigation } from './services/symbolNavigation';

type ResizeAxis = 'explorer' | 'chat' | 'bottom';
type LeftPanel = 'explorer' | 'search' | 'git' | 'maven';

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

const MIN_EDITOR_WIDTH = 280;

/** localStorage key for recent workspaces. */
const RECENT_WORKSPACES_KEY = 'echoly_recent_workspaces';

function readRecentWorkspaces(): RecentWorkspaceItem[] {
  try {
    const raw = localStorage.getItem(RECENT_WORKSPACES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeRecentWorkspaces(items: RecentWorkspaceItem[]): void {
  try {
    localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(items));
  } catch {
    // quota / private mode — ignore
  }
}

/**
 * Side panel widths are stored as absolute pixel preferences (set by dragging the
 * splitters), but the window itself can be resized freely. Without reconciling the
 * two, shrinking the window left the panels at their stored width while the editor
 * column shrank/overflowed — i.e. the panels looked "out of sync" with the window.
 * This derives the widths actually applied to the CSS vars: proportionally scale the
 * two side panels down (never below their usable minimum) so they always fit the
 * current window alongside a usable editor area, without touching — and therefore
 * without losing — the stored preference once the window grows back.
 */
function computeEffectiveLayoutWidths(
  layout: LayoutSettings,
  containerWidth: number,
): { explorerWidth: number; chatWidth: number } {
  const leftShown = layout.leftPanelExpanded !== false;
  const chatShown = layout.chatPanelExpanded !== false;
  const explorerWidth = leftShown ? layout.explorerWidth : 0;
  const chatWidth = chatShown ? layout.chatWidth : 0;
  const total = explorerWidth + chatWidth;

  if (!containerWidth || total <= containerWidth - MIN_EDITOR_WIDTH) {
    return { explorerWidth: layout.explorerWidth, chatWidth: layout.chatWidth };
  }

  const available = Math.max(0, containerWidth - MIN_EDITOR_WIDTH);
  const scale = total > 0 ? available / total : 1;
  return {
    explorerWidth: leftShown
      ? Math.max(140, Math.floor(layout.explorerWidth * scale))
      : layout.explorerWidth,
    chatWidth: chatShown ? Math.max(200, Math.floor(layout.chatWidth * scale)) : layout.chatWidth,
  };
}

/**
 * Windows opened via File > New Window are flagged with `?blank=1` so they
 * start with no workspace, instead of silently inheriting whatever project
 * the main-process WorkspaceService (shared across all windows) currently
 * has open.
 */
const isBlankNewWindow = (() => {
  try {
    return new URLSearchParams(window.location.search).get('blank') === '1';
  } catch {
    return false;
  }
})();

/** Optional workspace path for a new window (`?workspace=`). */
const workspaceFromQuery = (() => {
  try {
    return new URLSearchParams(window.location.search).get('workspace');
  } catch {
    return null;
  }
})();

const isMac =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);

function normalizeWorkspacePath(p: string | null | undefined): string {
  if (!p) return '';
  let clean = p.trim().replace(/[/\\]+$/, '');
  clean = clean.replace(/\\/g, '/');
  return clean;
}

export function App() {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo>({
    kind: 'local',
    root: null,
    label: '未打开工作区',
  });
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // undefined 表示正常打开（由 SettingsModal 自行恢复 localStorage 中的上次 tab），
  // 只有外部需要强制跳转时才赋具体值。
  const [settingsInitialTab, setSettingsInitialTab] = useState<
    'models' | 'runtime' | 'environment' | 'general' | 'skills' | 'update' | 'about' | undefined
  >(undefined);
  const [openWorkspaceOpen, setOpenWorkspaceOpen] = useState(false);
  const [newProjectWizardOpen, setNewProjectWizardOpen] = useState(false);
  const [switchTarget, setSwitchTarget] = useState<SwitchWorkspaceTarget | null>(null);
  const switchTargetRef = useRef<SwitchWorkspaceTarget | null>(null);
  switchTargetRef.current = switchTarget;
  const [branchModalOpen, setBranchModalOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [sshOpen, setSshOpen] = useState(false);
  const [extensionPanelOpen, setExtensionPanelOpen] = useState(false);
  const [claudePanelOpen, setClaudePanelOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [currentExtensionId, setCurrentExtensionId] = useState<string | null>(null);
  const [rightPanelTab, setRightPanelTab] = useState<'chat' | 'claude'>('chat'); // 右侧面板标签
  const [diffs, setDiffs] = useState<PendingDiff[]>([]);
  const [activeDiffId, setActiveDiffId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatSessionMessage[]>([]);
  const [sessionId, setSessionId] = useState(() => uid());
  const [terminalKey, setTerminalKey] = useState(0);
  const [selectedNode, setSelectedNode] = useState<{ path: string; isDirectory: boolean } | null>(
    null,
  );
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    DEFAULT_SETTINGS.permissionMode,
  );
  const [contextWindowTokens, setContextWindowTokens] = useState(
    DEFAULT_SETTINGS.contextWindowTokens,
  );
  const [editorSelection, setEditorSelection] = useState('');
  const [uiTheme, setUiTheme] = useState<UiTheme>(DEFAULT_SETTINGS.theme);
  const [autoSave, setAutoSave] = useState(DEFAULT_SETTINGS.autoSave);
  const [gitBlameInline, setGitBlameInline] = useState(DEFAULT_SETTINGS.gitBlameInline ?? true);
  const [hoverDelay, setHoverDelay] = useState(DEFAULT_SETTINGS.hoverDelay ?? 500);
  const [minimap, setMinimap] = useState(DEFAULT_SETTINGS.minimap !== false);
  const [selectionAiFloat, setSelectionAiFloat] = useState(
    DEFAULT_SETTINGS.selectionAiFloat !== false,
  );
  const [terminalScrollback, setTerminalScrollback] = useState<number>(
    DEFAULT_SETTINGS.terminalScrollback ?? 10000,
  );
  const [models, setModels] = useState<ModelProfile[]>(DEFAULT_MODELS);
  const [activeModelId, setActiveModelId] = useState<string>('deepseek-local');
  const [layout, setLayout] = useState<LayoutSettings>({ ...DEFAULT_LAYOUT });
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [isMavenProject, setIsMavenProject] = useState(false);
  const autoSaveRef = useRef(autoSave);
  autoSaveRef.current = autoSave;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const skipOpenFilesPersistRef = useRef(false);
  const openFilesPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Paths currently being discarded: within suppression window, Monaco's onChange
  // will NOT trigger auto-save or mark dirty, preventing discarded files from being saved back.
  const suppressAutoSaveUntilRef = useRef<Map<string, number>>(new Map());
  const shellRef = useRef<HTMLDivElement>(null);
  const [shellWidth, setShellWidth] = useState<number>(0);
  const middleColRef = useRef<HTMLDivElement>(null);
  const saveLayoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatRef = useRef<ChatPanelHandle>(null);
  const pendingAddToChatRef = useRef<string | null>(null);
  const [terminalOpenRequest, setTerminalOpenRequest] = useState<{
    cwd: string;
    nonce: number;
    initialCommand?: string;
    terminalType?: string;
    terminalTitle?: string;
  } | null>(null);
  const terminalNonce = useRef(0);
  const [leftPanel, setLeftPanel] = useState<LeftPanel>('explorer');
  const [scmDiff, setScmDiff] = useState<PendingDiff | null>(null);
  // 严格绑定文件路径的一次性行号跳转目标，跳转完毕立即消费清空，彻底杜绝跨文件行号粘连
  const [revealTarget, setRevealTarget] = useState<{
    path: string;
    line: number;
    column?: number;
    endLine?: number;
    nonce: number;
  } | null>(null);
  const revealNonceRef = useRef(0);
  const cursorLineRef = useRef(1);
  const cursorColRef = useRef(1);
  const searchRef = useRef<TopSearchBarHandle>(null);
  const fileTreeRef = useRef<FileTreeHandle>(null);

  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null);
  const [workspaceExpanded, setWorkspaceExpanded] = useState(true);
  const [outlineExpanded, setOutlineExpanded] = useState(false);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [timelineFile, setTimelineFile] = useState<string | null>(null);
  const [timelineCommits, setTimelineCommits] = useState<GitCommitEntry[]>([]);
  const [fileHistoryModalPath, setFileHistoryModalPath] = useState<string | null>(null);
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [isTreeCollapsed, setIsTreeCollapsed] = useState(false);

  const projectDisplayName = useMemo(() => {
    const raw = workspaceInfo.label || workspaceInfo.root || '';
    if (!raw || raw === '未打开工作区') return 'PROJECT-IDE';
    const clean = raw.replace(/^ssh\s+[^\s:]+:/, '');
    const segments = clean.split(/[/\\]/).filter(Boolean);
    const name = segments.pop() || clean;
    return name.toUpperCase();
  }, [workspaceInfo.label, workspaceInfo.root]);

  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(1);
  const [activeLanguage, setActiveLanguage] = useState('plaintext');
  const [wordWrap, setWordWrap] = useState(false);
  const [toasts, setToasts] = useState<
    Array<{
      id: string;
      title: string;
      detail?: string;
      type: 'success' | 'error' | 'info' | 'warn';
    }>
  >([]);
  const [toastDetailModal, setToastDetailModal] = useState<{
    id: string;
    title: string;
    detail?: string;
    type: 'success' | 'error' | 'info' | 'warn';
  } | null>(null);
  const [copiedToastId, setCopiedToastId] = useState<string | null>(null);
  const [modalCopied, setModalCopied] = useState(false);

  const showToast = useCallback(
    (title: string, detail?: string, type: 'success' | 'error' | 'info' | 'warn' = 'success') => {
      const id = Math.random().toString(36).slice(2);
      setToasts((prev) => [...prev, { id, title, detail, type }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4000);
    },
    [],
  );

  // 判断某个路径是否处于“放弃修改抑制期”（防止 Monaco onChange 触发 auto-save 误将已放弃的内容又写回磁盘）
  const isPathSuppressed = useCallback((path: string): boolean => {
    if (!path) return false;
    const norm = path.replace(/\\/g, '/').replace(/^\/+/, '');
    const now = Date.now();
    for (const [suppressedPath, until] of suppressAutoSaveUntilRef.current.entries()) {
      if (now >= until) continue;
      const normSuppressed = suppressedPath.replace(/\\/g, '/').replace(/^\/+/, '');
      if (
        norm === normSuppressed ||
        norm.endsWith('/' + normSuppressed) ||
        normSuppressed.endsWith('/' + norm)
      ) {
        return true;
      }
    }
    return false;
  }, []);

  const handleDiscardPath = async (pathOrPaths: string | string[]) => {
    const isAll =
      !pathOrPaths ||
      pathOrPaths === '.' ||
      pathOrPaths === 'ALL' ||
      pathOrPaths === 'all' ||
      (Array.isArray(pathOrPaths) &&
        pathOrPaths.some((p) => !p || p === '.' || p === 'ALL' || p === 'all'));

    const pathsToDiscard = (Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths]).filter(
      Boolean,
    );

    // 1. 立即锁定抑制窗口（3000ms），阻止任何 Monaco onChange 重绘误触发写盘
    const suppressUntilTime = Date.now() + 3000;
    if (isAll) {
      for (const t of tabsRef.current) {
        suppressAutoSaveUntilRef.current.set(t.path, suppressUntilTime);
      }
    } else {
      for (const dp of pathsToDiscard) {
        suppressAutoSaveUntilRef.current.set(dp, suppressUntilTime);
        const cleanDp = dp.replace(/\\/g, '/').replace(/^\/+/, '');
        suppressAutoSaveUntilRef.current.set(cleanDp, suppressUntilTime);
      }
    }

    // 2. 清除所有待保存定时器
    if (isAll) {
      for (const timer of autoSaveTimers.current.values()) clearTimeout(timer);
      autoSaveTimers.current.clear();
    } else {
      for (const dp of pathsToDiscard) {
        const normDp = dp.replace(/\\/g, '/').replace(/^\/+/, '');
        for (const [k, timer] of autoSaveTimers.current.entries()) {
          const normK = k.replace(/\\/g, '/').replace(/^\/+/, '');
          if (normK === normDp || normK.endsWith('/' + normDp) || normDp.endsWith('/' + normK)) {
            clearTimeout(timer);
            autoSaveTimers.current.delete(k);
          }
        }
      }
    }

    // 3. 立即从本地 gitStatus.entries 中过滤移除目标文件，实现毫秒级消除 M 标识
    setGitStatus((prev) => {
      if (!prev || !prev.entries?.length) return prev;
      if (isAll) return { ...prev, entries: [] };
      const cleanTargets = pathsToDiscard.map((p) => p.replace(/\\/g, '/').replace(/^\/+/, ''));
      const remaining = prev.entries.filter((e) => {
        const ep = e.path.replace(/\\/g, '/').replace(/^\/+/, '');
        return !cleanTargets.some(
          (tp) => ep === tp || ep.endsWith('/' + tp) || tp.endsWith('/' + ep),
        );
      });
      return { ...prev, entries: remaining };
    });

    // 4. 调用后端 git 服务还原文件
    const discardRes = await window.ide.gitDiscard(pathsToDiscard);
    if (discardRes && !discardRes.ok) {
      showToast('放弃修改失败', discardRes.detail || 'Git 还原失败', 'error');
      const curStatus = await window.ide.gitStatus();
      if (curStatus.ok) setGitStatus(curStatus);
      return;
    }

    // 5. 重新读取磁盘真实内容更新 affectedTabs
    const affectedTabs = tabsRef.current.filter((tab) => {
      if (isAll) return true;
      const normTp = tab.path.replace(/\\/g, '/').replace(/^\/+/, '');
      return pathsToDiscard.some((dp) => {
        const normDp = dp.replace(/\\/g, '/').replace(/^\/+/, '');
        return normTp === normDp || normTp.endsWith('/' + normDp) || normDp.endsWith('/' + normTp);
      });
    });

    for (const tab of affectedTabs) {
      const prevTimer = autoSaveTimers.current.get(tab.path);
      if (prevTimer) {
        clearTimeout(prevTimer);
        autoSaveTimers.current.delete(tab.path);
      }
      suppressAutoSaveUntilRef.current.set(tab.path, Date.now() + 3000);
      if (tab.language === 'image' || tab.previewUrl || isImagePath(tab.path)) {
        try {
          const previewUrl = await window.ide.readFileDataUrl(tab.path);
          setTabs((prev) =>
            prev.map((t) => (t.path === tab.path ? { ...t, dirty: false, previewUrl } : t)),
          );
        } catch {
          setTabs((prev) => prev.filter((t) => t.path !== tab.path));
        }
      } else {
        try {
          const freshContent = await window.ide.readFile(tab.path);
          setTabs((prev) =>
            prev.map((t) =>
              t.path === tab.path ? { ...t, content: freshContent, dirty: false } : t,
            ),
          );
        } catch {
          setTabs((prev) => prev.filter((t) => t.path !== tab.path));
        }
      }
    }

    // 6. 等待 Monaco 重绘事件沉淀后刷新状态
    await new Promise((r) => setTimeout(r, 200));

    const res = await window.ide.gitStatus();
    if (res.ok) {
      setGitStatus(res);
    }
    setTreeRefreshKey((k) => k + 1);
    setScmDiff(null);
    showToast('✓ 已放弃修改', '已恢复至 Git 最新提交版本', 'success');

    // 二次确认刷新：消除延迟残留
    setTimeout(async () => {
      const secondRes = await window.ide.gitStatus();
      if (secondRes.ok) setGitStatus(secondRes);
      setTreeRefreshKey((k) => k + 1);
    }, 600);
  };

  const handlePreviewGitDiff = async (path: string) => {
    const diff = await window.ide.gitDiff(path);
    if (diff.ok) {
      setScmDiff({
        id: diff.path,
        path: diff.path,
        original: diff.original,
        modified: diff.modified,
        description: 'Git 本地更改(工作树)',
      });
    }
  };

  const lastBranchRef = useRef<string | null>(null);

  const reloadTabsOnBranchChange = useCallback(async () => {
    // 分支切换后，重新从磁盘载入未被用户手动标记修改（非 dirty）的打开标签页
    const currentTabs = tabsRef.current;
    if (!currentTabs.length) return;

    for (const tab of currentTabs) {
      if (tab.dirty) continue;

      if (tab.language === 'image' || tab.previewUrl || isImagePath(tab.path)) {
        try {
          const previewUrl = await window.ide.readFileDataUrl(tab.path);
          setTabs((prev) =>
            prev.map((t) => (t.path === tab.path ? { ...t, dirty: false, previewUrl } : t)),
          );
        } catch {
          // 该文件在切后的分支若不存在，可保留或忽略
        }
      } else {
        try {
          const freshContent = await window.ide.readFile(tab.path);
          setTabs((prev) =>
            prev.map((t) =>
              t.path === tab.path ? { ...t, content: freshContent, dirty: false } : t,
            ),
          );
        } catch {
          // 该文件在新分支可能已被删除或重命名
        }
      }
    }
  }, []);

  const handleBranchSwitchSync = useCallback(async () => {
    await reloadTabsOnBranchChange();
    const st = await window.ide.gitStatus();
    if (st.ok) {
      setGitStatus(st);
      if (st.branch) {
        lastBranchRef.current = st.branch;
      }
    }
    setTreeRefreshKey((k) => k + 1);
  }, [reloadTabsOnBranchChange]);

  useEffect(() => {
    if (!workspace) return;
    let isMounted = true;
    const fetchGit = async () => {
      try {
        const res = await window.ide.gitStatus();
        if (!isMounted) return;
        if (res.ok) {
          const prevBranch = lastBranchRef.current;
          setGitStatus(res);
          if (res.branch) {
            lastBranchRef.current = res.branch;
            if (prevBranch && res.branch !== prevBranch) {
              // 检测到分支变动（如在终端执行 git checkout），联动重载标签页与树
              void handleBranchSwitchSync();
            }
          }
        } else {
          // 遇到临时网络异常/超时，保留上一次有效的 Git 状态，避免突变为“非 Git 项目”
          setGitStatus((prev) => (prev?.isRepo ? prev : res));
        }
      } catch {
        // 网络/IPC 异常时静默容灾保持
      }
    };
    void fetchGit();
    const timer = setInterval(() => void fetchGit(), 5000);
    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, [workspace, handleBranchSwitchSync]);

  useEffect(() => {
    return window.ide.onGitBranchSwitched?.(() => {
      void handleBranchSwitchSync();
    });
  }, [handleBranchSwitchSync]);

  const handleViewFileHistory = useCallback((filePath: string) => {
    setFileHistoryModalPath(filePath);
  }, []);

  useEffect(() => {
    if (activePath) {
      setActiveLanguage(languageFromPath(activePath));
      setSelectedNode({ path: activePath, isDirectory: false });
    } else {
      setActiveLanguage('plaintext');
    }
  }, [activePath]);

  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspaceItem[]>(() => {
    return readRecentWorkspaces();
  });

  const [sshTargetForModal, setSshTargetForModal] = useState<{
    server?: string;
    remotePath?: string;
  } | null>(null);

  useEffect(() => {
    if (workspaceInfo.root) {
      const path = workspaceInfo.root;
      const name = path.split('/').filter(Boolean).pop() || path;
      let sshServer = '';
      if (workspaceInfo.kind === 'ssh' && workspaceInfo.label) {
        const match = workspaceInfo.label.match(/^ssh\s+([^:/]+)/);
        sshServer = match ? match[1] : workspaceInfo.label;
      }
      setRecentWorkspaces((prev) => {
        const filtered = prev.filter((item) => item.path !== path);
        const newItem: RecentWorkspaceItem = {
          path,
          name,
          kind: workspaceInfo.kind,
          sshServer: sshServer || undefined,
          lastOpenedAt: Date.now(),
        };
        const updated = [newItem, ...filtered].slice(0, 20);
        writeRecentWorkspaces(updated);
        return updated;
      });
    }
  }, [workspaceInfo]);

  const persistOpenFilesForRoot = useCallback((root: string | null | undefined) => {
    if (!root) return;
    saveWorkspaceOpenFiles(
      root,
      tabsRef.current.map((t) => t.path).filter((p) => !isUntitledPath(p)),
      activePathRef.current && !isUntitledPath(activePathRef.current)
        ? activePathRef.current
        : null,
    );
  }, []);

  const restoreOpenFilesForRoot = useCallback(async (root: string | null) => {
    skipOpenFilesPersistRef.current = true;
    try {
      if (!root) {
        setTabs([]);
        setActivePath(null);
        return;
      }
      const saved = loadWorkspaceOpenFiles(root);
      if (!saved?.paths.length) {
        setTabs([]);
        setActivePath(null);
        return;
      }

      const restored: OpenTab[] = [];
      for (const p of saved.paths) {
        try {
          const exists = await window.ide.pathExists(p);
          if (!exists) continue;
          if (isImagePath(p)) {
            try {
              const previewUrl = await window.ide.readFileDataUrl(p);
              restored.push({
                path: p,
                content: '',
                language: 'image',
                dirty: false,
                previewUrl,
              });
            } catch {
              // skip unreadable images
            }
          } else {
            const content = await window.ide.readFile(p);
            restored.push({
              path: p,
              content,
              language: languageFromPath(p),
              dirty: false,
            });
          }
        } catch {
          // file deleted / inaccessible — skip
        }
      }

      setTabs(restored);
      const nextActive =
        saved.activePath && restored.some((t) => t.path === saved.activePath)
          ? saved.activePath
          : restored.length > 0
            ? restored[restored.length - 1].path
            : null;
      setActivePath(nextActive);
    } finally {
      // Defer so the restored tabs don't immediately overwrite storage with empty.
      window.setTimeout(() => {
        skipOpenFilesPersistRef.current = false;
      }, 0);
    }
  }, []);

  const switchWorkspaceInCurrentWindow = useCallback(
    async (path: string) => {
      try {
        persistOpenFilesForRoot(workspaceRef.current);
        if (workspaceInfo.kind === 'ssh') {
          await window.ide.sshDisconnect();
        }
        await window.ide.setWorkspace(path);
        const info = await window.ide.getWorkspaceInfo();
        setWorkspaceInfo(info);
        setWorkspace(info.root);

        setDiffs([]);
        setScmDiff(null);
        setActiveDiffId(null);
        setMessages([]);
        setSessionId(uid());
        setLayout((prev) => ({ ...prev, bottomPanelExpanded: false }));
        setTerminalKey((k) => k + 1);
        await restoreOpenFilesForRoot(info.root);
      } catch (err) {
        console.error(err);
      }
    },
    [workspaceInfo.kind, persistOpenFilesForRoot, restoreOpenFilesForRoot],
  );

  const openTargetInCurrentWindow = useCallback(
    async (target: SwitchWorkspaceTarget) => {
      if (!target.path) return;
      const isSsh =
        target.kind === 'ssh' ||
        !!target.sshServer ||
        target.path.startsWith('ssh ') ||
        target.path.startsWith('ssh:') ||
        target.path.startsWith('ssh://') ||
        /^[^@\s]+@[^:\s]+:/.test(target.path);

      if (isSsh) {
        let userHost = '';
        let hostOnly = '';
        const m =
          target.path.match(/^ssh\s+([^@\s]+@)?([^:/\s]+)/i) ||
          target.path.match(/^ssh:\/\/([^@/\s]+@)?([^:/\s]+)/i) ||
          target.path.match(/^([^@/\s]+@)?([^:/\s]+):/);
        if (m) {
          hostOnly = m[2] || '';
          userHost = (m[1] || '') + hostOnly;
        }

        const remotePathMatch = target.path.match(/:(.+)$/);
        const remotePath =
          remotePathMatch?.[1]?.trim() || (target.kind === 'ssh' ? target.path : undefined);

        // 1. 若当前窗口已有活动 SSH 会话，检查是否为同一服务器，如果是则直接秒级复用会话切换远程目录
        const activeSsh = await window.ide.sshGetActiveSession?.().catch(() => null);
        const targetServer = target.sshServer || userHost || hostOnly || '';
        const targetHost = target.rawItem?.host || hostOnly;
        const targetUser = target.rawItem?.username || (userHost.includes('@') ? userHost.split('@')[0] : '');

        if (activeSsh) {
          const isSameHost =
            (targetHost && targetHost === activeSsh.host) ||
            (!targetHost && targetServer && (targetServer.includes(activeSsh.host) || activeSsh.host.includes(targetServer)));
          const isSameUser = !targetUser || targetUser === activeSsh.username;

          if (isSameHost && isSameUser) {
            const nextRemote = remotePath || target.path;
            const res = await window.ide.sshSwitchRemotePath(nextRemote);
            if (res.ok) {
              const info = await window.ide.getWorkspaceInfo();
              persistOpenFilesForRoot(workspaceRef.current);
              setWorkspaceInfo(info);
              setWorkspace(info.root);
              setDiffs([]);
              setScmDiff(null);
              setTerminalKey((k) => k + 1);
              setTreeRefreshKey((k) => k + 1);
              await restoreOpenFilesForRoot(info.root);
              showToast('✓ 已切换远程工作区', `${info.root}`, 'success');
              return;
            } else {
              showToast('✕ 切换远程工作区失败', res.detail, 'error');
            }
          }
        }

        const profiles = await window.ide.listSshProfiles().catch(() => []);
        const matchedProfile = profiles.find((p: any) => {
          if (target.sshServer && (p.name === target.sshServer || p.host === target.sshServer))
            return true;
          if (remotePath && p.remotePath === remotePath) return true;
          if (hostOnly && p.host === hostOnly) return true;
          if (userHost && `${p.username}@${p.host}` === userHost.replace(/^@/, '')) return true;
          if (userHost && p.name === userHost) return true;
          return false;
        });

        // 优先使用当前用户输入的最新凭据（尤其是密码），并与匹配的 profile 合并补全
        const hostToConnect = target.rawItem?.host || matchedProfile?.host || hostOnly;
        const userToConnect =
          target.rawItem?.username ||
          matchedProfile?.username ||
          (userHost.includes('@') ? userHost.split('@')[0] : '');
        const portToConnect = Number(target.rawItem?.port || matchedProfile?.port || 22) || 22;
        const passwordToConnect = target.rawItem?.password;
        const keyToConnect = target.rawItem?.privateKeyPath || matchedProfile?.privateKeyPath;
        const passphraseToConnect = target.rawItem?.passphrase;
        const pathToConnect =
          remotePath || target.rawItem?.remotePath || matchedProfile?.remotePath || target.path;

        if (hostToConnect && userToConnect) {
          const res = await window.ide.sshConnect({
            host: hostToConnect,
            port: portToConnect,
            username: userToConnect,
            password: passwordToConnect,
            privateKeyPath: keyToConnect,
            passphrase: passphraseToConnect,
            remotePath: pathToConnect,
            saveProfile: target.rawItem?.saveProfile,
            profileName: target.rawItem?.profileName || matchedProfile?.name,
            browseOnly: false,
          });
          if (res.ok) {
            const info = await window.ide.getWorkspaceInfo();
            persistOpenFilesForRoot(workspaceRef.current);
            setWorkspaceInfo(info);
            setWorkspace(info.root);
            setDiffs([]);
            setScmDiff(null);
            setTerminalKey((k) => k + 1);
            setTreeRefreshKey((k) => k + 1);
            await restoreOpenFilesForRoot(info.root);
            showToast('✓ 已连接远程工作区', `${info.root}`, 'success');
            return;
          } else {
            showToast('✕ 连接远程工作区失败', res.detail, 'error');
          }
        }

        setSshTargetForModal({
          server: target.sshServer || userHost || hostOnly || undefined,
          remotePath: remotePath || target.path,
        });
        setSshOpen(true);
      } else {
        await switchWorkspaceInCurrentWindow(target.path);
      }
    },
    [persistOpenFilesForRoot, restoreOpenFilesForRoot, switchWorkspaceInCurrentWindow, showToast],
  );

  const openTargetInNewWindow = useCallback((target: SwitchWorkspaceTarget) => {
    const isSsh = target.kind === 'ssh' || !!target.sshServer;
    if (isSsh) {
      const sshUri = target.sshServer ? `${target.sshServer}:${target.path}` : target.path;
      void window.ide.openNewWindow(sshUri, target.rawItem);
    } else {
      void window.ide.openNewWindow(target.path);
    }
  }, []);

  const requestWorkspaceOpen = useCallback(
    async (target: SwitchWorkspaceTarget) => {
      const isSsh = target.kind === 'ssh' || !!target.sshServer;
      const normCurrent = normalizeWorkspacePath(workspace);
      const normTarget = normalizeWorkspacePath(target.path);
      const isSamePath =
        isMac || navigator.userAgent.includes('Windows')
          ? normCurrent.toLowerCase() === normTarget.toLowerCase()
          : normCurrent === normTarget;
      const isSame =
        Boolean(normCurrent && normTarget && isSamePath) &&
        workspaceInfo.kind === (isSsh ? 'ssh' : 'local');
      if (isSame) return;

      // 如果当前已有打开的工作区，且不是同一个，则弹出提示询问当前窗口还是新窗口打开
      // 在用户做出选择之前，当前窗口的一切状态（包括文件、终端、会话）绝对保持原样不动
      if (workspace) {
        setSwitchTarget(target);
        return;
      }

      // 否则直接在当前窗口打开
      await openTargetInCurrentWindow(target);
    },
    [workspace, workspaceInfo.kind, openTargetInCurrentWindow],
  );

  const requestWorkspaceSwitch = useCallback(
    (path: string) => {
      void requestWorkspaceOpen({
        path,
        name:
          path
            .split(/[/\\\\]/)
            .filter(Boolean)
            .pop() || path,
        kind: 'local',
      });
    },
    [requestWorkspaceOpen],
  );

  const handleSwitchWorkspacePath = useCallback(
    async (targetPath: string) => {
      if (!targetPath || targetPath === workspace) return;
      const isSsh =
        targetPath.startsWith('ssh ') ||
        targetPath.startsWith('ssh:') ||
        targetPath.startsWith('ssh://') ||
        /^[^@\s]+@[^:\s]+:/.test(targetPath);
      void requestWorkspaceOpen({
        path: targetPath,
        name:
          targetPath
            .split(/[/\\\\]/)
            .filter(Boolean)
            .pop() || targetPath,
        kind: isSsh ? 'ssh' : 'local',
      });
    },
    [workspace, requestWorkspaceOpen],
  );

  const handleSelectRecentWorkspace = useCallback(
    async (item: RecentWorkspaceItem) => {
      const isSsh = item.kind === 'ssh' || !!item.sshServer || item.path.startsWith('ssh ');
      void requestWorkspaceOpen({
        path: item.path,
        name:
          item.name ||
          item.path
            .split(/[/\\\\]/)
            .filter(Boolean)
            .pop() ||
          item.path,
        kind: isSsh ? 'ssh' : 'local',
        sshServer: item.sshServer,
        rawItem: item,
      });
    },
    [requestWorkspaceOpen],
  );

  const handleRemoveRecentWorkspace = useCallback((path: string) => {
    setRecentWorkspaces((prev) => {
      const updated = prev.filter((item) => item.path !== path);
      writeRecentWorkspaces(updated);
      return updated;
    });
    clearWorkspaceOpenFiles(path);
  }, []);

  const handleClearRecentWorkspaces = useCallback(() => {
    setRecentWorkspaces([]);
    try {
      localStorage.removeItem(RECENT_WORKSPACES_KEY);
    } catch {}
  }, []);

  const applySettings = useCallback((s: AppSettings) => {
    setPermissionMode(s.permissionMode);
    setContextWindowTokens(s.contextWindowTokens);
    setLayout({ ...DEFAULT_LAYOUT, ...s.layout });
    setUiTheme(s.theme ?? 'dark');
    setAutoSave(s.autoSave === true);
    setGitBlameInline(s.gitBlameInline !== false);
    setHoverDelay(Math.max(500, s.hoverDelay ?? 500));
    setMinimap(s.minimap !== false);
    setSelectionAiFloat(s.selectionAiFloat !== false);
    setTerminalScrollback(s.terminalScrollback ?? 10000);
    if (s.models && Array.isArray(s.models) && s.models.length > 0) {
      setModels(s.models);
    }
    if (s.activeModelId) {
      setActiveModelId(s.activeModelId);
    }
  }, []);

  const handleActiveModelChange = useCallback(async (modelId: string) => {
    setActiveModelId(modelId);
    try {
      const s = await window.ide.getSettings();
      await window.ide.saveSettings({ ...s, activeModelId: modelId });
    } catch (err) {
      console.error('Failed to save activeModelId:', err);
    }
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', uiTheme);
  }, [uiTheme]);

  useEffect(() => {
    void window.ide.getSettings().then(applySettings);
    if (isBlankNewWindow) {
      if (workspaceFromQuery) {
        const isSsh =
          workspaceFromQuery.startsWith('ssh ') ||
          workspaceFromQuery.startsWith('ssh:') ||
          workspaceFromQuery.startsWith('ssh://') ||
          /^[^@\s]+@[^:\s]+:/.test(workspaceFromQuery);
        const sshAuthToken = new URLSearchParams(window.location.search).get('sshAuthToken');
        if (sshAuthToken) {
          void window.ide.getSshAuthHandoff(sshAuthToken).then((auth) => {
            void openTargetInCurrentWindow({
              path: auth?.remotePath || workspaceFromQuery,
              name:
                workspaceFromQuery
                  .split(/[/\\\\]/)
                  .filter(Boolean)
                  .pop() || workspaceFromQuery,
              kind: 'ssh',
              sshServer:
                auth?.profileName ||
                (auth?.username && auth?.host ? `${auth.username}@${auth.host}` : undefined),
              rawItem: auth,
            });
          });
        } else {
          void openTargetInCurrentWindow({
            path: workspaceFromQuery,
            name:
              workspaceFromQuery
                .split(/[/\\\\]/)
                .filter(Boolean)
                .pop() || workspaceFromQuery,
            kind: isSsh ? 'ssh' : 'local',
          });
        }
      }
    } else {
      void window.ide.getWorkspaceInfo().then((info) => {
        setWorkspaceInfo(info);
        setWorkspace(info.root);
        if (info.root) {
          void restoreOpenFilesForRoot(info.root);
        }
      });
    }
    return window.ide.onWorkspaceChanged((info) => {
      const prevRoot = workspaceRef.current;
      if (prevRoot && prevRoot !== info.root) {
        persistOpenFilesForRoot(prevRoot);
      }
      setWorkspaceInfo(info);
      setWorkspace(info.root);
      setDiffs([]);
      setScmDiff(null);
      setTerminalKey((k) => k + 1);
      // Collapse terminal panel — user opens it manually when needed
      setLayout((prev) => ({ ...prev, bottomPanelExpanded: false }));
      void restoreOpenFilesForRoot(info.root);
    });
  }, [applySettings, persistOpenFilesForRoot, restoreOpenFilesForRoot, openTargetInCurrentWindow]);

  // Remember open tabs for the current project (debounced).
  useEffect(() => {
    if (!workspace || skipOpenFilesPersistRef.current) return;
    if (openFilesPersistTimer.current) clearTimeout(openFilesPersistTimer.current);
    openFilesPersistTimer.current = setTimeout(() => {
      if (skipOpenFilesPersistRef.current) return;
      if (workspaceRef.current !== workspace) return;
      saveWorkspaceOpenFiles(
        workspace,
        tabs.map((t) => t.path).filter((p) => !isUntitledPath(p)),
        activePath && !isUntitledPath(activePath) ? activePath : null,
      );
    }, 250);
    return () => {
      if (openFilesPersistTimer.current) clearTimeout(openFilesPersistTimer.current);
    };
  }, [workspace, tabs, activePath]);

  // 动态检测当前工作区是否为 Maven 项目（存在 pom.xml），若非 Maven 则隐藏 Maven 图标
  useEffect(() => {
    if (!workspace) {
      setIsMavenProject(false);
      return;
    }
    let cancelled = false;
    void window.ide.pathExists('pom.xml').then((hasPom) => {
      if (!cancelled) {
        setIsMavenProject(Boolean(hasPom));
        if (!hasPom && leftPanel === 'maven') {
          setLeftPanel('explorer');
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workspace, leftPanel]);

  const persistLayout = useCallback((next: LayoutSettings) => {
    if (saveLayoutTimer.current) clearTimeout(saveLayoutTimer.current);
    saveLayoutTimer.current = setTimeout(() => {
      void window.ide.saveSettings({ layout: next });
    }, 300);
  }, []);

  // ── 调试断点工作区隔离与持久化 ──
  const getBreakpointsStorageKey = useCallback((ws?: string | null) => {
    if (!ws) return 'echoly.dap.breakpoints.global';
    return `echoly.dap.breakpoints.${ws}`;
  }, []);

  const isBreakpointBelongsToWorkspace = useCallback((bp: DapBreakpoint, ws?: string | null): boolean => {
    if (!ws) return true;
    const normWs = ws.replace(/\\/g, '/').replace(/\/+$/, '');
    const normPath = bp.path.replace(/\\/g, '/');
    if (!normPath.startsWith('/') && !/^[A-Za-z]:/.test(normPath)) {
      return true;
    }
    return normPath.startsWith(normWs + '/') || normPath === normWs;
  }, []);

  const loadWorkspaceBreakpoints = useCallback((ws?: string | null): DapBreakpoint[] => {
    try {
      const key = getBreakpointsStorageKey(ws);
      const raw = localStorage.getItem(key);
      if (raw) {
        const list: DapBreakpoint[] = JSON.parse(raw);
        return Array.isArray(list) ? list.filter((b) => isBreakpointBelongsToWorkspace(b, ws)) : [];
      }
    } catch {}
    return [];
  }, [getBreakpointsStorageKey, isBreakpointBelongsToWorkspace]);

  // ── C/C++ & 多语言调试会话与底部面板标签 ──
  const [bottomTab, setBottomTab] = useState<'terminal' | 'debug' | 'problems'>('terminal');
  const [problemsCount, setProblemsCount] = useState<number>(0);
  const lastShiftPressRef = useRef<number>(0);
  const [isDebugging, setIsDebugging] = useState(false);
  const [debugState, setDebugState] = useState<'running' | 'paused' | 'stopped'>('stopped');

  // ── 全局终端与 AI 对话切换器（保证任何焦点状态下均能无条件可靠开闭） ──
  const lastToggleTerminalTimeRef = useRef<number>(0);
  const toggleTerminal = useCallback(() => {
    const now = Date.now();
    if (now - lastToggleTerminalTimeRef.current < 120) return;
    lastToggleTerminalTimeRef.current = now;

    setLayout((prev) => {
      const nextExpanded = !prev.bottomPanelExpanded;
      const next = {
        ...prev,
        bottomPanelExpanded: nextExpanded,
      };
      persistLayout(next);
      return next;
    });
    setBottomTab('terminal');
  }, [persistLayout]);

  const lastToggleAiTimeRef = useRef<number>(0);
  const toggleAiChat = useCallback(() => {
    const now = Date.now();
    if (now - lastToggleAiTimeRef.current < 120) return;
    lastToggleAiTimeRef.current = now;

    setLayout((prev) => {
      const willExpand = prev.chatPanelExpanded === false;
      const next = {
        ...prev,
        chatPanelExpanded: willExpand,
      };
      persistLayout(next);
      if (willExpand) {
        setTimeout(() => chatRef.current?.focusInput?.(), 50);
      }
      return next;
    });
  }, [persistLayout]);

  const handleAddToChat = useCallback(
    (text: string) => {
      setLayout((prev) => {
        if (prev.chatPanelExpanded !== false) {
          return prev;
        }
        const next = { ...prev, chatPanelExpanded: true };
        persistLayout(next);
        return next;
      });
      setRightPanelTab('chat');

      if (chatRef.current) {
        chatRef.current.insertPath(text);
        setTimeout(() => chatRef.current?.focusInput?.(), 50);
        return;
      }

      pendingAddToChatRef.current = text;
      let retries = 0;
      const interval = setInterval(() => {
        retries++;
        if (chatRef.current) {
          clearInterval(interval);
          if (pendingAddToChatRef.current) {
            const pendingText = pendingAddToChatRef.current;
            pendingAddToChatRef.current = null;
            chatRef.current.insertPath(pendingText);
          }
          chatRef.current.focusInput?.();
        } else if (retries > 30) {
          clearInterval(interval);
        }
      }, 30);
    },
    [persistLayout],
  );

  const handleFocusAi = useCallback(() => {
    setLayout((prev) => {
      if (prev.chatPanelExpanded !== false) {
        return prev;
      }
      const next = { ...prev, chatPanelExpanded: true };
      persistLayout(next);
      return next;
    });
    setRightPanelTab('chat');
    if (chatRef.current) {
      setTimeout(() => chatRef.current?.focusInput?.(), 50);
    } else {
      let retries = 0;
      const interval = setInterval(() => {
        retries++;
        if (chatRef.current) {
          clearInterval(interval);
          chatRef.current.focusInput?.();
        } else if (retries > 30) {
          clearInterval(interval);
        }
      }, 30);
    }
  }, [persistLayout]);

  useEffect(() => {
    if (layout.chatPanelExpanded !== false && chatRef.current && pendingAddToChatRef.current) {
      const text = pendingAddToChatRef.current;
      pendingAddToChatRef.current = null;
      chatRef.current.insertPath(text);
      setTimeout(() => chatRef.current?.focusInput?.(), 50);
    }
  }, [layout.chatPanelExpanded]);

  useEffect(() => {
    const handleToggleTerminalEvent = () => toggleTerminal();
    const handleToggleAiEvent = () => toggleAiChat();
    const handleFocusAiEvent = () => handleFocusAi();
    window.addEventListener('echoly:toggleTerminal', handleToggleTerminalEvent);
    window.addEventListener('echoly:toggleAi', handleToggleAiEvent);
    window.addEventListener('echoly:focusAi', handleFocusAiEvent);
    return () => {
      window.removeEventListener('echoly:toggleTerminal', handleToggleTerminalEvent);
      window.removeEventListener('echoly:toggleAi', handleToggleAiEvent);
      window.removeEventListener('echoly:focusAi', handleFocusAiEvent);
    };
  }, [toggleTerminal, toggleAiChat, handleFocusAi]);
  const [breakpoints, setBreakpoints] = useState<DapBreakpoint[]>(() => {
    return loadWorkspaceBreakpoints(workspace);
  });

  // 当工作区切换时，自动按当前工作区重新载入隔离断点列表
  useEffect(() => {
    setBreakpoints(loadWorkspaceBreakpoints(workspace));
  }, [workspace, loadWorkspaceBreakpoints]);

  const handleToggleBreakpoint = useCallback((path: string, line: number, condition?: string) => {
    setBreakpoints((prev) => {
      const exists = prev.some((b) => b.path === path && b.line === line);
      const next = exists
        ? prev.filter((b) => !(b.path === path && b.line === line))
        : [...prev, { path, line, condition: condition?.trim() || undefined, verified: true }];
      try {
        const key = getBreakpointsStorageKey(workspace);
        localStorage.setItem(key, JSON.stringify(next));
      } catch {}
      const fileLines = next.filter((b) => b.path === path).map((b) => b.line);
      void window.ide?.dapSetBreakpoints?.(path, fileLines);
      return next;
    });
  }, [workspace, getBreakpointsStorageKey]);

  const handleClearBreakpoints = useCallback(() => {
    setBreakpoints([]);
    try {
      const key = getBreakpointsStorageKey(workspace);
      localStorage.setItem(key, '[]');
    } catch {}
  }, [workspace, getBreakpointsStorageKey]);

  // 监听调试事件以自动展开底部调试面板
  useEffect(() => {
    if (!window.ide?.onDapEvent) return;
    const unlisten = window.ide.onDapEvent((ev) => {
      if (ev.type === 'stopped') {
        setIsDebugging(true);
        setDebugState('paused');
        setBottomTab('debug');
        setLayout((prev) => {
          if (!prev.bottomPanelExpanded) {
            const next = { ...prev, bottomPanelExpanded: true };
            persistLayout(next);
            return next;
          }
          return prev;
        });
      } else if (ev.type === 'continued') {
        setDebugState('running');
      } else if (ev.type === 'terminated' || ev.type === 'exited') {
        setIsDebugging(false);
        setDebugState('stopped');
      }
    });

    const handleStartDebug = () => {
      setIsDebugging(true);
      setDebugState('running');
      setBottomTab('debug');
      setLayout((prev) => {
        if (!prev.bottomPanelExpanded) {
          const next = { ...prev, bottomPanelExpanded: true };
          persistLayout(next);
          return next;
        }
        return prev;
      });
    };

    const handleStopDebug = () => {
      setIsDebugging(false);
      setDebugState('stopped');
    };

    const handleDebugError = (e: Event) => {
      const custom = e as CustomEvent<{ language?: string; message?: string }>;
      handleStopDebug();
      if (custom.detail?.message) {
        showToast(
          custom.detail.language === 'python' ? '⚠️ Python 缺少 debugpy 模块' : '⚠️ 调试启动失败',
          custom.detail.message,
          'warn',
        );
      }
    };

    const handleOpenBottomTab = (e: Event) => {
      const custom = e as CustomEvent<{ tab?: 'terminal' | 'debug' }>;
      const target = custom.detail?.tab;
      if (target === 'terminal' || target === 'debug') {
        setBottomTab(target);
        setLayout((prev) => {
          if (!prev.bottomPanelExpanded) {
            const next = { ...prev, bottomPanelExpanded: true };
            persistLayout(next);
            return next;
          }
          return prev;
        });
      }
    };

    let fsDebounce: ReturnType<typeof setTimeout> | null = null;
    const triggerFsRefresh = () => {
      if (fsDebounce) clearTimeout(fsDebounce);
      fsDebounce = setTimeout(() => {
        setTreeRefreshKey((k) => k + 1);
        void (async () => {
          try {
            const res = await window.ide.gitStatus();
            setGitStatus(res);
          } catch {}
        })();
        // 同步清理已在文件系统中删除的文件标签页与状态，防止失效文件残留于编辑器与 @ 引用中
        void (async () => {
          const curTabs = tabsRef.current;
          if (!curTabs || curTabs.length === 0) return;
          const toClose: string[] = [];
          for (const t of curTabs) {
            if (isUntitledPath(t.path)) continue;
            try {
              const exists = await window.ide.pathExists(t.path);
              if (!exists) {
                toClose.push(t.path);
              }
            } catch {
              // 忽略校验异常
            }
          }
          if (toClose.length > 0) {
            const closeSet = new Set(toClose.map((p) => p.replace(/\\/g, '/').replace(/^\/+/, '')));
            setTabs((prev) => {
              const next = prev.filter((t) => !closeSet.has(t.path.replace(/\\/g, '/').replace(/^\/+/, '')));
              if (activePathRef.current && closeSet.has(activePathRef.current.replace(/\\/g, '/').replace(/^\/+/, ''))) {
                const nextActive = next[next.length - 1]?.path ?? null;
                setActivePath(nextActive);
                activePathRef.current = nextActive;
              }
              return next;
            });
            persistOpenFilesForRoot(workspaceRef.current);
          }
        })();
      }, 80);
    };

    const unlistenFs = window.ide?.onFsChanged?.(() => {
      triggerFsRefresh();
    });

    const handleCustomFsRefresh = (e?: Event) => {
      const detail = (e as CustomEvent<{ deletedPath?: string; isDirectory?: boolean }>)?.detail;
      if (detail?.deletedPath) {
        const delNorm = detail.deletedPath.replace(/\\/g, '/').replace(/^\/+/, '');
        setTabs((prev) => {
          const next = prev.filter((t) => {
            const tp = t.path.replace(/\\/g, '/').replace(/^\/+/, '');
            if (tp === delNorm) return false;
            if (detail.isDirectory && tp.startsWith(delNorm + '/')) return false;
            return true;
          });
          if (activePathRef.current) {
            const ap = activePathRef.current.replace(/\\/g, '/').replace(/^\/+/, '');
            if (ap === delNorm || (detail.isDirectory && ap.startsWith(delNorm + '/'))) {
              const nextActive = next[next.length - 1]?.path ?? null;
              setActivePath(nextActive);
              activePathRef.current = nextActive;
            }
          }
          return next;
        });
        persistOpenFilesForRoot(workspaceRef.current);
      }
      triggerFsRefresh();
    };

    const handleAskAi = (e: Event) => {
      const detail = (e as CustomEvent<{ prompt: string; autoSubmit?: boolean }>).detail;
      if (detail?.prompt) {
        setRightPanelTab('chat');
        setLayout((prev) => {
          const next = { ...prev, rightPanelExpanded: true };
          persistLayout(next);
          return next;
        });
        chatRef.current?.askQuestion(detail.prompt, detail.autoSubmit);
      }
    };

    window.addEventListener('echoly:refreshFileTree', handleCustomFsRefresh);
    window.addEventListener('echoly:refreshTree', handleCustomFsRefresh);
    window.addEventListener('echoly:openBottomTab', handleOpenBottomTab);
    window.addEventListener('echoly:startDebug', handleStartDebug);
    window.addEventListener('echoly:stopDebug', handleStopDebug);
    window.addEventListener('echoly:runFinished', handleStopDebug);
    window.addEventListener('echoly:debugError', handleDebugError);
    window.addEventListener('echoly:askAi', handleAskAi);

    const handleOpenFileEvent = (e: Event) => {
      const detail = (e as CustomEvent)?.detail;
      if (detail?.path) {
        void openFile(detail.path, detail.line, detail.column, detail.endLine);
      }
    };
    window.addEventListener('echoly:openFile', handleOpenFileEvent);

    // 编辑器「选中代码 → 添加到对话」(Cmd+L 或工具栏按钮触发)
    const handleAddRefToChat = (e: Event) => {
      const detail = (e as CustomEvent)?.detail as {
        path: string;
        startLine?: number;
        endLine?: number;
      } | undefined;
      if (!detail?.path) return;
      const ref =
        detail.startLine !== undefined
          ? `@${detail.path}:L${detail.startLine}${detail.endLine !== undefined && detail.endLine !== detail.startLine ? `-${detail.endLine}` : ''}`
          : `@${detail.path}`;
      handleAddToChat(ref);
    };
    window.addEventListener('echoly:addRefToChat', handleAddRefToChat);

    return () => {
      if (fsDebounce) clearTimeout(fsDebounce);
      unlisten();
      unlistenFs?.();
      window.removeEventListener('echoly:refreshFileTree', handleCustomFsRefresh);
      window.removeEventListener('echoly:refreshTree', handleCustomFsRefresh);
      window.removeEventListener('echoly:openBottomTab', handleOpenBottomTab);
      window.removeEventListener('echoly:startDebug', handleStartDebug);
      window.removeEventListener('echoly:stopDebug', handleStopDebug);
      window.removeEventListener('echoly:runFinished', handleStopDebug);
      window.removeEventListener('echoly:debugError', handleDebugError);
      window.removeEventListener('echoly:askAi', handleAskAi);
      window.removeEventListener('echoly:openFile', handleOpenFileEvent);
      window.removeEventListener('echoly:addRefToChat', handleAddRefToChat);
    };
  }, [persistLayout, showToast]);

  const startResize = useCallback(
    (axis: ResizeAxis, e: ReactMouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const start = { ...layoutRef.current };
      const shell = shellRef.current;
      const startShellWidth = shell?.clientWidth ?? window.innerWidth;

      const onMove = (ev: MouseEvent) => {
        const next = { ...start };
        if (axis === 'explorer') {
          next.explorerWidth = clamp(start.explorerWidth + (ev.clientX - startX), 140, 900);
        } else if (axis === 'chat') {
          next.chatWidth = clamp(start.chatWidth - (ev.clientX - startX), 260, 1400);
        } else if (axis === 'bottom') {
          const middleCol = middleColRef.current || shell;
          if (middleCol) {
            const rect = middleCol.getBoundingClientRect();
            const maxH = Math.max(120, Math.floor(rect.height * 0.65));
            next.bottomHeight = clamp(rect.bottom - ev.clientY, 120, maxH);
          }
        }
        // Keep editor usable
        if (next.explorerWidth + next.chatWidth > startShellWidth - MIN_EDITOR_WIDTH) {
          if (axis === 'explorer') {
            next.explorerWidth = Math.max(140, startShellWidth - MIN_EDITOR_WIDTH - next.chatWidth);
          } else if (axis === 'chat') {
            next.chatWidth = Math.max(260, startShellWidth - MIN_EDITOR_WIDTH - next.explorerWidth);
          }
        }
        setLayout(next);
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.classList.remove('resizing', 'resizing-row');
        persistLayout(layoutRef.current);
      };

      document.body.classList.add('resizing');
      if (axis === 'bottom') document.body.classList.add('resizing-row');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [persistLayout],
  );

  async function changePermissionMode(mode: PermissionMode): Promise<void> {
    setPermissionMode(mode);
    const next = await window.ide.saveSettings({ permissionMode: mode });
    applySettings(next);
  }

  async function changeTheme(theme: UiTheme): Promise<void> {
    setUiTheme(theme);
    document.documentElement.setAttribute('data-theme', theme);
    const next = await window.ide.saveSettings({ theme });
    applySettings(next);
  }

  const openFile = useCallback(async (rawPath: string, line?: number, col?: number, endLine?: number) => {
    setScmDiff(null);
    setActiveDiffId(null);
    const ws = workspaceRef.current;
    let path = rawPath.replace(/\\/g, '/');
    if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1);
    if (ws) {
      const normWs = ws.replace(/\\/g, '/').replace(/\/+$/, '');
      if (path.startsWith(normWs)) {
        path = path.slice(normWs.length).replace(/^\/+/, '');
      }
    }
    const normPath = path;
    const existingTab = tabsRef.current.find((t) => {
      const tp = t.path.replace(/\\/g, '/');
      return tp === normPath || tp.endsWith('/' + normPath) || normPath.endsWith('/' + tp);
    });
    if (existingTab) {
      setActivePath(existingTab.path);
      activePathRef.current = existingTab.path;
      if (line != null && line > 0) {
        revealNonceRef.current += 1;
        setRevealTarget({
          path: existingTab.path,
          line,
          column: col ?? 1,
          endLine,
          nonce: revealNonceRef.current,
        });
      } else {
        setRevealTarget(null);
      }
      return;
    }
    if (isImagePath(path)) {
      try {
        const previewUrl = await window.ide.readFileDataUrl(path);
        setTabs((prev) => {
          if (prev.some((t) => t.path === path)) return prev;
          return [
            ...prev,
            {
              path,
              content: '',
              language: 'image',
              dirty: false,
              previewUrl,
            },
          ];
        });
      } catch (err) {
        alert(`无法预览图片：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      setActivePath(path);
      return;
    }
    let content = '';
    try {
      content = await window.ide.readFile(path);
    } catch (err) {
      // If relative path didn't hit directly, search for file across workspace (e.g. Java package path)
      let resolved = false;
      if (window.ide.searchFiles) {
        const fileName = path.split('/').pop() || path;
        try {
          const hits = await window.ide.searchFiles(fileName, 5);
          const matched = hits.find(
            (h) => h.path === path || h.path.endsWith('/' + path) || h.path.endsWith(fileName),
          );
          if (matched) {
            content = await window.ide.readFile(matched.path);
            path = matched.path;
            resolved = true;
          }
        } catch {
          // ignore
        }
      }
      if (!resolved) {
        console.warn(
          '[navigation] cannot open file:',
          path,
          err instanceof Error ? err.message : err,
        );
        return;
      }
    }
    // 大文件：超过 2MB 时不整段塞进 Monaco，避免渲染卡顿；仅提示并留空，待 agent/其它流程按需处理
    const isLarge = content.length > 2 * 1024 * 1024;
    setTabs((prev) => {
      if (prev.some((t) => t.path === path)) return prev;
      return [
        ...prev,
        {
          path,
          content: isLarge ? '' : content,
          language: languageFromPath(path),
          dirty: false,
          isLargeFile: isLarge,
        },
      ];
    });
    setActivePath(path);
    activePathRef.current = path;
    if (line != null && line > 0) {
      revealNonceRef.current += 1;
      setRevealTarget({
        path,
        line,
        column: col ?? 1,
        endLine,
        nonce: revealNonceRef.current,
      });
    } else {
      setRevealTarget(null);
    }
  }, []);

  // Initialize dual-tier symbol navigation (F12 definition jump, Shift+F12 references, and cross-tab opener)
  useEffect(() => {
    const nav = setupSymbolNavigation({
      getWorkspaceRoot: () => workspaceRef.current,
      onOpenFile: (targetPath, line, col) => {
        void openFile(targetPath, line, col);
      },
      getCurrentPath: () => activePathRef.current,
      getCurrentPosition: () => ({
        line: cursorLineRef.current,
        column: cursorColRef.current,
      }),
    });
    return () => nav.dispose();
  }, [openFile]);

  async function pickWorkspace(): Promise<void> {
    const root = await window.ide.pickWorkspace();
    if (!root) return;
    requestWorkspaceSwitch(root);
  }

  const handleOpenCreatedProject = useCallback(
    async (targetPath: string, openInNewWindow: boolean, entryFile?: string) => {
      if (openInNewWindow) {
        void window.ide.openNewWindow(targetPath);
      } else {
        await requestWorkspaceSwitch(targetPath);
        if (entryFile) {
          setTimeout(() => {
            void openFile(entryFile);
          }, 350);
        }
      }
    },
    [requestWorkspaceSwitch, openFile],
  );

  async function createTemplateWorkspace(_templateId = 'cpp-cmake'): Promise<void> {
    setNewProjectWizardOpen(true);
  }

  async function disconnectSsh(): Promise<void> {
    persistOpenFilesForRoot(workspaceRef.current);
    await window.ide.sshDisconnect();
    setWorkspace(null);
    setWorkspaceInfo({ kind: 'local', root: null, label: '未打开工作区' });
    setTabs([]);
    setActivePath(null);
    setDiffs([]);
    setTerminalKey((k) => k + 1);
  }

  const saveUntitledAs = useCallback(async (tab: OpenTab): Promise<void> => {
    const defaultName = `${tab.path.slice('untitled:'.length)}.txt`;
    let defaultPath = defaultName;
    const ws = workspaceRef.current;
    if (ws) {
      try {
        const rootAbs = await window.ide.resolveAbsolutePath('.');
        defaultPath = `${rootAbs.replace(/[/\\]$/, '')}/${defaultName}`;
      } catch {
        // keep bare defaultName
      }
    }
    const dest = await window.ide.saveFileDialog(defaultPath);
    if (!dest) return;

    let relPath = dest.replace(/\\/g, '/');
    if (ws) {
      try {
        const rootAbs = (await window.ide.resolveAbsolutePath('.'))
          .replace(/\\/g, '/')
          .replace(/\/+$/, '');
        if (relPath === rootAbs || relPath.startsWith(`${rootAbs}/`)) {
          relPath = relPath === rootAbs ? defaultName : relPath.slice(rootAbs.length + 1);
        } else {
          alert('请将文件保存到当前工作区内');
          return;
        }
      } catch {
        alert('当前无法写入工作区，请先打开文件夹');
        return;
      }
    } else {
      alert('请先打开工作区后再保存未命名文件');
      return;
    }

    await window.ide.writeFile(relPath, tab.content);
    setTabs((prev) =>
      prev.map((t) =>
        t.path === tab.path
          ? { ...t, path: relPath, dirty: false, language: languageFromPath(relPath) }
          : t,
      ),
    );
    setActivePath(relPath);
    setTreeRefreshKey((k) => k + 1);
  }, []);

  const saveActive = useCallback(async (): Promise<void> => {
    const path = activePathRef.current;
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab || tab.language === 'image' || tab.previewUrl) return;
    if (isUntitledPath(tab.path)) {
      await saveUntitledAs(tab);
      return;
    }
    await window.ide.writeFile(tab.path, tab.content);
    setTabs((prev) => prev.map((t) => (t.path === tab.path ? { ...t, dirty: false } : t)));
    void window.ide.gitStatus().then((res) => {
      if (res.ok) {
        setGitStatus(res);
        setTreeRefreshKey((k) => k + 1);
      }
    });
    // 延迟二次同步，保证底层 stat 刷新后无改动时 M 标识立即消失
    setTimeout(async () => {
      const res = await window.ide.gitStatus();
      if (res.ok) {
        setGitStatus(res);
        setTreeRefreshKey((k) => k + 1);
      }
    }, 300);
  }, [saveUntitledAs]);

  const saveAsActive = useCallback(async (): Promise<void> => {
    const path = activePathRef.current;
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab || tab.language === 'image' || tab.previewUrl) return;
    if (isUntitledPath(tab.path)) {
      await saveUntitledAs(tab);
      return;
    }
    const defaultName = tab.path.split(/[/\\]/).pop() || 'file.txt';
    const ws = workspaceRef.current;
    let defaultPath = defaultName;
    if (ws) {
      try {
        const rootAbs = await window.ide.resolveAbsolutePath('.');
        defaultPath = `${rootAbs.replace(/[/\\]$/, '')}/${defaultName}`;
      } catch {
        // keep bare defaultName
      }
    }
    const dest = await window.ide.saveFileDialog(defaultPath);
    if (!dest) return;

    let relPath = dest.replace(/\\/g, '/');
    if (ws) {
      try {
        const rootAbs = (await window.ide.resolveAbsolutePath('.'))
          .replace(/\\/g, '/')
          .replace(/\/+$/, '');
        if (relPath === rootAbs || relPath.startsWith(`${rootAbs}/`)) {
          relPath = relPath === rootAbs ? defaultName : relPath.slice(rootAbs.length + 1);
        }
      } catch {
        // fallback
      }
    }
    await window.ide.writeFile(relPath, tab.content);
    setTabs((prev) => {
      const exists = prev.some((t) => t.path === relPath);
      if (exists) {
        return prev.map((t) =>
          t.path === relPath ? { ...t, content: tab.content, dirty: false } : t,
        );
      }
      return [
        ...prev,
        { path: relPath, content: tab.content, dirty: false, language: languageFromPath(relPath) },
      ];
    });
    setActivePath(relPath);
    setTreeRefreshKey((k) => k + 1);
  }, [saveUntitledAs]);

  const saveAll = useCallback(async (): Promise<void> => {
    const currentTabs = tabsRef.current;
    const dirtyTabs = currentTabs.filter((t) => t.dirty && t.language !== 'image' && !t.previewUrl);
    for (const tab of dirtyTabs) {
      if (isUntitledPath(tab.path)) {
        await saveUntitledAs(tab);
      } else {
        await window.ide.writeFile(tab.path, tab.content);
      }
    }
    setTabs((prev) => prev.map((t) => (t.dirty ? { ...t, dirty: false } : t)));
    void window.ide.gitStatus().then((res) => {
      if (res.ok) {
        setGitStatus(res);
        setTreeRefreshKey((k) => k + 1);
      }
    });
  }, [saveUntitledAs]);

  const revertActiveFile = useCallback(async (): Promise<void> => {
    const path = activePathRef.current;
    if (!path || isUntitledPath(path)) return;
    try {
      const diskContent = await window.ide.readFile(path);
      setTabs((prev) =>
        prev.map((t) => (t.path === path ? { ...t, content: diskContent, dirty: false } : t)),
      );
    } catch {
      // ignore
    }
  }, []);

  const closeCurrentWorkspace = useCallback(async (): Promise<void> => {
    if (workspaceRef.current) {
      persistOpenFilesForRoot(workspaceRef.current);
    }
    if (workspaceInfo.kind === 'ssh') {
      await window.ide.sshDisconnect();
    }
    await window.ide.setWorkspace('');
    setWorkspace(null);
    setWorkspaceInfo({ kind: 'local', root: null, label: '未打开工作区' });
    setTabs([]);
    setActivePath(null);
    setDiffs([]);
    setTerminalKey((k) => k + 1);
  }, [workspaceInfo.kind, persistOpenFilesForRoot]);

  const createUntitledTab = useCallback(() => {
    setTabs((prev) => {
      let n = 1;
      while (prev.some((t) => t.path === `untitled:Untitled-${n}`)) n += 1;
      const nextPath = `untitled:Untitled-${n}`;
      setActivePath(nextPath);
      setScmDiff(null);
      setActiveDiffId(null);
      return [...prev, { path: nextPath, content: '', language: 'plaintext', dirty: true }];
    });
  }, []);

  const savePath = useCallback(async (path: string, content: string): Promise<void> => {
    if (isUntitledPath(path)) return;
    await window.ide.writeFile(path, content);
    setTabs((prev) =>
      prev.map((t) => (t.path === path && t.content === content ? { ...t, dirty: false } : t)),
    );
    void window.ide.gitStatus().then((res) => {
      if (res.ok) {
        setGitStatus(res);
        setTreeRefreshKey((k) => k + 1);
      }
    });
    // 延迟二次同步，保证底层 stat 刷新后无改动时 M 标识立即消失
    setTimeout(async () => {
      const res = await window.ide.gitStatus();
      if (res.ok) {
        setGitStatus(res);
        setTreeRefreshKey((k) => k + 1);
      }
    }, 300);
  }, []);

  function onChangeContent(path: string, content: string, markDirty = true): void {
    // 处于抑制期的路径（刚执行过放弃修改），严格拦截 Monaco 重绘产生的 onChange，保证 dirty=false 且绝不写盘
    if (isPathSuppressed(path)) {
      setTabs((prev) => {
        const normP = path.replace(/\\/g, '/').replace(/^\/+/, '');
        return prev.map((t) => {
          const tp = t.path.replace(/\\/g, '/').replace(/^\/+/, '');
          if (tp === normP || tp.endsWith('/' + normP) || normP.endsWith('/' + tp)) {
            return { ...t, content, dirty: false };
          }
          return t;
        });
      });
      for (const [k, timer] of autoSaveTimers.current.entries()) {
        const normK = k.replace(/\\/g, '/').replace(/^\/+/, '');
        const normP = path.replace(/\\/g, '/').replace(/^\/+/, '');
        if (normK === normP || normK.endsWith('/' + normP) || normP.endsWith('/' + normK)) {
          clearTimeout(timer);
          autoSaveTimers.current.delete(k);
        }
      }
      return;
    }

    const normTarget = path.replace(/\\/g, '/').replace(/^\/+/, '');
    const currentTab = tabsRef.current.find((t) => {
      const tp = t.path.replace(/\\/g, '/').replace(/^\/+/, '');
      return tp === normTarget || tp.endsWith('/' + normTarget) || normTarget.endsWith('/' + tp);
    });

    // 如果内容未曾改变且未标记为 dirty，直接忽略，避免空写盘
    if (currentTab && currentTab.content === content && !currentTab.dirty && !markDirty) {
      return;
    }

    setTabs((prev) => {
      return prev.map((t) => {
        const tp = t.path.replace(/\\/g, '/').replace(/^\/+/, '');
        if (tp === normTarget || tp.endsWith('/' + normTarget) || normTarget.endsWith('/' + tp)) {
          return { ...t, content, dirty: markDirty };
        }
        return t;
      });
    });

    if (!markDirty) {
      for (const [k, timer] of autoSaveTimers.current.entries()) {
        const normK = k.replace(/\\/g, '/').replace(/^\/+/, '');
        if (
          normK === normTarget ||
          normK.endsWith('/' + normTarget) ||
          normTarget.endsWith('/' + normK)
        ) {
          clearTimeout(timer);
          autoSaveTimers.current.delete(k);
        }
      }
      return;
    }

    if (isUntitledPath(path) || !autoSaveRef.current) return;

    for (const [k, timer] of autoSaveTimers.current.entries()) {
      const normK = k.replace(/\\/g, '/').replace(/^\/+/, '');
      if (
        normK === normTarget ||
        normK.endsWith('/' + normTarget) ||
        normTarget.endsWith('/' + normK)
      ) {
        clearTimeout(timer);
        autoSaveTimers.current.delete(k);
      }
    }

    autoSaveTimers.current.set(
      path,
      setTimeout(() => {
        autoSaveTimers.current.delete(path);
        if (!isPathSuppressed(path)) {
          void savePath(path, content);
        }
      }, 800),
    );
  }

  useEffect(() => {
    return () => {
      for (const timer of autoSaveTimers.current.values()) clearTimeout(timer);
      autoSaveTimers.current.clear();
    };
  }, []);

  useEffect(() => {
    return window.ide.onMenuCommand((command) => {
      if (command.type === 'autoSave') {
        setAutoSave(command.enabled);
        return;
      }
      if (command.type === 'toggleWordWrap') {
        setWordWrap(command.enabled);
        return;
      }
      if (command.type === 'openWorkspaceModal') {
        if (switchTargetRef.current) return;
        setOpenWorkspaceOpen((prev) => !prev);
        return;
      }
      if (command.type === 'newFile') {
        createUntitledTab();
        return;
      }
      if (command.type === 'closeEditor') {
        const path = activePathRef.current;
        if (!path) return;
        setTabs((prev) => {
          const next = prev.filter((t) => t.path !== path);
          const nextActive = next[next.length - 1]?.path ?? null;
          setActivePath(nextActive);
          return next;
        });
        return;
      }
      if (command.type === 'openWorkspace') {
        const path = command.path;
        window.ide
          .listDir(path)
          .then((res) => {
            if (Array.isArray(res)) {
              requestWorkspaceSwitch(path);
            } else {
              void openFile(path);
            }
          })
          .catch(() => {
            void openFile(path);
          });
        return;
      }
      if (command.type === 'save') {
        void saveActive();
        return;
      }
      if (command.type === 'saveAs') {
        void saveAsActive();
        return;
      }
      if (command.type === 'saveAll') {
        void saveAll();
        return;
      }
      if (command.type === 'revertFile') {
        void revertActiveFile();
        return;
      }
      if (command.type === 'closeWorkspace') {
        void closeCurrentWorkspace();
        return;
      }
    });
  }, [
    openFile,
    requestWorkspaceSwitch,
    createUntitledTab,
    saveActive,
    saveAsActive,
    saveAll,
    revertActiveFile,
    closeCurrentWorkspace,
  ]);

  function onPendingDiff(event: Extract<AgentEvent, { type: 'pending_diff' }>): void {
    setDiffs((prev) => {
      const others = prev.filter((d) => d.path !== event.diff.path);
      return [...others, event.diff];
    });
  }

  async function acceptDiff(id: string): Promise<void> {
    await window.ide.acceptDiff(id);
    const diff = diffs.find((d) => d.id === id);
    setDiffs((prev) => prev.filter((d) => d.id !== id));
    if (activeDiffId === id) setActiveDiffId(null);
    if (diff) {
      setTabs((prev) =>
        prev.map((t) =>
          t.path === diff.path ? { ...t, content: diff.modified, dirty: false } : t,
        ),
      );
      setTreeRefreshKey((k) => k + 1);
      window.dispatchEvent(new CustomEvent('echoly:refreshFileTree'));
    }
  }

  async function rejectDiff(id: string): Promise<void> {
    await window.ide.rejectDiff(id);
    setDiffs((prev) => prev.filter((d) => d.id !== id));
    if (activeDiffId === id) setActiveDiffId(null);
  }

  async function acceptAll(): Promise<void> {
    await window.ide.acceptAllDiffs();
    for (const diff of diffs) {
      setTabs((prev) =>
        prev.map((t) =>
          t.path === diff.path ? { ...t, content: diff.modified, dirty: false } : t,
        ),
      );
    }
    setDiffs([]);
    setActiveDiffId(null);
    setTreeRefreshKey((k) => k + 1);
    window.dispatchEvent(new CustomEvent('echoly:refreshFileTree'));
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;

      // Double Shift -> 类似 IntelliJ 全局搜索 (Search Everywhere)
      if (e.key === 'Shift') {
        const now = Date.now();
        if (now - lastShiftPressRef.current < 350 && now - lastShiftPressRef.current > 40) {
          lastShiftPressRef.current = 0;
          searchRef.current?.focus('actions');
          return;
        }
        lastShiftPressRef.current = now;
      } else {
        lastShiftPressRef.current = 0;
      }

      // ── 全局核心快捷键（无论光标在编辑区、终端、输入框、树视图或任何位置均全局生效） ──
      // 1. 终端面板展开/折叠: Cmd+J / Ctrl+J, Alt+F12, Ctrl+`
      if (
        (ctrl && !e.shiftKey && (e.key.toLowerCase() === 'j' || e.code === 'KeyJ')) ||
        (e.altKey && e.key === 'F12') ||
        (ctrl && (e.key === '`' || e.key === '~') && !e.shiftKey)
      ) {
        e.preventDefault();
        e.stopPropagation();
        toggleTerminal();
        return;
      }

      // 2. AI 窗口展开/折叠: Cmd+B / Ctrl+B
      if (
        ctrl &&
        !e.shiftKey &&
        (e.key.toLowerCase() === 'b' || e.code === 'KeyB')
      ) {
        e.preventDefault();
        e.stopPropagation();
        toggleAiChat();
        return;
      }

      // 3. AI 提问 / 添加到对话: Cmd+L / Ctrl+L (聚焦或添加选区到 AI 对话，绝不收起)
      if (
        ctrl &&
        !e.shiftKey &&
        (e.key.toLowerCase() === 'l' || e.code === 'KeyL')
      ) {
        const target = e.target as HTMLElement | null;
        const activeEl = document.activeElement as HTMLElement | null;
        const isInsideEditor = Boolean(
          (target && (target.closest('.editor-area') || target.closest('.monaco-editor') || target.closest('.inline-ai-widget'))) ||
          (activeEl && (activeEl.closest('.editor-area') || activeEl.closest('.monaco-editor') || activeEl.closest('.inline-ai-widget')))
        );
        // 若焦点在编辑器内，放行给 Monaco Action 与 EditorPane 处理选区引用添加
        if (isInsideEditor) {
          return;
        }
        // 若在编辑器外部（如侧边栏、终端或欢迎页），统一打开并聚焦 AI 助手
        e.preventDefault();
        e.stopPropagation();
        handleFocusAi();
        return;
      }

      // 3. 全局搜索与文件快速打开
      if (ctrl && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        searchRef.current?.focus('actions');
        return;
      }
      if (ctrl && e.key.toLowerCase() === 'p' && !e.shiftKey) {
        e.preventDefault();
        searchRef.current?.focus('files');
        return;
      }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus('code');
        return;
      }
      if (ctrl && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveActive();
        return;
      }
      const isMonacoFocused = (() => {
        const el = document.activeElement as HTMLElement | null;
        return !!(el && typeof el.closest === 'function' && el.closest('.monaco-editor'));
      })();
      const isTerminalFocused = (() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return false;
        return el.classList?.contains('xterm-helper-textarea') || !!el.closest?.('.xterm');
      })();
      const skipDueToInput = (() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return false;
        if (isMonacoFocused || isTerminalFocused) return false;
        const tag = el.tagName?.toLowerCase();
        return tag === 'input' || tag === 'textarea' || el.isContentEditable;
      })();
      const shortcutMap: Record<string, string> = {
        n: 'cmd-new-chat',
        i: 'cmd-open-composer',
        o: 'cmd-switch-workspace',
        ',': 'cmd-open-settings',
        r: 'cmd-reload-window',
      };
      if (ctrl && !e.shiftKey && shortcutMap[e.key.toLowerCase()]) {
        if (skipDueToInput) return;
        const action = ideActions.find((a) => a.id === shortcutMap[e.key.toLowerCase()]);
        if (action) {
          e.preventDefault();
          action.handler();
          return;
        }
      }
      // Cmd+Shift+G -> Git 面板（映射到 cmd-git-status）；Cmd+Shift+` -> 新终端
      if (ctrl && e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        ideActions.find((a) => a.id === 'cmd-git-status')?.handler();
        return;
      }
      if (ctrl && e.shiftKey && (e.key === '`' || e.key === '~')) {
        e.preventDefault();
        ideActions.find((a) => a.id === 'cmd-new-terminal')?.handler();
        return;
      }
      // Cmd+Shift+B / Cmd+Shift+E -> 展开/折叠左侧边栏
      if (ctrl && e.shiftKey && (e.key.toLowerCase() === 'b' || e.key.toLowerCase() === 'e')) {
        e.preventDefault();
        ideActions.find((a) => a.id === 'cmd-toggle-sidebar')?.handler();
        return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [activePath]);

  useEffect(() => {
    if (!extensionPanelOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setExtensionPanelOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [extensionPanelOpen]);

  // Keep side-panel widths in sync with the app window's actual size (see
  // computeEffectiveLayoutWidths) instead of only reacting to splitter drags.
  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const update = () => setShellWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const agentPreviewDiff = diffs.find((d) => d.id === activeDiffId) ?? null;
  const previewDiff = agentPreviewDiff ?? scmDiff;
  const terminalKind = workspaceInfo.kind === 'ssh' ? 'ssh' : 'local';
  const remoteHost =
    workspaceInfo.kind === 'ssh' && workspaceInfo.label
      ? (workspaceInfo.label.match(/^ssh\s+[^@\s]+@([^:\s/]+)/i)?.[1] ?? null)
      : null;

  const isWelcomeShell = !workspace;
  const showLeftPanel = !isWelcomeShell && layout.leftPanelExpanded !== false;
  const showChatPanel = !isWelcomeShell && layout.chatPanelExpanded !== false;
  const effectiveWidths = isWelcomeShell
    ? { explorerWidth: 0, chatWidth: 0 }
    : computeEffectiveLayoutWidths(layout, shellWidth);
  const shellStyle = {
    ['--explorer-width' as string]: `${effectiveWidths.explorerWidth}px`,
    ['--chat-width' as string]: `${effectiveWidths.chatWidth}px`,
    ['--bottom-height' as string]: `${isWelcomeShell ? 0 : layout.bottomHeight}px`,
  } as CSSProperties;

  const ideActions: CommandAction[] = [
    {
      id: 'cmd-open-composer',
      title: 'Composer: 多文件智能重构协同编辑 (⌘I)',
      category: 'AI',
      shortcut: isMac ? '⌘I' : 'Ctrl+I',
      handler: () => {
        setComposerOpen(true);
      },
    },
    {
      id: 'cmd-new-chat',
      title: 'AI: 新建对话会话',
      category: 'AI',
      shortcut: 'Cmd+N',
      handler: () => {
        chatRef.current?.clearAndNewSession();
        if (layoutRef.current.chatPanelExpanded === false) {
          const next = { ...layoutRef.current, chatPanelExpanded: true };
          setLayout(next);
          persistLayout(next);
        }
      },
    },
    {
      id: 'cmd-toggle-sidebar',
      title: '视图: 展开/折叠左侧边栏',
      category: '视图',
      shortcut: isMac ? '⌘⇧B' : 'Ctrl+Shift+B',
      handler: () => {
        const next = {
          ...layoutRef.current,
          leftPanelExpanded: layoutRef.current.leftPanelExpanded === false,
        };
        setLayout(next);
        persistLayout(next);
      },
    },
    {
      id: 'cmd-toggle-ai',
      title: '视图: 展开/折叠 AI 助手',
      category: '视图',
      shortcut: 'Cmd+B',
      handler: toggleAiChat,
    },
    {
      id: 'cmd-focus-ai',
      title: 'AI: 提问 / 聚焦 AI 助手',
      category: 'AI',
      shortcut: 'Cmd+L',
      handler: handleFocusAi,
    },
    {
      id: 'cmd-toggle-terminal',
      title: '终端: 展开/折叠底部控制台',
      category: '终端',
      shortcut: 'Cmd+J / Alt+F12',
      handler: toggleTerminal,
    },
    {
      id: 'cmd-new-terminal',
      title: '终端: 新建终端标签页',
      category: '终端',
      shortcut: 'Cmd+Shift+`',
      handler: () => {
        terminalNonce.current += 1;
        setTerminalOpenRequest({ cwd: workspaceRef.current || '', nonce: terminalNonce.current });
        const next = { ...layoutRef.current, bottomPanelExpanded: true };
        setLayout(next);
        persistLayout(next);
      },
    },
    {
      id: 'cmd-git-status',
      title: 'Git: 查看源代码版本控制',
      category: 'Git',
      shortcut: 'Cmd+Shift+G',
      handler: () => {
        setLeftPanel('git');
        const next = { ...layoutRef.current, leftPanelExpanded: true };
        setLayout(next);
        persistLayout(next);
      },
    },
    {
      id: 'cmd-git-branch',
      title: 'Git: 切换分支 / Tag 标签',
      category: 'Git',
      shortcut: '',
      handler: () => {
        setBranchModalOpen(true);
      },
    },
    {
      id: 'cmd-git-pull',
      title: 'Git: 拉取远端更新 (Pull)',
      category: 'Git',
      shortcut: '',
      handler: async () => {
        const res = await window.ide.gitPull();
        if (res.ok) {
          const st = await window.ide.gitStatus();
          setGitStatus(st);
        }
      },
    },
    {
      id: 'cmd-git-discard',
      title: 'Git: 放弃工作区所有更改 (Discard All)',
      category: 'Git',
      shortcut: '',
      handler: () => void handleDiscardPath('all'),
    },
    {
      id: 'cmd-git-history',
      title: 'Git: 查看当前文件提交历史',
      category: 'Git',
      shortcut: '',
      handler: () => {
        if (activePath) {
          handleViewFileHistory(activePath);
        } else {
          showToast('无法查看文件历史', '请先在编辑器中打开一个文件', 'info');
        }
      },
    },
    {
      id: 'cmd-git-log',
      title: 'Git: 查看提交历史与图谱 (Commit Graph)',
      category: 'Git',
      shortcut: '',
      handler: () => {
        setLeftPanel('git');
        const next = { ...layoutRef.current, leftPanelExpanded: true };
        setLayout(next);
        persistLayout(next);
      },
    },
    {
      id: 'cmd-open-settings',
      title: '首选项: 打开 IDE 设置与多模型管理',
      category: '设置',
      shortcut: 'Cmd+,',
      handler: () => setSettingsOpen(true),
    },
    {
      id: 'cmd-switch-workspace',
      title: '工作区: 打开或切换工作区目录',
      category: '工作区',
      shortcut: 'Cmd+O',
      handler: () => {
        if (switchTargetRef.current) return;
        setOpenWorkspaceOpen((prev) => !prev);
      },
    },
    {
      id: 'cmd-ssh-connect',
      title: '工作区: 连接远程 SSH 主机',
      category: '远程',
      shortcut: '',
      handler: () => setSshOpen(true),
    },
    {
      id: 'cmd-clone-repo',
      title: 'Git: 从远程 URL 克隆仓库 (Clone)',
      category: 'Git',
      shortcut: '',
      handler: () => setCloneOpen(true),
    },
    {
      id: 'cmd-reload-window',
      title: '窗口: 重载窗口 (Reload Window)',
      category: '窗口',
      shortcut: 'Cmd+R',
      handler: () => {
        persistOpenFilesForRoot(workspaceRef.current);
        window.location.reload();
      },
    },
  ];

  return (
    <div
      className={`app-shell${isWelcomeShell ? ' welcome-shell' : ''}`}
      ref={shellRef}
      style={shellStyle}
    >
      <header className="titlebar">
        <div className="titlebar-left" style={{ width: 70, WebkitAppRegion: 'drag' } as any}></div>
        <div className="titlebar-center" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {remoteHost && (
            <span className="titlebar-remote-badge" title={`远程服务器 ${remoteHost}`}>
              SSH {remoteHost}
            </span>
          )}
          <span className="titlebar-title-text">
            {workspaceInfo.label && workspaceInfo.label !== '未打开工作区'
              ? `${workspaceInfo.label.split('/').pop()} — `
              : ''}
            {activePath ? activePath.split('/').pop() : 'Echoly'}
          </span>
        </div>
        <div className="titlebar-actions" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* IDEA 风格运行配置工具条（移至右侧） */}
          <RunWidget
            workspace={workspace}
            activePath={activePath}
            isBottomExpanded={layout.bottomPanelExpanded === true}
            onExpandBottom={(targetTab) => {
              const next = { ...layout, bottomPanelExpanded: true };
              setLayout(next);
              persistLayout(next);
              if (targetTab) {
                setBottomTab(targetTab);
              }
            }}
            onSelectBottomTab={(tab) => {
              setBottomTab(tab);
              if (!layout.bottomPanelExpanded) {
                const next = { ...layout, bottomPanelExpanded: true };
                setLayout(next);
                persistLayout(next);
              }
            }}
            onRunCommand={(cmd, cwd, terminalType, terminalTitle) => {
              terminalNonce.current += 1;
              setTerminalOpenRequest({
                cwd: cwd || workspace || '',
                nonce: terminalNonce.current,
                initialCommand: cmd,
                terminalType,
                terminalTitle,
              });
            }}
            onShowToast={showToast}
          />

          {/* 全局命令与文件搜索触发栏 */}
          <button
            type="button"
            className="top-search-trigger"
            onClick={() => searchRef.current?.focus('actions')}
            title={isMac ? '搜索动作或文件 (⌘P / ⌘⇧P)' : '搜索动作或文件 (Ctrl+P / Ctrl+Shift+P)'}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span className="search-trigger-text">命令 / 搜索</span>
            <kbd className="search-trigger-kbd">{isMac ? '⌘P' : 'Ctrl+P'}</kbd>
          </button>

          {/* 3个区域折叠/展开切换按钮 */}
          <div className="layout-toggle-group">
            <button
              type="button"
              className={`layout-toggle-btn ${showLeftPanel ? 'active' : ''}`}
              title={
                showLeftPanel
                  ? `折叠左侧边栏 (${isMac ? '⌘⇧B' : 'Ctrl+Shift+B'})`
                  : `展开左侧边栏 (${isMac ? '⌘⇧B' : 'Ctrl+Shift+B'})`
              }
              disabled={isWelcomeShell}
              onClick={() => {
                const next = { ...layout, leftPanelExpanded: layout.leftPanelExpanded === false };
                setLayout(next);
                persistLayout(next);
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect
                  x="1.5"
                  y="1.5"
                  width="13"
                  height="13"
                  rx="2.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <line
                  x1="5.5"
                  y1="1.5"
                  x2="5.5"
                  y2="14.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <rect
                  x="1.5"
                  y="1.5"
                  width="4"
                  height="13"
                  fill="currentColor"
                  opacity={showLeftPanel ? 0.65 : 0.25}
                  rx="1.5"
                />
              </svg>
            </button>
            <button
              type="button"
              className={`layout-toggle-btn ${!isWelcomeShell && layout.bottomPanelExpanded === true ? 'active' : ''}`}
              title={
                layout.bottomPanelExpanded === true
                  ? `折叠底部终端 (${isMac ? '⌘J' : 'Ctrl+J'})`
                  : `展开底部终端 (${isMac ? '⌘J' : 'Ctrl+J'})`
              }
              disabled={isWelcomeShell}
              onClick={() => {
                const next = {
                  ...layout,
                  bottomPanelExpanded: layout.bottomPanelExpanded !== true,
                };
                setLayout(next);
                persistLayout(next);
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect
                  x="1.5"
                  y="1.5"
                  width="13"
                  height="13"
                  rx="2.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <line
                  x1="1.5"
                  y1="10.5"
                  x2="14.5"
                  y2="10.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <rect
                  x="1.5"
                  y="10.5"
                  width="13"
                  height="4"
                  fill="currentColor"
                  opacity={!isWelcomeShell && layout.bottomPanelExpanded === true ? 0.65 : 0.25}
                  rx="1.5"
                />
              </svg>
            </button>
            <button
              type="button"
              className={`layout-toggle-btn ${showChatPanel ? 'active' : ''}`}
              title={
                showChatPanel
                  ? `折叠右侧 AI 面板 (${isMac ? '⌘B' : 'Ctrl+B'})`
                  : `展开右侧 AI 面板 (${isMac ? '⌘B' : 'Ctrl+B'})`
              }
              disabled={isWelcomeShell}
              onClick={() => {
                const next = { ...layout, chatPanelExpanded: layout.chatPanelExpanded === false };
                setLayout(next);
                persistLayout(next);
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect
                  x="1.5"
                  y="1.5"
                  width="13"
                  height="13"
                  rx="2.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <line
                  x1="10.5"
                  y1="1.5"
                  x2="10.5"
                  y2="14.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <rect
                  x="10.5"
                  y="1.5"
                  width="4"
                  height="13"
                  fill="currentColor"
                  opacity={showChatPanel ? 0.65 : 0.25}
                  rx="1.5"
                />
              </svg>
            </button>
          </div>

          {/* 设置按钮 */}
          <button
            type="button"
            className="layout-toggle-btn settings-btn"
            title={isMac ? '设置 (⌘,)' : '设置 (Ctrl+,)'}
            onClick={() => setSettingsOpen(true)}
          >
            <svg
              width="19"
              height="19"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v6m0 6v6M5.64 5.64l4.24 4.24m4.24 4.24l4.24 4.24M1 12h6m6 0h6M5.64 18.36l4.24-4.24m4.24-4.24l4.24-4.24" />
            </svg>
          </button>

          <TopSearchBar
            ref={searchRef}
            enabled={!!workspace}
            actions={ideActions}
            onOpenFile={(path, line) => void openFile(path, line)}
          />
        </div>
      </header>

      <div className="main-grid">
        {/* 左侧面板 */}
        {showLeftPanel && (
          <>
            <aside className="panel left-side-panel">
              <div
                className="idea-sidebar-tabs"
                style={{
                  justifyContent: 'center',
                  gap: 14,
                  height: 38,
                  boxSizing: 'border-box',
                  padding: '5px 12px 5px',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <button
                  type="button"
                  className={leftPanel === 'explorer' ? 'active' : ''}
                  onClick={() => setLeftPanel('explorer')}
                  title="文件"
                  style={{ width: 28, height: 28, borderRadius: 6 }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                    <polyline points="10 9 9 9 8 9" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={leftPanel === ('search' as any) ? 'active' : ''}
                  title="搜索"
                  onClick={() => setLeftPanel('search' as any)}
                  style={{ width: 28, height: 28, borderRadius: 6 }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.3-4.3" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={leftPanel === 'git' ? 'active' : ''}
                  onClick={() => setLeftPanel('git')}
                  title="版本控制"
                  style={{ width: 28, height: 28, borderRadius: 6 }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <circle cx="18" cy="18" r="3" />
                    <circle cx="6" cy="6" r="3" />
                    <path d="M13 6h3a2 2 0 0 1 2 2v7" />
                    <line x1="6" y1="9" x2="6" y2="21" />
                  </svg>
                </button>
                {isMavenProject && (
                  <button
                    type="button"
                    className={leftPanel === 'maven' ? 'active' : ''}
                    onClick={() => setLeftPanel('maven')}
                    title="Maven 管理"
                    style={{ width: 28, height: 28, borderRadius: 6 }}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M4 19V5.5L12 13.5L20 5.5V19" />
                    </svg>
                  </button>
                )}
              </div>
              <div
                className="explorer-wrapper"
                style={{
                  display: leftPanel === 'explorer' ? 'flex' : 'none',
                  flexDirection: 'column',
                  minHeight: 0,
                  height: '100%',
                }}
              >
                <div
                  className="explorer-section"
                  style={{
                    flex: workspaceExpanded ? 1 : 'none',
                    display: 'flex',
                    flexDirection: 'column',
                    minHeight: 0,
                  }}
                >
                  <div
                    className="explorer-section-title idea-project-title"
                    style={{
                      height: 30,
                      boxSizing: 'border-box',
                      padding: '0 10px',
                      borderBottom: '1px solid var(--border)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      cursor: 'pointer',
                    }}
                    onClick={() => setWorkspaceExpanded((v) => !v)}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        minWidth: 0,
                        flex: 1,
                        marginRight: 8,
                      }}
                    >
                      <span className="chevron" style={{ fontSize: 12, color: 'rgba(255, 255, 255, 0.75)' }}>
                        {workspaceExpanded ? '▾' : '▸'}
                      </span>
                      <span
                        title={workspaceInfo.label || workspaceInfo.root || 'PROJECT-IDE'}
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: 'var(--text)',
                          letterSpacing: '0.05em',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {projectDisplayName}
                      </span>
                    </div>

                    <div
                      className="explorer-quick-actions"
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        gap: 4,
                        marginLeft: 'auto',
                        display: 'flex',
                        alignItems: 'center',
                        flexShrink: 0,
                      }}
                    >
                      {/* 1. 定位当前文件 (最左侧) */}
                      <button
                        type="button"
                        className="panel-action-btn"
                        title={activePath ? `定位当前文件 (${activePath.split('/').pop()})` : '定位到当前打开的文件'}
                        onClick={() => {
                          if (!activePath) {
                            showToast('当前没有打开的文件', undefined, 'info');
                            return;
                          }
                          fileTreeRef.current?.locateActiveFile();
                          showToast(`已定位: ${activePath.split('/').pop()}`, undefined, 'info');
                        }}
                      >
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
                          <circle cx="12" cy="12" r="7" />
                          <circle cx="12" cy="12" r="2" fill="currentColor" />
                          <line x1="12" y1="2" x2="12" y2="5" />
                          <line x1="12" y1="19" x2="12" y2="22" />
                          <line x1="2" y1="12" x2="5" y2="12" />
                          <line x1="19" y1="12" x2="22" y2="12" />
                        </svg>
                      </button>

                      {/* 2. 新建文件 */}
                      <button
                        type="button"
                        className="panel-action-btn"
                        title="新建文件"
                        onClick={() => fileTreeRef.current?.createFile()}
                      >
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
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h9" />
                          <polyline points="14 2 14 8 20 8" />
                          <path d="M20 15V8" />
                          <line x1="15" y1="18" x2="21" y2="18" />
                          <line x1="18" y1="15" x2="18" y2="21" />
                        </svg>
                      </button>

                      {/* 3. 新建文件夹 */}
                      <button
                        type="button"
                        className="panel-action-btn"
                        title="新建文件夹"
                        onClick={() => fileTreeRef.current?.createFolder()}
                      >
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
                          <path d="M4 22h11" />
                          <path d="M4 22a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v7" />
                          <line x1="15" y1="18" x2="21" y2="18" />
                          <line x1="18" y1="15" x2="18" y2="21" />
                        </svg>
                      </button>

                      {/* 4. 刷新文件树 */}
                      <button
                        type="button"
                        className="panel-action-btn"
                        title="刷新文件树"
                        onClick={() => {
                          setTreeRefreshKey((k) => k + 1);
                          void (async () => {
                            const res = await window.ide.gitStatus();
                            setGitStatus(res);
                          })();
                        }}
                      >
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
                          <polyline points="23 4 23 10 17 10"></polyline>
                          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                        </svg>
                      </button>

                      {/* 5. 全部折叠 / 展开 */}
                      <button
                        type="button"
                        className="panel-action-btn"
                        title={isTreeCollapsed ? '全部展开' : '全部折叠'}
                        onClick={() => {
                          if (isTreeCollapsed) {
                            fileTreeRef.current?.expandAll();
                            setIsTreeCollapsed(false);
                          } else {
                            fileTreeRef.current?.collapseAll();
                            setIsTreeCollapsed(true);
                          }
                        }}
                      >
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
                          <rect x="8" y="8" width="12" height="12" rx="2" ry="2" />
                          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                          <line x1="11" y1="14" x2="17" y2="14" />
                          {isTreeCollapsed && <line x1="14" y1="11" x2="14" y2="17" />}
                        </svg>
                      </button>
                    </div>
                  </div>
                  {workspaceExpanded && (
                    <div
                      className="explorer-section-body explorer-tree-body"
                      style={{ flex: 1, minHeight: 0 }}
                    >
                      <FileTree
                        ref={fileTreeRef}
                        workspace={workspace}
                        activePath={activePath}
                        selectedNode={selectedNode}
                        onSelectNode={setSelectedNode}
                        gitStatus={gitStatus}
                        refreshKey={treeRefreshKey}
                        onViewFileHistory={(p) => void handleViewFileHistory(p)}
                        onDiscardPath={(p) => void handleDiscardPath(p)}
                        onOpenFile={(p) => void openFile(p)}
                        onOpenTerminal={(cwd) => {
                          terminalNonce.current += 1;
                          setLayout((l) => ({ ...l, bottomPanelExpanded: true }));
                        }}
                        onAddToChat={handleAddToChat}
                        onAddToNewChat={(path) => {
                          setMessages([]);
                          chatRef.current?.startFreshWithPath(path);
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
              {/* Git / Search 面板：始终挂载但按需显隐，以保留内部状态（搜索词、选中提交等） */}
              <div
                className="git-panel"
                style={{
                  display: leftPanel === 'git' ? 'flex' : 'none',
                  minHeight: 0,
                  overflow: 'auto',
                  height: '100%',
                }}
              >
                <GitPanel
                  workspaceInfo={workspaceInfo}
                  onOpenFile={(p) => void openFile(p)}
                  onPreviewDiff={(diff) => {
                    setActiveDiffId(null);
                    setScmDiff(diff);
                  }}
                  onDiscardPath={handleDiscardPath}
                  onShowToast={showToast}
                  onViewFileHistory={(p) => void handleViewFileHistory(p)}
                  onRevealInExplorer={(p) => {
                    setLeftPanel('explorer');
                    setActivePath(p);
                  }}
                  onBranchSwitched={handleBranchSwitchSync}
                />
              </div>
              <div
                className="search-panel"
                style={{
                  display: leftPanel === ('search' as any) ? 'flex' : 'none',
                  minHeight: 0,
                  minWidth: 0,
                  overflow: 'hidden',
                  height: '100%',
                  width: '100%',
                }}
              >
                <SearchPanel onOpenFile={(p, l) => void openFile(p, l)} />
              </div>
              <div
                className="maven-panel-wrapper"
                style={{
                  display: leftPanel === 'maven' ? 'flex' : 'none',
                  minHeight: 0,
                  minWidth: 0,
                  overflow: 'hidden',
                  height: '100%',
                  width: '100%',
                }}
              >
                <MavenPanel
                  workspaceInfo={workspaceInfo}
                  onOpenFile={(p) => void openFile(p)}
                  onRunCommand={(cmd, cwd, terminalType, terminalTitle) => {
                    if (layout.bottomPanelExpanded !== true) {
                      const next = { ...layout, bottomPanelExpanded: true };
                      setLayout(next);
                      persistLayout(next);
                    }
                    terminalNonce.current += 1;
                    setTerminalOpenRequest({
                      cwd: cwd || workspace || '',
                      nonce: terminalNonce.current,
                      initialCommand: cmd,
                      terminalType: terminalType || 'mvn',
                      terminalTitle: terminalTitle || 'Maven',
                    });
                  }}
                  onShowToast={showToast}
                  onOpenSettings={(tab) => {
                    setSettingsInitialTab(tab as any);
                    setSettingsOpen(true);
                  }}
                />
              </div>
            </aside>

            <div
              className="splitter splitter-v"
              onMouseDown={(e) => startResize('explorer', e)}
              title="拖拽调整资源树宽度"
            />
          </>
        )}

        {/* 中间列: 编辑器 + 底部终端 */}
        <div className="middle-column" ref={middleColRef}>
          <EditorPane
            tabs={tabs}
            activePath={activePath}
            gitStatus={gitStatus}
            onOpenFile={(path, line, col) => {
              void openFile(path, line, col);
            }}
            onSelectTab={(path) => {
              setScmDiff(null);
              setRevealTarget(null);
              setActivePath(path);
            }}
            onCloseTab={(path) => {
              setTabs((prev) => {
                const next = prev.filter((t) => t.path !== path);
                if (activePath === path) {
                  const nextActive = next[next.length - 1]?.path ?? null;
                  setActivePath(nextActive);
                }
                return next;
              });
            }}
            onCloseOthers={(targetPath) => {
              setScmDiff(null);
              setTabs((prev) => prev.filter((t) => t.path === targetPath));
              setActivePath(targetPath);
            }}
            onCloseRight={(targetPath) => {
              setScmDiff(null);
              setTabs((prev) => {
                const idx = prev.findIndex((t) => t.path === targetPath);
                if (idx < 0) return prev;
                const next = prev.slice(0, idx + 1);
                if (!next.some((t) => t.path === activePath)) {
                  setActivePath(targetPath);
                }
                return next;
              });
            }}
            onCloseSaved={() => {
              setScmDiff(null);
              setTabs((prev) => {
                const next = prev.filter((t) => t.dirty);
                if (!next.some((t) => t.path === activePath)) {
                  setActivePath(next[next.length - 1]?.path ?? null);
                }
                return next;
              });
            }}
            onCloseAll={() => {
              setScmDiff(null);
              setTabs([]);
              setActivePath(null);
            }}
            onNewUntitled={createUntitledTab}
            onChangeContent={onChangeContent}
            onSelectionChange={setEditorSelection}
            onCursorChange={(line, col) => {
              setCursorLine(line);
              setCursorCol(col);
              cursorLineRef.current = line;
              cursorColRef.current = col;
            }}
            onAddToChat={handleAddToChat}
            previewDiff={previewDiff}
            onCloseDiff={
              scmDiff && !agentPreviewDiff
                ? () => setScmDiff(null)
                : agentPreviewDiff
                  ? () => setActiveDiffId(null)
                  : undefined
            }
            wordWrap={wordWrap}
            onToggleWordWrap={() => setWordWrap((w) => !w)}
            onPreviewGitDiff={handlePreviewGitDiff}
            onDiscardPath={handleDiscardPath}
            onRefreshGitStatus={async () => {
              const res = await window.ide.gitStatus();
              if (res.ok) setGitStatus(res);
            }}
            revealTarget={revealTarget}
            onRevealTargetConsumed={() => {
              setRevealTarget(null);
            }}
            uiTheme={uiTheme}
            gitBlameInline={gitBlameInline}
            workspace={workspace}
            onPickLocal={() => void pickWorkspace()}
            onPickSsh={() => {
              setSshTargetForModal(null);
              setSshOpen(true);
            }}
            onPickClone={() => setCloneOpen(true)}
            onCreateCppProject={() => void createTemplateWorkspace('cpp-cmake')}
            onCreateProject={(tplId) => void createTemplateWorkspace(tplId)}
            onOpenWorkspace={handleOpenCreatedProject}
            onShowToast={showToast}
            recentWorkspaces={recentWorkspaces}
            onSelectRecentWorkspace={(item) => void handleSelectRecentWorkspace(item)}
            onRemoveRecentWorkspace={handleRemoveRecentWorkspace}
            onClearRecentWorkspaces={handleClearRecentWorkspaces}
            onMoreWorkspaceHistory={() => setOpenWorkspaceOpen(true)}
            hoverDelay={hoverDelay}
            minimap={minimap}
            selectionAiFloat={selectionAiFloat}
            breakpoints={breakpoints}
            onToggleBreakpoint={handleToggleBreakpoint}
          />

          {workspace && (
            <>
              {layout.bottomPanelExpanded === true && (
                <div
                  className="splitter splitter-h"
                  onMouseDown={(e) => startResize('bottom', e)}
                  title="拖拽调整底栏高度"
                />
              )}
              <div
                className="bottom-panel"
                style={{
                  height: layout.bottomPanelExpanded === true ? layout.bottomHeight : 0,
                  display: layout.bottomPanelExpanded === true ? 'flex' : 'none',
                  flexDirection: 'column',
                  overflow: 'hidden',
                }}
              >
                {/* 底部面板模式切换工具栏 */}
                <div
                  style={{
                    height: 28,
                    background: 'rgba(0, 0, 0, 0.25)',
                    borderBottom: '1px solid var(--border)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0 8px',
                    flexShrink: 0,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                      type="button"
                      className={`bottom-tab-btn ${bottomTab === 'terminal' ? 'active' : ''}`}
                      onClick={() => setBottomTab('terminal')}
                      title="切换至终端面板"
                    >
                      <span>💻</span>
                      <span>终端 (Terminal)</span>
                    </button>
                    <button
                      type="button"
                      className={`bottom-tab-btn ${bottomTab === 'debug' ? 'active' : ''}`}
                      onClick={() => setBottomTab('debug')}
                      title="切换至调试工作台"
                    >
                      <span>🪲</span>
                      <span>调试控制台 (Debug)</span>
                      {isDebugging && (
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            background: debugState === 'paused' ? '#facc15' : '#22c55e',
                            boxShadow: debugState === 'paused' ? '0 0 6px #facc15' : '0 0 6px #22c55e',
                          }}
                        />
                      )}
                    </button>
                    <button
                      type="button"
                      className={`bottom-tab-btn ${bottomTab === 'problems' ? 'active' : ''}`}
                      onClick={() => setBottomTab('problems')}
                      title="切换至代码问题与诊断面板"
                    >
                      <span>⚠️</span>
                      <span>问题 (Problems)</span>
                      {problemsCount > 0 && (
                        <span className="problems-tab-badge">
                          {problemsCount}
                        </span>
                      )}
                    </button>
                  </div>

                  <button
                    type="button"
                    className="panel-action-btn"
                    onClick={() => {
                      const next = { ...layout, bottomPanelExpanded: false };
                      setLayout(next);
                      persistLayout(next);
                    }}
                    title="折叠面板"
                  >
                    ✕
                  </button>
                </div>

                <div style={{ flex: 1, overflow: 'hidden', display: bottomTab === 'terminal' ? 'flex' : 'none' }}>
                  <TerminalPanel
                    key={`${terminalKind}-${terminalKey}`}
                    terminalKind={terminalKind}
                    uiTheme={uiTheme}
                    openRequest={terminalOpenRequest}
                    visible={layout.bottomPanelExpanded === true && bottomTab === 'terminal'}
                    scrollback={terminalScrollback}
                    onCollapse={() => {
                      const next = { ...layout, bottomPanelExpanded: false };
                      setLayout(next);
                      persistLayout(next);
                    }}
                  />
                </div>

                <div style={{ flex: 1, overflow: 'hidden', display: bottomTab === 'debug' ? 'flex' : 'none' }}>
                  <DebugPanel
                    workspace={workspace}
                    breakpoints={breakpoints}
                    onToggleBreakpoint={handleToggleBreakpoint}
                    onClearBreakpoints={handleClearBreakpoints}
                    onOpenFile={(p, l, c) => void openFile(p, l, c)}
                    isDebugging={isDebugging}
                    debugState={debugState}
                    onContinue={() => window.ide?.dapContinue?.()}
                    onPause={() => window.ide?.dapPause?.()}
                    onStepOver={() => window.ide?.dapStepOver?.()}
                    onStepInto={() => window.ide?.dapStepInto?.()}
                    onStepOut={() => window.ide?.dapStepOut?.()}
                    onStop={() => {
                      void window.ide?.dapStopSession?.();
                      setIsDebugging(false);
                      setDebugState('stopped');
                      window.dispatchEvent(new CustomEvent('echoly:stopDebug'));
                      window.dispatchEvent(
                        new CustomEvent('echoly:stopTerminalCommand', {
                          detail: {},
                        }),
                      );
                      showToast('调试已终止', undefined, 'info');
                    }}
                  />
                </div>

                <div style={{ flex: 1, overflow: 'hidden', display: bottomTab === 'problems' ? 'flex' : 'none' }}>
                  <ProblemsPanel
                    workspace={workspace}
                    onOpenFile={(p, l, c) => void openFile(p, l, c)}
                    onCountChange={(count) => setProblemsCount(count)}
                  />
                </div>
              </div>
            </>
          )}
        </div>

        {/* 右侧 AI 面板：保持挂载以保留草稿与状态，按需显隐 */}
        {!isWelcomeShell && (
          <>
            {showChatPanel && (
              <div
                className="splitter splitter-v"
                onMouseDown={(e) => startResize('chat', e)}
                title="拖拽调整聊天面板宽度"
              />
            )}
            <aside
              className="panel right-chat-panel"
              style={{
                display: showChatPanel ? 'flex' : 'none',
              }}
            >
              {/* 右侧面板标签切换（仅在打开了 Claude 扩展等多面板时显示，默认隐藏单标签的 AI 对话） */}
              {claudePanelOpen && (
                <div className="right-panel-tabs">
                  <button
                    className={`right-panel-tab ${rightPanelTab === 'chat' ? 'active' : ''}`}
                    onClick={() => setRightPanelTab('chat')}
                  >
                    AI 对话
                  </button>
                  <button
                    className={`right-panel-tab ${rightPanelTab === 'claude' ? 'active' : ''}`}
                    onClick={() => setRightPanelTab('claude')}
                  >
                    Claude 扩展
                  </button>
                </div>
              )}

              {/* 根据标签显示不同内容 */}
              {rightPanelTab === 'chat' && (
                <ChatPanel
                  key={`${workspaceInfo.kind}-${workspace || 'none'}`}
                  ref={chatRef}
                  workspace={workspace}
                  workspaceInfo={workspaceInfo}
                  openFiles={[
                    ...tabs.filter((t) => t.path === activePath),
                    ...tabs.filter((t) => t.path !== activePath),
                  ]
                    .filter(
                      (t) => t.language !== 'image' && !t.previewUrl && !isUntitledPath(t.path),
                    )
                    .map((t) => ({ path: t.path, content: t.content }))}
                  selection={editorSelection}
                  cursor={
                    activePath
                      ? { path: activePath, line: cursorLine, column: cursorCol }
                      : undefined
                  }
                  onPendingDiff={onPendingDiff}
                  sessionMessages={messages}
                  onMessagesChange={setMessages}
                  onSessionChange={setSessionId}
                  permissionMode={permissionMode}
                  onPermissionModeChange={(m) => void changePermissionMode(m)}
                  contextWindowTokens={contextWindowTokens}
                  diffs={diffs}
                  onAcceptAllDiffs={() => void acceptAll()}
                  onRejectAllDiffs={() => {
                    diffs.forEach((d) => void rejectDiff(d.id));
                  }}
                  onSelectDiff={(id) => {
                    setScmDiff(null);
                    setActiveDiffId(id);
                  }}
                  onOpenFile={(p, l, e) => void openFile(p, l, undefined, e)}
                  onOpenSettings={() => setSettingsOpen(true)}
                  onSwitchWorkspace={handleSwitchWorkspacePath}
                  models={models}
                  activeModelId={activeModelId}
                  onActiveModelChange={handleActiveModelChange}
                />
              )}

              {rightPanelTab === 'claude' && claudePanelOpen && (
                <div style={{ height: '100%', overflow: 'hidden' }}>
                  <ClaudeChatPanel viewId="claudeVSCodeSidebar" workspace={workspace} />
                </div>
              )}
            </aside>
          </>
        )}
      </div>

      <SettingsModal
        open={settingsOpen}
        initialTab={settingsInitialTab}
        workspace={workspace}
        onClose={() => {
          setSettingsOpen(false);
          // 关闭后重置，避免下次普通打开时仍强制跳转到上次外部指定的 tab
          setSettingsInitialTab(undefined);
        }}
        onSaved={applySettings}
        onShowToast={showToast}
      />

      {/* 扩展管理面板 */}
      <ExtensionModal
        open={extensionPanelOpen}
        onClose={() => setExtensionPanelOpen(false)}
        onOpenExtension={(extId) => {
          setCurrentExtensionId(extId);
          setExtensionPanelOpen(false);
          setClaudePanelOpen(true);
          setRightPanelTab('claude'); // 切换到 Claude 标签
          // 展开右侧面板
          if (layout.chatPanelExpanded === false) {
            setLayout({ ...layout, chatPanelExpanded: true });
          }
        }}
      />

      <OpenWorkspaceModal
        open={openWorkspaceOpen}
        onClose={() => setOpenWorkspaceOpen(false)}
        onPickLocal={() => void pickWorkspace()}
        onPickSsh={() => {
          setSshTargetForModal(null);
          setSshOpen(true);
        }}
        onPickClone={() => setCloneOpen(true)}
        onOpenNewProjectWizard={() => setNewProjectWizardOpen(true)}
        recentWorkspaces={recentWorkspaces}
        currentWorkspace={workspace}
        currentWorkspaceInfo={workspaceInfo}
        onSelectRecent={(item) => void handleSelectRecentWorkspace(item)}
        onRemoveRecent={handleRemoveRecentWorkspace}
        onClearRecent={handleClearRecentWorkspaces}
      />

      <NewProjectWizardModal
        isOpen={newProjectWizardOpen}
        onClose={() => setNewProjectWizardOpen(false)}
        defaultWorkspace={workspace}
        onOpenWorkspace={handleOpenCreatedProject}
        onShowToast={showToast}
      />

      <CloneRepoModal
        open={cloneOpen}
        onClose={() => setCloneOpen(false)}
        onCloned={(path) => requestWorkspaceSwitch(path)}
      />
      <SshConnectModal
        open={sshOpen}
        initialServer={sshTargetForModal?.server}
        initialRemotePath={sshTargetForModal?.remotePath}
        isSwitchingWorkspace={!!sshTargetForModal}
        hasOpenWorkspace={!!workspace}
        onConfirmWorkspaceTarget={(t) => void requestWorkspaceOpen(t)}
        onClose={() => {
          setSshOpen(false);
          setSshTargetForModal(null);
        }}
        onConnected={() => {
          setSshTargetForModal(null);
          void window.ide.getWorkspaceInfo().then(async (info) => {
            persistOpenFilesForRoot(workspaceRef.current);
            setWorkspaceInfo(info);
            setWorkspace(info.root);
            setDiffs([]);
            setTerminalKey((k) => k + 1);
            await restoreOpenFilesForRoot(info.root);
          });
        }}
      />

      <SwitchWorkspaceModal
        open={!!switchTarget}
        target={switchTarget}
        onClose={() => {
          setSwitchTarget(null);
        }}
        onOpenCurrentWindow={(t) => void openTargetInCurrentWindow(t)}
        onOpenNewWindow={(t) => {
          openTargetInNewWindow(t);
        }}
      />

      <BranchSwitchModal
        open={branchModalOpen}
        currentBranch={gitStatus?.branch}
        onClose={() => setBranchModalOpen(false)}
        onSwitched={() => {
          void handleBranchSwitchSync();
        }}
      />

      <FileHistoryModal
        filePath={fileHistoryModalPath}
        onClose={() => setFileHistoryModalPath(null)}
        onPreviewDiff={(diff) => {
          setActiveDiffId(null);
          setScmDiff(diff);
        }}
      />

      <StatusBar
        branch={gitStatus?.branch ?? undefined}
        gitStatus={gitStatus}
        activePath={activePath}
        cursorPos={{ line: cursorLine, col: cursorCol }}
        docStats={
          (() => {
            const tab = tabs.find((t) => t.path === activePath);
            if (!tab) return null;
            return {
              lineCount: tab.content ? tab.content.split('\n').length : 1,
              charCount: tab.content ? tab.content.length : 0,
            };
          })()
        }
        language={activeLanguage}
        eol={
          (() => {
            const tab = tabs.find((t) => t.path === activePath);
            return tab?.content?.includes('\r\n') ? 'CRLF' : 'LF';
          })()
        }
        onOpenRemote={() => {
          setSshTargetForModal(null);
          setSshOpen(true);
        }}
        onOpenBranchSwitcher={() => setBranchModalOpen(true)}
        onSyncGit={async () => {
          const res = await window.ide.gitStatus();
          if (res.ok) setGitStatus(res);
        }}
        onToggleBottomPanel={() => {
          setLayout((prev) => ({
            ...prev,
            bottomPanelExpanded: !prev.bottomPanelExpanded,
          }));
        }}
        onGoToLine={(line, col) => {
          if (!activePath) return;
          revealNonceRef.current += 1;
          setRevealTarget({
            path: activePath,
            line,
            column: col ?? 1,
            nonce: revealNonceRef.current,
          });
          showToast(`已跳转到第 ${line} 行`, undefined, 'info');
        }}
        onToggleEol={(nextEol) => {
          if (!activePath) return;
          setTabs((prev) =>
            prev.map((t) => {
              if (t.path !== activePath) return t;
              const converted =
                nextEol === 'CRLF'
                  ? t.content.replace(/\r?\n/g, '\r\n')
                  : t.content.replace(/\r\n/g, '\n');
              return { ...t, content: converted, dirty: true };
            }),
          );
        }}
        onSelectLanguage={(lang) => {
          if (!activePath) return;
          setTabs((prev) =>
            prev.map((t) => (t.path === activePath ? { ...t, language: lang } : t)),
          );
          showToast(`语言模式已切换为 ${lang}`, undefined, 'info');
        }}
        onOpenAbout={() => {
          setSettingsInitialTab('about');
          setSettingsOpen(true);
        }}
        onShowToast={showToast}
      />

      {/* Bottom-Right Toast Notifications Overlay */}
      {toasts.length > 0 && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            zIndex: 99999,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            maxWidth: 'min(420px, calc(100vw - 32px))',
            pointerEvents: 'none',
          }}
        >
          {toasts.map((t) => {
            const cleanTitle = t.title.replace(
              /^[\u2713\u2715\u26a0\u2139\u26a1\u2699\u00d7]\uFE0F?\s*/u,
              '',
            );
            const isLong = (t.detail && t.detail.length > 40) || cleanTitle.length > 25;

            return (
              <div
                key={t.id}
                onClick={() => {
                  if (isLong) {
                    setToastDetailModal({
                      id: t.id,
                      title: cleanTitle,
                      detail: t.detail,
                      type: t.type,
                    });
                  }
                }}
                style={{
                  pointerEvents: 'auto',
                  background: 'var(--bg-elevated, #252526)',
                  border: '1px solid var(--border)',
                  borderLeft: `4px solid ${
                    t.type === 'success'
                      ? '#4caf50'
                      : t.type === 'error'
                        ? '#f44336'
                        : t.type === 'warn'
                          ? '#ff9800'
                          : '#2196f3'
                  }`,
                  borderRadius: 6,
                  padding: '9px 12px',
                  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
                  color: 'var(--text)',
                  fontSize: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: 360,
                  boxSizing: 'border-box',
                  cursor: isLong ? 'pointer' : 'default',
                  transition: 'transform 0.15s ease, box-shadow 0.15s ease',
                }}
              >
                <span
                  style={{
                    fontSize: 14,
                    flexShrink: 0,
                    lineHeight: 1,
                    display: 'flex',
                    alignItems: 'center',
                  }}
                >
                  {t.type === 'success'
                    ? '✓'
                    : t.type === 'error'
                      ? '✕'
                      : t.type === 'warn'
                        ? '⚠️'
                        : 'ℹ️'}
                </span>

                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      fontWeight: 600,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: 'var(--text-bright, #ffffff)',
                    }}
                    title={cleanTitle}
                  >
                    {cleanTitle}
                  </div>
                  {t.detail && (
                    <div
                      style={{
                        color: 'var(--muted)',
                        marginTop: 2,
                        fontSize: 11,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={t.detail}
                    >
                      {t.detail}
                    </div>
                  )}
                </div>

                {/* 快捷操作区：快速复制、弹窗展开与关闭 */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    flexShrink: 0,
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* 快速复制按钮 */}
                  <button
                    type="button"
                    className="panel-action-btn"
                    style={{
                      width: 24,
                      height: 24,
                      padding: 0,
                      borderRadius: 4,
                      color: copiedToastId === t.id ? '#10b981' : 'var(--muted)',
                    }}
                    title="复制提示内容"
                    onClick={() => {
                      const text = t.detail ? `${cleanTitle}\n${t.detail}` : cleanTitle;
                      void navigator.clipboard.writeText(text);
                      setCopiedToastId(t.id);
                      setTimeout(() => setCopiedToastId(null), 1500);
                    }}
                  >
                    {copiedToastId === t.id ? (
                      <span style={{ fontSize: 12, fontWeight: 700 }}>✓</span>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    )}
                  </button>

                  {/* 展开弹窗按钮 (提示较长或想要细看时) */}
                  {isLong && (
                    <button
                      type="button"
                      className="panel-action-btn"
                      style={{ width: 24, height: 24, padding: 0, borderRadius: 4 }}
                      title="弹窗查看完整详情"
                      onClick={() =>
                        setToastDetailModal({
                          id: t.id,
                          title: cleanTitle,
                          detail: t.detail,
                          type: t.type,
                        })
                      }
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <polyline points="15 3 21 3 21 9" />
                        <polyline points="9 21 3 21 3 15" />
                        <line x1="21" y1="3" x2="14" y2="10" />
                        <line x1="3" y1="21" x2="10" y2="14" />
                      </svg>
                    </button>
                  )}

                  {/* 关闭按钮 */}
                  <button
                    type="button"
                    className="panel-action-btn"
                    style={{ width: 20, height: 20, padding: 0, fontSize: 13, borderRadius: 4 }}
                    title="关闭"
                    onClick={() => setToasts((prev) => prev.filter((item) => item.id !== t.id))}
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 提示消息完整详情弹窗 */}
      {toastDetailModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 100000,
            background: 'rgba(0, 0, 0, 0.65)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={() => setToastDetailModal(null)}
        >
          <div
            style={{
              background: 'var(--bg-elevated, #252526)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              boxShadow: '0 12px 36px rgba(0, 0, 0, 0.6)',
              width: 500,
              maxWidth: '92vw',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              padding: 16,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16 }}>
                  {toastDetailModal.type === 'success'
                    ? '✓'
                    : toastDetailModal.type === 'error'
                      ? '✕'
                      : toastDetailModal.type === 'warn'
                        ? '⚠️'
                        : 'ℹ️'}
                </span>
                <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-bright)' }}>
                  {toastDetailModal.title}
                </span>
              </div>
              <button
                type="button"
                className="panel-action-btn"
                onClick={() => setToastDetailModal(null)}
                style={{ width: 24, height: 24, fontSize: 14 }}
              >
                ×
              </button>
            </div>

            {toastDetailModal.detail && (
              <div
                style={{
                  background: 'rgba(0, 0, 0, 0.3)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: 12,
                  maxHeight: 280,
                  overflowY: 'auto',
                  fontSize: 12,
                  lineHeight: 1.6,
                  fontFamily: 'Consolas, "Cascadia Code", monospace',
                  color: 'var(--text)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  userSelect: 'text',
                }}
              >
                {toastDetailModal.detail}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button
                type="button"
                className="panel-standard-btn"
                style={{ padding: '5px 14px', fontSize: 12 }}
                onClick={() => {
                  const text = toastDetailModal.detail
                    ? `${toastDetailModal.title}\n${toastDetailModal.detail}`
                    : toastDetailModal.title;
                  void navigator.clipboard.writeText(text);
                  setModalCopied(true);
                  setTimeout(() => setModalCopied(false), 2000);
                }}
              >
                {modalCopied ? '✓ 已复制完整内容' : '复制内容'}
              </button>
              <button
                type="button"
                className="panel-standard-btn primary"
                style={{ padding: '5px 14px', fontSize: 12 }}
                onClick={() => setToastDetailModal(null)}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
      <ComposerModal
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        workspaceRoot={workspace}
        openFiles={[
          ...tabs.filter((t) => t.path === activePath),
          ...tabs.filter((t) => t.path !== activePath),
        ]
          .filter((t) => t.language !== 'image' && !t.previewUrl && !isUntitledPath(t.path))
          .map((t) => ({ path: t.path, content: t.content }))}
        onOpenFile={(path, line) => openFile(path, line)}
      />
      <GlobalTooltip delay={hoverDelay} />
    </div>
  );
}
