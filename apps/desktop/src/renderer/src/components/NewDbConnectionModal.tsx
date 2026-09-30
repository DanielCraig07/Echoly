import React, { useEffect, useState } from 'react';
import type { DatabaseConnectionInfo, DbSavedConnection } from '@deepseek-ide/shared';
import { useModalResize, ModalResizeHandle, createSafeOverlayHandlers } from '../hooks/useModalResize';
import {
  DEFAULT_PORTS,
  defaultPortFor,
  resolvePort,
  validateDbConnection,
  type DbDriverType,
} from '../services/dbConnectionForm';

export interface NewDbConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnected: (conn: DatabaseConnectionInfo) => void;
  /** 编辑已有连接保存成功后回调（参数为保存后的配置） */
  onSaved?: (conn: DbSavedConnection) => void;
  /** 传入则为「编辑连接」模式；为空则是「新建连接」 */
  editing?: DbSavedConnection | null;
  onShowToast?: (title: string, detail?: string, type?: 'success' | 'error' | 'info' | 'warn') => void;
}

const TYPE_LABEL: Record<DbDriverType, string> = {
  sqlite: 'SQLite',
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
};

export function NewDbConnectionModal({
  isOpen,
  onClose,
  onConnected,
  onSaved,
  editing,
  onShowToast,
}: NewDbConnectionModalProps) {
  const [driver, setDriver] = useState<DbDriverType>('sqlite');
  const [name, setName] = useState<string>('');

  // SQLite fields
  const [sqlitePath, setSqlitePath] = useState<string>('');

  // Client-server DB fields (MySQL / Postgres)
  const [host, setHost] = useState<string>('localhost');
  // 端口直接预填驱动默认值（用户要求「默认显示」而非占位符提示）。
  // 预填不等于锁死：清空后 resolvePort 仍会兜底成默认端口，用户可以自由改。
  const [port, setPort] = useState<string>(String(DEFAULT_PORTS.mysql));
  const [database, setDatabase] = useState<string>('');
  const [username, setUsername] = useState<string>('root');
  const [password, setPassword] = useState<string>('');

  const [testing, setTesting] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [connecting, setConnecting] = useState<boolean>(false);

  const isEditing = Boolean(editing);

  // 打开时按 editing 预填。密码刻意**不回填真实值**（它在主进程里是密文，渲染层拿不到明文），
  // 留空即表示「保持已保存的密码不变」。
  useEffect(() => {
    if (!isOpen) return;
    setTestResult(null);
    setPassword('');
    if (editing) {
      setDriver(editing.type);
      setName(editing.name || '');
      setSqlitePath(editing.path || '');
      setHost(editing.host || 'localhost');
      setPort(
        editing.port != null ? String(editing.port) : defaultPortFor(editing.type),
      );
      setDatabase(editing.database || '');
      // 用户名统一默认 root（不再按驱动切换成 postgres），历史连接没存用户名时也回落到 root
      setUsername(editing.user || 'root');
    } else {
      setDriver('sqlite');
      setName('');
      setSqlitePath('');
      setHost('localhost');
      setPort(defaultPortFor('sqlite'));
      setDatabase('');
      setUsername('root');
    }
  }, [isOpen, editing]);

  // 模态框尺寸与右下角拖拽支持（默认 540x510，防止切换时高度跳跃）
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly:new_db_connection_modal_size',
    defaultWidth: 540,
    defaultHeight: 520,
    minWidth: 460,
    minHeight: 440,
  });

  const overlayHandlers = createSafeOverlayHandlers(onClose);

  if (!isOpen) return null;

  // 浏览选择本地 SQLite 文件
  const handleBrowseSqlite = async () => {
    if (!window.ide?.pickFile) return;
    try {
      const filePath = await window.ide.pickFile([
        { name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
        { name: 'All Files', extensions: ['*'] },
      ]);
      if (filePath) {
        setSqlitePath(filePath);
        if (!name) {
          const fileName = filePath.split('/').pop()?.split('\\').pop() || 'SQLite DB';
          setName(fileName);
        }
      }
    } catch (err: any) {
      onShowToast?.('选择文件失败', err.message || String(err), 'error');
    }
  };

  // 一键生成 Demo 示例库
  const handleGenerateDemo = async () => {
    if (!window.ide?.dbCreateDemoDb) return;
    try {
      setConnecting(true);
      const res = await window.ide.dbCreateDemoDb();
      if (res.ok && res.connection) {
        onShowToast?.('Demo 数据库已就绪', res.path, 'success');
        onConnected(res.connection);
        onClose();
      } else {
        onShowToast?.('创建 Demo 数据库失败', res.error, 'error');
      }
    } catch (err: any) {
      onShowToast?.('操作异常', err.message || String(err), 'error');
    } finally {
      setConnecting(false);
    }
  };

  // 表单校验（端口留空用默认值、非法值给中文提示）
  const validate = (): boolean => {
    const res = validateDbConnection({ driver, sqlitePath, host, port, database, username });
    if (!res.ok) {
      setTestResult({ ok: false, msg: res.error || '表单校验未通过' });
      return false;
    }
    return true;
  };

  // 真实测试连接 (支持 SQLite / MySQL / PostgreSQL)
  // 刻意不传 name：connect 只在拿到 name 或 savedId 时才把配置写进项目，测试连接不该留下垃圾配置。
  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);

    try {
      if (!validate()) return;

      const res = await window.ide?.dbConnect({
        type: driver === 'sqlite' ? 'sqlite' : driver,
        path: driver === 'sqlite' ? sqlitePath.trim() : undefined,
        host: driver === 'sqlite' ? undefined : host.trim(),
        port: driver === 'sqlite' ? undefined : resolvePort(driver, port),
        database: driver === 'sqlite' ? undefined : database.trim() || undefined,
        user: driver === 'sqlite' ? undefined : username.trim(),
        password: driver === 'sqlite' ? undefined : password || undefined,
      });

      if (res && res.ok && res.connection) {
        setTestResult({ ok: true, msg: `${TYPE_LABEL[driver]} 连接测试成功` });
        void window.ide?.dbDisconnect(res.connection.id);
      } else {
        setTestResult({ ok: false, msg: res?.error || `${TYPE_LABEL[driver]} 连接失败` });
      }
    } catch (err: any) {
      setTestResult({ ok: false, msg: err.message || String(err) });
    } finally {
      setTesting(false);
    }
  };

  // 保存并连接：先落盘配置（跟随项目），再用保存的配置连上
  const handleSaveAndConnect = async () => {
    if (!validate()) return;
    try {
      setConnecting(true);

      const saveRes = await window.ide?.dbSaveConnection({
        id: editing?.id,
        type: driver,
        name: name.trim() || `Test ${TYPE_LABEL[driver]}`,
        path: driver === 'sqlite' ? sqlitePath.trim() : undefined,
        host: driver === 'sqlite' ? undefined : host.trim(),
        port: driver === 'sqlite' ? undefined : resolvePort(driver, port),
        database: driver === 'sqlite' ? undefined : database.trim() || undefined,
        user: driver === 'sqlite' ? undefined : username.trim(),
        // 编辑时留空 = 保持已保存的密码不变（undefined 语义），不传空串把它清掉
        password: password ? password : undefined,
      });

      if (!saveRes?.ok || !saveRes.connection) {
        onShowToast?.('保存连接配置失败', saveRes?.error, 'error');
        return;
      }

      const saved = saveRes.connection;
      onSaved?.(saved);

      const res = await window.ide?.dbConnectSaved(saved.id);
      if (res && res.ok && res.connection) {
        onShowToast?.(`数据库「${res.connection.name}」已连接`, undefined, 'success');
        onConnected(res.connection);
        onClose();
      } else {
        // 配置已保存成功，只是这次连不上：不要关弹窗，让用户改完参数重试
        onShowToast?.('连接失败（配置已保存到项目）', res?.error, 'error');
      }
    } catch (err: any) {
      onShowToast?.('操作异常', err.message || String(err), 'error');
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      {...overlayHandlers}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.65)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
      }}
    >
      <div
        className="modal-container"
        style={{
          width: modalSize.width,
          height: modalSize.height,
          position: 'relative',
          background: 'var(--bg-panel, #1e1e1e)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.5)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部标题 */}
        <div
          style={{
            padding: '12px 18px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'rgba(255, 255, 255, 0.02)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>🗄️</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
              {isEditing ? '编辑数据库连接 (Edit Connection)' : '新建数据库连接 (Database Connection)'}
            </span>
          </div>
          <button
            type="button"
            className="panel-action-btn"
            onClick={onClose}
            title="关闭 (Esc)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* 主体表单（高度自适应滚动，杜绝因选择 SQLite 产生高度跳变） */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {/* 驱动类型选择 */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>
              数据库驱动类型 (Driver Type)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {[
                { type: 'sqlite' as const, label: 'SQLite', icon: '🪶', desc: '本地嵌入式 (免安装)' },
                { type: 'mysql' as const, label: 'MySQL', icon: '🐬', desc: '标准关系型服务' },
                { type: 'postgres' as const, label: 'PostgreSQL', icon: '🐘', desc: '高级对象关系型' },
              ].map((item) => (
                <div
                  key={item.type}
                  onClick={() => {
                    setDriver(item.type);
                    setTestResult(null);
                    // 切换驱动时把端口重置为该驱动的默认值（直接显示，不做占位符提示）；
                    // 用户名保持 root，不再跟着驱动变。
                    setPort(defaultPortFor(item.type));
                  }}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 6,
                    border: `1.5px solid ${driver === item.type ? 'var(--accent, #3b82f6)' : 'var(--border)'}`,
                    background: driver === item.type ? 'rgba(59, 130, 246, 0.12)' : 'rgba(255, 255, 255, 0.02)',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    transition: 'border-color 0.15s ease, background 0.15s ease',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>{item.icon}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                      {item.label}
                    </span>
                  </div>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{item.desc}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 连接名称 */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
              连接显示名称 (Connection Name)
            </div>
            <input
              type="text"
              placeholder={driver === 'sqlite' ? '例如: Main SQLite DB' : driver === 'postgres' ? 'postgresql' : 'mysql'}
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                background: 'var(--bg-editor, #141414)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '6px 8px',
                fontSize: 12,
                outline: 'none',
              }}
            />
          </div>

          {/* 驱动专属配置区（设置固定最小高度 160px，切换时完全平稳不跳变） */}
          <div style={{ minHeight: 160, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start' }}>
            {/* SQLite 表单 */}
            {driver === 'sqlite' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>
                      SQLite 文件路径 (*.db / *.sqlite / *.sqlite3)
                    </span>
                    <button
                      type="button"
                      onClick={handleGenerateDemo}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#60a5fa',
                        fontSize: 11,
                        cursor: 'pointer',
                        textDecoration: 'underline',
                        padding: 0,
                      }}
                    >
                      一键创建 Demo 示例库
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="text"
                      placeholder="/Users/example/project/app.db"
                      value={sqlitePath}
                      onChange={(e) => setSqlitePath(e.target.value)}
                      style={{
                        flex: 1,
                        background: 'var(--bg-editor, #141414)',
                        color: 'var(--text)',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        padding: '6px 8px',
                        fontSize: 12,
                        fontFamily: 'var(--font-mono, monospace)',
                        outline: 'none',
                      }}
                    />
                    <button
                      type="button"
                      onClick={handleBrowseSqlite}
                      style={{
                        background: 'rgba(255, 255, 255, 0.08)',
                        color: 'var(--text)',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        padding: '0 12px',
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      浏览...
                    </button>
                  </div>
                </div>

                <div
                  style={{
                    padding: '12px 14px',
                    borderRadius: 6,
                    background: 'rgba(59, 130, 246, 0.06)',
                    border: '1px solid rgba(59, 130, 246, 0.15)',
                    fontSize: 11.5,
                    color: 'var(--text-muted)',
                    lineHeight: 1.5,
                  }}
                >
                  💡 <strong>提示：</strong>系统内置零编译原生 SQLite 引擎。可直接连接项目已有的 SQLite 数据库文件，无需启动任何后台数据库服务。
                </div>
              </div>
            )}

            {/* MySQL / Postgres 表单 */}
            {driver !== 'sqlite' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr', gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>主机 (Host)</div>
                    <input
                      type="text"
                      placeholder="127.0.0.1 或 192.168.x.x"
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        background: 'var(--bg-editor, #141414)',
                        color: 'var(--text)',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        padding: '5px 8px',
                        fontSize: 12,
                        outline: 'none',
                      }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>端口 (Port)</div>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        background: 'var(--bg-editor, #141414)',
                        color: 'var(--text)',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        padding: '5px 8px',
                        fontSize: 12,
                        outline: 'none',
                      }}
                    />
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>
                    数据库名 (Database){driver === 'postgres' ? ' *' : ''}
                  </div>
                  <input
                    type="text"
                    placeholder="例如: tsingtec 或 test"
                    value={database}
                    onChange={(e) => setDatabase(e.target.value)}
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      background: 'var(--bg-editor, #141414)',
                      color: 'var(--text)',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                      padding: '5px 8px',
                      fontSize: 12,
                      outline: 'none',
                    }}
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>用户名 (Username)</div>
                    <input
                      type="text"
                      placeholder="root"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        background: 'var(--bg-editor, #141414)',
                        color: 'var(--text)',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        padding: '5px 8px',
                        fontSize: 12,
                        outline: 'none',
                      }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>密码 (Password)</div>
                    <input
                      type="password"
                      placeholder={isEditing ? '已保存，留空则保持不变' : '••••••••'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        background: 'var(--bg-editor, #141414)',
                        color: 'var(--text)',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        padding: '5px 8px',
                        fontSize: 12,
                        outline: 'none',
                      }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 保存位置提示：配置跟项目走，但**不写进项目里** —— 落在用户主目录的
              ~/.echoly/projects/<项目哈希>/ 下，所以这里只报项目，不报路径全名
              （哈希目录对用户没有意义，需要时去 ~/.echoly/projects/ 看 project.json）*/}
          {driver !== 'sqlite' && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              🔐 连接信息（含密码）会与当前项目绑定保存到本机的{' '}
              <code style={{ fontFamily: 'var(--font-mono, monospace)' }}>~/.echoly/projects/</code>{' '}
              下，<strong style={{ color: 'var(--text)' }}>不会写入项目目录</strong>
              ，因此也不会被提交到版本库。
            </div>
          )}

          {/* 测试连接反馈 */}
          {testResult && (
            <div
              style={{
                padding: '7px 12px',
                borderRadius: 5,
                fontSize: 11.5,
                background: testResult.ok ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                color: testResult.ok ? '#34d399' : '#f87171',
                border: `1px solid ${testResult.ok ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
              }}
            >
              {testResult.ok ? '✓ ' : '✕ '} {testResult.msg}
            </div>
          )}
        </div>

        {/* 底部按钮栏 */}
        <div
          style={{
            padding: '10px 18px',
            borderTop: '1px solid var(--border)',
            background: 'rgba(255, 255, 255, 0.02)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={handleTestConnection}
            disabled={testing}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              borderRadius: 5,
              background: 'rgba(255, 255, 255, 0.06)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              cursor: testing ? 'not-allowed' : 'pointer',
            }}
          >
            {testing ? '测试中...' : '测试连接 (Test)'}
          </button>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '6px 12px',
                fontSize: 12,
                borderRadius: 5,
                background: 'transparent',
                color: 'var(--text-muted)',
                border: '1px solid var(--border)',
                cursor: 'pointer',
              }}
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSaveAndConnect}
              disabled={connecting}
              style={{
                padding: '6px 16px',
                fontSize: 12,
                borderRadius: 5,
                background: 'var(--accent, #3b82f6)',
                color: '#fff',
                border: 'none',
                cursor: connecting ? 'not-allowed' : 'pointer',
                fontWeight: 600,
              }}
            >
              {connecting ? '连接中...' : isEditing ? '保存并连接' : '确定连接'}
            </button>
          </div>
        </div>

        {/* 右下角拖动调整尺寸手柄 */}
        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>
  );
}
