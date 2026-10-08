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
import { useDbConfirm } from './hooks/useDbConfirm';
import { buildSqlConfirmMarkdown } from './services/dbConfirmContent';
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
  CompareWithRevisionModal,
  CompareWithBranchOrTagModal,
  RollbackFileModal,
} from './components/GitFileModals';
import { UnsavedChangesModal } from './components/UnsavedChangesModal';
import {
  TopSearchBar,
  type TopSearchBarHandle,
  type CommandAction,
} from './components/TopSearchBar';
import { RunWidget } from './components/RunWidget';
import { ExtensionModal } from './components/ExtensionPanel';
import { ClaudeChatPanel } from './components/ClaudeChatPanel';
import { PanelChevron } from './components/PanelChevron';
import { GitPanel } from './components/GitPanel';
import { SearchPanel } from './components/SearchPanel';
import { MavenPanel } from './components/MavenPanel';
import { DatabasePanel } from './components/DatabasePanel';
import { AgentTaskPanel } from './components/AgentTaskPanel';
import { ProblemsPanel } from './components/ProblemsPanel';
import { StatusBar } from './components/StatusBar';
import { GlobalTooltip } from './components/GlobalTooltip';
import { heuristicDetectTech } from './utils/techStack';
import {
  isImagePath,
  isUntitledPath,
  isVirtualPath,
  isDbPath,
  requiresExactPathMatch,
  isSameFileByPath,
  languageFromPath,
  uid,
  buildSessionWorkspaceMeta,
} from './utils';
import {
  clearWorkspaceOpenFiles,
  loadWorkspaceOpenFiles,
  saveWorkspaceOpenFiles,
  type CursorPos,
  type VirtualTabState,
} from './workspaceSession';
import { setupSymbolNavigation } from './services/symbolNavigation';
import type { DbTableViewState } from './services/dbTableQuery';
import type { DbProjectScriptEntry } from './components/DatabasePanel';
import {
  PROJECT_SCRIPT_SCOPE,
  QUERIES_DIR,
  consoleTabPath,
  isQueryScriptName,
  nextScriptFileName,
  parseScriptRelPath,
  projectScriptPathFor,
  scriptDirFor,
  scriptFileNameFromTabPath,
  scriptPathFor,
  scriptTitleFromFileName,
} from './services/dbQueryScripts';

type ResizeAxis = 'explorer' | 'chat' | 'bottom';
type LeftPanel = 'explorer' | 'search' | 'git' | 'maven' | 'database' | 'agent-tasks';

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
  // 删除脚本 / 放弃更改等不可逆操作的统一确认框（全应用每个组件各持一个实例）
  const confirm = useDbConfirm();
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
  const [chatResetKey, setChatResetKey] = useState(0);
  const [terminalKey, setTerminalKey] = useState(0);

  const resetAiChatSession = useCallback(() => {
    setMessages([]);
    setSessionId(uid());
    setDiffs([]);
    setScmDiff(null);
    setActiveDiffId(null);
    setChatResetKey((k) => k + 1);
  }, []);
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
  const [formatOnSave, setFormatOnSave] = useState(DEFAULT_SETTINGS.formatOnSave ?? false);
  const [largeFileThresholdBytes, setLargeFileThresholdBytes] = useState(
    DEFAULT_SETTINGS.largeFileThresholdBytes ?? 2 * 1024 * 1024,
  );
  const largeFileThresholdBytesRef = useRef(largeFileThresholdBytes);
  largeFileThresholdBytesRef.current = largeFileThresholdBytes;
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
  /**
   * SQL 控制台脚本的落盘定时器，键是**脚本文件路径**（不是标签路径）。
   *
   * 单独一个 Map：虚拟标签本来完全不写盘，这一条落盘是「控制台脚本跟项目走」这个需求的实现，
   * 混进 autoSaveTimers 会让那条路径的语义（草稿/虚拟标签跳过）变得自相矛盾。
   */
  const scriptTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Paths currently being discarded: within suppression window, Monaco's onChange
  // will NOT trigger auto-save or mark dirty, preventing discarded files from being saved back.
  const suppressAutoSaveUntilRef = useRef<Map<string, number>>(new Map());
  const shellRef = useRef<HTMLDivElement>(null);
  const [shellWidth, setShellWidth] = useState<number>(0);
  const middleColRef = useRef<HTMLDivElement>(null);
  const saveLayoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatRef = useRef<ChatPanelHandle>(null);
  const pendingAddToChatRef = useRef<string | null>(null);
  const resolvedPathCache = useRef<Map<string, string>>(new Map());
  const [terminalOpenRequest, setTerminalOpenRequest] = useState<{
    cwd: string;
    nonce: number;
    initialCommand?: string;
    terminalType?: string;
    terminalTitle?: string;
  } | null>(null);
  const terminalNonce = useRef(0);
  const [leftPanel, setLeftPanel] = useState<LeftPanel>('explorer');
  useEffect(() => {
    if ((leftPanel as string) === 'agent-tasks') {
      setLeftPanel('explorer');
    }
  }, [leftPanel]);
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
  const handleRevealTargetConsumed = useCallback(() => {
    setRevealTarget(null);
  }, []);
  const cursorLineRef = useRef(1);
  const cursorColRef = useRef(1);
  const fileCursorPositionsRef = useRef<Record<string, CursorPos>>({});
  const searchRef = useRef<TopSearchBarHandle>(null);
  const fileTreeRef = useRef<FileTreeHandle>(null);

  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null);
  const [workspaceExpanded, setWorkspaceExpanded] = useState(true);
  const [outlineExpanded, setOutlineExpanded] = useState(false);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [timelineFile, setTimelineFile] = useState<string | null>(null);
  const [timelineCommits, setTimelineCommits] = useState<GitCommitEntry[]>([]);
  const [fileHistoryModalPath, setFileHistoryModalPath] = useState<string | null>(null);
  const [compareRevisionModalPath, setCompareRevisionModalPath] = useState<string | null>(null);
  const [compareBranchOrTagModalPath, setCompareBranchOrTagModalPath] = useState<string | null>(null);
  const [rollbackModalPath, setRollbackModalPath] = useState<string | null>(null);
  const [annotatedBlamePath, setAnnotatedBlamePath] = useState<string | null>(null);
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

  /**
   * 项目里保存的查询脚本清单（数据库面板底部那份）。
   *
   * 数据源是**项目配置目录的磁盘内容**，不是打开的标签：用户关掉标签后脚本并没消失，
   * 能在列表里再找到它才是这个清单的价值。因此凡是「脚本文件可能变了」的地方都要刷新：
   * 新建控制台、脚本首次落盘、删除脚本、切换工作区。
   *
   * 定义在很靠前的位置（紧跟 showToast）：切工作区那条 effect 要用它，
   * 而 effect 在文件里出现得比开控制台的逻辑早，const 放在后面会撞上暂时性死区。
   */
  const [projectScripts, setProjectScripts] = useState<DbProjectScriptEntry[]>([]);

  const refreshProjectScripts = useCallback(async () => {
    if (!window.ide?.listProjectConfigDir) return;
    try {
      const connDirs = await window.ide.listProjectConfigDir(QUERIES_DIR);
      const found: DbProjectScriptEntry[] = [];
      for (const connDir of connDirs) {
        if (!connDir.isDirectory) continue;
        const scopes = await window.ide.listProjectConfigDir(`${QUERIES_DIR}/${connDir.name}`);
        for (const scope of scopes) {
          if (!scope.isDirectory) continue;
          const files = await window.ide.listProjectConfigDir(
            `${QUERIES_DIR}/${connDir.name}/${scope.name}`,
          );
          for (const f of files) {
            if (f.isDirectory || !isQueryScriptName(f.name)) continue;
            found.push({
              scriptPath: `${QUERIES_DIR}/${connDir.name}/${scope.name}/${f.name}`,
              fileName: f.name,
              title: scriptTitleFromFileName(f.name),
              connectionId: connDir.name,
              scope: scope.name,
            });
          }
        }
      }
      // 按连接、再按文件名排：目录的 readdir 顺序不可依赖，而列表每次刷新都换序会让人眼花
      found.sort(
        (a, b) =>
          a.connectionId.localeCompare(b.connectionId) || a.fileName.localeCompare(b.fileName),
      );
      setProjectScripts(found);
    } catch {
      // 读不到就是空列表 —— 面板底部少一块，不该影响整个面板
      setProjectScripts([]);
    }
  }, []);

  // 判断某个路径是否处于“放弃修改抑制期”（防止 Monaco onChange 触发 auto-save 误将已放弃的内容又写回磁盘）
  const isPathSuppressed = useCallback((path: string): boolean => {
    if (!path) return false;
    const now = Date.now();
    for (const [suppressedPath, until] of suppressAutoSaveUntilRef.current.entries()) {
      if (now >= until) continue;
      // 虚拟标签（db:// / git-head:）只认精确相等：否则表名恰好与某个被放弃文件的裸名相同时，
      // 会把「刚放弃修改」的抑制态误加到 db 标签上，静默吞掉它的脏标记
      if (isSameFileByPath(path, suppressedPath)) {
        return true;
      }
    }
    return false;
  }, []);

  /**
   * 放弃更改（还原到 HEAD）。
   *
   * **这是全应用放弃修改的唯一收口点**：Git 面板的行内按钮与右键菜单、文件树的「放弃更改」、
   * 编辑器的 diff 工具条与单块放弃、命令面板的 Discard All，最终都落到这里。
   * 未提交的修改没有第二份，放弃了就找不回来 —— 因此确认放在这一层，
   * 而不是散在各个入口（散着放必然会漏，早前「放弃单块更改」就是这么漏掉的）。
   */
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

    const discardDetails = isAll
      ? [{ label: '范围', value: '工作区中全部未提交的修改' }]
      : [
          { label: '范围', value: `${pathsToDiscard.length} 个文件` },
          ...pathsToDiscard.slice(0, 8).map((p, i) => ({ label: i === 0 ? '文件' : '', value: p })),
          ...(pathsToDiscard.length > 8
            ? [{ label: '', value: `…另有 ${pathsToDiscard.length - 8} 个文件` }]
            : []),
        ];

    const discardOk = await confirm.confirm({
      title: isAll
        ? '放弃全部未提交修改'
        : pathsToDiscard.length > 1
          ? `放弃 ${pathsToDiscard.length} 个文件的修改`
          : '放弃更改',
      content: buildSqlConfirmMarkdown({
        intro: isAll
          ? '工作区中**所有未提交的修改**都会被还原到 HEAD，且**无法撤销**。'
          : '该文件未提交的修改会被还原到 HEAD，且**无法撤销**。',
        statements: [],
        notes: ['已暂存（git add）但尚未提交的改动也会一并还原。'],
      }),
      details: discardDetails,
      tone: 'danger',
      confirmLabel: '确认放弃',
    });
    if (discardOk === null) return;

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
          if (isSameFileByPath(k, normDp)) {
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
        return !cleanTargets.some((tp) => isSameFileByPath(e.path, tp));
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
      // 虚拟标签（草稿 / db:// / git-head:）没有磁盘内容可回读：
      // 一旦被卷进这里，下面的 readFile 必然失败，标签页会被静默关掉
      if (isVirtualPath(tab.path)) return false;
      if (isAll) return true;
      return pathsToDiscard.some((dp) => isSameFileByPath(tab.path, dp));
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
        description: `Git 本地更改(工作树) - ${diff.path}`,
        originalTitle: '最新提交 (HEAD)',
        modifiedTitle: '当前工作区 (未提交更改)',
      });
      if (diff.original === diff.modified) {
        showToast('Git 对比', '当前文件与最新提交 (HEAD) 无差异', 'info');
      }
    } else {
      showToast('获取差异失败', diff.detail || '无法对比该文件', 'warn');
    }
  };

  const handleAnnotateGitBlame = (path: string) => {
    if (annotatedBlamePath === path) {
      setAnnotatedBlamePath(null);
      showToast('Git 追溯 (Blame)', '已关闭代码追溯标注', 'info');
    } else {
      openFile(path);
      setAnnotatedBlamePath(path);
      showToast('Git 追溯 (Blame)', '已开启代码追溯标注栏', 'info');
    }
  };

  const handleShowCurrentRevision = async (path: string) => {
    const fileName = path.split(/[/\\]/).pop() || path;
    const res = await window.ide.gitShowFileAtRef('HEAD', path);
    if (res.ok && res.content != null) {
      const headVirtualPath = `git-head:${path}`;
      setTabs((prev) => {
        const existing = prev.find((t) => t.path === headVirtualPath);
        if (existing) {
          return prev.map((t) =>
            t.path === headVirtualPath ? { ...t, content: res.content! } : t,
          );
        }
        return [
          ...prev,
          {
            path: headVirtualPath,
            content: res.content!,
            language: languageFromPath(path),
            dirty: false,
            readOnly: true,
            title: `${fileName} (HEAD)`,
          },
        ];
      });
      setActivePath(headVirtualPath);
      showToast('Git 当前版本', `已载入 ${fileName} 的 HEAD 提交快照 (只读)`, 'info');
    } else {
      showToast('无法查看当前版本', res.detail || '版本库中未找到该文件', 'error');
    }
  };

  const lastBranchRef = useRef<string | null>(null);

  const reloadTabsOnBranchChange = useCallback(async () => {
    // 分支切换后，重新从磁盘载入未被用户手动标记修改（非 dirty）的打开标签页
    const currentTabs = tabsRef.current;
    if (!currentTabs.length) return;

    for (const tab of currentTabs) {
      if (tab.dirty) continue;
      // 虚拟标签（草稿 / db:// / git-head:）没有磁盘内容可回读，跳过以免无谓的读失败
      if (isVirtualPath(tab.path)) continue;

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

  // 自动为最近工程补充或刷新真实技术栈（优先读取磁盘配置文件）
  useEffect(() => {
    let cancelled = false;
    async function enrichTech() {
      const current = readRecentWorkspaces();
      let changed = false;
      const updated = await Promise.all(
        current.map(async (item) => {
          let tech = item.techStack;
          // 若未检测或之前误检测为默认 Git 或 通用，则尝试重新通过磁盘或启发式深度识别
          if (!tech || tech === 'Git' || tech === '通用') {
            if (item.kind !== 'ssh' && window.ide?.detectWorkspaceTech) {
              try {
                const detected = await window.ide.detectWorkspaceTech(item.path);
                if (detected) tech = detected;
              } catch {
                // ignore
              }
            }
            if (!tech || tech === 'Git') {
              const heuristic = heuristicDetectTech(item.name || '', item.path || '');
              if (heuristic && heuristic !== 'Git') {
                tech = heuristic;
              }
            }
            if (!tech || tech === 'Git') {
              tech = '通用';
            }
            if (tech && tech !== item.techStack) {
              changed = true;
              return { ...item, techStack: tech };
            }
          }
          return item;
        }),
      );
      if (!cancelled && changed) {
        setRecentWorkspaces(updated);
        writeRecentWorkspaces(updated);
      }
    }
    enrichTech();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (workspaceInfo.root) {
      const path = workspaceInfo.root;
      const name = path.split('/').filter(Boolean).pop() || path;
      let sshServer = '';
      if (workspaceInfo.kind === 'ssh' && workspaceInfo.label) {
        const match = workspaceInfo.label.match(/^ssh\s+([^:/]+)/);
        sshServer = match ? match[1] : workspaceInfo.label;
      }

      const detectAndSave = async () => {
        let tech: string | undefined = undefined;
        if (workspaceInfo.kind !== 'ssh' && window.ide?.detectWorkspaceTech) {
          try {
            tech = await window.ide.detectWorkspaceTech(path);
          } catch {
            // fallback
          }
        }
        if (!tech || tech === 'Git') {
          tech = heuristicDetectTech(name, path);
        }
        if (!tech || tech === 'Git') {
          tech = '通用';
        }

        let gitBranch: string | undefined = undefined;
        let uncommittedCount: number | undefined = undefined;
        if (workspaceInfo.kind !== 'ssh' && window.ide?.gitStatus) {
          try {
            const st = await window.ide.gitStatus();
            if (st && st.ok) {
              gitBranch = st.branch || undefined;
              uncommittedCount = st.entries?.length || 0;
            }
          } catch {
            // ignore
          }
        }

        setRecentWorkspaces((prev) => {
          const filtered = prev.filter((item) => item.path !== path);
          const newItem: RecentWorkspaceItem = {
            path,
            name,
            kind: workspaceInfo.kind,
            sshServer: sshServer || undefined,
            techStack: tech || undefined,
            gitBranch,
            uncommittedCount,
            lastOpenedAt: Date.now(),
          };
          const updated = [newItem, ...filtered].slice(0, 20);
          writeRecentWorkspaces(updated);
          return updated;
        });
      };

      detectAndSave();
    }
  }, [workspaceInfo]);

  const persistOpenFilesForRoot = useCallback((root: string | null | undefined) => {
    if (!root) return;
    const curPath = activePathRef.current;
    const curScroll = curPath ? fileCursorPositionsRef.current[curPath] : undefined;
    // 开着的 SQL 控制台（虚拟标签）单独存一份：它的内容不在磁盘文件里，
    // 而是各自挂在自己的脚本文件上，还原时要先知道「哪一页连着哪个连接 / 哪个库」
    const virtualTabs: VirtualTabState[] = tabsRef.current
      .filter((t) => t.path.startsWith('db://console/') && t.virtual?.scriptPath)
      .map((t) => ({
        path: t.path,
        language: t.language,
        title: t.title,
        scriptPath: t.virtual?.scriptPath,
        scriptTarget: t.virtual?.scriptTarget,
      }));
    saveWorkspaceOpenFiles(
      root,
      tabsRef.current.map((t) => t.path).filter((p) => !isVirtualPath(p)),
      activePathRef.current && !isVirtualPath(activePathRef.current)
        ? activePathRef.current
        : null,
      fileCursorPositionsRef.current,
      cursorLineRef.current,
      cursorColRef.current,
      curScroll?.scrollTop,
      curScroll?.scrollLeft,
      virtualTabs,
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
      // 只有虚拟标签（SQL 控制台）也算「有东西要还原」，不能因为 paths 为空就整页清空
      if (!saved || (saved.paths.length === 0 && (saved.virtualTabs?.length ?? 0) === 0)) {
        setTabs([]);
        setActivePath(null);
        return;
      }

      if (saved.cursorPositions) {
        fileCursorPositionsRef.current = { ...saved.cursorPositions };
      }
      if (saved.activePath && (saved.activeScrollTop != null || saved.activeLine != null)) {
        fileCursorPositionsRef.current[saved.activePath] = {
          ...fileCursorPositionsRef.current[saved.activePath],
          line: saved.activeLine ?? fileCursorPositionsRef.current[saved.activePath]?.line ?? 1,
          col: saved.activeCol ?? fileCursorPositionsRef.current[saved.activePath]?.col ?? 1,
          scrollTop: saved.activeScrollTop ?? fileCursorPositionsRef.current[saved.activePath]?.scrollTop,
          scrollLeft: saved.activeScrollLeft ?? fileCursorPositionsRef.current[saved.activePath]?.scrollLeft,
        };
      }

      const restored: OpenTab[] = [];
      for (const p of saved.paths) {
        try {
          // 防御性跳过虚拟路径：db:// / untitled: 不对应磁盘文件，pathExists 必然失败
          if (isVirtualPath(p)) continue;
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

      // 还原 SQL 控制台：脚本内容在读回来之前就是标签的内容（与保存时刻的最后一次编辑一致），
      // 结果集不还原 —— 它是那一刻数据库的快照，重新连上再跑一次才是可信的
      const consoleTabs: OpenTab[] = [];
      for (const v of saved.virtualTabs ?? []) {
        try {
          if (!v.scriptPath) continue;
          // 脚本存在用户主目录的项目配置里，不是工作区文件：走配置通道读，
          // 否则 SSH 工作区会去远端找这个文件（远端根本没有）
          const content = await window.ide.readProjectConfigFile(v.scriptPath);
          if (content === null) continue;
          const fileName = scriptFileNameFromTabPath(v.path);
          consoleTabs.push({
            path: v.path,
            content,
            language: v.language || 'db-console',
            dirty: false,
            title: v.title || scriptTitleFromFileName(fileName),
            readOnly: false,
            virtual: { scriptPath: v.scriptPath, scriptTarget: v.scriptTarget },
          });
        } catch {
          // 脚本文件被删掉了：这一页就没有内容可还原，跳过（不拿空脚本假装它还在）
        }
      }
      if (consoleTabs.length > 0) {
        setTabs((prev) => [...prev, ...consoleTabs]);
        if (!nextActive) {
          const lastConsole = consoleTabs[consoleTabs.length - 1].path;
          setActivePath(lastConsole);
          activePathRef.current = lastConsole;
        }
      } else {
        activePathRef.current = nextActive;
      }
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

        resetAiChatSession();
        setLayout((prev) => ({ ...prev, bottomPanelExpanded: false }));
        setTerminalKey((k) => k + 1);
        await restoreOpenFilesForRoot(info.root);
      } catch (err) {
        console.error(err);
      }
    },
    [workspaceInfo.kind, persistOpenFilesForRoot, restoreOpenFilesForRoot, resetAiChatSession],
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
              resetAiChatSession();
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
            resetAiChatSession();
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

  /** 从最近打开里移除一条：随时可以重新打开同一个目录加回来，不必打扰用户确认 */
  const handleRemoveRecentWorkspace = useCallback((path: string) => {
    setRecentWorkspaces((prev) => {
      const updated = prev.filter((item) => item.path !== path);
      writeRecentWorkspaces(updated);
      return updated;
    });
    clearWorkspaceOpenFiles(path);
  }, []);

  /**
   * 清空全部最近打开记录。
   *
   * 一次抹掉整份列表，重建只能靠一个个目录重新打开 —— 有确认的价值。
   * （单条移除见上：那条随时能加回来，不值得拦一道。）
   */
  const handleClearRecentWorkspaces = useCallback(async () => {
    const count = recentWorkspaces.length;
    if (count > 0) {
      const ok = await confirm.confirm({
        title: '清空最近打开记录',
        content: buildSqlConfirmMarkdown({
          intro: '全部最近打开记录都会被清除，且**无法撤销**。',
          statements: [],
          notes: [
            '只清空这份列表，**磁盘上的项目文件不受影响**；需要时重新打开目录即可。',
            '各项目记录的文件树展开状态与已打开文件列表会一并清除。',
          ],
        }),
        details: [{ label: '数量', value: `${count} 条记录` }],
        tone: 'danger',
        confirmLabel: '确认清空',
      });
      if (ok === null) return;
    }
    setRecentWorkspaces([]);
    try {
      localStorage.removeItem(RECENT_WORKSPACES_KEY);
    } catch {}
  }, [confirm, recentWorkspaces]);

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
    setFormatOnSave(s.formatOnSave === true);
    setLargeFileThresholdBytes(s.largeFileThresholdBytes ?? 2 * 1024 * 1024);
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
          void refreshProjectScripts();
        }
      });
    }
    return window.ide.onWorkspaceChanged((info) => {
      const prevRoot = workspaceRef.current;
      if (prevRoot && prevRoot !== info.root) {
        persistOpenFilesForRoot(prevRoot);
        resetAiChatSession();
      }
      setWorkspaceInfo(info);
      setWorkspace(info.root);
      setTerminalKey((k) => k + 1);
      // Collapse terminal panel — user opens it manually when needed
      setLayout((prev) => ({ ...prev, bottomPanelExpanded: false }));
      void restoreOpenFilesForRoot(info.root);
      // 项目脚本清单是按工作区哈希存的（配置目录不同），换项目必须重读
      void refreshProjectScripts();
    });
  }, [applySettings, persistOpenFilesForRoot, restoreOpenFilesForRoot, openTargetInCurrentWindow, resetAiChatSession, refreshProjectScripts]);

  // Remember open tabs for the current project (debounced).
  useEffect(() => {
    if (!workspace || skipOpenFilesPersistRef.current) return;
    if (openFilesPersistTimer.current) clearTimeout(openFilesPersistTimer.current);
    openFilesPersistTimer.current = setTimeout(() => {
      if (skipOpenFilesPersistRef.current) return;
      if (workspaceRef.current !== workspace) return;
      const curScroll = activePath ? fileCursorPositionsRef.current[activePath] : undefined;
      const virtualTabs: VirtualTabState[] = tabs
        .filter((t) => t.path.startsWith('db://console/') && t.virtual?.scriptPath)
        .map((t) => ({
          path: t.path,
          language: t.language,
          title: t.title,
          scriptPath: t.virtual?.scriptPath,
          scriptTarget: t.virtual?.scriptTarget,
        }));
      saveWorkspaceOpenFiles(
        workspace,
        tabs.map((t) => t.path).filter((p) => !isVirtualPath(p)),
        activePath && !isVirtualPath(activePath) ? activePath : null,
        fileCursorPositionsRef.current,
        cursorLineRef.current,
        cursorColRef.current,
        curScroll?.scrollTop,
        curScroll?.scrollLeft,
        virtualTabs,
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
  const [bottomMaximized, setBottomMaximized] = useState(false);
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
            if (isVirtualPath(t.path)) continue;
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
    // 全局支持「在集成终端中打开」(任意组件通过事件派发拉起对应路径终端)
    const handleOpenTerminalEvent = (e: Event) => {
      const detail = (e as CustomEvent)?.detail as { cwd?: string; initialCommand?: string; title?: string } | undefined;
      const cwd = detail?.cwd || workspaceRef.current || '';
      const targetDirName =
        cwd && cwd !== '.' ? cwd.split(/[/\\]/).filter(Boolean).pop() : undefined;
      setBottomTab('terminal');
      terminalNonce.current += 1;
      setTerminalOpenRequest({
        cwd,
        nonce: terminalNonce.current,
        initialCommand: detail?.initialCommand,
        terminalTitle: detail?.title || (targetDirName ? `终端: ${targetDirName}` : '终端'),
      });
      const next = { ...layoutRef.current, bottomPanelExpanded: true };
      setLayout(next);
      persistLayout(next);
    };
    // 全局支持「在终端中执行命令」(AI 对话代码块等一键快速运行)
    const handleRunInTerminalEvent = (e: Event) => {
      const detail = (e as CustomEvent)?.detail as { command?: string; cwd?: string } | undefined;
      if (!detail?.command?.trim()) return;
      const cwd = detail.cwd || workspaceRef.current || '';
      setBottomTab('terminal');
      terminalNonce.current += 1;
      setTerminalOpenRequest({
        cwd,
        nonce: terminalNonce.current,
        initialCommand: detail.command.trim() + '\n',
        terminalTitle: '运行命令',
      });
      const next = { ...layoutRef.current, bottomPanelExpanded: true };
      setLayout(next);
      persistLayout(next);
    };
    window.addEventListener('echoly:openTerminal', handleOpenTerminalEvent);
    window.addEventListener('echoly:runInTerminal', handleRunInTerminalEvent);

    return () => {
      if (fsDebounce) clearTimeout(fsDebounce);
      unlisten();
      unlistenFs?.();
      window.removeEventListener('echoly:refreshFileTree', handleCustomFsRefresh);
      window.removeEventListener('echoly:refreshTree', handleCustomFsRefresh);
      window.removeEventListener('echoly:openBottomTab', handleOpenBottomTab);
      window.removeEventListener('echoly:openTerminal', handleOpenTerminalEvent);
      window.removeEventListener('echoly:runInTerminal', handleRunInTerminalEvent);
      window.removeEventListener('echoly:startDebug', handleStartDebug);
      window.removeEventListener('echoly:stopDebug', handleStopDebug);
      window.removeEventListener('echoly:runFinished', handleStopDebug);
      window.removeEventListener('echoly:debugError', handleDebugError);
      window.removeEventListener('echoly:askAi', handleAskAi);
      window.removeEventListener('echoly:openFile', handleOpenFileEvent);
      window.removeEventListener('echoly:addRefToChat', handleAddRefToChat);
    };
  }, [persistLayout, showToast]);

  useEffect(() => {
    resolvedPathCache.current.clear();
    if (workspace && window.ide?.searchFiles) {
      void window.ide.searchFiles('', 1);
    }
  }, [workspace]);

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

    // 优先检查已解析的相对路径缓存（0ms 极速命中）
    if (resolvedPathCache.current.has(path)) {
      path = resolvedPathCache.current.get(path)!;
    } else if (resolvedPathCache.current.has(rawPath)) {
      path = resolvedPathCache.current.get(rawPath)!;
    }

    const normPath = path;
    const existingTab = tabsRef.current.find((t) => {
      const tp = t.path.replace(/\\/g, '/');
      if (tp === normPath) return true;
      // 虚拟路径与磁盘文件互不匹配：db:// 标签只能被同名 db:// 路径命中
      if (requiresExactPathMatch(tp) || requiresExactPathMatch(normPath)) return false;
      return tp.endsWith('/' + normPath) || normPath.endsWith('/' + tp);
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
      // 1. 优先使用快速定向文件解析器（毫秒级定向探测，避免全盘递归阻塞）
      let resolved = false;
      if (window.ide.resolveFilePath) {
        try {
          const resolvedPath = await window.ide.resolveFilePath(path);
          if (resolvedPath) {
            content = await window.ide.readFile(resolvedPath);
            resolvedPathCache.current.set(path, resolvedPath);
            resolvedPathCache.current.set(rawPath, resolvedPath);
            const fileName = path.split('/').pop() || path;
            resolvedPathCache.current.set(fileName, resolvedPath);
            path = resolvedPath;
            resolved = true;
          }
        } catch {
          // fall through
        }
      }

      // 2. 兜底尝试 searchFiles
      if (!resolved && window.ide.searchFiles) {
        const fileName = path.split('/').pop() || path;
        try {
          const hits = await window.ide.searchFiles(fileName, 5);
          const matched = hits.find(
            (h) => h.path === path || h.path.endsWith('/' + path) || h.path.endsWith('/' + fileName) || h.path.endsWith(fileName),
          );
          if (matched) {
            content = await window.ide.readFile(matched.path);
            resolvedPathCache.current.set(path, matched.path);
            resolvedPathCache.current.set(rawPath, matched.path);
            resolvedPathCache.current.set(fileName, matched.path);
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
    // 大文件防护：超过配置阈值（默认 2MB）时开启安全模式，使用纯文本轻量加载避免 AST 卡死
    const threshold = largeFileThresholdBytesRef.current || 2 * 1024 * 1024;
    const isLarge = content.length > threshold;
    setTabs((prev) => {
      if (prev.some((t) => t.path === path)) return prev;
      return [
        ...prev,
        {
          path,
          content,
          language: isLarge ? 'plaintext' : languageFromPath(path),
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
    resetAiChatSession();
    setTerminalKey((k) => k + 1);
  }

  const saveUntitledAs = useCallback(async (tab: OpenTab): Promise<boolean> => {
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
    if (!dest) return false;

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
          return false;
        }
      } catch {
        alert('当前无法写入工作区，请先打开文件夹');
        return false;
      }
    } else {
      alert('请先打开工作区后再保存未命名文件');
      return false;
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
    return true;
  }, []);

  const saveTab = useCallback(
    async (tabToSave: OpenTab): Promise<boolean> => {
      if (tabToSave.language === 'image' || tabToSave.previewUrl) return true;
      if (isUntitledPath(tabToSave.path)) {
        return await saveUntitledAs(tabToSave);
      }
      // 数据库内置视图不是磁盘文件，只能存在于标签页状态里
      if (isDbPath(tabToSave.path)) {
        setTabs((prev) => prev.map((t) => (t.path === tabToSave.path ? { ...t, dirty: false } : t)));
        return true;
      }
      await window.ide.writeFile(tabToSave.path, tabToSave.content);
      setTabs((prev) => prev.map((t) => (t.path === tabToSave.path ? { ...t, dirty: false } : t)));
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
      return true;
    },
    [saveUntitledAs],
  );

  const saveActive = useCallback(async (): Promise<void> => {
    const path = activePathRef.current;
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab || tab.language === 'image' || tab.previewUrl) return;

    if (formatOnSave && !tab.isLargeFile) {
      window.dispatchEvent(new CustomEvent('echoly:formatActiveEditor'));
      await new Promise((r) => setTimeout(r, 60));
    }

    const freshTab = tabsRef.current.find((t) => t.path === path) || tab;
    await saveTab(freshTab);
  }, [saveTab, formatOnSave]);

  const handleForceLoadLargeFile = useCallback((filePath: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.path === filePath
          ? { ...t, language: languageFromPath(filePath), isLargeFile: false }
          : t,
      ),
    );
  }, []);

  const handleFileMoved = useCallback((oldPath: string, newPath: string) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.path === oldPath) {
          return { ...t, path: newPath, language: languageFromPath(newPath) };
        }
        if (t.path.startsWith(oldPath + '/')) {
          const sub = t.path.slice(oldPath.length);
          const updated = `${newPath}${sub}`;
          return { ...t, path: updated, language: languageFromPath(updated) };
        }
        return t;
      }),
    );
    if (activePathRef.current === oldPath) {
      setActivePath(newPath);
    } else if (activePathRef.current?.startsWith(oldPath + '/')) {
      const sub = activePathRef.current.slice(oldPath.length);
      setActivePath(`${newPath}${sub}`);
    }
    setTreeRefreshKey((k) => k + 1);
    void window.ide.gitStatus().then((res) => {
      if (res.ok) setGitStatus(res);
    });
  }, []);

  useEffect(() => {
    const onTriggerSave = () => {
      void saveActive();
    };
    window.addEventListener('echoly:triggerSaveActive', onTriggerSave);
    return () => window.removeEventListener('echoly:triggerSaveActive', onTriggerSave);
  }, [saveActive]);

  const saveAsActive = useCallback(async (): Promise<void> => {
    const path = activePathRef.current;
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab || tab.language === 'image' || tab.previewUrl) return;
    if (isUntitledPath(tab.path)) {
      await saveUntitledAs(tab);
      return;
    }
    if (isDbPath(tab.path)) {
      // 数据库视图没有「另存为」语义
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
      } else if (!isDbPath(tab.path)) {
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

  /**
   * 从磁盘重读当前文件，丢弃编辑器里未保存的内容（命令面板 `revertFile`）。
   *
   * 这是唯一一处「没有二次确认也过得去」的破坏性操作：它丢的只是**内存里**的未保存编辑，
   * 磁盘上的文件一个字节没动，撤销回去也只是再改一遍，代价可控。
   * 真正会丢数据的「放弃更改（还原到 HEAD）」在 `handleDiscardPath` 里，那一处是强确认的。
   */
  const revertActiveFile = useCallback(async (): Promise<void> => {
    const path = activePathRef.current;
    if (!path || isUntitledPath(path) || isDbPath(path)) return;
    try {
      const diskContent = await window.ide.readFile(path);
      setTabs((prev) =>
        prev.map((t) => (t.path === path ? { ...t, content: diskContent, dirty: false } : t)),
      );
    } catch {
      // ignore
    }
  }, []);

  /**
   * 关闭工作区（命令面板 `closeWorkspace`）。
   *
   * 关闭前先拦一道：**有未保存的文件就问一声**。当前实现直接清空 tabs，
   * 未保存的编辑会无声消失（`persistOpenFilesForRoot` 只记路径，不记内容）。
   * 这是先前就存在的丢数据缺口，与本次「所有删除都要确认」的诉求同源，一并补上。
   */
  const closeCurrentWorkspace = useCallback(async (): Promise<void> => {
    const dirtyTabs = tabsRef.current.filter((t) => t.dirty && !isVirtualPath(t.path));
    if (dirtyTabs.length > 0) {
      const ok = await confirm.confirm({
        title: '关闭工作区',
        content: buildSqlConfirmMarkdown({
          intro: '关闭后**未保存的修改会丢失**，且**无法撤销**。',
          statements: [],
          notes: ['已保存到磁盘的内容不受影响，重新打开工作区即可继续。'],
        }),
        details: [
          { label: '未保存', value: `${dirtyTabs.length} 个文件` },
          ...dirtyTabs
            .slice(0, 8)
            .map((t, i) => ({ label: i === 0 ? '文件' : '', value: t.path })),
          ...(dirtyTabs.length > 8
            ? [{ label: '', value: `…另有 ${dirtyTabs.length - 8} 个文件` }]
            : []),
        ],
        tone: 'danger',
        confirmLabel: '仍然关闭',
      });
      if (ok === null) return;
    }
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
    resetAiChatSession();
    setTerminalKey((k) => k + 1);
  }, [workspaceInfo.kind, persistOpenFilesForRoot, resetAiChatSession, confirm]);

  // ── 未保存文件关闭确认弹窗逻辑 ──
  const [closeConfirmTab, setCloseConfirmTab] = useState<OpenTab | null>(null);
  const closeConfirmQueueRef = useRef<OpenTab[]>([]);

  const closeTabDirect = useCallback((path: string) => {
    setScmDiff((prev) => (prev?.path === path ? null : prev));
    setTabs((prev) => {
      const next = prev.filter((t) => t.path !== path);
      if (activePathRef.current === path) {
        const nextActive = next[next.length - 1]?.path ?? null;
        setActivePath(nextActive);
      }
      return next;
    });
  }, []);

  const requestCloseTab = useCallback(
    (path: string) => {
      const tab = tabsRef.current.find((t) => t.path === path);
      if (!tab) return;
      const isDirty =
        tab.dirty &&
        tab.language !== 'image' &&
        !tab.previewUrl &&
        !(isUntitledPath(tab.path) && !tab.content);
      if (isDirty) {
        setActivePath(path);
        closeConfirmQueueRef.current = [tab];
        setCloseConfirmTab(tab);
      } else {
        closeTabDirect(path);
      }
    },
    [closeTabDirect],
  );

  const requestCloseMultipleTabs = useCallback((pathsToClose: string[]) => {
    const currentTabs = tabsRef.current;
    const targets = currentTabs.filter((t) => pathsToClose.includes(t.path));
    const nonDirtyPaths = targets
      .filter(
        (t) =>
          !t.dirty ||
          t.language === 'image' ||
          t.previewUrl ||
          (isUntitledPath(t.path) && !t.content),
      )
      .map((t) => t.path);
    const dirtyTabs = targets.filter(
      (t) =>
        t.dirty &&
        t.language !== 'image' &&
        !t.previewUrl &&
        !(isUntitledPath(t.path) && !t.content),
    );

    if (nonDirtyPaths.length > 0) {
      setTabs((prev) => {
        const next = prev.filter((t) => !nonDirtyPaths.includes(t.path));
        if (activePathRef.current && nonDirtyPaths.includes(activePathRef.current)) {
          const nextActive = next[next.length - 1]?.path ?? null;
          setActivePath(nextActive);
        }
        return next;
      });
    }

    if (dirtyTabs.length > 0) {
      setActivePath(dirtyTabs[0].path);
      closeConfirmQueueRef.current = dirtyTabs;
      setCloseConfirmTab(dirtyTabs[0]);
    }
  }, []);

  const handleConfirmSave = useCallback(async () => {
    if (!closeConfirmTab) return;
    const currentTab = closeConfirmTab;
    const success = await saveTab(currentTab);
    if (!success) {
      return;
    }
    closeTabDirect(currentTab.path);

    const queue = closeConfirmQueueRef.current.filter((t) => t.path !== currentTab.path);
    closeConfirmQueueRef.current = queue;
    if (queue.length > 0) {
      setActivePath(queue[0].path);
      setCloseConfirmTab(queue[0]);
    } else {
      setCloseConfirmTab(null);
    }
  }, [closeConfirmTab, saveTab, closeTabDirect]);

  const handleConfirmDontSave = useCallback(() => {
    if (!closeConfirmTab) return;
    const currentTab = closeConfirmTab;
    closeTabDirect(currentTab.path);

    const queue = closeConfirmQueueRef.current.filter((t) => t.path !== currentTab.path);
    closeConfirmQueueRef.current = queue;
    if (queue.length > 0) {
      setActivePath(queue[0].path);
      setCloseConfirmTab(queue[0]);
    } else {
      setCloseConfirmTab(null);
    }
  }, [closeConfirmTab, closeTabDirect]);

  const handleConfirmCancel = useCallback(() => {
    closeConfirmQueueRef.current = [];
    setCloseConfirmTab(null);
  }, []);

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

  /**
   * 新建 / 复用一个 db:// 虚拟标签页（数据视图 / DDL / SQL 控制台），内容只存在于标签页状态中。
   * 虚拟标签与磁盘文件是两套独立的东西：绝不与真实文件标签合并，也不写盘。
   */
  const openVirtualTab = useCallback(
    (
      path: string,
      content: string,
      title: string,
      language: string = 'db-console',
      /** false 时保留标签页里已有的内容（切换标签页回流场景，避免覆盖用户改动） */
      replaceContent: boolean = true,
      /** 是否只读：DDL / 数据视图为 true（默认），SQL 控制台传 false 才能编辑 */
      readOnly: boolean = true,
      /** 虚拟标签的附属数据（SQL 控制台的脚本落盘路径与会话目标） */
      meta?: {
        scriptPath?: string;
        scriptTarget?: { connectionId: string; schemaName?: string };
        dbStructure?: { connectionId: string; schemaName?: string; tableName: string };
      },
    ) => {
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.path === path);
        if (idx >= 0) {
          if (!replaceContent) {
            // 已存在：切前台即可（但路径里仍可能带旧标题 / 旧的会话参数，顺手对齐）
            const same = { ...prev[idx], title, virtual: meta ?? prev[idx].virtual };
            if (
              prev[idx].title === same.title &&
              prev[idx].virtual === same.virtual
            ) {
              return prev;
            }
            const copy = [...prev];
            copy[idx] = same;
            return copy;
          }
          const copy = [...prev];
          // 内容在查看期间可能被用户改过（SQL 控制台），仅在明确要求替换时覆盖，且不改变 dirty
          copy[idx] = { ...copy[idx], content, title, language, readOnly, virtual: meta ?? copy[idx].virtual };
          return copy;
        }
        return [
          ...prev,
          { path, content, language, dirty: false, title, readOnly, virtual: meta },
        ];
      });
      setActivePath(path);
      activePathRef.current = path;
    },
    [],
  );

  /** 当前打开着的脚本相对路径：面板底部据此标出「已打开」 */
  const openScriptPaths = useMemo(
    () =>
      tabs
        .filter((t) => t.path.startsWith('db://console/') && t.virtual?.scriptPath)
        .map((t) => t.virtual!.scriptPath as string),
    [tabs],
  );

  /** 点开项目里的一个脚本：已开着就切前台，否则读回来新建一个控制台标签 */
  const openProjectScript = useCallback(
    async (script: DbProjectScriptEntry) => {
      const existing = tabsRef.current.find(
        (t) => t.virtual?.scriptPath === script.scriptPath,
      );
      if (existing) {
        setActivePath(existing.path);
        activePathRef.current = existing.path;
        return;
      }
      let content = '';
      try {
        content = (await window.ide.readProjectConfigFile(script.scriptPath)) ?? '';
      } catch (err: any) {
        showToast('打开脚本失败', err?.message || String(err), 'error');
        return;
      }
      // 目标连接不记得是谁了：脚本路径里的连接段就是连接 id，直接用它当会话目标。
      // （面板上不会显示连接名——`connectionLabel` 要连接列表才填得出来，本轮留空。）
      openVirtualTab(
        consoleTabPath(script.connectionId, script.fileName),
        content,
        script.title,
        'db-console',
        true,
        false,
        { scriptPath: script.scriptPath, scriptTarget: { connectionId: script.connectionId } },
      );
    },
    [openVirtualTab, showToast],
  );

  /** 删除一个脚本文件（不可撤销，所以先确认） */
  const deleteProjectScript = useCallback(
    async (script: DbProjectScriptEntry) => {
      const ok = await confirm.confirm({
        title: '删除查询脚本',
        content: buildSqlConfirmMarkdown({
          intro: '这个脚本文件会从磁盘上删除，且**无法撤销**。',
          statements: [],
        }),
        details: [
          { label: '名称', value: script.title },
          { label: '路径', value: script.scriptPath },
        ],
        tone: 'danger',
        confirmLabel: '确认删除',
      });
      if (ok === null) return;
      try {
        await window.ide.removeProjectConfigFile(script.scriptPath);
        // 标签还开着的话一并收掉：否则它继续显示着一段已经不存在的内容，
        // 之后的自动保存会把它又写回去，删除等于没删
        const tab = tabsRef.current.find((t) => t.virtual?.scriptPath === script.scriptPath);
        if (tab) closeTabDirect(tab.path);
        await refreshProjectScripts();
        showToast('已删除脚本', script.fileName, 'success');
      } catch (err: any) {
        showToast('删除脚本失败', err?.message || String(err), 'error');
      }
    },
    [closeTabDirect, refreshProjectScripts, showToast],
  );

  /**
   * 打开一个 SQL 控制台。
   *
   * 标签路径只有两段：**连接 + 脚本文件名**，不含库 ——
   * 库是「这条 SQL 打到哪里去」的执行目标，换它不该把用户手里的脚本挪个地方
   * （早前按「连接 × 库」另开标签，同一个脚本会分裂成两页各自演化）。
   *
   * 脚本一律落进连接的**项目段** `queries/<连接>/_project/`（见 `projectScriptPathFor`）：
   * 脚本属于项目，不属于某个库。早前落到 `queries/<连接>/<库>/` 时，
   * 「同一个脚本换到另一个库跑」会表现为文件搬家 —— 而这只是换个执行目标而已。
   *
   * 文件名在「该连接下已知的脚本名」里取第一个空位，于是新开的查询天然不重名，
   * 落盘后也各占一个文件。脚本**先落盘再开标签**：这样标签一出现就已有归属，
   * 用户随手关掉窗口也不会丢。
   */
  const openSqlConsole = useCallback(
    async (
      connId: string,
      schemaName: string | undefined,
      initialSql: string,
      title: string,
    ) => {
      const taken = new Set<string>();
      // 已在标签里的先占位，免得「磁盘上没有、但正开着」的名字被再次选中
      for (const t of tabsRef.current) {
        if (t.path.startsWith('db://console/')) taken.add(scriptFileNameFromTabPath(t.path));
      }
      // 再扫一遍该连接下**所有已落盘的脚本名**：只靠标签会漏掉「上次关掉但文件还在」的那些，
      // 选出同名文件就会把旧脚本覆盖掉。新老两种布局（`_project` 段与按库分段）都要扫到，
      // 否则老脚本的名字会被新脚本撞上。
      try {
        const connDirs = await window.ide.listProjectConfigDir(QUERIES_DIR);
        const connSeg = scriptDirFor(connId).split('/')[1];
        if (connDirs.some((d) => d.isDirectory && d.name === connSeg)) {
          const scopes = await window.ide.listProjectConfigDir(`${QUERIES_DIR}/${connSeg}`);
          for (const scope of scopes) {
            if (!scope.isDirectory) continue;
            const files = await window.ide.listProjectConfigDir(
              `${QUERIES_DIR}/${connSeg}/${scope.name}`,
            );
            for (const f of files) {
              if (!f.isDirectory && isQueryScriptName(f.name)) taken.add(f.name);
            }
          }
        }
      } catch {
        // 目录不存在是常态（该连接下还没建过脚本），按空目录处理
      }

      const fileName = nextScriptFileName(Array.from(taken));
      const tabPath = consoleTabPath(connId, fileName);
      const scriptPath = projectScriptPathFor(connId, fileName);

      // 落盘是「尽力而为」：配置目录写不进去时，控制台照样能开、能跑 SQL，
      // 只是这次的内容不会留下 —— 为此把整页操作挡下来是本末倒置。
      void window.ide
        .writeProjectConfigFile(scriptPath, initialSql)
        .then(() => refreshProjectScripts())
        .catch((err) => console.warn('[db] 保存查询脚本失败:', err));

      openVirtualTab(
        tabPath,
        initialSql,
        title || scriptTitleFromFileName(fileName),
        'db-console',
        true,
        false,
        { scriptPath, scriptTarget: { connectionId: connId, schemaName } },
      );
    },
    [openVirtualTab, refreshProjectScripts],
  );

  /**
   * 控制台里改了连接 / 库。
   *
   * **换库：只更新会话目标** —— 脚本文件、标签路径全都不动。「这条 SQL 打到哪里去」
   * 是执行目标，不是脚本的归属；早前换库会把文件从 `queries/<连接>/<旧库>/` 搬到
   * `queries/<连接>/<新库>/`，同一个脚本在磁盘上搬来搬去，而它本身一个字都没改。
   * 新脚本现在一律落在连接的 `_project` 段下，这个「不搬」的语义才是自洽的。
   *
   * 换连接：脚本确实得挪（新旧连接各有一份文件才找得回），落到新连接的**同一段**下 ——
   * 老脚本留在 `queries/<旧连接>/<库>/`，就搬进 `queries/<新连接>/<库>/`，
   * 而不是硬塞进 `_project`：那会让老脚本莫名其妙地换个目录，也可能与已有文件撞名。
   *
   * 顺序上是「先建新标签、再关旧的」：反过来的话，中间那一帧 activePath 指向一个不存在的标签，
   * 控制台会被卸载，整棵状态白重建一次。
   */
  const retargetConsole = useCallback(
    (
      oldPath: string,
      target: { connectionId: string; schemaName?: string },
      kind: 'connection' | 'schema',
    ) => {
      const tab = tabsRef.current.find((t) => t.path === oldPath);
      if (!tab) return;

      if (kind === 'schema') {
        const scriptPath = tab.virtual?.scriptPath;
        const nextVirtual = {
          scriptPath,
          scriptTarget: { connectionId: target.connectionId, schemaName: target.schemaName },
        };
        setTabs((prev) =>
          prev.map((t) => (t.path === oldPath ? { ...t, virtual: nextVirtual } : t)),
        );
        return;
      }

      // 换连接：把脚本搬到新连接的目录下，文件名与所属段都保持不变（用户认的是这个名字）
      const fileName = scriptFileNameFromTabPath(oldPath);
      const oldScriptPath = tab.virtual?.scriptPath;
      const parsed = oldScriptPath ? parseScriptRelPath(oldScriptPath) : null;
      const nextScriptPath = scriptPathFor(
        target.connectionId,
        parsed?.scope ?? PROJECT_SCRIPT_SCOPE,
        fileName,
      );
      const nextPath = consoleTabPath(target.connectionId, fileName);
      const nextVirtual = {
        scriptPath: nextScriptPath,
        scriptTarget: { connectionId: target.connectionId, schemaName: target.schemaName },
      };

      if (nextScriptPath !== oldScriptPath) {
        void window.ide
          .writeProjectConfigFile(nextScriptPath, tab.content)
          .then(() =>
            oldScriptPath ? window.ide.removeProjectConfigFile(oldScriptPath) : undefined,
          )
          .then(() => refreshProjectScripts())
          .catch((err: any) => console.warn('[db] 迁移查询脚本失败:', err));
      }

      if (nextPath === oldPath) {
        setTabs((prev) => prev.map((t) => (t.path === oldPath ? { ...t, virtual: nextVirtual } : t)));
        return;
      }
      openVirtualTab(nextPath, tab.content, tab.title ?? scriptTitleFromFileName(fileName), 'db-console', true, false, nextVirtual);
      closeTabDirect(oldPath);
    },
    [closeTabDirect, openVirtualTab, refreshProjectScripts],
  );

  /**
   * 表结构视图里把表改名了（`db://structure/*`）。
   *
   * 表名不只是一个显示文本，它是**标签路径、标签标题、虚拟标签里的表身份**三处的组成部分，
   * 因此改名是一次「换标签」而不是「刷新内容」：
   *
   * 1. 新路径已经在标签里 → 只关旧的，切到那一个（两张表页各自加载自己的结构）；
   * 2. 否则**复用同一个标签对象**换掉 path / title / virtual，而不是「先关旧再开新」——
   *    旧路径上还挂着一个 `<DbStructureView>`，先关会先触发一次「按旧表名取数」，
   *    必然报「表不存在」。就地改 key 让 React 直接把它换成新表的那一个。
   *
   * 树上的表清单也顺手刷新一次：否则左侧还挂着旧表名，点它又是一次「表不存在」。
   */
  const handleTableRenamed = useCallback(
    (oldPath: string, newTableName: string) => {
      const tab = tabsRef.current.find((t) => t.path === oldPath);
      const meta = tab?.virtual?.dbStructure;
      if (!tab || !meta) return;

      const schemaSeg = meta.schemaName ? `${encodeURIComponent(meta.schemaName)}/` : '';
      const nextPath = `db://structure/${meta.connectionId}/${schemaSeg}${encodeURIComponent(newTableName)}`;
      const nextVirtual = {
        dbStructure: {
          connectionId: meta.connectionId,
          schemaName: meta.schemaName,
          tableName: newTableName,
        },
      };

      if (nextPath !== oldPath) {
        const existing = tabsRef.current.find((t) => t.path === nextPath);
        if (existing) {
          // 目标表本来就开着：不要造出第二个标签，收掉旧的、切过去
          setTabs((prev) =>
            prev
              .filter((t) => t.path !== oldPath)
              .map((t) => (t.path === nextPath ? { ...t, virtual: nextVirtual } : t)),
          );
          setActivePath(nextPath);
          activePathRef.current = nextPath;
        } else {
          setTabs((prev) =>
            prev.map((t) =>
              t.path === oldPath
                ? { ...t, path: nextPath, title: `📜 ${newTableName}`, virtual: nextVirtual }
                : t,
            ),
          );
          setActivePath(nextPath);
          activePathRef.current = nextPath;
        }
      }

      // 树上的旧名字要立刻消失，否则用户点它会去查一张已经不存在的表
      window.dispatchEvent(new CustomEvent('echoly:refreshDbTree'));
    },
    [],
  );

  /**
   * 左侧树下发给表数据视图的筛选 / 排序请求。
   *
   * 「按此列排序」是在**树**上点的，要生效得让**编辑区**里那个数据视图重新查询 ——
   * 两个组件之间没有直接通路。这里用一个带 nonce 的请求对象中转：nonce 变化即「重新套用一次」，
   * 否则同一张表连续下发两次不同排序时，后一次会因为值相同而被 React 判为没变化。
   */
  const [dbViewRequest, setDbViewRequest] = useState<{
    path: string;
    view: DbTableViewState;
    nonce: number;
  } | null>(null);
  const dbViewNonceRef = useRef(0);

  const savePath = useCallback(async (path: string, content: string): Promise<void> => {
    if (isUntitledPath(path) || isDbPath(path)) return;
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
    // 路径匹配统一走 isSameFileByPath：磁盘路径保留前后缀追赶兜底，
    // 虚拟标签（草稿 / db:// / git-head:）只认精确相等——否则一次表结构或控制台的回流
    // 就可能顺着后缀匹配落到某个已打开的代码文件标签上。
    const matches = (target: string, candidate: string): boolean =>
      isSameFileByPath(target, candidate);

    // 内置虚拟标签（草稿 / db:// / git-head:）的内容只活在标签页状态里：
    // 只允许精确命中自己，既不标脏也不外发，从源头堵死任何写盘与跨标签回写
    if (requiresExactPathMatch(path)) {
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.path === path);
        if (idx < 0) return prev;
        const tab = prev[idx];
        const nextDirty = isUntitledPath(path) ? markDirty : tab.dirty;
        if (tab.content === content && tab.dirty === nextDirty) return prev;
        const copy = [...prev];
        copy[idx] = { ...tab, content, dirty: nextDirty };
        return copy;
      });
      // SQL 控制台例外：它的脚本要落盘（跟项目走）。虚拟标签的「不写盘」原则针对的是
      // 标签**自身**不对应磁盘文件，而控制台另外挂着一个明确的脚本文件，写它不算破例。
      const consoleTab = tabsRef.current.find((t) => t.path === path);
      const scriptPath = consoleTab?.virtual?.scriptPath;
      if (scriptPath) {
        const prevTimer = scriptTimers.current.get(scriptPath);
        if (prevTimer) clearTimeout(prevTimer);
        // 与自动保存同节奏地防抖：Monaco 每次按键都会回调，逐字写盘既费 IO 也无意义
        scriptTimers.current.set(
          scriptPath,
          setTimeout(() => {
            scriptTimers.current.delete(scriptPath);
            void window.ide
              .writeProjectConfigFile(scriptPath, content)
              // 新脚本是「先落盘再开标签」，一般不会走到这里；但路径换了段的迁移、
              // 以及首次写入失败后的重试都要靠这一刷把清单对齐
              .then(() => refreshProjectScripts())
              .catch((err: any) => console.warn('[db] 保存查询脚本失败:', err));
          }, 800),
        );
      }
      for (const [k, timer] of autoSaveTimers.current.entries()) {
        if (k === path) {
          clearTimeout(timer);
          autoSaveTimers.current.delete(k);
        }
      }
      return;
    }

    // 处于抑制期的路径（刚执行过放弃修改），严格拦截 Monaco 重绘产生的 onChange，保证 dirty=false 且绝不写盘
    if (isPathSuppressed(path)) {
      setTabs((prev) => {
        return prev.map((t) => (matches(path, t.path) ? { ...t, content, dirty: false } : t));
      });
      for (const [k, timer] of autoSaveTimers.current.entries()) {
        if (matches(path, k)) {
          clearTimeout(timer);
          autoSaveTimers.current.delete(k);
        }
      }
      return;
    }

    const currentTab = tabsRef.current.find((t) => matches(path, t.path));

    // 如果内容未曾改变且未标记为 dirty，直接忽略，避免空写盘
    if (currentTab && currentTab.content === content && !currentTab.dirty && !markDirty) {
      return;
    }

    setTabs((prev) => {
      return prev.map((t) => (matches(path, t.path) ? { ...t, content, dirty: markDirty } : t));
    });

    if (!markDirty) {
      for (const [k, timer] of autoSaveTimers.current.entries()) {
        if (matches(path, k)) {
          clearTimeout(timer);
          autoSaveTimers.current.delete(k);
        }
      }
      return;
    }

    // 只有确实命中了某个真实标签才需要排自动保存：没有匹配（例如已被关闭）时排进去的
    // 定时器永远无人消费，还会在 800ms 后凭空写一次盘
    if (!currentTab || isVirtualPath(path)) return;

    if (isUntitledPath(path) || !autoSaveRef.current) return;

    // 定时器键取自调用方传入的原始路径，比较时同样尊重 exactOnly 语义
    const timerMatches = (key: string): boolean => matches(path, key);
    for (const [k, timer] of autoSaveTimers.current.entries()) {
      if (timerMatches(k)) {
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
      // 控制台脚本的待写定时器同样要清掉，否则退出前最后一笔编辑会落在一个已经没人收拾的
      // 回调里（更糟的是它写的是已经切走的那个工作区的相对路径）
      for (const timer of scriptTimers.current.values()) clearTimeout(timer);
      scriptTimers.current.clear();
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
        requestCloseTab(path);
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
    // Cursor 交互效果：AI 作答修改文件时直接修改并保存对应文件
    // 同步更新编辑器已打开标签页，内容更新并标记为已保存 (dirty: false)
    setTabs((prev) =>
      prev.map((t) =>
        t.path === event.diff.path ? { ...t, content: event.diff.modified, dirty: false } : t,
      ),
    );
    setTreeRefreshKey((k) => k + 1);
    window.dispatchEvent(new CustomEvent('echoly:refreshFileTree'));
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
    const diff = diffs.find((d) => d.id === id);
    await window.ide.rejectDiff(id);
    setDiffs((prev) => prev.filter((d) => d.id !== id));
    if (activeDiffId === id) setActiveDiffId(null);
    if (diff) {
      // 拒绝/撤销修改：恢复原始内容并更新标签页与文件树
      setTabs((prev) =>
        prev.map((t) =>
          t.path === diff.path ? { ...t, content: diff.original, dirty: false } : t,
        ),
      );
      setTreeRefreshKey((k) => k + 1);
      window.dispatchEvent(new CustomEvent('echoly:refreshFileTree'));
    }
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

  async function rejectAll(): Promise<void> {
    await (window.ide.rejectAllDiffs?.() ??
      Promise.all(diffs.map((d) => window.ide.rejectDiff(d.id))));
    for (const diff of diffs) {
      setTabs((prev) =>
        prev.map((t) =>
          t.path === diff.path ? { ...t, content: diff.original, dirty: false } : t,
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
      // Cmd+W / Ctrl+W 关闭当前编辑器标签
      if (ctrl && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'w') {
        const path = activePathRef.current;
        if (path) {
          e.preventDefault();
          requestCloseTab(path);
          return;
        }
      }
      // Cmd+F: 编辑区与终端区域搜索唤起并自动定位光标
      if (ctrl && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        const el = document.activeElement as HTMLElement | null;
        const inTerminal = !!(
          el &&
          (el.classList?.contains('xterm-helper-textarea') ||
            !!el.closest?.('.xterm') ||
            !!el.closest?.('.terminal-panel') ||
            !!el.closest?.('.terminal-sessions'))
        );
        const inMonaco = !!(el && typeof el.closest === 'function' && el.closest('.monaco-editor'));
        const isTerminalActive = (() => {
          if (inTerminal) return true;
          if (inMonaco) return false;
          const bottomPanel = document.querySelector<HTMLElement>('.bottom-panel');
          const isBottomVisible = bottomPanel && getComputedStyle(bottomPanel).display !== 'none';
          const isTerminalTabActive = !!document.querySelector('.bottom-tab-btn.active')?.textContent?.includes('终端');
          return !!(isBottomVisible && isTerminalTabActive);
        })();

        if (isTerminalActive) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('echoly:focusTerminalSearch'));
          return;
        }

        e.preventDefault();
        window.dispatchEvent(new CustomEvent('echoly:focusEditorFind'));
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
      // Cmd+D -> 显示差异 (Show Diff)
      if (ctrl && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'd') {
        const targetP = activePath && !activePath.startsWith('untitled:') ? activePath : null;
        if (targetP) {
          e.preventDefault();
          void handlePreviewGitDiff(targetP);
          return;
        }
      }
      // Alt+Cmd+Z -> 回滚修改 (Rollback)
      if (ctrl && e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
        const targetP = activePath && !activePath.startsWith('untitled:') ? activePath : null;
        if (targetP) {
          e.preventDefault();
          setRollbackModalPath(targetP);
          return;
        }
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
            activePath={activePath || undefined}
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
                <button
                  type="button"
                  className={leftPanel === 'database' ? 'active' : ''}
                  onClick={() => setLeftPanel('database')}
                  title="轻量数据库"
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
                    <ellipse cx="12" cy="5" rx="9" ry="3" />
                    <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
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
                      justifyContent: 'space-between',
                      cursor: 'pointer',
                    }}
                    onClick={() => setWorkspaceExpanded((v) => !v)}
                  >
                    <div
                      className="panel-header-title"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                        minWidth: 0,
                        flex: 1,
                        marginRight: 8,
                      }}
                    >
                      <PanelChevron expanded={workspaceExpanded} size={12} />
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
                        onPreviewGitDiff={(p) => void handlePreviewGitDiff(p)}
                        onAnnotateGitBlame={(p) => void handleAnnotateGitBlame(p)}
                        onCompareWithRevision={(p) => setCompareRevisionModalPath(p)}
                        onCompareWithBranchOrTag={(p) => setCompareBranchOrTagModalPath(p)}
                        onShowCurrentRevision={(p) => void handleShowCurrentRevision(p)}
                        onRollbackPath={(p) => setRollbackModalPath(p)}
                        onFileMoved={handleFileMoved}
                        onShowToast={showToast}
                        onOpenFile={(p) => void openFile(p)}
                        onOpenTerminal={(cwd) => {
                          const targetDirName =
                            cwd && cwd !== '.' ? cwd.split(/[/\\]/).filter(Boolean).pop() : undefined;
                          setBottomTab('terminal');
                          terminalNonce.current += 1;
                          setTerminalOpenRequest({
                            cwd: cwd || workspace || '',
                            nonce: terminalNonce.current,
                            terminalTitle: targetDirName ? `终端: ${targetDirName}` : '终端',
                          });
                          const next = { ...layoutRef.current, bottomPanelExpanded: true };
                          setLayout(next);
                          persistLayout(next);
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
                  onCompareWithRevision={(p) => setCompareRevisionModalPath(p)}
                  onCompareWithBranchOrTag={(p) => setCompareBranchOrTagModalPath(p)}
                  onAnnotateGitBlame={(p) => void handleAnnotateGitBlame(p)}
                  onRevealInExplorer={(p) => {
                    setLeftPanel('explorer');
                    setActivePath(p);
                  }}
                  onBranchSwitched={handleBranchSwitchSync}
                  onOpenCloneModal={() => setCloneOpen(true)}
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
              <div
                className="database-panel-wrapper"
                style={{
                  display: leftPanel === 'database' ? 'flex' : 'none',
                  minHeight: 0,
                  minWidth: 0,
                  overflow: 'hidden',
                  height: '100%',
                  width: '100%',
                }}
              >
                <DatabasePanel
                  onOpenTableData={(connId, tableName, schemaName, view) => {
                    const schemaSeg = schemaName ? `${encodeURIComponent(schemaName)}/` : '';
                    const tabPath = `db://data/${connId}/${schemaSeg}${encodeURIComponent(tableName)}`;
                    // 走统一的虚拟标签入口：已存在则切前台（内容交给 DbTableDataView 自己重载），不存在才新建
                    openVirtualTab(tabPath, '', `📊 ${tableName}`, 'db-data', false);
                    // 带筛选 / 排序打开时下发请求：数据视图挂载后按 nonce 套用并立刻按新条件查询。
                    // 放在 openVirtualTab 之后 —— 先让标签存在，再变更请求，避免视图拿到一个还没打开的路径。
                    if (view) {
                      dbViewNonceRef.current += 1;
                      setDbViewRequest({ path: tabPath, view, nonce: dbViewNonceRef.current });
                    }
                  }}
                  onOpenTableStructure={(connId, tableName, schemaName) => {
                    const schemaSeg = schemaName ? `${encodeURIComponent(schemaName)}/` : '';
                    const tabPath = `db://structure/${connId}/${schemaSeg}${encodeURIComponent(tableName)}`;
                    // DDL 正文由 DbStructureView 自己去拉（DDL / 列清单两个视图都要用到，
                    // 且「应用」之后还得重新拉一次），这里不预先取。
                    openVirtualTab(tabPath, '', `📜 ${tableName}`, 'db-structure', false, true, {
                      dbStructure: { connectionId: connId, schemaName, tableName },
                    });
                  }}
                  onOpenSqlConsole={openSqlConsole}
                  scripts={projectScripts}
                  onOpenScript={(s) => void openProjectScript(s)}
                  onDeleteScript={(s) => void deleteProjectScript(s)}
                  openScriptPaths={openScriptPaths}
                  onShowToast={showToast}
                />
              </div>
              <div
                className="agent-task-panel-wrapper"
                style={{
                  display: leftPanel === 'agent-tasks' ? 'flex' : 'none',
                  minHeight: 0,
                  minWidth: 0,
                  overflow: 'hidden',
                  height: '100%',
                  width: '100%',
                }}
              >
                <AgentTaskPanel
                  workspaceRoot={workspace}
                  onOpenFile={(p) => void openFile(p)}
                  onShowToast={showToast}
                  onSendToChat={(prompt) => {
                    if (layout.chatPanelExpanded === false) {
                      const next = { ...layout, chatPanelExpanded: true };
                      setLayout(next);
                      persistLayout(next);
                    }
                    setTimeout(() => {
                      chatRef.current?.askQuestion(prompt, true);
                    }, 100);
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
              requestCloseTab(path);
            }}
            onCloseOthers={(targetPath) => {
              setScmDiff(null);
              const paths = tabs.filter((t) => t.path !== targetPath).map((t) => t.path);
              requestCloseMultipleTabs(paths);
            }}
            onCloseLeft={(targetPath) => {
              setScmDiff(null);
              const idx = tabs.findIndex((t) => t.path === targetPath);
              if (idx > 0) {
                const paths = tabs.slice(0, idx).map((t) => t.path);
                requestCloseMultipleTabs(paths);
              }
            }}
            onCloseRight={(targetPath) => {
              setScmDiff(null);
              const idx = tabs.findIndex((t) => t.path === targetPath);
              if (idx >= 0) {
                const paths = tabs.slice(idx + 1).map((t) => t.path);
                requestCloseMultipleTabs(paths);
              }
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
              const paths = tabs.map((t) => t.path);
              requestCloseMultipleTabs(paths);
            }}
            onNewUntitled={createUntitledTab}
            onOpenVirtualTab={openVirtualTab}
            onCloseVirtualTab={closeTabDirect}
            onTableRenamed={handleTableRenamed}
            onRetargetConsole={retargetConsole}
            onOpenConsoleForTable={openSqlConsole}
            dbViewRequest={dbViewRequest}
            onChangeContent={onChangeContent}
            onSelectionChange={setEditorSelection}
            onCursorChange={(line, col) => {
              setCursorLine(line);
              setCursorCol(col);
              cursorLineRef.current = line;
              cursorColRef.current = col;
              if (activePathRef.current) {
                const cur = fileCursorPositionsRef.current[activePathRef.current];
                fileCursorPositionsRef.current[activePathRef.current] = {
                  ...cur,
                  line,
                  col,
                };
              }
            }}
            onScrollChange={(path, scrollTop, scrollLeft) => {
              if (path) {
                const cur = fileCursorPositionsRef.current[path] || { line: 1, col: 1 };
                fileCursorPositionsRef.current[path] = { ...cur, scrollTop, scrollLeft };
              }
            }}
            initialCursorPositions={fileCursorPositionsRef.current}
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
            onViewFileHistory={(p) => void handleViewFileHistory(p)}
            onCompareWithRevision={(p) => setCompareRevisionModalPath(p)}
            onCompareWithBranchOrTag={(p) => setCompareBranchOrTagModalPath(p)}
            onAnnotateGitBlame={(p) => void handleAnnotateGitBlame(p)}
            showBlameAnnotation={annotatedBlamePath === activePath}
            onCloseBlameAnnotation={() => setAnnotatedBlamePath(null)}
            onPreviewDiff={(diff) => {
              setActiveDiffId(null);
              setScmDiff(diff);
            }}
            onRefreshGitStatus={async () => {
              const res = await window.ide.gitStatus();
              if (res.ok) setGitStatus(res);
            }}
            revealTarget={revealTarget}
            onRevealTargetConsumed={handleRevealTargetConsumed}
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
            confirm={confirm}
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
            formatOnSave={formatOnSave}
            onForceLoadLargeFile={handleForceLoadLargeFile}
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
                  height:
                    layout.bottomPanelExpanded === true
                      ? bottomMaximized
                        ? '72vh'
                        : layout.bottomHeight
                      : 0,
                  display: layout.bottomPanelExpanded === true ? 'flex' : 'none',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  background: 'var(--bg-bottom, #141414)',
                }}
              >
                {/* 底部面板模式切换工具栏 */}
                <div
                  style={{
                    height: 32,
                    boxSizing: 'border-box',
                    background: 'var(--bg-bottom, #141414)',
                    borderBottom: '1px solid var(--border)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0 8px',
                    flexShrink: 0,
                    userSelect: 'none',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, height: '100%' }}>
                    <button
                      type="button"
                      className={`bottom-tab-btn ${bottomTab === 'terminal' ? 'active' : ''}`}
                      onClick={() => setBottomTab('terminal')}
                      title="切换至终端面板"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="4 17 10 11 4 5" />
                        <line x1="12" y1="19" x2="20" y2="19" />
                      </svg>
                      <span>终端 (Terminal)</span>
                    </button>
                    <button
                      type="button"
                      className={`bottom-tab-btn ${bottomTab === 'debug' ? 'active' : ''}`}
                      onClick={() => setBottomTab('debug')}
                      title="切换至调试工作台"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m8 2 1.88 1.88" />
                        <path d="M14.12 3.88 16 2" />
                        <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
                        <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
                        <path d="M12 20v-9" />
                        <path d="M6.53 9C4.6 8.8 3 7.1 3 5" />
                        <path d="M6 13H2" />
                        <path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
                        <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" />
                        <path d="M22 13h-4" />
                        <path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />
                      </svg>
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
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                      <span>问题 (Problems)</span>
                      {problemsCount > 0 && (
                        <span className="problems-tab-badge">
                          {problemsCount}
                        </span>
                      )}
                    </button>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {bottomTab === 'problems' && (
                      <span style={{ fontSize: 11, color: 'var(--muted)', marginRight: 4 }}>
                        {problemsCount > 0 ? `共 ${problemsCount} 处诊断` : '未发现代码问题'}
                      </span>
                    )}
                    {bottomTab === 'terminal' && (
                      <span style={{ fontSize: 11, color: 'var(--muted)', marginRight: 4 }}>
                        {terminalKind === 'ssh' ? '远程 SSH 终端' : '本地终端'}
                      </span>
                    )}
                    {bottomTab === 'debug' && (
                      <span
                        style={{
                          fontSize: 11,
                          color: isDebugging
                            ? debugState === 'paused'
                              ? '#facc15'
                              : '#22c55e'
                            : 'var(--muted)',
                          marginRight: 4,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                        }}
                      >
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            background: isDebugging
                              ? debugState === 'paused'
                                ? '#facc15'
                                : '#22c55e'
                              : 'var(--muted)',
                          }}
                        />
                        {isDebugging
                          ? debugState === 'paused'
                            ? '调试已暂停'
                            : '调试进行中'
                          : '未在调试 (就绪)'}
                      </span>
                    )}

                    <button
                      type="button"
                      className="panel-action-btn"
                      onClick={() => {
                        setBottomMaximized((v) => !v);
                        window.dispatchEvent(
                          new CustomEvent('echoly:scrollTerminalBottom', {
                            detail: {},
                          }),
                        );
                      }}
                      title={bottomMaximized ? '还原面板高度' : '最大化面板高度'}
                    >
                      {bottomMaximized ? (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="4 14 10 14 10 20" />
                          <polyline points="20 10 14 10 14 4" />
                          <line x1="14" y1="10" x2="21" y2="3" />
                          <line x1="3" y1="21" x2="10" y2="14" />
                        </svg>
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="15 3 21 3 21 9" />
                          <polyline points="9 21 3 21 3 15" />
                          <line x1="21" y1="3" x2="14" y2="10" />
                          <line x1="3" y1="21" x2="10" y2="14" />
                        </svg>
                      )}
                    </button>

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
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                </div>

                <div style={{ flex: 1, overflow: 'hidden', display: bottomTab === 'terminal' ? 'flex' : 'none' }}>
                  <TerminalPanel
                    key={`${terminalKind}-${terminalKey}`}
                    terminalKind={terminalKind}
                    uiTheme={uiTheme}
                    openRequest={terminalOpenRequest}
                    visible={layout.bottomPanelExpanded === true && bottomTab === 'terminal'}
                    scrollback={terminalScrollback}
                    maximized={bottomMaximized}
                    onRequestCloseConfirm={layout.bottomPanelExpanded === true && bottomTab === 'terminal'}
                    onCollapse={() => {
                      const next = { ...layout, bottomPanelExpanded: false };
                      setLayout(next);
                      persistLayout(next);
                    }}
                    onOpenFile={(p, l, c) => void openFile(p, l, c)}
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
                  key={`${workspaceInfo.kind}-${workspace || 'none'}-${chatResetKey}`}
                  ref={chatRef}
                  workspace={workspace}
                  workspaceInfo={workspaceInfo}
                  openFiles={[
                    ...tabs.filter((t) => t.path === activePath),
                    ...tabs.filter((t) => t.path !== activePath),
                  ]
                    .filter(
                      (t) =>
                        t.language !== 'image' &&
                        !t.previewUrl &&
                        !isUntitledPath(t.path) &&
                        !isDbPath(t.path),
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
                  onRejectAllDiffs={() => void rejectAll()}
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
                  recentWorkspaces={recentWorkspaces}
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
            resetAiChatSession();
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

      <CompareWithRevisionModal
        open={!!compareRevisionModalPath}
        filePath={compareRevisionModalPath}
        onClose={() => setCompareRevisionModalPath(null)}
        onPreviewDiff={async (diff) => {
          let modified = diff.modified;
          if (!modified && diff.path) {
            const openTab = tabs.find((t) => t.path === diff.path || t.path.endsWith('/' + diff.path));
            if (openTab && openTab.content) {
              modified = openTab.content;
            } else {
              try {
                modified = await window.ide.readFile(diff.path);
              } catch {}
            }
          }
          setActiveDiffId(null);
          setScmDiff({
            ...diff,
            modified,
          });
        }}
      />

      <CompareWithBranchOrTagModal
        open={!!compareBranchOrTagModalPath}
        filePath={compareBranchOrTagModalPath}
        onClose={() => setCompareBranchOrTagModalPath(null)}
        onPreviewDiff={async (diff) => {
          let modified = diff.modified;
          if (!modified && diff.path) {
            const openTab = tabs.find((t) => t.path === diff.path || t.path.endsWith('/' + diff.path));
            if (openTab && openTab.content) {
              modified = openTab.content;
            } else {
              try {
                modified = await window.ide.readFile(diff.path);
              } catch {}
            }
          }
          setActiveDiffId(null);
          setScmDiff({
            ...diff,
            modified,
          });
        }}
      />

      <RollbackFileModal
        open={!!rollbackModalPath}
        filePath={rollbackModalPath}
        onClose={() => setRollbackModalPath(null)}
        onConfirm={async (path) => {
          await handleDiscardPath(path);
        }}
      />

      <UnsavedChangesModal
        open={!!closeConfirmTab}
        tab={closeConfirmTab}
        onSave={handleConfirmSave}
        onDontSave={handleConfirmDontSave}
        onCancel={handleConfirmCancel}
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
        language={
          (() => {
            const tab = tabs.find((t) => t.path === activePath);
            if (tab?.language) return tab.language;
            if (activePath && !isVirtualPath(activePath)) return languageFromPath(activePath);
            return 'plaintext';
          })()
        }
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
          // 虚拟标签（db:// / untitled:) 没有磁盘 EOL 语义，改行尾毫无意义且会误标脏
          if (!activePath || isVirtualPath(activePath)) return;
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
          if (!activePath || isDbPath(activePath)) return;
          setTabs((prev) =>
            prev.map((t) => (isSameFileByPath(t.path, activePath) ? { ...t, language: lang } : t)),
          );
          window.dispatchEvent(
            new CustomEvent('echoly:changeEditorLanguage', {
              detail: { path: activePath, language: lang },
            }),
          );
          showToast(`语言模式已切换为 ${lang}`, undefined, 'info');
        }}
        onOpenAbout={() => {
          setSettingsInitialTab('about');
          setSettingsOpen(true);
        }}
        onShowToast={showToast}
      />

      {/* Bottom-Left Drawer Toast Notifications Overlay */}
      {toasts.length > 0 && (
        <div
          style={{
            position: 'fixed',
            bottom: 28,
            left: 24,
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
                className="toast-drawer-item"
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
                  background: 'var(--bg-elevated, #1e1e1e)',
                  border: '1px solid var(--border-strong, rgba(255, 255, 255, 0.12))',
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
          .filter(
            (t) =>
              t.language !== 'image' && !t.previewUrl && !isUntitledPath(t.path) && !isDbPath(t.path),
          )
          .map((t) => ({ path: t.path, content: t.content }))}
        onOpenFile={(path, line) => openFile(path, line)}
      />
      <GlobalTooltip delay={hoverDelay} />
      {confirm.modal}
    </div>
  );
}
