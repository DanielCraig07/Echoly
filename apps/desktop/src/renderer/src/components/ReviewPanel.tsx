import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DiffEditor } from '@monaco-editor/react';
import type { PendingDiff } from '@deepseek-ide/shared';
import {
  useModalResize,
  ModalResizeHandle,
  createSafeOverlayHandlers,
} from '../hooks/useModalResize';
import { groupDiffsByBatch, moveReviewFocus } from '../services/reviewGrouping';
import { languageFromPath } from '../utils';

interface ReviewPanelProps {
  open: boolean;
  /** 本轮待审阅的改动 */
  diffs: PendingDiff[];
  onAccept: (id: string) => void | Promise<void>;
  onReject: (id: string) => void | Promise<void>;
  onClose: () => void;
}

/** 超过这个体积就不内嵌 diff 编辑器：Monaco 实例化 + 逐行 diff 会让面板卡住。 */
const MAX_PREVIEW_CHARS = 200_000;

/**
 * 单处改动的差异预览。
 *
 * 审阅时只看到一句「修改了 xxx」是不够的 —— 用户要么去编辑器里翻，要么只能盲信。
 * 这里内嵌一个只读 Monaco diff 视图，让「接受/拒绝」这个决定在面板内就能做完。
 *
 * 每次只渲染一个（由调用方的 `expandedId` 控制）：多个 diff 编辑器同屏时，
 * 光是模型实例化就能让面板明显变卡，而用户一次也只看一处。
 */
function DiffPreview({ diff }: { diff: PendingDiff }) {
  const tooLarge = (diff.original?.length ?? 0) + (diff.modified?.length ?? 0) > MAX_PREVIEW_CHARS;
  if (tooLarge) {
    return (
      <div
        style={{
          padding: '8px 10px',
          borderTop: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.05))',
          color: 'var(--muted, #888)',
          fontSize: 11,
        }}
      >
        内容过大（超过 {Math.round(MAX_PREVIEW_CHARS / 1000)}KB），不在面板内渲染差异 ——
        打开文件查看，或直接接受/拒绝。
      </div>
    );
  }

  return (
    <div
      style={{
        height: 280,
        borderTop: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.05))',
      }}
    >
      <DiffEditor
        original={diff.original ?? ''}
        modified={diff.modified ?? ''}
        language={languageFromPath(diff.path)}
        theme="vs-dark"
        options={{
          readOnly: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          renderSideBySide: true,
          lineNumbersMinChars: 4,
          lineDecorationsWidth: 10,
          wordWrap: 'off',
          renderOverviewRuler: false,
        }}
      />
    </div>
  );
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
export function ReviewPanel({ open, diffs, onAccept, onReject, onClose }: ReviewPanelProps) {
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_review_panel_size',
    defaultWidth: 720,
    defaultHeight: 560,
    minWidth: 460,
    minHeight: 320,
  });

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  /** 展开差异预览的那一处改动。同一时刻只展开一个 —— 多个 diff 编辑器同屏会明显拖慢面板。 */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** J/K 移动到的文件序号；-1 表示还没用键盘选过。 */
  const [focusedGroup, setFocusedGroup] = useState<number>(-1);

  /**
   * 键盘处理要用到的三样东西放 ref 里。
   *
   * 键位监听必须在早退之前注册（hook 顺序），而 `groups` / `runSequential`
   * 都在早退之后才算出来。用 ref 转一手，既保住 hook 顺序，也不会读到陈旧闭包 ——
   * 直接闭包捕获会让监听器一直用「第一次渲染时」的那份列表。
   */
  const allIdsRef = useRef<string[]>([]);
  const groupCountRef = useRef(0);
  const runSequentialRef = useRef<
    (ids: string[], action: (id: string) => void | Promise<void>) => void
  >(() => undefined);
  const busyRef = useRef(false);

  const batches = useMemo(() => groupDiffsByBatch(diffs), [diffs]);
  /** 焦点索引按「渲染顺序拉平」后编号，需要一张反查表把 (批次, 文件) 映射回归属序号。 */
  const focusIndexByKey = useMemo(() => {
    const map = new Map<string, number>();
    let index = 0;
    for (const batch of batches) {
      for (const group of batch.groups) {
        map.set(`${batch.runId ?? ''}::${group.path}`, index);
        index += 1;
      }
    }
    return map;
  }, [batches]);
  const groups = useMemo(() => batches.flatMap((batch) => batch.groups), [batches]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      // 审阅流的键盘动作：J/K 逐文件走，Cmd/Ctrl+Enter 一键全接受。
      // 带修饰键时不抢 J/K（那是别处的快捷键），输入框里也不抢。
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!busyRef.current) runSequentialRef.current(allIdsRef.current, onAccept);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toLowerCase();
      if (key !== 'j' && key !== 'k') return;
      e.preventDefault();
      setFocusedGroup((current) =>
        moveReviewFocus(current, key === 'j' ? 1 : -1, groupCountRef.current),
      );
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
  allIdsRef.current = allIds;
  groupCountRef.current = groups.length;
  runSequentialRef.current = runSequential;
  busyRef.current = busy;
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
          fontSize: 'var(--ui-font-size, 12px)',
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
            <span style={{ color: 'var(--muted, #888)', fontSize: 11 }}>
              J/K 切文件 · Cmd+Enter 全接受
            </span>
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
          {batches.length === 0 ? (
            <div style={{ color: 'var(--muted, #888)', padding: '18px 0' }}>
              本轮没有待审阅的改动。
            </div>
          ) : (
            batches.map((batch) => (
              <div key={batch.runId ?? 'legacy'} style={{ marginTop: 12 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    padding: '2px 2px 6px',
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: 11, color: 'var(--text, #ccc)' }}>
                    {batch.label === 'latest'
                      ? '本轮'
                      : batch.label === 'previous'
                        ? '上一轮'
                        : '更早的改动'}
                    <span style={{ color: 'var(--muted, #888)', fontWeight: 400 }}>
                      {' · '}
                      {batch.groups.length} 个文件 / {batch.diffIds.length} 处
                    </span>
                  </span>
                  <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      type="button"
                      className="panel-action-btn panel-action-btn--compact"
                      disabled={busy}
                      onClick={() => void runSequential(batch.diffIds, onAccept)}
                      title="接受这一轮的改动"
                    >
                      接受本轮
                    </button>
                    <button
                      type="button"
                      className="panel-action-btn panel-action-btn--compact"
                      disabled={busy}
                      onClick={() => void runSequential(batch.diffIds, onReject)}
                      title="拒绝这一轮的改动"
                    >
                      拒绝本轮
                    </button>
                  </span>
                </div>
                {batch.groups.map((group) => {
                  const groupIndex =
                    focusIndexByKey.get(`${batch.runId ?? ''}::${group.path}`) ?? -1;
                  return (
                    <div
                      key={group.path}
                      style={{
                        border:
                          groupIndex === focusedGroup
                            ? '1px solid var(--accent, #3794ff)'
                            : '1px solid var(--border, rgba(255, 255, 255, 0.08))',
                        background:
                          groupIndex === focusedGroup
                            ? 'color-mix(in srgb, var(--accent, #3794ff) 8%, transparent)'
                            : undefined,
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

                      {group.diffIds.map((id) => {
                        const diff = diffs.find((d) => d.id === id) ?? null;
                        return (
                          <React.Fragment key={id}>
                            <div
                              style={{
                                padding: '6px 10px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 8,
                                borderTop:
                                  '1px solid var(--border-subtle, rgba(255, 255, 255, 0.05))',
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
                                title={diff?.description ?? id}
                              >
                                {diff?.description ?? '（无说明）'}
                              </span>
                              <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                                <button
                                  type="button"
                                  className="panel-action-btn panel-action-btn--compact"
                                  onClick={() => setExpandedId((v) => (v === id ? null : id))}
                                  title="查看这一处的差异"
                                >
                                  {expandedId === id ? '▾' : '▸'}
                                </button>
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
                            {expandedId === id && diff && <DiffPreview diff={diff} />}
                          </React.Fragment>
                        );
                      })}
                    </div>
                  );
                })}
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
