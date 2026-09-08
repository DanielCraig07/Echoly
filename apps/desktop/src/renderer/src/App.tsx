import {
  useCallback,
  useEffect,
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
} from '@deepseek-ide/shared';
import { DEFAULT_LAYOUT, DEFAULT_SETTINGS, DEFAULT_MODELS } from '@deepseek-ide/shared';
import { FileTree, type FileTreeHandle } from './components/FileTree';
import { EditorPane } from './components/EditorPane';
import { ChatPanel, type ChatPanelHandle } from './components/ChatPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { SettingsModal } from './components/SettingsModal';
import { OpenWorkspaceModal } from './components/OpenWorkspaceModal';
import { CloneRepoModal } from './components/CloneRepoModal';
import { SshConnectModal } from './components/SshConnectModal';
import { SwitchWorkspaceModal } from './components/SwitchWorkspaceModal';
import { BranchSwitchModal } from './components/BranchSwitchModal';
import {
  TopSearchBar,
  type TopSearchBarHandle,
  type CommandAction,
} from './components/TopSearchBar';
import { RunWidget } from './components/RunWidget';
import { ExtensionPanel } from './components/ExtensionPanel';
import { ClaudeChatPanel } from './components/ClaudeChatPanel';
import { GitPanel } from './components/GitPanel';
import { SearchPanel } from './components/SearchPanel';
import { StatusBar } from './components/StatusBar';
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
type LeftPanel = 'explorer' | 'git';

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
  const [openWorkspaceOpen, setOpenWorkspaceOpen] = useState(false);
  const [switchWorkspacePath, setSwitchWorkspacePath] = useState<string | null>(null);
  const [branchModalOpen, setBranchModalOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [sshOpen, setSshOpen] = useState(false);
  const [extensionPanelOpen, setExtensionPanelOpen] = useState(false);
  const [claudePanelOpen, setClaudePanelOpen] = useState(false);
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
  const [models, setModels] = useState<ModelProfile[]>(DEFAULT_MODELS);
  const [activeModelId, setActiveModelId] = useState<string>('deepseek-local');
  const [layout, setLayout] = useState<LayoutSettings>({ ...DEFAULT_LAYOUT });
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [shellWidth, setShellWidth] = useState(0);
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
  const middleColRef = useRef<HTMLDivElement>(null);
  const saveLayoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatRef = useRef<ChatPanelHandle>(null);
  const [terminalOpenRequest, setTerminalOpenRequest] = useState<{
    cwd: string;
    nonce: number;
    initialCommand?: string;
  } | null>(null);
  const terminalNonce = useRef(0);
  const [leftPanel, setLeftPanel] = useState<LeftPanel>('explorer');
  const [scmDiff, setScmDiff] = useState<PendingDiff | null>(null);
  const [revealLine, setRevealLine] = useState<number | null>(null);
  const [revealColumn, setRevealColumn] = useState<number | null>(null);
  // nonce 单调递增，每次点击跳转时自增，保证 EditorPane 的 revealLine effect 必定触发
  const [revealNonce, setRevealNonce] = useState(0);
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
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
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

    const pathsToDiscard = (Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths]).filter(Boolean);

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
            prev.map((t) =>
              t.path === tab.path ? { ...t, dirty: false, previewUrl } : t,
            ),
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

  useEffect(() => {
    if (!workspace) return;
    let isMounted = true;
    const fetchGit = async () => {
      try {
        const res = await window.ide.gitStatus();
        if (!isMounted) return;
        if (res.ok) {
          setGitStatus(res);
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
  }, [workspace]);

  const handleViewFileHistory = useCallback(async (filePath: string) => {
    setTimelineFile(filePath);
    // 不展开时间线，保持默认折叠
    setLeftPanel('explorer');
    try {
      const res = await window.ide.gitFileHistory(filePath, 50);
      if (res.ok) {
        setTimelineCommits(res.commits);
      } else {
        setTimelineCommits([]);
      }
    } catch {
      setTimelineCommits([]);
    }
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

  const requestWorkspaceSwitch = useCallback(
    (path: string) => {
      if (workspace && workspace !== path) {
        setSwitchWorkspacePath(path);
      } else {
        void switchWorkspaceInCurrentWindow(path);
      }
    },
    [workspace, switchWorkspaceInCurrentWindow],
  );

  const handleSwitchWorkspacePath = useCallback(
    async (targetPath: string) => {
      if (!targetPath || targetPath === workspace) return;

      const isSsh =
        targetPath.startsWith('ssh ') ||
        targetPath.startsWith('ssh:') ||
        targetPath.startsWith('ssh://') ||
        /^[^@\s]+@[^:\s]+:/.test(targetPath);
      if (isSsh) {
        let userHost = '';
        let hostOnly = '';
        const m =
          targetPath.match(/^ssh\s+([^@\s]+@)?([^:/\s]+)/i) ||
          targetPath.match(/^ssh:\/\/([^@/\s]+@)?([^:/\s]+)/i) ||
          targetPath.match(/^([^@/\s]+@)?([^:/\s]+):/);
        if (m) {
          hostOnly = m[2] || '';
          userHost = (m[1] || '') + hostOnly;
        }

        const remotePathMatch = targetPath.match(/:(.+)$/);
        const remotePath = remotePathMatch?.[1]?.trim() || undefined;

        const profiles = await window.ide.listSshProfiles().catch(() => []);
        const matchedProfile = profiles.find((p) => {
          if (remotePath && p.remotePath === remotePath) return true;
          if (hostOnly && p.host === hostOnly) return true;
          if (userHost && `${p.username}@${p.host}` === userHost.replace(/^@/, '')) return true;
          if (userHost && p.name === userHost) return true;
          return false;
        });

        if (matchedProfile) {
          const res = await window.ide.sshConnect({
            host: matchedProfile.host,
            port: matchedProfile.port,
            username: matchedProfile.username,
            privateKeyPath: matchedProfile.privateKeyPath,
            remotePath: remotePath || matchedProfile.remotePath,
          });
          if (res.ok) {
            const info = await window.ide.getWorkspaceInfo();
            persistOpenFilesForRoot(workspaceRef.current);
            setWorkspaceInfo(info);
            setWorkspace(info.root);
            setDiffs([]);
            setScmDiff(null);
            setTerminalKey((k) => k + 1);
            await restoreOpenFilesForRoot(info.root);
            return;
          }
        }

        setSshTargetForModal({
          server: userHost || hostOnly || undefined,
          remotePath: remotePath || targetPath,
        });
        setSshOpen(true);
      } else {
        requestWorkspaceSwitch(targetPath);
      }
    },
    [workspace, requestWorkspaceSwitch, persistOpenFilesForRoot, restoreOpenFilesForRoot],
  );

  const handleSelectRecentWorkspace = useCallback(
    async (item: RecentWorkspaceItem) => {
      const isSsh = item.kind === 'ssh' || !!item.sshServer || item.path.startsWith('ssh ');
      if (isSsh) {
        const profiles = await window.ide.listSshProfiles().catch(() => []);
        const matchedProfile = profiles.find(
          (p: any) =>
            (item.sshServer && (p.name === item.sshServer || p.host === item.sshServer)) ||
            p.remotePath === item.path,
        );
        if (matchedProfile) {
          const res = await window.ide.sshConnect({
            host: matchedProfile.host,
            port: matchedProfile.port,
            username: matchedProfile.username,
            privateKeyPath: matchedProfile.privateKeyPath,
            remotePath: item.path || matchedProfile.remotePath,
          });
          if (res.ok) {
            const info = await window.ide.getWorkspaceInfo();
            persistOpenFilesForRoot(workspaceRef.current);
            setWorkspaceInfo(info);
            setWorkspace(info.root);
            setDiffs([]);
            setScmDiff(null);
            setTerminalKey((k) => k + 1);
            await restoreOpenFilesForRoot(info.root);
            return;
          }
        }
        setSshTargetForModal({
          server: item.sshServer,
          remotePath: item.path,
        });
        setSshOpen(true);
      } else {
        requestWorkspaceSwitch(item.path);
      }
    },
    [requestWorkspaceSwitch, persistOpenFilesForRoot, restoreOpenFilesForRoot],
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
        void window.ide.setWorkspace(workspaceFromQuery).then(async (root) => {
          const info = await window.ide.getWorkspaceInfo();
          setWorkspaceInfo(info);
          setWorkspace(root);
          await restoreOpenFilesForRoot(root);
        });
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
  }, [applySettings, persistOpenFilesForRoot, restoreOpenFilesForRoot]);

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

  const persistLayout = useCallback((next: LayoutSettings) => {
    if (saveLayoutTimer.current) clearTimeout(saveLayoutTimer.current);
    saveLayoutTimer.current = setTimeout(() => {
      void window.ide.saveSettings({ layout: next });
    }, 300);
  }, []);

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

  const openFile = useCallback(async (rawPath: string, line?: number, col?: number) => {
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
        // nonce 自增保证 effect 必定重新触发，即使行号相同也能跳转
        setRevealNonce((n) => n + 1);
        setRevealColumn(col ?? null);
        setRevealLine(line);
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
            (h) => h.path === path || h.path.endsWith('/' + path) || h.path.endsWith(fileName)
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
        console.warn('[navigation] cannot open file:', path, err instanceof Error ? err.message : err);
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
      setRevealNonce((n) => n + 1);
      setRevealColumn(col ?? null);
      setTimeout(() => setRevealLine(line), 10);
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
        if (normK === normTarget || normK.endsWith('/' + normTarget) || normTarget.endsWith('/' + normK)) {
          clearTimeout(timer);
          autoSaveTimers.current.delete(k);
        }
      }
      return;
    }

    if (isUntitledPath(path) || !autoSaveRef.current) return;

    for (const [k, timer] of autoSaveTimers.current.entries()) {
      const normK = k.replace(/\\/g, '/').replace(/^\/+/, '');
      if (normK === normTarget || normK.endsWith('/' + normTarget) || normTarget.endsWith('/' + normK)) {
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
        setOpenWorkspaceOpen(true);
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
      if (command.type !== 'save') return;
      void saveActive();
    });
  }, [openFile, requestWorkspaceSwitch, createUntitledTab, saveActive]);

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
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveActive();
        return;
      }
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
      }
      // Command palette 中登记的快捷键（Cmd+N/B/J/O/, 等）。这些组合键没有打字
      // 语义，即使焦点在输入框/终端（xterm 的隐藏 textarea）里也应触发，因此不做
      // isTyping 拦截，否则打开终端后标签页或 xterm 获得焦点就会让快捷键失效。
      const shortcutMap: Record<string, string> = {
        n: 'cmd-new-chat',
        b: 'cmd-toggle-ai',
        j: 'cmd-toggle-terminal',
        o: 'cmd-switch-workspace',
        ',': 'cmd-open-settings',
      };
      const isMonacoFocused = (() => {
        const el = document.activeElement as HTMLElement | null;
        return !!(el && typeof el.closest === 'function' && el.closest('.monaco-editor'));
      })();
      const isTerminalFocused = (() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return false;
        return el.classList?.contains('xterm-helper-textarea') || !!el.closest?.('.xterm');
      })();
      // 仅当焦点在应用自带文本输入且不在编辑器/终端里时，跳过 IDE 快捷键；
      // 编辑器与终端里的 Cmd 组合键仍交由 IDE 处理（它们不冲突于打字）。
      const skipDueToInput = (() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return false;
        if (isMonacoFocused || isTerminalFocused) return false;
        const tag = el.tagName?.toLowerCase();
        return tag === 'input' || tag === 'textarea' || el.isContentEditable;
      })();
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
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [activePath]);

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
      id: 'cmd-toggle-ai',
      title: '视图: 展开/折叠 AI 助手',
      category: '视图',
      shortcut: 'Cmd+B',
      handler: () => {
        const next = {
          ...layoutRef.current,
          chatPanelExpanded: layoutRef.current.chatPanelExpanded === false,
        };
        setLayout(next);
        persistLayout(next);
      },
    },
    {
      id: 'cmd-toggle-terminal',
      title: '终端: 展开/折叠底部控制台',
      category: '终端',
      shortcut: 'Cmd+J',
      handler: () => {
        const next = {
          ...layoutRef.current,
          bottomPanelExpanded: layoutRef.current.bottomPanelExpanded !== true,
        };
        setLayout(next);
        persistLayout(next);
      },
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
      handler: () => setOpenWorkspaceOpen(true),
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
            onExpandBottom={() => {
              const next = { ...layout, bottomPanelExpanded: true };
              setLayout(next);
              persistLayout(next);
            }}
            onRunCommand={(cmd) => {
              terminalNonce.current += 1;
              setTerminalOpenRequest({
                cwd: workspace || '',
                nonce: terminalNonce.current,
                initialCommand: cmd,
              });
            }}
          />

          {/* 全局命令与文件搜索触发栏 */}
          <button
            type="button"
            className="top-search-trigger"
            onClick={() => searchRef.current?.focus('actions')}
            title="搜索动作或文件 (⌘P / ⌘Shift+P)"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span className="search-trigger-text">命令 / 搜索</span>
            <kbd className="search-trigger-kbd">⌘P</kbd>
          </button>

          {/* 3个区域折叠/展开切换按钮 */}
          <div className="layout-toggle-group">
            <button
              type="button"
              className={`layout-toggle-btn ${showLeftPanel ? 'active' : ''}`}
              title={showLeftPanel ? '折叠左侧边栏' : '展开左侧边栏'}
              disabled={isWelcomeShell}
              onClick={() => {
                const next = { ...layout, leftPanelExpanded: layout.leftPanelExpanded === false };
                setLayout(next);
                persistLayout(next);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <rect
                  x="1.5"
                  y="1.5"
                  width="13"
                  height="13"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <line
                  x1="5.5"
                  y1="1.5"
                  x2="5.5"
                  y2="14.5"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <rect
                  x="1.5"
                  y="1.5"
                  width="4"
                  height="13"
                  fill="currentColor"
                  opacity="0.4"
                  rx="1"
                />
              </svg>
            </button>
            <button
              type="button"
              className={`layout-toggle-btn ${!isWelcomeShell && layout.bottomPanelExpanded === true ? 'active' : ''}`}
              title={layout.bottomPanelExpanded === true ? '折叠底部终端' : '展开底部终端'}
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
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <rect
                  x="1.5"
                  y="1.5"
                  width="13"
                  height="13"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <line
                  x1="1.5"
                  y1="10.5"
                  x2="14.5"
                  y2="10.5"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <rect
                  x="1.5"
                  y="10.5"
                  width="13"
                  height="4"
                  fill="currentColor"
                  opacity="0.4"
                  rx="1"
                />
              </svg>
            </button>
            <button
              type="button"
              className={`layout-toggle-btn ${showChatPanel ? 'active' : ''}`}
              title={showChatPanel ? '折叠右侧 AI 面板' : '展开右侧 AI 面板'}
              disabled={isWelcomeShell}
              onClick={() => {
                const next = { ...layout, chatPanelExpanded: layout.chatPanelExpanded === false };
                setLayout(next);
                persistLayout(next);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <rect
                  x="1.5"
                  y="1.5"
                  width="13"
                  height="13"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <line
                  x1="10.5"
                  y1="1.5"
                  x2="10.5"
                  y2="14.5"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <rect
                  x="10.5"
                  y="1.5"
                  width="4"
                  height="13"
                  fill="currentColor"
                  opacity="0.4"
                  rx="1"
                />
              </svg>
            </button>
          </div>

          {/* 设置按钮 */}
          <button
            type="button"
            className="layout-toggle-btn settings-btn"
            title="设置"
            onClick={() => setSettingsOpen(true)}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
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
                  gap: 16,
                  height: 35,
                  padding: '4px 12px 4px',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <button
                  type="button"
                  className={leftPanel === 'explorer' ? 'active' : ''}
                  onClick={() => setLeftPanel('explorer')}
                  title="文件"
                  style={{ width: 26, height: 26, borderRadius: 6 }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
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
                  style={{ width: 26, height: 26, borderRadius: 6 }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
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
                  style={{ width: 26, height: 26, borderRadius: 6 }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <circle cx="18" cy="18" r="3" />
                    <circle cx="6" cy="6" r="3" />
                    <path d="M13 6h3a2 2 0 0 1 2 2v7" />
                    <line x1="6" y1="9" x2="6" y2="21" />
                  </svg>
                </button>
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
                    }}
                    onClick={() => setWorkspaceExpanded((v) => !v)}
                  >
                    <span className="chevron" style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {workspaceExpanded ? '▾' : '▸'}
                    </span>
                    <span
                      title={workspaceInfo.label || 'PROJECT-IDE'}
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: 'var(--text)',
                        letterSpacing: '0.05em',
                        flex: 1,
                        minWidth: 0,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {workspaceInfo.label
                        ? workspaceInfo.label.includes('/')
                          ? workspaceInfo.label.split('/').filter(Boolean).pop()?.toUpperCase()
                          : workspaceInfo.label.toUpperCase()
                        : 'PROJECT-IDE'}
                    </span>

                    <div
                      className="explorer-quick-actions"
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        gap: 4,
                        marginLeft: 'auto',
                        display: 'flex',
                        alignItems: 'center',
                      }}
                    >
                      <button
                        type="button"
                        title="新建文件"
                        style={{ padding: 4 }}
                        onClick={() => fileTreeRef.current?.createFile()}
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                        >
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h9" />
                          <polyline points="14 2 14 8 20 8" />
                          <path d="M20 15V8" />
                          <line x1="15" y1="18" x2="21" y2="18" />
                          <line x1="18" y1="15" x2="18" y2="21" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        title="新建文件夹"
                        style={{ padding: 4 }}
                        onClick={() => fileTreeRef.current?.createFolder()}
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                        >
                          <path d="M4 22h11" />
                          <path d="M4 22a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v7" />
                          <line x1="15" y1="18" x2="21" y2="18" />
                          <line x1="18" y1="15" x2="18" y2="21" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        title="刷新文件树"
                        style={{ padding: 4 }}
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
                          strokeWidth="1.5"
                        >
                          <polyline points="23 4 23 10 17 10"></polyline>
                          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
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
                        onAddToChat={(path) => chatRef.current?.insertPath(path)}
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
                <SearchPanel
                  onOpenFile={(p, l) => void openFile(p, l)}
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
            onAddToChat={(text) => chatRef.current?.insertPath(text)}
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
            revealLine={revealLine}
            revealColumn={revealColumn}
            revealNonce={revealNonce}
            uiTheme={uiTheme}
            gitBlameInline={gitBlameInline}
            workspace={workspace}
            onPickLocal={() => void pickWorkspace()}
            onPickSsh={() => {
              setSshTargetForModal(null);
              setSshOpen(true);
            }}
            onPickClone={() => setCloneOpen(true)}
            recentWorkspaces={recentWorkspaces}
            onSelectRecentWorkspace={(item) => void handleSelectRecentWorkspace(item)}
            onRemoveRecentWorkspace={handleRemoveRecentWorkspace}
            onClearRecentWorkspaces={handleClearRecentWorkspaces}
            onMoreWorkspaceHistory={() => setOpenWorkspaceOpen(true)}
          />

          {workspace && layout.bottomPanelExpanded === true && (
            <>
              <div
                className="splitter splitter-h"
                onMouseDown={(e) => startResize('bottom', e)}
                title="拖拽调整底栏高度"
              />
              <div className="bottom-panel" style={{ height: layout.bottomHeight }}>
                <TerminalPanel
                  key={`${terminalKind}-${terminalKey}`}
                  terminalKind={terminalKind}
                  uiTheme={uiTheme}
                  openRequest={terminalOpenRequest}
                  visible={true}
                  onCollapse={() => {
                    const next = { ...layout, bottomPanelExpanded: false };
                    setLayout(next);
                    persistLayout(next);
                  }}
                />
              </div>
            </>
          )}
        </div>

        {/* 右侧 AI 面板 */}
        {showChatPanel && (
          <>
            <div
              className="splitter splitter-v"
              onMouseDown={(e) => startResize('chat', e)}
              title="拖拽调整聊天面板宽度"
            />
            <aside className="panel right-chat-panel">
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
                  onOpenFile={(p, l) => void openFile(p, l)}
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
        onClose={() => setSettingsOpen(false)}
        onSaved={applySettings}
        onShowToast={showToast}
      />

      {/* 扩展管理面板 */}
      {extensionPanelOpen && (
        <div className="modal-overlay" onClick={() => setExtensionPanelOpen(false)}>
          <div className="extension-modal" onClick={(e) => e.stopPropagation()}>
            <div className="extension-modal-header">
              <h2>扩展管理</h2>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setExtensionPanelOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="extension-modal-body">
              <ExtensionPanel
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
            </div>
          </div>
        </div>
      )}

      <OpenWorkspaceModal
        open={openWorkspaceOpen}
        onClose={() => setOpenWorkspaceOpen(false)}
        onPickLocal={() => void pickWorkspace()}
        onPickSsh={() => {
          setSshTargetForModal(null);
          setSshOpen(true);
        }}
        onPickClone={() => setCloneOpen(true)}
        recentWorkspaces={recentWorkspaces}
        onSelectRecent={(item) => void handleSelectRecentWorkspace(item)}
        onRemoveRecent={handleRemoveRecentWorkspace}
        onClearRecent={handleClearRecentWorkspaces}
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
        open={!!switchWorkspacePath}
        targetPath={switchWorkspacePath}
        onClose={() => setSwitchWorkspacePath(null)}
        onOpenCurrentWindow={(path) => void switchWorkspaceInCurrentWindow(path)}
        onOpenNewWindow={(path) => void window.ide.openNewWindow(path)}
      />

      <BranchSwitchModal
        open={branchModalOpen}
        currentBranch={gitStatus?.branch}
        onClose={() => setBranchModalOpen(false)}
        onSwitched={() => {
          void (async () => {
            const st = await window.ide.gitStatus();
            setGitStatus(st);
            setTreeRefreshKey((k) => k + 1);
          })();
        }}
      />

      <StatusBar
        branch={gitStatus?.branch ?? undefined}
        gitStatus={gitStatus}
        activePath={activePath}
        cursorPos={{ line: cursorLine, col: cursorCol }}
        language={activeLanguage}
        onOpenBranchSwitcher={() => setBranchModalOpen(true)}
        onSelectLanguage={(lang) => {
          if (!activePath) return;
          setTabs((prev) =>
            prev.map((t) => (t.path === activePath ? { ...t, language: lang } : t)),
          );
        }}
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
            maxWidth: 360,
            pointerEvents: 'none',
          }}
        >
          {toasts.map((t) => (
            <div
              key={t.id}
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
                padding: '10px 14px',
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
                color: 'var(--text)',
                fontSize: 12,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
              }}
            >
              <span style={{ fontSize: 14 }}>
                {t.type === 'success'
                  ? '✓'
                  : t.type === 'error'
                    ? '✕'
                    : t.type === 'warn'
                      ? '⚠️'
                      : 'ℹ️'}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{t.title}</div>
                {t.detail && (
                  <div style={{ color: 'var(--muted)', marginTop: 2, fontSize: 11 }}>
                    {t.detail}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
