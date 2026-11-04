import React, { useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { countLineChanges } from '../services/textDiff';
import {
  planExternalChangeActions,
  type PendingExternalChange,
} from '../services/externalFileChanges';

export interface PendingChangesBarProps {
  changes: PendingExternalChange[];
  onAccept: (change: PendingExternalChange) => void;
  onReject: (change: PendingExternalChange) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  /** 点一行 → 打开这个文件（用户想先看看改了什么再决定）。 */
  onOpenFile?: (path: string, abs: string) => void;
  /** 外层容器是浮层时用的额外类名（`.pending-changes-bar--floating`）。 */
  className?: string;
}

/** 一行文件摊开后的展示数据。 */
interface Row {
  change: PendingExternalChange;
  additions: number | null;
  deletions: number | null;
  canReject: boolean;
  acceptLosesEdits: boolean;
  acceptLabelKey: string;
}

/**
 * 「代理改了磁盘上的文件，你打算怎么办」那一栏 —— 和 Cursor 一样贴在聊天输入框上方。
 *
 * 为什么不是一个只读提示：代理改盘之后编辑器里那一份和磁盘上那一份就分叉了，用户得
 * 挑一份。给一行文件名、加删行数，再给「接受 / 拒绝」两个出口，用户才真的有的选。
 *
 * 为什么行数可能是空的：`+N -M` 要拿「改动前」和「改动后」两份内容去比，而代理是
 * **别的进程**写的盘 —— 我们从没读过、没存过的文件就没有那份「改动前」。这时宁可不显示
 * 数字（也不显示一份按「整个文件都是新加的」算出来的假数字），行上会写明原因。
 */
export const PendingChangesBar: React.FC<PendingChangesBarProps> = ({
  changes,
  onAccept,
  onReject,
  onAcceptAll,
  onRejectAll,
  onOpenFile,
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

        if (change.fresh !== null && change.before !== undefined) {
          const counts = countLineChanges(change.before, change.fresh);
          additions = counts.additions;
          deletions = counts.deletions;
        } else if (change.fresh === null && change.before !== undefined) {
          // 文件被删了：整份内容的行数就是「删掉的多少行」
          deletions = countLineChanges(change.before, '').deletions;
        }

        return {
          change,
          additions,
          deletions,
          canReject: actions.canReject,
          acceptLosesEdits: actions.acceptLosesEdits,
          acceptLabelKey:
            actions.accept === 'dismiss'
              ? 'app.extChangeDismiss'
              : actions.accept === 'close'
                ? 'app.extChangeClose'
                : 'app.extChangeAccept',
        };
      }),
    [changes],
  );

  if (rows.length === 0) return null;
  const rejectable = rows.filter((row) => row.canReject).length;

  return (
    <div className={`pending-changes-bar${className ? ` ${className}` : ''}`}>
      {/* 列表本身限高并滚动：代理一次动手可能是几十个文件，不能让输入框被挤出去 */}
      <div className="pending-changes-list" data-collapsed={collapsed ? 'true' : 'false'}>
        {rows.map((row) => (
          <div
            key={row.change.abs}
            className="pending-change-row"
            role="button"
            tabIndex={0}
            title={row.change.path}
            onClick={() => onOpenFile?.(row.change.path, row.change.abs)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onOpenFile?.(row.change.path, row.change.abs);
            }}
          >
            <span className="pending-change-icon" aria-hidden="true">
              <span className="pending-change-icon-dot" />
            </span>

            <span className="pending-change-stats">
              {row.additions !== null && (row.additions > 0 || row.deletions === null) && (
                <span className="add">+{row.additions}</span>
              )}
              {row.deletions !== null && (row.deletions > 0 || row.additions === null) && (
                <span className="del">-{row.deletions}</span>
              )}
            </span>

            <span className="pending-change-name">{row.change.name}</span>
            <span className="pending-change-path">{row.change.path}</span>

            {/* 行内的「接受 / 拒绝」平时收起来：整栏要像 Cursor 那样干净。
                悬停或键盘聚焦时露出来 —— 多文件时用户往往只想处理其中一两个。 */}
            <span className="pending-change-row-actions">
              <button
                type="button"
                className="pending-row-btn accept"
                onClick={(e) => {
                  e.stopPropagation();
                  onAccept(row.change);
                }}
                title={row.acceptLosesEdits ? t('app.extChangeLosesEdits') : t(row.acceptLabelKey)}
              >
                {t(row.acceptLabelKey)}
              </button>
              <button
                type="button"
                className="pending-row-btn reject"
                disabled={!row.canReject}
                onClick={(e) => {
                  e.stopPropagation();
                  onReject(row.change);
                }}
                title={row.canReject ? t('app.extChangeReject') : t('app.extChangeNoBefore')}
              >
                {t('app.extChangeReject')}
              </button>
            </span>

            {row.change.fresh === null ? (
              <span className="pending-change-note">{t('app.extChangeDeleted')}</span>
            ) : row.acceptLosesEdits ? (
              <span className="pending-change-note warn">{t('app.extChangeLosesEdits')}</span>
            ) : !row.canReject ? (
              <span className="pending-change-note">{t('app.extChangeNoBefore')}</span>
            ) : null}
          </div>
        ))}
      </div>

      <div className="pending-changes-footer">
        <button
          type="button"
          className="pending-changes-summary"
          onClick={() => setCollapsed((prev) => !prev)}
          title={collapsed ? t('app.extChangeExpand') : t('app.extChangeCollapse')}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span>{t('app.extChangeFilesCount', { count: rows.length })}</span>
          <svg
            className="pending-changes-chevron"
            data-collapsed={collapsed ? 'true' : 'false'}
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </button>

        <div className="pending-changes-actions">
          <button
            type="button"
            className="pending-changes-btn reject-all"
            disabled={rejectable === 0}
            onClick={onRejectAll}
            title={rejectable === 0 ? t('app.extChangeNoBefore') : t('app.extChangeRejectAll')}
          >
            {t('app.extChangeRejectAll')}
          </button>
          <button type="button" className="pending-changes-btn accept-all" onClick={onAcceptAll}>
            {t('app.extChangeAcceptAll')}
          </button>
        </div>
      </div>
    </div>
  );
};
