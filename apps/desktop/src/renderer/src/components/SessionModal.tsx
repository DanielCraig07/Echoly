import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { ChatSession, WorkspaceInfo, RecentWorkspaceItem } from '@deepseek-ide/shared';
import { formatSessionWorkspaceLine, folderNameFromPath } from '../utils';
import { useModalResize, ModalResizeHandle } from '../hooks/useModalResize';

interface Props {
  currentSessionId: string;
  onSelectSession: (session: ChatSession) => void;
  onNewSession: () => void;
  onClose: () => void;
  activeSessionIds?: string[];
  onRenameSession?: (id: string, newTitle: string) => void;
  workspaceInfo?: WorkspaceInfo | null;
  recentWorkspaces?: RecentWorkspaceItem[];
}

export function isSessionMatchingWorkspace(
  session: ChatSession,
  ws: WorkspaceInfo | null | undefined,
): boolean {
  if (!ws?.root) return true;
  const norm = (str?: string) =>
    (str || '').replace(/\\/g, '/').replace(/\/+$/, '').trim().toLowerCase();

  const wsRoot = norm(ws.root);
  const wsLabel = norm(ws.label);
  const sessionPath = norm(session.workspacePath);
  const sessionProject = norm(session.projectName);
  const currentProject = norm(folderNameFromPath(ws.root));

  // 1. 绝对或规范化路径直接匹配
  if (sessionPath) {
    if (sessionPath === wsRoot || sessionPath === wsLabel) return true;
    if (sessionPath.endsWith('/' + wsRoot) || wsRoot.endsWith('/' + sessionPath)) return true;
  }

  // 2. 项目名称一致匹配
  if (sessionProject && currentProject && sessionProject === currentProject) {
    return true;
  }

  return false;
}

export function isSessionMatchingProject(
  session: ChatSession,
  project: { path?: string; name?: string },
): boolean {
  if (!project.path && !project.name) return true;
  const norm = (str?: string) =>
    (str || '').replace(/\\/g, '/').replace(/\/+$/, '').trim().toLowerCase();

  const projPath = norm(project.path);
  const projName = norm(project.name);
  const sessionPath = norm(session.workspacePath);
  const sessionProject = norm(session.projectName);

  // 1. 路径直接匹配
  if (projPath && sessionPath) {
    if (sessionPath === projPath) return true;
    if (sessionPath.endsWith('/' + projPath) || projPath.endsWith('/' + sessionPath)) return true;
  }

  // 2. 项目名称匹配
  if (projName) {
    if (sessionProject && sessionProject === projName) return true;
    if (sessionPath) {
      const folder = norm(folderNameFromPath(session.workspacePath || ''));
      if (folder === projName) return true;
    }
  }

  // 3. 从 project.path 中提取目录名匹配
  if (projPath && !projName) {
    const folder = norm(folderNameFromPath(project.path || ''));
    if (sessionProject && sessionProject === folder) return true;
  }

  return false;
}

export interface AvailableProject {
  key: string;
  name: string;
  path?: string;
  isCurrent: boolean;
  count: number;
}

function getStoredRecentWorkspaces(): RecentWorkspaceItem[] {
  try {
    const raw = localStorage.getItem('echoly_recent_workspaces');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function collectAvailableProjects(
  workspaceInfo: WorkspaceInfo | null | undefined,
  recentWorkspaces: RecentWorkspaceItem[] | undefined,
  sessions: ChatSession[],
): AvailableProject[] {
  // key 为规范化小写项目名，确保相同项目名称在下拉列表中全局唯一，不重复出现
  const map = new Map<
    string,
    { key: string; name: string; path?: string; isCurrent: boolean }
  >();

  const getCanonical = (
    rawName?: string,
    rawPath?: string,
  ): { canonicalKey: string; name: string } => {
    const n = (rawName || '').trim();
    const folder = folderNameFromPath(rawPath || '').trim();
    const name = n || folder || '未命名项目';
    return {
      canonicalKey: name.toLowerCase(),
      name,
    };
  };

  // 1. 当前打开的工作区（置顶）
  if (workspaceInfo?.root) {
    const currentName =
      folderNameFromPath(workspaceInfo.root) || workspaceInfo.label || '当前项目';
    const { canonicalKey, name } = getCanonical(currentName, workspaceInfo.root);
    map.set(canonicalKey, {
      key: canonicalKey,
      name,
      path: workspaceInfo.root,
      isCurrent: true,
    });
  }

  // 2. 所有最近/已知工作区（即使当前没有任何历史会话，也全部纳入并供用户选择）
  const recents =
    recentWorkspaces && recentWorkspaces.length > 0
      ? recentWorkspaces
      : getStoredRecentWorkspaces();

  for (const r of recents) {
    if (!r.path && !r.name) continue;
    const { canonicalKey, name } = getCanonical(r.name, r.path);
    const existing = map.get(canonicalKey);
    if (!existing) {
      map.set(canonicalKey, {
        key: canonicalKey,
        name,
        path: r.path,
        isCurrent: false,
      });
    } else {
      // 若已有项缺少 path 而新项有，或者新项是更完整的路径，保留路径
      if (!existing.path && r.path) {
        existing.path = r.path;
      }
    }
  }

  // 3. 历史会话中记录的项目
  for (const s of sessions) {
    const sPath = s.workspacePath;
    const sName = s.projectName || (sPath ? folderNameFromPath(sPath) : '');
    if (!sPath && !sName) continue;
    const { canonicalKey, name } = getCanonical(sName, sPath);
    const existing = map.get(canonicalKey);
    if (!existing) {
      map.set(canonicalKey, {
        key: canonicalKey,
        name,
        path: sPath,
        isCurrent: false,
      });
    } else {
      if (!existing.path && sPath) {
        existing.path = sPath;
      }
    }
  }

  // 计算每个项目当前匹配到的会话条数（允许为 0）
  const result: AvailableProject[] = [];
  for (const proj of map.values()) {
    const count = sessions.filter((s) => isSessionMatchingProject(s, proj)).length;
    result.push({
      key: proj.key,
      name: proj.name,
      path: proj.path,
      isCurrent: proj.isCurrent,
      count,
    });
  }

  // 当前项目置顶，其余项目优先按会话数降序排列，再按名称字母序排列
  result.sort((a, b) => {
    if (a.isCurrent) return -1;
    if (b.isCurrent) return 1;
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name);
  });

  return result;
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
  workspaceInfo,
  recentWorkspaces,
}: Props) {
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_session_modal_size',
    defaultWidth: 640,
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
  // 筛选范围：'current' 为当前工作区，'all' 为全局全部会话，或者指定项目的 key
  const [filterScope, setFilterScope] = useState<string>('current');
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const projectDropdownRef = useRef<HTMLDivElement>(null);

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
        if (projectDropdownOpen) {
          setProjectDropdownOpen(false);
          return;
        }
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose, editingId, projectDropdownOpen]);

  // 点击外部关闭项目下拉选单
  useEffect(() => {
    if (!projectDropdownOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (
        projectDropdownRef.current &&
        !projectDropdownRef.current.contains(e.target as Node)
      ) {
        setProjectDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [projectDropdownOpen]);

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
        // 关键：立即同步更新当前会话状态并通知 ChatPanel，不等待后台磁盘写入
        setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
        onRenameSession?.(id, trimmed);
        await window.ide.saveSession(updated);
      }
      setEditingId(null);
    } finally {
      isSavingRenameRef.current = false;
    }
  };

  const currentProjectName = workspaceInfo?.root
    ? folderNameFromPath(workspaceInfo.root)
    : '';

  const isCurrentProjectSession = useCallback(
    (s: ChatSession) => {
      if (!workspaceInfo?.root) return true;
      return isSessionMatchingWorkspace(s, workspaceInfo);
    },
    [workspaceInfo],
  );

  const currentProjectSessions = useMemo(
    () => sessions.filter(isCurrentProjectSession),
    [sessions, isCurrentProjectSession],
  );

  // 收集并整理所有项目（包含无历史会话的项目）
  const availableProjects = useMemo(
    () => collectAvailableProjects(workspaceInfo, recentWorkspaces, sessions),
    [workspaceInfo, recentWorkspaces, sessions],
  );

  const selectedSpecificProject = useMemo(
    () =>
      filterScope !== 'current' && filterScope !== 'all'
        ? availableProjects.find((p) => p.key === filterScope)
        : null,
    [filterScope, availableProjects],
  );

  // 根据当前选择的范围解析会话池
  const poolSessions = useMemo(() => {
    if (filterScope === 'all') {
      return sessions;
    }
    if (filterScope === 'current') {
      return workspaceInfo?.root ? currentProjectSessions : sessions;
    }
    if (selectedSpecificProject) {
      return sessions.filter((s) =>
        isSessionMatchingProject(s, selectedSpecificProject),
      );
    }
    return sessions;
  }, [filterScope, sessions, workspaceInfo, currentProjectSessions, selectedSpecificProject]);

  const filteredSessions = poolSessions.filter((s) => {
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

  const activeScopeBadgeText = useMemo(() => {
    if (filterScope === 'all') return '全局会话 (全部项目)';
    if (filterScope === 'current') {
      return currentProjectName ? `当前项目: ${currentProjectName}` : '当前项目';
    }
    if (selectedSpecificProject) {
      return `项目: ${selectedSpecificProject.name}`;
    }
    return '历史会话';
  }, [filterScope, currentProjectName, selectedSpecificProject]);

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
          <div className="session-modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>历史会话</span>
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 12,
                background: 'var(--primary-subtle, rgba(56, 189, 248, 0.12))',
                color: 'var(--primary, #38bdf8)',
                border: '1px solid rgba(56, 189, 248, 0.25)',
                fontWeight: 600,
                maxWidth: 180,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={selectedSpecificProject?.path || workspaceInfo?.root || '全部项目'}
            >
              {activeScopeBadgeText}
            </span>
            <span className="session-modal-count">({filteredSessions.length})</span>
          </div>
          <div className="session-modal-actions" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* 项目会话切换器：永久展示（放出来），支持选择所有已知项目（不管有没有历史会话） */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                background: 'var(--bg-elevated, rgba(255,255,255,0.06))',
                borderRadius: 6,
                padding: 2,
                border: '1px solid var(--border)',
                position: 'relative',
              }}
            >
              {workspaceInfo?.root && (
                <button
                  type="button"
                  style={{
                    padding: '3px 8px',
                    fontSize: 11,
                    borderRadius: 4,
                    border: 'none',
                    background: filterScope === 'current' ? 'var(--primary, #38bdf8)' : 'transparent',
                    color: filterScope === 'current' ? '#000' : 'var(--muted)',
                    fontWeight: filterScope === 'current' ? 700 : 500,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    whiteSpace: 'nowrap',
                  }}
                  onClick={() => setFilterScope('current')}
                  title={`当前项目：${currentProjectName} (${currentProjectSessions.length} 条会话)`}
                >
                  当前项目 ({currentProjectSessions.length})
                </button>
              )}
              <button
                type="button"
                style={{
                  padding: '3px 8px',
                  fontSize: 11,
                  borderRadius: 4,
                  border: 'none',
                  background: filterScope === 'all' ? 'var(--primary, #38bdf8)' : 'transparent',
                  color: filterScope === 'all' ? '#000' : 'var(--muted)',
                  fontWeight: filterScope === 'all' ? 700 : 500,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  whiteSpace: 'nowrap',
                }}
                onClick={() => setFilterScope('all')}
                title={`全部项目历史会话 (${sessions.length} 条)`}
              >
                全部项目 ({sessions.length})
              </button>

              {/* 下拉选择具体项目（包含无历史会话的所有已知项目） */}
              <div ref={projectDropdownRef} style={{ position: 'relative' }}>
                <button
                  type="button"
                  style={{
                    padding: '3px 8px',
                    fontSize: 11,
                    borderRadius: 4,
                    border: 'none',
                    background: selectedSpecificProject ? 'var(--primary, #38bdf8)' : 'transparent',
                    color: selectedSpecificProject ? '#000' : 'var(--muted)',
                    fontWeight: selectedSpecificProject ? 700 : 500,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 3,
                    transition: 'all 0.15s ease',
                    maxWidth: 150,
                  }}
                  onClick={() => setProjectDropdownOpen((v) => !v)}
                  title="选择具体项目（包含暂无历史会话的所有已知项目）"
                >
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {selectedSpecificProject
                      ? `${selectedSpecificProject.name} (${selectedSpecificProject.count})`
                      : '指定项目'}
                  </span>
                  <span style={{ fontSize: 9, opacity: 0.8 }}>▾</span>
                </button>

                {projectDropdownOpen && (
                  <div className="session-project-dropdown-menu">
                    <div className="session-project-dropdown-header">
                      <span>切换查看项目（所有项目均可选）</span>
                      <span className="session-project-dropdown-badge">{availableProjects.length} 个项目</span>
                    </div>

                    {/* 全局全部项目 */}
                    <div
                      className={`session-project-dropdown-item${filterScope === 'all' ? ' active' : ''}`}
                      onClick={() => {
                        setFilterScope('all');
                        setProjectDropdownOpen(false);
                      }}
                    >
                      <div className="session-project-item-left">
                        <svg
                          className="session-project-item-icon"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="12" cy="12" r="10" />
                          <line x1="2" y1="12" x2="22" y2="12" />
                          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                        </svg>
                        <span className="session-project-item-title">全部项目 (全局)</span>
                      </div>
                      <div className="session-project-item-right">
                        <span className={`session-project-count-pill${sessions.length > 0 ? ' has-sessions' : ''}`}>
                          {sessions.length} 条
                        </span>
                        {filterScope === 'all' && (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </div>
                    </div>

                    <div className="session-project-dropdown-divider" />

                    {/* 所有已知项目列表（包含 0 会话历史的项目，当前项目置顶展示） */}
                    {availableProjects.map((p) => {
                      const isSelected = p.isCurrent
                        ? filterScope === 'current' || filterScope === p.key
                        : filterScope === p.key;

                      return (
                        <div
                          key={p.key}
                          className={`session-project-dropdown-item${isSelected ? ' active' : ''}`}
                          onClick={() => {
                            setFilterScope(p.isCurrent ? 'current' : p.key);
                            setProjectDropdownOpen(false);
                          }}
                          title={p.path ? `${p.name} (${p.path})` : p.name}
                        >
                          <div className="session-project-item-left">
                            {p.isCurrent ? (
                              <svg
                                className="session-project-item-icon"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                                <circle cx="12" cy="10" r="3" />
                              </svg>
                            ) : (
                              <svg
                                className="session-project-item-icon"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                              </svg>
                            )}
                            <span className="session-project-item-title">
                              {p.isCurrent ? `当前：${p.name}` : p.name}
                            </span>
                            {p.isCurrent && (
                              <span className="session-project-current-tag">当前</span>
                            )}
                          </div>
                          <div className="session-project-item-right">
                            <span className={`session-project-count-pill${p.count > 0 ? ' has-sessions' : ''}`}>
                              {p.count > 0 ? `${p.count} 条` : '0'}
                            </span>
                            {isSelected && (
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

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
            <div className="session-modal-empty" style={{ padding: '32px 16px', textAlign: 'center' }}>
              {search ? (
                '没有匹配的会话'
              ) : filterScope === 'current' ? (
                <div>
                  <div style={{ color: 'var(--muted)', marginBottom: 12 }}>
                    当前项目（{currentProjectName || '当前项目'}）暂无历史会话
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                    {sessions.length > 0 && (
                      <button
                        type="button"
                        className="ghost-btn-sm"
                        onClick={() => setFilterScope('all')}
                        style={{ fontSize: 12, padding: '4px 12px' }}
                      >
                        查看全部项目会话 ({sessions.length})
                      </button>
                    )}
                  </div>
                </div>
              ) : selectedSpecificProject ? (
                <div>
                  <div style={{ color: 'var(--muted)', marginBottom: 12 }}>
                    项目 “{selectedSpecificProject.name}” 暂无历史会话
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                    {workspaceInfo?.root && (
                      <button
                        type="button"
                        className="ghost-btn-sm"
                        onClick={() => setFilterScope('current')}
                        style={{ fontSize: 12, padding: '4px 12px' }}
                      >
                        查看当前项目 ({currentProjectSessions.length})
                      </button>
                    )}
                    <button
                      type="button"
                      className="ghost-btn-sm"
                      onClick={() => setFilterScope('all')}
                      style={{ fontSize: 12, padding: '4px 12px' }}
                    >
                      查看全部项目会话 ({sessions.length})
                    </button>
                  </div>
                </div>
              ) : (
                '暂无历史会话记录'
              )}
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
                      if (isEditing) {
                        void handleSaveRename(s.id);
                        return;
                      }
                      onSelectSession(s);
                      onClose();
                    }}
                  >
                    <div className="session-row-left">
                      {isEditing ? (
                        <div className="session-row-text">
                          <div
                            className="session-row-title-bar editing"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              className="session-rename-input"
                              type="text"
                              value={editTitle}
                              onChange={(e) => setEditTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  void handleSaveRename(s.id);
                                } else if (e.key === 'Escape') {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setEditingId(null);
                                }
                              }}
                              onBlur={() => void handleSaveRename(s.id)}
                              autoFocus
                            />
                            <div className="session-rename-actions">
                              <button
                                type="button"
                                className="session-rename-btn save"
                                title="保存名称 (Enter)"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  void handleSaveRename(s.id);
                                }}
                              >
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                className="session-rename-btn cancel"
                                title="取消 (Esc)"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setEditingId(null);
                                }}
                              >
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                  <line x1="18" y1="6" x2="6" y2="18" />
                                  <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                              </button>
                            </div>
                            {isCurrent && (
                              <span className="session-current-badge">
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
                      ) : (
                        <div className="session-row-text">
                          <div className="session-row-title-bar">
                            <span className="session-row-title" title={s.title}>
                              {s.title}
                            </span>
                            {isCurrent && (
                              <span className="session-current-badge">
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
                        {!isEditing && (
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
                        )}
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
