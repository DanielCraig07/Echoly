import { useEffect, useState, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { RemoteDirEntry, SshProfile } from '@deepseek-ide/shared';
import type { SwitchWorkspaceTarget } from './SwitchWorkspaceModal';
import { useDbConfirm } from '../hooks/useDbConfirm';
import { buildSqlConfirmMarkdown } from '../services/dbConfirmContent';
import { useI18n } from '../i18n';

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

import { useModalResize, ModalResizeHandle } from '../hooks/useModalResize';

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
  const { t } = useI18n();
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_ssh_modal_size',
    defaultWidth: 760,
    defaultHeight: 600,
    minWidth: 520,
    minHeight: 420,
  });
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
  /**
   * 本次失败是不是「macOS 本地网络未授权」。由主进程给标志位，**不能**从 `error`
   * 文案里找关键词：那句话是给人看的，改一次措辞或在英文下就匹配不上，
   * 「打开系统设置」这个补救入口会静默消失，用户只看到一句干巴巴的失败。
   */
  const [needsLocalNetwork, setNeedsLocalNetwork] = useState(false);
  const [showForm, setShowForm] = useState(false);
  // 删除确认走应用内弹窗（理由见 removeProfile 的注释）
  const confirm = useDbConfirm();

  const [remoteDirs, setRemoteDirs] = useState<RemoteDirEntry[]>([]);
  const [dirLoading, setDirLoading] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [pathInputVal, setPathInputVal] = useState('');
  const pathInputRef = useRef<HTMLInputElement>(null);

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
    setNeedsLocalNetwork(false);
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
    setNeedsLocalNetwork(false);
    const res = await window.ide.listRemoteDir(pathOrEmpty);
    setDirLoading(false);
    if (!res.ok) {
      setError(res.detail || t('ssh.loadDirFailed'));
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
    setNeedsLocalNetwork(false);

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
      setNeedsLocalNetwork(result.needsLocalNetwork === true);
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
    setNeedsLocalNetwork(false);

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
      setNeedsLocalNetwork(result.needsLocalNetwork === true);
      return;
    }
    onConnected(result.label || result.detail);
    onClose();
  }

  /**
   * 删除一条已保存的 SSH 配置。
   *
   * 配置里的主机 / 用户名 / 密钥路径都是用户手工填的，删掉就得重填，所以先确认。
   * 确认框里点名是哪一台：列表里同一台机器的不同账号、或同一账号的不同端口
   * 在界面上只差最后几个字符。
   */
  async function removeProfile(id: string, e: React.MouseEvent): Promise<void> {
    e.stopPropagation();
    const target = profiles.find((p) => p.id === id);
    const ok = await confirm.confirm({
      title: t('ssh.deleteTitle'),
      content: buildSqlConfirmMarkdown({
        t,
        intro: t('ssh.deleteIntro'),
        statements: [],
      }),
      details: [
        {
          label: t('ssh.detailHost'),
          value: `${target?.host ?? t('ssh.unknown')}:${target?.port || 22}`,
        },
        { label: t('ssh.detailUser'), value: target?.username || t('ssh.notSpecified') },
      ],
      tone: 'danger',
      confirmLabel: t('ssh.confirmDelete'),
    });
    if (ok === null) return;
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
        style={{
          width: modalSize.width,
          height: modalSize.height,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {step === 'credentials' ? (
          <>
            <header className="ide-modal-header">
              <div>
                <h2>{t('ssh.title')}</h2>
                <p className="ide-modal-desc">{showForm ? t('ssh.descForm') : t('ssh.descList')}</p>
              </div>
              <button
                type="button"
                className="panel-action-btn"
                onClick={handleClose}
                title={t('common.closeEsc')}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </header>

            <div
              className="ide-modal-body"
              style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
            >
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
                        <div
                          style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}
                        >
                          <div
                            style={{
                              width: 32,
                              height: 32,
                              borderRadius: 7,
                              background: 'rgba(255, 255, 255, 0.06)',
                              color: 'var(--accent, #007acc)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                              border: '1px solid rgba(255, 255, 255, 0.1)',
                            }}
                          >
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                              <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                              <line x1="6" y1="6" x2="6.01" y2="6" />
                              <line x1="6" y1="18" x2="6.01" y2="18" />
                            </svg>
                          </div>
                          <div
                            style={{
                              flex: 1,
                              minWidth: 0,
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 2,
                            }}
                          >
                            <span className="ssh-server-name">{p.name}</span>
                            <span className="ssh-server-meta">
                              {p.username}@{p.host}
                            </span>
                          </div>
                          <span
                            style={{
                              fontSize: 10.5,
                              fontFamily: 'var(--font-mono, monospace)',
                              color: 'var(--muted, #888)',
                              background: 'rgba(255, 255, 255, 0.06)',
                              padding: '2px 7px',
                              borderRadius: 4,
                              border: '1px solid rgba(255, 255, 255, 0.08)',
                              flexShrink: 0,
                            }}
                          >
                            :{p.port || 22}
                          </span>
                        </div>
                      </button>
                      <button
                        type="button"
                        className="ssh-server-remove"
                        title={t('ssh.removeProfileTitle')}
                        onClick={(e) => void removeProfile(p.id, e)}
                        disabled={busy}
                      >
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {showForm && (
                <div className="ide-form">
                  <div className="ide-field-grid">
                    <div className="ide-field ide-field-span-2">
                      <label htmlFor="ssh-host">{t('ssh.host')}</label>
                      <input
                        id="ssh-host"
                        value={host}
                        onChange={(e) => setHost(e.target.value)}
                        placeholder="192.168.1.10"
                        autoFocus
                      />
                    </div>
                    <div className="ide-field">
                      <label htmlFor="ssh-port">{t('ssh.port')}</label>
                      <input id="ssh-port" value={port} onChange={(e) => setPort(e.target.value)} />
                    </div>
                    <div className="ide-field">
                      <label htmlFor="ssh-user">{t('ssh.username')}</label>
                      <input
                        id="ssh-user"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="root"
                      />
                    </div>
                    <div className="ide-field ide-field-span-2">
                      <label htmlFor="ssh-pass">{t('ssh.password')}</label>
                      <input
                        id="ssh-pass"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder={t('ssh.passwordPh')}
                      />
                    </div>
                    <div className="ide-field ide-field-span-2">
                      <label htmlFor="ssh-key">{t('ssh.keyPath')}</label>
                      <input
                        id="ssh-key"
                        className="mono-input"
                        value={privateKeyPath}
                        onChange={(e) => setPrivateKeyPath(e.target.value)}
                        placeholder="~/.ssh/id_rsa"
                      />
                    </div>
                    <div className="ide-field">
                      <label htmlFor="ssh-phrase">{t('ssh.passphrase')}</label>
                      <input
                        id="ssh-phrase"
                        type="password"
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        placeholder={t('ssh.optional')}
                      />
                    </div>
                    <div className="ide-field">
                      <label htmlFor="ssh-name">{t('ssh.profileName')}</label>
                      <input
                        id="ssh-name"
                        value={profileName}
                        onChange={(e) => setProfileName(e.target.value)}
                        placeholder={t('ssh.profileNamePh')}
                      />
                    </div>
                  </div>
                  <label className="ide-check">
                    <input
                      type="checkbox"
                      checked={saveProfile}
                      onChange={(e) => setSaveProfile(e.target.checked)}
                    />
                    <span>{t('ssh.saveProfile')}</span>
                  </label>
                </div>
              )}

              {error && (
                <div
                  className="probe-fail"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    alignItems: 'flex-start',
                  }}
                >
                  <span>{error}</span>
                  {needsLocalNetwork && (
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
                      {t('ssh.openMacSettings')}
                    </button>
                  )}
                </div>
              )}
            </div>

            <footer className="ide-modal-footer">
              {!showForm && profiles.length > 0 ? (
                <>
                  <button type="button" className="ghost" onClick={handleClose} disabled={busy}>
                    {t('ssh.cancel')}
                  </button>
                  <button type="button" className="primary" onClick={() => setShowForm(true)}>
                    {t('ssh.addServer')}
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
                    {profiles.length > 0 ? t('ssh.backToList') : t('ssh.cancel')}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || !host.trim() || !username.trim()}
                    onClick={() => void startConnectAndPickDir()}
                  >
                    {busy ? t('ssh.connecting') : t('ssh.next')}
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
                <h2>{t('ssh.pickDirTitle')}</h2>
                <p className="ide-modal-desc">{t('ssh.pickDirDesc')}</p>
              </div>
              <button
                type="button"
                className="panel-action-btn"
                onClick={handleClose}
                title={t('common.closeEsc')}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </header>

            <div className="ide-modal-body remote-dir-modal-body">
              <div className="remote-dir-picker">
                {/* 顶部路径栏与导航按钮 */}
                <div className="remote-dir-nav-bar">
                  <div className="remote-dir-path-box">
                    <span className="remote-dir-server-icon" title={t('ssh.remoteHostPath')}>
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
                          title={t('ssh.gotoPathTitle')}
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
                        title={t('ssh.editPathHint')}
                        onDoubleClick={() => {
                          setIsEditingPath(true);
                          setPathInputVal(remotePath);
                        }}
                      >
                        <button
                          type="button"
                          className={`remote-dir-crumb-item${remotePath === '/' ? ' current' : ''}`}
                          onClick={() => void loadRemoteDir('/')}
                          title={t('ssh.rootDir')}
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
                        title={t('ssh.inputPathTitle')}
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
                      title={t('ssh.parentDirTitle')}
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
                      <span>{t('ssh.parentDir')}</span>
                    </button>
                    <button
                      type="button"
                      className="remote-dir-action-pill"
                      onClick={() => void loadRemoteDir('')}
                      disabled={dirLoading}
                      title={t('ssh.homeTitle')}
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
                      title={
                        showHidden
                          ? t('ssh.showHiddenTitleOff')
                          : t('ssh.showHiddenTitleOn', { n: hiddenCount })
                      }
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
                      <span>{showHidden ? t('ssh.hide') : t('ssh.showHidden')}</span>
                      {hiddenCount > 0 && !showHidden && (
                        <span className="remote-dir-hidden-count">{hiddenCount}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="remote-dir-action-pill icon-only"
                      onClick={() => void loadRemoteDir(remotePath)}
                      disabled={dirLoading}
                      title={t('ssh.refreshDirTitle')}
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
                      placeholder={t('ssh.filterPh')}
                    />
                    {filterQuery && (
                      <button
                        type="button"
                        className="remote-dir-search-clear"
                        onClick={() => setFilterQuery('')}
                        title={t('ssh.clearSearch')}
                      >
                        ×
                      </button>
                    )}
                  </div>
                  <div className="remote-dir-count-hint">
                    <span>
                      {t('ssh.dirCount', { n: filteredDirs.length })}
                      {filterQuery
                        ? t('ssh.dirCountMatch', {
                            matched: filteredDirs.length,
                            total: remoteDirs.length,
                          })
                        : ''}
                    </span>
                    {dirLoading && (
                      <span className="remote-dir-loading-hint">{t('ssh.reading')}</span>
                    )}
                  </div>
                </div>

                {/* 目录列表 */}
                <div className="remote-dir-list-container">
                  {dirLoading && <div className="remote-dir-nav-progress" />}
                  <div className={`remote-dir-list${dirLoading ? ' is-navigating' : ''}`}>
                    {remoteDirs.length === 0 && dirLoading && (
                      <div className="remote-dir-empty-state">
                        <div className="remote-dir-spinner" />
                        <p>{t('ssh.readingList')}</p>
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
                            ? t('ssh.emptyFiltered', { q: filterQuery })
                            : hiddenCount > 0 && !showHidden
                              ? t('ssh.emptyHidden', { n: hiddenCount })
                              : t('ssh.emptyDir')}
                        </p>
                        <p className="remote-dir-empty-sub">
                          {hiddenCount > 0 && !showHidden
                            ? t('ssh.emptySubHidden')
                            : t('ssh.emptySub')}
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
                          title={t('ssh.rowTitle', { path: dir.path })}
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
                            {isDot && (
                              <span className="remote-dir-row-tag">{t('ssh.rowTagHidden')}</span>
                            )}
                          </div>
                          <div className="remote-dir-row-right">
                            <span className="remote-dir-enter-tip">{t('ssh.dblClickEnter')}</span>
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
                      {t('ssh.tipBar')}
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
                  {needsLocalNetwork && (
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
                      {t('ssh.openMacSettings')}
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
                  {t('ssh.back')}
                </button>
                <span className="remote-dir-selected-preview" title={remotePath}>
                  <span className="preview-label">{t('ssh.target')}</span>
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
                  {busy ? t('ssh.opening') : t('ssh.openBtn', { name: folderLabel })}
                </button>
              </div>
            </footer>
          </>
        )}
        {/* 全向拖拽调整手柄 */}
        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
      {/* 确认弹窗放在 overlay 的子 div 之外：overlay 自带「点外部即关闭」，
          弹窗的遮罩若落在它里面，点遮罩会连带把整个 SSH 窗口一起关掉 */}
      {confirm.modal}
    </div>,
    document.body,
  );
}
