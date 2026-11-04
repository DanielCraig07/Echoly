import React, { useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { PanelChevron } from './PanelChevron';
import { computeLineDiffStats } from '../services/diffStats';
import {
  planExternalChangeActions,
  type PendingExternalChange,
} from '../services/externalFileChanges';

export interface PendingChangesBarProps {
  changes: PendingExternalChange[];
  onAcceptAll: () => void;
  onRejectAll: () => void;
  /** 点一行 → 在编辑区把那处改动**对着看**（和内置会话点文件名的行为一致）。 */
  onShowDiff?: (change: PendingExternalChange) => void;
  /** 面板整个收起来、只能浮在左下角时加的类名。 */
  className?: string;
}

/** 一行文件摊开后的展示数据。 */
interface Row {
  change: PendingExternalChange;
  additions: number | null;
  deletions: number | null;
  canReject: boolean;
  acceptLosesEdits: boolean;
}

/**
 * 「代理改了磁盘上的文件，你打算怎么办」那一栏。
 *
 * 长得**和内置会话里那块「本轮改动的文件」一模一样**：同一套 class
 * （`.chat-diff-summary-container` 那几个）、同一套文案 key（`chat.diff*`）、同一套
 * 数字口径（`computeLineDiffStats`）。两处说的是同一件事，而且经常同时出现（内置 Agent
 * 刚改完一批，Claude 又改了一批），长得不一样只会让人以为是两种东西。
 *
 * 交互也**刻意和那一块看齐**：行上没有按钮，点一行就在编辑区把「改动前 / 改动后」并排
 * 打开 —— 判断要不要接受，得先看见改了什么。批量的出口只有一个，在底部那行
 * （全部拒绝 / 全部接受），这样整栏既干净又不会误点。
 *
 * 为什么行数可能是空的：`+N -M` 要拿「改动前」和「改动后」两份内容去比，而代理是
 * **别的进程**写的盘 —— 我们从没读过、没存过的文件就没有那份「改动前」。这时宁可不显示
 * 数字（也不显示一份按「整个文件都是新加的」算出来的假数字），行上写明原因。
 */
export const PendingChangesBar: React.FC<PendingChangesBarProps> = ({
  changes,
  onAcceptAll,
  onRejectAll,
  onShowDiff,
  className,
}) => {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);

  const rows = useMemo<Row[]>(
    () =>
      changes.map((change) => {
        const actions = planExternalChangeActions(change);
        let additions: number | null = null;
        let deletions: number | null = null;

        if (change.before !== undefined) {
          // 只有拿到「改动前」才算数字：没有它就只知道「现在这么多行」，
          // 报成 `+N` 会让用户以为代理加了一整个文件的内容。
          const stats = computeLineDiffStats(change.before, change.fresh ?? '');
          // 两个都是 0（只剩空白字符之类的差异）时不显示 `+0 -0`：那个数字没有信息量
          if (stats.added !== 0 || stats.deleted !== 0) {
            additions = change.fresh === null ? null : stats.added;
            deletions = stats.deleted;
          }
        }

        return {
          change,
          additions,
          deletions,
          canReject: actions.canReject,
          acceptLosesEdits: actions.acceptLosesEdits,
        };
      }),
    [changes],
  );

  if (rows.length === 0) return null;
  const rejectable = rows.filter((row) => row.canReject).length;

  return (
    <div className={`chat-diff-summary-container${className ? ` ${className}` : ''}`}>
      {/* 列表本身限高并滚动（见 .chat-diff-file-list）：代理一次动手可能是几十个文件，
          不能让输入框被挤出去 */}
      {!collapsed && (
        <div className="chat-diff-file-list">
          {rows.map((row) => (
            <div
              key={row.change.abs}
              className="chat-diff-file-item"
              role="button"
              tabIndex={0}
              title={t('chat.diffViewTip', { path: row.change.path })}
              onClick={() => onShowDiff?.(row.change)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onShowDiff?.(row.change);
              }}
            >
              {/* 橙色小方块（带一个亮点）：和内置会话那块同一个「这个文件被改了」标记 */}
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
                {row.additions !== null && <span className="diff-add">+{row.additions}</span>}
                {row.deletions !== null && <span className="diff-del">-{row.deletions}</span>}
              </span>

              <span className="diff-filename">{row.change.name}</span>
              <span className="diff-filepath">{row.change.path}</span>

              {row.change.fresh === null ? (
                <span className="pending-change-note">{t('app.extChangeDeleted')}</span>
              ) : row.acceptLosesEdits ? (
                <span className="pending-change-note warn">{t('app.extChangeDirtyShort')}</span>
              ) : !row.canReject ? (
                <span className="pending-change-note">{t('app.extChangeNoBeforeShort')}</span>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <div className="chat-diff-action-bar">
        <div
          className="chat-diff-action-left"
          onClick={() => setCollapsed((prev) => !prev)}
          title={collapsed ? t('chat.diffExpandList') : t('chat.diffCollapseList')}
        >
          <PanelChevron expanded={!collapsed} size={11} color="var(--muted)" />
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ opacity: 0.7 }}
            aria-hidden="true"
          >
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span className="count-text">{t('chat.diffFilesWithChanges', { n: rows.length })}</span>
        </div>
        <div className="chat-diff-action-right">
          <button
            type="button"
            className="btn-reject-all"
            disabled={rejectable === 0}
            onClick={onRejectAll}
            title={rejectable === 0 ? t('app.extChangeNoBefore') : t('chat.diffRejectAll')}
          >
            {t('chat.diffRejectAll')}
          </button>
          <button type="button" className="btn-accept-all" onClick={onAcceptAll}>
            {t('chat.diffAcceptAll')}
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};
