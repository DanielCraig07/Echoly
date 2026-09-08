import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import { KeyMod, KeyCode, editor as MonacoEditor } from 'monaco-editor';
import type {
  GitStatusEntry,
  GitStatusResult,
  OpenTab,
  PendingDiff,
  UiTheme,
} from '@deepseek-ide/shared';
import { isImagePath, isUntitledPath, languageFromPath, untitledTabLabel } from '../utils';
import { RenderFileTreeIcon } from './FileTree';
import { MarkdownMessage, extractMarkdownHeadings, type MarkdownHeadingItem } from './MarkdownMessage';
import { WelcomeView } from './WelcomeView';
import type { RecentWorkspaceItem } from './OpenWorkspaceModal';
import { setupCmdClickGesture, navigateBack, highlightJumpLocation, navigationStack, type PeekResult } from '../services/symbolNavigation';

interface Props {
  tabs: OpenTab[];
  activePath: string | null;
  gitStatus?: GitStatusResult | null;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onCloseOthers?: (targetPath: string) => void;
  onCloseRight?: (targetPath: string) => void;
  onCloseSaved?: () => void;
  onCloseAll?: () => void;
  onNewUntitled?: () => void;
  onChangeContent: (path: string, content: string, markDirty?: boolean) => void;
  onSelectionChange?: (text: string) => void;
  onCursorChange?: (line: number, col: number) => void;
  onAddToChat?: (text: string) => void;
  onOpenFile?: (path: string, line?: number, column?: number) => void;
  previewDiff: PendingDiff | null;
  onCloseDiff?: () => void;
  wordWrap?: boolean;
  onToggleWordWrap?: () => void;
  onPreviewGitDiff?: (path: string) => void;
  onDiscardPath?: (path: string) => void;
  onRefreshGitStatus?: () => void;
  revealLine?: number | null;
  revealColumn?: number | null;
  revealNonce?: number; // 单调递增计数器，保证每次跳转请求都触发 effect
  uiTheme: UiTheme;
  gitBlameInline?: boolean;
  /** When there is no open workspace, show the quick-start welcome screen instead of a plain hint. */
  workspace?: string | null;
  onPickLocal?: () => void;
  onPickSsh?: () => void;
  onPickClone?: () => void;
  recentWorkspaces?: RecentWorkspaceItem[];
  onSelectRecentWorkspace?: (item: RecentWorkspaceItem) => void;
  onRemoveRecentWorkspace?: (path: string) => void;
  onClearRecentWorkspaces?: () => void;
  onMoreWorkspaceHistory?: () => void;
}

function getTabGitMeta(path?: string | null, entries: GitStatusEntry[] = []) {
  if (!path || typeof path !== 'string' || !entries || !Array.isArray(entries) || !entries.length)
    return null;
  const norm = path.replace(/\\/g, '/').replace(/^\/+/, '');
  try {
    const matched = entries.find((e) => {
      if (!e?.path) return false;
      const ep = e.path.replace(/\\/g, '/').replace(/^\/+/, '');
      return ep === norm || norm.endsWith('/' + ep) || ep.endsWith('/' + norm);
    });
    if (!matched) return null;
    if (matched.untracked) return { label: 'U', color: '#73c991' };
    if (matched.staged) return { label: 'A', color: '#73c991' };
    if (matched.workTree && matched.workTree.trim()) return { label: 'M', color: '#e2c08d' };
    return null;
  } catch {
    return null;
  }
}

interface GitLineDiff {
  type: 'added' | 'modified' | 'deleted';
  startLine: number;
  endLine: number;
}

function computeLineDiffs(originalText: string, modifiedText: string): GitLineDiff[] {
  const origLines = originalText.replace(/\r/g, '').split('\n');
  const modLines = modifiedText.replace(/\r/g, '').split('\n');

  const N = origLines.length;
  const M = modLines.length;

  let start = 0;
  while (start < N && start < M && origLines[start] === modLines[start]) {
    start++;
  }

  let origEnd = N - 1;
  let modEnd = M - 1;
  while (origEnd >= start && modEnd >= start && origLines[origEnd] === modLines[modEnd]) {
    origEnd--;
    modEnd--;
  }

  const subOrig = origLines.slice(start, origEnd + 1);
  const subMod = modLines.slice(start, modEnd + 1);

  const subN = subOrig.length;
  const subM = subMod.length;

  const diffs: GitLineDiff[] = [];

  if (subN === 0 && subM === 0) {
    return diffs;
  }

  if (subN === 0 && subM > 0) {
    diffs.push({
      type: 'added',
      startLine: start + 1,
      endLine: start + subM,
    });
    return diffs;
  }

  if (subN > 0 && subM === 0) {
    diffs.push({
      type: 'deleted',
      startLine: Math.max(1, start),
      endLine: Math.max(1, start),
    });
    return diffs;
  }

  // Standard DP LCS for the sub-range
  const dp: number[][] = Array.from({ length: subN + 1 }, () => new Array(subM + 1).fill(0));
  for (let i = 1; i <= subN; i++) {
    for (let j = 1; j <= subM; j++) {
      if (subOrig[i - 1] === subMod[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  let i = subN;
  let j = subM;
  type DiffOp = { type: 'equal' | 'added' | 'deleted'; origIdx: number; modIdx: number };
  const ops: DiffOp[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && subOrig[i - 1] === subMod[j - 1]) {
      ops.push({ type: 'equal', origIdx: i - 1, modIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'added', origIdx: i, modIdx: j - 1 });
      j--;
    } else {
      ops.push({ type: 'deleted', origIdx: i - 1, modIdx: j });
      i--;
    }
  }

  ops.reverse();

  // Group consecutive non-equal ops into hunks
  let k = 0;
  while (k < ops.length) {
    if (ops[k].type === 'equal') {
      k++;
      continue;
    }

    let delCount = 0;
    let addCount = 0;
    const hunkStartMod = ops[k].modIdx;
    let firstModIdx = -1;
    let lastModIdx = -1;

    while (k < ops.length && ops[k].type !== 'equal') {
      if (ops[k].type === 'deleted') {
        delCount++;
      } else if (ops[k].type === 'added') {
        addCount++;
        if (firstModIdx === -1) firstModIdx = ops[k].modIdx;
        lastModIdx = ops[k].modIdx;
      }
      k++;
    }

    if (delCount > 0 && addCount > 0) {
      diffs.push({
        type: 'modified',
        startLine: start + (firstModIdx >= 0 ? firstModIdx : hunkStartMod) + 1,
        endLine: start + (lastModIdx >= 0 ? lastModIdx : hunkStartMod) + 1,
      });
    } else if (addCount > 0) {
      diffs.push({
        type: 'added',
        startLine: start + firstModIdx + 1,
        endLine: start + lastModIdx + 1,
      });
    } else if (delCount > 0) {
      const lineNum = Math.min(M, Math.max(1, start + hunkStartMod + 1));
      diffs.push({
        type: 'deleted',
        startLine: lineNum,
        endLine: lineNum,
      });
    }
  }

  return diffs;
}

interface TabContextMenuState {
  x: number;
  y: number;
  targetPath: string;
}

export function EditorPane({
  tabs,
  activePath,
  gitStatus,
  onSelectTab,
  onCloseTab,
  onCloseOthers,

  onCloseRight,
  onCloseSaved,
  onCloseAll,
  onNewUntitled,
  onChangeContent,
  onSelectionChange,
  onCursorChange,
  onAddToChat,
  onOpenFile,
  previewDiff,
  onCloseDiff,
  wordWrap = false,
  onToggleWordWrap,
  onPreviewGitDiff,
  onDiscardPath,
  onRefreshGitStatus,
  revealLine,
  revealColumn,
  revealNonce = 0,
  uiTheme,
  gitBlameInline = true,
  workspace,
  onPickLocal,
  onPickSsh,
  onPickClone,
  recentWorkspaces,
  onSelectRecentWorkspace,
  onRemoveRecentWorkspace,
  onClearRecentWorkspaces,
  onMoreWorkspaceHistory,
}: Props) {
  const active = tabs.find((t) => t.path === activePath) ?? null;
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const splitEditorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  // setEOL 对齐行尾期间为 true，用于拦截因此触发的 onChange 回声（避免误标脏/触发写盘）
  const eolAligningRef = useRef(false);
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const activeRef = useRef(active);
  activeRef.current = active;
  const onAddToChatRef = useRef(onAddToChat);
  onAddToChatRef.current = onAddToChat;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);
  const cmdKey = isMac ? '⌘' : 'Ctrl+';
  const pendingRevealColumn = useRef<number | null>(null);
  // Peek panel state: shown when there are multiple definition results
  const [peekResults, setPeekResults] = useState<PeekResult[]>([]);
  const [peekSymbol, setPeekSymbol] = useState<string>('');
  const [peekVisible, setPeekVisible] = useState(false);
  const monacoTheme = uiTheme === 'light' ? 'vs' : 'custom-dark';
  const pendingReveal = useRef<number | null>(null);

  const lastCursorPosRef = useRef<{ path: string; line: number; column: number } | null>(null);
  const isNavigatingBackRef = useRef(false);
  const navigatingBackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markNavigatingBack = useCallback(() => {
    isNavigatingBackRef.current = true;
    if (navigatingBackTimerRef.current) clearTimeout(navigatingBackTimerRef.current);
    navigatingBackTimerRef.current = setTimeout(() => {
      isNavigatingBackRef.current = false;
    }, 600);
  }, []);

  const trackCursorJump = useCallback((path: string | null | undefined, line: number, column: number) => {
    if (!path || isNavigatingBackRef.current) return;
    const prev = lastCursorPosRef.current;
    if (prev) {
      if (prev.path !== path || Math.abs(prev.line - line) >= 5) {
        navigationStack.push(prev);
      }
    }
    lastCursorPosRef.current = { path, line, column };
  }, []);

  const [selectedText, setSelectedText] = useState('');
  const [tabsScrolling, setTabsScrolling] = useState(false);
  const tabsScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTabsScroll = () => {
    setTabsScrolling(true);
    if (tabsScrollTimeoutRef.current) clearTimeout(tabsScrollTimeoutRef.current);
    tabsScrollTimeoutRef.current = setTimeout(() => {
      setTabsScrolling(false);
    }, 800);
  };

  const [selectionRange, setSelectionRange] = useState<{
    startLine: number;
    endLine: number;
  } | null>(null);
  const [selectionCoords, setSelectionCoords] = useState<{ top: number; left: number } | null>(
    null,
  );
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [mdEditorRatio, setMdEditorRatio] = useState<number>(0.5);
  // 滚动节流：滚动时会触发 onDidScrollChange 并调用 updateSelectionAndCoords，
  // 其内部会做 getScrolledVisiblePosition/getBoundingClientRect 并 setState(selectionCoords)，
  // 高频滚动下会持续重渲染导致卡顿。这里用 requestAnimationFrame 合并每次滚动的更新。
  const scrollRafRef = useRef<number | null>(null);
  const scheduleCoordsUpdate = useCallback((fn: () => void) => {
    if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      fn();
    });
  }, []);

  // 行内 Blame 用 ContentWidget（绝对定位浮层）而非注入文本实现：
  // 注入文本会计入视图行的 getLineMaxColumn，End 键/点击行尾会把光标移进
  // blame 文本内部（“光标停在行尾后几个字符”）。ContentWidget 完全在文本
  // 坐标系之外，光标无法进入，同时仍然锚定在行尾渲染。
  const removeBlameWidget = useCallback(() => {
    const widget = blameWidgetRef.current;
    const ed = blameOwnerEditorRef.current;
    if (widget && ed) {
      try {
        ed.removeContentWidget(widget);
      } catch {
        // 编辑器可能已销毁
      }
    }
    blameWidgetRef.current = null;
    blameWidgetPosRef.current = null;
    blameOwnerEditorRef.current = null;
  }, []);

  // 组件卸载时取消挂起的滚动更新，避免泄漏
  useEffect(() => {
    return () => {
      if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
      if (blameTimerRef.current) clearTimeout(blameTimerRef.current);
      removeBlameWidget();
    };
  }, [removeBlameWidget]);

  const startMdResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const ratio = (ev.clientX - rect.left) / rect.width;
      setMdEditorRatio(Math.max(0.15, Math.min(0.85, ratio)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(null);

  // Split editor state
  const [isSplit, setIsSplit] = useState(false);
  const [splitPath, setSplitPath] = useState<string | null>(null);
  const splitActive = (splitPath ? tabs.find((t) => t.path === splitPath) : null) ?? active;
  const [splitRatio, setSplitRatio] = useState<number>(0.5);
  const editorSplitContainerRef = useRef<HTMLDivElement>(null);

  // Inline AI edit state (Cmd+K)
  const [showInlineAi, setShowInlineAi] = useState(false);
  const [inlinePrompt, setInlinePrompt] = useState('');
  const inlineInputRef = useRef<HTMLInputElement>(null);

  const startSplitResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = editorSplitContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const ratio = (ev.clientX - rect.left) / rect.width;
      setSplitRatio(Math.max(0.2, Math.min(0.8, ratio)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const handleInlineAiSubmit = useCallback(() => {
    if (!inlinePrompt.trim() || !active) return;
    const rangeText = selectionRange
      ? ` 第 ${selectionRange.startLine}-${selectionRange.endLine} 行`
      : '';
    const promptText = `请修改当前文件 \`${active.path}\`${rangeText}：\n需求：${inlinePrompt.trim()}\n\n当前选区代码：\n\`\`\`${active.language || ''}\n${selectedText}\n\`\`\``;
    onAddToChat?.(promptText);
    setShowInlineAi(false);
    setInlinePrompt('');
  }, [active, inlinePrompt, selectionRange, selectedText, onAddToChat]);

  const handleQuickPrompt = useCallback((txt: string) => {
    setInlinePrompt(txt);
    setTimeout(() => inlineInputRef.current?.focus(), 20);
  }, []);

  const [showMdPreview, setShowMdPreview] = useState(false);
  const [showToc, setShowToc] = useState(false);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const tocListRef = useRef<HTMLDivElement>(null);
  const [gitDiffData, setGitDiffData] = useState<{ original: string; modified: string } | null>(
    null,
  );
  const [mdPreviewScrollTo, setMdPreviewScrollTo] = useState<string | null>(null);
  const mdPreviewRef = useRef<HTMLDivElement>(null);
  const decorationsRef = useRef<string[]>([]);
  const blameWidgetRef = useRef<MonacoEditor.IContentWidget | null>(null);
  const blameWidgetPosRef = useRef<MonacoEditor.IContentWidgetPosition | null>(null);
  const blameOwnerEditorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const blameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentBlameLineRef = useRef<number | null>(null);
  const blameCacheRef = useRef<Map<string, { text: string; lineNumber: number }>>(new Map());
  const [gitInlineDiffLine, setGitInlineDiffLine] = useState<number | null>(null);
  const isSyncingScrollRef = useRef(false);



  const applyBlameDecoration = useCallback(
    (ed: MonacoEditor.IStandaloneCodeEditor, lineNumber: number, text: string) => {
      const model = ed.getModel();
      if (!model || lineNumber > model.getLineCount() || lineNumber < 1) return;
      const maxCol = model.getLineMaxColumn(lineNumber);

      blameWidgetPosRef.current = {
        position: { lineNumber, column: maxCol },
        preference: [MonacoEditor.ContentWidgetPositionPreference.EXACT],
      };

      if (!blameWidgetRef.current || blameOwnerEditorRef.current !== ed) {
        removeBlameWidget();
        const domNode = document.createElement('div');
        domNode.className = 'monaco-inline-git-blame';
        const widget: MonacoEditor.IContentWidget = {
          getId: () => 'echoly-git-blame-inline',
          getDomNode: () => domNode,
          getPosition: () => blameWidgetPosRef.current,
        };
        ed.addContentWidget(widget);
        blameWidgetRef.current = widget;
        blameOwnerEditorRef.current = ed;
      }

      blameWidgetRef.current.getDomNode().textContent = text;
      ed.layoutContentWidget(blameWidgetRef.current);
    },
    [removeBlameWidget],
  );

  const updateGitBlame = useCallback(
    (lineNumber: number, immediate = false) => {
      currentBlameLineRef.current = lineNumber;
      const ed = editorRef.current;
      if (!gitBlameInline) {
        removeBlameWidget();
        return;
      }
      if (blameTimerRef.current) clearTimeout(blameTimerRef.current);

      if (!ed || !activePath || activePath.startsWith('untitled:')) {
        removeBlameWidget();
        return;
      }

      // Check cache first for instantaneous 0ms display on cursor move
      const cacheKey = `${activePath}:${lineNumber}`;
      const cached = blameCacheRef.current.get(cacheKey);
      if (cached) {
        applyBlameDecoration(ed, lineNumber, cached.text);
      }

      const runFetch = async () => {
        if (!editorRef.current || currentBlameLineRef.current !== lineNumber) return;
        try {
          const res = await window.ide.gitBlameLine(activePath, lineNumber);
          if (currentBlameLineRef.current !== lineNumber) return;

          let text = '';
          if (res && res.ok && res.commit && res.commit.hash && !/^0+$/.test(res.commit.hash)) {
            const c = res.commit;
            const cleanMsg = (c.message || '').replace(/[\r\n]+/g, ' ').trim();
            const msg = cleanMsg.length > 40 ? cleanMsg.slice(0, 38) + '…' : cleanMsg;
            text = `${c.author}, ${c.relativeDate || c.date || '已提交'} • ${msg}`;
          } else {
            text = 'You, 未提交的更改 • 未保存或未提交的修改';
          }

          blameCacheRef.current.set(cacheKey, { text, lineNumber });
          if (editorRef.current) {
            applyBlameDecoration(editorRef.current, lineNumber, text);
          }
        } catch {
          const fallback = 'You, 未提交的更改 • 未保存或未提交的修改';
          if (editorRef.current && currentBlameLineRef.current === lineNumber) {
            applyBlameDecoration(editorRef.current, lineNumber, fallback);
          }
        }
      };

      if (immediate || cached) {
        void runFetch();
      } else {
        blameTimerRef.current = setTimeout(runFetch, 80);
      }
    },
    [activePath, gitBlameInline, applyBlameDecoration],
  );

  const updateGitBlameRef = useRef(updateGitBlame);
  updateGitBlameRef.current = updateGitBlame;

  // Whenever active file, content or gitBlameInline setting changes, re-apply blame so it stays permanently on cursor line!
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (!gitBlameInline) {
      removeBlameWidget();
      return;
    }
    // 状态或内容变更时立即清除缓存，避免恢复后依然展示旧的“未提交的修改”
    blameCacheRef.current.clear();
    const pos = ed.getPosition();
    const line = pos?.lineNumber ?? currentBlameLineRef.current;
    if (line != null && line > 0) {
      updateGitBlameRef.current(line, true);
    }
  }, [activePath, active?.content, gitBlameInline, gitStatus, removeBlameWidget]);

  // Track which line ranges are modified (for inline diff popup on gutter click)
  const modifiedRangesRef = useRef<Array<{ start: number; end: number }>>([]);
  const activeTabRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (activeTabRef.current) {
      activeTabRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });
    }
  }, [activePath]);

  const isMarkdown = Boolean(activePath?.endsWith('.md'));
  const activeLanguage = useMemo(() => {
    if (!active) return 'plaintext';
    if (active.language && active.language !== 'plaintext') return active.language;
    return languageFromPath(active.path);
  }, [active]);
  const splitActiveLanguage = useMemo(() => {
    if (!splitActive) return 'plaintext';
    if (splitActive.language && splitActive.language !== 'plaintext') return splitActive.language;
    return languageFromPath(splitActive.path);
  }, [splitActive]);
  const mdHeadings = useMemo(() => {
    if (!active || !isMarkdown) return [];
    return extractMarkdownHeadings(active.content);
  }, [active?.content, isMarkdown]);
  const isImage = Boolean(
    active && (active.language === 'image' || active.previewUrl || isImagePath(active.path)),
  );
  const activeGitMeta = getTabGitMeta(activePath, gitStatus?.entries);

  useEffect(() => {
    if (!activePath || activePath.startsWith('untitled:') || isImage || !window.ide?.gitDiff) {
      setGitDiffData(null);
      return;
    }
    let cancelled = false;
    window.ide
      .gitDiff(activePath, false)
      .then((res) => {
        if (cancelled) return;
        if (res && res.ok) {
          setGitDiffData({ original: res.original, modified: res.modified });
        } else {
          setGitDiffData(null);
        }
      })
      .catch(() => {
        if (!cancelled) setGitDiffData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activePath, gitStatus, isImage, active?.dirty]);

  // 外部重载内容（放弃修改 / Agent 改写文件 / 磁盘同步）时，@monaco-editor/react 通过 executeEdits
  // 写入新内容，而 Monaco 的 applyEdits 会把插入文本的行尾规范化为 model 既有 EOL。
  // 若 model 为 CRLF 而磁盘内容是 LF，model.getValue() 将返回 CRLF，后续任何一次保存都会
  // 把整个文件的换行符改写，造成 git 永久报 M 而 gutter（比较时剥离 \r）却显示无差异。
  // 这里在内容更新后把 model EOL 对齐为最新内容的 EOL，从源头消除这种字节级偏移。
  const alignModelEol = useCallback(
    (ed: MonacoEditor.IStandaloneCodeEditor | null, content?: string) => {
      const model = ed?.getModel();
      if (!model || model.isDisposed()) return;
      if (typeof content !== 'string' || content.length === 0) return;
      const wantCrlf = content.includes('\r\n');
      const isCrlf = model.getEOL() === '\r\n';
      if (wantCrlf === isCrlf) return;
      // 仅当内容除行尾外完全一致时才对齐，避免干扰正在进行中的真实编辑
      if (model.getValue().replace(/\r\n/g, '\n') !== content.replace(/\r\n/g, '\n')) return;
      eolAligningRef.current = true;
      try {
        model.setEOL(
          wantCrlf ? MonacoEditor.EndOfLineSequence.CRLF : MonacoEditor.EndOfLineSequence.LF,
        );
      } finally {
        eolAligningRef.current = false;
      }
    },
    [],
  );

  useEffect(() => {
    alignModelEol(editorRef.current, active?.content);
  }, [active?.path, active?.content, alignModelEol]);

  useEffect(() => {
    alignModelEol(splitEditorRef.current, splitActive?.content);
  }, [splitActive?.path, splitActive?.content, alignModelEol]);

  useEffect(() => {
    if (revealLine != null && revealLine > 0) {
      const col = revealColumn ?? 1;
      pendingReveal.current = revealLine;
      pendingRevealColumn.current = col;
      const ed = editorRef.current;
      if (ed) {
        const model = ed.getModel();
        const modelUri = model?.uri?.path || '';
        const currentActive = (activePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const isMatchingModel =
          Boolean(model) &&
          (modelUri.endsWith(currentActive) || currentActive.endsWith(modelUri.replace(/^\/+/, '')));

        if (isMatchingModel && model && revealLine <= model.getLineCount()) {
          try {
            ed.revealLineInCenter(revealLine);
            ed.setPosition({ lineNumber: revealLine, column: col });
            ed.focus();
            highlightJumpLocation(ed, revealLine);
            pendingReveal.current = null;
            pendingRevealColumn.current = null;
          } catch {
            // ignore
          }
        }
      }
    }
  }, [revealLine, revealColumn, activePath, revealNonce]);

  const setupEditorScrollSync = (ed: MonacoEditor.IStandaloneCodeEditor) => {
    ed.onDidScrollChange((e) => {
      if (isSyncingScrollRef.current) return;
      if (!mdPreviewRef.current) return;

      const previewEl = mdPreviewRef.current;
      const editorScrollTop = e.scrollTop;
      const editorScrollHeight = e.scrollHeight;
      const editorHeight = ed.getLayoutInfo().height;

      const maxEditorScroll = editorScrollHeight - editorHeight;
      if (maxEditorScroll <= 0) return;

      const scrollRatio = Math.max(0, Math.min(1, editorScrollTop / maxEditorScroll));
      const maxPreviewScroll = previewEl.scrollHeight - previewEl.clientHeight;

      if (maxPreviewScroll > 0) {
        isSyncingScrollRef.current = true;
        previewEl.scrollTop = scrollRatio * maxPreviewScroll;
        setTimeout(() => {
          isSyncingScrollRef.current = false;
        }, 40);
      }
    });
  };

  const updateActiveHeading = useCallback(() => {
    const previewEl = mdPreviewRef.current;
    if (!previewEl || mdHeadings.length === 0) return;

    // Check if scrolled near bottom: highlight the last heading
    if (previewEl.scrollHeight - previewEl.scrollTop - previewEl.clientHeight < 40) {
      setActiveHeadingId(mdHeadings[mdHeadings.length - 1].id);
      return;
    }

    const containerRect = previewEl.getBoundingClientRect();
    const threshold = containerRect.top + 90;

    let currentId: string | null = null;
    for (const h of mdHeadings) {
      const el = previewEl.querySelector(`#${CSS.escape(h.id)}`);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.top <= threshold) {
          currentId = h.id;
        } else {
          break;
        }
      }
    }

    if (!currentId && mdHeadings.length > 0) {
      currentId = mdHeadings[0].id;
    }
    setActiveHeadingId(currentId);
  }, [mdHeadings]);

  // Sync active heading on preview / TOC toggle
  useEffect(() => {
    if (showMdPreview && showToc) {
      updateActiveHeading();
    }
  }, [showMdPreview, showToc, updateActiveHeading]);

  // Keep active item visible inside TOC floating list
  useEffect(() => {
    if (!showToc || !activeHeadingId) return;
    const activeItem = tocListRef.current?.querySelector('.md-toc-item.active');
    if (activeItem) {
      activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [activeHeadingId, showToc]);

  const handlePreviewScroll = () => {
    updateActiveHeading();
    if (isSyncingScrollRef.current) return;
    const previewEl = mdPreviewRef.current;
    const ed = editorRef.current;
    if (!previewEl || !ed) return;

    const maxPreviewScroll = previewEl.scrollHeight - previewEl.clientHeight;
    if (maxPreviewScroll <= 0) return;

    const scrollRatio = Math.max(0, Math.min(1, previewEl.scrollTop / maxPreviewScroll));
    const maxEditorScroll = ed.getScrollHeight() - ed.getLayoutInfo().height;

    if (maxEditorScroll > 0) {
      isSyncingScrollRef.current = true;
      ed.setScrollTop(scrollRatio * maxEditorScroll);
      setTimeout(() => {
        isSyncingScrollRef.current = false;
      }, 40);
    }
  };

  // Apply git decorations (gutter indicators & overview ruler) from diff data
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !gitDiffData) {
      if (ed) {
        decorationsRef.current = ed.deltaDecorations(decorationsRef.current, []);
      }
      modifiedRangesRef.current = [];
      return;
    }

    const originalText = gitDiffData.original;
    const currentText = active?.content ?? gitDiffData.modified;
    const diffs = computeLineDiffs(originalText, currentText);

    const decorations: MonacoEditor.IModelDeltaDecoration[] = [];
    const ranges: Array<{ start: number; end: number }> = [];

    for (const diff of diffs) {
      ranges.push({ start: diff.startLine, end: diff.endLine });
      decorations.push({
        range: {
          startLineNumber: diff.startLine,
          startColumn: 1,
          endLineNumber: diff.endLine,
          endColumn: 1,
        },
        options: {
          isWholeLine: true,
          linesDecorationsClassName: `git-gutter-${diff.type}`,
          glyphMarginClassName: 'git-gutter-glyph',
          overviewRuler: {
            color:
              diff.type === 'added'
                ? '#2ea043'
                : diff.type === 'deleted'
                  ? '#f85149'
                  : '#e2c08d',
            position: 7, // OverviewRulerLane.Full
          },
        },
      });
    }

    modifiedRangesRef.current = ranges;
    decorationsRef.current = ed.deltaDecorations(decorationsRef.current, decorations);
  }, [gitDiffData, active?.content]);

  useEffect(() => {
    if (!active) {
      onSelectionChangeRef.current?.('');
      setSelectedText('');
    }
    // Close peek panel whenever the active file changes
    setPeekVisible(false);
  }, [active]);

  // Single-Hunk Discard Handler (reverts ONLY the target modified hunk, leaving other changes in the file intact)
  const handleDiscardSingleHunk = async () => {
    if (!active?.path || !gitDiffData || gitInlineDiffLine == null) return;
    const origLines = gitDiffData.original.split('\n');
    const modLines = (active.content || gitDiffData.modified).split('\n');
    const targetL = gitInlineDiffLine;

    let oi = 0,
      mi = 0;
    let currentHunk: { modStart: number; modEnd: number; origLines: string[] } | null = null;
    let matchingHunk: { modStart: number; modEnd: number; origLines: string[] } | null = null;

    while (oi < origLines.length || mi < modLines.length) {
      if (oi < origLines.length && mi < modLines.length && origLines[oi] === modLines[mi]) {
        if (currentHunk) {
          if (targetL >= currentHunk.modStart && targetL <= currentHunk.modEnd) {
            matchingHunk = currentHunk;
            break;
          }
          currentHunk = null;
        }
        oi++;
        mi++;
      } else {
        if (!currentHunk) {
          currentHunk = { modStart: mi + 1, modEnd: mi + 1, origLines: [] };
        } else {
          currentHunk.modEnd = mi + 1;
        }

        if (oi < origLines.length && mi < modLines.length) {
          currentHunk.origLines.push(origLines[oi]);
          oi++;
          mi++;
        } else if (
          mi < modLines.length &&
          (oi >= origLines.length || !origLines.slice(oi, oi + 10).includes(modLines[mi]))
        ) {
          mi++;
        } else if (oi < origLines.length) {
          currentHunk.origLines.push(origLines[oi]);
          oi++;
        }
      }
    }

    if (
      currentHunk &&
      !matchingHunk &&
      targetL >= currentHunk.modStart &&
      targetL <= currentHunk.modEnd
    ) {
      matchingHunk = currentHunk;
    }

    if (!matchingHunk) return;

    const newModLines = [
      ...modLines.slice(0, matchingHunk.modStart - 1),
      ...matchingHunk.origLines,
      ...modLines.slice(matchingHunk.modEnd),
    ];

    const newContent = newModLines.join('\n');
    await window.ide.writeFile(active.path, newContent);
    const isNowClean = Boolean(gitDiffData && newContent === gitDiffData.original);
    onChangeContent(active.path, newContent, !isNowClean);
    onRefreshGitStatus?.();
    setGitInlineDiffLine(null);
  };

  // Tab Context Menu Action Handlers
  const handleCloseTab = (path: string) => {
    onCloseTab(path);
    setContextMenu(null);
  };

  const handleCloseOthers = (targetPath: string) => {
    if (onCloseOthers) {
      onCloseOthers(targetPath);
    } else {
      onSelectTab(targetPath);
      tabs.filter((t) => t.path !== targetPath).forEach((t) => onCloseTab(t.path));
    }
    setContextMenu(null);
  };

  const handleCloseRight = (targetPath: string) => {
    if (onCloseRight) {
      onCloseRight(targetPath);
    } else {
      onSelectTab(targetPath);
      const idx = tabs.findIndex((t) => t.path === targetPath);
      if (idx >= 0) {
        tabs.slice(idx + 1).forEach((t) => onCloseTab(t.path));
      }
    }
    setContextMenu(null);
  };

  const handleCloseSaved = () => {
    if (onCloseSaved) {
      onCloseSaved();
    } else {
      tabs.filter((t) => !t.dirty).forEach((t) => onCloseTab(t.path));
    }
    setContextMenu(null);
  };

  const handleCloseAll = () => {
    if (onCloseAll) {
      onCloseAll();
    } else {
      tabs.forEach((t) => onCloseTab(t.path));
    }
    setContextMenu(null);
  };

  const handleCopyPath = async (targetPath: string, relative = false) => {
    try {
      if (relative) {
        await navigator.clipboard.writeText(targetPath);
      } else {
        const abs = await window.ide.resolveAbsolutePath(targetPath);
        await navigator.clipboard.writeText(abs);
      }
    } catch (err) {
      console.error(err);
    }
    setContextMenu(null);
  };

  const handleShowInFinder = async (targetPath: string) => {
    try {
      await window.ide.downloadFile(targetPath);
    } catch (err) {
      console.error(err);
    }
    setContextMenu(null);
  };

  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleAddToChat = (e?: React.SyntheticEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!active?.path) return;
    const rangeLabel =
      selectionRange && selectionRange.startLine === selectionRange.endLine
        ? `L${selectionRange.startLine}`
        : selectionRange
          ? `L${selectionRange.startLine}-L${selectionRange.endLine}`
          : '';
    const refToken = `@${active.path}${rangeLabel ? `:${rangeLabel}` : ''}`;
    onAddToChat?.(refToken);
  };

  const isMouseDownRef = useRef(false);

  const updateSelectionTextOnly = useCallback((ed: MonacoEditor.IStandaloneCodeEditor) => {
    const model = ed.getModel();
    const sel = ed.getSelection();
    if (!model || !sel || sel.isEmpty()) {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = setTimeout(() => {
        onSelectionChangeRef.current?.('');
        setSelectedText('');
        setSelectionRange(null);
      }, 250);
      return;
    }
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    const val = model.getValueInRange(sel);
    onSelectionChangeRef.current?.(val);
    setSelectedText(val);
    setSelectionRange({
      startLine: sel.startLineNumber,
      endLine: sel.endLineNumber,
    });
  }, []);

  const updateSelectionAndCoords = useCallback((ed: MonacoEditor.IStandaloneCodeEditor) => {
    const model = ed.getModel();
    const sel = ed.getSelection();
    if (!model || !sel || sel.isEmpty()) {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = setTimeout(() => {
        onSelectionChangeRef.current?.('');
        setSelectedText('');
        setSelectionRange(null);
        setSelectionCoords(null);
      }, 250);
      return;
    }
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    const val = model.getValueInRange(sel);
    onSelectionChangeRef.current?.(val);
    setSelectedText(val);
    setSelectionRange({
      startLine: sel.startLineNumber,
      endLine: sel.endLineNumber,
    });

    // Only compute and display floating coordinates when mouse is NOT pressed down
    if (isMouseDownRef.current) {
      setSelectionCoords(null);
      return;
    }

    repositionSelectionCoords(ed);
  }, []);

  // 轻量版：滚动时只重算浮层坐标，避免重复 getValueInRange / 触发父级 setState。
  // 与 updateSelectionAndCoords 分开，滚动时走这个更省。
  const repositionSelectionCoords = useCallback((ed: MonacoEditor.IStandaloneCodeEditor) => {
    const sel = ed.getSelection();
    if (!sel) return;
    try {
      const endPos = sel.getEndPosition();
      const visiblePos = ed.getScrolledVisiblePosition(endPos);
      const editorDom = ed.getDomNode();
      const containerDom = editorContainerRef.current;
      if (visiblePos && editorDom && containerDom) {
        const editorRect = editorDom.getBoundingClientRect();
        const containerRect = containerDom.getBoundingClientRect();
        const left = editorRect.left - containerRect.left + visiblePos.left + 8;
        const isNearTop = visiblePos.top < 32;
        const top = isNearTop
          ? editorRect.top - containerRect.top + visiblePos.top + (visiblePos.height || 18) + 4
          : editorRect.top - containerRect.top + visiblePos.top - 28;

        setSelectionCoords({
          left: Math.max(10, Math.min(left, containerRect.width - 170)),
          top: Math.max(8, Math.min(top, containerRect.height - 35)),
        });
      }
    } catch {
      // ignore
    }
  }, []);

  const openInlineAiForEditor = useCallback(
    (ed: MonacoEditor.IStandaloneCodeEditor) => {
      const sel = ed.getSelection();
      const model = ed.getModel();
      if (model && sel) {
        if (!sel.isEmpty()) {
          const text = model.getValueInRange(sel);
          setSelectedText(text);
          setSelectionRange({
            startLine: sel.startLineNumber,
            endLine: sel.endLineNumber,
          });
        } else {
          // If no selection range, select current line
          const lineNum = sel.positionLineNumber;
          const lineContent = model.getLineContent(lineNum);
          setSelectedText(lineContent);
          setSelectionRange({
            startLine: lineNum,
            endLine: lineNum,
          });
        }
      }
      repositionSelectionCoords(ed);
      setShowInlineAi(true);
      setTimeout(() => {
        inlineInputRef.current?.focus();
        inlineInputRef.current?.select();
      }, 50);
    },
    [repositionSelectionCoords],
  );

  const triggerAddToChatForEditor = useCallback((ed: MonacoEditor.IStandaloneCodeEditor) => {
    const curActive = activeRef.current;
    if (!curActive?.path) return;
    const sel = ed.getSelection();
    const model = ed.getModel();
    let rangeLabel = '';
    if (model && sel && !sel.isEmpty()) {
      rangeLabel =
        sel.startLineNumber === sel.endLineNumber
          ? `L${sel.startLineNumber}`
          : `L${sel.startLineNumber}-L${sel.endLineNumber}`;
    }
    const refToken = `@${curActive.path}${rangeLabel ? `:${rangeLabel}` : ''}`;
    onAddToChatRef.current?.(refToken);
    setSelectionCoords(null);
  }, []);

  const setupEditorKeybindings = useCallback(
    (ed: MonacoEditor.IStandaloneCodeEditor, onOpenFileRef?: { current?: typeof onOpenFile }) => {
      ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyK, () => {
        openInlineAiForEditor(ed);
      });
      ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyL, () => {
        triggerAddToChatForEditor(ed);
      });
      // Go back through jump history:
      // 1. macOS: Ctrl+- (Control + Minus, standard VS Code navigate back. NOT Cmd+- which zooms out!)
      ed.addCommand(KeyMod.WinCtrl | KeyCode.Minus, () => {
        markNavigatingBack();
        const fn = onOpenFileRef?.current ?? onOpenFile;
        if (fn) {
          navigateBack(
            {
              onOpenFile: fn,
              getWorkspaceRoot: () => workspace,
              getCurrentPath: () => activeRef.current?.path ?? null,
              getCurrentPosition: () => {
                const pos = ed.getPosition();
                return pos ? { line: pos.lineNumber, column: pos.column } : null;
              },
            },
            ed
          );
        }
      });
      // 2. Cmd+[ (standard Mac back navigation in browsers, Xcode, etc.)
      ed.addCommand(KeyMod.CtrlCmd | KeyCode.BracketLeft, () => {
        markNavigatingBack();
        const fn = onOpenFileRef?.current ?? onOpenFile;
        if (fn) {
          navigateBack(
            {
              onOpenFile: fn,
              getWorkspaceRoot: () => workspace,
              getCurrentPath: () => activeRef.current?.path ?? null,
              getCurrentPosition: () => {
                const pos = ed.getPosition();
                return pos ? { line: pos.lineNumber, column: pos.column } : null;
              },
            },
            ed
          );
        }
      });
      // 3. Windows/Linux: Alt+LeftArrow
      ed.addCommand(KeyMod.Alt | KeyCode.LeftArrow, () => {
        if (!navigator.platform.toUpperCase().includes('MAC')) {
          markNavigatingBack();
          const fn = onOpenFileRef?.current ?? onOpenFile;
          if (fn) {
            navigateBack(
              {
                onOpenFile: fn,
                getWorkspaceRoot: () => workspace,
                getCurrentPath: () => activeRef.current?.path ?? null,
                getCurrentPosition: () => {
                  const pos = ed.getPosition();
                  return pos ? { line: pos.lineNumber, column: pos.column } : null;
                },
              },
              ed
            );
          }
        }
      });
      // When switching to another file tab via navigation, reveal line as soon as new model attaches
      ed.onDidChangeModel(() => {
        if (pendingReveal.current != null) {
          const line = pendingReveal.current;
          const col = pendingRevealColumn.current ?? 1;
          pendingReveal.current = null;
          pendingRevealColumn.current = null;
          requestAnimationFrame(() => {
            ed.revealLineInCenter(line);
            ed.setPosition({ lineNumber: line, column: col });
            ed.focus();
            highlightJumpLocation(ed, line);
          });
        }
      });
    },
    [openInlineAiForEditor, triggerAddToChatForEditor, workspace, onOpenFile],
  );

  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (isMouseDownRef.current) {
        isMouseDownRef.current = false;
        if (editorRef.current) {
          updateSelectionAndCoords(editorRef.current);
        }
      }
    };
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => {
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [updateSelectionAndCoords]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (peekVisible) {
          setPeekVisible(false);
          editorRef.current?.focus();
          return;
        }
        if (showInlineAi) {
          setShowInlineAi(false);
          editorRef.current?.focus();
          return;
        }
      }

      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      if (!isCmdOrCtrl) return;

      const key = e.key.toLowerCase();
      if (key === 'k') {
        if (editorRef.current && activeRef.current?.path) {
          e.preventDefault();
          e.stopPropagation();
          openInlineAiForEditor(editorRef.current);
        }
      } else if (key === 'l') {
        if (editorRef.current && activeRef.current?.path) {
          e.preventDefault();
          e.stopPropagation();
          triggerAddToChatForEditor(editorRef.current);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [showInlineAi, peekVisible, openInlineAiForEditor, triggerAddToChatForEditor]);

  if (previewDiff) {
    const lang = languageFromPath(previewDiff.path);
    const modifiedFiles = gitStatus?.entries || [];
    const totalDiffs = modifiedFiles.length || 1;
    const currentFileName = previewDiff.path.split('/').pop() || previewDiff.path;
    const currentIndex = modifiedFiles.findIndex((e) => e.path === previewDiff.path);
    const displayIndex = currentIndex !== -1 ? currentIndex + 1 : 1;

    return (
      <div className="editor-area">
        <div
          className="diff-title-row"
          style={{
            height: 35,
            padding: '0 12px',
            background: 'var(--bg-active)',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 12,
            color: 'var(--text)',
            boxSizing: 'border-box',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
            <span style={{ fontWeight: 600, color: 'var(--text)' }}>{currentFileName}</span>
            <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
              Git 本地更改(工作树) - 第 {displayIndex} 个更改(共 {totalDiffs} 个)
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            {/* 1. Stage button + */}
            <button
              type="button"
              title="暂存更改"
              onClick={async () => {
                await window.ide.gitStage([previewDiff.path]);
                onRefreshGitStatus?.();
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
                justifyContent: 'center',
              }}
              className="icon-btn"
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

            {/* 2. Discard button ⟲ */}
            <button
              type="button"
              title="放弃更改"
              onClick={() => {
                onDiscardPath?.(previewDiff.path);
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
                justifyContent: 'center',
              }}
              className="icon-btn"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>

            {/* 3. Next diff ↓ */}
            <button
              type="button"
              title="下一个更改"
              onClick={() => {
                if (modifiedFiles.length > 0) {
                  const nextIdx = (currentIndex + 1) % modifiedFiles.length;
                  onPreviewGitDiff?.(modifiedFiles[nextIdx].path);
                }
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
                justifyContent: 'center',
              }}
              className="icon-btn"
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
                <polyline points="19 12 12 19 5 12" />
              </svg>
            </button>

            {/* 4. Previous diff ↑ */}
            <button
              type="button"
              title="上一个更改"
              onClick={() => {
                if (modifiedFiles.length > 0) {
                  const prevIdx = (currentIndex - 1 + modifiedFiles.length) % modifiedFiles.length;
                  onPreviewGitDiff?.(modifiedFiles[prevIdx].path);
                }
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
                justifyContent: 'center',
              }}
              className="icon-btn"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </button>

            {/* 5. Close ✕ */}
            {onCloseDiff && (
              <button
                type="button"
                title="关闭预览"
                onClick={onCloseDiff}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--muted)',
                  cursor: 'pointer',
                  padding: 4,
                  borderRadius: 4,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                className="icon-btn"
              >
                <svg
                  width="14"
                  height="14"
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
        </div>
        <div className="editor-fill">
          <DiffEditor
            original={previewDiff.original}
            modified={previewDiff.modified}
            language={lang}
            theme={monacoTheme}
            onMount={(diffEd) => {
              setTimeout(() => {
                const changes = diffEd.getLineChanges();
                if (changes && changes.length > 0) {
                  const line =
                    changes[0].modifiedStartLineNumber || changes[0].originalStartLineNumber || 1;
                  diffEd.getModifiedEditor().revealLineInCenter(line);
                }
              }, 150);
            }}
            options={{
              readOnly: true,
              renderSideBySide: true,
              smoothScrolling: true,
              renderOverviewRuler: false,
              overviewRulerLanes: 0,
              overviewRulerBorder: false,
              renderIndicators: true,
              ignoreTrimWhitespace: false,
              minimap: { enabled: false },
              lineNumbersMinChars: 4,
              lineDecorationsWidth: 10,
              glyphMargin: false,
              folding: true,
              wordWrap: wordWrap ? 'on' : 'off',
              scrollbar: {
                vertical: 'visible',
                horizontal: 'auto',
                verticalScrollbarSize: 4,
                horizontalScrollbarSize: 3,
                verticalSliderSize: 4,
                horizontalSliderSize: 3,
                useShadows: false,
              },
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="editor-area" onClick={() => setContextMenu(null)}>
      {tabs.length > 0 && (
        <div
          className={`tabs ${tabsScrolling ? 'tabs-scrolling' : ''}`}
          onScroll={handleTabsScroll}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest('.tab')) return;
            onNewUntitled?.();
          }}
          title={onNewUntitled ? '双击空白处新建文本文件' : undefined}
        >
          {tabs.map((tab) => {
            const fileName = isUntitledPath(tab.path)
              ? untitledTabLabel(tab.path)
              : tab.path.split('/').pop() || tab.path;
            const gitMeta = getTabGitMeta(tab.path, gitStatus?.entries);
            const isActive = tab.path === activePath;
            return (
              <button
                key={tab.path}
                ref={isActive ? activeTabRef : null}
                className={`tab ${isActive ? 'active' : ''}`}
                onClick={() => onSelectTab(tab.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({
                    x: e.clientX,
                    y: e.clientY,
                    targetPath: tab.path,
                  });
                }}
              >
                <RenderFileTreeIcon name={fileName} isDirectory={false} />
                <span className="tab-title" style={{ color: gitMeta?.color }}>
                  {fileName}
                </span>
                {gitMeta?.label && (
                  <span
                    className="tab-git-badge"
                    style={{
                      color: gitMeta.color,
                    }}
                    title="点击查看 Git 对比"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (tab.path === activePath) {
                        const curLine = editorRef.current?.getPosition()?.lineNumber || 1;
                        setGitInlineDiffLine(curLine);
                      } else {
                        onSelectTab(tab.path);
                        setTimeout(() => setGitInlineDiffLine(1), 100);
                      }
                    }}
                  >
                    {gitMeta.label}
                  </span>
                )}
                <span
                  className={`tab-close-btn${tab.dirty ? ' is-dirty' : ''}`}
                  title={tab.dirty ? '未保存 (点击关闭)' : '关闭'}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.path);
                  }}
                >
                  {tab.dirty && <span className="dirty-dot">•</span>}
                  <svg className="close-icon" width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M2.146 2.854a.5.5 0 1 1 .708-.708L8 7.293l5.146-5.147a.5.5 0 0 1 .708.708L8.707 8l5.147 5.146a.5.5 0 0 1-.708.708L8 8.707l-5.146 5.147a.5.5 0 0 1-.708-.708L7.293 8 2.146 2.854Z" />
                  </svg>
                </span>
              </button>
            );
          })}
          <div className="tabs-rest" aria-hidden />
        </div>
      )}

      {/* Breadcrumb Navigation Bar (Match User Screenshot 2) */}
      {typeof activePath === 'string' && activePath.trim().length > 0 && (
        <div className="editor-breadcrumb">
          {(isUntitledPath(activePath)
            ? [untitledTabLabel(activePath)]
            : activePath.split('/')
          ).map((part, i, arr) => (
            <span key={i} className="crumb-item">
              <span>{part}</span>
              {i < arr.length - 1 && <span className="crumb-sep">&gt;</span>}
            </span>
          ))}
          <div className="editor-breadcrumb-actions">
            <button
              type="button"
              className="editor-breadcrumb-btn breadcrumb-nav-back-btn"
              title="返回跳转前位置 (⌃- 或 ⌘[)"
              onClick={() => {
                markNavigatingBack();
                const fn = onOpenFileRef?.current ?? onOpenFile;
                if (fn) {
                  navigateBack(
                    {
                      onOpenFile: fn,
                      getWorkspaceRoot: () => workspace,
                      getCurrentPath: () => activeRef.current?.path ?? null,
                      getCurrentPosition: () => {
                        const pos = editorRef.current?.getPosition();
                        return pos ? { line: pos.lineNumber, column: pos.column } : null;
                      },
                    },
                    editorRef.current
                  );
                }
              }}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style={{ verticalAlign: -1 }}>
                <path fillRule="evenodd" d="M15 8a.5.5 0 0 0-.5-.5H2.707l3.147-3.146a.5.5 0 1 0-.708-.708l-4 4a.5.5 0 0 0 0 .708l4 4a.5.5 0 0 0 .708-.708L2.707 8.5H14.5A.5.5 0 0 0 15 8z" />
              </svg>
              <span>返回</span>
            </button>
            {isMarkdown && (
              <button
                type="button"
                className={`md-preview-btn${showMdPreview ? ' active' : ''}`}
                onClick={() => setShowMdPreview((v) => !v)}
              >
                {showMdPreview ? (
                  <>
                    <svg
                      width="12.5"
                      height="12.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ marginRight: 4, verticalAlign: -1 }}
                    >
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                    编辑
                  </>
                ) : (
                  <>
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ marginRight: 4, verticalAlign: -2 }}
                    >
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                    预览
                  </>
                )}
              </button>
            )}
            {isMarkdown && showMdPreview && (
              <button
                type="button"
                className={`editor-breadcrumb-btn${showToc ? ' active' : ''}`}
                onClick={() => setShowToc((v) => !v)}
                title={showToc ? '收起目录大纲' : '展开目录大纲'}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ marginRight: 5, verticalAlign: -2 }}
                >
                  <line x1="9" y1="6" x2="20" y2="6" />
                  <line x1="9" y1="12" x2="20" y2="12" />
                  <line x1="9" y1="18" x2="20" y2="18" />
                  <circle cx="4" cy="6" r="1.5" fill="currentColor" />
                  <circle cx="4" cy="12" r="1.5" fill="currentColor" />
                  <circle cx="4" cy="18" r="1.5" fill="currentColor" />
                </svg>
                目录{mdHeadings.length > 0 ? ` (${mdHeadings.length})` : ''}
              </button>
            )}
            {onToggleWordWrap && (
              <button
                type="button"
                className={`editor-breadcrumb-btn${wordWrap ? ' active' : ''}`}
                onClick={onToggleWordWrap}
                title={wordWrap ? '禁用自动换行' : '启用自动换行'}
              >
                ↵ 换行
              </button>
            )}
            <button
              type="button"
              className={`editor-breadcrumb-btn${isSplit ? ' active' : ''}`}
              onClick={() => {
                setIsSplit((v) => !v);
                if (!isSplit && !splitPath) {
                  const otherTab = tabs.find((t) => t.path !== activePath);
                  setSplitPath(otherTab ? otherTab.path : activePath);
                }
              }}
              title={isSplit ? '关闭拆分' : '拆分编辑器 (双栏编辑/对比)'}
            >
              ◫ 拆分
            </button>
          </div>
        </div>
      )}

      <div className="editor-fill" ref={editorContainerRef} style={{ position: 'relative' }}>
        {/* Floating Add-to-Chat prompt when selection is present */}
        {selectedText.trim().length > 0 && active?.path && selectionCoords && !showInlineAi && (
          <div
            className="selection-float-widget compact"
            style={{
              left: `${selectionCoords.left}px`,
              top: `${selectionCoords.top}px`,
            }}
          >
            <button
              type="button"
              className="selection-ai-btn"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (editorRef.current) {
                  triggerAddToChatForEditor(editorRef.current);
                } else {
                  handleAddToChat(e);
                  setSelectionCoords(null);
                }
              }}
              title={`添加到 AI 会话提问 (${cmdKey}L)`}
            >
              <svg
                className="selection-ai-sparkle-icon"
                viewBox="0 0 16 16"
                width="13"
                height="13"
                fill="none"
              >
                <path
                  d="M8 1.5C8.3 4.8 11.2 7.7 14.5 8C11.2 8.3 8.3 11.2 8 14.5C7.7 11.2 4.8 8.3 1.5 8C4.8 7.7 7.7 4.8 8 1.5Z"
                  fill="url(#ai-sparkle-grad)"
                />
                <defs>
                  <linearGradient
                    id="ai-sparkle-grad"
                    x1="1.5"
                    y1="1.5"
                    x2="14.5"
                    y2="14.5"
                    gradientUnits="userSpaceOnUse"
                  >
                    <stop stopColor="#a78bfa" />
                    <stop offset="1" stopColor="#38bdf8" />
                  </linearGradient>
                </defs>
              </svg>
              <span>AI 提问</span>
              <kbd className="selection-ai-kbd">{cmdKey} L</kbd>
            </button>
            <div className="selection-ai-divider" />
            <button
              type="button"
              className="selection-ai-inline-btn"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (editorRef.current) {
                  openInlineAiForEditor(editorRef.current);
                } else {
                  setShowInlineAi(true);
                  setTimeout(() => inlineInputRef.current?.focus(), 50);
                }
              }}
              title={`行内智能编辑 (${cmdKey}K)`}
            >
              <span>编辑</span>
              <kbd className="selection-ai-kbd">{cmdKey} K</kbd>
            </button>
          </div>
        )}

        {/* Inline AI Edit Widget (Cmd+K) */}
        {showInlineAi && active?.path && (
          <div
            className="inline-ai-widget"
            style={{
              left: selectionCoords ? `${Math.max(16, selectionCoords.left - 60)}px` : '40px',
              top: selectionCoords ? `${Math.max(10, selectionCoords.top + 28)}px` : '40px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="inline-ai-header">
              <span className="inline-ai-title">
                ✦ 行内 AI 编辑{' '}
                {selectionRange ? `(行 ${selectionRange.startLine}-${selectionRange.endLine})` : ''}
              </span>
              <button
                type="button"
                className="inline-ai-close"
                onClick={() => setShowInlineAi(false)}
                title="关闭 (Esc)"
              >
                ×
              </button>
            </div>
            <div className="inline-ai-input-row">
              <input
                ref={inlineInputRef}
                type="text"
                className="inline-ai-input"
                placeholder="输入修改要求，例如：重构优化 / 增加异常捕获 (Enter 发送)"
                value={inlinePrompt}
                onChange={(e) => setInlinePrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleInlineAiSubmit();
                  } else if (e.key === 'Escape') {
                    setShowInlineAi(false);
                  }
                }}
              />
              <button
                type="button"
                className="inline-ai-submit-btn"
                disabled={!inlinePrompt.trim()}
                onClick={handleInlineAiSubmit}
              >
                发送
              </button>
            </div>
            <div className="inline-ai-tags">
              <span
                className="inline-ai-tag"
                onClick={() => handleQuickPrompt('优化并简化此段代码结构')}
              >
                优化结构
              </span>
              <span
                className="inline-ai-tag"
                onClick={() => handleQuickPrompt('为选区代码添加清晰的中文注释')}
              >
                添加注释
              </span>
              <span
                className="inline-ai-tag"
                onClick={() => handleQuickPrompt('增强入参校验与异常捕获逻辑')}
              >
                错误处理
              </span>
              <span
                className="inline-ai-tag"
                onClick={() => handleQuickPrompt('为此代码编写对应的单元测试用例')}
              >
                编写单测
              </span>
            </div>
          </div>
        )}

        {/* ── Definition Peek Panel: shown when Cmd+Click finds multiple results ── */}
        {peekVisible && peekResults.length > 0 && (
          <div
            className="def-peek-panel"
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              zIndex: 50,
              background: 'var(--bg-surface, #1e1e2e)',
              borderTop: '1px solid var(--border, #333)',
              maxHeight: 220,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 -4px 16px rgba(0,0,0,0.35)',
            }}
          >
            {/* Header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '5px 12px 4px',
              borderBottom: '1px solid var(--border, #333)',
              flexShrink: 0,
            }}>
              <span style={{ fontSize: 11, color: 'var(--muted, #888)', fontWeight: 600, letterSpacing: '0.03em' }}>
                "{peekSymbol}" 的 {peekResults.length} 个定义 — 点击跳转 &nbsp;|&nbsp; Alt+← 返回
              </span>
              <button
                type="button"
                onClick={() => setPeekVisible(false)}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--muted, #888)', fontSize: 16, lineHeight: 1, padding: '0 2px',
                }}
                title="关闭 (Esc)"
              >
                ×
              </button>
            </div>
            {/* Results list */}
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {peekResults.map((r, i) => (
                <button
                  key={i}
                  type="button"
                  className="def-peek-item"
                  onClick={() => {
                    setPeekVisible(false);
                    onOpenFile?.(r.path, r.line, r.column);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    width: '100%',
                    padding: '5px 14px',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: '1px solid var(--border-subtle, rgba(255,255,255,0.05))',
                    cursor: 'pointer',
                    textAlign: 'left',
                    color: 'var(--text, #cdd6f4)',
                    fontSize: 12,
                    fontFamily: 'var(--font-mono, monospace)',
                  }}
                >
                  <span style={{ color: 'var(--accent, #89b4fa)', flexShrink: 0, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '50%' }}>
                    {r.path}
                  </span>
                  <span style={{ color: 'var(--muted, #888)', flexShrink: 0 }}>:{r.line}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {active && isImage ? (
          <div className="image-preview-pane">
            {active.previewUrl ? (
              <>
                <div className="image-preview-stage">
                  <img
                    src={active.previewUrl}
                    alt={active.path.split('/').pop() || active.path}
                    className="image-preview-img"
                    draggable={false}
                  />
                </div>
                <div className="image-preview-meta">
                  <span className="image-preview-name">
                    {active.path.split('/').pop() || active.path}
                  </span>
                  <span className="image-preview-path">{active.path}</span>
                </div>
              </>
            ) : (
              <div className="image-preview-empty">无法加载图片预览</div>
            )}
          </div>
        ) : active && showMdPreview && isMarkdown ? (
          <div className="md-preview-split" ref={splitContainerRef}>
            <div
              className="md-preview-editor"
              style={{
                flex: `0 0 ${mdEditorRatio * 100}%`,
                width: `${mdEditorRatio * 100}%`,
              }}
            >
              <Editor
                path={workspace && !active.path.startsWith('/') ? `${workspace.replace(/[/\\]+$/, '')}/${active.path}` : active.path}
                value={active.content}
                language={activeLanguage}
                theme={monacoTheme}
                onChange={(v) => {
                  if (eolAligningRef.current) return; // setEOL 对齐行尾产生的回声，忽略
                  const content = v ?? '';
                  onChangeContent(active.path, content);
                  if (activeLanguage === 'python' && window.ide?.lspNotifyDocument) {
                    void window.ide.lspNotifyDocument(active.path, content, 'python');
                  }
                }}
                onMount={(ed) => {
                  editorRef.current = ed;
                  if (activeLanguage === 'python' && window.ide?.lspNotifyDocument) {
                    void window.ide.lspNotifyDocument(active.path, active.content, 'python');
                  }
                  // We use a ref wrapper so the keybinding closure always uses the latest onOpenFile
                  const onOpenFileRef = { current: onOpenFile };
                  setupEditorKeybindings(ed, onOpenFileRef);
                  setupEditorScrollSync(ed);
                  const cmdClickGesture = setupCmdClickGesture(ed, {
                    getWorkspaceRoot: () => workspace,
                    onOpenFile: (targetPath, line, col) => {
                      onOpenFile?.(targetPath, line, col);
                    },
                    onShowPeekResults: (results, symbol) => {
                      setPeekResults(results);
                      setPeekSymbol(symbol);
                      setPeekVisible(true);
                    },
                    getCurrentPath: () => activeRef.current?.path ?? null,
                    getCurrentPosition: () => {
                      const pos = ed.getPosition();
                      return pos ? { line: pos.lineNumber, column: pos.column } : null;
                    },
                  });
                  ed.onDidDispose(() => {
                    cmdClickGesture.dispose();
                  });
                  ed.onDidChangeCursorSelection(() => {
                    if (isMouseDownRef.current) {
                      updateSelectionTextOnly(ed);
                    } else {
                      updateSelectionAndCoords(ed);
                    }
                  });
                  ed.onDidScrollChange(() => {
                    if (isMouseDownRef.current) return;
                    // 滚动触发，用 rAF 合并，避免频繁 setState 重渲染造成卡顿
                    scheduleCoordsUpdate(() => repositionSelectionCoords(ed));
                  });
                  ed.onDidChangeCursorPosition((e) => {
                    onCursorChange?.(e.position.lineNumber, e.position.column);
                    updateGitBlameRef.current(e.position.lineNumber);
                    // Track cursor line text for md preview sync
                    if (showMdPreview && isMarkdown) {
                      const model = ed.getModel();
                      if (model) {
                        const lineText = model.getLineContent(e.position.lineNumber).trim();
                        if (lineText) setMdPreviewScrollTo(lineText);
                      }
                    }
                  });
                  // Git gutter click handler — GUTTER_LINE_NUMBERS = 4, GUTTER_GLYPH_MARGIN = 3
                  ed.onMouseDown((e) => {
                    if (e.event.metaKey || e.event.ctrlKey) {
                      return;
                    }
                    isMouseDownRef.current = true;
                    setSelectionCoords(null);
                    if (e.target.type === 4 || e.target.type === 3) {
                      const line = e.target.position?.lineNumber;
                      if (line && modifiedRangesRef.current.length > 0) {
                        const isModifiedLine = modifiedRangesRef.current.some(
                          (r) => line >= r.start && line <= r.end,
                        );
                        if (isModifiedLine) {
                          setGitInlineDiffLine(line);
                        }
                      }
                    }
                  });
                  ed.onMouseUp(() => {
                    isMouseDownRef.current = false;
                    updateSelectionAndCoords(ed);
                  });
                  updateSelectionAndCoords(ed);

                  if (pendingReveal.current != null) {
                    const line = pendingReveal.current;
                    const col = pendingRevealColumn.current ?? 1;
                    pendingReveal.current = null;
                    pendingRevealColumn.current = null;
                    ed.revealLineInCenter(line);
                    ed.setPosition({ lineNumber: line, column: col });
                    ed.focus();
                  }
                }}
                options={{
                  fontSize: 13,
                  fontFamily: 'Menlo, Monaco, "Cascadia Code", Consolas, "PingFang SC", "Microsoft YaHei", monospace',
                  fontWeight: '400',
                  disableMonospaceOptimizations: true,
                  minimap: { enabled: false },
                  automaticLayout: true,
                  smoothScrolling: true,
                  wordWrap: wordWrap ? 'on' : 'off',
                  lineNumbersMinChars: 4,
                  lineDecorationsWidth: 10,
                  glyphMargin: false,
                  folding: true,
                  overviewRulerLanes: 0,
                  overviewRulerBorder: false,
                  multiCursorModifier: 'alt',
                  links: true,
                  gotoLocation: {
                    multiple: 'goto',
                    multipleDefinitions: 'peek',
                    multipleReferences: 'peek',
                    multipleDeclarations: 'peek',
                    multipleImplementations: 'goto',
                    multipleTypeDefinitions: 'goto',
                  },
                  scrollBeyondLastColumn: 0,
                  scrollbar: {
                    vertical: 'visible',
                    horizontal: 'auto',
                    verticalScrollbarSize: 4,
                    horizontalScrollbarSize: 3,
                    verticalSliderSize: 4,
                    horizontalSliderSize: 3,
                    useShadows: false,
                  },
                }}
              />
            </div>
            <div
              className="splitter splitter-v md-splitter"
              onMouseDown={startMdResize}
              title="拖动调整预览宽度"
            />
            <div className="md-preview-container">
              <div
                className="md-preview-panel"
                ref={mdPreviewRef}
                onScroll={handlePreviewScroll}
              >
                <MarkdownMessage content={active.content} />
              </div>
              {showToc && (
                <div className="md-toc-floating-panel">
                  <div className="md-toc-header">
                    <span className="md-toc-title">文档大纲 ({mdHeadings.length})</span>
                    <button
                      type="button"
                      className="md-toc-close-btn"
                      onClick={() => setShowToc(false)}
                      title="关闭大纲"
                    >
                      ✕
                    </button>
                  </div>
                  {mdHeadings.length === 0 ? (
                    <div className="md-toc-empty">暂无标题大纲</div>
                  ) : (
                    <div className="md-toc-list" ref={tocListRef}>
                      {mdHeadings.map((h, idx) => {
                        const isActive = activeHeadingId === h.id;
                        return (
                          <div
                            key={`${h.id}-${idx}`}
                            className={`md-toc-item level-${h.level}${isActive ? ' active' : ''}`}
                            onClick={() => {
                              setActiveHeadingId(h.id);
                              if (mdPreviewRef.current) {
                                const el = mdPreviewRef.current.querySelector(`#${CSS.escape(h.id)}`);
                                if (el) {
                                  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                }
                              }
                              if (editorRef.current) {
                                editorRef.current.revealLineInCenter(h.line);
                                editorRef.current.setPosition({ lineNumber: h.line, column: 1 });
                              }
                            }}
                            title={`第 ${h.line} 行: ${h.text}`}
                          >
                            <span className="md-toc-bullet" />
                            <span className="md-toc-text">{h.text}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : active && isSplit ? (
          <div
            className="split-editor-layout"
            ref={editorSplitContainerRef}
            style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden' }}
          >
            <div style={{ width: `${splitRatio * 100}%`, height: '100%', position: 'relative' }}>
              <Editor
                path={active.path}
                value={active.content}
                language={activeLanguage}
                theme={monacoTheme}
                onChange={(v) => {
                  if (eolAligningRef.current) return; // setEOL 对齐行尾产生的回声，忽略
                  onChangeContent(active.path, v ?? '');
                }}
                onMount={(ed) => {
                  editorRef.current = ed;
                  setupEditorKeybindings(ed);
                  ed.onDidChangeCursorSelection(() => {
                    if (isMouseDownRef.current) {
                      updateSelectionTextOnly(ed);
                    } else {
                      updateSelectionAndCoords(ed);
                    }
                  });
                  ed.onDidScrollChange(() => {
                    if (isMouseDownRef.current) return;
                    scheduleCoordsUpdate(() => repositionSelectionCoords(ed));
                  });
                  ed.onDidChangeCursorPosition((e) => {
                    onCursorChange?.(e.position.lineNumber, e.position.column);
                    updateGitBlameRef.current(e.position.lineNumber);
                  });
                  ed.onMouseDown(() => {
                    isMouseDownRef.current = true;
                    setSelectionCoords(null);
                  });
                  ed.onMouseUp(() => {
                    isMouseDownRef.current = false;
                    updateSelectionAndCoords(ed);
                  });
                  updateSelectionAndCoords(ed);
                }}
                options={{
                  fontSize: 13,
                  minimap: { enabled: false },
                  automaticLayout: true,
                  smoothScrolling: true,
                  wordWrap: wordWrap ? 'on' : 'off',
                  scrollBeyondLastColumn: 0,
                  lineNumbersMinChars: 4,
                  scrollbar: {
                    vertical: 'visible',
                    horizontal: 'auto',
                    verticalScrollbarSize: 4,
                    horizontalScrollbarSize: 3,
                  },
                }}
              />
            </div>
            <div
              className="splitter splitter-v split-editor-splitter"
              onMouseDown={startSplitResize}
              title="拖动调整双栏宽度"
            />
            <div
              style={{
                width: `${(1 - splitRatio) * 100}%`,
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                borderLeft: '1px solid var(--border)',
              }}
            >
              <div className="split-secondary-header">
                <span className="split-label">拆分窗格</span>
                <select
                  value={splitActive?.path || ''}
                  onChange={(e) => setSplitPath(e.target.value)}
                  className="split-file-selector"
                >
                  {tabs.map((t) => {
                    const name = isUntitledPath(t.path)
                      ? untitledTabLabel(t.path)
                      : t.path.split('/').pop() || t.path;
                    return (
                      <option key={t.path} value={t.path}>
                        {name}
                      </option>
                    );
                  })}
                </select>
                <button
                  type="button"
                  className="split-close-btn"
                  onClick={() => setIsSplit(false)}
                  title="关闭拆分视图"
                >
                  ×
                </button>
              </div>
              <div style={{ flex: 1, position: 'relative' }}>
                {splitActive && (
                  <Editor
                    path={
                      splitActive.path === active.path
                        ? splitActive.path + ':split'
                        : splitActive.path
                    }
                    value={splitActive.content}
                    language={splitActiveLanguage}
                    theme={monacoTheme}
                    onChange={(v) => {
                      if (eolAligningRef.current) return; // setEOL 对齐行尾产生的回声，忽略
                      onChangeContent(splitActive.path, v ?? '');
                    }}
                    onMount={(ed) => {
                      splitEditorRef.current = ed;
                      setupEditorKeybindings(ed);
                    }}
                    options={{
                      fontSize: 13,
                      minimap: { enabled: false },
                      automaticLayout: true,
                      smoothScrolling: true,
                      wordWrap: wordWrap ? 'on' : 'off',
                      scrollBeyondLastColumn: 0,
                      lineNumbersMinChars: 4,
                      scrollbar: {
                        vertical: 'visible',
                        horizontal: 'auto',
                        verticalScrollbarSize: 4,
                        horizontalScrollbarSize: 3,
                      },
                    }}
                  />
                )}
              </div>
            </div>
          </div>
        ) : active ? (
          active.isLargeFile ? (
            <div className="large-file-placeholder">
              <div className="large-file-icon">📄</div>
              <div className="large-file-title">{active.path.split('/').pop() || active.path}</div>
              <div className="large-file-hint">
                文件较大（&gt;2MB），为避免编辑器卡顿未加载全文。可直接运行终端/搜索或让 Agent
                按行读取。
              </div>
            </div>
          ) : (
            <Editor
              path={active.path}
              value={active.content}
              language={activeLanguage}
              theme={monacoTheme}
              onChange={(v) => {
                if (eolAligningRef.current) return; // setEOL 对齐行尾产生的回声，忽略
                onChangeContent(active.path, v ?? '');
              }}
              onMount={(ed, monaco) => {
                editorRef.current = ed;
                try {
                  monaco?.editor?.remeasureFonts?.();
                  if (typeof document !== 'undefined' && document.fonts?.ready) {
                    document.fonts.ready.then(() => {
                      monaco?.editor?.remeasureFonts?.();
                    });
                  }
                } catch {
                  // ignore
                }
                setupEditorKeybindings(ed);
                const cmdClickGesture = setupCmdClickGesture(ed, {
                  getWorkspaceRoot: () => workspace,
                  onOpenFile: (targetPath, line, col) => {
                    const fn = onOpenFileRef?.current ?? onOpenFile;
                    fn?.(targetPath, line, col);
                  },
                  onShowPeekResults: (results, symbol) => {
                    setPeekResults(results);
                    setPeekSymbol(symbol);
                    setPeekVisible(true);
                  },
                  getCurrentPath: () => activeRef.current?.path ?? null,
                  getCurrentPosition: () => {
                    const pos = ed.getPosition();
                    return pos ? { line: pos.lineNumber, column: pos.column } : null;
                  },
                });
                ed.onDidDispose(() => {
                  cmdClickGesture.dispose();
                });
                ed.onDidChangeCursorSelection(() => {
                  if (isMouseDownRef.current) {
                    updateSelectionTextOnly(ed);
                  } else {
                    updateSelectionAndCoords(ed);
                  }
                });
                ed.onDidScrollChange(() => {
                  if (isMouseDownRef.current) return;
                  scheduleCoordsUpdate(() => repositionSelectionCoords(ed));
                });
                ed.onDidChangeCursorPosition((e) => {
                  onCursorChange?.(e.position.lineNumber, e.position.column);
                  updateGitBlameRef.current(e.position.lineNumber);
                  trackCursorJump(activeRef.current?.path, e.position.lineNumber, e.position.column);
                });
                // Git gutter click handler — GUTTER_LINE_NUMBERS = 4, GUTTER_GLYPH_MARGIN = 3
                ed.onMouseDown((e) => {
                  if (e.event.metaKey || e.event.ctrlKey) {
                    return;
                  }
                  isMouseDownRef.current = true;
                  setSelectionCoords(null);
                  if (e.target.type === 4 || e.target.type === 3) {
                    const line = e.target.position?.lineNumber;
                    if (line && modifiedRangesRef.current.length > 0) {
                      const isModifiedLine = modifiedRangesRef.current.some(
                        (r) => line >= r.start && line <= r.end,
                      );
                      if (isModifiedLine) {
                        setGitInlineDiffLine(line);
                      }
                    }
                  }
                });
                ed.onMouseUp(() => {
                  isMouseDownRef.current = false;
                  updateSelectionAndCoords(ed);
                });
                updateSelectionAndCoords(ed);
                const initPos = ed.getPosition();
                if (initPos) {
                  updateGitBlameRef.current(initPos.lineNumber, true);
                }

                if (pendingReveal.current != null) {
                  const line = pendingReveal.current;
                  pendingReveal.current = null;
                  ed.revealLineInCenter(line);
                  ed.setPosition({ lineNumber: line, column: 1 });
                  ed.focus();
                }
              }}
              options={{
                fontSize: 13,
                fontFamily: 'Menlo, Monaco, "Cascadia Code", Consolas, "PingFang SC", "Microsoft YaHei", monospace',
                fontWeight: '400',
                disableMonospaceOptimizations: true,
                minimap: { enabled: false },
                automaticLayout: true,
                smoothScrolling: true,
                wordWrap: wordWrap ? 'on' : 'off',
                scrollBeyondLastColumn: 0,
                lineNumbersMinChars: 4,
                lineDecorationsWidth: 10,
                glyphMargin: false,
                folding: true,
                overviewRulerLanes: 2,
                overviewRulerBorder: false,
                multiCursorModifier: 'alt',
                links: true,
                gotoLocation: {
                  multiple: 'peek',
                  multipleDefinitions: 'peek',
                  multipleReferences: 'peek',
                  multipleDeclarations: 'peek',
                  multipleImplementations: 'peek',
                  multipleTypeDefinitions: 'peek',
                },
                scrollbar: {
                  vertical: 'visible',
                  horizontal: 'auto',
                  verticalScrollbarSize: 4,
                  horizontalScrollbarSize: 3,
                  verticalSliderSize: 4,
                  horizontalSliderSize: 3,
                  useShadows: false,
                },
              }}
            />
          )
        ) : !workspace ? (
          <WelcomeView
            onPickLocal={() => onPickLocal?.()}
            onPickSsh={() => onPickSsh?.()}
            onPickClone={() => onPickClone?.()}
            recentWorkspaces={recentWorkspaces}
            onSelectRecent={onSelectRecentWorkspace}
            onRemoveRecent={onRemoveRecentWorkspace}
            onClearRecent={onClearRecentWorkspaces}
            onMoreHistory={onMoreWorkspaceHistory}
          />
        ) : (
          <div className="empty-state">从左侧打开文件，或让 Agent 开始改代码</div>
        )}

        {/* Full-width Inline Diff Banner matching user screenshot 100% */}
        {gitInlineDiffLine != null && active && (
          <div
            style={{
              position: 'absolute',
              top: (() => {
                if (!editorRef.current || gitInlineDiffLine == null) return 80;
                try {
                  const lineTop = editorRef.current.getTopForLineNumber(gitInlineDiffLine);
                  const scrollTop = editorRef.current.getScrollTop();
                  return Math.max(35, Math.min(lineTop - scrollTop + 22, 500));
                } catch {
                  return 80;
                }
              })(),
              left: 0,
              right: 0,
              width: '100%',
              zIndex: 999,
              background: 'var(--bg-lighter, #181818)',
              borderTop: '2px solid var(--accent, #007acc)',
              borderBottom: '1px solid var(--border)',
              boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
              fontSize: 12,
              fontFamily: 'Consolas, Monaco, monospace',
              color: 'var(--text)',
              boxSizing: 'border-box',
            }}
            className="git-inline-diff-banner"
          >
            {/* Header Action Bar */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                height: 32,
                padding: '0 12px',
                background: 'rgba(255, 255, 255, 0.04)',
                borderBottom: '1px solid var(--border)',
                fontSize: 12,
                userSelect: 'none',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
                <span style={{ fontWeight: 600, color: 'var(--text)' }}>
                  {active.path.split('/').pop() || active.path}
                </span>
                <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                  Git 本地更改(工作树) - 第{' '}
                  {(() => {
                    const idx = modifiedRangesRef.current.findIndex(
                      (r) => gitInlineDiffLine >= r.start && gitInlineDiffLine <= r.end,
                    );
                    return idx !== -1 ? idx + 1 : 1;
                  })()}{' '}
                  个更改(共 {Math.max(1, modifiedRangesRef.current.length)} 个)
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                {/* 1. Stage button + */}
                <button
                  type="button"
                  title="暂存更改"
                  onClick={async () => {
                    await window.ide.gitStage([active.path]);
                    onRefreshGitStatus?.();
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

                {/* 2. Discard button ⟲ (Reverts ONLY this single change hunk) */}
                <button
                  type="button"
                  title="放弃此处更改"
                  onClick={() => {
                    void handleDiscardSingleHunk();
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
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                </button>

                {/* 3. Next diff ↓ */}
                <button
                  type="button"
                  title="下一个更改"
                  onClick={() => {
                    if (modifiedRangesRef.current.length > 0) {
                      const curIdx = modifiedRangesRef.current.findIndex(
                        (r) => gitInlineDiffLine >= r.start && gitInlineDiffLine <= r.end,
                      );
                      const nextIdx = (curIdx + 1) % modifiedRangesRef.current.length;
                      const targetL = modifiedRangesRef.current[nextIdx].start;
                      setGitInlineDiffLine(targetL);
                      editorRef.current?.revealLineInCenter(targetL);
                    }
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
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <polyline points="19 12 12 19 5 12" />
                  </svg>
                </button>

                {/* 4. Previous diff ↑ */}
                <button
                  type="button"
                  title="上一个更改"
                  onClick={() => {
                    if (modifiedRangesRef.current.length > 0) {
                      const curIdx = modifiedRangesRef.current.findIndex(
                        (r) => gitInlineDiffLine >= r.start && gitInlineDiffLine <= r.end,
                      );
                      const prevIdx =
                        (curIdx - 1 + modifiedRangesRef.current.length) %
                        modifiedRangesRef.current.length;
                      const targetL = modifiedRangesRef.current[prevIdx].start;
                      setGitInlineDiffLine(targetL);
                      editorRef.current?.revealLineInCenter(targetL);
                    }
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
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </button>

                {/* 5. Close ✕ */}
                <button
                  type="button"
                  title="关闭"
                  onClick={() => setGitInlineDiffLine(null)}
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
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Dual Line Numbers & Code Diff Rows */}
            <div style={{ maxHeight: 300, overflowY: 'auto', overflowX: 'auto' }}>
              {(() => {
                if (!gitDiffData) {
                  return (
                    <div style={{ padding: '8px 12px', color: 'var(--muted)' }}>
                      加载对比数据中...
                    </div>
                  );
                }
                const origLines = gitDiffData.original.split('\n');
                const modLines = gitDiffData.modified.split('\n');
                const targetL = gitInlineDiffLine || 1;
                const start = Math.max(0, targetL - 4);
                const end = Math.min(modLines.length, targetL + 4);
                const rows: Array<{
                  type: 'same' | 'add' | 'del';
                  origNum?: number;
                  modNum?: number;
                  content: string;
                }> = [];

                for (let i = start; i < end; i++) {
                  const modContent = modLines[i];
                  const origContent = origLines[i];
                  if (origContent === modContent) {
                    rows.push({
                      type: 'same',
                      origNum: i + 1,
                      modNum: i + 1,
                      content: modContent || '',
                    });
                  } else {
                    if (origContent !== undefined) {
                      rows.push({ type: 'del', origNum: i + 1, content: origContent });
                    }
                    if (modContent !== undefined) {
                      rows.push({ type: 'add', modNum: i + 1, content: modContent });
                    }
                  }
                }

                return rows.map((row, idx) => {
                  let pairedContent: string | undefined;
                  if (row.type === 'del' && rows[idx + 1] && rows[idx + 1].type === 'add') {
                    pairedContent = rows[idx + 1].content;
                  } else if (row.type === 'add' && rows[idx - 1] && rows[idx - 1].type === 'del') {
                    pairedContent = rows[idx - 1].content;
                  }

                  const renderContent = () => {
                    if (row.type === 'same' || !pairedContent) return row.content;
                    const oldStr = row.type === 'del' ? row.content : pairedContent;
                    const newStr = row.type === 'add' ? row.content : pairedContent;

                    let prefixLen = 0;
                    while (
                      prefixLen < oldStr.length &&
                      prefixLen < newStr.length &&
                      oldStr[prefixLen] === newStr[prefixLen]
                    ) {
                      prefixLen++;
                    }

                    let suffixLen = 0;
                    while (
                      suffixLen < oldStr.length - prefixLen &&
                      suffixLen < newStr.length - prefixLen &&
                      oldStr[oldStr.length - 1 - suffixLen] ===
                      newStr[newStr.length - 1 - suffixLen]
                    ) {
                      suffixLen++;
                    }

                    const currentStr = row.content;
                    const prefix = currentStr.slice(0, prefixLen);
                    const middle =
                      row.type === 'del'
                        ? oldStr.slice(prefixLen, oldStr.length - suffixLen)
                        : newStr.slice(prefixLen, newStr.length - suffixLen);
                    const suffix = currentStr.slice(currentStr.length - suffixLen);

                    if (!middle) return row.content;
                    const highlightBg =
                      row.type === 'del' ? 'rgba(244, 67, 54, 0.65)' : 'rgba(76, 175, 80, 0.65)';

                    return (
                      <>
                        <span>{prefix}</span>
                        <span
                          style={{
                            background: highlightBg,
                            borderRadius: 2,
                            padding: '0 1px',
                            boxShadow: `0 0 0 1px ${highlightBg}`,
                          }}
                        >
                          {middle}
                        </span>
                        <span>{suffix}</span>
                      </>
                    );
                  };

                  return (
                    <div
                      key={idx}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        height: 20,
                        lineHeight: '20px',
                        background:
                          row.type === 'del'
                            ? 'rgba(244, 67, 54, 0.25)'
                            : row.type === 'add'
                              ? 'rgba(76, 175, 80, 0.25)'
                              : 'transparent',
                        fontSize: 12,
                        fontFamily: 'Consolas, Monaco, monospace',
                      }}
                    >
                      {/* Dual Line Numbers Column */}
                      <div
                        style={{
                          width: 64,
                          display: 'flex',
                          justifyContent: 'space-between',
                          padding: '0 8px',
                          color: 'var(--muted)',
                          borderRight: '1px solid rgba(255, 255, 255, 0.08)',
                          userSelect: 'none',
                          background: 'rgba(0, 0, 0, 0.2)',
                          fontSize: 11,
                          flexShrink: 0,
                          boxSizing: 'border-box',
                        }}
                      >
                        <span>{row.origNum ?? ''}</span>
                        <span>{row.modNum ?? ''}</span>
                      </div>

                      {/* Code Content */}
                      <div
                        style={{
                          paddingLeft: 12,
                          whiteSpace: 'pre',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          flex: 1,
                        }}
                      >
                        {renderContent()}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}
      </div>

      {/* Editor Tab Context Menu (VSCode style) */}
      {contextMenu && (
        <div
          className="tab-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {getTabGitMeta(contextMenu.targetPath, gitStatus?.entries) && (
            <>
              <div
                className="menu-item menu-item-danger"
                onClick={() => {
                  onDiscardPath?.(contextMenu.targetPath);
                  setContextMenu(null);
                }}
              >
                <span>放弃修改 (Discard Changes)</span>
                <span className="shortcut">⟲</span>
              </div>
              <div className="menu-divider" />
            </>
          )}
          <div className="menu-item" onClick={() => handleCloseTab(contextMenu.targetPath)}>
            <span>关闭</span>
            <span className="shortcut">⌘W</span>
          </div>
          <div className="menu-item" onClick={() => handleCloseOthers(contextMenu.targetPath)}>
            <span>关闭其他</span>
            <span className="shortcut">⌥⌘T</span>
          </div>
          <div className="menu-item" onClick={() => handleCloseRight(contextMenu.targetPath)}>
            <span>关闭右侧标签页</span>
          </div>
          <div className="menu-item" onClick={handleCloseSaved}>
            <span>关闭已保存</span>
          </div>
          <div className="menu-item" onClick={handleCloseAll}>
            <span>全部关闭</span>
          </div>

          <div className="menu-divider" />

          <div
            className="menu-item"
            onClick={() => void handleCopyPath(contextMenu.targetPath, false)}
          >
            <span>复制绝对路径</span>
            <span className="shortcut">⌥⌘C</span>
          </div>
          <div
            className="menu-item"
            onClick={() => void handleCopyPath(contextMenu.targetPath, true)}
          >
            <span>复制相对路径</span>
            <span className="shortcut">⌥⇧⌘C</span>
          </div>

          <div className="menu-divider" />

          <div
            className="menu-item"
            onClick={() => void handleShowInFinder(contextMenu.targetPath)}
          >
            <span>在 Finder / 资源管理器中显示</span>
            <span className="shortcut">⌥⌘R</span>
          </div>
        </div>
      )}
    </div>
  );
}
