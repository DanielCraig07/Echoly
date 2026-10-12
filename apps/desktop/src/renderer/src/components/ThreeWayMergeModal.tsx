import React, { useState, useMemo, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import { parseConflictBlocks, type ConflictBlock } from '../services/mergeConflictResolver';

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
              三方合并编辑器 (3-Way Merge)
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
              {resolvedCount}/{totalCount} 冲突已解决
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              className="panel-action-btn"
              title="全部采纳当前分支修改 (Accept All Current)"
              onClick={() => handleBatchResolve('current')}
            >
              <span style={{ fontSize: 11 }}>全部采纳当前</span>
            </button>
            <button
              type="button"
              className="panel-action-btn"
              title="全部采纳传入分支修改 (Accept All Incoming)"
              onClick={() => handleBatchResolve('incoming')}
            >
              <span style={{ fontSize: 11 }}>全部采纳传入</span>
            </button>
            <button
              type="button"
              className="panel-action-btn"
              title="全部保留双方修改"
              onClick={() => handleBatchResolve('both')}
            >
              <span style={{ fontSize: 11 }}>保留双方</span>
            </button>
            <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }} />
            <button
              type="button"
              className="panel-action-btn"
              title="上一处冲突"
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
              title="下一处冲突"
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
              title="关闭三方合并视图"
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
              <span>当前分支 (Current / Ours - HEAD)</span>
              {currentBlock && (
                <button
                  type="button"
                  className="panel-action-btn"
                  title="为当前冲突采纳此侧"
                  onClick={() => handleResolve(currentBlock.id, 'current')}
                  style={{ color: '#60a5fa' }}
                >
                  <span>✓ 采纳此侧</span>
                </button>
              )}
            </div>
            <div style={{ flex: 1, position: 'relative' }}>
              <Editor
                value={currentBlock?.currentText || '// 当前冲突块无内容'}
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
              <span>基底版本 (Base / Common Ancestor)</span>
              {currentBlock && currentBlock.hasBase && (
                <button
                  type="button"
                  className="panel-action-btn"
                  title="为当前冲突采纳基底"
                  onClick={() => handleResolve(currentBlock.id, 'base')}
                  style={{ color: '#9ca3af' }}
                >
                  <span>✓ 采纳基底</span>
                </button>
              )}
            </div>
            <div style={{ flex: 1, position: 'relative' }}>
              <Editor
                value={currentBlock?.baseText || '// 共同祖先基底无文本差异或未启用 diff3'}
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
              <span>传入分支 (Incoming / Theirs)</span>
              {currentBlock && (
                <button
                  type="button"
                  className="panel-action-btn"
                  title="为当前冲突采纳此侧"
                  onClick={() => handleResolve(currentBlock.id, 'incoming')}
                  style={{ color: '#34d399' }}
                >
                  <span>✓ 采纳此侧</span>
                </button>
              )}
            </div>
            <div style={{ flex: 1, position: 'relative' }}>
              <Editor
                value={currentBlock?.incomingText || '// 传入冲突块无内容'}
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
              <span style={{ fontWeight: 700, color: 'var(--text)' }}>最终合并结果 (Result)</span>
              <span style={{ color: 'var(--muted)', fontSize: 10 }}>可直接在此编辑器中二次手动微调</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {currentBlock && (
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  当前冲突 [{activeBlockIndex + 1}/{totalCount}] 抉择：
                  <strong style={{ color: resolutions[currentBlock.id] ? '#34d399' : '#f59e0b', marginLeft: 4 }}>
                    {resolutions[currentBlock.id] === 'current'
                      ? '已选当前'
                      : resolutions[currentBlock.id] === 'incoming'
                      ? '已选传入'
                      : resolutions[currentBlock.id] === 'both'
                      ? '保留双方'
                      : resolutions[currentBlock.id] === 'base'
                      ? '已选基底'
                      : '未抉择'}
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
              ? `⚠️ 尚有 ${totalCount - resolvedCount} 处冲突未做选择，未选择处将保留原有冲突标记`
              : '✓ 所有冲突已全部完成抉择，可以安全写回文件'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              style={{ padding: '4px 12px', fontSize: 12 }}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSave}
              style={{ padding: '4px 16px', fontSize: 12, background: 'var(--accent, #6366f1)', color: '#fff', fontWeight: 600 }}
            >
              完成合并并保存文件
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
