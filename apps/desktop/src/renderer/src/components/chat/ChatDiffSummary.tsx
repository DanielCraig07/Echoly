import React, { useState } from 'react';
import type { PendingDiff } from '@deepseek-ide/shared';
import { useI18n } from '../../i18n';
import { PanelChevron } from '../PanelChevron';
import { computeLineDiffStats } from '../../services/diffStats';
import { groupDiffsByBatch, type ReviewBatch } from '../../services/reviewGrouping';

export interface ChatDiffSummaryProps {
  diffs: PendingDiff[];
  /** 接受某一轮的这些改动（id 已按轮次收好） */
  onAccept: (ids: string[]) => void;
  onReject: (ids: string[]) => void;
  /** 点某个文件 → 在编辑区并排看差异 */
  onSelect: (id: string) => void;
  /** 打开完整的审阅面板（逐处展开、J/K 键盘流） */
  onOpenReview?: () => void;
}

/**
 * 输入框上方的「本轮改动的文件」。
 *
 * **按 Agent 轮次分组**，每轮各自「全部接受 / 全部拒绝」。以前这里只有一个
 * 跨轮次的「全部接受」：连问两轮之后，按钮看起来只是「接受这一批」，
 * 实际会把上一轮还留在列表里的改动一起落盘 —— 而用户在按下之前根本分不清
 * 哪些属于哪一轮。分组之后每个按钮的作用范围就是它自己那一组，标题写在第几轮上。
 *
 * 同一文件在一轮里被改多次时只列一行：`groupDiffsByFile` 负责聚合，
 * 行上先点开的是最后一次改动（`original` → 最终的 `modified`），
 * 那才是「这个文件现在长什么样」。
 */
const BatchSection: React.FC<{
  batch: ReviewBatch;
  diffs: PendingDiff[];
  onAccept: (ids: string[]) => void;
  onReject: (ids: string[]) => void;
  onSelect: (id: string) => void;
}> = ({ batch, diffs, onAccept, onReject, onSelect }) => {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);

  const label =
    batch.label === 'latest'
      ? t('chat.diffBatchLatest')
      : batch.label === 'previous'
        ? t('chat.diffBatchPrevious')
        : t('chat.diffBatchOlder');

  return (
    <div className="chat-diff-batch">
      <div className="chat-diff-batch-header">
        <div
          className="chat-diff-action-left"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? t('chat.diffExpandList') : t('chat.diffCollapseList')}
        >
          <PanelChevron expanded={!collapsed} size={11} color="var(--muted)" />
          <span className="batch-label">{label}</span>
          <span className="count-text">
            {t('chat.diffBatchSummary', {
              n: batch.groups.length,
              m: batch.diffIds.length,
            })}
          </span>
        </div>
        <div className="chat-diff-action-right">
          <button
            type="button"
            className="btn-reject-all"
            onClick={() => onReject(batch.diffIds)}
            title={t('chat.diffRejectAll')}
          >
            {t('chat.diffRejectAll')}
          </button>
          <button
            type="button"
            className="btn-accept-all"
            onClick={() => onAccept(batch.diffIds)}
            title={t('chat.diffAcceptAll')}
          >
            {t('chat.diffAcceptAll')}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="chat-diff-file-list">
          {batch.groups.map((group) => {
            // 聚合后的一行代表「这个文件在这一轮里的最终形态」：
            // 首条提供改动前内容，末条提供最终内容，中间那些是模型自己迭代的过程。
            const first = diffs.find((d) => d.id === group.diffIds[0]);
            const last = diffs.find((d) => d.id === group.diffIds[group.diffIds.length - 1]);
            const { added, deleted } = computeLineDiffStats(
              first?.original ?? '',
              last?.modified ?? '',
            );
            const fileName = group.path.split('/').filter(Boolean).pop() || group.path;

            return (
              <div
                key={group.path}
                className="chat-diff-file-item"
                role="button"
                tabIndex={0}
                onClick={() => onSelect(group.diffIds[group.diffIds.length - 1])}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ')
                    onSelect(group.diffIds[group.diffIds.length - 1]);
                }}
                title={t('chat.diffViewTip', { path: group.path })}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  style={{ color: 'var(--warn)', flexShrink: 0 }}
                  aria-hidden="true"
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
                <span className="diff-filepath">{group.path}</span>
                {group.diffIds.length > 1 && (
                  <span className="diff-filecount">×{group.diffIds.length}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export function ChatDiffSummary({
  diffs,
  onAccept,
  onReject,
  onSelect,
  onOpenReview,
}: ChatDiffSummaryProps) {
  const { t } = useI18n();
  // 批次序已经是「最新在前」，直接用。
  const batches = groupDiffsByBatch(diffs);
  if (batches.length === 0) return null;

  return (
    <div className="chat-diff-summary-container">
      <div className="chat-diff-batches">
        {batches.map((batch) => (
          <BatchSection
            key={batch.runId ?? 'legacy'}
            batch={batch}
            diffs={diffs}
            onAccept={onAccept}
            onReject={onReject}
            onSelect={onSelect}
          />
        ))}
      </div>
      {onOpenReview && (
        <div className="chat-diff-action-bar">
          <button type="button" className="chat-diff-review-btn" onClick={onOpenReview}>
            {t('chat.diffReviewTip')}
          </button>
        </div>
      )}
    </div>
  );
}
