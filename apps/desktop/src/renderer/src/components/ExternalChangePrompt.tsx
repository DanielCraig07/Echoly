import React from 'react';
import { useI18n } from '../i18n';
import {
  planExternalChangeActions,
  type PendingExternalChange,
} from '../services/externalFileChanges';

interface Props {
  changes: PendingExternalChange[];
  onAccept: (change: PendingExternalChange) => void;
  onReject: (change: PendingExternalChange) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
}

/**
 * 「代理改了磁盘上的文件，你打算怎么办」的待办卡片。
 *
 * 为什么不是一个只读 toast：代理改盘之后编辑器里那一份和磁盘上那一份就分叉了，
 * 用户得决定跟哪一份。「接受」= 用磁盘上的版本，「拒绝」= 还原到改动前 —— 没有这两个
 * 按钮，用户除了自己再手动改回去，没有别的出路。
 *
 * 只在一部分情况下给「拒绝」：没记到「改动前」的内容时（比如代理改的是一个我们
 * 从没读过、没存过的文件）就还原不了，这时候按钮要禁用并且**说清楚为什么**，
 * 而不是点了没反应。
 */
export const ExternalChangePrompt: React.FC<Props> = ({
  changes,
  onAccept,
  onReject,
  onAcceptAll,
  onRejectAll,
}) => {
  const { t } = useI18n();
  if (changes.length === 0) return null;

  const rejectable = changes.filter((change) => planExternalChangeActions(change).canReject);

  return (
    <div
      style={{
        // 外层 toast 容器是 `pointer-events: none`（它本身不该挡住点击），
        // 这里的按钮要能点，所以自己把指针事件打开。
        pointerEvents: 'auto',
        background: 'var(--bg-elevated, #1c1c1f)',
        border: '1px solid rgba(59, 130, 246, 0.45)',
        borderRadius: 10,
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
        padding: '10px 12px',
        width: 'min(420px, calc(100vw - 32px))',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 13, color: '#60a5fa' }}>◆</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg, #e5e5e5)' }}>
            {t('app.extChangeTitle', { count: changes.length })}
          </span>
        </div>
        {changes.length > 1 && (
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button type="button" onClick={onAcceptAll} style={smallButton('accept')}>
              {t('app.extChangeAcceptAll')}
            </button>
            <button
              type="button"
              disabled={rejectable.length === 0}
              onClick={onRejectAll}
              style={smallButton('reject', rejectable.length === 0)}
            >
              {t('app.extChangeRejectAll')}
            </button>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {changes.map((change) => {
          const actions = planExternalChangeActions(change);
          // 「接受」不是每一条都叫得上「接受」：文件没开着就是「知道了」，
          // 被删了就是「关闭标签」—— 按钮上的字得对得上它真正要做的事。
          const acceptLabel =
            actions.accept === 'dismiss'
              ? t('app.extChangeDismiss')
              : actions.accept === 'close'
                ? t('app.extChangeClose')
                : t('app.extChangeAccept');
          return (
            <div
              key={change.abs}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                background: 'rgba(255, 255, 255, 0.03)',
                borderRadius: 8,
                padding: '6px 8px',
              }}
            >
              <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span
                  title={change.path}
                  style={{
                    fontSize: 12.5,
                    color: 'var(--fg, #e5e5e5)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {change.name}
                </span>
                {change.fresh === null ? (
                  <span style={hintStyle}>{t('app.extChangeDeleted')}</span>
                ) : actions.acceptLosesEdits ? (
                  <span style={{ ...hintStyle, color: '#f59e0b' }}>
                    {t('app.extChangeLosesEdits')}
                  </span>
                ) : !actions.canReject ? (
                  <span style={hintStyle}>{t('app.extChangeNoBefore')}</span>
                ) : null}
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={() => onAccept(change)}
                  style={smallButton('accept')}
                >
                  {acceptLabel}
                </button>
                <button
                  type="button"
                  disabled={!actions.canReject}
                  title={actions.canReject ? undefined : t('app.extChangeNoBefore')}
                  onClick={() => onReject(change)}
                  style={smallButton('reject', !actions.canReject)}
                >
                  {t('app.extChangeReject')}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const hintStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--muted, #a1a1aa)',
};

function smallButton(kind: 'accept' | 'reject', disabled = false): React.CSSProperties {
  const accent = kind === 'accept' ? '#3b82f6' : '#71717a';
  return {
    fontSize: 11.5,
    lineHeight: '18px',
    padding: '2px 10px',
    borderRadius: 6,
    border: `1px solid ${accent}`,
    background: kind === 'accept' ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
    color: disabled
      ? 'var(--muted, #71717a)'
      : accent === '#71717a'
        ? 'var(--fg, #e5e5e5)'
        : accent,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    whiteSpace: 'nowrap',
  };
}
