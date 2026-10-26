import { useEffect, useState, useCallback } from 'react';
import type { ChatSession, ChatSessionMessage, WorkspaceInfo } from '@deepseek-ide/shared';
import {
  AUTO_SESSION_TITLE_FALLBACK,
  buildSessionWorkspaceMeta,
  formatSessionWorkspaceLine,
  isCustomSessionTitle,
} from '../utils';
import { useDbConfirm } from '../hooks/useDbConfirm';
import { buildSqlConfirmMarkdown } from '../services/dbConfirmContent';
import { useI18n, type Translate } from '../i18n';

interface Props {
  currentSessionId: string;
  currentMessages: ChatSessionMessage[];
  workspaceInfo?: WorkspaceInfo | null;
  onLoad: (session: ChatSession) => void;
  onNewSession?: () => void;
  onClose: () => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  if (isToday) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sessionPreview(messages: ChatSessionMessage[], t: Translate): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return t('session.emptyConversation');
  return first.content.slice(0, 60) + (first.content.length > 60 ? '…' : '');
}

export function SessionDrawer({
  currentSessionId,
  currentMessages,
  workspaceInfo,
  onLoad,
  onNewSession,
  onClose,
}: Props) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  // 删除确认走应用内弹窗：系统 `window.confirm` 在 Electron 里既不是应用主题色，
  // 也没法把「删的是哪一条、有多少轮对话」摆成可核对的键值行
  const confirm = useDbConfirm();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await window.ide.listSessions();
      setSessions(list);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // 删除确认框挂着时让 Esc 归它，别把整个抽屉一起关掉
        if (confirm.isOpen) return;
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose, confirm.isOpen]);

  /**
   * 删除一条会话（含全部对话记录，无回收站）。
   *
   * 确认文案里点名是哪一条：抽屉里相邻两行的标题常常一模一样，
   * 只说「确认删除？」拦不住手滑点错的那一下。
   */
  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const target = sessions.find((s) => s.id === id);
    const ok = await confirm.confirm({
      title: t('session.deleteTitle'),
      content: buildSqlConfirmMarkdown({
        t,
        intro: t('session.deleteIntro'),
        statements: [],
      }),
      details: [
        { label: t('session.labelTitle'), value: target?.title?.trim() || t('session.untitled') },
        { label: t('session.labelTime'), value: target ? formatTime(target.updatedAt) : t('session.unknown') },
        { label: t('session.labelTurns'), value: t('session.turnsCount', { n: target?.messages?.length ?? 0 }) },
      ],
      tone: 'danger',
      confirmLabel: t('session.confirmDelete'),
    });
    if (ok === null) return;
    setDeleting(id);
    try {
      await window.ide.deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (id === currentSessionId) {
        onNewSession?.();
        onClose();
      }
    } finally {
      setDeleting(null);
    }
  };

  const handleLoad = async (session: ChatSession) => {
    if (currentMessages.length > 0) {
      const firstUser = currentMessages.find((m) => m.role === 'user');
      const firstUserSnippet = firstUser ? firstUser.content.slice(0, 40) : '';
      const existing = sessions.find((s) => s.id === currentSessionId);
      const isCustom = isCustomSessionTitle(existing?.title, firstUserSnippet, existing?.customTitle);

      const title = isCustom && existing?.title ? existing.title : firstUserSnippet || AUTO_SESSION_TITLE_FALLBACK;
      const meta = buildSessionWorkspaceMeta(workspaceInfo);
      await window.ide.saveSession({
        id: currentSessionId,
        title,
        customTitle: isCustom,
        messages: currentMessages,
        updatedAt: Date.now(),
        ...meta,
      });
    }
    onLoad(session);
  };

  return (
    <>
      <div className="session-drawer-backdrop" onClick={onClose} />
      <div className="session-drawer">
        <div className="session-drawer-header">
          <span>{t('session.historyTitle')}</span>
          <button type="button" className="session-drawer-close" onClick={onClose} title={t('session.close')}>
            ✕
          </button>
        </div>

        <div className="session-drawer-list">
          {loading ? (
            <div className="session-drawer-empty">{t('session.loading')}</div>
          ) : sessions.length === 0 ? (
            <div className="session-drawer-empty">{t('session.empty')}</div>
          ) : (
            sessions.map((s) => {
              const ws = formatSessionWorkspaceLine(s, t);
              return (
                <div
                  key={s.id}
                  className={`session-item${s.id === currentSessionId ? ' active' : ''}`}
                  onClick={() => void handleLoad(s)}
                  title={s.title}
                >
                  <div className="session-item-title">{s.title}</div>
                  <div className="session-item-ws" title={ws.title || ws.text}>
                    {ws.badge ? (
                      <span className={`session-ws-badge${ws.kind === 'ssh' ? ' ssh' : ' local'}`}>
                        {ws.badge}
                      </span>
                    ) : null}
                    <span>{ws.text}</span>
                  </div>
                  <div className="session-item-meta">
                    <span className="session-item-time">{formatTime(s.updatedAt)}</span>
                    <span className="session-item-count">
                      {t('session.countBadge', {
                        n: s.messages.filter((m) => m.role !== 'tool').length,
                      })}
                    </span>
                  </div>
                  <div className="session-item-preview">{sessionPreview(s.messages, t)}</div>
                  <button
                    type="button"
                    className="session-item-delete"
                    disabled={deleting === s.id}
                    onClick={(e) => void handleDelete(s.id, e)}
                    title={t('session.delete')}
                  >
                    ✕
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
      {confirm.modal}
    </>
  );
}
