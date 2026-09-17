import { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ChatSession } from '@deepseek-ide/shared';
import { formatSessionWorkspaceLine } from '../utils';
import { useModalResize, ModalResizeHandle } from '../hooks/useModalResize';

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
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_session_modal_size',
    defaultWidth: 620,
    defaultHeight: 560,
    minWidth: 480,
    minHeight: 380,
  });
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

  return createPortal(
    <div className="session-modal-overlay" onClick={onClose}>
      <div
        className="session-modal"
        style={{
          width: modalSize.width,
          height: modalSize.height,
          maxWidth: '96vw',
          maxHeight: '94vh',
          position: 'relative',
        }}
        onClick={(e) => e.stopPropagation()}
      >
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
            <button
              type="button"
              className="panel-action-btn"
              onClick={onClose}
              title="关闭 (Esc)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div className="session-modal-search">
          <div className="session-search-wrapper">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="session-search-icon"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="搜索历史会话标题或内容…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            {search && (
              <button
                type="button"
                className="session-search-clear-btn"
                onClick={() => setSearch('')}
                title="清空"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        <div className="session-modal-body">
          {loading ? (
            <div className="session-modal-empty" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
                <line x1="12" y1="2" x2="12" y2="6" /><line x1="12" y1="18" x2="12" y2="22" />
                <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" /><line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
                <line x1="2" y1="12" x2="6" y2="12" /><line x1="18" y1="12" x2="22" y2="12" />
                <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" /><line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
              </svg>
              <span>加载中…</span>
            </div>
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
                const msgCount = s.messages.filter((m) => m.role !== 'tool').length;

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
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span className="session-row-title" title={s.title}>
                              {s.title}
                            </span>
                            {isCurrent && (
                              <span
                                style={{
                                  fontSize: 10,
                                  fontWeight: 600,
                                  padding: '1px 6px',
                                  borderRadius: 4,
                                  background: 'rgba(76, 141, 255, 0.18)',
                                  color: 'var(--accent, #4c8dff)',
                                  border: '1px solid rgba(76, 141, 255, 0.3)',
                                  flexShrink: 0,
                                }}
                              >
                                当前
                              </span>
                            )}
                          </div>
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
                      <span className="session-row-time">{formatTime(s.updatedAt)}</span>
                      <span
                        style={{
                          fontSize: 10.5,
                          color: 'var(--muted, #888)',
                          background: 'rgba(255, 255, 255, 0.05)',
                          padding: '2px 7px',
                          borderRadius: 4,
                          border: '1px solid rgba(255, 255, 255, 0.06)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        💬 {msgCount} 轮
                      </span>
                      <div className="session-row-actions" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <button
                          type="button"
                          className="session-card-icon-btn"
                          onClick={(e) => handleStartRename(s, e)}
                          title="重命名会话"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 24,
                            height: 24,
                            borderRadius: 5,
                            border: 'none',
                            background: 'transparent',
                            color: 'var(--muted, #888)',
                            cursor: 'pointer',
                          }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="session-card-delete"
                          disabled={deleting === s.id}
                          onClick={(e) => void handleDelete(s.id, e)}
                          title="删除会话"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 24,
                            height: 24,
                            borderRadius: 5,
                            border: 'none',
                            background: 'transparent',
                            color: 'var(--muted, #888)',
                            cursor: 'pointer',
                          }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {/* 右下角全向拖拽调整大小手柄 */}
        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>,
    document.body,
  );
}
