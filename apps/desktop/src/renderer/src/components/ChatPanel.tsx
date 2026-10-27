import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  AgentEvent,
  AgentMode,
  AgentRunStatus,
  ChatAttachment,
  ChatMessageMetrics,
  ChatSession,
  ChatSessionMessage,
  CheckpointSummary,
  ConfirmRequest,
  ModelProfile,
  PermissionMode,
  PlanProposal,
  PendingDiff,
  WorkspaceInfo,
  RecentWorkspaceItem,
  BrowserElementRef,
  SlashCommandInfo,
} from '@deepseek-ide/shared';
import { renderCommand } from '@deepseek-ide/shared';
import { buildSessionWorkspaceMeta, isCustomSessionTitle, uid } from '../utils';
import { buildAgentHistory } from '../chatHistory';
import { MarkdownMessage } from './MarkdownMessage';
import { PlanPanel } from './PlanPanel';
import { SessionModal } from './SessionModal';
import { useDbConfirm } from '../hooks/useDbConfirm';
import { buildSqlConfirmMarkdown } from '../services/dbConfirmContent';
import { showGlobalToast } from '../services/toast';
import { resolveSpecialMentions } from '../services/specialMentions';
import { translateSegments, useI18n, type Translate } from '../i18n';
import {
  expandCommandSelection,
  matchMentionTrigger,
  matchSlashTrigger,
} from '../services/slashTrigger';
import { ThinkingBlock } from './ThinkingBlock';
import { WorkedForGroup } from './chat/WorkedForGroup';
import { CollapsibleUserContent } from './chat/CollapsibleUserContent';
import { InputCodeRefOverlay, type InputCodeRefOverlayHandle } from './chat/InputCodeRefOverlay';
import { FileLanguageIcon } from './chat/CodeRefPill';
import { ModelMetricsBadge } from './chat/ModelMetricsBadge';
import { TurnCheckpointBar } from './chat/TurnCheckpointBar';
import { PanelChevron } from './PanelChevron';
import { computeLineDiffStats } from '../services/diffStats';
import echolyAppIcon from '../assets/echoly-icon.png';

interface MentionItem {
  id: string;
  type: 'special' | 'file' | 'command';
  title: string;
  desc: string;
  path?: string;
  insertText: string;
  /** 命令项专用：展开后的正文。选中时替换掉 `/name` 而不是插入名字。 */
  commandBody?: string;
  /** 命令项的来源标记（工作区 / 用户）。 */
  badge?: string;
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
  /** 撤销完成后同步宿主状态：参数是实际被还原的文件路径。 */
  onRevertTurn?: (revertedPaths: string[]) => void | Promise<void>;
  onSelectDiff?: (id: string) => void;
  onOpenFile?: (path: string, line?: number, endLine?: number) => void;
  onOpenSettings?: () => void;
  onSwitchWorkspace?: (path: string) => void;
  models?: ModelProfile[];
  activeModelId?: string;
  onActiveModelChange?: (modelId: string) => void;
  recentWorkspaces?: RecentWorkspaceItem[];
}

export type ChatPanelHandle = {
  insertPath: (path: string) => void;
  startFreshWithPath: (path: string) => void;
  clearAndNewSession: () => void;
  askQuestion: (prompt: string, autoSubmit?: boolean) => void;
  focusInput: () => void;
  addBrowserElementRef?: (ref: BrowserElementRef) => void;
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
  streamingMsgId?: string;
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

/** 权限短标签走动态 key（`chat.permShort.*`），由调用方传入 t 渲染。 */
function permissionShortLabel(t: Translate, mode: PermissionMode): string {
  return t(`chat.permShort.${mode}`);
}

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
        <PanelChevron expanded={open} size={10} style={{ opacity: 0.6, marginLeft: 3 }} />
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

const STICK_BOTTOM_THRESHOLD_PX = 8;

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

/** 特殊引用（@Git / @Terminal / @Problems）附件在气泡里的图标与配色。 */
const SPECIAL_MENTION_STYLE: Record<
  string,
  { icon: string; color: string; border: string; bg: string }
> = {
  '@Git': {
    icon: '🌳',
    color: '#4ade80',
    border: 'rgba(74, 222, 128, 0.4)',
    bg: 'rgba(74, 222, 128, 0.08)',
  },
  '@Terminal': {
    icon: '▶',
    color: '#fbbf24',
    border: 'rgba(251, 191, 36, 0.4)',
    bg: 'rgba(251, 191, 36, 0.08)',
  },
  '@Problems': {
    icon: '⚠',
    color: '#f87171',
    border: 'rgba(248, 113, 113, 0.4)',
    bg: 'rgba(248, 113, 113, 0.08)',
  },
};

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
    onRevertTurn,
    onSelectDiff,
    onOpenFile,
    onOpenSettings,
    onSwitchWorkspace,
    models = [],
    activeModelId,
    onActiveModelChange,
    recentWorkspaces,
  } = props;
  // 面板里有大量中文注释与日志（不翻译），这里只接用户可见文案
  const { t, locale } = useI18n();
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
  /**
   * runId → 该轮文件改动的写前记录摘要。
   *
   * 主进程存的是真正可回放的数据，这里只缓存「有没有、几个、是否可完整撤销」，
   * 用来决定每轮气泡下那个「撤销本轮改动」按钮出不出现。
   * `null` 表示查过了：这一轮没有可撤销的改动（例如纯问答），按钮不显示。
   */
  const [checkpoints, setCheckpoints] = useState<Record<string, CheckpointSummary | null>>({});
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  // 清空对话等不可逆操作走应用内确认框（系统 window.confirm 不是应用主题色，也没法列出影响范围）
  const confirm = useDbConfirm();
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
  const [exported, setExported] = useState(false);
  const stickRef = useRef(true);
  const userInteractingRef = useRef(false);
  const userInteractTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isProgrammaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);

  // 当全屏大图预览打开时，支持按 Esc 键关闭
  useEffect(() => {
    if (!previewImage) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setPreviewImage(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [previewImage]);

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
          const firstUserSnippet = firstUserMsg ? firstUserMsg.content.slice(0, 40) : '';
          // 判定收在 utils.isCustomSessionTitle 里（原先这段在 5 处各抄一遍，
          // 而它比较的 `'当前对话'` 是哨兵值，漏改一处就会静默失灵）
          const isCustom = isCustomSessionTitle(
            updated.title,
            firstUserSnippet,
            updated.customTitle,
          );

          const title = isCustom ? updated.title : firstUserSnippet || updated.title;
          const meta = buildSessionWorkspaceMeta(workspaceInfoRef.current);
          void window.ide.saveSession({
            id: updated.id,
            title,
            customTitle: isCustom,
            messages: updated.messages,
            updatedAt: Date.now(),
            ...meta,
          });
        }
        return updated;
      }),
    );
  }, []);

  /**
   * 回退到某条用户消息：把这条之后的消息全部丢弃。
   *
   * 只在**确实有东西可丢**时才确认：它是最后一条消息的话，回退不过是把文字挪回输入框，
   * 没有任何损失；但若后面已经攒了若干轮 AI 回复（尤其是还在跑的那一轮），
   * 这一次点击就是不可逆地删掉它们。
   */
  const handleRollbackUserMessage = useCallback(
    async (msg: ChatSessionMessage) => {
      const currentTabId = activeTabIdRef.current;
      if (!currentTabId) return;
      const targetTab = tabsRef.current.find((t) => t.id === currentTabId);
      const allMessages = targetTab?.messages ?? [];
      const idx = allMessages.findIndex((mm) => mm.id === msg.id);
      const droppedCount = idx >= 0 ? allMessages.length - idx - 1 : 0;
      const hasRunning = Boolean(targetTab?.runId);
      if (droppedCount > 0 || hasRunning) {
        const ok = await confirm.confirm({
          title: t('chat.rollbackTitle'),
          content: buildSqlConfirmMarkdown({
            t,
            intro: t('chat.rollbackIntro'),
            statements: [],
            notes: [t('chat.rollbackNote')],
          }),
          details: [
            {
              label: t('chat.rollbackDropped'),
              value: t('chat.rollbackDroppedValue', { n: droppedCount }),
            },
            ...(hasRunning
              ? [{ label: t('chat.rollbackRunning'), value: t('chat.rollbackRunningValue') }]
              : []),
          ],
          tone: 'danger',
          confirmLabel: t('chat.rollbackConfirm'),
        });
        if (ok === null) return;
      }
      if (targetTab?.runId) {
        void window.ide.cancelAgent(targetTab.runId);
      }
      updateTab(currentTabId, (t) => {
        const i = t.messages.findIndex((mm) => mm.id === msg.id);
        const truncated = i >= 0 ? t.messages.slice(0, i) : t.messages;
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
    [updateTab, confirm, t],
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
            showGlobalToast(t('chat.fileTooLarge20', { name: file.name }), 'warn');
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
            showGlobalToast(t('chat.fileTooLarge5', { name: file.name }), 'warn');
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
    [updateTab, t],
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

  /**
   * 把浏览器元素引用追加到当前会话输入框与附件列表。
   *
   * 同一元素（同一页面 + 同一选择器）重复引用时不再重复追加附件：
   * 反复点击页面上的同一节点只会往输入框里堆叠相同的 @Element 令牌与附件，
   * 既挤占上下文，也让用户难以清理。此时改为提示已存在并跳过。
   */
  const appendBrowserElementRef = useCallback(
    (tabId: string, elementRef: BrowserElementRef) => {
      const label = `<${elementRef.tagName}${elementRef.id ? '#' + elementRef.id : ''}>`;
      const token = `@Element[${label}]`;

      let duplicated = false;
      updateTab(tabId, (t) => {
        const exists = (t.attachments || []).some(
          (a) =>
            a.type === 'browser-element' &&
            a.browserElement?.selectorPath === elementRef.selectorPath &&
            a.browserElement?.url === elementRef.url,
        );
        if (exists) {
          duplicated = true;
          return t;
        }
        const trimmed = t.input.trimEnd();
        return {
          ...t,
          input: !trimmed ? `${token} ` : `${trimmed} ${token} `,
          attachments: [
            ...(t.attachments || []),
            {
              id: uid(),
              name: label,
              type: 'browser-element' as const,
              content: elementRef.outerHtml,
              browserElement: elementRef,
            },
          ],
        };
      });

      if (duplicated) {
        window.dispatchEvent(
          new CustomEvent('echoly:toast', {
            detail: { message: t('chat.elementExists'), type: 'info' },
          }),
        );
      }

      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          const len = (textareaRef.current.value ?? '').length;
          textareaRef.current.setSelectionRange(len, len);
        }
      }, 50);
    },
    [updateTab, t],
  );

  /** 把整个浏览器页面引用追加到当前会话（同一页面地址不重复引用） */
  const appendBrowserPageRef = useCallback(
    (tabId: string, pageInfo: { url: string; title: string; errors?: string[] }) => {
      const token = `@Browser[${pageInfo.title} - ${pageInfo.url}]`;
      let duplicated = false;
      updateTab(tabId, (t) => {
        const exists = (t.attachments || []).some(
          (a) => a.type === 'browser-page' && a.browserPage?.url === pageInfo.url,
        );
        if (exists) {
          duplicated = true;
          return t;
        }
        const trimmed = t.input.trimEnd();
        return {
          ...t,
          input: !trimmed ? `${token} ` : `${trimmed} ${token} `,
          attachments: [
            ...(t.attachments || []),
            {
              id: uid(),
              name: pageInfo.title || pageInfo.url,
              type: 'browser-page' as const,
              browserPage: pageInfo,
            },
          ],
        };
      });

      if (duplicated) {
        window.dispatchEvent(
          new CustomEvent('echoly:toast', {
            detail: { message: t('chat.pageExists'), type: 'info' },
          }),
        );
      }

      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          const len = (textareaRef.current.value ?? '').length;
          textareaRef.current.setSelectionRange(len, len);
        }
      }, 50);
    },
    [updateTab, t],
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
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    const hasSelection = Boolean(
      sel &&
      !sel.isCollapsed &&
      sel.rangeCount > 0 &&
      ((sel.anchorNode &&
        (el.contains(sel.anchorNode) ||
          (sel.anchorNode.parentElement && el.contains(sel.anchorNode.parentElement)))) ||
        (sel.focusNode &&
          (el.contains(sel.focusNode) ||
            (sel.focusNode.parentElement && el.contains(sel.focusNode.parentElement))))),
    );
    if (!force && (!stickRef.current || userInteractingRef.current || hasSelection)) return;
    isProgrammaticScrollRef.current = true;
    if (programmaticScrollTimerRef.current) clearTimeout(programmaticScrollTimerRef.current);
    el.scrollTop = el.scrollHeight;
    programmaticScrollTimerRef.current = setTimeout(() => {
      isProgrammaticScrollRef.current = false;
    }, 60);
  }, []);

  /** Bring the new user turn into view; stick-to-bottom keeps following the reply
   *  while CSS sticky holds the user bubble at the top (file-tree folder style). */
  const scrollToUserMsg = useCallback((msgId: string) => {
    stickRef.current = true;
    userInteractingRef.current = false;
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

  /**
   * `/` 命令状态。
   *
   * 与 `@` 分开一个 state，而不是给 mentionState 加一个 `trigger` 字段：
   * 两者的**插入行为不同**（`@` 插入引用文本，`/` 用模板正文替换掉命令名），
   * 混在一起后每处用到的地方都要多一次判断，而这些判断迟早会漏。
   */
  const [commandState, setCommandState] = useState<{
    isOpen: boolean;
    query: string;
    cursorIndex: number;
    selectedIndex: number;
  }>({ isOpen: false, query: '', cursorIndex: 0, selectedIndex: 0 });
  const commandListRef = useRef<HTMLDivElement>(null);
  const commandPopoverRef = useRef<HTMLDivElement>(null);
  const [commands, setCommands] = useState<SlashCommandInfo[]>([]);

  // 命令是纯文本文件，每次都重新扫一遍：读盘成本远低于「新建了命令却要重启才看到」的困惑。
  const refreshCommands = useCallback(async () => {
    try {
      const list = await window.ide.listCommands();
      setCommands(list ?? []);
      return list ?? [];
    } catch {
      setCommands([]);
      return [];
    }
  }, []);

  // 挂载时拉一次，切换工作区后再拉一次 —— 命令是跟着工作区走的
  useEffect(() => {
    void refreshCommands();
  }, [refreshCommands, props.workspace]);

  // 弹窗打开的瞬间再扫一次盘：用户往往是「刚写完命令文件就切回来试」，
  // 只靠挂载时那一次会让人以为没生效。
  useEffect(() => {
    if (commandState.isOpen) void refreshCommands();
    // 只在「刚打开」这一刻触发，query 变化不必重扫
  }, [commandState.isOpen, refreshCommands]);

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
    if (!mentionState.isOpen && !commandState.isOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (mentionPopoverRef.current?.contains(target)) return;
      if (commandPopoverRef.current?.contains(target)) return;
      if (textareaRef.current?.contains(target)) return;
      setMentionState((prev) => (prev.isOpen ? { ...prev, isOpen: false } : prev));
      setCommandState((prev) => (prev.isOpen ? { ...prev, isOpen: false } : prev));
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [mentionState.isOpen, commandState.isOpen]);

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
        desc: t('chat.currentFileDesc', { path: currentPath }),
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
        desc: t('chat.mentionGitDesc'),
        insertText: '@Git ',
      },
      {
        id: 'special:terminal',
        type: 'special',
        title: '@Terminal',
        desc: t('chat.mentionTerminalDesc'),
        insertText: '@Terminal ',
      },
      {
        id: 'special:problems',
        type: 'special',
        title: '@Problems',
        desc: t('chat.mentionProblemsDesc'),
        insertText: '@Problems ',
      },
    );

    return list;
  }, [cursor?.path, openFiles, missingPaths, t]);

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
      const trigger = matchMentionTrigger(textBefore);
      if (!trigger) return;
      const atIdx = trigger.start;
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
    },
    [activeTab?.id, activeTab?.input, mentionState.cursorIndex],
  );

  /**
   * 命令候选项。
   *
   * 与 `@` 的文件项不同，这里**不做存在性校验** —— 命令来自刚扫过的磁盘，
   * 少了它只意味着下拉里少一行，不会让已插入的引用变成死链接。
   */
  const commandCandidates = useMemo<MentionItem[]>(
    () =>
      commands.map((c) => ({
        id: `command:${c.source}:${c.name}`,
        type: 'command',
        title: `/${c.name}`,
        desc: c.description,
        insertText: `/${c.name} `,
        commandBody: c.body,
        badge:
          c.source === 'workspace' ? t('chat.commandBadgeWorkspace') : t('chat.commandBadgeUser'),
      })),
    [commands, t],
  );

  const filteredCommands = useMemo(() => {
    if (!commandState.isOpen) return [];
    const q = commandState.query.toLowerCase().trim();
    if (!q) return commandCandidates;
    // 同时匹配名字与描述：模板的描述往往比名字更能说明它是干什么的
    return commandCandidates.filter(
      (item) => item.title.toLowerCase().includes(q) || item.desc.toLowerCase().includes(q),
    );
  }, [commandState.isOpen, commandState.query, commandCandidates]);

  /**
   * 选中命令：用模板正文**替换掉** `/name` 与游标到行尾的这段输入。
   *
   * 参数提取用的是命令名之后、`/name` 所在行的剩余文本。之所以按行而不是按整段输入：
   * 用户常常先写一句需求，再另起一行敲 `/review src/a.ts`，此时前面那句不该被当成参数。
   */
  const handleSelectCommand = useCallback(
    (item: MentionItem) => {
      const input = activeTab?.input ?? '';
      if (!item.commandBody) {
        setCommandState({ isOpen: false, query: '', cursorIndex: 0, selectedIndex: 0 });
        return;
      }
      const trigger = matchSlashTrigger(input.slice(0, commandState.cursorIndex));
      if (!trigger) {
        setCommandState({ isOpen: false, query: '', cursorIndex: 0, selectedIndex: 0 });
        return;
      }
      // 参数是命令名之后、同一行的剩余文本
      const textAfter = input.slice(commandState.cursorIndex);
      const newlineAt = textAfter.indexOf('\n');
      const rawArgs = newlineAt < 0 ? textAfter : textAfter.slice(0, newlineAt);
      const expanded = renderCommand({ body: item.commandBody }, rawArgs);
      const { next, cursor } = expandCommandSelection({
        input,
        cursorIndex: commandState.cursorIndex,
        expanded,
      });
      updateTab(activeTab.id, (t) => ({ ...t, input: next }));
      setCommandState({ isOpen: false, query: '', cursorIndex: 0, selectedIndex: 0 });
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(cursor, cursor);
        }
      }, 20);
    },
    [activeTab?.id, activeTab?.input, commandState.cursorIndex],
  );

  /**
   * 两个弹窗（`@` 与 `/`）共用一套「候选列表」语义。
   *
   * 键盘导航、高亮滚动、点击采纳这三件事在两处是完全一样的，各写一遍迟早会分叉
   * （比如只给其中一个加了 Tab 采纳）。这里收敛成一份：同一时刻至多有一个弹窗是开的，
   * 渲染与按键处理都只认下面这几个派生值。
   *
   * 命令优先，且**哪怕一个命令都没有也要开**：空列表时弹出的引导文案是用户
   * 发现这个功能的唯一途径，静默什么都不显示等于功能不存在。
   */
  const suggestMode: 'mention' | 'command' | null = commandState.isOpen
    ? 'command'
    : mentionState.isOpen && filteredMentions.length > 0
      ? 'mention'
      : null;
  const suggestItems =
    suggestMode === 'command'
      ? filteredCommands
      : suggestMode === 'mention'
        ? filteredMentions
        : [];
  const suggestIndex =
    suggestMode === 'command' ? commandState.selectedIndex : mentionState.selectedIndex;
  const suggestListRef = suggestMode === 'command' ? commandListRef : mentionListRef;

  const setSuggestIndex = useCallback(
    (idx: number) => {
      if (suggestMode === 'command') {
        setCommandState((prev) =>
          prev.selectedIndex === idx ? prev : { ...prev, selectedIndex: idx },
        );
      } else if (suggestMode === 'mention') {
        setMentionState((prev) =>
          prev.selectedIndex === idx ? prev : { ...prev, selectedIndex: idx },
        );
      }
    },
    [suggestMode],
  );

  const closeSuggest = useCallback(() => {
    setMentionState((prev) => (prev.isOpen ? { ...prev, isOpen: false } : prev));
    setCommandState((prev) => (prev.isOpen ? { ...prev, isOpen: false } : prev));
  }, []);

  const handleSelectSuggest = useCallback(
    (item: MentionItem) => {
      if (suggestMode === 'command') handleSelectCommand(item);
      else handleSelectMention(item);
    },
    [suggestMode, handleSelectCommand, handleSelectMention],
  );

  // 当上下键切换或弹窗打开时，自动滚动将当前高亮项保持在可视范围内
  useEffect(() => {
    if (suggestMode && suggestListRef.current) {
      const activeEl = suggestListRef.current.querySelector(
        '.chat-mention-item.active',
      ) as HTMLElement | null;
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [suggestIndex, suggestMode, suggestListRef]);

  useEffect(() => {
    if (lastUserMsgId && lastUserMsgId !== prevLastUserMsgIdRef.current) {
      prevLastUserMsgIdRef.current = lastUserMsgId;
      scrollToUserMsg(lastUserMsgId);
    }
  }, [lastUserMsgId, scrollToUserMsg]);

  const jumpToLatest = useCallback(() => {
    userInteractingRef.current = false;
    stickRef.current = true;
    setShowJumpLatest(false);
    scrollToBottom(true);
  }, [scrollToBottom]);

  useEffect(() => {
    const el = messagesElRef.current;
    if (!el) return;

    const hasUserSelection = () => {
      const sel = typeof window !== 'undefined' ? window.getSelection() : null;
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
      const anchor = sel.anchorNode;
      const focus = sel.focusNode;
      return Boolean(
        (anchor &&
          (el.contains(anchor) || (anchor.parentElement && el.contains(anchor.parentElement)))) ||
        (focus &&
          (el.contains(focus) || (focus.parentElement && el.contains(focus.parentElement)))),
      );
    };

    const onSelectionChange = () => {
      if (hasUserSelection()) {
        userInteractingRef.current = true;
      }
    };
    document.addEventListener('selectionchange', onSelectionChange);

    let isMouseDown = false;
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 0) {
        isMouseDown = true;
        userInteractingRef.current = true;
      }
    };

    const onWindowMouseUp = () => {
      if (!isMouseDown) return;
      isMouseDown = false;
      if (userInteractTimerRef.current) clearTimeout(userInteractTimerRef.current);
      userInteractTimerRef.current = setTimeout(() => {
        if (!hasUserSelection()) {
          userInteractingRef.current = false;
        }
      }, 500);
    };

    const onWheel = (e: WheelEvent) => {
      userInteractingRef.current = true;
      if (userInteractTimerRef.current) clearTimeout(userInteractTimerRef.current);
      userInteractTimerRef.current = setTimeout(() => {
        if (!hasUserSelection()) {
          userInteractingRef.current = false;
        }
      }, 250);

      if (e.deltaY < 0) {
        // 用户向上滚轮（主动查阅历史）：立即解除吸底并展示「回到最新」按钮
        stickRef.current = false;
        setShowJumpLatest((prev) => (prev ? prev : true));
      } else if (e.deltaY > 0) {
        // 向下滚轮：仅当真正触碰最底边缘（<= 8px）时才恢复吸底
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distance <= STICK_BOTTOM_THRESHOLD_PX) {
          stickRef.current = true;
          setShowJumpLatest((prev) => (prev ? false : prev));
        }
      }
    };

    let touchStartY = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? 0;
      userInteractingRef.current = true;
    };
    const onTouchMove = (e: TouchEvent) => {
      userInteractingRef.current = true;
      if (userInteractTimerRef.current) clearTimeout(userInteractTimerRef.current);
      userInteractTimerRef.current = setTimeout(() => {
        if (!hasUserSelection()) {
          userInteractingRef.current = false;
        }
      }, 250);

      const currentY = e.touches[0]?.clientY ?? 0;
      const deltaY = touchStartY - currentY;
      if (deltaY < 0) {
        // 手指向下拉（查阅历史）：立即解除吸底
        stickRef.current = false;
        setShowJumpLatest((prev) => (prev ? prev : true));
      } else if (deltaY > 0) {
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distance <= STICK_BOTTOM_THRESHOLD_PX) {
          stickRef.current = true;
          setShowJumpLatest((prev) => (prev ? false : prev));
        }
      }
    };
    const onTouchEnd = () => {
      if (userInteractTimerRef.current) clearTimeout(userInteractTimerRef.current);
      userInteractTimerRef.current = setTimeout(() => {
        if (!hasUserSelection()) {
          userInteractingRef.current = false;
        }
      }, 250);
    };

    const onScroll = () => {
      if (isProgrammaticScrollRef.current) {
        return;
      }
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distance <= STICK_BOTTOM_THRESHOLD_PX;

      if (userInteractingRef.current || hasUserSelection()) {
        // 用户主动滚动交互或正在选中文本：以用户意图为最高准则
        if (atBottom) {
          stickRef.current = true;
          setShowJumpLatest((prev) => (prev ? false : prev));
        } else {
          stickRef.current = false;
          setShowJumpLatest((prev) => (prev ? prev : true));
        }
        return;
      }

      // 用户未主动滚动（当前由 AI 流式吐字或内容渲染触发）：
      if (atBottom) {
        stickRef.current = true;
        setShowJumpLatest((prev) => (prev ? false : prev));
      } else if (!stickRef.current) {
        // 用户此前已主动上滑脱离了底部，保持脱离状态并提示「回到最新」
        setShowJumpLatest((prev) => (prev ? prev : true));
      } else {
        // 关键保障：此前本就处于吸底状态，distance 变大纯粹是 AI 正在流式输出使得内容撑高！
        // 绝不误杀 stickRef，并确保滚动条平滑紧跟最新内容
        scrollToBottom();
      }
    };

    let mutationRafId: number | null = null;
    let lastKnownScrollHeight = el.scrollHeight;

    const observer = new MutationObserver(() => {
      if (
        !stickRef.current ||
        userInteractingRef.current ||
        isProgrammaticScrollRef.current ||
        hasUserSelection()
      ) {
        lastKnownScrollHeight = el.scrollHeight;
        return;
      }

      if (el.scrollHeight !== lastKnownScrollHeight) {
        lastKnownScrollHeight = el.scrollHeight;
        if (mutationRafId !== null) cancelAnimationFrame(mutationRafId);
        mutationRafId = requestAnimationFrame(() => {
          mutationRafId = null;
          if (
            stickRef.current &&
            !userInteractingRef.current &&
            !hasUserSelection() &&
            messagesElRef.current
          ) {
            isProgrammaticScrollRef.current = true;
            messagesElRef.current.scrollTop = messagesElRef.current.scrollHeight;
            if (programmaticScrollTimerRef.current)
              clearTimeout(programmaticScrollTimerRef.current);
            programmaticScrollTimerRef.current = setTimeout(() => {
              isProgrammaticScrollRef.current = false;
            }, 60);
          }
        });
      }
    });

    observer.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    el.addEventListener('mousedown', onMouseDown, { passive: true });
    window.addEventListener('mouseup', onWindowMouseUp, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      observer.disconnect();
      if (mutationRafId !== null) cancelAnimationFrame(mutationRafId);
      document.removeEventListener('selectionchange', onSelectionChange);
      el.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onWindowMouseUp);
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      if (programmaticScrollTimerRef.current) clearTimeout(programmaticScrollTimerRef.current);
      if (userInteractTimerRef.current) clearTimeout(userInteractTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (stickRef.current) {
      scrollToBottom();
    }
  }, [
    activeTab?.messages,
    activeTab?.streaming,
    activeTab?.thinkingStreaming,
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

    addBrowserElementRef(elementRef: BrowserElementRef) {
      const currentTabId = activeTabIdRef.current;
      if (!currentTabId) return;
      appendBrowserElementRef(currentTabId, elementRef);
    },
  }));

  // 全局接收浏览器标签/元素引用
  useEffect(() => {
    const handleElementRef = (e: Event) => {
      const detail = (e as CustomEvent)?.detail as BrowserElementRef | undefined;
      if (!detail) return;
      const currentTabId = activeTabIdRef.current;
      if (!currentTabId) return;
      appendBrowserElementRef(currentTabId, detail);
    };

    const handlePageRef = (e: Event) => {
      const detail = (e as CustomEvent)?.detail as
        { url: string; title: string; errors?: string[] } | undefined;
      if (!detail) return;
      const currentTabId = activeTabIdRef.current;
      if (!currentTabId) return;
      appendBrowserPageRef(currentTabId, detail);
    };

    const handleAskQuestion = (e: Event) => {
      const detail = (e as CustomEvent)?.detail as
        { prompt: string; autoSubmit?: boolean } | undefined;
      if (!detail?.prompt) return;
      const currentTabId = activeTabIdRef.current;
      if (!currentTabId) return;
      updateTab(currentTabId, (t) => ({ ...t, input: detail.prompt }));
      setTimeout(() => {
        if (detail.autoSubmit) {
          void send();
        } else if (textareaRef.current) {
          textareaRef.current.focus();
          const len = (textareaRef.current.value ?? '').length;
          textareaRef.current.setSelectionRange(len, len);
        }
      }, 50);
    };

    window.addEventListener('echoly:addBrowserElementRefToChat', handleElementRef);
    window.addEventListener('echoly:addBrowserRefToChat', handlePageRef);
    window.addEventListener('echoly:askChatQuestion', handleAskQuestion);

    return () => {
      window.removeEventListener('echoly:addBrowserElementRefToChat', handleElementRef);
      window.removeEventListener('echoly:addBrowserRefToChat', handlePageRef);
      window.removeEventListener('echoly:askChatQuestion', handleAskQuestion);
    };
  }, [updateTab, appendBrowserElementRef, appendBrowserPageRef]);

  const prevWorkspaceRef = useRef<string | undefined>(workspace);
  const pendingLoadSessionRef = useRef<{ session: ChatSession; path: string } | null>(null);

  const sessionToTab = useCallback((session: ChatSession): SessionTab => {
    const firstUser = session.messages?.find((m) => m.role === 'user');
    const firstUserSnippet = firstUser ? firstUser.content.slice(0, 40) : '';
    const isCustom = isCustomSessionTitle(session.title, firstUserSnippet, session.customTitle);

    return {
      id: session.id,
      title: session.title,
      customTitle: isCustom,
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
        onMessagesChangeRef.current?.([]);
        onSessionChangeRef.current?.(reset.id);
        setShowHistoryModal(false);
        setPreviewImage(null);
      }
    }
    prevWorkspaceRef.current = workspace;
  }, [workspace, workspaceInfo?.root, workspaceInfo?.label, sessionToTab]);

  /**
   * 刷新某轮（或全部已知轮次）的撤销可用性。
   *
   * 只在「一轮结束」和「撤销完成后」这两个时点查：checkpoint 的 status 在主进程里
   * 随写入变化，但按钮的可用状态只在用户能看到结果之后才有意义，逐次工具调用去轮询
   * 只会给每条 tool_result 增加一次 IPC 往返。
   */
  const refreshCheckpoints = useCallback(async (runIds: string[]) => {
    if (runIds.length === 0) return;
    const entries = await Promise.all(
      runIds.map(async (id) => {
        try {
          return [id, await window.ide.getCheckpointSummary(id)] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );
    setCheckpoints((prev) => {
      const next = { ...prev };
      for (const [id, summary] of entries) next[id] = summary;
      return next;
    });
  }, []);

  /** 当前标签页里所有带 runId 的轮次。 */
  const knownRunIds = useCallback(
    (tab: SessionTab | undefined): string[] =>
      (tab?.messages ?? [])
        .map((m) => m.runId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    [],
  );

  /**
   * 切换标签页 / 工作区后补齐尚未查询过的轮次。
   *
   * 只查 `checkpoints` 里还没有键的那些，且结果是 `null` 也是一种「已查过」的记录 ——
   * 否则每次切换标签页都会把所有历史轮次重问一遍，而绝大多数轮次根本没有改动。
   */
  useEffect(() => {
    const pending = knownRunIds(activeTab).filter((id) => !(id in checkpoints));
    if (pending.length > 0) void refreshCheckpoints(pending);
  }, [activeTab, checkpoints, knownRunIds, refreshCheckpoints]);

  // 流式输出节流缓冲池：避免高频单 token 触发过密 React 重渲染与长文 Markdown AST 全量反复解析
  const streamingBufferRef = useRef<Map<string, { streaming: string; thinking: string }>>(
    new Map(),
  );
  const streamingRafRef = useRef<number | null>(null);

  const flushStreamingBuffer = useCallback(() => {
    if (streamingRafRef.current !== null) {
      cancelAnimationFrame(streamingRafRef.current);
      streamingRafRef.current = null;
    }
    const buffer = streamingBufferRef.current;
    if (buffer.size === 0) return;

    const snapshot = new Map(buffer);
    buffer.clear();

    setTabs((prevTabs) =>
      prevTabs.map((t) => {
        const item = snapshot.get(t.id);
        if (!item || (!item.streaming && !item.thinking)) return t;
        return {
          ...t,
          streaming: item.streaming ? (t.streaming || '') + item.streaming : t.streaming,
          streamingMsgId: t.streamingMsgId || uid(),
          thinkingStreaming: item.thinking
            ? (t.thinkingStreaming || '') + item.thinking
            : t.thinkingStreaming,
        };
      }),
    );
  }, []);

  // Global Agent Event Listener (Routes events to matching runId session)
  useEffect(() => {
    const unsub = window.ide.onAgentEvent((event) => {
      // 未送达回执不能按 runId 找 Tab：用户点「停止」时渲染层会**乐观地**立刻清掉 runId，
      // 而主进程的中止与回执是之后才到的 —— 那时按 runId 已经找不到归属，气泡会永远停在
      // 「排队中」。所以这里按消息 id 反查，不依赖 runId 是否还在。
      if (event.type === 'queued_message_undelivered') {
        const ids = new Set(event.ids);
        setTabs((prev) =>
          prev.map((t) =>
            t.messages.some((m) => ids.has(m.id))
              ? {
                  ...t,
                  messages: t.messages.map((m) =>
                    ids.has(m.id) ? { ...m, delivery: 'undelivered' as const } : m,
                  ),
                }
              : t,
          ),
        );
        return;
      }

      // Find matching session tab for this runId
      const targetTab = tabsRef.current.find((t) => t.runId === event.runId);
      if (!targetTab) return;

      if (event.type === 'token') {
        let b = streamingBufferRef.current.get(targetTab.id);
        if (!b) {
          b = { streaming: '', thinking: '' };
          streamingBufferRef.current.set(targetTab.id, b);
        }
        b.streaming += event.text;
        if (streamingRafRef.current === null) {
          streamingRafRef.current = requestAnimationFrame(flushStreamingBuffer);
        }
        return;
      }

      if (event.type === 'thinking_token') {
        let b = streamingBufferRef.current.get(targetTab.id);
        if (!b) {
          b = { streaming: '', thinking: '' };
          streamingBufferRef.current.set(targetTab.id, b);
        }
        b.thinking += event.text;
        if (streamingRafRef.current === null) {
          streamingRafRef.current = requestAnimationFrame(flushStreamingBuffer);
        }
        return;
      }

      // 非流式微块事件到达时，立即先刷出当前累积的文本缓冲区
      flushStreamingBuffer();

      updateTab(targetTab.id, (tab) => {
        const next = { ...tab };
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
          case 'queued_message_consumed':
            // 气泡从「排队中」转为普通用户消息：模型已经看到它了
            next.messages = next.messages.map((m) =>
              m.id === event.id ? { ...m, delivery: 'consumed' as const, runId: event.runId } : m,
            );
            break;
          // 注：queued_message_undelivered 在上面的监听入口就按消息 id 处理掉了，
          // 走不到这里（它到得比 runId 被清空更晚，没法按 runId 找 Tab）。
          case 'tool_start': {
            next.streaming = '';
            next.thinkingStreaming = '';
            try {
              window.dispatchEvent(
                new CustomEvent('echoly:agent-step-start', {
                  detail: {
                    toolName: event.name,
                    toolArgs: event.args,
                    id: event.id,
                  },
                }),
              );
            } catch {
              /* ignore */
            }
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
            try {
              window.dispatchEvent(
                new CustomEvent('echoly:agent-step-done', {
                  detail: {
                    toolName: event.name,
                    status: event.isError ? 'failed' : 'completed',
                    result: event.result,
                    isError: event.isError,
                    id: event.id,
                  },
                }),
              );
            } catch {
              /* ignore */
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
          case 'metrics': {
            if (event.metrics && next.messages.length > 0) {
              const lastIdx = next.messages.length - 1;
              const last = next.messages[lastIdx];
              if (last && last.role === 'assistant') {
                const msgs = [...next.messages];
                msgs[lastIdx] = { ...last, metrics: event.metrics };
                next.messages = msgs;
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
              (next.messages.some((m) => m.role === 'tool') ? t('chat.workedFoldHint') : '');
            const finalizedId = targetTab.streamingMsgId || uid();
            next.streamingMsgId = undefined;
            if (textToDisplay && textToDisplay !== '(cancelled)') {
              const lastIdx = next.messages.length - 1;
              const last = next.messages[lastIdx];
              // Match against the trailing intermediate assistant bubble (emitted just
              // before `done` for the same final answer) rather than requiring an exact
              // string match, since minor formatting differences would otherwise cause
              // the same answer to be appended twice.
              if (last && last.role === 'assistant' && last.isIntermediate) {
                const msgs = [...next.messages];
                msgs[lastIdx] = {
                  ...last,
                  id: finalizedId,
                  content: textToDisplay,
                  isIntermediate: false,
                  metrics: event.metrics,
                  circuitBroken: event.circuitBroken,
                };
                next.messages = msgs;
              } else if (last && last.role === 'assistant' && last.content === textToDisplay) {
                const msgs = [...next.messages];
                msgs[lastIdx] = {
                  ...last,
                  isIntermediate: false,
                  metrics: event.metrics,
                  circuitBroken: event.circuitBroken,
                };
                next.messages = msgs;
              } else {
                next.messages = [
                  ...next.messages,
                  {
                    id: finalizedId,
                    role: 'assistant',
                    content: textToDisplay,
                    isIntermediate: false,
                    createdAt: Date.now(),
                    metrics: event.metrics,
                    circuitBroken: event.circuitBroken,
                  },
                ];
              }
            } else if (next.messages.length > 0) {
              const lastIdx = next.messages.length - 1;
              const last = next.messages[lastIdx];
              if (last && last.role === 'assistant' && last.isIntermediate) {
                const msgs = [...next.messages];
                msgs[lastIdx] = {
                  ...last,
                  isIntermediate: false,
                  metrics: event.metrics,
                  circuitBroken: event.circuitBroken,
                };
                next.messages = msgs;
              }
            }
            next.status = 'done';
            next.runId = null;
            try {
              window.dispatchEvent(
                new CustomEvent('echoly:agent-task-completed', {
                  detail: {
                    summary: textToDisplay || t('chat.taskCompleted'),
                  },
                }),
              );
            } catch {
              /* ignore */
            }
            break;
          }
          case 'error': {
            const isConnErr =
              /econnrefused|fetch failed|timeout|network|connect|enotfound|offline|abort/i.test(
                event.message,
              );
            const errContent = isConnErr
              ? t('chat.modelConnWarning', { msg: event.message })
              : t('chat.errorPrefix', { msg: event.message });
            next.messages = [
              ...next.messages,
              {
                id: uid(),
                role: 'assistant',
                content: errContent,
                createdAt: Date.now(),
              },
            ];
            next.streaming = '';
            next.awaitingContinue = false;
            next.continueInfo = null;
            next.stepInfo = null;
            next.status = 'error';
            next.runId = null;
            try {
              window.dispatchEvent(
                new CustomEvent('echoly:agent-task-failed', {
                  detail: {
                    error: event.message,
                  },
                }),
              );
            } catch {
              /* ignore */
            }
            break;
          }
        }
        return next;
      });

      // 一轮结束才去问「这轮有没有可撤销的改动」：运行中文件还在被陆续改写，
      // 中途问到的数量立刻过期，按钮也会一闪一闪。
      if (event.type === 'done' || event.type === 'error') {
        void refreshCheckpoints(knownRunIds(targetTab));
      }
    });
    return () => {
      unsub();
      flushStreamingBuffer();
    };
  }, [updateTab, flushStreamingBuffer, refreshCheckpoints, knownRunIds]);

  async function send(
    overridePrompt?: string,
    overrideMode?: AgentMode,
    planForRun?: PlanProposal | null,
  ): Promise<void> {
    if (!workspace) {
      showGlobalToast(t('chat.needWorkspace'), 'warn');
      return;
    }
    if (!activeTab) return;
    const rawPrompt = (overridePrompt ?? activeTab.input).trim();
    const currentAttachments = activeTab.attachments || [];
    if (!rawPrompt && currentAttachments.length === 0) return;
    const prompt =
      rawPrompt ||
      (currentAttachments.some((a) => a.type === 'image')
        ? t('chat.analyzeImage')
        : t('chat.analyzeAttachment'));
    const runMode = overrideMode ?? activeTab.mode;

    // 展开 @Git / @Terminal / @Problems：这三个引用描述的是「此刻的状态」，
    // 所以快照必须在提交这一刻取，而不是用户敲下 @ 的那一刻。
    const mentionAttachments = await resolveSpecialMentions(prompt, {
      getWorkspaceRoot: () => workspace,
    });
    const attachmentsForRun = [...currentAttachments, ...mentionAttachments];

    // 本轮还在跑：不新起一轮，而是把消息追加给它。
    // 为什么不在渲染层直接排队等结束后再发：那样消息要么在用户以为已经提交之后被迟迟不发，
    // 要么与一轮的收尾抢时序。交给主进程的队列，Agent 会在下一个步骤边界取走它，
    // 于是模型在**同一条上下文**里看到这条补充要求，知道它刚才改到哪。
    if (activeTab.runId) {
      const queuedId = uid();
      const queuedMsg: ChatSessionMessage = {
        id: queuedId,
        role: 'user',
        content: prompt,
        attachments: attachmentsForRun.length > 0 ? attachmentsForRun : undefined,
        createdAt: Date.now(),
        delivery: 'queued',
      };
      updateTab(activeTab.id, (t) => ({
        ...t,
        input: overridePrompt ? t.input : '',
        attachments: overridePrompt ? t.attachments : [],
        messages: [...t.messages, queuedMsg],
      }));
      const accepted = await window.ide.queueAgentMessage(activeTab.runId, {
        id: queuedId,
        content: prompt,
        attachments: attachmentsForRun.length > 0 ? attachmentsForRun : undefined,
      });
      scrollToUserMsg(queuedId);
      if (!accepted) {
        // 主进程说这一轮已经结束了（收尾与提交撞在一起）：把气泡退回输入框，
        // 而不是让它永远挂在「排队中」—— 用户看到的状态必须和真实送达情况一致。
        updateTab(activeTab.id, (t) => ({
          ...t,
          messages: t.messages.map((m) =>
            m.id === queuedId ? { ...m, delivery: 'undelivered' as const } : m,
          ),
        }));
      }
      return;
    }

    try {
      window.dispatchEvent(
        new CustomEvent('echoly:agent-task-start', {
          detail: {
            prompt,
            workspace,
          },
        }),
      );
    } catch {
      /* ignore */
    }

    const userMsg: ChatSessionMessage = {
      id: uid(),
      role: 'user',
      content: prompt,
      attachments: attachmentsForRun.length > 0 ? attachmentsForRun : undefined,
      createdAt: Date.now(),
    };

    const newMessages = [...activeTab.messages, userMsg];
    const firstUser = activeTab.messages.find((m) => m.role === 'user');
    const firstUserSnippet = firstUser ? firstUser.content.slice(0, 40) : '';
    const isCustom = isCustomSessionTitle(activeTab.title, firstUserSnippet, activeTab.customTitle);

    const newTitle = isCustom
      ? activeTab.title
      : activeTab.messages.length === 0
        ? prompt.slice(0, 40)
        : activeTab.title;

    updateTab(activeTab.id, (t) => ({
      ...t,
      title: newTitle,
      customTitle: isCustom,
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
      attachments: attachmentsForRun.length > 0 ? attachmentsForRun : undefined,
    });

    updateTab(activeTab.id, (t) => ({
      ...t,
      runId: id,
      pendingPlanContext: planContext ? null : t.pendingPlanContext,
      // 把 runId 钉在发起这一轮的用户消息上：撤销按钮要能找到「这一轮」对应的写前记录，
      // 而消息列表会在会话里持久化，重开应用后仍能对上。
      messages: t.messages.map((m) => (m.id === userMsg.id ? { ...m, runId: id } : m)),
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
    // 中止的一轮同样可能已经改过文件，撤销入口要跟着出现
    void refreshCheckpoints(knownRunIds(tab));
  }

  /**
   * 撤销某一轮 AI 的全部文件改动。
   *
   * 冲突（本轮之后该文件又被改过）与「未能留底」都不能当成成功静默略过 ——
   * 用户点这个按钮的动机是「我不信任这批改动，想让工作区回到动手之前」，
   * 所以结果必须逐条说清楚：还原了哪些、哪些没动、为什么。
   */
  async function revertTurn(runId: string): Promise<void> {
    const summary = checkpoints[runId];
    if (summary?.incomplete) {
      // 已知不可完整撤销：与其还原一半，不如让用户走 Git
      showGlobalToast(
        t('chat.revertNotPossible'),
        'warn',
        t('chat.revertIncompleteAlert', {
          reason: summary.incompleteReason ?? t('chat.unknownReason'),
        }),
      );
      return;
    }
    const ok = await confirm.confirm({
      title: t('chat.revertTitle'),
      content: buildSqlConfirmMarkdown({
        t,
        intro: t('chat.revertIntro'),
        statements: [],
        notes: [t('chat.revertNote1'), t('chat.revertNote2')],
      }),
      details: [
        {
          label: t('chat.revertDetailLabel'),
          value: t('chat.revertDetailValue', { n: summary?.mutations ?? 0 }),
        },
      ],
      tone: 'danger',
      confirmLabel: t('chat.revertConfirm'),
    });
    if (ok === null) return;

    const res = await window.ide.revertCheckpoint(runId);
    if ('error' in res) {
      showGlobalToast(t('chat.revertFailed'), 'error', res.error);
      return;
    }

    // 主进程已把磁盘改回写前状态；这里同步内存中的 diff 列表与打开的文件内容，
    // 否则编辑器仍显示 AI 改过的版本，用户会以为撤销没生效。
    await onRevertTurn?.(res.reverted);
    setCheckpoints((prev) => ({ ...prev, [runId]: null }));

    // 标题给结论，明细进 detail：toast 放不下多行清单，但点开就是一个可滚动的明细弹窗。
    // 没成功还原任何一处、或有被跳过的文件时降级为 warn —— 那种结果不该显示成绿色的「成功」。
    const headline = t('chat.revertResult', { n: res.reverted.length });
    const details: string[] = [];
    if (res.conflicts.length > 0) {
      details.push(
        t('chat.revertConflicts', {
          list: res.conflicts.map((p) => `  · ${p}`).join('\n'),
        }),
      );
    }
    if (res.skipped.length > 0) {
      details.push(
        t('chat.revertSkipped', {
          list: res.skipped.map((sk) => `  · ${sk.path}（${sk.reason}）`).join('\n'),
        }),
      );
    }
    showGlobalToast(
      headline,
      res.skipped.length > 0 || res.conflicts.length > 0 ? 'warn' : 'success',
      details.length > 0 ? details.join('\n') : undefined,
    );
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

  /**
   * 关闭一个对话 Tab。
   *
   * 值得确认的只有一种情形：**这个 Tab 正在跑 agent**，关掉会连带 `cancelAgent` 掐断它。
   * 空 Tab / 已结束的 Tab 关掉没有任何代价，每次弹窗只会让人厌烦 ——
   * 「所有删除都要有确认」拦的是会丢东西的那一下，不是让人对弹窗脱敏。
   */
  const handleCloseTab = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const tabToClose = tabs.find((t) => t.id === id);
    if (tabToClose?.runId) {
      const ok = await confirm.confirm({
        title: t('chat.closeTabTitle'),
        content: buildSqlConfirmMarkdown({
          t,
          intro: t('chat.closeTabIntro'),
          statements: [],
        }),
        details: [
          { label: t('chat.labelTitle'), value: tabToClose.title?.trim() || t('chat.untitled') },
          { label: t('chat.labelStatus'), value: t('chat.statusRunning') },
        ],
        tone: 'danger',
        confirmLabel: t('chat.closeTabConfirm'),
      });
      if (ok === null) return;
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
    const firstUser = session.messages?.find((m) => m.role === 'user');
    const firstUserSnippet = firstUser ? firstUser.content.slice(0, 40) : '';
    const isCustom = isCustomSessionTitle(session.title, firstUserSnippet, session.customTitle);

    const sessionRunIds = (session.messages ?? [])
      .map((m) => m.runId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    const existing = tabs.find((t) => t.id === session.id);
    if (existing) {
      // 无论已存在还是新打开，都确保同步最新的标题、自定义标题标记和消息
      setTabs((prev) =>
        prev.map((t) =>
          t.id === session.id
            ? {
                ...t,
                title: session.title || t.title,
                customTitle: isCustom,
                messages:
                  session.messages && session.messages.length > 0 ? session.messages : t.messages,
              }
            : t,
        ),
      );
      setActiveTabId(existing.id);
      void refreshCheckpoints(sessionRunIds);
      return;
    }

    const tab = sessionToTab(session);
    // 如果当前只有一个空标签页（没有对话消息），直接替换该空标签，体验更流畅
    setTabs((prev) => {
      if (prev.length === 1 && prev[0].messages.length === 0) {
        return [tab];
      }
      return [...prev, tab];
    });
    setActiveTabId(tab.id);
    void refreshCheckpoints(sessionRunIds);
  };

  const handleRenameSession = (id: string, newTitle: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, title: newTitle, customTitle: true } : t)),
    );
  };

  const handleExportSessionMarkdown = useCallback(() => {
    if (!activeTab || activeTab.messages.length === 0) return;
    const dateStr = new Date(activeTab.updatedAt || Date.now()).toLocaleString();
    let md = `# ${activeTab.title || t('chat.exportDefaultTitle')}\n\n`;
    md += `${t('chat.exportMeta', { date: dateStr, mode: MODE_LABEL[activeTab.mode] || activeTab.mode })}\n\n---\n\n`;

    for (const msg of activeTab.messages) {
      if (msg.role === 'user') {
        md += `### 👤 User\n\n${msg.content}\n\n`;
      } else if (msg.role === 'assistant') {
        md += `### 🤖 Assistant\n\n`;
        if ((msg as any).thinking) {
          md += `<details>\n<summary>${t('chat.exportThinking')}</summary>\n\n${(msg as any).thinking}\n\n</details>\n\n`;
        }
        md += `${msg.content}\n\n`;
      }
      md += `---\n\n`;
    }

    try {
      void navigator.clipboard.writeText(md);
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeTitle = (activeTab.title || 'chat-session').replace(/[\\/:*?"<>|]/g, '_');
      a.download = `${safeTitle}-${Date.now()}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
      setExported(true);
      setTimeout(() => setExported(false), 2000);
    } catch {
      setExported(true);
      setTimeout(() => setExported(false), 2000);
    }
  }, [activeTab, t]);

  const handleClearCurrentSession = useCallback(async () => {
    if (!activeTab || activeTab.messages.length === 0) return;
    const ok = await confirm.confirm({
      title: t('chat.clearTitle'),
      content: buildSqlConfirmMarkdown({
        t,
        intro: t('chat.clearIntro'),
        statements: [],
      }),
      details: [
        {
          label: t('chat.labelMessages'),
          value: t('chat.clearMessagesValue', { n: activeTab.messages.length }),
        },
        { label: t('chat.labelTitle'), value: activeTab.title?.trim() || t('chat.untitled') },
      ],
      tone: 'danger',
      confirmLabel: t('chat.clearConfirm'),
    });
    if (ok === null) return;
    updateTab(activeTab.id, (t) => ({
      ...t,
      messages: [],
      streaming: '',
      status: 'idle',
      thinkingStreaming: '',
      runId: null,
      plan: null,
      pendingPlanContext: null,
    }));
  }, [activeTab, updateTab, confirm, t]);

  /**
   * 快捷提问按钮：把一段**中文指令**填进输入框（用户可改后再发）。
   *
   * 这些指令刻意不进字典 —— 它们最终是送给模型的 prompt，不是界面文案，
   * 与 `services/specialMentions.ts` / EditorPane 的 `handleQuickPrompt` 同类。
   * 按钮上显示的短标签（「解释代码」/「Explain」）走 `chat.quick*`，那个是翻的。
   */
  const handleQuickPrompt = useCallback(
    (type: 'explain' | 'optimize' | 'test' | 'bug') => {
      if (!activeTab) return;
      const activeFile = openFiles && openFiles.length > 0 ? openFiles[0] : null;
      const hasSelection = Boolean(selection && selection.trim().length > 0);
      const fileName = activeFile?.path ? activeFile.path.split(/[/\\]/).pop() : '';

      let prompt = '';
      switch (type) {
        case 'explain':
          if (hasSelection) {
            prompt = `请详细解释以下这段选中的代码逻辑与设计意图：\n\`\`\`\n${selection}\n\`\`\``;
          } else if (fileName) {
            prompt = `请通读并解释当前打开的文件 @${activeFile?.path} 的核心架构与功能逻辑。`;
          } else {
            prompt = `请帮我梳理并解释当前项目的整体架构、模块划分与核心逻辑。`;
          }
          break;
        case 'optimize':
          if (hasSelection) {
            prompt = `请审查以下选中的代码，分析其潜在性能瓶颈、资源占用并提供重构优化方案：\n\`\`\`\n${selection}\n\`\`\``;
          } else if (fileName) {
            prompt = `请分析当前文件 @${activeFile?.path} 的性能开销并给出优化重构建议。`;
          } else {
            prompt = `请分析并给出提升当前项目代码质量与性能的重构优化建议。`;
          }
          break;
        case 'test':
          if (hasSelection) {
            prompt = `请为以下选中的代码编写高覆盖率的单元测试，包含边界测试与异常处理：\n\`\`\`\n${selection}\n\`\`\``;
          } else if (fileName) {
            prompt = `请为当前文件 @${activeFile?.path} 编写高覆盖率的单元测试用例。`;
          } else {
            prompt = `请为项目中的核心逻辑编写覆盖全面的单元测试。`;
          }
          break;
        case 'bug':
          if (hasSelection) {
            prompt = `请审查以下选中的代码，排查是否存在内存泄漏、并发竞态或安全隐患：\n\`\`\`\n${selection}\n\`\`\``;
          } else if (fileName) {
            prompt = `请排查当前文件 @${activeFile?.path} 中是否存在隐蔽 Bug 或边界异常隐患。`;
          } else {
            prompt = `请检查当前工作区代码中是否存在潜在的 Bug、内存泄漏或安全隐患。`;
          }
          break;
      }

      updateTab(activeTab.id, (t) => ({ ...t, input: prompt }));
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 50);
    },
    [activeTab, openFiles, selection, updateTab],
  );

  const windowTokens = activeTab?.contextUsage?.windowTokens ?? contextWindowTokens;
  const usedTokens = activeTab?.contextUsage?.usedTokens ?? 0;
  const usagePct = windowTokens > 0 ? Math.min(100, (usedTokens / windowTokens) * 100) : 0;

  return (
    <div className="chat-panel">
      {/* Title Bar Header with Tabs */}
      <div className="panel-title chat-title-row">
        <div className="chat-tabs-bar">
          {tabs.map((tb) => {
            const isRunning =
              tb.status !== 'idle' &&
              tb.status !== 'done' &&
              tb.status !== 'error' &&
              tb.status !== 'cancelled';
            const isActive = tb.id === activeTabId;
            return (
              <div
                key={tb.id}
                className={`chat-tab-item${isActive ? ' active' : ''}`}
                onClick={() => setActiveTabId(tb.id)}
                title={
                  isActive
                    ? tb.title || t('chat.titleCurrent')
                    : t('chat.tabInactiveTitle', { title: tb.title || t('chat.titleDefault') })
                }
              >
                <span className="chat-tab-icon" aria-hidden="true">
                  {isRunning ? (
                    <span className="chat-tab-running-dot" title={t('chat.tabRunning')} />
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
                <span className="chat-tab-title">{tb.title || 'New Chat'}</span>
                {tabs.length > 1 && (
                  <button
                    type="button"
                    className="chat-tab-close"
                    onClick={(e) => void handleCloseTab(tb.id, e)}
                    title={t('chat.tabClose')}
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
          <button
            type="button"
            className={`icon-btn ${exported ? 'active' : ''}`}
            title={exported ? t('chat.exported') : t('chat.exportTip')}
            onClick={handleExportSessionMarkdown}
            disabled={!activeTab || activeTab.messages.length === 0}
            style={{ opacity: !activeTab || activeTab.messages.length === 0 ? 0.35 : 1 }}
          >
            {exported ? (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#10b981"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
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
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="icon-btn"
            title={t('chat.clearChat')}
            onClick={handleClearCurrentSession}
            disabled={!activeTab || activeTab.messages.length === 0}
            style={{ opacity: !activeTab || activeTab.messages.length === 0 ? 0.35 : 1 }}
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
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
          <button
            type="button"
            className="icon-btn"
            title={t('chat.newChat')}
            onClick={handleNewTab}
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
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            type="button"
            className="icon-btn"
            title={t('chat.history')}
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
                          title={t('chat.attachmentImgTip', {
                            name: att.name,
                            size: formatFileSize(att.size),
                          })}
                        >
                          <img src={att.dataUrl} alt={att.name} />
                          <span className="chat-msg-attachment-img-name">{att.name}</span>
                        </div>
                      ) : att.type === 'browser-element' ? (
                        <div
                          key={att.id}
                          className="chat-msg-attachment-file-pill"
                          title={t('chat.elementRefTip', {
                            name: att.name,
                            url: att.browserElement?.url || '',
                            selector: att.browserElement?.selectorPath || '',
                          })}
                          onClick={() => {
                            if (att.content) {
                              navigator.clipboard?.writeText(att.content).catch(() => {});
                            }
                          }}
                          style={{
                            borderColor: 'rgba(59, 130, 246, 0.4)',
                            background: 'rgba(59, 130, 246, 0.08)',
                            cursor: 'pointer',
                          }}
                        >
                          {att.browserElement?.screenshotDataUrl ? (
                            <img
                              src={att.browserElement.screenshotDataUrl}
                              alt={att.name}
                              style={{
                                width: 18,
                                height: 18,
                                objectFit: 'cover',
                                borderRadius: 3,
                                border: '1px solid rgba(59, 130, 246, 0.45)',
                                flexShrink: 0,
                              }}
                            />
                          ) : (
                            <span className="file-pill-icon">🎯</span>
                          )}
                          <span
                            className="file-pill-name"
                            style={{ color: '#60a5fa', fontWeight: 600 }}
                          >
                            {att.name}
                          </span>
                          <span className="file-pill-size" style={{ color: '#93c5fd' }}>
                            {t('chat.domElement')}
                          </span>
                        </div>
                      ) : att.type === 'browser-page' ? (
                        <div
                          key={att.id}
                          className="chat-msg-attachment-file-pill"
                          title={t('chat.pageRefTip', {
                            title: att.browserPage?.title || att.name,
                            url: att.browserPage?.url || '',
                            errors: att.browserPage?.errors?.length
                              ? t('chat.pageRefErrors', {
                                  n: att.browserPage.errors.length,
                                  list: att.browserPage.errors.join('\n'),
                                })
                              : '',
                          })}
                          style={{
                            borderColor: 'rgba(147, 51, 234, 0.4)',
                            background: 'rgba(147, 51, 234, 0.08)',
                          }}
                        >
                          <span className="file-pill-icon">🌐</span>
                          <span
                            className="file-pill-name"
                            style={{ color: '#c084fc', fontWeight: 600 }}
                          >
                            {att.name}
                          </span>
                          <span className="file-pill-size" style={{ color: '#d8b4fe' }}>
                            {att.browserPage?.errors?.length
                              ? t('chat.pageErrorsBadge', { n: att.browserPage.errors.length })
                              : t('chat.pageBadge')}
                          </span>
                        </div>
                      ) : SPECIAL_MENTION_STYLE[att.name] ? (
                        <div
                          key={att.id}
                          className="chat-msg-attachment-file-pill"
                          title={t('chat.mentionSnapshotTip', {
                            name: att.name,
                            content: (att.content || '').slice(0, 600),
                          })}
                          style={{
                            borderColor: SPECIAL_MENTION_STYLE[att.name].border,
                            background: SPECIAL_MENTION_STYLE[att.name].bg,
                          }}
                        >
                          <span className="file-pill-icon">
                            {SPECIAL_MENTION_STYLE[att.name].icon}
                          </span>
                          <span
                            className="file-pill-name"
                            style={{
                              color: SPECIAL_MENTION_STYLE[att.name].color,
                              fontWeight: 600,
                            }}
                          >
                            {att.name}
                          </span>
                          <span
                            className="file-pill-size"
                            style={{ color: SPECIAL_MENTION_STYLE[att.name].color, opacity: 0.8 }}
                          >
                            {t('chat.contextBadge')}
                          </span>
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
                {/*
                  运行中追加的消息状态。不显示「已送达」——那是默认预期，
                  只有「还没到步骤边界」和「本轮已结束、没送到」两种异常状态才值得占位。
                */}
                {m.delivery === 'queued' && (
                  <div className="msg-delivery-badge queued" title={t('chat.deliveryQueuedTip')}>
                    <span className="msg-delivery-dot" />
                    {t('chat.deliveryQueued')}
                  </div>
                )}
                {m.delivery === 'undelivered' && (
                  <div
                    className="msg-delivery-badge undelivered"
                    title={t('chat.deliveryUndeliveredTip')}
                  >
                    <span className="msg-delivery-dot" />
                    {t('chat.deliveryUndelivered')}
                  </div>
                )}
                <div
                  className={`msg-actions msg-actions-corner ${copiedId === m.id ? 'has-active' : ''}`}
                >
                  <button
                    type="button"
                    className={`msg-action-btn ${copiedId === m.id ? 'copied' : ''}`}
                    title={copiedId === m.id ? t('editor.copied') : t('chat.copyMsg')}
                    onClick={() => handleCopyMessage(m.content, m.id)}
                  >
                    {copiedId === m.id ? (
                      <>
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
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        <span>{t('editor.copied')}</span>
                      </>
                    ) : (
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    )}
                  </button>
                  <button
                    type="button"
                    className="msg-action-btn"
                    title={t('chat.rollbackTip')}
                    onClick={() => void handleRollbackUserMessage(m)}
                  >
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
                      <path d="M3 10h10a5 5 0 0 1 5 5v2" />
                      <polyline points="7 6 3 10 7 14" />
                    </svg>
                  </button>
                </div>
              </div>
            );

            const renderAssistantMsg = (m: ChatSessionMessage) => (
              <div key={m.id} id={`msg-${m.id}`} className="msg assistant">
                {(m as any).thinking?.length > 0 && (
                  <ThinkingBlock thinking={(m as any).thinking} />
                )}
                <MarkdownMessage content={m.content} onOpenFile={onOpenFile} />
                <div
                  className="msg-footer"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: m.metrics ? 'space-between' : 'flex-end',
                    marginTop: 4,
                  }}
                >
                  {m.metrics && <ModelMetricsBadge metrics={m.metrics} />}
                  <div className={`msg-actions ${copiedId === m.id ? 'has-active' : ''}`}>
                    <button
                      type="button"
                      className={`msg-action-btn ${copiedId === m.id ? 'copied' : ''}`}
                      title={copiedId === m.id ? t('editor.copied') : t('chat.copyMsg')}
                      onClick={() => handleCopyMessage(m.content, m.id)}
                    >
                      {copiedId === m.id ? (
                        <>
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
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                          <span>{t('editor.copied')}</span>
                        </>
                      ) : (
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      )}
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
              if (turnIsLive && activeTab?.streaming) {
                const streamingKey = activeTab.streamingMsgId || 'streaming-current';
                bodyEls.push(
                  <div key={streamingKey} id={`msg-${streamingKey}`} className="msg assistant">
                    <MarkdownMessage
                      content={activeTab.streaming}
                      streaming
                      onOpenFile={onOpenFile}
                    />
                  </div>,
                );
              }
              return bodyEls;
            };

            const turnNodes = turns.map((turn, turnIdx) => {
              const turnKey = turn.user?.id ?? `orphan-${turnIdx}`;
              const isLastTurn = turnIdx === turns.length - 1;
              const turnRunId = turn.user?.runId;
              const checkpoint = turnRunId ? checkpoints[turnRunId] : undefined;
              return (
                <div key={turnKey} className="chat-turn">
                  {turn.user && (
                    <div className="chat-turn-folder">{renderUserBubble(turn.user)}</div>
                  )}
                  <div className="chat-turn-files">
                    {renderTurnBody(turn.body, turnKey, isLastTurn)}
                    {/* 这一轮修改了文件时显示美化的修改清单与回退控制栏 */}
                    {checkpoint && (
                      <TurnCheckpointBar
                        checkpoint={checkpoint}
                        onRevertTurn={async (paths) => {
                          await onRevertTurn?.(paths);
                          setCheckpoints((prev) => ({ ...prev, [checkpoint.runId]: null }));
                          void refreshCheckpoints([checkpoint.runId]);
                        }}
                        onOpenFile={onOpenFile}
                        onRefreshCheckpoints={() => void refreshCheckpoints([checkpoint.runId])}
                      />
                    )}
                  </div>
                </div>
              );
            });

            if (msgs.length === 0 && !activeTab?.streaming) {
              return (
                <>
                  <div className="chat-empty-state">
                    <div className="chat-empty-icon-wrap">
                      <img
                        src={echolyAppIcon}
                        alt="Echoly App Icon"
                        className="chat-empty-app-icon"
                      />
                    </div>
                    <div className="chat-empty-title">{t('chat.emptyTitle')}</div>
                    <div className="chat-empty-subtitle">{t('chat.emptySubtitle')}</div>
                    <div className="chat-prompt-pills">
                      <button
                        type="button"
                        className="chat-prompt-pill"
                        onClick={() => handleQuickPrompt('explain')}
                      >
                        <span className="chat-prompt-pill-icon">🔍</span>
                        <span className="chat-prompt-pill-text">
                          {selection?.trim()
                            ? t('chat.quickExplainSelection')
                            : t('chat.quickExplain')}
                        </span>
                        <span className="chat-prompt-pill-arrow">→</span>
                      </button>
                      <button
                        type="button"
                        className="chat-prompt-pill"
                        onClick={() => handleQuickPrompt('optimize')}
                      >
                        <span className="chat-prompt-pill-icon">⚡</span>
                        <span className="chat-prompt-pill-text">{t('chat.quickOptimize')}</span>
                        <span className="chat-prompt-pill-arrow">→</span>
                      </button>
                      <button
                        type="button"
                        className="chat-prompt-pill"
                        onClick={() => handleQuickPrompt('test')}
                      >
                        <span className="chat-prompt-pill-icon">🧪</span>
                        <span className="chat-prompt-pill-text">{t('chat.quickTest')}</span>
                        <span className="chat-prompt-pill-arrow">→</span>
                      </button>
                      <button
                        type="button"
                        className="chat-prompt-pill"
                        onClick={() => handleQuickPrompt('bug')}
                      >
                        <span className="chat-prompt-pill-icon">🛠️</span>
                        <span className="chat-prompt-pill-text">{t('chat.quickBug')}</span>
                        <span className="chat-prompt-pill-arrow">→</span>
                      </button>
                    </div>
                  </div>
                  <div ref={bottomRef} />
                </>
              );
            }

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
            {t('chat.jumpLatest')}
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
                  title={t('chat.diffViewTip', { path: d.path })}
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
              <span className="count-text">
                {t('chat.diffFilesWithChanges', { n: diffs.length })}
              </span>
            </div>
            <div className="chat-diff-action-right">
              <button type="button" className="btn-reject-all" onClick={onRejectAllDiffs}>
                {t('chat.diffRejectAll')}
              </button>
              <button type="button" className="btn-accept-all" onClick={onAcceptAllDiffs}>
                {t('chat.diffAcceptAll')}
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
                placeholder={t('chat.askAnswerPh')}
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
                {t('chat.submit')}
              </button>
            </div>
          )}
          <div className="chat-ask-popup-actions">
            <button type="button" className="primary" onClick={() => void answerConfirm(true)}>
              {t('chat.allow')}
            </button>
            <button type="button" className="danger" onClick={() => void answerConfirm(false)}>
              {t('chat.deny')}
            </button>
          </div>
        </div>
      )}
      {activeTab?.awaitingContinue && activeTab.continueInfo && (
        <div className="chat-ask-popup continue">
          <div className="chat-ask-popup-title">{t('chat.maxStepsTitle')}</div>
          <div className="chat-ask-popup-detail">
            {t('chat.maxStepsDetail', {
              done: activeTab.continueInfo.completedSteps,
              chunk: activeTab.continueInfo.chunkSize,
            })}
          </div>
          <div className="chat-ask-popup-actions">
            <button type="button" className="primary" onClick={() => void continueRun()}>
              {t('chat.continueBtn')}
            </button>
            <button type="button" className="danger" onClick={() => void stopContinue()}>
              {t('chat.stopBtn')}
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
            ...(isDragging ? { border: '1px dashed rgba(255, 255, 255, 0.45)' } : {}),
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
                      title={t('chat.zoomTip')}
                    />
                  ) : att.type === 'browser-element' ? (
                    att.browserElement?.screenshotDataUrl ? (
                      <img
                        src={att.browserElement.screenshotDataUrl}
                        alt={att.name}
                        className="staged-img-thumb"
                        onClick={() =>
                          setPreviewImage(att.browserElement?.screenshotDataUrl || null)
                        }
                        title={t('chat.zoomElementTip')}
                      />
                    ) : (
                      <span className="staged-file-icon" style={{ fontSize: 13 }}>
                        🎯
                      </span>
                    )
                  ) : att.type === 'browser-page' ? (
                    <span className="staged-file-icon" style={{ fontSize: 13 }}>
                      🌐
                    </span>
                  ) : (
                    <span className="staged-file-icon">📄</span>
                  )}
                  <div className="staged-info">
                    <span
                      className="staged-name"
                      title={att.browserElement?.selectorPath || att.browserPage?.url || att.name}
                    >
                      {att.name}
                    </span>
                    <span
                      className="staged-size"
                      style={
                        att.type === 'browser-element'
                          ? { color: '#60a5fa' }
                          : att.type === 'browser-page'
                            ? { color: '#c084fc' }
                            : undefined
                      }
                    >
                      {att.type === 'browser-element'
                        ? att.browserElement?.screenshotDataUrl
                          ? t('chat.domElementWithShot')
                          : t('chat.domElement')
                        : att.type === 'browser-page'
                          ? t('chat.webPage')
                          : formatFileSize(att.size)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="staged-remove-btn"
                    onClick={() => handleRemoveAttachment(att.id)}
                    title={t('chat.removeAttachment')}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {suggestMode && (
            <div
              className="chat-mention-popover"
              ref={suggestMode === 'command' ? commandPopoverRef : mentionPopoverRef}
            >
              <div className="chat-mention-header">
                <span>
                  {suggestMode === 'command' ? t('chat.commandHeader') : t('chat.mentionHeader')}
                </span>
                <span className="chat-mention-tip">{t('chat.suggestTip')}</span>
              </div>
              <div
                ref={suggestListRef}
                className="chat-mention-list"
                onMouseMove={() => {
                  isKeyboardNavRef.current = false;
                }}
              >
                {suggestItems.length === 0 && suggestMode === 'command' && (
                  <div className="chat-mention-empty">
                    {translateSegments('chat.commandEmpty', locale, { fileName: 'name.md' }).map(
                      (seg, i) =>
                        seg.emphasis ? (
                          <code key={i}>{seg.text}</code>
                        ) : (
                          <span key={i}>{seg.text}</span>
                        ),
                    )}
                  </div>
                )}
                {suggestItems.map((item, idx) => {
                  const isSelected = idx === suggestIndex;
                  return (
                    <div
                      key={item.id}
                      className={`chat-mention-item${isSelected ? ' active' : ''}`}
                      onMouseEnter={() => {
                        if (!isKeyboardNavRef.current) setSuggestIndex(idx);
                      }}
                      onMouseMove={() => {
                        isKeyboardNavRef.current = false;
                        setSuggestIndex(idx);
                      }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleSelectSuggest(item);
                      }}
                    >
                      <div className="chat-mention-icon">
                        {item.type === 'command' ? (
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="4 17 10 11 4 5" />
                            <line x1="12" y1="19" x2="20" y2="19" />
                          </svg>
                        ) : item.type === 'special' ? (
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
                        <span className="chat-mention-title">
                          {item.title}
                          {item.badge && <span className="chat-mention-badge">{item.badge}</span>}
                        </span>
                        <span className="chat-mention-desc">{item.desc}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              {suggestMode === 'command' && (
                <div className="chat-mention-footer">
                  {translateSegments('chat.commandFooter', locale, {
                    wsDir: '.echoly/commands/',
                    cursorDir: '.cursor/commands/',
                    deepseekDir: '.deepseek/commands/',
                    fileName: 'name.md',
                    args: '$ARGUMENTS',
                  }).map((seg, i) =>
                    seg.emphasis ? (
                      <code key={i}>{seg.text}</code>
                    ) : (
                      <span key={i}>{seg.text}</span>
                    ),
                  )}
                </div>
              )}
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
              // 运行中把「Enter 发送」改成「Enter 追加」：这两件事的行为不同（一个是新起一轮，
              // 一个是插进当前这轮），占位文案是用户唯一能提前知道的途径。
              activeTab?.runId
                ? t('chat.placeholderRunning')
                : activeTab?.mode === 'ask'
                  ? t('chat.placeholderAsk')
                  : activeTab?.mode === 'plan'
                    ? t('chat.placeholderPlan')
                    : t('chat.placeholderAgent')
            }
            onChange={(val) => {
              updateTab(activeTab.id, (t) => ({ ...t, input: val }));

              // 检测 @ / 两个触发符
              // 从末尾反向找光标位置（onChange 中无法直接获取 selectionStart，取全长近似）
              const cursor = val.length;
              const textBefore = val.slice(0, cursor);

              // `/` 只认行首；`@` 允许行内但要求前面是空白（见 slashTrigger.ts 里的说明）
              const slashMatch = matchSlashTrigger(textBefore);
              if (slashMatch) {
                setCommandState({
                  isOpen: true,
                  query: slashMatch.query,
                  cursorIndex: cursor,
                  selectedIndex: 0,
                });
                setMentionState((prev) => (prev.isOpen ? { ...prev, isOpen: false } : prev));
                return;
              }
              setCommandState((prev) => (prev.isOpen ? { ...prev, isOpen: false } : prev));

              const match = matchMentionTrigger(textBefore);
              if (match) {
                setMentionState({
                  isOpen: true,
                  query: match.query,
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
              if (suggestMode && suggestItems.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  isKeyboardNavRef.current = true;
                  setSuggestIndex((suggestIndex + 1) % suggestItems.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  isKeyboardNavRef.current = true;
                  setSuggestIndex((suggestIndex - 1 + suggestItems.length) % suggestItems.length);
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  const item = suggestItems[suggestIndex] || suggestItems[0];
                  if (item) {
                    handleSelectSuggest(item);
                  }
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  closeSuggest();
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
                  const refPart = fullInput.endsWith(plain)
                    ? fullInput.slice(0, fullInput.length - plain.length)
                    : '';
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
                title={t('chat.addAttachment')}
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
                        title={t('chat.modelCurrentTip', {
                          name: currentModel?.name || currentModelId,
                          model: currentModel?.model || '',
                          status: isCurrentHealthy
                            ? t('chat.modelStatusHealthy')
                            : t('chat.modelStatusUntested'),
                        })}
                      >
                        <span className="chat-model-dot" style={{ backgroundColor: badge.color }} />
                        <span className="chat-model-name">
                          {currentModel?.name || currentModelId}
                        </span>
                        <PanelChevron
                          expanded={modelDropdownOpen}
                          size={10}
                          style={{ opacity: 0.6, marginLeft: 3 }}
                        />
                      </button>

                      {modelDropdownOpen && (
                        <div className="chat-model-dropdown-menu">
                          <div className="chat-model-dropdown-header">
                            <span>{t('chat.selectModel')}</span>
                            <button
                              type="button"
                              className="chat-model-settings-link"
                              onClick={() => {
                                setModelDropdownOpen(false);
                                onOpenSettings?.();
                              }}
                            >
                              {t('chat.manageModels')}
                            </button>
                          </div>
                          {!hasConnectedModels && (
                            <div className="chat-model-dropdown-alert">
                              {t('chat.noHealthyModel')}
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
                                      <span>{t('chat.untestedDivider')}</span>
                                    </div>
                                  )}
                                  <div
                                    className={`chat-model-dropdown-item${isSelected ? ' selected' : ''}${isDisabled ? ' disabled' : ''}`}
                                    title={
                                      isDisabled
                                        ? t('chat.modelUntestedTip')
                                        : isHealthy
                                          ? t('chat.modelHealthyTip')
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
                                          {m.model} {m.enableThinking ? t('chat.thinkingMode') : ''}
                                        </div>
                                      </div>
                                    </div>
                                    <div className="chat-model-status-group">
                                      {isHealthy ? (
                                        <span className="chat-model-connected-badge">
                                          {t('chat.modelHealthyBadge')}
                                        </span>
                                      ) : (
                                        <span className="chat-model-untested-badge">
                                          {t('chat.modelUntestedBadge')}
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
                title={t('chat.modeTip', { mode: MODE_LABEL[activeTab?.mode || 'agent'] })}
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
                title={t('chat.permTip', { perm: t(`chat.permFull.${permissionMode}`) })}
                options={PERMISSION_ORDER.map((m) => ({
                  value: m,
                  label: permissionShortLabel(t, m),
                }))}
                onChange={(m) => onPermissionModeChange(m)}
              />

              {/* .echolyrules 项目规则指示器 */}
              <button
                type="button"
                className="chat-pill-btn echolyrules-pill"
                title={hasRules ? t('chat.rulesActiveTip') : t('chat.rulesInactiveTip')}
                onClick={() => void handleOpenOrInitRules()}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 9999,
                  border: hasRules
                    ? '1px solid rgba(168, 85, 247, 0.4)'
                    : '1px solid var(--border)',
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
                  title={t('chat.contextUsageTip', {
                    pct: usagePct.toFixed(0),
                    used: formatTokens(usedTokens),
                    window: formatTokens(windowTokens),
                  })}
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
                <div className="chat-action-btn-group">
                  {/*
                    运行中且有内容时并排给出「追加」按钮。只靠 Enter 是不够的：
                    停止按钮此刻占着原来的发送位，用户看不到任何「可以继续输入」的视觉线索，
                    于是会以为输入框已经不可用而干等。
                  */}
                  {(activeTab.input ?? '').trim().length > 0 && (
                    <button
                      type="button"
                      className="chat-action-circle-btn send"
                      onClick={() => void send()}
                      title={t('chat.appendTip')}
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
                  <button
                    type="button"
                    className="chat-action-circle-btn stop"
                    onClick={() => void cancel()}
                    title={t('chat.stopBtn')}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="6" width="12" height="12" rx="2" ry="2" />
                    </svg>
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="chat-action-circle-btn send"
                  onClick={() => void send()}
                  title={t('chat.send')}
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
          workspaceInfo={workspaceInfo}
          recentWorkspaces={recentWorkspaces}
          onSelectSession={handleLoadSessionFromModal}
          onNewSession={handleDeleteCurrentSessionAndOpenNew}
          onRenameSession={handleRenameSession}
          onClose={() => setShowHistoryModal(false)}
        />
      )}

      {/* Image Lightbox Modal – 使用 createPortal 挂载到 body，避免父容器 stacking context 遮挡 */}
      {previewImage &&
        createPortal(
          <div className="chat-image-lightbox" onClick={() => setPreviewImage(null)}>
            <div className="chat-image-lightbox-content" onClick={(e) => e.stopPropagation()}>
              <img src={previewImage} alt="Preview" />
              <button
                type="button"
                className="chat-image-lightbox-close"
                onClick={() => setPreviewImage(null)}
                title={t('chat.close')}
              >
                ×
              </button>
            </div>
          </div>,
          document.body,
        )}

      {confirm.modal}
    </div>
  );
};

export const ChatPanel = forwardRef(ChatPanelComponent);
