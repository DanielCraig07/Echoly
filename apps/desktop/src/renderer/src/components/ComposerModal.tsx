import React, { useState, useEffect, useRef } from 'react';
import type { ModelProfile } from '@deepseek-ide/shared';
import { useModalResize, ModalResizeHandle } from '../hooks/useModalResize';

interface Props {
  open: boolean;
  onClose: () => void;
  workspaceRoot?: string | null;
  openFiles?: Array<{ path: string; content?: string }>;
  models?: ModelProfile[];
  activeModelId?: string;
  onOpenFile?: (path: string, line?: number) => void;
}

interface ComposerFileDiff {
  id: string;
  path: string;
  original: string;
  modified: string;
  status: 'pending' | 'accepted' | 'rejected';
}

export function ComposerModal({
  open,
  onClose,
  workspaceRoot,
  openFiles = [],
  models = [],
  activeModelId,
  onOpenFile,
}: Props) {
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_composer_modal_size',
    defaultWidth: 680,
    defaultHeight: 620,
    minWidth: 500,
    minHeight: 400,
  });

  const [prompt, setPrompt] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string>('');
  const [fileDiffs, setFileDiffs] = useState<ComposerFileDiff[]>([]);
  const [expandedDiffs, setExpandedDiffs] = useState<Record<string, boolean>>({});
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [rulesActive, setRulesActive] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 加载 .echolyrules 状态
  useEffect(() => {
    if (!open) return;
    void window.ide.rulesGet(workspaceRoot || undefined).then((res) => {
      setRulesActive(!!res.content);
    });
  }, [open, workspaceRoot]);

  // 聚焦输入框
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [open]);

  // 全局 Escape 关闭
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isRunning) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, isRunning, onClose]);

  // 监听 Agent 事件中的 pending_diff
  useEffect(() => {
    if (!open || !runId) return;

    const cleanup = (window as any).electron?.ipcRenderer?.on(
      'agent:event',
      (_e: any, evt: any) => {
        if (evt.runId !== runId) return;

        if (evt.type === 'status') {
          setStatusText(evt.status === 'tool_running' ? '正在执行跨模块文件变更...' : '思考与规划中...');
        } else if (evt.type === 'pending_diff' && evt.diff) {
          const d = evt.diff;
          setFileDiffs((prev) => {
            const exists = prev.find((item) => item.id === d.id);
            if (exists) return prev;
            return [
              ...prev,
              {
                id: d.id,
                path: d.path,
                original: d.original,
                modified: d.modified,
                status: 'pending',
              },
            ];
          });
          setExpandedDiffs((prev) => ({ ...prev, [d.id]: true }));
        } else if (evt.type === 'final' || evt.type === 'completed' || evt.type === 'cancelled') {
          setIsRunning(false);
          setStatusText('');
        }
      },
    );

    return () => {
      cleanup?.();
    };
  }, [open, runId]);

  const handleStartComposer = async () => {
    if (!prompt.trim() || isRunning) return;
    setIsRunning(true);
    setStatusText('正在初始化 Composer 跨文件重构任务...');
    setFileDiffs([]);

    try {
      const res = await window.ide.startAgent({
        prompt: `【Composer 跨文件重构任务】\n${prompt.trim()}`,
        mode: 'agent',
        modelId: activeModelId,
      });
      setRunId(res.runId);
    } catch (err) {
      console.error('[Composer] Start failed:', err);
      setIsRunning(false);
      setStatusText('启动失败，请检查网络或配置');
    }
  };

  const handleAcceptSingle = async (diffId: string) => {
    await window.ide.acceptDiff(diffId);
    setFileDiffs((prev) =>
      prev.map((d) => (d.id === diffId ? { ...d, status: 'accepted' } : d)),
    );
  };

  const handleRejectSingle = async (diffId: string) => {
    await window.ide.rejectDiff(diffId);
    setFileDiffs((prev) =>
      prev.map((d) => (d.id === diffId ? { ...d, status: 'rejected' } : d)),
    );
  };

  const handleAcceptAll = async () => {
    await window.ide.acceptAllDiffs();
    setFileDiffs((prev) => prev.map((d) => ({ ...d, status: 'accepted' })));
    onClose();
  };

  const handleRejectAll = async () => {
    for (const d of fileDiffs) {
      if (d.status === 'pending') {
        await window.ide.rejectDiff(d.id);
      }
    }
    setFileDiffs((prev) => prev.map((d) => ({ ...d, status: 'rejected' })));
  };

  if (!open) return null;

  const pendingCount = fileDiffs.filter((d) => d.status === 'pending').length;

  return (
    <div
      className="settings-overlay composer-overlay"
      onClick={onClose}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.45)',
        backdropFilter: 'blur(6px)',
        zIndex: 9999,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingTop: '8vh',
      }}
    >
      <div
        className="composer-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: modalSize.width,
          height: modalSize.height,
          maxWidth: '96vw',
          maxHeight: '90vh',
          position: 'relative',
          background: 'var(--bg-modal, #141414)',
          border: '1px solid var(--border, rgba(255, 255, 255, 0.12))',
          borderRadius: 12,
          boxShadow: '0 24px 64px -8px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(255, 255, 255, 0.08)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'scaleIn 0.15s ease-out',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))',
            background: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 22,
                height: 22,
                borderRadius: 6,
                background: 'linear-gradient(135deg, #a78bfa, #38bdf8)',
                color: '#fff',
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              ✦
            </span>
            <span style={{ fontSize: 13.5, fontWeight: 650, color: 'var(--text, #fff)' }}>
              Composer 跨文件重构器
            </span>
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                color: '#38bdf8',
                background: 'rgba(56, 189, 248, 0.12)',
                border: '1px solid rgba(56, 189, 248, 0.25)',
                borderRadius: 4,
                padding: '1px 6px',
              }}
            >
              ⌘I
            </span>
            {rulesActive && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 500,
                  color: '#34d399',
                  background: 'rgba(16, 185, 129, 0.1)',
                  border: '1px solid rgba(16, 185, 129, 0.2)',
                  borderRadius: 4,
                  padding: '1px 6px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                }}
                title=".echolyrules 规范已注入当前任务"
              >
                ● .echolyrules
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="panel-action-btn"
              onClick={onClose}
              title="关闭 (Esc)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Input Area */}
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8, borderBottom: '1px solid var(--border, rgba(255,255,255,0.06))' }}>
          <textarea
            ref={inputRef}
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                handleStartComposer();
              }
            }}
            placeholder="描述您要执行的跨文件多模块修改，例如：将项目所有 API 请求重构成使用统一的 requestClient 拦截器，并补充完整 TypeScript 类型 (⌘↵ 发送)..."
            style={{
              width: '100%',
              background: 'rgba(0, 0, 0, 0.25)',
              border: '1px solid var(--border, rgba(255,255,255,0.1))',
              borderRadius: 8,
              padding: '10px 12px',
              color: 'var(--text, #fff)',
              fontSize: 12.5,
              lineHeight: 1.6,
              resize: 'none',
              outline: 'none',
              boxSizing: 'border-box',
              fontFamily: 'inherit',
            }}
          />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, color: 'var(--muted, #888)' }}>
              {statusText ? (
                <span style={{ color: 'var(--accent, #4c8dff)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span className="inline-ai-spinner" style={{ width: 10, height: 10 }} />
                  {statusText}
                </span>
              ) : (
                '快捷键：按 ⌘↵ 提交执行 | Esc 取消'
              )}
            </span>

            <button
              type="button"
              className="btn btn-primary"
              disabled={!prompt.trim() || isRunning}
              onClick={handleStartComposer}
              style={{
                padding: '5px 14px',
                fontSize: 12,
                borderRadius: 6,
                fontWeight: 500,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                cursor: !prompt.trim() || isRunning ? 'not-allowed' : 'pointer',
                opacity: !prompt.trim() || isRunning ? 0.6 : 1,
              }}
            >
              <span>{isRunning ? '重构中...' : '开始重构'}</span>
              <kbd style={{ fontSize: 10, opacity: 0.8 }}>⌘↵</kbd>
            </button>
          </div>
        </div>

        {/* Diff Results Waterfall */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {fileDiffs.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright, #fff)' }}>
                涉及变更文件 ({fileDiffs.length})
                {pendingCount > 0 && <span style={{ color: '#38bdf8', marginLeft: 6 }}>({pendingCount} 待审查)</span>}
              </span>

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={handleAcceptAll}
                  style={{
                    border: 'none',
                    background: 'rgba(16, 185, 129, 0.15)',
                    color: '#34d399',
                    fontSize: 11.5,
                    padding: '4px 10px',
                    borderRadius: 5,
                    cursor: 'pointer',
                    fontWeight: 600,
                  }}
                >
                  ✓ 全部采纳 (⌘↵)
                </button>
                <button
                  type="button"
                  onClick={handleRejectAll}
                  style={{
                    border: 'none',
                    background: 'rgba(239, 68, 68, 0.15)',
                    color: '#f87171',
                    fontSize: 11.5,
                    padding: '4px 10px',
                    borderRadius: 5,
                    cursor: 'pointer',
                  }}
                >
                  ✕ 全部放弃
                </button>
              </div>
            </div>
          )}

          {fileDiffs.length === 0 && !isRunning && (
            <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--muted, #888)', fontSize: 12 }}>
              在上方输入要重构的需求，Composer 将跨越多个文件生成差异对比卡片
            </div>
          )}

          {fileDiffs.map((diff) => {
            const isExpanded = expandedDiffs[diff.id] ?? true;
            return (
              <div
                key={diff.id}
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid var(--border, rgba(255, 255, 255, 0.08))',
                  borderRadius: 8,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    background: 'rgba(0, 0, 0, 0.15)',
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                  onClick={() => setExpandedDiffs((prev) => ({ ...prev, [diff.id]: !isExpanded }))}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--muted, #888)' }}>{isExpanded ? '▼' : '▶'}</span>
                    <span
                      style={{ fontSize: 12, fontFamily: 'var(--font-mono, monospace)', fontWeight: 550, color: 'var(--text-bright, #fff)' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenFile?.(diff.path);
                      }}
                      title="点击在编辑器中打开此文件"
                    >
                      {diff.path}
                    </span>
                    {diff.status === 'accepted' && (
                      <span style={{ fontSize: 10, color: '#34d399', background: 'rgba(16,185,129,0.15)', padding: '1px 5px', borderRadius: 4 }}>已采纳</span>
                    )}
                    {diff.status === 'rejected' && (
                      <span style={{ fontSize: 10, color: '#f87171', background: 'rgba(239,68,68,0.15)', padding: '1px 5px', borderRadius: 4 }}>已放弃</span>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                    {diff.status === 'pending' && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleAcceptSingle(diff.id)}
                          style={{
                            border: 'none',
                            background: 'rgba(16, 185, 129, 0.18)',
                            color: '#34d399',
                            fontSize: 11,
                            padding: '2px 8px',
                            borderRadius: 4,
                            cursor: 'pointer',
                          }}
                        >
                          采纳
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRejectSingle(diff.id)}
                          style={{
                            border: 'none',
                            background: 'rgba(239, 68, 68, 0.18)',
                            color: '#f87171',
                            fontSize: 11,
                            padding: '2px 8px',
                            borderRadius: 4,
                            cursor: 'pointer',
                          }}
                        >
                          放弃
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {isExpanded && (
                  <div
                    style={{
                      maxHeight: 240,
                      overflowY: 'auto',
                      padding: '8px 12px',
                      background: 'rgba(0, 0, 0, 0.35)',
                      fontFamily: 'var(--font-mono, monospace)',
                      fontSize: 11.5,
                      lineHeight: 1.5,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                    }}
                  >
                    <div style={{ color: '#34d399' }}>{diff.modified.slice(0, 1500)}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>
  );
}
