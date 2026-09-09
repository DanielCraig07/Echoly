import { useEffect, useState, useCallback, useRef } from 'react';
import type { ChatSession } from '@deepseek-ide/shared';
import { formatSessionWorkspaceLine } from '../utils';

interface Props {
  currentSessionId: string;
  onSelectSession: (session: ChatSession) => void;
  onNewSession: () => void;
  onClose: () => void;
  activeSessionIds?: string[];
  onRenameSession?: (id: string, newTitle: string) => void;
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

export function SessionModal({
  currentSessionId,
  onSelectSession,
  onNewSession,
  onClose,
  activeSessionIds = [],
  onRenameSession,
}: Props) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await window.ide.listSessions();
      // 保证 UI 上绝对不出现重复卡片
      const uniqueMap = new Map<string, ChatSession>();
      for (const s of list) {
        if (!uniqueMap.has(s.id)) {
          uniqueMap.set(s.id, s);
        }
      }
      setSessions(Array.from(uniqueMap.values()));
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
        if (editingId) {
          setEditingId(null);
          return;
        }
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose, editingId]);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleting(id);
    try {
      await window.ide.deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (id === currentSessionId) {
        onNewSession();
        onClose();
      }
    } finally {
      setDeleting(null);
    }
  };

  const handleStartRename = (s: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(s.id);
    setEditTitle(s.title);
  };

  const isSavingRenameRef = useRef(false);

  const handleSaveRename = async (id: string) => {
    if (isSavingRenameRef.current) return;
    isSavingRenameRef.current = true;
    try {
      const trimmed = editTitle.trim();
      if (!trimmed) {
        setEditingId(null);
        return;
      }
      const target = sessions.find((s) => s.id === id);
      if (target) {
        const updated: ChatSession = {
          ...target,
          title: trimmed,
          customTitle: true,
          updatedAt: Date.now(),
        };
        await window.ide.saveSession(updated);
        setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
        onRenameSession?.(id, trimmed);
      }
      setEditingId(null);
    } finally {
      isSavingRenameRef.current = false;
    }
  };

  const filteredSessions = sessions.filter((s) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const matchTitle = s.title.toLowerCase().includes(q);
    const matchMsg = s.messages.some((m) => m.content.toLowerCase().includes(q));
    const ws = formatSessionWorkspaceLine(s);
    const matchWs =
      ws.text.toLowerCase().includes(q) ||
      ws.badge.toLowerCase().includes(q) ||
      (s.workspacePath || '').toLowerCase().includes(q);
    return matchTitle || matchMsg || matchWs;
  });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="session-modal" onClick={(e) => e.stopPropagation()}>
        <div className="session-modal-header">
          <div className="session-modal-title">
            <span>历史会话</span>
            <span className="session-modal-count">({sessions.length})</span>
          </div>
          <div className="session-modal-actions">
            <button
              type="button"
              className="primary-btn-sm"
              onClick={() => {
                onNewSession();
                onClose();
              }}
            >
              + 新建会话
            </button>
            <button type="button" className="close-btn" onClick={onClose} title="关闭 (Esc)">
              ✕
            </button>
          </div>
        </div>

        <div className="session-modal-search">
          <input
            type="text"
            placeholder="搜索历史会话标题或内容…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </div>

        <div className="session-modal-body">
          {loading ? (
            <div className="session-modal-empty">加载中…</div>
          ) : filteredSessions.length === 0 ? (
            <div className="session-modal-empty">
              {search ? '没有匹配的会话' : '暂无历史会话记录'}
            </div>
          ) : (
            <div className="session-modal-list">
              {filteredSessions.map((s) => {
                const isActiveTab = activeSessionIds.includes(s.id);
                const isCurrent = s.id === currentSessionId;
                const isEditing = editingId === s.id;
                const ws = formatSessionWorkspaceLine(s);

                return (
                  <div
                    key={s.id}
                    className={`session-row${isCurrent ? ' current' : ''}${isActiveTab ? ' active-tab' : ''}`}
                    onClick={() => {
                      if (!isEditing) {
                        onSelectSession(s);
                        onClose();
                      }
                    }}
                  >
                    <div className="session-row-left">
                      {isEditing ? (
                        <input
                          className="session-rename-input"
                          type="text"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleSaveRename(s.id);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          onBlur={() => void handleSaveRename(s.id)}
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <div className="session-row-text">
                          <span className="session-row-title" title={s.title}>
                            {s.title}
                          </span>
                          <span className="session-row-project" title={ws.title || ws.text}>
                            {ws.badge ? (
                              <span
                                className={`session-ws-badge${ws.kind === 'ssh' ? ' ssh' : ' local'}`}
                              >
                                {ws.badge}
                              </span>
                            ) : null}
                            <span className="session-row-project-name">{ws.text}</span>
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="session-row-right">
                      {isCurrent && <span className="session-card-badge">当前</span>}
                      <span className="session-row-time">{formatTime(s.updatedAt)}</span>
                      <span className="session-row-msgs">
                        {s.messages.filter((m) => m.role !== 'tool').length} 条
                      </span>
                      <button
                        type="button"
                        className="session-card-icon-btn"
                        onClick={(e) => handleStartRename(s, e)}
                        title="重命名"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="session-card-delete"
                        disabled={deleting === s.id}
                        onClick={(e) => void handleDelete(s.id, e)}
                        title="删除"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
