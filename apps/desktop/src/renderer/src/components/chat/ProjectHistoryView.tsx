import React, { useMemo } from 'react';
import type { ChatSession } from '@deepseek-ide/shared';
import { useI18n } from '../../i18n';
import echolyAppIcon from '../../assets/echoly-icon.png';

export interface ProjectHistoryViewProps {
  sessions: ChatSession[];
  activeSessionIds: string[];
  projectName?: string;
  onSelectSession: (session: ChatSession) => void;
  onDeleteSession?: (id: string, title?: string) => void;
  onOpenHistoryModal: () => void;
  onQuickPrompt: (type: 'explain' | 'optimize' | 'test' | 'bug') => void;
  selection?: string;
}

function formatRelativeTime(ts: number, t: (k: string, vars?: any) => string): string {
  if (!ts) return '';
  const diff = Math.max(0, Date.now() - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return t('chat.justNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('chat.minsAgo', { n: min });
  const hour = Math.floor(min / 60);
  if (hour < 24) return t('chat.hoursAgo', { n: hour });
  const day = Math.floor(hour / 24);
  if (day === 1) return t('chat.yesterday');
  if (day < 7) return t('chat.daysAgo', { n: day });
  const d = new Date(ts);
  return d.toLocaleDateString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  });
}

function getSessionSnippet(session: ChatSession): string {
  if (!session.messages || session.messages.length === 0) return '';
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if ((m.role === 'user' || m.role === 'assistant') && !m.isIntermediate && m.content?.trim()) {
      const clean = m.content
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/#+\s*/g, '')
        .replace(/[*_~>]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (clean) {
        return clean.length > 76 ? clean.slice(0, 76) + '…' : clean;
      }
    }
  }
  return '';
}

const MAX_DISPLAY_SESSIONS = 5;

export const ProjectHistoryView: React.FC<ProjectHistoryViewProps> = ({
  sessions,
  activeSessionIds,
  projectName,
  onSelectSession,
  onDeleteSession,
  onOpenHistoryModal,
  onQuickPrompt,
  selection,
}) => {
  const { t } = useI18n();

  const displaySessions = useMemo(() => {
    return sessions.slice(0, MAX_DISPLAY_SESSIONS);
  }, [sessions]);

  const hasMore = sessions.length > MAX_DISPLAY_SESSIONS;

  return (
    <div className="project-history-view">
      {/* 头部：Echoly 图标、项目标签与会话统计 */}
      <div className="project-history-header">
        <div className="project-history-brand">
          <div className="project-history-icon-wrap">
            <img src={echolyAppIcon} alt="Echoly Icon" className="project-history-app-icon" />
          </div>
          <div className="project-history-title-block">
            <div className="project-history-title-row">
              <span className="project-history-title">{t('chat.projectHistoryTitle')}</span>
              {projectName && (
                <span className="project-history-project-badge" title={projectName}>
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
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  {projectName}
                </span>
              )}
            </div>
            <span className="project-history-subtitle">{t('chat.projectHistorySubtitle')}</span>
          </div>
        </div>

        <button
          type="button"
          className="project-history-view-all-btn"
          onClick={onOpenHistoryModal}
          title={t('chat.viewAllSessions', { n: sessions.length })}
        >
          {t('chat.viewAllSessions', { n: sessions.length })}
        </button>
      </div>

      {/* 历史会话卡片列表 */}
      <div className="project-history-list">
        {displaySessions.map((session) => {
          const isActiveTab = activeSessionIds.includes(session.id);
          const snippet = getSessionSnippet(session);
          const msgCount = session.messages.filter((m) => m.role !== 'tool').length;

          return (
            <div
              key={session.id}
              className={`project-history-card${isActiveTab ? ' is-active' : ''}`}
              onClick={() => onSelectSession(session)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectSession(session);
                }
              }}
            >
              <div className="project-history-card-header">
                <div className="project-history-card-title-group">
                  <span className="project-history-card-icon">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                  </span>
                  <span className="project-history-card-title" title={session.title}>
                    {session.title || t('session.untitled')}
                  </span>
                  {isActiveTab && (
                    <span className="project-history-badge active">{t('chat.openInTab')}</span>
                  )}
                </div>

                <div className="project-history-card-meta-right">
                  <span className="project-history-time">
                    {formatRelativeTime(session.updatedAt, t)}
                  </span>
                  {onDeleteSession && (
                    <button
                      type="button"
                      className="project-history-delete-btn"
                      title={t('chat.deleteSession')}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteSession(session.id, session.title);
                      }}
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
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>

              {snippet && <div className="project-history-card-snippet">{snippet}</div>}

              <div className="project-history-card-footer">
                <span className="project-history-card-count">
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
                  </svg>
                  {t('chat.sessionMessagesCount', { n: msgCount })}
                </span>
                <span className="project-history-arrow">→</span>
              </div>
            </div>
          );
        })}

        {hasMore && (
          <button
            type="button"
            className="project-history-more-btn"
            onClick={onOpenHistoryModal}
            title={t('chat.viewMoreSessions', { n: sessions.length })}
          >
            {t('chat.viewMoreSessions', { n: sessions.length })}
          </button>
        )}
      </div>

      {/* 分割线与快捷指令区 */}
      <div className="project-history-divider">
        <span>{t('chat.orNewQuestion')}</span>
      </div>

      <div className="project-history-quick-grid">
        <button type="button" className="chat-prompt-pill" onClick={() => onQuickPrompt('explain')}>
          <span className="chat-prompt-pill-icon">🔍</span>
          <span className="chat-prompt-pill-text">
            {selection?.trim() ? t('chat.quickExplainSelection') : t('chat.quickExplain')}
          </span>
          <span className="chat-prompt-pill-arrow">→</span>
        </button>

        <button
          type="button"
          className="chat-prompt-pill"
          onClick={() => onQuickPrompt('optimize')}
        >
          <span className="chat-prompt-pill-icon">⚡</span>
          <span className="chat-prompt-pill-text">{t('chat.quickOptimize')}</span>
          <span className="chat-prompt-pill-arrow">→</span>
        </button>

        <button type="button" className="chat-prompt-pill" onClick={() => onQuickPrompt('test')}>
          <span className="chat-prompt-pill-icon">🧪</span>
          <span className="chat-prompt-pill-text">{t('chat.quickTest')}</span>
          <span className="chat-prompt-pill-arrow">→</span>
        </button>

        <button type="button" className="chat-prompt-pill" onClick={() => onQuickPrompt('bug')}>
          <span className="chat-prompt-pill-icon">🛠️</span>
          <span className="chat-prompt-pill-text">{t('chat.quickBug')}</span>
          <span className="chat-prompt-pill-arrow">→</span>
        </button>
      </div>
    </div>
  );
};
