import React, { useState, useMemo, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import { parseConflictBlocks, type ConflictBlock } from '../services/mergeConflictResolver';
import { useI18n } from '../i18n';

export interface ThreeWayMergeModalProps {
  filePath: string;
  initialContent: string;
  theme?: string;
  onSave: (mergedContent: string) => void;
  onClose: () => void;
}

export function ThreeWayMergeModal({
  filePath,
  initialContent,
  theme = 'vs-dark',
  onSave,
  onClose,
}: ThreeWayMergeModalProps) {
  const { t } = useI18n();
  const blocks = useMemo(() => parseConflictBlocks(initialContent), [initialContent]);

  // 每个冲突块的选择状态：'current' | 'incoming' | 'both' | 'base' | 'unresolved'
  const [resolutions, setResolutions] = useState<Record<string, 'current' | 'incoming' | 'both' | 'base'>>(() => {
    const init: Record<string, 'current' | 'incoming' | 'both' | 'base'> = {};
    return init;
  });

  const [activeBlockIndex, setActiveBlockIndex] = useState<number>(0);

  // 根据当前选择，实时组装最终合并文本
  const computedResult = useMemo(() => {
    if (!initialContent || blocks.length === 0) return initialContent;
    const lines = initialContent.split(/\r?\n/);
    const resultLines: string[] = [];
    let lineIdx = 1;

    for (const b of blocks) {
      // 冲突块之前的正常文本
      while (lineIdx < b.startLine) {
        resultLines.push(lines[lineIdx - 1]);
        lineIdx++;
      }

      // 冲突块本身
      const res = resolutions[b.id];
      if (res === 'current') {
        if (b.currentText) resultLines.push(b.currentText);
      } else if (res === 'incoming') {
        if (b.incomingText) resultLines.push(b.incomingText);
      } else if (res === 'base' && b.baseText) {
        resultLines.push(b.baseText);
      } else if (res === 'both') {
        if (b.currentText) resultLines.push(b.currentText);
        if (b.incomingText) resultLines.push(b.incomingText);
      } else {
        // 未解决时，保留原始冲突标记
        for (let i = b.startLine; i <= b.endLine; i++) {
          resultLines.push(lines[i - 1]);
        }
      }

      lineIdx = b.endLine + 1;
    }

    // 最后一个冲突块之后的正常文本
    while (lineIdx <= lines.length) {
      resultLines.push(lines[lineIdx - 1]);
      lineIdx++;
    }

    return resultLines.join('\n');
  }, [initialContent, blocks, resolutions]);

  const [customResultText, setCustomResultText] = useState<string | null>(null);
  const finalResultText = customResultText ?? computedResult;

  const currentBlock = blocks[activeBlockIndex] || null;

  const resolvedCount = Object.keys(resolutions).length;
  const totalCount = blocks.length;

  const handleResolve = useCallback((blockId: string, choice: 'current' | 'incoming' | 'both' | 'base') => {
    setResolutions((prev) => ({
      ...prev,
      [blockId]: choice,
    }));
    setCustomResultText(null);
  }, []);

  const handleBatchResolve = useCallback((choice: 'current' | 'incoming' | 'both') => {
    const next: Record<string, 'current' | 'incoming' | 'both' | 'base'> = {};
    for (const b of blocks) {
      next[b.id] = choice;
    }
    setResolutions(next);
    setCustomResultText(null);
  }, [blocks]);

  const handleSave = () => {
    onSave(finalResultText);
    onClose();
  };

  const fileName = filePath.split('/').pop() || filePath;

  return (
    <div
      className="modal-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="three-way-merge-container"
        style={{
          width: '94vw',
          height: '92vh',
          backgroundColor: 'var(--bg-editor, #141414)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.6)',
        }}
      >
        {/* ── 顶部二级操作栏 (严格对齐 Maven 规范: 高度 30px, padding: 0 10px) ── */}
        <div
          style={{
            height: 30,
            padding: '0 10px',
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-secondary, #181818)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.05em', color: 'var(--text)' }}>
              {t('merge.title')}
            </span>
            <span style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--bg-tertiary, #222)', padding: '1px 6px', borderRadius: 4 }}>
              {fileName}
            </span>
            <span
              style={{
                fontSize: 11,
                padding: '1px 6px',
                borderRadius: 4,
                background: resolvedCount === totalCount ? 'rgba(52, 211, 153, 0.2)' : 'rgba(245, 158, 11, 0.2)',
                color: resolvedCount === totalCount ? '#34d399' : '#f59e0b',
                fontWeight: 600,
              }}
            >
              {t('merge.resolvedCount', { done: resolvedCount, total: totalCount })}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              className="panel-action-btn"
              title={t('merge.acceptAllCurrentTitle')}
              onClick={() => handleBatchResolve('current')}
            >
              <span style={{ fontSize: 11 }}>{t('merge.acceptAllCurrent')}</span>
            </button>
            <button
              type="button"
              className="panel-action-btn"
              title={t('merge.acceptAllIncomingTitle')}
              onClick={() => handleBatchResolve('incoming')}
            >
              <span style={{ fontSize: 11 }}>{t('merge.acceptAllIncoming')}</span>
            </button>
            <button
              type="button"
              className="panel-action-btn"
              title={t('merge.keepBothTitle')}
              onClick={() => handleBatchResolve('both')}
            >
              <span style={{ fontSize: 11 }}>{t('merge.keepBoth')}</span>
            </button>
            <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }} />
            <button
              type="button"
              className="panel-action-btn"
              title={t('merge.prevConflict')}
              disabled={activeBlockIndex <= 0}
              onClick={() => setActiveBlockIndex((i) => Math.max(0, i - 1))}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="18 15 12 9 6 15" />
              </svg>
            </button>
            <button
              type="button"
              className="panel-action-btn"
              title={t('merge.nextConflict')}
              disabled={activeBlockIndex >= blocks.length - 1}
              onClick={() => setActiveBlockIndex((i) => Math.min(blocks.length - 1, i + 1))}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            <button
              type="button"
              className="panel-action-btn"
              title={t('merge.closeTitle')}
              onClick={onClose}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* ── 上半区：Current (当前) | Base (基础) | Incoming (传入) 三栏对比 ── */}
        <div style={{ flex: 1, display: 'flex', borderBottom: '1px solid var(--border)', overflow: 'hidden' }}>
          {/* 左栏：Current / Ours */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', overflow: 'hidden' }}>
            <div
              style={{
                height: 28,
                padding: '0 8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: 'rgba(59, 130, 246, 0.1)',
                borderBottom: '1px solid var(--border)',
                fontSize: 11,
                color: '#60a5fa',
                fontWeight: 600,
              }}
            >
              <span>{t('merge.currentBranch')}</span>
              {currentBlock && (
                <button
                  type="button"
                  className="panel-action-btn"
                  title={t('merge.acceptThisSideTitle')}
                  onClick={() => handleResolve(currentBlock.id, 'current')}
                  style={{ color: '#60a5fa' }}
                >
                  <span>{t('merge.acceptThisSide')}</span>
                </button>
              )}
            </div>
            <div style={{ flex: 1, position: 'relative' }}>
              <Editor
                value={currentBlock?.currentText || t('merge.noCurrentText')}
                language="plaintext"
                theme={theme}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  fontSize: 12,
                  automaticLayout: true,
                }}
              />
            </div>
          </div>

          {/* 中栏：Base (共同基底) */}
          <div style={{ flex: 0.9, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', overflow: 'hidden' }}>
            <div
              style={{
                height: 28,
                padding: '0 8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: 'rgba(107, 114, 128, 0.1)',
                borderBottom: '1px solid var(--border)',
                fontSize: 11,
                color: '#9ca3af',
                fontWeight: 600,
              }}
            >
              <span>{t('merge.baseBranch')}</span>
              {currentBlock && currentBlock.hasBase && (
                <button
                  type="button"
                  className="panel-action-btn"
                  title={t('merge.acceptBaseTitle')}
                  onClick={() => handleResolve(currentBlock.id, 'base')}
                  style={{ color: '#9ca3af' }}
                >
                  <span>{t('merge.acceptBase')}</span>
                </button>
              )}
            </div>
            <div style={{ flex: 1, position: 'relative' }}>
              <Editor
                value={currentBlock?.baseText || t('merge.noBaseText')}
                language="plaintext"
                theme={theme}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  fontSize: 12,
                  automaticLayout: true,
                }}
              />
            </div>
          </div>

          {/* 右栏：Incoming / Theirs */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div
              style={{
                height: 28,
                padding: '0 8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: 'rgba(16, 185, 129, 0.1)',
                borderBottom: '1px solid var(--border)',
                fontSize: 11,
                color: '#34d399',
                fontWeight: 600,
              }}
            >
              <span>{t('merge.incomingBranch')}</span>
              {currentBlock && (
                <button
                  type="button"
                  className="panel-action-btn"
                  title={t('merge.acceptThisSideTitle')}
                  onClick={() => handleResolve(currentBlock.id, 'incoming')}
                  style={{ color: '#34d399' }}
                >
                  <span>{t('merge.acceptThisSide')}</span>
                </button>
              )}
            </div>
            <div style={{ flex: 1, position: 'relative' }}>
              <Editor
                value={currentBlock?.incomingText || t('merge.noIncomingText')}
                language="plaintext"
                theme={theme}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  fontSize: 12,
                  automaticLayout: true,
                }}
              />
            </div>
          </div>
        </div>

        {/* ── 下半区：最终合并结果 (Result Editor) ── */}
        <div style={{ flex: 1.1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div
            style={{
              height: 28,
              padding: '0 10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: 'var(--bg-secondary, #181818)',
              borderBottom: '1px solid var(--border)',
              fontSize: 11,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontWeight: 700, color: 'var(--text)' }}>{t('merge.resultTitle')}</span>
              <span style={{ color: 'var(--muted)', fontSize: 10 }}>{t('merge.resultHint')}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {currentBlock && (
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {t('merge.currentChoice', { index: activeBlockIndex + 1, total: totalCount })}
                  <strong style={{ color: resolutions[currentBlock.id] ? '#34d399' : '#f59e0b', marginLeft: 4 }}>
                    {resolutions[currentBlock.id] === 'current'
                      ? t('merge.choiceCurrent')
                      : resolutions[currentBlock.id] === 'incoming'
                      ? t('merge.choiceIncoming')
                      : resolutions[currentBlock.id] === 'both'
                      ? t('merge.choiceBoth')
                      : resolutions[currentBlock.id] === 'base'
                      ? t('merge.choiceBase')
                      : t('merge.choiceUnresolved')}
                  </strong>
                </span>
              )}
            </div>
          </div>
          <div style={{ flex: 1, position: 'relative' }}>
            <Editor
              value={finalResultText}
              onChange={(val) => setCustomResultText(val ?? '')}
              theme={theme}
              options={{
                minimap: { enabled: true },
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                fontSize: 12,
                automaticLayout: true,
              }}
            />
          </div>
        </div>

        {/* ── 底部操作按钮 ── */}
        <div
          style={{
            height: 40,
            padding: '0 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-secondary, #181818)',
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            {resolvedCount < totalCount
              ? t('merge.pendingNote', { n: totalCount - resolvedCount })
              : t('merge.allResolved')}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              style={{ padding: '4px 12px', fontSize: 12 }}
            >
              {t('merge.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSave}
              style={{ padding: '4px 16px', fontSize: 12, background: 'var(--accent, #6366f1)', color: '#fff', fontWeight: 600 }}
            >
              {t('merge.saveAndFinish')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
