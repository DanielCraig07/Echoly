import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { setupCmdClickGesture, navigateBack, highlightJumpLocation, navigationStack } from '../services/symbolNavigation';

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
  revealTarget?: {
    path: string;
    line: number;
    column?: number;
    nonce: number;
  } | null;
  onRevealTargetConsumed?: () => void;
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
  hoverDelay?: number;
  minimap?: boolean;
  selectionAiFloat?: boolean;
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

export interface InlineDiffOp {
  type: 'same' | 'del' | 'add';
  origNum?: number;
  modNum?: number;
  text: string;
}

export interface InlineDiffHunk {
  id: number;
  dels: InlineDiffOp[];
  adds: InlineDiffOp[];
  startOrigLine: number;
  endOrigLine: number;
  startModLine: number;
  endModLine: number;
  opsStartIndex: number;
  opsEndIndex: number;
}

export function computeInlineHunks(
  originalText: string,
  modifiedText: string,
): {
  ops: InlineDiffOp[];
  hunks: InlineDiffHunk[];
} {
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
  const subOps: Array<{
    type: 'same' | 'del' | 'add';
    origSubIdx?: number;
    modSubIdx?: number;
    text: string;
  }> = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && subOrig[i - 1] === subMod[j - 1]) {
      subOps.push({ type: 'same', origSubIdx: i - 1, modSubIdx: j - 1, text: subOrig[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      subOps.push({ type: 'add', modSubIdx: j - 1, text: subMod[j - 1] });
      j--;
    } else {
      subOps.push({ type: 'del', origSubIdx: i - 1, text: subOrig[i - 1] });
      i--;
    }
  }
  subOps.reverse();

  const ops: InlineDiffOp[] = [];
  for (let k = 0; k < start; k++) {
    ops.push({ type: 'same', origNum: k + 1, modNum: k + 1, text: origLines[k] });
  }
  for (const s of subOps) {
    if (s.type === 'same') {
      const origNum = start + s.origSubIdx! + 1;
      const modNum = start + s.modSubIdx! + 1;
      ops.push({ type: 'same', origNum, modNum, text: s.text });
    } else if (s.type === 'del') {
      const origNum = start + s.origSubIdx! + 1;
      ops.push({ type: 'del', origNum, text: s.text });
    } else {
      const modNum = start + s.modSubIdx! + 1;
      ops.push({ type: 'add', modNum, text: s.text });
    }
  }
  for (let k = origEnd + 1; k < N; k++) {
    const origNum = k + 1;
    const modNum = modEnd + 1 + (k - origEnd);
    ops.push({ type: 'same', origNum, modNum, text: origLines[k] });
  }

  const hunks: InlineDiffHunk[] = [];
  let curHunk: InlineDiffHunk | null = null;

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.type === 'same') {
      if (curHunk) {
        hunks.push(curHunk);
        curHunk = null;
      }
    } else {
      if (!curHunk) {
        curHunk = {
          id: hunks.length + 1,
          dels: [],
          adds: [],
          startOrigLine: op.origNum ?? 1,
          endOrigLine: op.origNum ?? 1,
          startModLine: op.modNum ?? 1,
          endModLine: op.modNum ?? 1,
          opsStartIndex: k,
          opsEndIndex: k,
        };
      }
      if (op.type === 'del') {
        curHunk.dels.push(op);
        if (op.origNum != null) {
          if (curHunk.dels.length === 1) curHunk.startOrigLine = op.origNum;
          curHunk.endOrigLine = op.origNum;
        }
      } else {
        curHunk.adds.push(op);
        if (op.modNum != null) {
          if (curHunk.adds.length === 1) curHunk.startModLine = op.modNum;
          curHunk.endModLine = op.modNum;
        }
      }
      curHunk.opsEndIndex = k;
    }
  }
  if (curHunk) hunks.push(curHunk);

  return { ops, hunks };
}

export function computeLineSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (!s1 || !s2) return 0;
  const t1 = s1.trim();
  const t2 = s2.trim();
  if (t1 === t2) return 0.95;
  let p = 0;
  while (p < t1.length && p < t2.length && t1[p] === t2[p]) p++;
  let s = 0;
  while (s < t1.length - p && s < t2.length - p && t1[t1.length - 1 - s] === t2[t2.length - 1 - s]) s++;
  return ((p + s) * 2) / (t1.length + t2.length);
}

export interface InlineDiffPart {
  text: string;
  isDiff: boolean;
}

export function computeLineTokenDiff(
  oldStr: string,
  newStr: string,
): {
  partsOld: InlineDiffPart[];
  partsNew: InlineDiffPart[];
} {
  const t1 = oldStr.match(/(\s+|\w+|[^\w\s]+)/g) || [];
  const t2 = newStr.match(/(\s+|\w+|[^\w\s]+)/g) || [];
  const n = t1.length;
  const m = t2.length;
  if (n === 0 && m === 0) {
    return { partsOld: [], partsNew: [] };
  }
  if (n === 0) {
    return {
      partsOld: [],
      partsNew: [{ text: newStr, isDiff: true }],
    };
  }
  if (m === 0) {
    return {
      partsOld: [{ text: oldStr, isDiff: true }],
      partsNew: [],
    };
  }

  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (t1[i] === t2[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const matched1 = new Set<number>();
  const matched2 = new Set<number>();
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (t1[i - 1] === t2[j - 1]) {
      matched1.add(i - 1);
      matched2.add(j - 1);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  const merge = (tokens: string[], matched: Set<number>): InlineDiffPart[] => {
    const merged: InlineDiffPart[] = [];
    for (let idx = 0; idx < tokens.length; idx++) {
      const isDiff = !matched.has(idx);
      if (merged.length > 0 && merged[merged.length - 1].isDiff === isDiff) {
        merged[merged.length - 1].text += tokens[idx];
      } else {
        merged.push({ text: tokens[idx], isDiff });
      }
    }
    return merged;
  };

  return {
    partsOld: merge(t1, matched1),
    partsNew: merge(t2, matched2),
  };
}

export function computeWordDiff(
  oldStr: string,
  newStr: string,
): {
  prefix: string;
  middleOld: string;
  middleNew: string;
  suffix: string;
} {
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
    oldStr[oldStr.length - 1 - suffixLen] === newStr[newStr.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  return {
    prefix: oldStr.slice(0, prefixLen),
    middleOld: oldStr.slice(prefixLen, oldStr.length - suffixLen),
    middleNew: newStr.slice(prefixLen, newStr.length - suffixLen),
    suffix: oldStr.slice(oldStr.length - suffixLen),
  };
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
  revealTarget,
  onRevealTargetConsumed,
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
  hoverDelay = 500,
  minimap = true,
  selectionAiFloat = true,
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
  const pendingRevealTargetRef = useRef<{
    path: string;
    line: number;
    column?: number;
    nonce: number;
  } | null>(null);
  const monacoTheme = uiTheme === 'light' ? 'custom-light' : 'custom-dark';

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
  const [inlineAiCoords, setInlineAiCoords] = useState<{ top: number; left: number } | null>(null);
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
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const handleDown = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('mousedown', handleDown);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handleDown);
      window.removeEventListener('keydown', handleKey);
    };
  }, [contextMenu]);

  useLayoutEffect(() => {
    const el = contextMenuRef.current;
    if (!el || !contextMenu) return;
    const rect = el.getBoundingClientRect();
    let x = contextMenu.x;
    let y = contextMenu.y;
    if (x + rect.width > window.innerWidth - 8) {
      x = Math.max(8, window.innerWidth - rect.width - 8);
    }
    if (y + rect.height > window.innerHeight - 8) {
      y = Math.max(8, window.innerHeight - rect.height - 8);
    }
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [contextMenu]);

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
  const showMdPreviewRef = useRef(false);
  showMdPreviewRef.current = showMdPreview;
  const [showToc, setShowToc] = useState(false);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const tocListRef = useRef<HTMLDivElement>(null);
  const [gitDiffData, setGitDiffData] = useState<{
    path: string;
    original: string;
    modified: string;
  } | null>(null);
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
  const [editorInstance, setEditorInstance] = useState<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const isSyncingScrollRef = useRef(false);
  const tocNavigatingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 保存每个 md 文件的预览滚动位置，切换文件时持久化，切回时恢复
  const mdPreviewScrollCacheRef = useRef<Map<string, number>>(new Map());
  // 用于在文件切换时读取切换前的 activePath，以便保存旧文件滚动位置
  const prevActivePathRef = useRef<string | null>(null);



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
    if (
      !activePath ||
      activePath.startsWith('untitled:') ||
      isImage ||
      !window.ide?.gitDiff ||
      gitStatus?.isRepo === false ||
      activeGitMeta?.label === 'U'
    ) {
      setGitDiffData(null);
      return;
    }
    let cancelled = false;
    window.ide
      .gitDiff(activePath, false)
      .then((res) => {
        if (cancelled) return;
        if (res && res.ok && res.isTracked !== false) {
          setGitDiffData({ path: activePath, original: res.original, modified: res.modified });
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
  }, [activePath, gitStatus, isImage, active?.dirty, activeGitMeta?.label]);

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
    pendingRevealTargetRef.current = revealTarget ?? null;
  }, [revealTarget]);

  const executeRevealTarget = useCallback(
    (ed: MonacoEditor.IStandaloneCodeEditor) => {
      const target = pendingRevealTargetRef.current;
      if (!target || target.line <= 0) return;

      const model = ed.getModel();
      if (!model) return;

      const modelUri = (model.uri?.fsPath || model.uri?.path || '').replace(/\\/g, '/');
      const curActive = (activePath || '').replace(/\\/g, '/');
      const targetPath = target.path.replace(/\\/g, '/');

      const matchesActive =
        Boolean(curActive && targetPath) &&
        (curActive === targetPath ||
          curActive.endsWith('/' + targetPath) ||
          targetPath.endsWith('/' + curActive));

      const matchesModel =
        Boolean(modelUri && targetPath) &&
        (modelUri === targetPath ||
          modelUri.endsWith('/' + targetPath) ||
          targetPath.endsWith('/' + modelUri));

      if (!matchesActive || !matchesModel) {
        return;
      }

      if (target.line > model.getLineCount()) {
        return;
      }

      try {
        const line = target.line;
        const col = target.column ?? 1;
        ed.revealLineInCenter(line);
        ed.setPosition({ lineNumber: line, column: col });
        ed.focus();
        highlightJumpLocation(ed, line);
      } catch {
        // ignore
      } finally {
        pendingRevealTargetRef.current = null;
        onRevealTargetConsumed?.();
      }
    },
    [activePath, onRevealTargetConsumed]
  );

  useEffect(() => {
    if (editorRef.current) {
      executeRevealTarget(editorRef.current);
    }
  }, [revealTarget, activePath, executeRevealTarget]);

  // 当切换标签或打开其它文件时，若当前 pendingTarget 与新文件路径不匹配，立即清空，杜绝跨文件粘连
  useEffect(() => {
    if (pendingRevealTargetRef.current) {
      const curActive = (activePath || '').replace(/\\/g, '/');
      const targetPath = pendingRevealTargetRef.current.path.replace(/\\/g, '/');
      const matches =
        Boolean(curActive && targetPath) &&
        (curActive === targetPath ||
          curActive.endsWith('/' + targetPath) ||
          targetPath.endsWith('/' + curActive));
      if (!matches) {
        pendingRevealTargetRef.current = null;
        onRevealTargetConsumed?.();
      }
    }
  }, [activePath, onRevealTargetConsumed]);

  const getMarkdownAnchors = useCallback(
    (ed: MonacoEditor.IStandaloneCodeEditor, previewEl: HTMLElement) => {
      const model = ed.getModel();
      const totalLines = model ? model.getLineCount() : 1;
      const maxPreviewScroll = Math.max(0, previewEl.scrollHeight - previewEl.clientHeight);
      const maxEditorScroll = Math.max(0, ed.getScrollHeight() - ed.getLayoutInfo().height);

      const anchors: Array<{ editorTop: number; previewTop: number }> = [];
      anchors.push({ editorTop: 0, previewTop: 0 });

      for (const h of mdHeadings) {
        let el: HTMLElement | null = null;
        try {
          el = previewEl.querySelector(`#${CSS.escape(h.id)}`) as HTMLElement | null;
        } catch {}
        if (!el && h.line != null) {
          el = previewEl.querySelector(`[data-heading-line="${h.line}"]`) as HTMLElement | null;
        }
        if (!el && h.text) {
          const headings = Array.from(previewEl.querySelectorAll('h1, h2, h3, h4, h5, h6')) as HTMLElement[];
          el = headings.find((item) => item.textContent?.trim() === h.text.trim()) || null;
        }
        if (el) {
          const pTop =
            el.getBoundingClientRect().top - previewEl.getBoundingClientRect().top + previewEl.scrollTop - 16;
          const eTop = ed.getTopForLineNumber(h.line) - 16;
          anchors.push({
            editorTop: Math.max(0, eTop),
            previewTop: Math.max(0, pTop),
          });
        }
      }

      anchors.push({
        editorTop: Math.max(0, maxEditorScroll),
        previewTop: Math.max(0, maxPreviewScroll),
      });

      anchors.sort((a, b) => a.editorTop - b.editorTop);
      return anchors;
    },
    [mdHeadings],
  );

  const syncEditorToPreview = useCallback(
    (ed: MonacoEditor.IStandaloneCodeEditor, previewEl: HTMLElement) => {
      const editorScrollTop = ed.getScrollTop();
      const anchors = getMarkdownAnchors(ed, previewEl);
      if (anchors.length < 2) return;

      let i = 0;
      while (i < anchors.length - 1 && anchors[i + 1].editorTop <= editorScrollTop) {
        i++;
      }
      const a1 = anchors[i];
      const a2 = anchors[Math.min(i + 1, anchors.length - 1)];

      const eDelta = a2.editorTop - a1.editorTop;
      const ratio = eDelta > 0 ? Math.max(0, Math.min(1, (editorScrollTop - a1.editorTop) / eDelta)) : 0;
      const targetPreviewTop = a1.previewTop + ratio * (a2.previewTop - a1.previewTop);

      isSyncingScrollRef.current = true;
      previewEl.scrollTop = targetPreviewTop;
      setTimeout(() => {
        isSyncingScrollRef.current = false;
      }, 50);
    },
    [getMarkdownAnchors],
  );

  const syncPreviewToEditor = useCallback(
    (previewEl: HTMLElement, ed: MonacoEditor.IStandaloneCodeEditor) => {
      const previewScrollTop = previewEl.scrollTop;
      const anchors = getMarkdownAnchors(ed, previewEl);
      if (anchors.length < 2) return;

      let i = 0;
      while (i < anchors.length - 1 && anchors[i + 1].previewTop <= previewScrollTop) {
        i++;
      }
      const a1 = anchors[i];
      const a2 = anchors[Math.min(i + 1, anchors.length - 1)];

      const pDelta = a2.previewTop - a1.previewTop;
      const ratio = pDelta > 0 ? Math.max(0, Math.min(1, (previewScrollTop - a1.previewTop) / pDelta)) : 0;
      const targetEditorTop = a1.editorTop + ratio * (a2.editorTop - a1.editorTop);

      isSyncingScrollRef.current = true;
      ed.setScrollTop(targetEditorTop);
      setTimeout(() => {
        isSyncingScrollRef.current = false;
      }, 50);
    },
    [getMarkdownAnchors],
  );

  const setupEditorScrollSync = (ed: MonacoEditor.IStandaloneCodeEditor) => {
    ed.onDidScrollChange(() => {
      if (isSyncingScrollRef.current) return;
      if (!mdPreviewRef.current) return;
      syncEditorToPreview(ed, mdPreviewRef.current);
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
      let el: Element | null = null;
      try {
        el = previewEl.querySelector(`#${CSS.escape(h.id)}`);
      } catch {}
      if (!el && h.line != null) {
        el = previewEl.querySelector(`[data-heading-line="${h.line}"]`);
      }
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

  // Keep editor and preview in sync when toggling or entering preview mode;
  // when switching between md files, restore the cached scroll position first.
  useEffect(() => {
    if (showMdPreview && isMarkdown) {
      const timer = setTimeout(() => {
        const ed = editorRef.current;
        const previewEl = mdPreviewRef.current;
        if (ed && previewEl) {
          // 如果缓存中有当前文件的滚动位置，优先恢复；否则按编辑器位置同步
          const cached = activePath ? mdPreviewScrollCacheRef.current.get(activePath) : undefined;
          if (cached !== undefined && cached > 0) {
            // 1. 锁定滚动同步，防止 Monaco onDidScrollChange 覆盖恢复值
            isSyncingScrollRef.current = true;
            // 2. 恢复预览面板滚动位置
            previewEl.scrollTop = cached;
            // 3. 关键：同时把 Monaco 编辑器位置也同步到与预览对应的位置
            //    否则 Monaco 仍停在第 1 行，后续任何编辑器滚动事件会通过
            //    syncEditorToPreview 将预览拉回 0，破坏刚刚恢复的位置。
            const anchors = getMarkdownAnchors(ed, previewEl);
            if (anchors.length >= 2) {
              let ai = 0;
              while (ai < anchors.length - 1 && anchors[ai + 1].previewTop <= cached) ai++;
              const a1 = anchors[ai];
              const a2 = anchors[Math.min(ai + 1, anchors.length - 1)];
              const pDelta = a2.previewTop - a1.previewTop;
              const ratio = pDelta > 0 ? Math.max(0, Math.min(1, (cached - a1.previewTop) / pDelta)) : 0;
              const targetEditorTop = a1.editorTop + ratio * (a2.editorTop - a1.editorTop);
              ed.setScrollTop(Math.max(0, targetEditorTop));
            }
            // 4. 延长锁定时间（250ms），覆盖 Monaco 模型初始化后的所有延迟滚动事件
            setTimeout(() => { isSyncingScrollRef.current = false; }, 250);
            updateActiveHeading();
          } else {
            syncEditorToPreview(ed, previewEl);
            updateActiveHeading();
          }
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [showMdPreview, isMarkdown, activePath, getMarkdownAnchors, syncEditorToPreview, updateActiveHeading]);

  // Keep active item visible inside TOC floating list
  useEffect(() => {
    if (!showToc || !activeHeadingId) return;
    const activeItem = tocListRef.current?.querySelector('.md-toc-item.active');
    if (activeItem) {
      activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [activeHeadingId, showToc]);

  const handlePreviewScroll = () => {
    if (isSyncingScrollRef.current) return;
    updateActiveHeading();
    const previewEl = mdPreviewRef.current;
    const ed = editorRef.current;
    if (!previewEl || !ed) return;
    // 实时保存当前文件的预览滚动位置
    if (activePath) {
      mdPreviewScrollCacheRef.current.set(activePath, previewEl.scrollTop);
    }
    syncPreviewToEditor(previewEl, ed);
  };

  const handleHeadingClick = useCallback((h: MarkdownHeadingItem) => {
    if (tocNavigatingTimerRef.current) {
      clearTimeout(tocNavigatingTimerRef.current);
    }
    // Lock scroll synchronization during TOC navigation to prevent Monaco scroll from interfering with preview
    isSyncingScrollRef.current = true;
    setActiveHeadingId(h.id);

    if (mdPreviewRef.current) {
      const previewEl = mdPreviewRef.current;
      let el: HTMLElement | null = null;
      try {
        el = previewEl.querySelector(`#${CSS.escape(h.id)}`) as HTMLElement | null;
      } catch {}
      if (!el && h.line != null) {
        el = previewEl.querySelector(`[data-heading-line="${h.line}"]`) as HTMLElement | null;
      }
      if (!el && h.text) {
        const headings = Array.from(previewEl.querySelectorAll('h1, h2, h3, h4, h5, h6')) as HTMLElement[];
        el = headings.find((item) => item.textContent?.trim() === h.text.trim()) || null;
      }

      if (el) {
        const offset =
          el.getBoundingClientRect().top - previewEl.getBoundingClientRect().top + previewEl.scrollTop - 16;
        previewEl.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
      }
    }

    if (editorRef.current) {
      const targetTop = Math.max(0, editorRef.current.getTopForLineNumber(h.line) - 16);
      editorRef.current.setScrollTop(targetTop, 1 /* Smooth */);
      editorRef.current.setPosition({ lineNumber: h.line, column: 1 });
    }

    // Release sync lock once smooth scroll settles
    tocNavigatingTimerRef.current = setTimeout(() => {
      isSyncingScrollRef.current = false;
    }, 650);
  }, []);

  // 选中文本后的 AI 悬浮提示：滑动文件时针对当前选区隐藏提示；重新划选或选区变化时恢复展示
  const dismissedSelectionKeyRef = useRef<string | null>(null);
  // Monaco 查找框是否展开：展开时收起 AI 悬浮提示，避免盖在搜索框的上/下一个按钮上
  const [findWidgetVisible, setFindWidgetVisible] = useState(false);

  useEffect(() => {
    const ed = editorInstance;
    const domNode = ed?.getDomNode();
    const findWidget = domNode?.querySelector('.find-widget');
    if (!findWidget) return;

    const sync = () => setFindWidgetVisible(findWidget.classList.contains('visible'));
    sync();

    // Monaco 只切 .find-widget 的 visible class，观察它即可感知查找框开关
    const observer = new MutationObserver(sync);
    observer.observe(findWidget, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [editorInstance, activePath]);

  useEffect(() => {
    if (findWidgetVisible) setSelectionCoords(null);
  }, [findWidgetVisible]);

  // 切换文件时清空原有装饰与 diff 数据，并重置选区 AI 悬浮窗提示状态
  // 同时保存旧文件的 md 预览滚动位置（供切回时恢复）
  useEffect(() => {
    // 先保存切换前文件的预览滚动位置
    const prevPath = prevActivePathRef.current;
    const previewEl = mdPreviewRef.current;
    if (prevPath && previewEl && showMdPreviewRef.current) {
      const scrollTop = previewEl.scrollTop;
      if (scrollTop > 0) {
        mdPreviewScrollCacheRef.current.set(prevPath, scrollTop);
      }
    }
    prevActivePathRef.current = activePath;

    const ed = editorRef.current;
    if (ed) {
      decorationsRef.current = ed.deltaDecorations(decorationsRef.current, []);
    } else {
      decorationsRef.current = [];
    }
    setGitDiffData(null);
    modifiedRangesRef.current = [];
    dismissedSelectionKeyRef.current = null;
    setSelectionCoords(null);
  }, [activePath]);

  // Apply git decorations (gutter indicators & overview ruler) from diff data
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !gitDiffData || gitDiffData.path !== activePath) {
      if (ed) {
        decorationsRef.current = ed.deltaDecorations(decorationsRef.current, []);
      }
      modifiedRangesRef.current = [];
      return;
    }

    const model = ed.getModel();
    if (!model || model.isDisposed()) return;

    const originalText = gitDiffData.original;
    const currentText = active?.content ?? gitDiffData.modified;
    const diffs = computeLineDiffs(originalText, currentText);

    const decorations: MonacoEditor.IModelDeltaDecoration[] = [];
    const ranges: Array<{ start: number; end: number }> = [];
    const isLight = uiTheme === 'light';

    for (const diff of diffs) {
      ranges.push({ start: diff.startLine, end: diff.endLine });
      const diffColor =
        diff.type === 'added'
          ? (isLight ? '#1a7f37' : '#2ea043')
          : diff.type === 'deleted'
            ? (isLight ? '#cf222e' : '#f85149')
            : (isLight ? '#bf8700' : '#e2c08d');

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
            color: diffColor,
            position: 1, // OverviewRulerLane.Left: 占滚动条左侧 1/3 宽度，纤细清晰
          },
        },
      });
    }

    modifiedRangesRef.current = ranges;
    decorationsRef.current = ed.deltaDecorations(decorationsRef.current, decorations);
  }, [gitDiffData, active?.content, activePath, editorInstance, uiTheme]);

  // 按 Esc 键退出 Git 差异对比、差异预览，或关闭选区浮动工具栏，或关闭目录大纲
  useEffect(() => {
    if (gitInlineDiffLine == null && !previewDiff && !selectionCoords && !showToc) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectionCoords) {
          e.preventDefault();
          e.stopPropagation();
          setSelectionCoords(null);
          return;
        }
        if (showToc) {
          e.preventDefault();
          e.stopPropagation();
          setShowToc(false);
          return;
        }
        if (gitInlineDiffLine != null) {
          e.preventDefault();
          e.stopPropagation();
          setGitInlineDiffLine(null);
        } else if (previewDiff && onCloseDiff) {
          e.preventDefault();
          e.stopPropagation();
          onCloseDiff();
        }
      }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [gitInlineDiffLine, previewDiff, onCloseDiff, selectionCoords, showToc]);

  useEffect(() => {
    if (!active) {
      onSelectionChangeRef.current?.('');
      setSelectedText('');
    }
  }, [active]);

  // Single-Hunk Discard Handler (reverts ONLY the target modified hunk, leaving other changes in the file intact)
  const handleDiscardSingleHunk = async () => {
    if (!active?.path || !gitDiffData || gitDiffData.path !== activePath || gitInlineDiffLine == null) return;
    const currentContent = active.content ?? gitDiffData.modified;
    const { hunks } = computeInlineHunks(gitDiffData.original, currentContent);
    const targetL = gitInlineDiffLine;

    let targetHunk = hunks.find((h) => targetL >= h.startModLine && targetL <= h.endModLine);
    if (!targetHunk && hunks.length > 0) {
      targetHunk = [...hunks].sort(
        (a, b) => Math.abs(a.startModLine - targetL) - Math.abs(b.startModLine - targetL),
      )[0];
    }
    if (!targetHunk) return;

    const modLines = currentContent.split('\n');
    const origHunkLines = targetHunk.dels.map((d) => d.text);
    const newModLines = [
      ...modLines.slice(0, Math.max(0, targetHunk.startModLine - 1)),
      ...origHunkLines,
      ...modLines.slice(targetHunk.endModLine),
    ];

    const newContent = newModLines.join('\n');
    await window.ide.writeFile(active.path, newContent);
    const isNowClean = Boolean(newContent === gitDiffData.original);
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
  const lastMousePosRef = useRef<{ clientX: number; clientY: number } | null>(null);

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

  // 选区更新或滚动时计算浮层坐标：跟随鼠标位置，智能避让代码文本，绝不遮挡代码
  const repositionSelectionCoords = useCallback((ed: MonacoEditor.IStandaloneCodeEditor) => {
    const sel = ed.getSelection();
    const model = ed.getModel();
    if (!sel || sel.isEmpty() || !model) {
      setSelectionCoords(null);
      return;
    }
    try {
      const editorDom = ed.getDomNode();
      const containerDom = editorContainerRef.current;
      if (!editorDom || !containerDom) {
        setSelectionCoords(null);
        return;
      }
      const editorRect = editorDom.getBoundingClientRect();
      const containerRect = containerDom.getBoundingClientRect();

      // 获取当前编辑器内部布局（行号宽度、minimap 与垂直滚动条宽度）
      const layout = ed.getLayoutInfo();
      const contentLeft = layout.contentLeft; // 实际代码文本起始 X
      const minimapWidth = layout.minimap?.renderMinimap ? layout.minimap.minimapWidth : 0;
      const scrollbarWidth = layout.verticalScrollbarWidth || 12;
      const rightMargin = minimapWidth + scrollbarWidth + 14;

      const widgetWidth = 208;
      const widgetHeight = 28;

      const maxAllowedRight = editorRect.right - containerRect.left - rightMargin;
      const minAllowedLeft = editorRect.left - containerRect.left + contentLeft;

      const startPos = sel.getStartPosition();
      const endPos = sel.getEndPosition();
      const startVis = ed.getScrolledVisiblePosition(startPos);
      const endVis = ed.getScrolledVisiblePosition(endPos);

      // 若选区已完全滚出可视区域，自动隐藏
      if (
        (startVis && startVis.top > containerRect.height + 30) ||
        (endVis && endVis.top < -30)
      ) {
        setSelectionCoords(null);
        return;
      }

      const defaultLineHeight = 19;

      // 锚点：优先使用鼠标最后释放位置；若无则使用选区结束处
      let anchorX: number;
      let anchorY: number;
      if (lastMousePosRef.current) {
        anchorX = lastMousePosRef.current.clientX - containerRect.left;
        anchorY = lastMousePosRef.current.clientY - containerRect.top;
      } else {
        const refVis = endVis || startVis;
        anchorX = editorRect.left - containerRect.left + (refVis?.left ?? contentLeft);
        anchorY = editorRect.top - containerRect.top + (refVis?.top ?? 0) + (refVis?.height || defaultLineHeight);
      }

      // 收集选区及周边行代码文本占用的矩形范围，用于碰撞检测
      const checkStartLine = Math.max(1, sel.startLineNumber - 2);
      const checkEndLine = Math.min(model.getLineCount(), sel.endLineNumber + 2);
      const codeObstacles: { top: number; bottom: number; left: number; right: number }[] = [];

      for (let ln = checkStartLine; ln <= checkEndLine; ln++) {
        const lineVis = ed.getScrolledVisiblePosition({ lineNumber: ln, column: 1 });
        if (!lineVis) continue;
        const lineTop = editorRect.top - containerRect.top + lineVis.top;
        const lineBottom = lineTop + (lineVis.height || defaultLineHeight);
        const maxCol = model.getLineMaxColumn(ln);
        const lineEndVis = ed.getScrolledVisiblePosition({ lineNumber: ln, column: maxCol });

        const codeLeft = editorRect.left - containerRect.left + contentLeft;
        const codeRight = editorRect.left - containerRect.left + (lineEndVis ? lineEndVis.left : contentLeft);
        const isCursorLine = ed.getPosition()?.lineNumber === ln;
        // 当前光标行可能有 Git Blame 装饰信息
        const occupiedRight = Math.max(codeLeft, codeRight + (isCursorLine ? 220 : 16));

        codeObstacles.push({
          top: lineTop,
          bottom: lineBottom,
          left: codeLeft,
          right: occupiedRight,
        });
      }

      // 碰撞检测：浮层矩形是否与任何代码文本相交
      const doesOverlapCode = (left: number, top: number, width: number, height: number) => {
        const right = left + width;
        const bottom = top + height;
        for (const obs of codeObstacles) {
          const vertOverlap = top < obs.bottom - 1 && bottom > obs.top + 1;
          const horizOverlap = left < obs.right + 6 && right > obs.left - 6;
          if (vertOverlap && horizOverlap) {
            return true;
          }
        }
        return false;
      };

      let finalLeft: number | null = null;
      let finalTop: number | null = null;

      // 候选 1：鼠标所在行右侧空白区（跟随鼠标且不遮挡该行代码）
      const currentObs = codeObstacles.find((o) => anchorY >= o.top - 4 && anchorY <= o.bottom + 4);
      const cand1Left = Math.max(anchorX + 12, (currentObs?.right ?? anchorX) + 14);
      const cand1Top = anchorY - widgetHeight / 2;
      if (
        cand1Left + widgetWidth <= maxAllowedRight &&
        cand1Top >= 8 &&
        cand1Top + widgetHeight <= containerRect.height - 8 &&
        !doesOverlapCode(cand1Left, cand1Top, widgetWidth, widgetHeight)
      ) {
        finalLeft = cand1Left;
        finalTop = cand1Top;
      }

      // 候选 2：选区/鼠标下方行的空白处（优先贴近鼠标 X 坐标，但避开该行文字）
      if (finalLeft == null) {
        const cand2Top = anchorY + 8;
        const belowObs = codeObstacles.find((o) => cand2Top >= o.top - 2 && cand2Top <= o.bottom + 2);
        const cand2Left = Math.max(
          minAllowedLeft,
          Math.max(anchorX - 20, (belowObs?.right ?? minAllowedLeft) + 12),
        );
        if (
          cand2Left + widgetWidth <= maxAllowedRight &&
          cand2Top + widgetHeight <= containerRect.height - 8 &&
          !doesOverlapCode(cand2Left, cand2Top, widgetWidth, widgetHeight)
        ) {
          finalLeft = cand2Left;
          finalTop = cand2Top;
        }
      }

      // 候选 3：选区/鼠标上方行的空白处
      if (finalLeft == null) {
        const cand3Top = anchorY - widgetHeight - 8;
        const aboveObs = codeObstacles.find((o) => cand3Top >= o.top - 2 && cand3Top <= o.bottom + 2);
        const cand3Left = Math.max(
          minAllowedLeft,
          Math.max(anchorX - 20, (aboveObs?.right ?? minAllowedLeft) + 12),
        );
        if (
          cand3Top >= 8 &&
          cand3Left + widgetWidth <= maxAllowedRight &&
          !doesOverlapCode(cand3Left, cand3Top, widgetWidth, widgetHeight)
        ) {
          finalLeft = cand3Left;
          finalTop = cand3Top;
        }
      }

      // 候选 4：当前鼠标所在行，停靠在右侧边距安全区
      if (finalLeft == null) {
        const cand4Left = maxAllowedRight - widgetWidth;
        const cand4Top = Math.max(8, Math.min(anchorY - widgetHeight / 2, containerRect.height - widgetHeight - 8));
        if (!doesOverlapCode(cand4Left, cand4Top, widgetWidth, widgetHeight)) {
          finalLeft = cand4Left;
          finalTop = cand4Top;
        }
      }

      // 候选 5：兜底方案——选区末尾行下方，不遮挡选区任何代码
      if (finalLeft == null) {
        const refBottomVis = endVis || startVis;
        const selBottomY =
          editorRect.top - containerRect.top + (refBottomVis?.top ?? anchorY) + (refBottomVis?.height || defaultLineHeight);
        finalTop = Math.max(8, Math.min(selBottomY + 6, containerRect.height - widgetHeight - 8));
        finalLeft = Math.max(
          minAllowedLeft,
          Math.min(anchorX, maxAllowedRight - widgetWidth),
        );
      }

      if (finalLeft != null && finalTop != null) {
        setSelectionCoords({ left: finalLeft, top: finalTop });
      } else {
        setSelectionCoords(null);
      }
    } catch {
      // ignore
    }
  }, []);

  const updateSelectionAndCoords = useCallback((ed: MonacoEditor.IStandaloneCodeEditor) => {
    const model = ed.getModel();
    const sel = ed.getSelection();
    // 查找框打开时不显示 AI 悬浮提示，避免遮挡搜索框
    if (ed.getDomNode()?.querySelector('.find-widget.visible')) {
      setSelectionCoords(null);
      return;
    }
    if (!model || !sel || sel.isEmpty()) {
      dismissedSelectionKeyRef.current = null;
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

    const currentKey = `${sel.startLineNumber}:${sel.startColumn}-${sel.endLineNumber}:${sel.endColumn}`;
    // 滑动后当前选区隐藏不再提示 AI；当用户重新划选或改变选区时恢复展示
    if (dismissedSelectionKeyRef.current === currentKey) {
      setSelectionCoords(null);
      return;
    }

    dismissedSelectionKeyRef.current = null;
    repositionSelectionCoords(ed);
  }, [repositionSelectionCoords]);

  const openInlineAiForEditor = useCallback(
    (ed: MonacoEditor.IStandaloneCodeEditor) => {
      const sel = ed.getSelection();
      const model = ed.getModel();
      let startLine = 1;
      let endLine = 1;
      if (model && sel) {
        if (!sel.isEmpty()) {
          const text = model.getValueInRange(sel);
          setSelectedText(text);
          startLine = sel.startLineNumber;
          endLine = sel.endLineNumber;
          setSelectionRange({
            startLine,
            endLine,
          });
        } else {
          // If no selection range, select current line
          const lineNum = sel.positionLineNumber;
          const lineContent = model.getLineContent(lineNum);
          setSelectedText(lineContent);
          startLine = lineNum;
          endLine = lineNum;
          setSelectionRange({
            startLine: lineNum,
            endLine: lineNum,
          });
        }
      }
      try {
        const editorDom = ed.getDomNode();
        const containerDom = editorContainerRef.current;
        const startPos = sel ? sel.getStartPosition() : { lineNumber: startLine, column: 1 };
        const visiblePos = ed.getScrolledVisiblePosition(startPos);
        if (visiblePos && editorDom && containerDom) {
          const editorRect = editorDom.getBoundingClientRect();
          const containerRect = containerDom.getBoundingClientRect();
          const left = Math.max(
            16,
            Math.min(
              editorRect.left - containerRect.left + visiblePos.left - 40,
              containerRect.width - 440,
            ),
          );
          const isNearTop = visiblePos.top < 120;
          const top = isNearTop
            ? editorRect.top - containerRect.top + visiblePos.top + 28
            : editorRect.top - containerRect.top + visiblePos.top - 95;
          setInlineAiCoords({ left, top });
        } else {
          setInlineAiCoords(null);
        }
      } catch {
        setInlineAiCoords(null);
      }
      setShowInlineAi(true);
      setTimeout(() => {
        inlineInputRef.current?.focus();
        inlineInputRef.current?.select();
      }, 50);
    },
    [],
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
        requestAnimationFrame(() => {
          executeRevealTarget(ed);
        });
      });
    },
    [openInlineAiForEditor, triggerAddToChatForEditor, workspace, onOpenFile, executeRevealTarget],
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
  }, [showInlineAi, openInlineAiForEditor, triggerAddToChatForEditor]);

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
                title="关闭预览 (Esc)"
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
              folding: true,
              occurrencesHighlight: 'off',
              selectionHighlight: false,
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
        {selectedText.trim().length > 0 &&
          active?.path &&
          selectionCoords &&
          !showInlineAi &&
          !findWidgetVisible &&
          selectionAiFloat !== false && (
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
              <div className="selection-ai-divider" />
              <button
                type="button"
                className="selection-ai-close-btn"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setSelectionCoords(null);
                }}
                title="隐藏快捷栏 (Esc)"
              >
                ✕
              </button>
            </div>
          )}

        {/* Inline AI Edit Widget (Cmd+K) */}
        {showInlineAi && active?.path && (
          <div
            className="inline-ai-widget"
            style={{
              left: inlineAiCoords
                ? `${inlineAiCoords.left}px`
                : selectionCoords
                  ? `${Math.max(16, selectionCoords.left - 60)}px`
                  : '40px',
              top: inlineAiCoords
                ? `${inlineAiCoords.top}px`
                : selectionCoords
                  ? `${Math.max(10, selectionCoords.top + 28)}px`
                  : '40px',
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
                  setEditorInstance(ed);
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
                    const sel = ed.getSelection();
                    if (sel && !sel.isEmpty()) {
                      dismissedSelectionKeyRef.current = `${sel.startLineNumber}:${sel.startColumn}-${sel.endLineNumber}:${sel.endColumn}`;
                    }
                    setSelectionCoords(null);
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
                  // Git gutter click handler — 点击左侧差异色条/边距触发差异对比，排除代码折叠按钮
                  ed.onMouseDown((e) => {
                    if (e.event) {
                      const b = e.event.browserEvent;
                      lastMousePosRef.current = {
                        clientX: b?.clientX ?? e.event.posx,
                        clientY: b?.clientY ?? e.event.posy,
                      };
                    }
                    if (e.event.metaKey || e.event.ctrlKey) {
                      return;
                    }
                    isMouseDownRef.current = true;
                    setSelectionCoords(null);
                    const el = e.target.element as HTMLElement | null;
                    const isGitGutterEl = !!el?.closest('[class*="git-gutter"]');
                    const isFoldingEl = !!el?.closest(
                      '[class*="codicon-folding"], [class*="folding"], [class*="codicon-chevron"], .inline-folded',
                    );
                    // 仅当明确点击了代码折叠/展开按钮（且未直接点中 git-gutter 色条）时忽略，保障折叠不误触
                    if (isFoldingEl && !isGitGutterEl) {
                      return;
                    }
                    // 左侧装订线区域（type 4 行装饰 / type 3 行号 / type 2 字形边距）或直接命中 git-gutter 元素
                    if (
                      e.target.type === 4 ||
                      e.target.type === 3 ||
                      e.target.type === 2 ||
                      isGitGutterEl
                    ) {
                      const line = e.target.position?.lineNumber ?? e.target.range?.startLineNumber;
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
                  ed.onMouseUp((e) => {
                    isMouseDownRef.current = false;
                    if (e.event) {
                      const b = e.event.browserEvent;
                      lastMousePosRef.current = {
                        clientX: b?.clientX ?? e.event.posx,
                        clientY: b?.clientY ?? e.event.posy,
                      };
                    }
                    updateSelectionAndCoords(ed);
                  });
                  updateSelectionAndCoords(ed);

                  executeRevealTarget(ed);
                }}
                options={{
                  fontSize: 13,
                  fontFamily: 'Menlo, Monaco, "Cascadia Code", Consolas, "PingFang SC", "Microsoft YaHei", monospace',
                  fontWeight: '400',
                  disableMonospaceOptimizations: true,
                  minimap: { enabled: minimap !== false },
                  hover: { enabled: true, delay: Math.max(500, hoverDelay ?? 500) },
                  automaticLayout: true,
                  smoothScrolling: true,
                  wordWrap: wordWrap ? 'on' : 'off',
                  lineNumbersMinChars: 4,
                  lineDecorationsWidth: 10,
                  glyphMargin: false,
                  folding: true,
                  overviewRulerLanes: 3,
                  overviewRulerBorder: false,
                  scrollbar: {
                    vertical: 'visible',
                    horizontal: 'auto',
                    verticalScrollbarSize: 12,
                    horizontalScrollbarSize: 8,
                    verticalSliderSize: 12,
                    horizontalSliderSize: 8,
                    useShadows: false,
                  },
                  multiCursorModifier: 'alt',
                  links: true,
                  occurrencesHighlight: 'off',
                  selectionHighlight: false,
                  gotoLocation: {
                    multiple: 'goto',
                    multipleDefinitions: 'peek',
                    multipleReferences: 'peek',
                    multipleDeclarations: 'peek',
                    multipleImplementations: 'goto',
                    multipleTypeDefinitions: 'goto',
                  },
                  scrollBeyondLastColumn: 0,
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
                      title="关闭大纲 (Esc)"
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
                            onClick={() => handleHeadingClick(h)}
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
                    const sel = ed.getSelection();
                    if (sel && !sel.isEmpty()) {
                      dismissedSelectionKeyRef.current = `${sel.startLineNumber}:${sel.startColumn}-${sel.endLineNumber}:${sel.endColumn}`;
                    }
                    setSelectionCoords(null);
                  });
                  ed.onDidChangeCursorPosition((e) => {
                    onCursorChange?.(e.position.lineNumber, e.position.column);
                    updateGitBlameRef.current(e.position.lineNumber);
                  });
                  ed.onMouseDown((e) => {
                    isMouseDownRef.current = true;
                    if (e.event) {
                      const b = e.event.browserEvent;
                      lastMousePosRef.current = {
                        clientX: b?.clientX ?? e.event.posx,
                        clientY: b?.clientY ?? e.event.posy,
                      };
                    }
                    setSelectionCoords(null);
                  });
                  ed.onMouseUp((e) => {
                    isMouseDownRef.current = false;
                    if (e.event) {
                      const b = e.event.browserEvent;
                      lastMousePosRef.current = {
                        clientX: b?.clientX ?? e.event.posx,
                        clientY: b?.clientY ?? e.event.posy,
                      };
                    }
                    updateSelectionAndCoords(ed);
                  });
                  updateSelectionAndCoords(ed);
                }}
                options={{
                  fontSize: 13,
                  minimap: { enabled: minimap !== false },
                  hover: { enabled: true, delay: Math.max(500, hoverDelay ?? 500) },
                  automaticLayout: true,
                  smoothScrolling: true,
                  occurrencesHighlight: 'off',
                  selectionHighlight: false,
                  wordWrap: wordWrap ? 'on' : 'off',
                  scrollBeyondLastColumn: 0,
                  lineNumbersMinChars: 4,
                  overviewRulerLanes: 3,
                  overviewRulerBorder: false,
                  scrollbar: {
                    vertical: 'visible',
                    horizontal: 'auto',
                    verticalScrollbarSize: 12,
                    horizontalScrollbarSize: 8,
                    verticalSliderSize: 12,
                    horizontalSliderSize: 8,
                    useShadows: false,
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
                      occurrencesHighlight: 'off',
                      selectionHighlight: false,
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
                setEditorInstance(ed);
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
                  const sel = ed.getSelection();
                  if (sel && !sel.isEmpty()) {
                    dismissedSelectionKeyRef.current = `${sel.startLineNumber}:${sel.startColumn}-${sel.endLineNumber}:${sel.endColumn}`;
                  }
                  setSelectionCoords(null);
                });
                ed.onDidChangeCursorPosition((e) => {
                  onCursorChange?.(e.position.lineNumber, e.position.column);
                  updateGitBlameRef.current(e.position.lineNumber);
                  trackCursorJump(activeRef.current?.path, e.position.lineNumber, e.position.column);
                });
                // Git gutter click handler — 点击左侧差异色条/边距触发差异对比，排除代码折叠按钮
                ed.onMouseDown((e) => {
                  if (e.event) {
                    const b = e.event.browserEvent;
                    lastMousePosRef.current = {
                      clientX: b?.clientX ?? e.event.posx,
                      clientY: b?.clientY ?? e.event.posy,
                    };
                  }
                  if (e.event.metaKey || e.event.ctrlKey) {
                    return;
                  }
                  isMouseDownRef.current = true;
                  setSelectionCoords(null);
                  const el = e.target.element as HTMLElement | null;
                  const isGitGutterEl = !!el?.closest('[class*="git-gutter"]');
                  const isFoldingEl = !!el?.closest(
                    '[class*="codicon-folding"], [class*="folding"], [class*="codicon-chevron"], .inline-folded',
                  );
                  // 仅当明确点击了代码折叠/展开按钮（且未直接点中 git-gutter 色条）时忽略，保障折叠不误触
                  if (isFoldingEl && !isGitGutterEl) {
                    return;
                  }
                  // 左侧装订线区域（type 4 行装饰 / type 3 行号 / type 2 字形边距）或直接命中 git-gutter 元素
                  if (
                    e.target.type === 4 ||
                    e.target.type === 3 ||
                    e.target.type === 2 ||
                    isGitGutterEl
                  ) {
                    const line = e.target.position?.lineNumber ?? e.target.range?.startLineNumber;
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
                ed.onMouseUp((e) => {
                  isMouseDownRef.current = false;
                  if (e.event) {
                    const b = e.event.browserEvent;
                    lastMousePosRef.current = {
                      clientX: b?.clientX ?? e.event.posx,
                      clientY: b?.clientY ?? e.event.posy,
                    };
                  }
                  updateSelectionAndCoords(ed);
                });
                updateSelectionAndCoords(ed);
                const initPos = ed.getPosition();
                if (initPos) {
                  updateGitBlameRef.current(initPos.lineNumber, true);
                }

                executeRevealTarget(ed);
              }}
              options={{
                fontSize: 13,
                fontFamily: 'Menlo, Monaco, "Cascadia Code", Consolas, "PingFang SC", "Microsoft YaHei", monospace',
                fontWeight: '400',
                disableMonospaceOptimizations: true,
                'semanticHighlighting.enabled': true,
                minimap: { enabled: minimap !== false },
                hover: { enabled: true, delay: Math.max(500, hoverDelay ?? 500) },
                automaticLayout: true,
                smoothScrolling: true,
                wordWrap: wordWrap ? 'on' : 'off',
                scrollBeyondLastColumn: 0,
                lineNumbersMinChars: 4,
                lineDecorationsWidth: 10,
                glyphMargin: false,
                folding: true,
                overviewRulerLanes: 3,
                overviewRulerBorder: false,
                multiCursorModifier: 'alt',
                links: true,
                occurrencesHighlight: 'off',
                selectionHighlight: false,
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
                  verticalScrollbarSize: 12,
                  horizontalScrollbarSize: 8,
                  verticalSliderSize: 12,
                  horizontalSliderSize: 8,
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
              fontFamily: 'ui-monospace, SFMono-Regular, "Cascadia Code", Menlo, Monaco, Consolas, monospace',
              color: 'var(--text)',
              boxSizing: 'border-box',
            }}
            className="git-inline-diff-banner"
          >
            {(() => {
              if (!gitDiffData || gitDiffData.path !== activePath) {
                return (
                  <div style={{ padding: '12px 16px', color: 'var(--muted)' }}>
                    正在加载改动对比数据...
                  </div>
                );
              }

              const originalContent = gitDiffData.original;
              const currentContent = active.content ?? gitDiffData.modified;
              const { ops, hunks } = computeInlineHunks(originalContent, currentContent);
              const targetL = gitInlineDiffLine || 1;

              let activeHunk = hunks.find(
                (h) => targetL >= h.startModLine && targetL <= h.endModLine,
              );
              if (!activeHunk && hunks.length > 0) {
                activeHunk = [...hunks].sort(
                  (a, b) => Math.abs(a.startModLine - targetL) - Math.abs(b.startModLine - targetL),
                )[0];
              }

              const currentHunkIdx = activeHunk ? hunks.indexOf(activeHunk) : 0;
              const totalHunks = Math.max(1, hunks.length);

              // 组织当前 Hunk 及其上下 3 行上下文
              const displayRows: Array<{
                key: string;
                type: 'same' | 'del' | 'add';
                origNum?: number;
                modNum?: number;
                text: string;
              }> = [];

              if (activeHunk) {
                // 1. 上文 3 行
                const ctxTop = ops.slice(Math.max(0, activeHunk.opsStartIndex - 3), activeHunk.opsStartIndex);
                for (let k = 0; k < ctxTop.length; k++) {
                  const o = ctxTop[k];
                  displayRows.push({
                    key: `top_${k}_${o.origNum}_${o.modNum}`,
                    type: 'same',
                    origNum: o.origNum,
                    modNum: o.modNum,
                    text: o.text,
                  });
                }
                // 2. 整块删除行
                for (let k = 0; k < activeHunk.dels.length; k++) {
                  const o = activeHunk.dels[k];
                  displayRows.push({
                    key: `del_${k}_${o.origNum}`,
                    type: 'del',
                    origNum: o.origNum,
                    text: o.text,
                  });
                }
                // 3. 整块新增行
                for (let k = 0; k < activeHunk.adds.length; k++) {
                  const o = activeHunk.adds[k];
                  displayRows.push({
                    key: `add_${k}_${o.modNum}`,
                    type: 'add',
                    modNum: o.modNum,
                    text: o.text,
                  });
                }
                // 4. 下文 3 行
                const ctxBottom = ops.slice(activeHunk.opsEndIndex + 1, Math.min(ops.length, activeHunk.opsEndIndex + 4));
                for (let k = 0; k < ctxBottom.length; k++) {
                  const o = ctxBottom[k];
                  displayRows.push({
                    key: `btm_${k}_${o.origNum}_${o.modNum}`,
                    type: 'same',
                    origNum: o.origNum,
                    modNum: o.modNum,
                    text: o.text,
                  });
                }
              }

              // 为当前改动块中的每一行计算行内改动差异 (Token/Word Diff)
              const lineDiffPartsMap = new Map<string, InlineDiffPart[]>();

              if (activeHunk) {
                const dels = activeHunk.dels;
                const adds = activeHunk.adds;

                if (dels.length > 0 && adds.length > 0) {
                  if (dels.length === adds.length) {
                    // 数量相等时按行序 1-对-1 对应计算行内差异
                    for (let k = 0; k < dels.length; k++) {
                      const diff = computeLineTokenDiff(dels[k].text, adds[k].text);
                      lineDiffPartsMap.set(`del_${k}_${dels[k].origNum}`, diff.partsOld);
                      lineDiffPartsMap.set(`add_${k}_${adds[k].modNum}`, diff.partsNew);
                    }
                  } else {
                    // 数量不等时基于行相似度最优贪心配对
                    const matchedAddIdxs = new Set<number>();
                    for (let di = 0; di < dels.length; di++) {
                      let bestAi = -1;
                      let bestSim = 0;
                      for (let ai = 0; ai < adds.length; ai++) {
                        if (matchedAddIdxs.has(ai)) continue;
                        const sim = computeLineSimilarity(dels[di].text, adds[ai].text);
                        if (sim > bestSim && sim >= 0.25) {
                          bestSim = sim;
                          bestAi = ai;
                        }
                      }
                      if (bestAi >= 0) {
                        matchedAddIdxs.add(bestAi);
                        const diff = computeLineTokenDiff(dels[di].text, adds[bestAi].text);
                        lineDiffPartsMap.set(`del_${di}_${dels[di].origNum}`, diff.partsOld);
                        lineDiffPartsMap.set(`add_${bestAi}_${adds[bestAi].modNum}`, diff.partsNew);
                      }
                    }
                  }
                }
              }

              return (
                <>
                  {/* Header Action Bar */}
                  <div
                    className="scm-hunk-action-bar"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      height: 34,
                      padding: '0 12px',
                      background: 'rgba(255, 255, 255, 0.03)',
                      borderBottom: '1px solid var(--border)',
                      fontSize: 12,
                      userSelect: 'none',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text)' }}>
                        {active.path.split('/').pop() || active.path}
                      </span>
                      <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                        Git 本地更改(工作树) - 第 {currentHunkIdx + 1} 个更改(共 {totalHunks} 个)
                      </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      {/* 1. Stage button + */}
                      <button
                        type="button"
                        title="暂存文件更改"
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
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="12" y1="5" x2="12" y2="19" />
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                      </button>

                      {/* 2. Discard button ⟲ (精准放弃当前改动块) */}
                      <button
                        type="button"
                        title="放弃此块更改"
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
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                          <path d="M3 3v5h5" />
                        </svg>
                      </button>

                      {/* 3. Previous diff ↑ */}
                      <button
                        type="button"
                        title="上一个更改"
                        onClick={() => {
                          if (hunks.length > 0) {
                            const prevIdx = (currentHunkIdx - 1 + hunks.length) % hunks.length;
                            const prevHunk = hunks[prevIdx];
                            setGitInlineDiffLine(prevHunk.startModLine);
                            editorRef.current?.revealLineInCenter(prevHunk.startModLine);
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
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="12" y1="19" x2="12" y2="5" />
                          <polyline points="5 12 12 5 19 12" />
                        </svg>
                      </button>

                      {/* 4. Next diff ↓ */}
                      <button
                        type="button"
                        title="下一个更改"
                        onClick={() => {
                          if (hunks.length > 0) {
                            const nextIdx = (currentHunkIdx + 1) % hunks.length;
                            const nextHunk = hunks[nextIdx];
                            setGitInlineDiffLine(nextHunk.startModLine);
                            editorRef.current?.revealLineInCenter(nextHunk.startModLine);
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
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="12" y1="5" x2="12" y2="19" />
                          <polyline points="19 12 12 19 5 12" />
                        </svg>
                      </button>

                      {/* 5. Close ✕ */}
                      <button
                        type="button"
                        title="关闭对比 (Esc)"
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
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Dual Line Numbers & Code Diff Rows */}
                  <div style={{ maxHeight: 340, overflowY: 'auto', overflowX: 'auto', background: 'var(--bg-editor, #1e1e1e)' }}>
                    {displayRows.length === 0 ? (
                      <div style={{ padding: '12px 16px', color: 'var(--muted)' }}>
                        当前未检测到行级改动
                      </div>
                    ) : (
                      displayRows.map((row) => {
                        const renderRowContent = () => {
                          const parts = lineDiffPartsMap.get(row.key);
                          if (parts && parts.length > 0) {
                            const isDel = row.type === 'del';
                            const diffBg = isDel ? 'rgba(248, 81, 73, 0.42)' : 'rgba(46, 160, 67, 0.42)';
                            const diffColor = isDel ? '#ffdcd7' : '#aff5b4';
                            return (
                              <>
                                {parts.map((p, pIdx) =>
                                  p.isDiff ? (
                                    <span
                                      key={pIdx}
                                      style={{
                                        background: diffBg,
                                        color: diffColor,
                                        borderRadius: 2,
                                        padding: '1px 2px',
                                      }}
                                    >
                                      {p.text}
                                    </span>
                                  ) : (
                                    <span key={pIdx}>{p.text}</span>
                                  ),
                                )}
                              </>
                            );
                          }
                          // 未配对的纯新增行或纯删除行
                          if (row.type === 'del') {
                            return <span style={{ color: '#ffdcd7' }}>{row.text}</span>;
                          }
                          if (row.type === 'add') {
                            return <span style={{ color: '#aff5b4' }}>{row.text}</span>;
                          }
                          return row.text;
                        };

                        const isDel = row.type === 'del';
                        const isAdd = row.type === 'add';

                        return (
                          <div
                            key={row.key}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              minHeight: 22,
                              lineHeight: '22px',
                              background: isDel
                                ? 'rgba(248, 81, 73, 0.12)'
                                : isAdd
                                  ? 'rgba(46, 160, 67, 0.12)'
                                  : 'transparent',
                              borderLeft: isDel
                                ? '3px solid #f85149'
                                : isAdd
                                  ? '3px solid #3fb950'
                                  : '3px solid transparent',
                              fontSize: 12,
                              boxSizing: 'border-box',
                            }}
                          >
                            {/* 行号栏 Gutter */}
                            <div
                              style={{
                                width: 88,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'flex-end',
                                padding: '0 6px',
                                color: 'var(--muted)',
                                borderRight: '1px solid rgba(255, 255, 255, 0.08)',
                                userSelect: 'none',
                                background: 'rgba(0, 0, 0, 0.22)',
                                fontSize: 11,
                                flexShrink: 0,
                                boxSizing: 'border-box',
                                gap: 6,
                              }}
                            >
                              <span
                                style={{
                                  width: 28,
                                  textAlign: 'right',
                                  color: isDel ? '#f85149' : undefined,
                                }}
                              >
                                {row.origNum ?? ''}
                              </span>
                              <span
                                style={{
                                  width: 28,
                                  textAlign: 'right',
                                  color: isAdd ? '#3fb950' : undefined,
                                }}
                              >
                                {row.modNum ?? ''}
                              </span>
                              <span
                                style={{
                                  width: 14,
                                  textAlign: 'center',
                                  fontWeight: 700,
                                  color: isDel ? '#f85149' : isAdd ? '#3fb950' : 'transparent',
                                }}
                              >
                                {isDel ? '-' : isAdd ? '+' : ' '}
                              </span>
                            </div>

                            {/* 代码内容区域 */}
                            <div
                              style={{
                                padding: '0 12px',
                                whiteSpace: 'pre',
                                overflow: 'visible',
                                flex: 1,
                                color: row.type === 'same' ? 'rgba(255, 255, 255, 0.65)' : 'var(--text, #e6edf3)',
                              }}
                            >
                              {renderRowContent()}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </>
              );
            })()}
          </div>
        )}
      </div>

      {/* Editor Tab Context Menu (VSCode / Modern macOS style) */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
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
                <div className="menu-item-left">
                  <svg className="menu-item-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                  <span>放弃修改 (Discard Changes)</span>
                </div>
                <kbd className="shortcut-badge shortcut-badge-icon" title="放弃修改">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                </kbd>
              </div>
              <div className="menu-divider" />
            </>
          )}
          <div className="menu-item" onClick={() => handleCloseTab(contextMenu.targetPath)}>
            <div className="menu-item-left">
              <svg className="menu-item-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
              <span>关闭</span>
            </div>
            <kbd className="shortcut-badge">{isMac ? '⌘W' : 'Ctrl+W'}</kbd>
          </div>
          <div className="menu-item" onClick={() => handleCloseOthers(contextMenu.targetPath)}>
            <div className="menu-item-left">
              <svg className="menu-item-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="13" height="13" rx="2" />
                <path d="M9 17h10a2 2 0 0 0 2-2V9" />
              </svg>
              <span>关闭其他</span>
            </div>
            <kbd className="shortcut-badge">{isMac ? '⌥⌘T' : 'Alt+Ctrl+T'}</kbd>
          </div>
          <div className="menu-item" onClick={() => handleCloseRight(contextMenu.targetPath)}>
            <div className="menu-item-left">
              <svg className="menu-item-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="9 18 15 12 9 6" />
                <line x1="19" y1="5" x2="19" y2="19" />
              </svg>
              <span>关闭右侧标签页</span>
            </div>
          </div>
          <div className="menu-item" onClick={handleCloseSaved}>
            <div className="menu-item-left">
              <svg className="menu-item-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
              <span>关闭已保存</span>
            </div>
          </div>
          <div className="menu-item" onClick={handleCloseAll}>
            <div className="menu-item-left">
              <svg className="menu-item-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="9" y1="9" x2="15" y2="15" />
                <line x1="15" y1="9" x2="9" y2="15" />
              </svg>
              <span>全部关闭</span>
            </div>
          </div>

          <div className="menu-divider" />

          <div
            className="menu-item"
            onClick={() => void handleCopyPath(contextMenu.targetPath, false)}
          >
            <div className="menu-item-left">
              <svg className="menu-item-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <span>复制绝对路径</span>
            </div>
            <kbd className="shortcut-badge">{isMac ? '⌥⌘C' : 'Alt+Ctrl+C'}</kbd>
          </div>
          <div
            className="menu-item"
            onClick={() => void handleCopyPath(contextMenu.targetPath, true)}
          >
            <div className="menu-item-left">
              <svg className="menu-item-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
              </svg>
              <span>复制相对路径</span>
            </div>
            <kbd className="shortcut-badge">{isMac ? '⌥⇧⌘C' : 'Alt+Shift+Ctrl+C'}</kbd>
          </div>

          <div className="menu-divider" />

          <div
            className="menu-item"
            onClick={() => void handleShowInFinder(contextMenu.targetPath)}
          >
            <div className="menu-item-left">
              <svg className="menu-item-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span>{isMac ? '在 Finder 中显示' : '在资源管理器中显示'}</span>
            </div>
            <kbd className="shortcut-badge">{isMac ? '⌥⌘R' : 'Alt+Ctrl+R'}</kbd>
          </div>
        </div>
      )}
    </div>
  );
}
