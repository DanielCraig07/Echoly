import { useEffect, useState, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { RemoteDirEntry, SshProfile } from '@deepseek-ide/shared';
import type { SwitchWorkspaceTarget } from './SwitchWorkspaceModal';

interface Props {
  open: boolean;
  onClose: () => void;
  onConnected: (label: string) => void;
  hasOpenWorkspace?: boolean;
  isSwitchingWorkspace?: boolean;
  onConfirmWorkspaceTarget?: (target: SwitchWorkspaceTarget) => void;
  initialServer?: string;
  initialRemotePath?: string;
}

export function SshConnectModal({
  open,
  onClose,
  onConnected,
  hasOpenWorkspace,
  isSwitchingWorkspace,
  onConfirmWorkspaceTarget,
  initialServer,
  initialRemotePath,
}: Props) {
  const [step, setStep] = useState<'credentials' | 'pick_directory'>('credentials');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [privateKeyPath, setPrivateKeyPath] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [remotePath, setRemotePath] = useState('');
  const [saveProfile, setSaveProfile] = useState(true);
  const [profileName, setProfileName] = useState('');
  const [profiles, setProfiles] = useState<SshProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);

  const [remoteDirs, setRemoteDirs] = useState<RemoteDirEntry[]>([]);
  const [dirLoading, setDirLoading] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [pathInputVal, setPathInputVal] = useState('');
  const pathInputRef = useRef<HTMLInputElement>(null);

  const [pickerSize, setPickerSize] = useState<{ width: number; height: number }>(() => {
    try {
      const saved = localStorage.getItem('echoly_ssh_picker_size');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed?.width === 'number' && typeof parsed?.height === 'number') {
          if (parsed.width >= 480 && parsed.height >= 380) {
            return {
              width: Math.min(parsed.width, Math.max(500, window.innerWidth - 40)),
              height: Math.min(parsed.height, Math.max(380, window.innerHeight - 40)),
            };
          }
        }
      }
    } catch {}
    const defaultW = typeof window !== 'undefined' ? Math.min(740, Math.max(520, Math.round(window.innerWidth * 0.58))) : 740;
    const defaultH = typeof window !== 'undefined' ? Math.min(580, Math.max(420, Math.round(window.innerHeight * 0.72))) : 580;
    return { width: defaultW, height: defaultH };
  });

  const pickerSizeRef = useRef(pickerSize);
  pickerSizeRef.current = pickerSize;

  const handlePickerResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = pickerSizeRef.current.width;
    const startH = pickerSizeRef.current.height;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      const maxW = Math.round(Math.min(1200, window.innerWidth - 30));
      const maxH = Math.round(Math.min(960, window.innerHeight - 30));
      const newW = Math.round(Math.max(500, Math.min(maxW, startW + dx * 2)));
      const newH = Math.round(Math.max(400, Math.min(maxH, startH + dy * 2)));
      pickerSizeRef.current = { width: newW, height: newH };
      setPickerSize({ width: newW, height: newH });
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        localStorage.setItem('echoly_ssh_picker_size', JSON.stringify(pickerSizeRef.current));
      } catch {}
    };

    document.body.style.cursor = 'nwse-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const isHiddenDir = (name: string) => name.startsWith('.') || name.startsWith('__');

  const breadcrumbSegments = useMemo(() => {
    if (!remotePath) return [];
    const parts = remotePath.split('/').filter(Boolean);
    const result: Array<{ name: string; path: string }> = [];
    let cur = '';
    for (const p of parts) {
      cur += '/' + p;
      result.push({ name: p, path: cur });
    }
    return result;
  }, [remotePath]);

  const filteredDirs = useMemo(() => {
    let list = [...remoteDirs];
    if (!showHidden) {
      list = list.filter((d) => !isHiddenDir(d.name));
    }
    if (filterQuery.trim()) {
      const q = filterQuery.trim().toLowerCase();
      list = list.filter((d) => d.name.toLowerCase().includes(q));
    }
    list.sort((a, b) => {
      const aHidden = isHiddenDir(a.name);
      const bHidden = isHiddenDir(b.name);
      if (aHidden !== bHidden) return aHidden ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [remoteDirs, showHidden, filterQuery]);

  const hiddenCount = useMemo(() => {
    return remoteDirs.filter((d) => isHiddenDir(d.name)).length;
  }, [remoteDirs]);

  const folderLabel = remotePath.split('/').filter(Boolean).pop() || remotePath || '/';

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open, onClose, step]);

  useEffect(() => {
    if (!open) {
      setShowForm(false);
      setStep('credentials');
      return;
    }
    setError('');
    setStep('credentials');
    if (initialRemotePath) {
      setRemotePath(initialRemotePath);
    }
    Promise.all([window.ide.listSshProfiles(), window.ide.listLocalSshConfig()]).then(
      ([saved, local]) => {
        const merged = [...saved];
        for (const l of local) {
          if (!merged.find((m) => m.host === l.host && m.username === l.username)) {
            merged.push(l);
          }
        }
        setProfiles(merged);

        if (initialServer) {
          const matched = merged.find(
            (p) =>
              initialServer.includes(p.host) || (p.username && initialServer.includes(p.username)),
          );
          if (matched) {
            setHost(matched.host);
            setPort(String(matched.port || 22));
            setUsername(matched.username);
            setPrivateKeyPath(matched.privateKeyPath || '');
            setProfileName(matched.name);
            setShowForm(true);
          } else if (initialServer.includes('@')) {
            const [u, h] = initialServer.split('@');
            setUsername(u);
            setHost(h);
            setShowForm(true);
          }
        } else if (merged.length === 0) {
          setShowForm(true);
        }
      },
    );
  }, [open, initialServer, initialRemotePath]);

  async function loadRemoteDir(pathOrEmpty?: string): Promise<void> {
    setDirLoading(true);
    setError('');
    const res = await window.ide.listRemoteDir(pathOrEmpty);
    setDirLoading(false);
    if (!res.ok) {
      setError(res.detail || '读取远程目录失败');
      return;
    }
    setRemoteDirs(res.entries || []);
    if (res.currentPath) {
      setRemotePath(res.currentPath);
      setPathInputVal(res.currentPath);
    }
  }

  async function startConnectAndPickDir(credentials?: Partial<SshProfile>): Promise<void> {
    const targetHost = credentials?.host || host;
    const targetPort = Number(credentials?.port || port) || 22;
    const targetUser = credentials?.username || username;
    const targetKey = credentials?.privateKeyPath || privateKeyPath;
    const targetPath = credentials?.remotePath || remotePath;
    const targetName = credentials?.name || profileName;

    setHost(targetHost);
    setPort(String(targetPort));
    setUsername(targetUser);
    setPrivateKeyPath(targetKey || '');
    setProfileName(targetName || '');

    setBusy(true);
    setError('');

    const result = await window.ide.sshConnect({
      host: targetHost,
      port: targetPort,
      username: targetUser,
      password: password || undefined,
      privateKeyPath: targetKey || undefined,
      passphrase: passphrase || undefined,
      remotePath: targetPath || undefined,
      saveProfile: false,
      browseOnly: true,
    });

    setBusy(false);
    if (!result.ok) {
      setError(result.detail);
      setShowForm(true);
      return;
    }

    setStep('pick_directory');
    await loadRemoteDir(targetPath || '');
  }

  async function confirmOpenWorkspace(): Promise<void> {
    if (!remotePath.trim()) return;
    setBusy(true);
    setError('');

    if (saveProfile) {
      try {
        await window.ide.saveSshProfile({
          host,
          port: Number(port) || 22,
          username,
          privateKeyPath: privateKeyPath || undefined,
          remotePath: remotePath.trim(),
          name: profileName || undefined,
        });
      } catch (err) {
        console.warn('Failed to save SSH profile:', err);
      }
    }

    const target: SwitchWorkspaceTarget = {
      path: remotePath.trim(),
      name: folderLabel,
      kind: 'ssh',
      sshServer: profileName || `${username}@${host}`,
      rawItem: {
        host,
        port: Number(port) || 22,
        username,
        password: password || undefined,
        privateKeyPath: privateKeyPath || undefined,
        passphrase: passphrase || undefined,
        remotePath: remotePath.trim(),
        saveProfile,
        profileName: profileName || undefined,
        isTempBrowse: true,
      },
    };

    if (!isSwitchingWorkspace && hasOpenWorkspace && onConfirmWorkspaceTarget) {
      setBusy(false);
      onClose();
      onConfirmWorkspaceTarget(target);
      return;
    }

    const result = await window.ide.sshConnect({
      host,
      port: Number(port) || 22,
      username,
      password: password || undefined,
      privateKeyPath: privateKeyPath || undefined,
      passphrase: passphrase || undefined,
      remotePath: remotePath.trim(),
      saveProfile,
      profileName: profileName || undefined,
      browseOnly: false,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.detail);
      return;
    }
    onConnected(result.label || result.detail);
    onClose();
  }

  async function removeProfile(id: string, e: React.MouseEvent): Promise<void> {
    e.stopPropagation();
    await window.ide.deleteSshProfile(id);
    const saved = await window.ide.listSshProfiles();
    const local = await window.ide.listLocalSshConfig();
    const merged = [...saved];
    for (const l of local) {
      if (!merged.find((m) => m.host === l.host && m.username === l.username)) {
        merged.push(l);
      }
    }
    setProfiles(merged);
  }

  const navigateParent = () => {
    if (!remotePath || remotePath === '/') return;
    const parts = remotePath.split('/').filter(Boolean);
    parts.pop();
    const parent = parts.length ? '/' + parts.join('/') : '/';
    setRemotePath(parent);
    setPathInputVal(parent);
    void loadRemoteDir(parent);
  };

  const handleClose = () => {
    if (step === 'pick_directory') {
      void window.ide.sshDisconnectBrowse?.();
    }
    onClose();
  };

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="settings-overlay">
      <div
        className={`ide-modal${step === 'pick_directory' ? ' ide-modal-dir-picker' : showForm ? ' ide-modal-md' : ''}`}
        style={step === 'pick_directory' ? { width: pickerSize.width, height: pickerSize.height } : undefined}
      >
        {step === 'credentials' ? (
          <>
            <header className="ide-modal-header">
              <div>
                <h2>SSH 远程连接</h2>
                <p className="ide-modal-desc">
                  {showForm
                    ? '填写主机与认证信息；密码不会写入磁盘'
                    : '选择已有服务器（含 ~/.ssh/config），或添加新连接'}
                </p>
              </div>
              <button
                type="button"
                className="settings-close-btn"
                onClick={handleClose}
                aria-label="关闭"
              >
                ×
              </button>
            </header>

            <div className="ide-modal-body">
              {!showForm && profiles.length > 0 && (
                <ul className="ssh-server-list">
                  {profiles.map((p) => (
                    <li key={p.id} className="ssh-server-item">
                      <button
                        type="button"
                        className="ssh-server-main"
                        onClick={() => void startConnectAndPickDir(p)}
                        disabled={busy}
                      >
                        <span className="ssh-server-name">{p.name}</span>
                        <span className="ssh-server-meta">
                          {p.username}@{p.host}:{p.port || 22}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="ssh-server-remove"
                        title="删除此配置"
                        onClick={(e) => void removeProfile(p.id, e)}
                        disabled={busy}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {showForm && (
                <div className="ide-form">
                  <div className="ide-field-grid">
                    <div className="ide-field ide-field-span-2">
                      <label htmlFor="ssh-host">主机</label>
                      <input
                        id="ssh-host"
                        value={host}
                        onChange={(e) => setHost(e.target.value)}
                        placeholder="192.168.1.10"
                        autoFocus
                      />
                    </div>
                    <div className="ide-field">
                      <label htmlFor="ssh-port">端口</label>
                      <input id="ssh-port" value={port} onChange={(e) => setPort(e.target.value)} />
                    </div>
                    <div className="ide-field">
                      <label htmlFor="ssh-user">用户名</label>
                      <input
                        id="ssh-user"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="root"
                      />
                    </div>
                    <div className="ide-field ide-field-span-2">
                      <label htmlFor="ssh-pass">密码（可选）</label>
                      <input
                        id="ssh-pass"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="会话内有效，不落盘"
                      />
                    </div>
                    <div className="ide-field ide-field-span-2">
                      <label htmlFor="ssh-key">私钥路径（可选）</label>
                      <input
                        id="ssh-key"
                        className="mono-input"
                        value={privateKeyPath}
                        onChange={(e) => setPrivateKeyPath(e.target.value)}
                        placeholder="~/.ssh/id_rsa"
                      />
                    </div>
                    <div className="ide-field">
                      <label htmlFor="ssh-phrase">私钥口令</label>
                      <input
                        id="ssh-phrase"
                        type="password"
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        placeholder="可选"
                      />
                    </div>
                    <div className="ide-field">
                      <label htmlFor="ssh-name">配置名称</label>
                      <input
                        id="ssh-name"
                        value={profileName}
                        onChange={(e) => setProfileName(e.target.value)}
                        placeholder="显示名称"
                      />
                    </div>
                  </div>
                  <label className="ide-check">
                    <input
                      type="checkbox"
                      checked={saveProfile}
                      onChange={(e) => setSaveProfile(e.target.checked)}
                    />
                    <span>保存连接配置（不含密码）</span>
                  </label>
                </div>
              )}

              {error && (
                <div className="probe-fail" style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                  <span>{error}</span>
                  {error.includes('本地网络') && (
                    <button
                      type="button"
                      className="ghost"
                      style={{ padding: '2px 8px', fontSize: 11, textDecoration: 'underline', cursor: 'pointer' }}
                      onClick={() => void window.ide.openSystemSettings?.('localNetwork')}
                    >
                      打开 macOS「系统设置 - 本地网络」
                    </button>
                  )}
                </div>
              )}
            </div>

            <footer className="ide-modal-footer">
              {!showForm && profiles.length > 0 ? (
                <>
                  <button type="button" className="ghost" onClick={handleClose} disabled={busy}>
                    取消
                  </button>
                  <button type="button" className="primary" onClick={() => setShowForm(true)}>
                    添加服务器
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => (profiles.length > 0 ? setShowForm(false) : handleClose())}
                    disabled={busy}
                  >
                    {profiles.length > 0 ? '返回列表' : '取消'}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || !host.trim() || !username.trim()}
                    onClick={() => void startConnectAndPickDir()}
                  >
                    {busy ? '连接中…' : '下一步'}
                  </button>
                </>
              )}
            </footer>
          </>
        ) : (
          <>
            <header className="ide-modal-header remote-dir-modal-header">
              <div>
                <div className="remote-dir-header-badge">
                  <span className="remote-dir-header-dot" />
                  <span className="remote-dir-header-host">
                    {username}@{host}:{port || 22}
                  </span>
                </div>
                <h2>选择远程工作区目录</h2>
                <p className="ide-modal-desc">
                  浏览选择服务器目录，或通过路径栏直接定位后作为工作区打开
                </p>
              </div>
              <button
                type="button"
                className="settings-close-btn"
                onClick={handleClose}
                aria-label="关闭"
              >
                ×
              </button>
            </header>

            <div className="ide-modal-body remote-dir-modal-body">
              <div className="remote-dir-picker">
                {/* 顶部路径栏与导航按钮 */}
                <div className="remote-dir-nav-bar">
                  <div className="remote-dir-path-box">
                    <span className="remote-dir-server-icon" title="远程主机路径">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                        <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                        <line x1="6" y1="6" x2="6.01" y2="6" />
                        <line x1="6" y1="18" x2="6.01" y2="18" />
                      </svg>
                    </span>

                    {isEditingPath ? (
                      <div className="remote-dir-edit-wrap">
                        <input
                          ref={pathInputRef}
                          value={pathInputVal}
                          onChange={(e) => setPathInputVal(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              setIsEditingPath(false);
                              void loadRemoteDir(pathInputVal);
                            } else if (e.key === 'Escape') {
                              setIsEditingPath(false);
                              setPathInputVal(remotePath);
                            }
                          }}
                          onBlur={() => setIsEditingPath(false)}
                          placeholder="/home/username/project"
                          autoFocus
                        />
                        <button
                          type="button"
                          className="remote-dir-icon-action-btn"
                          title="跳转至该路径 (Enter)"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setIsEditingPath(false);
                            void loadRemoteDir(pathInputVal);
                          }}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <polyline points="9 10 4 15 9 20" />
                            <path d="M20 4v7a4 4 0 0 1-4 4H4" />
                          </svg>
                        </button>
                      </div>
                    ) : (
                      <div
                        className="remote-dir-breadcrumbs"
                        title="双击此处或点击右侧按钮直接编辑路径"
                        onDoubleClick={() => {
                          setIsEditingPath(true);
                          setPathInputVal(remotePath);
                        }}
                      >
                        <button
                          type="button"
                          className={`remote-dir-crumb-item${remotePath === '/' ? ' current' : ''}`}
                          onClick={() => void loadRemoteDir('/')}
                          title="根目录 /"
                        >
                          /
                        </button>
                        {breadcrumbSegments.map((seg, idx) => {
                          const isLast = idx === breadcrumbSegments.length - 1;
                          return (
                            <span key={seg.path} className="remote-dir-crumb-segment">
                              <span className="remote-dir-crumb-sep">/</span>
                              <button
                                type="button"
                                className={`remote-dir-crumb-item${isLast ? ' current' : ''}`}
                                onClick={() => void loadRemoteDir(seg.path)}
                                title={seg.path}
                              >
                                {seg.name}
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    )}

                    {!isEditingPath && (
                      <button
                        type="button"
                        className="remote-dir-edit-toggle-btn"
                        onClick={() => {
                          setIsEditingPath(true);
                          setPathInputVal(remotePath);
                          setTimeout(() => pathInputRef.current?.focus(), 50);
                        }}
                        title="直接输入路径"
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                        </svg>
                      </button>
                    )}
                  </div>

                  {/* 导航工具栏按钮 */}
                  <div className="remote-dir-actions-group">
                    <button
                      type="button"
                      className="remote-dir-action-pill"
                      onClick={navigateParent}
                      disabled={dirLoading || remotePath === '/'}
                      title="返回上一级目录"
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <line x1="12" y1="19" x2="12" y2="5" />
                        <polyline points="5 12 12 5 19 12" />
                      </svg>
                      <span>上一级</span>
                    </button>
                    <button
                      type="button"
                      className="remote-dir-action-pill"
                      onClick={() => void loadRemoteDir('')}
                      disabled={dirLoading}
                      title="前往用户 Home 目录 (~)"
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                        <polyline points="9 22 9 12 15 12 15 22" />
                      </svg>
                      <span>Home</span>
                    </button>
                    <button
                      type="button"
                      className={`remote-dir-action-pill${showHidden ? ' active' : ''}`}
                      onClick={() => setShowHidden((v) => !v)}
                      title={showHidden ? '已显示隐藏文件夹，点击隐藏' : `显示隐藏文件夹 (${hiddenCount})`}
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        {showHidden ? (
                          <>
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                          </>
                        ) : (
                          <>
                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                            <line x1="1" y1="1" x2="23" y2="23" />
                          </>
                        )}
                      </svg>
                      <span>{showHidden ? '隐藏' : '显示隐藏'}</span>
                      {hiddenCount > 0 && !showHidden && (
                        <span className="remote-dir-hidden-count">{hiddenCount}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="remote-dir-action-pill icon-only"
                      onClick={() => void loadRemoteDir(remotePath)}
                      disabled={dirLoading}
                      title="刷新当前目录"
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className={dirLoading ? 'spin-anim' : ''}
                      >
                        <polyline points="23 4 23 10 17 10" />
                        <polyline points="1 20 1 14 7 14" />
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* 搜索过滤与目录计数 */}
                <div className="remote-dir-filter-bar">
                  <div className="remote-dir-search-wrap">
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                      value={filterQuery}
                      onChange={(e) => setFilterQuery(e.target.value)}
                      placeholder="快速搜索子文件夹..."
                    />
                    {filterQuery && (
                      <button
                        type="button"
                        className="remote-dir-search-clear"
                        onClick={() => setFilterQuery('')}
                        title="清除搜索"
                      >
                        ×
                      </button>
                    )}
                  </div>
                  <div className="remote-dir-count-hint">
                    <span>
                      共 {filteredDirs.length} 个子目录
                      {filterQuery && ` (匹配 ${filteredDirs.length}/${remoteDirs.length})`}
                    </span>
                    {dirLoading && <span className="remote-dir-loading-hint"> (读取中…)</span>}
                  </div>
                </div>

                {/* 目录列表 */}
                <div className="remote-dir-list-container">
                  {dirLoading && <div className="remote-dir-nav-progress" />}
                  <div className={`remote-dir-list${dirLoading ? ' is-navigating' : ''}`}>
                    {remoteDirs.length === 0 && dirLoading && (
                      <div className="remote-dir-empty-state">
                        <div className="remote-dir-spinner" />
                        <p>正在读取远程目录列表…</p>
                      </div>
                    )}
                    {(!dirLoading || remoteDirs.length > 0) && filteredDirs.length === 0 && (
                      <div className="remote-dir-empty-state">
                        <div className="remote-dir-empty-icon">
                          <svg
                            width="30"
                            height="30"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                          >
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                          </svg>
                        </div>
                        <p className="remote-dir-empty-title">
                          {filterQuery
                            ? `未找到与「${filterQuery}」匹配的文件夹`
                            : hiddenCount > 0 && !showHidden
                              ? `当前目录仅有 ${hiddenCount} 个系统/隐藏文件夹（已被隐藏）`
                              : '当前目录下无子文件夹'}
                        </p>
                        <p className="remote-dir-empty-sub">
                          {hiddenCount > 0 && !showHidden
                            ? '可点击上方「显示隐藏」查看隐藏文件夹，或直接点击下方打开此目录'
                            : '您可以直接点击下方「打开工作区」将当前路径作为工程打开'}
                        </p>
                      </div>
                    )}
                    {filteredDirs.map((dir) => {
                      const isDot = isHiddenDir(dir.name);
                      const isSelected = remotePath === dir.path;
                      return (
                        <div
                          key={dir.path}
                          className={`remote-dir-row${isSelected ? ' selected' : ''}${isDot ? ' is-hidden' : ''}`}
                          onClick={() => setRemotePath(dir.path)}
                          onDoubleClick={() => {
                            setRemotePath(dir.path);
                            void loadRemoteDir(dir.path);
                          }}
                          title={`单击选中，双击进入: ${dir.path}`}
                        >
                          <div className="remote-dir-row-left">
                            <span className="remote-dir-folder-icon">
                              <svg
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="currentColor"
                                stroke="none"
                              >
                                <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                              </svg>
                            </span>
                            <span className="remote-dir-row-name">{dir.name}</span>
                            {isDot && <span className="remote-dir-row-tag">隐藏</span>}
                          </div>
                          <div className="remote-dir-row-right">
                            <span className="remote-dir-enter-tip">双击进入</span>
                            <svg
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <polyline points="9 18 15 12 9 6" />
                            </svg>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="remote-dir-tips-bar">
                    <span className="remote-dir-tip-text">
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                      单击选中路径，双击可进入下级目录
                    </span>
                  </div>
                </div>
              </div>

              {error && (
                <div
                  className="probe-fail"
                  style={{
                    marginTop: 10,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    alignItems: 'flex-start',
                  }}
                >
                  <span>{error}</span>
                  {error.includes('本地网络') && (
                    <button
                      type="button"
                      className="ghost"
                      style={{
                        padding: '2px 8px',
                        fontSize: 11,
                        textDecoration: 'underline',
                        cursor: 'pointer',
                      }}
                      onClick={() => void window.ide.openSystemSettings?.('localNetwork')}
                    >
                      打开 macOS「系统设置 - 本地网络」
                    </button>
                  )}
                </div>
              )}
            </div>

            <footer className="ide-modal-footer remote-dir-modal-footer">
              <div className="remote-dir-footer-left">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    void window.ide.sshDisconnectBrowse?.();
                    setStep('credentials');
                  }}
                  disabled={busy}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    style={{ marginRight: 5 }}
                  >
                    <line x1="19" y1="12" x2="5" y2="12" />
                    <polyline points="12 19 5 12 12 5" />
                  </svg>
                  返回
                </button>
                <span className="remote-dir-selected-preview" title={remotePath}>
                  <span className="preview-label">目标:</span>
                  <span className="preview-path">{remotePath}</span>
                </span>
              </div>

              <div className="remote-dir-footer-right">
                <button
                  type="button"
                  className="primary remote-dir-open-btn"
                  disabled={busy || !remotePath.trim()}
                  onClick={() => void confirmOpenWorkspace()}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    style={{ marginRight: 6 }}
                  >
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  {busy ? '打开中…' : `打开「${folderLabel}」`}
                </button>
              </div>
            </footer>
            <div
              className="ide-modal-resize-handle"
              onMouseDown={handlePickerResizeStart}
              title="拖动右下角调整大小"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path
                  d="M8.5 1.5L1.5 8.5M8.5 5L5 8.5M8.5 8.5L8.5 8.51"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </svg>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
