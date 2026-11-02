import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PendingDiff } from '@deepseek-ide/shared';
import {
  useModalResize,
  ModalResizeHandle,
  createSafeOverlayHandlers,
} from '../hooks/useModalResize';
import { groupDiffsByFile } from '../services/reviewGrouping';

interface ReviewPanelProps {
  open: boolean;
  /** 本轮待审阅的改动 */
  diffs: PendingDiff[];
  onAccept: (id: string) => void | Promise<void>;
  onReject: (id: string) => void | Promise<void>;
  onAcceptAll: (ids: string[]) => void | Promise<void>;
  onRejectAll: (ids: string[]) => void | Promise<void>;
  onClose: () => void;
}

/**
 * 改动审阅面板。
 *
 * 之前审阅一轮 Agent 改动只能靠逐个弹出的 diff 模态框，改五个文件就要开关五次，
 * 而且看不出「这一轮总共动了多少」。这里把一轮改动聚到一个列表里按文件分组，
 * 支持整组接受/拒绝，也支持逐条处理。
 *
 * 聚合逻辑在 `services/reviewGrouping.ts`，这个组件只负责呈现与派发回调 ——
 * 数据层（diffStore 的 accept/reject/acceptAll）由调用方注入，组件不直接碰 IPC，
 * 这样它既能在应用里用，也能在测试里单独渲染。
 */
export function ReviewPanel({
  open,
  diffs,
  onAccept,
  onReject,
  onAcceptAll,
  onRejectAll,
  onClose,
}: ReviewPanelProps) {
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_review_panel_size',
    defaultWidth: 720,
    defaultHeight: 560,
    minWidth: 460,
    minHeight: 320,
  });

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const groups = useMemo(() => groupDiffsByFile(diffs), [diffs]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  /** 串行处理：并发写盘会让 diffStore 的撤销状态相互覆盖 */
  const runSequential = async (ids: string[], action: (id: string) => void | Promise<void>) => {
    if (busy || ids.length === 0) return;
    setBusy(true);
    setPendingId(ids[0] ?? null);
    try {
      for (const id of ids) {
        setPendingId(id);
        await action(id);
      }
    } finally {
      setBusy(false);
      setPendingId(null);
    }
  };

  const allIds = diffs.map((d) => d.id);
  const overlay = createSafeOverlayHandlers(onClose);

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--overlay, rgba(0, 0, 0, 0.65))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1200,
      }}
      {...overlay}
    >
      <div
        style={{
          width: modalSize.width,
          height: modalSize.height,
          background: 'var(--bg-modal, #141414)',
          border: '1px solid var(--border, rgba(255, 255, 255, 0.08))',
          borderRadius: 10,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontSize: 12,
          color: 'var(--text, #cccccc)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部：标题与整体操作 */}
        <div
          style={{
            height: 42,
            flexShrink: 0,
            padding: '0 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid var(--border, rgba(255, 255, 255, 0.08))',
          }}
        >
          <span style={{ fontWeight: 700, letterSpacing: '0.02em' }}>
            审阅本轮改动 · {groups.length} 个文件 / {diffs.length} 处
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="panel-standard-btn"
              disabled={busy || allIds.length === 0}
              onClick={() => void runSequential(allIds, onAccept)}
              title="接受本轮全部改动"
            >
              全部接受
            </button>
            <button
              type="button"
              className="panel-standard-btn"
              disabled={busy || allIds.length === 0}
              onClick={() => void runSequential(allIds, onReject)}
              title="拒绝本轮全部改动，写回改动前内容"
            >
              全部拒绝
            </button>
            <button
              type="button"
              className="panel-action-btn"
              onClick={onClose}
              title="关闭审阅面板（Esc）"
            >
              ✕
            </button>
          </div>
        </div>

        {/* 列表 */}
        <div style={{ flex: 1, overflow: 'auto', padding: '8px 14px 14px' }}>
          {groups.length === 0 ? (
            <div style={{ color: 'var(--muted, #888)', padding: '18px 0' }}>
              本轮没有待审阅的改动。
            </div>
          ) : (
            groups.map((group) => (
              <div
                key={group.path}
                style={{
                  border: '1px solid var(--border, rgba(255, 255, 255, 0.08))',
                  borderRadius: 8,
                  marginTop: 8,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    padding: '8px 10px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    background: 'var(--bg-elevated, #1e1e1e)',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={group.path}
                  >
                    {group.path}
                    {group.hasNewFile && (
                      <span style={{ color: 'var(--ok, #89d185)', marginLeft: 6 }}>新建</span>
                    )}
                  </span>
                  <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      type="button"
                      className="panel-action-btn"
                      disabled={busy}
                      onClick={() => void runSequential(group.diffIds, onAccept)}
                      title="接受该文件的全部改动"
                    >
                      ✓
                    </button>
                    <button
                      type="button"
                      className="panel-action-btn"
                      disabled={busy}
                      onClick={() => void runSequential(group.diffIds, onReject)}
                      title="拒绝该文件的全部改动"
                    >
                      ✕
                    </button>
                  </span>
                </div>

                {group.diffIds.map((id) => (
                  <div
                    key={id}
                    style={{
                      padding: '6px 10px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      borderTop: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.05))',
                      opacity: pendingId === id ? 0.5 : 1,
                    }}
                  >
                    <span
                      style={{
                        color: 'var(--muted, #888)',
                        fontSize: 11,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={diffs.find((d) => d.id === id)?.description ?? id}
                    >
                      {diffs.find((d) => d.id === id)?.description ?? '（无说明）'}
                    </span>
                    <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <button
                        type="button"
                        className="panel-action-btn panel-action-btn--compact"
                        disabled={busy}
                        onClick={() => void runSequential([id], onAccept)}
                        title="接受这一处改动"
                      >
                        ✓
                      </button>
                      <button
                        type="button"
                        className="panel-action-btn panel-action-btn--compact"
                        disabled={busy}
                        onClick={() => void runSequential([id], onReject)}
                        title="拒绝这一处改动"
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>

        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>,
    document.body,
  );
}
