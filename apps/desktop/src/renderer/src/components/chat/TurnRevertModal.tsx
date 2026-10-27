import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { DiffEditor } from '@monaco-editor/react';
import type { CheckpointDetail, CheckpointMutationDetail } from '@deepseek-ide/shared';
import { computeLineDiffStats } from '../../services/diffStats';
import { FileLanguageIcon } from './CodeRefPill';
import { useI18n } from '../../i18n';
import {
  useModalResize,
  ModalResizeHandle,
  createSafeOverlayHandlers,
} from '../../hooks/useModalResize';

export interface TurnRevertModalProps {
  open: boolean;
  runId: string;
  onClose: () => void;
  onRevertSuccess: (revertedPaths: string[]) => void;
  onOpenFile?: (path: string, line?: number) => void;
}

function getLanguageByPath(filePath?: string): string {
  if (!filePath) return 'plaintext';
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'java':
      return 'java';
    case 'sql':
      return 'sql';
    case 'py':
      return 'python';
    case 'json':
      return 'json';
    case 'html':
      return 'html';
    case 'css':
    case 'scss':
    case 'less':
      return 'css';
    case 'md':
      return 'markdown';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'shell';
    case 'cpp':
    case 'c':
    case 'cc':
    case 'h':
    case 'hpp':
      return 'cpp';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'xml':
      return 'xml';
    case 'yaml':
    case 'yml':
      return 'yaml';
    default:
      return 'plaintext';
  }
}

export const TurnRevertModal: React.FC<TurnRevertModalProps> = ({
  open,
  runId,
  onClose,
  onRevertSuccess,
  onOpenFile,
}) => {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<CheckpointDetail | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [revertMode, setRevertMode] = useState<'selected' | 'all'>('selected');
  const [safeConflictCheck, setSafeConflictCheck] = useState(true);
  const [searchFilter, setSearchFilter] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_turn_revert_modal_size',
    defaultWidth: 1060,
    defaultHeight: 720,
    minWidth: 760,
    minHeight: 480,
  });

  const safeOverlay = createSafeOverlayHandlers(onClose);

  // Load checkpoint detail
  useEffect(() => {
    if (!open || !runId) return;
    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);

    void window.ide
      .getCheckpointDetail(runId)
      .then((res) => {
        if (cancelled) return;
        setDetail(res);
        if (res && res.files.length > 0) {
          const allPaths = new Set(res.files.map((f) => f.path));
          setSelectedPaths(allPaths);
          setActiveFilePath(res.files[0].path);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, runId]);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isExecuting) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, isExecuting, onClose]);

  // Filtered files
  const filteredFiles = useMemo(() => {
    if (!detail) return [];
    if (!searchFilter.trim()) return detail.files;
    const q = searchFilter.toLowerCase();
    return detail.files.filter((f) => f.path.toLowerCase().includes(q));
  }, [detail, searchFilter]);

  // Diff stats map
  const statsMap = useMemo(() => {
    const map = new Map<string, { added: number; deleted: number }>();
    if (!detail) return map;
    for (const f of detail.files) {
      if (f.kind === 'write') {
        map.set(f.path, computeLineDiffStats(f.original ?? '', f.written ?? ''));
      } else if (f.kind === 'delete') {
        const deletedLines = (f.original ?? '').split(/\r?\n/).filter((l) => l.trim()).length;
        map.set(f.path, { added: 0, deleted: deletedLines || 1 });
      } else {
        map.set(f.path, { added: 0, deleted: 0 });
      }
    }
    return map;
  }, [detail]);

  // Active file
  const activeFile = useMemo(() => {
    if (!detail || !activeFilePath) return null;
    return detail.files.find((f) => f.path === activeFilePath) || detail.files[0] || null;
  }, [detail, activeFilePath]);

  // Selection toggle
  const togglePath = (path: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const handleSelectAll = (checked: boolean) => {
    if (!detail) return;
    if (checked) {
      setSelectedPaths(new Set(detail.files.map((f) => f.path)));
    } else {
      setSelectedPaths(new Set());
    }
  };

  // Execute revert
  const handleConfirmRevert = async () => {
    if (!detail || isExecuting) return;
    setIsExecuting(true);
    setErrorMsg(null);

    const pathsToRevert =
      revertMode === 'all' ? undefined : Array.from(selectedPaths);

    if (revertMode === 'selected' && (!pathsToRevert || pathsToRevert.length === 0)) {
      setErrorMsg('请至少勾选一个需要回退的文件');
      setIsExecuting(false);
      return;
    }

    try {
      const res = await window.ide.revertCheckpoint(runId, {
        paths: pathsToRevert,
        force: !safeConflictCheck,
      });

      if ('error' in res) {
        setErrorMsg(res.error);
        setIsExecuting(false);
        return;
      }

      onRevertSuccess(res.reverted);
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setIsExecuting(false);
    }
  };

  if (!open) return null;

  const isAllSelected = detail && detail.files.length > 0 && selectedPaths.size === detail.files.length;
  const isIndeterminate = detail && selectedPaths.size > 0 && selectedPaths.size < detail.files.length;
  const targetCount = revertMode === 'all' ? (detail?.files.length ?? 0) : selectedPaths.size;

  const modalContent = (
    <div className="settings-overlay turn-revert-overlay" {...safeOverlay}>
      <div
        className="turn-revert-modal"
        style={{
          width: modalSize.width,
          height: modalSize.height,
          maxWidth: '96vw',
          maxHeight: '94vh',
          position: 'relative',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="turn-revert-header">
          <div className="turn-revert-header-left">
            <div className="turn-revert-icon-pill" title="回退控制">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <polyline points="12 7 12 12 15 14" />
              </svg>
            </div>
            <div>
              <div className="turn-revert-title">本轮文件改动与回退控制</div>
              <div className="turn-revert-desc">
                细粒度审查本轮 AI 修改的具体内容，自由勾选文件并控制回退策略
              </div>
            </div>
          </div>
          <button
            type="button"
            className="panel-action-btn turn-revert-close-btn"
            title="关闭 (Esc)"
            onClick={onClose}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {errorMsg && (
          <div className="turn-revert-error-banner">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Body (Two Column) */}
        <div className="turn-revert-body">
          {loading ? (
            <div className="turn-revert-loading">
              <div className="loading-spinner" />
              <span>正在加载本轮改动快照与版本差异...</span>
            </div>
          ) : !detail || detail.files.length === 0 ? (
            <div className="turn-revert-empty">
              <span>本轮未记录到任何文件变动，或记录已被全部回退。</span>
            </div>
          ) : (
            <>
              {/* Left Column: File List & Checkbox */}
              <div className="turn-revert-files-sidebar">
                <div className="turn-revert-files-toolbar">
                  <label className="turn-revert-select-all">
                    <input
                      type="checkbox"
                      checked={Boolean(isAllSelected)}
                      ref={(el) => {
                        if (el) el.indeterminate = Boolean(isIndeterminate);
                      }}
                      onChange={(e) => handleSelectAll(e.target.checked)}
                    />
                    <span>
                      已选 {selectedPaths.size} / {detail.files.length} 个文件
                    </span>
                  </label>
                  {detail.files.length > 3 && (
                    <input
                      type="text"
                      className="turn-revert-search-input"
                      placeholder="搜索路径..."
                      value={searchFilter}
                      onChange={(e) => setSearchFilter(e.target.value)}
                    />
                  )}
                </div>

                <div className="turn-revert-files-list">
                  {filteredFiles.map((file) => {
                    const isSelected = selectedPaths.has(file.path);
                    const isActive = activeFile?.path === file.path;
                    const stats = statsMap.get(file.path) || { added: 0, deleted: 0 };
                    const basename = file.path.split('/').pop() || file.path;

                    let kindLabel = '修改';
                    let kindClass = 'mod-write';
                    if (file.kind === 'write' && file.original === null) {
                      kindLabel = '新增';
                      kindClass = 'mod-create';
                    } else if (file.kind === 'delete') {
                      kindLabel = '删除';
                      kindClass = 'mod-delete';
                    } else if (file.kind === 'move') {
                      kindLabel = '重命名';
                      kindClass = 'mod-move';
                    } else if (file.kind === 'unrecordable') {
                      kindLabel = '不可退';
                      kindClass = 'mod-unrec';
                    }

                    return (
                      <div
                        key={file.path}
                        className={`turn-revert-file-item ${isActive ? 'active' : ''} ${
                          isSelected ? 'checked' : ''
                        }`}
                        onClick={() => setActiveFilePath(file.path)}
                        onDoubleClick={() => {
                          if (file.kind !== 'delete' && onOpenFile) {
                            onOpenFile(file.path);
                            onClose();
                          }
                        }}
                      >
                        <input
                          type="checkbox"
                          className="turn-revert-item-checkbox"
                          checked={isSelected}
                          disabled={file.kind === 'unrecordable'}
                          onChange={() => togglePath(file.path)}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <span className="turn-revert-file-icon">
                          <FileLanguageIcon fileName={basename} />
                        </span>
                        <div className="turn-revert-file-info">
                          <div className="turn-revert-file-name" title={file.path}>
                            {basename}
                          </div>
                          <div className="turn-revert-file-path" title={file.path}>
                            {file.path}
                          </div>
                        </div>
                        <div className="turn-revert-file-meta">
                          <span className={`turn-revert-kind-badge ${kindClass}`}>
                            {kindLabel}
                          </span>
                          {(stats.added > 0 || stats.deleted > 0) && (
                            <span className="turn-revert-stats-badge">
                              {stats.added > 0 && <span className="diff-add">+{stats.added}</span>}
                              {stats.deleted > 0 && <span className="diff-del">-{stats.deleted}</span>}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Right Column: Diff Preview */}
              <div className="turn-revert-diff-pane">
                {activeFile ? (
                  <>
                    <div className="turn-revert-diff-header">
                      <div className="turn-revert-diff-path-wrap">
                        <FileLanguageIcon fileName={activeFile.path.split('/').pop() || ''} />
                        <span className="turn-revert-diff-path" title={activeFile.path}>
                          {activeFile.path}
                        </span>
                        <span className="turn-revert-diff-tag">
                          {activeFile.kind === 'write' && activeFile.original === null
                            ? '新建文件 (写前不存在)'
                            : activeFile.kind === 'delete'
                              ? '已删除文件 (快照可还原)'
                              : activeFile.kind === 'move'
                                ? `重命名自: ${activeFile.from}`
                                : '原文件修改对比'}
                        </span>
                      </div>
                      {onOpenFile && (
                        <button
                          type="button"
                          className="turn-revert-open-file-btn"
                          title={
                            activeFile.kind === 'delete'
                              ? '文件已在磁盘中删除，无法在编辑器中打开'
                              : '在编辑器中打开此文件并定位'
                          }
                          disabled={activeFile.kind === 'delete'}
                          onClick={() => {
                            if (activeFile.kind === 'delete') return;
                            onOpenFile(activeFile.path);
                            onClose();
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                            <polyline points="15 3 21 3 21 9" />
                            <line x1="10" y1="14" x2="21" y2="3" />
                          </svg>
                          <span>在编辑器中打开</span>
                        </button>
                      )}
                    </div>
                    {activeFile.kind === 'move' ? (
                      <div className="turn-revert-special-card-wrap">
                        <div className="turn-revert-special-card">
                          <div className="turn-revert-special-icon move-icon">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="17 1 21 5 17 9" />
                              <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                              <polyline points="7 23 3 19 7 15" />
                              <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                            </svg>
                          </div>
                          <div className="turn-revert-special-title">文件重命名 / 移动操作</div>
                          <div className="turn-revert-move-paths">
                            <div className="move-path-box from-box">
                              <span className="move-label">原文件路径</span>
                              <span className="move-val">{activeFile.from || activeFile.path}</span>
                            </div>
                            <div className="move-arrow-icon">➔</div>
                            <div className="move-path-box to-box">
                              <span className="move-label">新文件路径</span>
                              <span className="move-val">{activeFile.to || activeFile.path}</span>
                            </div>
                          </div>
                          <div className="turn-revert-special-desc">
                            执行回退后，该文件将原样移动回原路径 <code>{activeFile.from || activeFile.path}</code>。
                          </div>
                        </div>
                      </div>
                    ) : activeFile.kind === 'unrecordable' ? (
                      <div className="turn-revert-special-card-wrap">
                        <div className="turn-revert-special-card">
                          <div className="turn-revert-special-icon warn-icon">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                              <line x1="12" y1="9" x2="12" y2="13" />
                              <line x1="12" y1="17" x2="12.01" y2="17" />
                            </svg>
                          </div>
                          <div className="turn-revert-special-title">改动未完整留存快照</div>
                          <div className="turn-revert-warning-reason">
                            {activeFile.reason || '文件过大或包含二进制内容'}
                          </div>
                          <div className="turn-revert-special-desc">
                            由于改动内容超出安全快照阈值，建议通过 Git 源代码管理器查看工作树差异或丢弃更改。
                          </div>
                        </div>
                      </div>
                    ) : (
                      <>
                        {/* Diff sub-header for side-by-side panes with distinct boundary */}
                        <div className="turn-revert-diff-columns-bar">
                          <div className="diff-col-title diff-col-original">
                            <span className="diff-col-dot dot-original" />
                            <span>修改前（初始版本）</span>
                          </div>
                          <div className="diff-col-divider" />
                          <div className="diff-col-title diff-col-modified">
                            <span className="diff-col-dot dot-modified" />
                            <span>修改后（当前磁盘状态）</span>
                          </div>
                        </div>
                        <div className="turn-revert-diff-viewer">
                          <DiffEditor
                            original={activeFile.original ?? ''}
                            modified={activeFile.written ?? ''}
                            language={getLanguageByPath(activeFile.path)}
                            theme="vs-dark"
                            options={{
                              readOnly: true,
                              minimap: { enabled: false },
                              scrollBeyondLastLine: false,
                              fontSize: 12,
                              renderSideBySide: true,
                              originalEditable: false,
                              renderOverviewRuler: false,
                              overviewRulerLanes: 0,
                              overviewRulerBorder: false,
                              scrollbar: {
                                vertical: 'auto',
                                verticalScrollbarSize: 8,
                                horizontal: 'auto',
                                horizontalScrollbarSize: 8,
                                useShadows: false,
                              },
                            }}
                          />
                        </div>
                      </>
                    )}
                  </>
                ) : (
                  <div className="turn-revert-diff-placeholder">
                    <span>请从左侧选择要审查的文件</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer: Strategy Controls & Confirm Action */}
        <div className="turn-revert-footer">
          <div className="turn-revert-strategy-controls">
            <div className="turn-revert-mode-group">
              <span className="control-label">回退范围：</span>
              <label className="radio-pill">
                <input
                  type="radio"
                  name="revertMode"
                  value="selected"
                  checked={revertMode === 'selected'}
                  onChange={() => setRevertMode('selected')}
                />
                <span>仅回退所选 ({selectedPaths.size})</span>
              </label>
              <label className="radio-pill">
                <input
                  type="radio"
                  name="revertMode"
                  value="all"
                  checked={revertMode === 'all'}
                  onChange={() => setRevertMode('all')}
                />
                <span>整轮全部回退 ({detail?.files.length ?? 0})</span>
              </label>
            </div>

            <label className="turn-revert-safe-check" title="如果文件在本轮 AI 改动之后被手动二次编辑过，防冲突保护会安全跳过它，防止覆盖您的手写代码">
              <input
                type="checkbox"
                checked={safeConflictCheck}
                onChange={(e) => setSafeConflictCheck(e.target.checked)}
              />
              <span>防冲突保护（检测到二次手改时安全跳过）</span>
            </label>
          </div>

          <div className="turn-revert-actions">
            <button
              type="button"
              className="turn-revert-btn-cancel"
              disabled={isExecuting}
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="button"
              className="turn-revert-btn-confirm"
              disabled={isExecuting || loading || targetCount === 0}
              onClick={handleConfirmRevert}
            >
              {isExecuting ? (
                <>
                  <div className="btn-spinner" />
                  <span>正在执行回退...</span>
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 14 4 9l5-5" />
                    <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
                  </svg>
                  <span>确认回退 ({targetCount} 个文件)</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Modal Resize Handle (Bottom-Right) */}
        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
};
