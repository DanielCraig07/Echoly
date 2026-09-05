import { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import type { GitStatusEntry, GitStatusResult, OpenTab, PendingDiff, UiTheme } from '@deepseek-ide/shared';
import { isImagePath, isUntitledPath, languageFromPath, untitledTabLabel } from '../utils';
import { RenderFileTreeIcon } from './FileTree';
import { MarkdownMessage } from './MarkdownMessage';
import { WelcomeView } from './WelcomeView';
import type { RecentWorkspaceItem } from './OpenWorkspaceModal';







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
  onChangeContent: (path: string, content: string) => void;
  onSelectionChange?: (text: string) => void;
  onCursorChange?: (line: number, col: number) => void;
  onAddToChat?: (text: string) => void;
  previewDiff: PendingDiff | null;
  onCloseDiff?: () => void;
  wordWrap?: boolean;
  onToggleWordWrap?: () => void;
  onPreviewGitDiff?: (path: string) => void;
  onDiscardPath?: (path: string) => void;
  onRefreshGitStatus?: () => void;
  revealLine?: number | null;
  uiTheme: UiTheme;
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
  if (!path || typeof path !== 'string' || !entries || !Array.isArray(entries) || !entries.length) return null;
  const norm = path.replace(/\\/g, '/');
  try {
    const matched = entries.find((e) => e && e.path === norm);
    if (!matched) return null;
    if (matched.untracked) return { label: 'U', color: '#4caf50' };
    if (matched.staged) return { label: 'A', color: '#4caf50' };
    if (matched.workTree && matched.workTree.trim()) return { label: 'M', color: '#e5a54b' };
    return null;
  } catch {
    return null;
  }
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
  previewDiff,
  onCloseDiff,
  wordWrap = false,
  onToggleWordWrap,
  onPreviewGitDiff,
  onDiscardPath,
  onRefreshGitStatus,
  revealLine,
  uiTheme,
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
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const monacoTheme = uiTheme === 'light' ? 'vs' : 'custom-dark';
  const pendingReveal = useRef<number | null>(null);

  const [selectedText, setSelectedText] = useState('');
  const [selectionRange, setSelectionRange] = useState<{ startLine: number; endLine: number } | null>(null);
  const [selectionCoords, setSelectionCoords] = useState<{ top: number; left: number } | null>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [mdEditorRatio, setMdEditorRatio] = useState<number>(0.5);

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
    const rangeText = selectionRange ? ` 第 ${selectionRange.startLine}-${selectionRange.endLine} 行` : '';
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
  const [gitDiffData, setGitDiffData] = useState<{ original: string; modified: string } | null>(null);
  const [mdPreviewScrollTo, setMdPreviewScrollTo] = useState<string | null>(null);
  const mdPreviewRef = useRef<HTMLDivElement>(null);
  const decorationsRef = useRef<string[]>([]);
  const blameDecorationsRef = useRef<string[]>([]);
  const blameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [gitInlineDiffLine, setGitInlineDiffLine] = useState<number | null>(null);
  const isSyncingScrollRef = useRef(false);

  const updateGitBlame = useCallback(
    (lineNumber: number) => {
      if (blameTimerRef.current) clearTimeout(blameTimerRef.current);
      blameTimerRef.current = setTimeout(async () => {
        const ed = editorRef.current;
        if (!ed || !activePath || activePath.startsWith('untitled:')) {
          if (ed && blameDecorationsRef.current.length > 0) {
            blameDecorationsRef.current = ed.deltaDecorations(blameDecorationsRef.current, []);
          }
          return;
        }
        const model = ed.getModel();
        if (!model || lineNumber > model.getLineCount()) return;

        try {
          const res = await window.ide.gitBlameLine(activePath, lineNumber);
          if (!res.ok || !res.commit) {
            blameDecorationsRef.current = ed.deltaDecorations(blameDecorationsRef.current, []);
            return;
          }
          const maxCol = model.getLineMaxColumn(lineNumber);
          const c = res.commit;
          const msg = c.message.length > 40 ? c.message.slice(0, 38) + '…' : c.message;
          const text = `  ${c.author}, ${c.relativeDate || c.date} • ${msg}`;

          blameDecorationsRef.current = ed.deltaDecorations(blameDecorationsRef.current, [
            {
              range: {
                startLineNumber: lineNumber,
                startColumn: maxCol,
                endLineNumber: lineNumber,
                endColumn: maxCol,
              },
              options: {
                isWholeLine: false,
                after: {
                  content: text,
                  inlineClassName: 'monaco-inline-git-blame',
                },
              },
            },
          ]);
        } catch {
          if (ed) {
            blameDecorationsRef.current = ed.deltaDecorations(blameDecorationsRef.current, []);
          }
        }
      }, 250);
    },
    [activePath],
  );

  useEffect(() => {
    if (editorRef.current && blameDecorationsRef.current.length > 0) {
      blameDecorationsRef.current = editorRef.current.deltaDecorations(blameDecorationsRef.current, []);
    }
  }, [activePath]);

  // Track which line ranges are modified (for inline diff popup on gutter click)
  const modifiedRangesRef = useRef<Array<{ start: number; end: number }>>([]);
  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  // Suppress onChange echoes when content is set programmatically (e.g. accept diff)
  const suppressChangeRef = useRef(false);
  const prevActiveContentRef = useRef<string | null>(null);

  // When active tab's content changes externally (e.g. accept diff), suppress the
  // next onChange echo so it doesn't overwrite the programmatic update.
  useEffect(() => {
    if (!active) return;
    if (prevActiveContentRef.current !== null && prevActiveContentRef.current !== active.content) {
      // Content changed from outside; the Monaco model update will fire onChange once — suppress it
      suppressChangeRef.current = true;
    }
    prevActiveContentRef.current = active.content;
  });

  useEffect(() => {
    if (activeTabRef.current) {
      activeTabRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [activePath]);

  const isMarkdown = Boolean(activePath?.endsWith('.md'));
  const isImage = Boolean(
    active && (active.language === 'image' || active.previewUrl || isImagePath(active.path)),
  );
  const activeGitMeta = getTabGitMeta(activePath, gitStatus?.entries);

  useEffect(() => {
    if (!activePath || !activeGitMeta || !window.ide.gitDiff) {
      setGitDiffData(null);
      return;
    }
    void window.ide.gitDiff(activePath, false).then((res) => {
      if (res.ok) {
        setGitDiffData({ original: res.original, modified: res.modified });
      } else {
        setGitDiffData(null);
      }
    }).catch(() => {
      setGitDiffData(null);
    });
  }, [activePath, activeGitMeta]);



  useEffect(() => {
    if (revealLine != null && revealLine > 0) {
      pendingReveal.current = revealLine;
      const ed = editorRef.current;
      if (ed) {
        ed.revealLineInCenter(revealLine);
        ed.setPosition({ lineNumber: revealLine, column: 1 });
        ed.focus();
        pendingReveal.current = null;
      }
    }
  }, [revealLine, activePath]);

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

  const handlePreviewScroll = () => {
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

  // Apply git decorations (gutter indicators) from diff data
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !gitDiffData) {
      if (ed && !gitDiffData) {
        decorationsRef.current = ed.deltaDecorations(decorationsRef.current, []);
      }
      modifiedRangesRef.current = [];
      return;
    }
    const origLines = gitDiffData.original.split('\n');
    const modLines = gitDiffData.modified.split('\n');
    const decorations: MonacoEditor.IModelDeltaDecoration[] = [];
    const ranges: Array<{ start: number; end: number }> = [];
    let rangeStart = -1;
    let oi = 0, mi = 0;
    while (oi < origLines.length || mi < modLines.length) {
      if (oi < origLines.length && mi < modLines.length && origLines[oi] === modLines[mi]) {
        // End a modified range
        if (rangeStart >= 0) {
          ranges.push({ start: rangeStart, end: mi });
          rangeStart = -1;
        }
        oi++; mi++;
      } else if (oi < origLines.length && mi < modLines.length) {
        // Modified
        if (rangeStart < 0) rangeStart = mi + 1;
        decorations.push({
          range: { startLineNumber: mi + 1, startColumn: 1, endLineNumber: mi + 1, endColumn: 1 },
          options: {
            isWholeLine: true,
            linesDecorationsClassName: 'git-gutter-modified',
            glyphMarginClassName: 'git-gutter-glyph',
          },
        });
        oi++; mi++;
      } else if (mi < modLines.length && (oi >= origLines.length || !origLines.slice(oi, oi + 10).includes(modLines[mi]))) {
        // Added line
        if (rangeStart < 0) rangeStart = mi + 1;
        decorations.push({
          range: { startLineNumber: mi + 1, startColumn: 1, endLineNumber: mi + 1, endColumn: 1 },
          options: {
            isWholeLine: true,
            linesDecorationsClassName: 'git-gutter-added',
            glyphMarginClassName: 'git-gutter-glyph',
          },
        });
        mi++;
      } else if (oi < origLines.length) {
        // Deleted line
        if (rangeStart < 0) rangeStart = mi + 1;
        const delLine = Math.min(mi + 1, modLines.length);
        decorations.push({
          range: { startLineNumber: Math.max(delLine, 1), startColumn: 1, endLineNumber: Math.max(delLine, 1), endColumn: 1 },
          options: {
            isWholeLine: true,
            linesDecorationsClassName: 'git-gutter-deleted',
            glyphMarginClassName: 'git-gutter-glyph',
          },
        });
        oi++;
      } else {
        break;
      }
    }
    if (rangeStart >= 0) ranges.push({ start: rangeStart, end: modLines.length });
    modifiedRangesRef.current = ranges;
    decorationsRef.current = ed.deltaDecorations(decorationsRef.current, decorations);
  }, [gitDiffData]);

  useEffect(() => {
    if (!active) {
      onSelectionChangeRef.current?.('');
      setSelectedText('');
    }
  }, [active]);

  // Single-Hunk Discard Handler (reverts ONLY the target modified hunk, leaving other changes in the file intact)
  const handleDiscardSingleHunk = async () => {
    if (!active?.path || !gitDiffData || gitInlineDiffLine == null) return;
    const origLines = gitDiffData.original.split('\n');
    const modLines = (active.content || gitDiffData.modified).split('\n');
    const targetL = gitInlineDiffLine;

    let oi = 0, mi = 0;
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
        oi++; mi++;
      } else {
        if (!currentHunk) {
          currentHunk = { modStart: mi + 1, modEnd: mi + 1, origLines: [] };
        } else {
          currentHunk.modEnd = mi + 1;
        }

        if (oi < origLines.length && mi < modLines.length) {
          currentHunk.origLines.push(origLines[oi]);
          oi++; mi++;
        } else if (mi < modLines.length && (oi >= origLines.length || !origLines.slice(oi, oi + 10).includes(modLines[mi]))) {
          mi++;
        } else if (oi < origLines.length) {
          currentHunk.origLines.push(origLines[oi]);
          oi++;
        }
      }
    }

    if (currentHunk && !matchingHunk && targetL >= currentHunk.modStart && targetL <= currentHunk.modEnd) {
      matchingHunk = currentHunk;
    }

    if (!matchingHunk) return;

    const newModLines = [
      ...modLines.slice(0, matchingHunk.modStart - 1),
      ...matchingHunk.origLines,
      ...modLines.slice(matchingHunk.modEnd),
    ];

    const newContent = newModLines.join('\n');
    onChangeContent(active.path, newContent);
    await window.ide.writeFile(active.path, newContent);
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
          left: Math.max(10, Math.min(left, containerRect.width - 65)),
          top: Math.max(8, Math.min(top, containerRect.height - 35)),
        });
      }
    } catch {
      // ignore
    }
  }, []);

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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (selectedText && selectedText.trim().length > 0) {
          e.preventDefault();
          setShowInlineAi(true);
          setTimeout(() => inlineInputRef.current?.focus(), 50);
        }
      }
      if (e.key === 'Escape' && showInlineAi) {
        setShowInlineAi(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedText, showInlineAi]);

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
              style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              className="icon-btn"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
              style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              className="icon-btn"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
              style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              className="icon-btn"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
              style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              className="icon-btn"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
                style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                className="icon-btn"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
                  const line = changes[0].modifiedStartLineNumber || changes[0].originalStartLineNumber || 1;
                  diffEd.getModifiedEditor().revealLineInCenter(line);
                }
              }, 150);
            }}
            options={{
              readOnly: true,
              renderSideBySide: true,
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
                horizontalScrollbarSize: 4,
                verticalSliderSize: 4,
                horizontalSliderSize: 4,
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
        className="tabs"
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
              <span style={{ color: gitMeta?.color }}>{fileName}</span>
              {gitMeta?.label && (
                <span
                  className="tab-git-badge"
                  style={{ color: gitMeta.color, cursor: 'pointer', padding: '0 4px', borderRadius: 2 }}
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
              {tab.dirty && <span className="dirty-dot">•</span>}
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.path);
                }}
              >
                ×
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
          {(isUntitledPath(activePath) ? [untitledTabLabel(activePath)] : activePath.split('/')).map((part, i, arr) => (
            <span key={i} className="crumb-item">
              <span>{part}</span>
              {i < arr.length - 1 && <span className="crumb-sep">&gt;</span>}
            </span>
          ))}
          <div className="editor-breadcrumb-actions">
            {isMarkdown && (
              <button
                type="button"
                className={`md-preview-btn${showMdPreview ? ' active' : ''}`}
                onClick={() => setShowMdPreview((v) => !v)}
              >
                {showMdPreview ? '编辑' : '预览'}
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
            title="引用选中文本到 AI 会话 (快捷键 Cmd+K 打开行内 AI 编辑)"
          >
            <span
              className="selection-ai-badge"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleAddToChat(e);
                setSelectionCoords(null);
              }}
              title="添加到 AI 聊天会话"
            >
              ✦ AI
            </span>
            <span
              className="selection-ai-inline-btn"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setShowInlineAi(true);
                setTimeout(() => inlineInputRef.current?.focus(), 50);
              }}
              title="行内 AI 智能编辑 (Cmd+K)"
            >
              ⌘K
            </span>
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
              <span className="inline-ai-title">✦ 行内 AI 编辑 {selectionRange ? `(行 ${selectionRange.startLine}-${selectionRange.endLine})` : ''}</span>
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
              <span className="inline-ai-tag" onClick={() => handleQuickPrompt('优化并简化此段代码结构')}>优化结构</span>
              <span className="inline-ai-tag" onClick={() => handleQuickPrompt('为选区代码添加清晰的中文注释')}>添加注释</span>
              <span className="inline-ai-tag" onClick={() => handleQuickPrompt('增强入参校验与异常捕获逻辑')}>错误处理</span>
              <span className="inline-ai-tag" onClick={() => handleQuickPrompt('为此代码编写对应的单元测试用例')}>编写单测</span>
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
                path={active.path}
                value={active.content}
                language={active.language}
                theme={monacoTheme}
                onChange={(v) => onChangeContent(active.path, v ?? '')}
                onMount={(ed) => {
                  editorRef.current = ed;
                  setupEditorScrollSync(ed);
                  ed.onDidChangeCursorSelection(() => {
                    if (isMouseDownRef.current) {
                      updateSelectionTextOnly(ed);
                    } else {
                      updateSelectionAndCoords(ed);
                    }
                  });
                  ed.onDidScrollChange(() => {
                    if (!isMouseDownRef.current) {
                      updateSelectionAndCoords(ed);
                    }
                  });
                  ed.onDidChangeCursorPosition((e) => {
                    onCursorChange?.(e.position.lineNumber, e.position.column);
                    updateGitBlame(e.position.lineNumber);
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
                    isMouseDownRef.current = true;
                    setSelectionCoords(null);
                    if (e.target.type === 4 || e.target.type === 3) {
                      const line = e.target.position?.lineNumber;
                      if (line && modifiedRangesRef.current.length > 0) {
                        const isModifiedLine = modifiedRangesRef.current.some(
                          (r) => line >= r.start && line <= r.end
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
                    pendingReveal.current = null;
                    ed.revealLineInCenter(line);
                    ed.setPosition({ lineNumber: line, column: 1 });
                    ed.focus();
                  }
                }}
                options={{
                  fontSize: 13,
                  minimap: { enabled: false },
                  automaticLayout: true,
                  wordWrap: wordWrap ? 'on' : 'off',
                  lineNumbersMinChars: 4,
                  lineDecorationsWidth: 10,
                  glyphMargin: false,
                  folding: true,
                  overviewRulerLanes: 0,
                  overviewRulerBorder: false,
                  scrollbar: {
                    vertical: 'visible',
                    horizontal: 'auto',
                    verticalScrollbarSize: 8,
                    horizontalScrollbarSize: 8,
                    verticalSliderSize: 8,
                    horizontalSliderSize: 8,
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
            <div className="md-preview-panel" ref={mdPreviewRef} onScroll={handlePreviewScroll} style={{ flex: 1 }}>
              <MarkdownMessage content={active.content} />
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
                language={active.language}
                theme={monacoTheme}
                onChange={(v) => {
                  if (suppressChangeRef.current) {
                    suppressChangeRef.current = false;
                    return;
                  }
                  onChangeContent(active.path, v ?? '');
                }}
                onMount={(ed) => {
                  editorRef.current = ed;
                  ed.onDidChangeCursorSelection(() => {
                    if (isMouseDownRef.current) {
                      updateSelectionTextOnly(ed);
                    } else {
                      updateSelectionAndCoords(ed);
                    }
                  });
                  ed.onDidScrollChange(() => {
                    if (!isMouseDownRef.current) {
                      updateSelectionAndCoords(ed);
                    }
                  });
                  ed.onDidChangeCursorPosition((e) => {
                    onCursorChange?.(e.position.lineNumber, e.position.column);
                    updateGitBlame(e.position.lineNumber);
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
                  wordWrap: wordWrap ? 'on' : 'off',
                  lineNumbersMinChars: 4,
                  scrollbar: {
                    vertical: 'visible',
                    horizontal: 'auto',
                    verticalScrollbarSize: 8,
                    horizontalScrollbarSize: 8,
                  },
                }}
              />
            </div>
            <div
              className="splitter splitter-v split-editor-splitter"
              onMouseDown={startSplitResize}
              title="拖动调整双栏宽度"
            />
            <div style={{ width: `${(1 - splitRatio) * 100}%`, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderLeft: '1px solid var(--border)' }}>
              <div className="split-secondary-header">
                <span className="split-label">拆分窗格</span>
                <select
                  value={splitActive?.path || ''}
                  onChange={(e) => setSplitPath(e.target.value)}
                  className="split-file-selector"
                >
                  {tabs.map((t) => {
                    const name = isUntitledPath(t.path) ? untitledTabLabel(t.path) : t.path.split('/').pop() || t.path;
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
                    path={splitActive.path === active.path ? splitActive.path + ':split' : splitActive.path}
                    value={splitActive.content}
                    language={splitActive.language}
                    theme={monacoTheme}
                    onChange={(v) => onChangeContent(splitActive.path, v ?? '')}
                    options={{
                      fontSize: 13,
                      minimap: { enabled: false },
                      automaticLayout: true,
                      wordWrap: wordWrap ? 'on' : 'off',
                      lineNumbersMinChars: 4,
                      scrollbar: {
                        vertical: 'visible',
                        horizontal: 'auto',
                        verticalScrollbarSize: 8,
                        horizontalScrollbarSize: 8,
                      },
                    }}
                  />
                )}
              </div>
            </div>
          </div>
        ) : active ? (
          <Editor
            path={active.path}
            value={active.content}
            language={active.language}
            theme={monacoTheme}
            onChange={(v) => {
              if (suppressChangeRef.current) {
                suppressChangeRef.current = false;
                return;
              }
              onChangeContent(active.path, v ?? '');
            }}
            onMount={(ed) => {
              editorRef.current = ed;
              ed.onDidChangeCursorSelection(() => {
                if (isMouseDownRef.current) {
                  updateSelectionTextOnly(ed);
                } else {
                  updateSelectionAndCoords(ed);
                }
              });
              ed.onDidScrollChange(() => {
                if (!isMouseDownRef.current) {
                  updateSelectionAndCoords(ed);
                }
              });
              ed.onDidChangeCursorPosition((e) => {
                onCursorChange?.(e.position.lineNumber, e.position.column);
                updateGitBlame(e.position.lineNumber);
              });
              // Git gutter click handler — GUTTER_LINE_NUMBERS = 4, GUTTER_GLYPH_MARGIN = 3
              ed.onMouseDown((e) => {
                isMouseDownRef.current = true;
                setSelectionCoords(null);
                if (e.target.type === 4 || e.target.type === 3) {
                  const line = e.target.position?.lineNumber;
                  if (line && modifiedRangesRef.current.length > 0) {
                    const isModifiedLine = modifiedRangesRef.current.some(
                      (r) => line >= r.start && line <= r.end
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
                pendingReveal.current = null;
                ed.revealLineInCenter(line);
                ed.setPosition({ lineNumber: line, column: 1 });
                ed.focus();
              }
            }}
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              automaticLayout: true,
              wordWrap: wordWrap ? 'on' : 'off',
              lineNumbersMinChars: 4,
              lineDecorationsWidth: 10,
              glyphMargin: false,
              folding: true,
              overviewRulerLanes: 0,
              overviewRulerBorder: false,
              scrollbar: {
                vertical: 'visible',
                horizontal: 'auto',
                verticalScrollbarSize: 8,
                horizontalScrollbarSize: 8,
                verticalSliderSize: 8,
                horizontalSliderSize: 8,
                useShadows: false,
              },
            }}
          />
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
                      (r) => gitInlineDiffLine >= r.start && gitInlineDiffLine <= r.end
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
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
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
                        (r) => gitInlineDiffLine >= r.start && gitInlineDiffLine <= r.end
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
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
                        (r) => gitInlineDiffLine >= r.start && gitInlineDiffLine <= r.end
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
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
                  return <div style={{ padding: '8px 12px', color: 'var(--muted)' }}>加载对比数据中...</div>;
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
                    rows.push({ type: 'same', origNum: i + 1, modNum: i + 1, content: modContent || '' });
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
                      oldStr[oldStr.length - 1 - suffixLen] === newStr[newStr.length - 1 - suffixLen]
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

          <div className="menu-item" onClick={() => void handleCopyPath(contextMenu.targetPath, false)}>
            <span>复制绝对路径</span>
            <span className="shortcut">⌥⌘C</span>
          </div>
          <div className="menu-item" onClick={() => void handleCopyPath(contextMenu.targetPath, true)}>
            <span>复制相对路径</span>
            <span className="shortcut">⌥⇧⌘C</span>
          </div>

          <div className="menu-divider" />

          <div className="menu-item" onClick={() => void handleShowInFinder(contextMenu.targetPath)}>
            <span>在 Finder / 资源管理器中显示</span>
            <span className="shortcut">⌥⌘R</span>
          </div>
        </div>
      )}
    </div>
  );
}
