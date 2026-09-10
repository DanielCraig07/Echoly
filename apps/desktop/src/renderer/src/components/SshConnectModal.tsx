import { useEffect, useState } from 'react';
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

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open, onClose]);

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

  if (!open) return null;

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
    const parent = '/' + parts.join('/');
    void loadRemoteDir(parent);
  };

  const folderLabel = remotePath.split('/').filter(Boolean).pop() || remotePath || '/';

  const handleClose = () => {
    if (step === 'pick_directory') {
      void window.ide.sshDisconnect();
    }
    onClose();
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="settings-overlay" onClick={handleClose}>
      <div
        className={`ide-modal${step === 'pick_directory' || showForm ? ' ide-modal-md' : ''}`}
        onClick={(e) => e.stopPropagation()}
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

              {error && <div className="probe-fail">{error}</div>}
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
            <header className="ide-modal-header">
              <div>
                <h2>选择远程目录</h2>
                <p className="ide-modal-desc">
                  已连接{' '}
                  <strong>
                    {username}@{host}
                  </strong>{' '}
                  — 选择或输入工作区路径
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
              <div className="remote-dir-picker">
                <div className="remote-dir-toolbar">
                  <div className="remote-dir-input-wrap">
                    <input
                      value={remotePath}
                      onChange={(e) => setRemotePath(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void loadRemoteDir(remotePath);
                      }}
                      placeholder="/home/username/project"
                    />
                  </div>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void loadRemoteDir(remotePath)}
                    disabled={dirLoading}
                  >
                    跳转
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={navigateParent}
                    disabled={dirLoading || remotePath === '/'}
                    title="上一级"
                  >
                    上一级
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void loadRemoteDir('')}
                    disabled={dirLoading}
                    title="主目录"
                  >
                    Home
                  </button>
                </div>

                <div className="remote-dir-list">
                  {dirLoading && <div className="remote-dir-empty">正在读取远程目录…</div>}
                  {!dirLoading && remoteDirs.length === 0 && (
                    <div className="remote-dir-empty">当前目录下无子文件夹，可直接打开此路径</div>
                  )}
                  {!dirLoading &&
                    remoteDirs.map((dir) => (
                      <button
                        type="button"
                        key={dir.path}
                        className={`remote-dir-item${remotePath === dir.path ? ' selected' : ''}`}
                        onClick={() => setRemotePath(dir.path)}
                        onDoubleClick={() => {
                          setRemotePath(dir.path);
                          void loadRemoteDir(dir.path);
                        }}
                      >
                        <span className="remote-dir-item-name">{dir.name}</span>
                        <span className="remote-dir-item-path">{dir.path}</span>
                      </button>
                    ))}
                </div>
              </div>

              {error && <div className="probe-fail">{error}</div>}
            </div>

            <footer className="ide-modal-footer">
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  void window.ide.sshDisconnect();
                  setStep('credentials');
                }}
                disabled={busy}
              >
                返回
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || !remotePath.trim()}
                onClick={() => void confirmOpenWorkspace()}
              >
                {busy ? '打开中…' : `打开「${folderLabel}」`}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
