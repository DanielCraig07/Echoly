import React, { useState } from 'react';
import type { CheckpointSummary } from '@deepseek-ide/shared';
import { TurnRevertModal } from './TurnRevertModal';
import { useI18n } from '../../i18n';

export interface TurnCheckpointBarProps {
  checkpoint: CheckpointSummary;
  onRevertTurn?: (revertedPaths: string[]) => Promise<void> | void;
  onOpenFile?: (path: string, line?: number) => void;
  onRefreshCheckpoints?: () => void;
}

export const TurnCheckpointBar: React.FC<TurnCheckpointBarProps> = ({
  checkpoint,
  onRevertTurn,
  onOpenFile,
  onRefreshCheckpoints,
}) => {
  const { t } = useI18n();
  const [modalOpen, setModalOpen] = useState(false);

  const handleRevertSuccess = async (revertedPaths: string[]) => {
    if (onRevertTurn) {
      await onRevertTurn(revertedPaths);
    }
    if (onRefreshCheckpoints) {
      onRefreshCheckpoints();
    }
  };

  return (
    <>
      <div className="chat-turn-checkpoint-card">
        <div className="checkpoint-card-left" onClick={() => setModalOpen(true)}>
          <div className="checkpoint-card-icon">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
              <polyline points="14 2 14 8 20 8" />
              <path d="M9 15l2 2 4-4" />
            </svg>
          </div>
          <div className="checkpoint-card-info">
            <span className="checkpoint-card-title">
              本轮修改了{' '}
              <strong className="count">{checkpoint.fileCount ?? checkpoint.mutations}</strong>{' '}
              个文件
              {checkpoint.mutations > (checkpoint.fileCount ?? checkpoint.mutations) && (
                <span className="checkpoint-card-subcount">
                  （共 {checkpoint.mutations} 次操作）
                </span>
              )}
            </span>
            {checkpoint.incomplete && (
              <span
                className="checkpoint-incomplete-tag"
                title={checkpoint.incompleteReason ?? '部分二进制或超大目录无法留底'}
              >
                ⚠️ 包含未留底操作
              </span>
            )}
          </div>
        </div>

        <div className="checkpoint-card-actions">
          <button
            type="button"
            className="checkpoint-action-btn btn-view-diff"
            title="查看具体修改了哪些文件与代码 Diff"
            onClick={() => setModalOpen(true)}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="18" cy="18" r="3" />
              <circle cx="6" cy="6" r="3" />
              <path d="M13 6h3a2 2 0 0 1 2 2v7" />
              <path d="M11 18H8a2 2 0 0 1-2-2V9" />
            </svg>
            <span>查看修改 Diff</span>
          </button>

          <button
            type="button"
            className="checkpoint-action-btn btn-revert-trigger"
            disabled={checkpoint.incomplete}
            title={
              checkpoint.incomplete
                ? t('chat.revertIncompleteTip', {
                    reason: checkpoint.incompleteReason ?? t('chat.unknownReason'),
                  })
                : t('chat.revertTurnTip', { n: checkpoint.mutations })
            }
            onClick={() => setModalOpen(true)}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
            </svg>
            <span>{t('chat.revertTurn')}</span>
          </button>
        </div>
      </div>

      {modalOpen && (
        <TurnRevertModal
          open={modalOpen}
          runId={checkpoint.runId}
          onClose={() => setModalOpen(false)}
          onRevertSuccess={handleRevertSuccess}
          onOpenFile={onOpenFile}
        />
      )}
    </>
  );
};
