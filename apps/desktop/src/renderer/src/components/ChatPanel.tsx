import React, { useCallback, useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import type {
  AgentEvent,
  AgentMode,
  AgentRunStatus,
  ChatAttachment,
  ChatSession,
  ChatSessionMessage,
  ConfirmRequest,
  ModelProfile,
  PermissionMode,
  PlanProposal,
  PendingDiff,
  WorkspaceInfo,
} from '@deepseek-ide/shared';
import { PERMISSION_MODE_LABELS } from '@deepseek-ide/shared';
import { buildSessionWorkspaceMeta, uid } from '../utils';
import { buildAgentHistory } from '../chatHistory';
import { MarkdownMessage } from './MarkdownMessage';
import { PlanPanel } from './PlanPanel';
import { SessionModal } from './SessionModal';
import { ThinkingBlock } from './ThinkingBlock';
import { WorkedForGroup } from './chat/WorkedForGroup';
import { CollapsibleUserContent } from './chat/CollapsibleUserContent';
import { InputCodeRefOverlay, type InputCodeRefOverlayHandle } from './chat/InputCodeRefOverlay';
import { FileLanguageIcon } from './chat/CodeRefPill';

interface MentionItem {
  id: string;
  type: 'special' | 'file';
  title: string;
  desc: string;
  path?: string;
  insertText: string;
}

interface Props {
  workspace: string | null;
  workspaceInfo?: WorkspaceInfo;
  openFiles: Array<{ path: string; content: string }>;
  selection?: string;
  cursor?: { path: string; line: number; column: number };
  onPendingDiff: (event: Extract<AgentEvent, { type: 'pending_diff' }>) => void;
  sessionMessages: ChatSessionMessage[];
  onMessagesChange: (messages: ChatSessionMessage[]) => void;
  onSessionChange?: (sessionId: string) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  contextWindowTokens: number;
  diffs?: PendingDiff[];
  onAcceptAllDiffs?: () => void;
  onRejectAllDiffs?: () => void;
  onSelectDiff?: (id: string) => void;
  onOpenFile?: (path: string, line?: number, endLine?: number) => void;
  onOpenSettings?: () => void;
  onSwitchWorkspace?: (path: string) => void;
  models?: ModelProfile[];
  activeModelId?: string;
  onActiveModelChange?: (modelId: string) => void;
}

export type ChatPanelHandle = {
  insertPath: (path: string) => void;
  startFreshWithPath: (path: string) => void;
  clearAndNewSession: () => void;
  askQuestion: (prompt: string, autoSubmit?: boolean) => void;
  focusInput: () => void;
};

export interface SessionTab {
  id: string;
  title: string;
  customTitle?: boolean;
  messages: ChatSessionMessage[];
  attachments?: ChatAttachment[];
  mode: AgentMode;
  modelId?: string;
  input: string;
  status: AgentRunStatus;
  runId: string | null;
  streaming: string;
  thinkingStreaming?: string;
  confirm: ConfirmRequest | null;
  plan: PlanProposal | null;
  pendingPlanContext: PlanProposal | null;
  stepInfo: { step: number; maxSteps: number } | null;
  awaitingContinue: boolean;
  continueInfo: { completedSteps: number; chunkSize: number } | null;
  contextUsage: { usedTokens: number; windowTokens: number; source: 'api' | 'estimate' } | null;
  updatedAt: number;
}

const MODE_LABEL: Record<AgentMode, string> = {
  ask: 'Ask',
  plan: 'Plan',
  agent: 'Agent',
};

const PERMISSION_ORDER: PermissionMode[] = ['allow_all_extreme', 'allow_all', 'ask', 'deny_all'];

const PERMISSION_SHORT_LABELS: Record<PermissionMode, string> = {
  allow_all_extreme: '全放行·极',
  allow_all: '全自动',
  ask: '需确认',
  deny_all: '只读',
};

/**
 * 与模型选择按钮同款外观的下拉控件。用于「模式 / 权限」等选项，
 * 取代原生 <select>，从而在 Windows 上与右侧模型选择按钮视觉完全一致
 * （同样的 pill、hover、弹出菜单与选中态）。
 */
interface PillEntry<T extends string> {
  value: T;
  /** 关闭态按钮上显示的文本（短标签）。 */
  label: string;
  /** 菜单项显示的文本，缺省时与 label 一致（如权限项可写完整说明）。 */
  menuLabel?: string;
}

function ChatToolbarPill<T extends string>(props: {
  value: T;
  options: ReadonlyArray<PillEntry<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  title?: string;
}): React.JSX.Element {
  const { value, options, onChange, disabled, title } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div className="chat-model-selector-wrapper" ref={ref}>
      <button
        type="button"
        className="chat-model-selector-btn"
        disabled={disabled}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="chat-model-name">{current?.label ?? String(value)}</span>
        <span className="chat-model-arrow">▾</span>
      </button>
      {open && (
        <div className="chat-model-dropdown-menu compact">
          <div className="chat-model-dropdown-list">
            {options.map((opt) => {
              const selected = opt.value === value;
              return (
                <div
                  key={opt.value}
                  className={`chat-model-dropdown-item${selected ? ' selected' : ''}`}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                >
                  <span className="chat-model-item-title">{opt.menuLabel ?? opt.label}</span>
                  {selected && <span className="chat-model-check">✓</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const STICK_THRESHOLD_PX = 60;

function createEmptyTab(id?: string, title = 'New Chat'): SessionTab {
  return {
    id: id || uid(),
    title,
    messages: [],
    attachments: [],
    mode: 'agent',
    input: '',
    status: 'idle',
    runId: null,
    streaming: '',
    confirm: null,
    plan: null,
    pendingPlanContext: null,
    stepInfo: null,
    awaitingContinue: false,
    continueInfo: null,
    contextUsage: null,
    updatedAt: Date.now(),
  };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatToolArgs(args: unknown): string {
  try {
    return typeof args === 'string' ? args : JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function formatFileSize(bytes?: number): string {
  if (typeof bytes !== 'number' || isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getProviderBadge(provider?: string) {
  switch (provider) {
    case 'deepseek':
      return { label: 'DeepSeek', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)' };
    case 'openai':
      return { label: 'OpenAI', color: '#10a37f', bg: 'rgba(16, 163, 127, 0.15)' };
    case 'anthropic':
      return { label: 'Claude', color: '#f97316', bg: 'rgba(249, 115, 22, 0.15)' };
    default:
      return { label: 'Custom', color: '#a855f7', bg: 'rgba(168, 85, 247, 0.15)' };
  }
}

function computeLineDiffStats(
  original?: string,
  modified?: string,
): { added: number; deleted: number } {
  const origText = original ?? '';
  const modText = modified ?? '';
  if (!origText) {
    const lines = modText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return { added: lines.length || 1, deleted: 0 };
  }
  if (!modText) {
    const lines = origText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return { added: 0, deleted: lines.length || 1 };
  }

  const origLines = origText.split(/\r?\n/);
  const modLines = modText.split(/\r?\n/);

  let added = 0;
  let deleted = 0;
  let oi = 0;
  let mi = 0;

  while (oi < origLines.length || mi < modLines.length) {
    if (oi < origLines.length && mi < modLines.length && origLines[oi] === modLines[mi]) {
      oi++;
      mi++;
    } else {
      const findOrig = origLines.indexOf(modLines[mi], oi);
      const findMod = modLines.indexOf(origLines[oi], mi);

      if (findOrig !== -1 && (findMod === -1 || findOrig - oi <= findMod - mi)) {
        deleted += findOrig - oi;
        oi = findOrig;
      } else if (findMod !== -1) {
        added += findMod - mi;
        mi = findMod;
      } else {
        if (oi < origLines.length) {
          deleted++;
          oi++;
        }
        if (mi < modLines.length) {
          added++;
          mi++;
        }
      }
    }
  }

  return { added, deleted };
}

// ChatPanel Component
const ChatPanelComponent: React.ForwardRefRenderFunction<ChatPanelHandle, Props> = (props, ref) => {
  const {
    workspace,
    workspaceInfo,
    openFiles,
    selection,
    cursor,
    onPendingDiff,
    sessionMessages,
    onMessagesChange,
    onSessionChange,
    permissionMode,
    onPermissionModeChange,
    contextWindowTokens,
    diffs,
    onAcceptAllDiffs,
    onRejectAllDiffs,
    onSelectDiff,
    onOpenFile,
    onOpenSettings,
    onSwitchWorkspace,
    models = [],
    activeModelId,
    onActiveModelChange,
  } = props;
  // Manage multiple active session tabs
  const [tabs, setTabs] = useState<SessionTab[]>(() => {
    const initial = createEmptyTab();
    if (sessionMessages && sessionMessages.length > 0) {
      initial.messages = sessionMessages;
      const first = sessionMessages.find((m) => m.role === 'user');
      if (first) initial.title = first.content.slice(0, 40);
    }
    return [initial];
  });
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [showJumpLatest, setShowJumpLatest] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false);
      }
    };
    if (modelDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [modelDropdownOpen]);
  const isComposingRef = useRef(false);
  const [confirmAnswer, setConfirmAnswer] = useState('');

  const messagesElRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<InputCodeRefOverlayHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const stickRef = useRef(true);
  const isProgrammaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);

  // .echolyrules 规则感知与管理
  const [hasRules, setHasRules] = useState(false);

  useEffect(() => {
    let unmounted = false;
    const checkRules = async () => {
      try {
        const res = await window.ide.rulesGet(workspace || undefined);
        if (!unmounted) {
          setHasRules(!!res?.content);
        }
      } catch {
        if (!unmounted) setHasRules(false);
      }
    };
    void checkRules();
    const timer = setInterval(() => {
      void checkRules();
    }, 4000);
    return () => {
      unmounted = true;
      clearInterval(timer);
    };
  }, [workspace]);

  const handleOpenOrInitRules = async () => {
    try {
      const res = await window.ide.rulesGet(workspace || undefined);
      const targetFilename = res?.filename || '.echolyrules';
      if (!res?.content) {
        // 留空由后端智能感知当前工作区技术栈（Java/Python/C++/Go/Rust/TS）生成专属规则规范
        await window.ide.rulesSave('', workspace || undefined);
        setHasRules(true);
      }
      window.dispatchEvent(new CustomEvent('echoly:refreshFileTree'));
      onOpenFile?.(targetFilename);
    } catch (e) {
      console.error('打开或创建 .echolyrules 失败', e);
    }
  };

  const handleCopyMessage = useCallback((content: string, id: string) => {
    void navigator.clipboard.writeText(content);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  }, []);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const onPendingDiffRef = useRef(onPendingDiff);
  onPendingDiffRef.current = onPendingDiff;
  const onMessagesChangeRef = useRef(onMessagesChange);
  onMessagesChangeRef.current = onMessagesChange;
  const onSessionChangeRef = useRef(onSessionChange);
  onSessionChangeRef.current = onSessionChange;

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  useEffect(() => {
    setConfirmAnswer('');
  }, [activeTab?.confirm?.id]);

  // Helper to update a specific session tab
  const workspaceInfoRef = useRef(workspaceInfo);
  workspaceInfoRef.current = workspaceInfo;

  const updateTab = useCallback((id: string, updater: (prev: SessionTab) => SessionTab) => {
    setTabs((prevTabs) =>
      prevTabs.map((t) => {
        if (t.id !== id) return t;
        const updated = updater(t);
        // Auto-save to IPC if messages changed
        if (updated.messages.length > 0) {
          const firstUserMsg = updated.messages.find((m) => m.role === 'user');
          const title = updated.customTitle
            ? updated.title
            : firstUserMsg
              ? firstUserMsg.content.slice(0, 40)
              : updated.title;
          const meta = buildSessionWorkspaceMeta(workspaceInfoRef.current);
          void window.ide.saveSession({
            id: updated.id,
            title,
            customTitle: updated.customTitle,
            messages: updated.messages,
            updatedAt: Date.now(),
            ...meta,
          });
        }
        return updated;
      }),
    );
  }, []);

  const handleRollbackUserMessage = useCallback(
    (msg: ChatSessionMessage) => {
      const currentTabId = activeTabIdRef.current;
      if (!currentTabId) return;
      const targetTab = tabsRef.current.find((t) => t.id === currentTabId);
      if (targetTab?.runId) {
        void window.ide.cancelAgent(targetTab.runId);
      }
      updateTab(currentTabId, (t) => {
        const idx = t.messages.findIndex((mm) => mm.id === msg.id);
        const truncated = idx >= 0 ? t.messages.slice(0, idx) : t.messages;
        return {
          ...t,
          input: msg.content,
          attachments: msg.attachments && msg.attachments.length > 0 ? [...msg.attachments] : [],
          messages: truncated,
          streaming: '',
          runId: null,
          confirm: null,
          awaitingContinue: false,
          plan: null,
          status: 'idle',
        };
      });
      textareaRef.current?.focus();
    },
    [updateTab],
  );

  const processFiles = useCallback(
    async (files: File[]) => {
      const currentTabId = activeTabIdRef.current;
      if (!currentTabId) return;
      const newAttachments: ChatAttachment[] = [];

      for (const file of files) {
        const isImage =
          file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name);
        const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

        if (isImage || isPdf) {
          if (file.size > 20 * 1024 * 1024) {
            alert(`文件 ${file.name} 超过 20MB 限制`);
            continue;
          }
          try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });
            newAttachments.push({
              id: uid(),
              name: file.name || (isImage ? 'image.png' : 'document.pdf'),
              type: isImage ? 'image' : 'file',
              mimeType: file.type || (isImage ? 'image/png' : 'application/pdf'),
              size: file.size,
              dataUrl,
            });
          } catch (err) {
            console.error('Failed to read media/document file:', err);
          }
        } else {
          if (file.size > 5 * 1024 * 1024) {
            alert(`文件 ${file.name} 超过 5MB 限制`);
            continue;
          }
          try {
            const text = await file.text();
            newAttachments.push({
              id: uid(),
              name: file.name,
              type: 'file',
              mimeType: file.type || 'text/plain',
              size: file.size,
              content: text,
            });
          } catch (err) {
            console.error('Failed to read text file:', err);
          }
        }
      }

      if (newAttachments.length > 0) {
        updateTab(currentTabId, (t) => ({
          ...t,
          attachments: [...(t.attachments || []), ...newAttachments],
        }));
      }
    },
    [updateTab],
  );

  const handleRemoveAttachment = useCallback(
    (id: string) => {
      const currentTabId = activeTabIdRef.current;
      if (!currentTabId) return;
      updateTab(currentTabId, (t) => ({
        ...t,
        attachments: (t.attachments || []).filter((a) => a.id !== id),
      }));
    },
    [updateTab],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        void processFiles(files);
      }
    },
    [processFiles],
  );

  // Sync active tab messages to parent prop
  useEffect(() => {
    if (activeTab) {
      onMessagesChangeRef.current(activeTab.messages);
      onSessionChangeRef.current?.(activeTab.id);
    }
  }, [activeTab?.messages, activeTab?.id]);

  const scrollToBottom = useCallback((force = false) => {
    const el = messagesElRef.current;
    if (!el) return;
    if (!force && !stickRef.current) return;
    isProgrammaticScrollRef.current = true;
    if (programmaticScrollTimerRef.current) clearTimeout(programmaticScrollTimerRef.current);
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      if (messagesElRef.current) {
        messagesElRef.current.scrollTop = messagesElRef.current.scrollHeight;
      }
      programmaticScrollTimerRef.current = setTimeout(() => {
        isProgrammaticScrollRef.current = false;
      }, 100);
    });
  }, []);

  /** Bring the new user turn into view; stick-to-bottom keeps following the reply
   *  while CSS sticky holds the user bubble at the top (file-tree folder style). */
  const scrollToUserMsg = useCallback((msgId: string) => {
    stickRef.current = true;
    setStickToBottom(true);
    setShowJumpLatest(false);
    isProgrammaticScrollRef.current = true;
    if (programmaticScrollTimerRef.current) clearTimeout(programmaticScrollTimerRef.current);

    const doScroll = () => {
      const el = messagesElRef.current;
      const userEl = document.getElementById(`msg-${msgId}`);
      if (el && userEl) {
        const containerRect = el.getBoundingClientRect();
        const userRect = userEl.getBoundingClientRect();
        const targetScrollTop = el.scrollTop + (userRect.top - containerRect.top);
        el.scrollTo({
          top: Math.max(0, targetScrollTop - 4),
          behavior: 'auto',
        });
      }
      stickRef.current = true;
    };

    doScroll();
    requestAnimationFrame(doScroll);
    setTimeout(() => {
      doScroll();
      stickRef.current = true;
      programmaticScrollTimerRef.current = setTimeout(() => {
        isProgrammaticScrollRef.current = false;
      }, 150);
    }, 40);
  }, []);

  const lastUserMsgId = [...(activeTab?.messages ?? [])]
    .reverse()
    .find((m) => m.role === 'user')?.id;
  const prevLastUserMsgIdRef = useRef<string | undefined>(undefined);

  // @ 上下文提及联想状态与数据源
  const [mentionState, setMentionState] = useState<{
    isOpen: boolean;
    query: string;
    cursorIndex: number;
    selectedIndex: number;
  }>({
    isOpen: false,
    query: '',
    cursorIndex: 0,
    selectedIndex: 0,
  });
  const mentionListRef = useRef<HTMLDivElement>(null);
  const mentionPopoverRef = useRef<HTMLDivElement>(null);
  const isKeyboardNavRef = useRef(false);

  // 已删除文件的路径集合：openFiles 来源于打开的编辑器标签，文件被删除后标签仍在，
  // 会导致 @ 弹窗继续列出已失效的引用。此处对所有文件路径做一次磁盘存在性校验。
  const [missingPaths, setMissingPaths] = useState<Set<string>>(() => new Set());
  const fsValidationNonce = useRef(0);
  // openFiles 每次渲染都是新数组，用稳定的路径串做依赖，避免流式输出期间反复触发 IPC 校验
  const candidatePathsKey = useMemo(
    () =>
      Array.from(
        new Set([cursor?.path, ...openFiles.map((f) => f.path)].filter(Boolean) as string[]),
      ).join('\n'),
    [cursor?.path, openFiles],
  );

  const validateFilePaths = useCallback(async () => {
    const checker = window.ide?.pathExists;
    if (!checker) return;
    const paths = candidatePathsKey ? candidatePathsKey.split('\n').filter(Boolean) : [];
    if (paths.length === 0) {
      setMissingPaths((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    const nonce = ++fsValidationNonce.current;
    const results = await Promise.all(
      paths.map(async (p) => {
        try {
          const exists = await checker(p);
          return { path: p, exists: Boolean(exists) };
        } catch {
          return { path: p, exists: false };
        }
      }),
    );
    if (nonce !== fsValidationNonce.current) return;
    const next = new Set<string>();
    for (const r of results) {
      if (!r.exists) {
        next.add(r.path);
        const norm = r.path.replace(/\\/g, '/').replace(/^\/+/, '');
        next.add(norm);
      }
    }
    setMissingPaths((prev) => {
      if (prev.size === next.size && Array.from(next).every((p) => prev.has(p))) return prev;
      return next;
    });
  }, [candidatePathsKey]);

  useEffect(() => {
    void validateFilePaths();
  }, [validateFilePaths]);

  // 每次弹窗打开时重新校验一次：SSH 工作区不产生文件系统事件，
  // 仅靠事件无法感知删除，必须在打开瞬间做一次实时校验
  useEffect(() => {
    if (mentionState.isOpen) void validateFilePaths();
  }, [mentionState.isOpen, validateFilePaths]);

  // 点击弹窗之外的任意位置即关闭（原先只有 AI 区域内的 Esc 能取消）
  useEffect(() => {
    if (!mentionState.isOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (mentionPopoverRef.current?.contains(target)) return;
      if (textareaRef.current?.contains(target)) return;
      setMentionState((prev) => (prev.isOpen ? { ...prev, isOpen: false } : prev));
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [mentionState.isOpen]);

  // 文件系统变更（新增/删除/重命名）后重新校验，保证弹窗列表实时有效
  useEffect(() => {
    const unlisten = window.ide?.onFsChanged?.(() => void validateFilePaths());
    const handler = () => void validateFilePaths();
    window.addEventListener('echoly:refreshFileTree', handler);
    window.addEventListener('echoly:refreshTree', handler);
    return () => {
      unlisten?.();
      window.removeEventListener('echoly:refreshFileTree', handler);
      window.removeEventListener('echoly:refreshTree', handler);
    };
  }, [validateFilePaths]);

  const mentionCandidates = useMemo<MentionItem[]>(() => {
    const list: MentionItem[] = [];
    const seen = new Set<string>();
    const isStale = (p: string) => {
      if (!p) return true;
      if (missingPaths.has(p)) return true;
      const norm = p.replace(/\\/g, '/').replace(/^\/+/, '');
      if (missingPaths.has(norm)) return true;
      for (const m of missingPaths) {
        const normM = m.replace(/\\/g, '/').replace(/^\/+/, '');
        if (norm === normM || norm.endsWith('/' + normM) || normM.endsWith('/' + norm)) {
          return true;
        }
      }
      return false;
    };

    // 1. 当前活动文件优先放置在第一位
    const currentPath = cursor?.path || openFiles[0]?.path;
    if (currentPath && !isStale(currentPath)) {
      seen.add(currentPath);
      const name = currentPath.split('/').pop() || currentPath;
      list.push({
        id: `current-file:${currentPath}`,
        type: 'file',
        title: `@${name}`,
        desc: `当前文件 · ${currentPath}`,
        path: currentPath,
        insertText: `@${currentPath} `,
      });
    }

    // 2. 其他已打开的文件（跳过已在磁盘上删除的失效引用）
    for (const f of openFiles) {
      if (!f.path || seen.has(f.path) || isStale(f.path)) continue;
      seen.add(f.path);
      const name = f.path.split('/').pop() || f.path;
      list.push({
        id: `file:${f.path}`,
        type: 'file',
        title: `@${name}`,
        desc: f.path,
        path: f.path,
        insertText: `@${f.path} `,
      });
    }

    // 3. 特殊上下文选项 (@Git, @Terminal, @Problems)
    list.push(
      {
        id: 'special:git',
        type: 'special',
        title: '@Git',
        desc: '引用当前工作区 Git 变更与状态',
        insertText: '@Git ',
      },
      {
        id: 'special:terminal',
        type: 'special',
        title: '@Terminal',
        desc: '引用终端最近执行输出与报错',
        insertText: '@Terminal ',
      },
      {
        id: 'special:problems',
        type: 'special',
        title: '@Problems',
        desc: '引用当前代码报错与诊断信息',
        insertText: '@Problems ',
      },
    );

    return list;
  }, [cursor?.path, openFiles, missingPaths]);

  const filteredMentions = useMemo(() => {
    if (!mentionState.isOpen) return [];
    const q = mentionState.query.toLowerCase().trim();
    if (!q) return mentionCandidates;
    return mentionCandidates.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.desc.toLowerCase().includes(q) ||
        (item.path && item.path.toLowerCase().includes(q)),
    );
  }, [mentionState.isOpen, mentionState.query, mentionCandidates]);

  const handleSelectMention = useCallback(
    (item: MentionItem) => {
      const input = activeTab?.input ?? '';
      const textBefore = input.slice(0, mentionState.cursorIndex);
      const textAfter = input.slice(mentionState.cursorIndex);
      const atIdx = textBefore.lastIndexOf('@');
      if (atIdx >= 0) {
        const nextInput = textBefore.slice(0, atIdx) + item.insertText + textAfter;
        updateTab(activeTab.id, (t) => ({ ...t, input: nextInput }));
        setMentionState({ isOpen: false, query: '', cursorIndex: 0, selectedIndex: 0 });
        setTimeout(() => {
          if (textareaRef.current) {
            const newPos = atIdx + item.insertText.length;
            textareaRef.current.focus();
            textareaRef.current.setSelectionRange(newPos, newPos);
          }
        }, 20);
      }
    },
    [activeTab?.id, activeTab?.input, mentionState.cursorIndex],
  );

  // 当上下键切换或弹窗打开时，自动滚动将当前高亮项保持在可视范围内
  useEffect(() => {
    if (mentionState.isOpen && mentionListRef.current) {
      const activeEl = mentionListRef.current.querySelector(
        '.chat-mention-item.active',
      ) as HTMLElement | null;
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [mentionState.selectedIndex, mentionState.isOpen]);

  useEffect(() => {
    if (lastUserMsgId && lastUserMsgId !== prevLastUserMsgIdRef.current) {
      prevLastUserMsgIdRef.current = lastUserMsgId;
      scrollToUserMsg(lastUserMsgId);
    }
  }, [lastUserMsgId, scrollToUserMsg]);

  const jumpToLatest = useCallback(() => {
    stickRef.current = true;
    setStickToBottom(true);
    setShowJumpLatest(false);
    scrollToBottom(true);
  }, [scrollToBottom]);

  useEffect(() => {
    const el = messagesElRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // 用户向上滚轮（主动查阅历史）：立即解除吸底并展示「回到最新」按钮
        stickRef.current = false;
        setStickToBottom(false);
        setShowJumpLatest(true);
      }
      // 向下滚轮（e.deltaY > 0）时不强行吸底！
      // 允许用户在历史记录中自由向下平滑微调浏览，只有当真正滚到接近底部（onScroll 触发 nearBottom）时才恢复吸底。
    };

    let touchStartY = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const currentY = e.touches[0]?.clientY ?? 0;
      const deltaY = touchStartY - currentY;
      if (deltaY < 0) {
        // 手指向下拉（查阅历史）：立即解除吸底
        stickRef.current = false;
        setStickToBottom(false);
        setShowJumpLatest(true);
      }
      // 同样，手指向上推（向下看历史）时不强行吸底，避免突然跳到最底部
    };

    const onScroll = () => {
      if (isProgrammaticScrollRef.current) {
        return;
      }
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const nearBottom = distance <= STICK_THRESHOLD_PX;

      if (nearBottom) {
        // 只有当距离底部在安全缓冲区内（<= STICK_THRESHOLD_PX）时，才恢复吸底
        stickRef.current = true;
        setStickToBottom(true);
        setShowJumpLatest(false);
      } else {
        // 离底部较远，说明用户脱离了底部在翻阅历史消息，解除吸底并展示「回到最新」
        stickRef.current = false;
        setStickToBottom(false);
        setShowJumpLatest(true);
      }
    };

    const observer = new MutationObserver(() => {
      // 只要处于吸底状态，DOM 发生变更（如流式输出、卡片展开）一律紧贴最新底部
      if (stickRef.current && messagesElRef.current) {
        isProgrammaticScrollRef.current = true;
        messagesElRef.current.scrollTop = messagesElRef.current.scrollHeight;
        if (programmaticScrollTimerRef.current) clearTimeout(programmaticScrollTimerRef.current);
        programmaticScrollTimerRef.current = setTimeout(() => {
          isProgrammaticScrollRef.current = false;
        }, 80);
      }
    });

    observer.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      if (programmaticScrollTimerRef.current) clearTimeout(programmaticScrollTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (stickRef.current) {
      scrollToBottom();
    }
  }, [
    activeTab?.messages,
    activeTab?.streaming,
    activeTab?.plan,
    activeTab?.status,
    activeTab?.stepInfo,
    activeTab?.awaitingContinue,
    scrollToBottom,
  ]);

  useImperativeHandle(ref, () => ({
    insertPath(pathOrRef: string) {
      const token = pathOrRef.startsWith('@') ? pathOrRef : `@${pathOrRef}`;
      const currentTabId = activeTabIdRef.current;
      if (!currentTabId) return;
      updateTab(currentTabId, (t) => {
        const prev = t.input;
        const trimmed = prev.trimEnd();
        const nextInput = !trimmed ? `${token} ` : `${trimmed} ${token} `;
        return { ...t, input: nextInput };
      });
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          const len = (textareaRef.current.value ?? '').length;
          textareaRef.current.setSelectionRange(len, len);
        }
      }, 50);
    },

    startFreshWithPath(path: string) {
      const newTab = createEmptyTab();
      newTab.input = `@${path} `;
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
    },

    clearAndNewSession() {
      const reset = createEmptyTab();
      setTabs([reset]);
      setActiveTabId(reset.id);
    },

    askQuestion(prompt: string, autoSubmit = false) {
      const currentTabId = activeTabIdRef.current;
      if (!currentTabId) return;
      updateTab(currentTabId, (t) => ({ ...t, input: prompt }));
      setTimeout(() => {
        if (autoSubmit) {
          void send();
        } else if (textareaRef.current) {
          textareaRef.current.focus();
          const len = (textareaRef.current.value ?? '').length;
          textareaRef.current.setSelectionRange(len, len);
        }
      }, 50);
    },

    focusInput() {
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          const len = (textareaRef.current.value ?? '').length;
          textareaRef.current.setSelectionRange(len, len);
        }
      }, 30);
    },
  }));

  const prevWorkspaceRef = useRef<string | undefined>(workspace);
  const pendingLoadSessionRef = useRef<{ session: ChatSession; path: string } | null>(null);

  const sessionToTab = useCallback((session: ChatSession): SessionTab => {
    return {
      id: session.id,
      title: session.title,
      customTitle: session.customTitle,
      messages: session.messages,
      attachments: [],
      mode: 'agent',
      input: '',
      status: 'idle',
      runId: null,
      streaming: '',
      confirm: null,
      plan: null,
      pendingPlanContext: null,
      stepInfo: null,
      awaitingContinue: false,
      continueInfo: null,
      contextUsage: null,
      updatedAt: session.updatedAt,
    };
  }, []);

  useEffect(() => {
    if (prevWorkspaceRef.current !== undefined && prevWorkspaceRef.current !== workspace) {
      const pending = pendingLoadSessionRef.current;
      pendingLoadSessionRef.current = null;
      const matchesPending =
        !!pending &&
        (pending.path === workspace ||
          pending.path === workspaceInfo?.root ||
          pending.path === workspaceInfo?.label);
      if (matchesPending && pending) {
        const tab = sessionToTab(pending.session);
        setTabs([tab]);
        setActiveTabId(tab.id);
      } else {
        const reset = createEmptyTab();
        setTabs([reset]);
        setActiveTabId(reset.id);
      }
    }
    prevWorkspaceRef.current = workspace;
  }, [workspace, workspaceInfo?.root, workspaceInfo?.label, sessionToTab]);

  // Global Agent Event Listener (Routes events to matching runId session)
  useEffect(() => {
    return window.ide.onAgentEvent((event) => {
      // Find matching session tab for this runId
      const targetTab = tabsRef.current.find((t) => t.runId === event.runId);
      if (!targetTab) return;

      updateTab(targetTab.id, (t) => {
        const next = { ...t };
        switch (event.type) {
          case 'status':
            next.status = event.status;
            if (event.status === 'thinking') {
              next.thinkingStreaming = '';
            } else if (event.status === 'cancelled') {
              next.runId = null;
              next.confirm = null;
              next.streaming = '';
              next.thinkingStreaming = '';
              next.awaitingContinue = false;
              next.continueInfo = null;
              next.stepInfo = null;
            }
            break;
          case 'token':
            next.streaming += event.text;
            break;
          case 'thinking_token':
            next.thinkingStreaming = (next.thinkingStreaming || '') + event.text;
            break;
          case 'pending_diff':
            onPendingDiffRef.current(event);
            break;
          case 'confirm_request':
            next.confirm = event.request;
            break;
          case 'confirm_resolved':
            if (next.confirm?.id === event.requestId) {
              next.confirm = null;
            }
            break;
          case 'plan_proposal':
            next.plan = event.plan;
            break;
          case 'step_progress':
            next.stepInfo = { step: event.step, maxSteps: event.maxSteps };
            next.awaitingContinue = false;
            next.streaming = '';
            break;
          case 'max_steps_reached':
            next.awaitingContinue = true;
            next.continueInfo = {
              completedSteps: event.completedSteps,
              chunkSize: event.chunkSize,
            };
            next.streaming = '';
            break;
          case 'context_usage':
            next.contextUsage = {
              usedTokens: event.usedTokens,
              windowTokens: event.windowTokens,
              source: event.source,
            };
            break;
          case 'tool_start': {
            next.streaming = '';
            next.thinkingStreaming = '';
            const newMsg: ChatSessionMessage = {
              id: event.id || uid(),
              role: 'tool',
              content: '',
              toolName: event.name,
              toolCallId: event.id,
              toolStatus: 'running',
              toolArgs: formatToolArgs(event.args),
              createdAt: Date.now(),
            };
            next.messages = [...next.messages, newMsg];
            break;
          }
          case 'tool_output': {
            const existingIdx = next.messages.findIndex(
              (m) =>
                m.role === 'tool' &&
                (m.toolCallId === event.id ||
                  (m.toolName === 'run_terminal' && m.toolStatus === 'running')),
            );
            if (existingIdx >= 0) {
              const msgs = [...next.messages];
              const prev = msgs[existingIdx];
              msgs[existingIdx] = {
                ...prev,
                content: `${prev.content || ''}${event.chunk}`,
              };
              next.messages = msgs;
            }
            break;
          }
          case 'tool_result': {
            const existingIdx = next.messages.findIndex(
              (m) =>
                m.role === 'tool' &&
                (m.toolCallId === event.id ||
                  (m.toolName === event.name && m.toolStatus === 'running')),
            );
            if (existingIdx >= 0) {
              const msgs = [...next.messages];
              msgs[existingIdx] = {
                ...msgs[existingIdx],
                content: event.result,
                toolStatus: event.isError ? 'error' : 'done',
              };
              next.messages = msgs;
            } else {
              const newMsg: ChatSessionMessage = {
                id: event.id || uid(),
                role: 'tool',
                content: event.result,
                toolName: event.name,
                toolCallId: event.id,
                toolStatus: event.isError ? 'error' : 'done',
                createdAt: Date.now(),
              };
              next.messages = [...next.messages, newMsg];
            }
            break;
          }
          case 'assistant_message': {
            next.streaming = '';
            next.thinkingStreaming = '';
            if (event.content) {
              const displayContent = event.content
                .split('\n')
                .filter((line) => !/^-{3,}\s*$/.test(line.trim()))
                .join('\n')
                .trim();
              if (displayContent) {
                // Prevent duplicate consecutive or recent identical intermediate thought bubbles
                const lastAssistantMsg = [...next.messages]
                  .reverse()
                  .find((m) => m.role === 'assistant');
                if (
                  lastAssistantMsg &&
                  lastAssistantMsg.isIntermediate &&
                  lastAssistantMsg.content === displayContent
                ) {
                  break;
                }
                next.messages = [
                  ...next.messages,
                  {
                    id: uid(),
                    role: 'assistant',
                    content: displayContent,
                    isIntermediate: true,
                    createdAt: Date.now(),
                  },
                ];
              }
            }
            break;
          }
          case 'done': {
            next.streaming = '';
            next.thinkingStreaming = '';
            next.awaitingContinue = false;
            next.continueInfo = null;
            next.stepInfo = null;
            const textToDisplay =
              event.finalText ||
              (next.messages.some((m) => m.role === 'tool')
                ? '已完成执行，详细操作步骤已收折在上方「Worked for」面板中，点击即可展开查看。'
                : '');
            if (textToDisplay && textToDisplay !== '(cancelled)') {
              const lastIdx = next.messages.length - 1;
              const last = next.messages[lastIdx];
              // Match against the trailing intermediate assistant bubble (emitted just
              // before `done` for the same final answer) rather than requiring an exact
              // string match, since minor formatting differences would otherwise cause
              // the same answer to be appended twice.
              if (last && last.role === 'assistant' && last.isIntermediate) {
                const msgs = [...next.messages];
                msgs[lastIdx] = { ...last, content: textToDisplay, isIntermediate: false };
                next.messages = msgs;
              } else if (last && last.role === 'assistant' && last.content === textToDisplay) {
                const msgs = [...next.messages];
                msgs[lastIdx] = { ...last, isIntermediate: false };
                next.messages = msgs;
              } else {
                next.messages = [
                  ...next.messages,
                  {
                    id: uid(),
                    role: 'assistant',
                    content: textToDisplay,
                    isIntermediate: false,
                    createdAt: Date.now(),
                  },
                ];
              }
            } else if (next.messages.length > 0) {
              const lastIdx = next.messages.length - 1;
              const last = next.messages[lastIdx];
              if (last && last.role === 'assistant' && last.isIntermediate) {
                const msgs = [...next.messages];
                msgs[lastIdx] = { ...last, isIntermediate: false };
                next.messages = msgs;
              }
            }
            next.status = 'done';
            next.runId = null;
            break;
          }
          case 'error':
            next.messages = [
              ...next.messages,
              {
                id: uid(),
                role: 'assistant',
                content: `错误：${event.message}`,
                createdAt: Date.now(),
              },
            ];
            next.streaming = '';
            next.awaitingContinue = false;
            next.continueInfo = null;
            next.stepInfo = null;
            next.status = 'error';
            next.runId = null;
            break;
        }
        return next;
      });
    });
  }, [updateTab]);

  async function send(
    overridePrompt?: string,
    overrideMode?: AgentMode,
    planForRun?: PlanProposal | null,
  ): Promise<void> {
    if (!workspace) {
      alert('请先打开工作区');
      return;
    }
    if (!activeTab) return;
    const rawPrompt = (overridePrompt ?? activeTab.input).trim();
    const currentAttachments = activeTab.attachments || [];
    if (!rawPrompt && currentAttachments.length === 0) return;
    const prompt =
      rawPrompt ||
      (currentAttachments.some((a) => a.type === 'image') ? '请分析图片' : '请分析附件');
    const runMode = overrideMode ?? activeTab.mode;

    const userMsg: ChatSessionMessage = {
      id: uid(),
      role: 'user',
      content: prompt,
      attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
      createdAt: Date.now(),
    };

    const newMessages = [...activeTab.messages, userMsg];
    const newTitle = activeTab.messages.length === 0 ? prompt.slice(0, 40) : activeTab.title;

    updateTab(activeTab.id, (t) => ({
      ...t,
      title: newTitle,
      input: overridePrompt ? t.input : '',
      attachments: overridePrompt ? t.attachments : [],
      messages: newMessages,
      streaming: '',
      status: 'thinking',
      awaitingContinue: false,
      continueInfo: null,
      stepInfo: null,
    }));

    scrollToUserMsg(userMsg.id);

    const history = buildAgentHistory(newMessages, contextWindowTokens);
    const ctxSource = planForRun ?? (runMode === 'agent' ? activeTab.pendingPlanContext : null);
    const planContext =
      runMode === 'agent' && ctxSource
        ? {
            title: ctxSource.title,
            summary: ctxSource.summary,
            todos: ctxSource.todos,
          }
        : undefined;

    const connectedModels = models.filter((m) => m.lastProbeOk === true);
    const chosenModel = models.find((m) => m.id === (activeTab.modelId || activeModelId));
    const effectiveModelId =
      (chosenModel?.lastProbeOk ? chosenModel.id : undefined) ||
      connectedModels[0]?.id ||
      activeTab.modelId ||
      activeModelId ||
      (models[0]?.id ?? 'deepseek-local');

    const { runId: id } = await window.ide.startAgent({
      prompt,
      mode: runMode,
      modelId: effectiveModelId,
      planContext,
      openFiles,
      selection: selection?.trim() || undefined,
      cursor,
      history,
      attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
    });

    updateTab(activeTab.id, (t) => ({
      ...t,
      runId: id,
      pendingPlanContext: planContext ? null : t.pendingPlanContext,
    }));
  }

  async function cancel(): Promise<void> {
    const tab = activeTab;
    if (!tab?.runId) return;
    const runId = tab.runId;
    // Optimistic UI: stop button should clear immediately even if the run is
    // blocked on confirm / a long tool call.
    updateTab(tab.id, (t) => ({
      ...t,
      runId: null,
      confirm: null,
      streaming: '',
      awaitingContinue: false,
      continueInfo: null,
      stepInfo: null,
      status: 'cancelled',
    }));
    await window.ide.cancelAgent(runId);
  }

  async function answerConfirm(approved: boolean, answer?: string): Promise<void> {
    if (!activeTab?.confirm) return;
    const text = answer?.trim() || undefined;
    await window.ide.respondConfirm(activeTab.confirm.id, approved, text);
    setConfirmAnswer('');
    updateTab(activeTab.id, (t) => ({ ...t, confirm: null }));
  }

  async function continueRun(): Promise<void> {
    if (!activeTab?.runId) return;
    updateTab(activeTab.id, (t) => ({ ...t, awaitingContinue: false, status: 'thinking' }));
    await window.ide.continueAgent(activeTab.runId);
  }

  async function stopContinue(): Promise<void> {
    if (!activeTab?.runId) return;
    await window.ide.stopContinueAgent(activeTab.runId);
  }

  function executePlan(): void {
    if (!activeTab?.plan) return;
    const p = activeTab.plan;
    updateTab(activeTab.id, (t) => ({ ...t, pendingPlanContext: p, mode: 'agent' }));
    const prompt = `请按已批准的计划执行。\n标题：${p.title}\n摘要：${p.summary}\n步骤：\n${p.todos
      .filter((t) => t.status !== 'completed' && t.status !== 'cancelled')
      .map((t, i) => `${i + 1}. ${t.content}`)
      .join('\n')}`;
    void send(prompt, 'agent', p);
  }

  const handleNewTab = () => {
    const newTab = createEmptyTab();
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleDeleteCurrentSessionAndOpenNew = () => {
    const currentId = activeTabIdRef.current;
    const newTab = createEmptyTab();
    setTabs((prev) => {
      const remaining = prev.filter((t) => t.id !== currentId);
      return remaining.length === 0 ? [newTab] : [...remaining, newTab];
    });
    setActiveTabId(newTab.id);
  };

  const handleCloseTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const tabToClose = tabs.find((t) => t.id === id);
    if (tabToClose?.runId) {
      void window.ide.cancelAgent(tabToClose.runId);
    }
    if (tabs.length === 1) {
      const reset = createEmptyTab();
      setTabs([reset]);
      setActiveTabId(reset.id);
      return;
    }
    const nextTabs = tabs.filter((t) => t.id !== id);
    setTabs(nextTabs);
    if (activeTabId === id) {
      setActiveTabId(nextTabs[nextTabs.length - 1].id);
    }
  };

  const handleLoadSessionFromModal = (session: ChatSession) => {
    // 直接在当前聊天面板中打开该历史会话，不再触发切换工作区弹窗
    const existing = tabs.find((t) => t.id === session.id);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const tab = sessionToTab(session);
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  };

  const handleRenameSession = (id: string, newTitle: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, title: newTitle, customTitle: true } : t)),
    );
  };

  const windowTokens = activeTab?.contextUsage?.windowTokens ?? contextWindowTokens;
  const usedTokens = activeTab?.contextUsage?.usedTokens ?? 0;
  const usagePct = windowTokens > 0 ? Math.min(100, (usedTokens / windowTokens) * 100) : 0;

  return (
    <div className="chat-panel">
      {/* Title Bar Header with Tabs */}
      <div className="panel-title chat-title-row">
        <div className="chat-tabs-bar">
          {tabs.map((t) => {
            const isRunning =
              t.status !== 'idle' &&
              t.status !== 'done' &&
              t.status !== 'error' &&
              t.status !== 'cancelled';
            const isActive = t.id === activeTabId;
            return (
              <div
                key={t.id}
                className={`chat-tab-item${isActive ? ' active' : ''}`}
                onClick={() => setActiveTabId(t.id)}
                title={isActive ? (t.title || '当前对话') : `${t.title || '对话'} (点击切换)`}
              >
                <span className="chat-tab-icon" aria-hidden="true">
                  {isRunning ? (
                    <span className="chat-tab-running-dot" title="运行中…" />
                  ) : (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 2a10 10 0 0 1 10 10c0 5.523-4.477 10-10 10a9.96 9.96 0 0 1-4.587-1.11L3 22l1.11-4.413A9.96 9.96 0 0 1 2 12 10 10 0 0 1 12 2z" />
                    </svg>
                  )}
                </span>
                <span className="chat-tab-title">
                  {t.title || 'New Chat'}
                </span>
                {tabs.length > 1 && (
                  <button
                    type="button"
                    className="chat-tab-close"
                    onClick={(e) => handleCloseTab(t.id, e)}
                    title="关闭 Tab"
                  >
                    <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M1.293 1.293a1 1 0 0 1 1.414 0L8 6.586l5.293-5.293a1 1 0 1 1 1.414 1.414L9.414 8l5.293 5.293a1 1 0 0 1-1.414 1.414L8 9.414l-5.293 5.293a1 1 0 0 1-1.414-1.414L6.586 8 1.293 2.707a1 1 0 0 1 0-1.414z" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="chat-header-actions">
          <button type="button" className="icon-btn" title="新建对话" onClick={handleNewTab}>
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            type="button"
            className="icon-btn"
            title="历史会话"
            onClick={() => setShowHistoryModal(true)}
          >
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M12 7v5l4 2" />
            </svg>
          </button>
        </div>
      </div>

      {/* Messages Wrap */}
      <div className="chat-messages-wrap">
        <div className="chat-messages" ref={messagesElRef}>
          {(() => {
            const msgs = activeTab?.messages ?? [];
            const isRunning = activeTab
              ? activeTab.status !== 'idle' &&
                activeTab.status !== 'done' &&
                activeTab.status !== 'error' &&
                activeTab.status !== 'cancelled'
              : false;

            // File-tree style turns: each user bubble is the sticky "folder";
            // everything until the next user message is the scrollable "files".
            // Scrolling past a turn lets the next user bubble push this one up.
            type ChatTurn = {
              user: ChatSessionMessage | null;
              body: ChatSessionMessage[];
            };
            const turns: ChatTurn[] = [];
            let current: ChatTurn = { user: null, body: [] };
            for (const m of msgs) {
              if (m.role === 'user') {
                if (current.user || current.body.length > 0) turns.push(current);
                current = { user: m, body: [] };
              } else {
                current.body.push(m);
              }
            }
            turns.push(current);

            const renderUserBubble = (m: ChatSessionMessage) => (
              <div id={`msg-${m.id}`} className="msg user">
                {m.attachments && m.attachments.length > 0 && (
                  <div className="chat-msg-attachments">
                    {m.attachments.map((att) =>
                      att.type === 'image' && att.dataUrl ? (
                        <div
                          key={att.id}
                          className="chat-msg-attachment-img-card"
                          onClick={() => setPreviewImage(att.dataUrl || null)}
                          title={`${att.name} (${formatFileSize(att.size)}) - 点击放大`}
                        >
                          <img src={att.dataUrl} alt={att.name} />
                          <span className="chat-msg-attachment-img-name">{att.name}</span>
                        </div>
                      ) : (
                        <div
                          key={att.id}
                          className="chat-msg-attachment-file-pill"
                          title={`${att.name} (${formatFileSize(att.size)})`}
                        >
                          <span className="file-pill-icon">📄</span>
                          <span className="file-pill-name">{att.name}</span>
                          <span className="file-pill-size">{formatFileSize(att.size)}</span>
                        </div>
                      ),
                    )}
                  </div>
                )}
                <CollapsibleUserContent content={m.content} onOpenFile={onOpenFile} />
                <div className="msg-actions msg-actions-corner">
                  <button
                    type="button"
                    className="msg-action-btn"
                    title="复制消息内容"
                    onClick={() => handleCopyMessage(m.content, m.id)}
                  >
                    {copiedId === m.id ? '✓ 已复制' : '📋 复制'}
                  </button>
                  <button
                    type="button"
                    className="msg-action-btn"
                    title="回退到此消息（清除此后的 AI 回复）"
                    onClick={() => handleRollbackUserMessage(m)}
                  >
                    ↩ 回退
                  </button>
                </div>
              </div>
            );

            const renderAssistantMsg = (m: ChatSessionMessage) => (
              <div key={m.id} id={`msg-${m.id}`} className="msg assistant">
                <div className="msg-header">
                  <div className="msg-role ai-role">
                    <span className="ai-role-dot" />
                    AI
                  </div>
                </div>
                {(m as any).thinking?.length > 0 && (
                  <ThinkingBlock thinking={(m as any).thinking} />
                )}
                <MarkdownMessage content={m.content} onOpenFile={onOpenFile} />
                <div
                  className="msg-footer"
                  style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}
                >
                  <div className="msg-actions">
                    <button
                      type="button"
                      className="msg-action-btn"
                      title="复制消息内容"
                      onClick={() => handleCopyMessage(m.content, m.id)}
                    >
                      {copiedId === m.id ? '✓ 已复制' : '📋 复制'}
                    </button>
                  </div>
                </div>
              </div>
            );

            const renderTurnBody = (
              body: ChatSessionMessage[],
              turnKey: string,
              turnIsLive: boolean,
            ) => {
              const bodyEls: React.ReactNode[] = [];
              let pendingGroup: ChatSessionMessage[] = [];

              const flushGroup = (key: string, isLiveGroup: boolean) => {
                if (pendingGroup.length === 0) return;
                let trailingAssistant: ChatSessionMessage | null = null;
                const lastMsg = pendingGroup[pendingGroup.length - 1];
                if (
                  lastMsg &&
                  lastMsg.role === 'assistant' &&
                  !lastMsg.isIntermediate &&
                  lastMsg.content?.trim()
                ) {
                  trailingAssistant = pendingGroup.pop()!;
                }
                if (pendingGroup.length > 0) {
                  bodyEls.push(
                    <WorkedForGroup
                      key={key}
                      messages={pendingGroup}
                      isStreaming={Boolean(isRunning && turnIsLive && isLiveGroup)}
                      liveThinking={
                        isRunning && turnIsLive && isLiveGroup
                          ? activeTab?.thinkingStreaming
                          : undefined
                      }
                      contextUsage={activeTab?.contextUsage}
                      onOpenFile={onOpenFile}
                    />,
                  );
                }
                pendingGroup = [];
                if (trailingAssistant) {
                  bodyEls.push(renderAssistantMsg(trailingAssistant));
                }
              };

              body.forEach((m, idx) => {
                const isInter = m.role === 'tool' || (m.role === 'assistant' && m.isIntermediate);
                if (isInter) {
                  pendingGroup.push(m);
                } else {
                  // Completed groups in this turn are never "live"
                  flushGroup(`${turnKey}-g-${idx}`, false);
                  if (m.role === 'assistant') {
                    bodyEls.push(renderAssistantMsg(m));
                  }
                }
              });
              // Trailing tool/reasoning group is live only for the current turn while running
              flushGroup(`${turnKey}-g-end`, true);
              return bodyEls;
            };

            const turnNodes = turns.map((turn, turnIdx) => {
              const turnKey = turn.user?.id ?? `orphan-${turnIdx}`;
              const isLastTurn = turnIdx === turns.length - 1;
              return (
                <div key={turnKey} className="chat-turn">
                  {turn.user && (
                    <div className="chat-turn-folder">
                      {renderUserBubble(turn.user)}
                    </div>
                  )}
                  <div className="chat-turn-files">
                    {renderTurnBody(turn.body, turnKey, isLastTurn)}
                    {isLastTurn && activeTab?.streaming && (
                      <div className="msg assistant">
                        <MarkdownMessage content={activeTab.streaming} streaming onOpenFile={onOpenFile} />
                      </div>
                    )}
                  </div>
                </div>
              );
            });

            return (
              <>
                {turnNodes}
                <div ref={bottomRef} />
              </>
            );
          })()}
        </div>
        {showJumpLatest && (
          <button type="button" className="jump-latest-btn" onClick={jumpToLatest}>
            ↓ 回到最新
          </button>
        )}
      </div>

      {/* Windsurf/Cursor style modified files block (above chat input) */}
      {diffs && diffs.length > 0 && (
        <div className="chat-diff-summary-container">
          <div className="chat-diff-file-list">
            {diffs.map((d) => {
              const fileName = d.path.split('/').filter(Boolean).pop() || d.path;
              const { added, deleted } = computeLineDiffStats(d.original, d.modified);

              return (
                <div
                  key={d.id}
                  className="chat-diff-file-item"
                  onClick={() => onSelectDiff?.(d.id)}
                  title={`点击查看 ${d.path} 差异`}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    style={{ color: 'var(--warn)', flexShrink: 0 }}
                  >
                    <rect
                      x="2"
                      y="2"
                      width="12"
                      height="12"
                      rx="2"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    <circle cx="8" cy="8" r="2" fill="currentColor" />
                  </svg>
                  <span className="diff-stats">
                    <span className="diff-add">+{added}</span>
                    <span className="diff-del">-{deleted}</span>
                  </span>
                  <span className="diff-filename">{fileName}</span>
                  <span className="diff-filepath">{d.path}</span>
                </div>
              );
            })}
          </div>

          <div className="chat-diff-action-bar">
            <div className="chat-diff-action-left">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ opacity: 0.7 }}
              >
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ opacity: 0.7 }}
              >
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span className="count-text">{diffs.length} Files With Changes</span>
            </div>
            <div className="chat-diff-action-right">
              <button type="button" className="btn-reject-all" onClick={onRejectAllDiffs}>
                Reject all
              </button>
              <button type="button" className="btn-accept-all" onClick={onAcceptAllDiffs}>
                Accept all
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI 交互确认 / 问答弹层（输入框上方） */}
      {activeTab?.confirm && (
        <div className="chat-ask-popup">
          <div className="chat-ask-popup-title">{activeTab.confirm.title}</div>
          {activeTab.confirm.detail && (
            <div className="chat-ask-popup-detail">{activeTab.confirm.detail}</div>
          )}
          {activeTab.confirm.options && activeTab.confirm.options.length > 0 && (
            <div className="chat-ask-popup-options">
              {activeTab.confirm.options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className="chat-ask-option"
                  onClick={() => void answerConfirm(true, opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
          {activeTab.confirm.allowInput && (
            <div className="chat-ask-popup-input-row">
              <input
                className="chat-ask-input"
                value={confirmAnswer}
                placeholder="输入回答后提交…"
                onChange={(e) => setConfirmAnswer(e.target.value)}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={() => {
                  isComposingRef.current = false;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if ((e.metaKey || e.ctrlKey || e.shiftKey) && !isComposingRef.current) {
                      e.preventDefault();
                      setConfirmAnswer((prev) => prev + '\n');
                      return;
                    }
                    if (!isComposingRef.current) {
                      e.preventDefault();
                      if (confirmAnswer.trim()) void answerConfirm(true, confirmAnswer);
                    }
                  }
                }}
              />
              <button
                type="button"
                className="primary"
                disabled={!confirmAnswer.trim()}
                onClick={() => void answerConfirm(true, confirmAnswer)}
              >
                提交
              </button>
            </div>
          )}
          <div className="chat-ask-popup-actions">
            <button type="button" className="primary" onClick={() => void answerConfirm(true)}>
              允许
            </button>
            <button type="button" className="danger" onClick={() => void answerConfirm(false)}>
              拒绝
            </button>
          </div>
        </div>
      )}
      {activeTab?.awaitingContinue && activeTab.continueInfo && (
        <div className="chat-ask-popup continue">
          <div className="chat-ask-popup-title">已达步数上限</div>
          <div className="chat-ask-popup-detail">
            已完成 {activeTab.continueInfo.completedSteps} 步，尚未给出最终答案。可再继续{' '}
            {activeTab.continueInfo.chunkSize} 步。
          </div>
          <div className="chat-ask-popup-actions">
            <button type="button" className="primary" onClick={() => void continueRun()}>
              继续
            </button>
            <button type="button" className="danger" onClick={() => void stopContinue()}>
              停止
            </button>
          </div>
        </div>
      )}
      {activeTab?.plan && (
        <PlanPanel
          plan={activeTab.plan}
          onChange={(plan) => updateTab(activeTab.id, (t) => ({ ...t, plan }))}
          onExecute={executePlan}
          onDismiss={() => updateTab(activeTab.id, (t) => ({ ...t, plan: null }))}
          busy={!!activeTab.runId}
        />
      )}

      {/* Input Box */}
      <div
        className="chat-input"
        style={{ padding: '0 12px 12px', borderTop: 'none', background: 'transparent' }}
      >
        <div
          className={`chat-input-box${isDragging ? ' drag-over' : ''}`}
          style={{
            position: 'relative',
            background: 'var(--bg-lighter)',
            borderRadius: 16,
            border: isDragging ? '1px dashed var(--accent)' : '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            padding: '8px 12px',
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
              void processFiles(Array.from(e.dataTransfer.files));
            }
          }}
        >
          {activeTab?.attachments && activeTab.attachments.length > 0 && (
            <div className="chat-staged-attachments">
              {activeTab.attachments.map((att) => (
                <div key={att.id} className="chat-staged-attachment-item">
                  {att.type === 'image' && att.dataUrl ? (
                    <img
                      src={att.dataUrl}
                      alt={att.name}
                      className="staged-img-thumb"
                      onClick={() => setPreviewImage(att.dataUrl || null)}
                      title="点击放大"
                    />
                  ) : (
                    <span className="staged-file-icon">📄</span>
                  )}
                  <div className="staged-info">
                    <span className="staged-name" title={att.name}>
                      {att.name}
                    </span>
                    <span className="staged-size">{formatFileSize(att.size)}</span>
                  </div>
                  <button
                    type="button"
                    className="staged-remove-btn"
                    onClick={() => handleRemoveAttachment(att.id)}
                    title="移除附件"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {mentionState.isOpen && filteredMentions.length > 0 && (
            <div className="chat-mention-popover" ref={mentionPopoverRef}>
              <div className="chat-mention-header">
                <span>上下文引用与文件关联 (@)</span>
                <span className="chat-mention-tip">↑↓ 切换 · ↵ / Tab 采纳 · Esc 取消</span>
              </div>
              <div
                ref={mentionListRef}
                className="chat-mention-list"
                onMouseMove={() => {
                  isKeyboardNavRef.current = false;
                }}
              >
                {filteredMentions.map((item, idx) => {
                  const isSelected = idx === mentionState.selectedIndex;
                  return (
                    <div
                      key={item.id}
                      className={`chat-mention-item${isSelected ? ' active' : ''}`}
                      onMouseEnter={() => {
                        if (!isKeyboardNavRef.current) {
                          setMentionState((prev) => (prev.selectedIndex === idx ? prev : { ...prev, selectedIndex: idx }));
                        }
                      }}
                      onMouseMove={() => {
                        isKeyboardNavRef.current = false;
                        setMentionState((prev) => (prev.selectedIndex === idx ? prev : { ...prev, selectedIndex: idx }));
                      }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleSelectMention(item);
                      }}
                    >
                      <div className="chat-mention-icon">
                        {item.type === 'special' ? (
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.2"
                          >
                            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                          </svg>
                        ) : (
                          <FileLanguageIcon fileName={item.title.replace(/^@/, '')} />
                        )}
                      </div>
                      <div className="chat-mention-info">
                        <span className="chat-mention-title">{item.title}</span>
                        <span className="chat-mention-desc">{item.desc}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <InputCodeRefOverlay
            ref={textareaRef}
            className="chat-textarea-custom"
            value={activeTab?.input ?? ''}
            style={{
              border: 'none',
              background: 'transparent',
              outline: 'none',
              minHeight: '52px',
              resize: 'none',
              fontSize: 'var(--ui-font-size, 12px)',
            }}
            onOpenFile={onOpenFile}
            placeholder={
              activeTab?.mode === 'ask'
                ? '提问关于代码的问题…（输入 @ 引用上下文，Enter 发送）'
                : activeTab?.mode === 'plan'
                  ? '描述目标，生成可执行计划…（输入 @ 引用上下文，Enter 发送）'
                  : '描述任务…（输入 @ 引用上下文，Enter 发送）'
            }
            onChange={(val) => {
              updateTab(activeTab.id, (t) => ({ ...t, input: val }));

              // 检测 @ mention 触发
              // 从末尾反向找光标位置（onChange 中无法直接获取 selectionStart，取全长近似）
              const cursor = val.length;
              const textBefore = val.slice(0, cursor);
              const match = textBefore.match(/(?:^|\s)@([^\s@]*)$/);
              if (match) {
                setMentionState({
                  isOpen: true,
                  query: match[1],
                  cursorIndex: cursor,
                  selectedIndex: 0,
                });
              } else {
                setMentionState((prev) => (prev.isOpen ? { ...prev, isOpen: false } : prev));
              }
            }}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (mentionState.isOpen && filteredMentions.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  isKeyboardNavRef.current = true;
                  setMentionState((prev) => ({
                    ...prev,
                    selectedIndex: (prev.selectedIndex + 1) % filteredMentions.length,
                  }));
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  isKeyboardNavRef.current = true;
                  setMentionState((prev) => ({
                    ...prev,
                    selectedIndex:
                      (prev.selectedIndex - 1 + filteredMentions.length) % filteredMentions.length,
                  }));
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  const item = filteredMentions[mentionState.selectedIndex] || filteredMentions[0];
                  if (item) {
                    handleSelectMention(item);
                  }
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setMentionState((prev) => ({ ...prev, isOpen: false }));
                  return;
                }
              }

              if (e.key === 'Enter') {
                if ((e.metaKey || e.ctrlKey) && !isComposingRef.current) {
                  // Cmd/Ctrl + Enter: insert newline at cursor (within plainText only)
                  e.preventDefault();
                  const target = e.currentTarget;
                  const start = target.selectionStart;
                  const end = target.selectionEnd;
                  // target.value 是 plainText；activeTab.input 是完整値（含 refs 前缀）
                  const plain = target.value;
                  const fullInput = activeTab.input ?? '';
                  const newPlain = plain.substring(0, start) + '\n' + plain.substring(end);
                  // 保留 refs 前缀（fullInput 头部），替换 plainText 部分
                  const refPart = fullInput.endsWith(plain) ? fullInput.slice(0, fullInput.length - plain.length) : '';
                  updateTab(activeTab.id, (t) => ({ ...t, input: refPart + newPlain }));
                  requestAnimationFrame(() => {
                    target.selectionStart = target.selectionEnd = start + 1;
                  });
                  return;
                }
                if (e.shiftKey) {
                  // Shift + Enter: native newline in textarea
                  return;
                }
                if (!e.shiftKey && !e.metaKey && !e.ctrlKey && !isComposingRef.current) {
                  // Plain Enter: send message
                  e.preventDefault();
                  void send();
                }
              }
            }}
          />
          <div className="chat-input-toolbar">
            <div className="chat-toolbar-left">
              {/* Attachment Button & hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    void processFiles(Array.from(e.target.files));
                    e.target.value = '';
                  }
                }}
              />
              <button
                type="button"
                className="chat-attach-btn"
                title="添加附件（图片/文件）"
                onClick={() => fileInputRef.current?.click()}
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
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.48-8.48" />
                </svg>
              </button>

              {/* Model Selector Dropdown */}
              <div className="chat-model-selector-wrapper" ref={modelDropdownRef}>
                {(() => {
                  const connectedModels = models.filter((m) => m.lastProbeOk === true);
                  const hasConnectedModels = connectedModels.length > 0;

                  // 如果偏好模型连通正常则使用它；若偏好模型未连通且有连通正常的模型，自动选用第一个连通正常的模型
                  const preferredId = activeTab?.modelId || activeModelId;
                  const preferredModel = models.find((m) => m.id === preferredId);

                  let currentModelId = preferredId || (models[0]?.id ?? 'deepseek-local');
                  if (hasConnectedModels) {
                    if (!preferredModel || !preferredModel.lastProbeOk) {
                      currentModelId = connectedModels[0].id;
                    }
                  }

                  const currentModel = models.find((m) => m.id === currentModelId) || models[0];
                  const badge = getProviderBadge(currentModel?.provider);
                  const isCurrentHealthy = currentModel?.lastProbeOk === true;

                  // 连通正常的模型排在最前，未连通的排在后面
                  const sortedModels = [...models].sort((a, b) => {
                    const aOk = a.lastProbeOk === true ? 1 : 0;
                    const bOk = b.lastProbeOk === true ? 1 : 0;
                    return bOk - aOk;
                  });

                  return (
                    <>
                      <button
                        type="button"
                        className="chat-model-selector-btn"
                        onClick={() => setModelDropdownOpen((v) => !v)}
                        title={`当前模型: ${currentModel?.name || currentModelId} (${currentModel?.model || ''})${isCurrentHealthy ? ' [连通正常]' : ' [未通过连通测试]'}`}
                      >
                        <span className="chat-model-dot" style={{ backgroundColor: badge.color }} />
                        <span className="chat-model-name">
                          {currentModel?.name || currentModelId}
                        </span>
                        <span className="chat-model-arrow">▾</span>
                      </button>

                      {modelDropdownOpen && (
                        <div className="chat-model-dropdown-menu">
                          <div className="chat-model-dropdown-header">
                            <span>选择大模型</span>
                            <button
                              type="button"
                              className="chat-model-settings-link"
                              onClick={() => {
                                setModelDropdownOpen(false);
                                onOpenSettings?.();
                              }}
                            >
                              ⚙ 管理模型
                            </button>
                          </div>
                          {!hasConnectedModels && (
                            <div className="chat-model-dropdown-alert">
                              ⚠️ 暂无连通正常的模型，请点击右上角【管理模型】测试连通性。
                            </div>
                          )}
                          <div className="chat-model-dropdown-list">
                            {sortedModels.map((m, idx) => {
                              const isHealthy = m.lastProbeOk === true;
                              const isSelected = m.id === currentModelId;
                              const mBadge = getProviderBadge(m.provider);
                              // 只要有连通正常的模型，未通过连通测试的模型完全不可选
                              const isDisabled = hasConnectedModels && !isHealthy;
                              const showDivider =
                                hasConnectedModels &&
                                !isHealthy &&
                                (idx === 0 || sortedModels[idx - 1].lastProbeOk === true);

                              return (
                                <React.Fragment key={m.id}>
                                  {showDivider && (
                                    <div className="chat-model-dropdown-divider">
                                      <span>未通过连通测试 (不可选)</span>
                                    </div>
                                  )}
                                  <div
                                    className={`chat-model-dropdown-item${isSelected ? ' selected' : ''}${isDisabled ? ' disabled' : ''}`}
                                    title={
                                      isDisabled
                                        ? '该模型未通过连通测试，不可选择。请前往【管理模型】测试通过后再使用。'
                                        : isHealthy
                                          ? '连通测试正常，可选用'
                                          : undefined
                                    }
                                    onClick={() => {
                                      if (isDisabled) return;
                                      updateTab(activeTab.id, (t) => ({ ...t, modelId: m.id }));
                                      onActiveModelChange?.(m.id);
                                      setModelDropdownOpen(false);
                                    }}
                                  >
                                    <div className="chat-model-item-left">
                                      <span
                                        className="chat-model-item-dot"
                                        style={{ backgroundColor: mBadge.color }}
                                      />
                                      <div className="chat-model-item-meta">
                                        <div className="chat-model-item-name-row">
                                          <span className="chat-model-item-title" title={m.name}>
                                            {m.name}
                                          </span>
                                          <span
                                            className="chat-model-provider-badge"
                                            style={{
                                              color: mBadge.color,
                                              backgroundColor: mBadge.bg,
                                            }}
                                          >
                                            {mBadge.label}
                                          </span>
                                        </div>
                                        <div className="chat-model-item-sub">
                                          {m.model} {m.enableThinking ? '· 思考模式' : ''}
                                        </div>
                                      </div>
                                    </div>
                                    <div className="chat-model-status-group">
                                      {isHealthy ? (
                                        <span className="chat-model-connected-badge">
                                          ● 正常
                                        </span>
                                      ) : (
                                        <span className="chat-model-untested-badge">
                                          未连通·不可选
                                        </span>
                                      )}
                                      {isSelected && <span className="chat-model-check">✓</span>}
                                    </div>
                                  </div>
                                </React.Fragment>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>

              {/* Mode Selector（自定义下拉，与模型选择同款外观） */}
              <ChatToolbarPill
                value={activeTab?.mode || 'agent'}
                disabled={!!activeTab?.runId}
                title={`模式: ${MODE_LABEL[activeTab?.mode || 'agent']}`}
                options={[
                  { value: 'agent', label: 'Agent' },
                  { value: 'ask', label: 'Ask' },
                  { value: 'plan', label: 'Plan' },
                ]}
                onChange={(mode) => updateTab(activeTab.id, (t) => ({ ...t, mode }))}
              />

              {/* Permission Selector（自定义下拉，与模型选择同款外观） */}
              <ChatToolbarPill
                value={permissionMode}
                title={`权限: ${PERMISSION_MODE_LABELS[permissionMode]}`}
                options={PERMISSION_ORDER.map((m) => ({
                  value: m,
                  label: PERMISSION_SHORT_LABELS[m],
                }))}
                onChange={(m) => onPermissionModeChange(m)}
              />

              {/* .echolyrules 项目规则指示器 */}
              <button
                type="button"
                className="chat-pill-btn echolyrules-pill"
                title={
                  hasRules
                    ? '项目规则 (.echolyrules): 已生效，点击打开编辑'
                    : '项目规则: 未设置，点击创建 .echolyrules 项目规则文件'
                }
                onClick={() => void handleOpenOrInitRules()}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 9999,
                  border: hasRules ? '1px solid rgba(168, 85, 247, 0.4)' : '1px solid var(--border)',
                  background: hasRules ? 'rgba(168, 85, 247, 0.12)' : 'transparent',
                  color: hasRules ? '#c084fc' : 'var(--text-secondary)',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  flexShrink: 0,
                }}
              >
                <span style={{ fontSize: 10, color: hasRules ? '#a855f7' : 'inherit' }}>✦</span>
                <span style={{ fontWeight: 500 }}>.echolyrules</span>
                {hasRules && (
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: '50%',
                      backgroundColor: '#10b981',
                      display: 'inline-block',
                    }}
                  />
                )}
              </button>
            </div>

            <div className="chat-toolbar-right">
              {/* Context progress circle */}
              {windowTokens > 0 && (
                <div
                  title={`上下文使用率: ${usagePct.toFixed(0)}% (${formatTokens(usedTokens)} / ${formatTokens(windowTokens)})`}
                  style={{
                    position: 'relative',
                    width: 14,
                    height: 14,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <svg
                    viewBox="0 0 36 36"
                    style={{ width: 15, height: 15, transform: 'rotate(-90deg)' }}
                  >
                    <path
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      fill="none"
                      stroke="rgba(255, 255, 255, 0.1)"
                      strokeWidth="4"
                    />
                    <path
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="4"
                      strokeDasharray={`${usagePct}, 100`}
                    />
                  </svg>
                </div>
              )}
              {/* Send / Stop */}
              {activeTab?.runId ? (
                <button
                  type="button"
                  className="chat-action-circle-btn stop"
                  onClick={() => void cancel()}
                  title="停止"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" ry="2" />
                  </svg>
                </button>
              ) : (
                <button
                  type="button"
                  className="chat-action-circle-btn send"
                  onClick={() => void send()}
                  title="发送"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* History Session Modal */}
      {showHistoryModal && (
        <SessionModal
          currentSessionId={activeTabId}
          activeSessionIds={tabs.map((t) => t.id)}
          onSelectSession={handleLoadSessionFromModal}
          onNewSession={handleDeleteCurrentSessionAndOpenNew}
          onRenameSession={handleRenameSession}
          onClose={() => setShowHistoryModal(false)}
        />
      )}

      {/* Image Lightbox Modal */}
      {previewImage && (
        <div className="chat-image-lightbox" onClick={() => setPreviewImage(null)}>
          <div className="chat-image-lightbox-content" onClick={(e) => e.stopPropagation()}>
            <img src={previewImage} alt="Preview" />
            <button
              type="button"
              className="chat-image-lightbox-close"
              onClick={() => setPreviewImage(null)}
              title="关闭"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export const ChatPanel = forwardRef(ChatPanelComponent);
