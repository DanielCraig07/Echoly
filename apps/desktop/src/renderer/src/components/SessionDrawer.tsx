import { useEffect, useState, useCallback } from 'react';
import type { ChatSession, ChatSessionMessage, WorkspaceInfo } from '@deepseek-ide/shared';
import { buildSessionWorkspaceMeta, formatSessionWorkspaceLine } from '../utils';

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

function sessionPreview(messages: ChatSessionMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return '（空对话）';
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
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

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
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
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
      const title = currentMessages.find((m) => m.role === 'user')?.content.slice(0, 40) ?? '对话';
      const meta = buildSessionWorkspaceMeta(workspaceInfo);
      await window.ide.saveSession({
        id: currentSessionId,
        title,
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
          <span>历史会话</span>
          <button type="button" className="session-drawer-close" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>

        <div className="session-drawer-list">
          {loading ? (
            <div className="session-drawer-empty">加载中…</div>
          ) : sessions.length === 0 ? (
            <div className="session-drawer-empty">暂无历史会话</div>
          ) : (
            sessions.map((s) => {
              const ws = formatSessionWorkspaceLine(s);
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
                      {s.messages.filter((m) => m.role !== 'tool').length} 条
                    </span>
                  </div>
                  <div className="session-item-preview">{sessionPreview(s.messages)}</div>
                  <button
                    type="button"
                    className="session-item-delete"
                    disabled={deleting === s.id}
                    onClick={(e) => void handleDelete(s.id, e)}
                    title="删除"
                  >
                    ✕
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
