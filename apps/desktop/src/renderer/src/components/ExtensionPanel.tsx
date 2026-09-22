/**
 * Extension Panel - 现代扩展与插件管理面板
 * 用于安装、管理和控制 VSCode / Claude 等核心扩展生态
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useModalResize, ModalResizeHandle, createSafeOverlayHandlers } from '../hooks/useModalResize';

export interface ExtensionPanelProps {
  onOpenExtension?: (extensionId: string) => void;
  onClose?: () => void;
}

export interface ExtensionModalProps {
  open: boolean;
  onClose: () => void;
  onOpenExtension: (extensionId: string) => void;
}

declare global {
  interface Window {
    extensions: {
      installClaudeCode(): Promise<{ success: boolean; error?: string }>;
      loadFromPath(extensionPath: string): Promise<{ success: boolean; error?: string }>;
      executeCommand(
        command: string,
        ...args: any[]
      ): Promise<{ success: boolean; result?: any; error?: string }>;
      getLoadedExtensions(): Promise<{ success: boolean; extensions?: string[] }>;
      onCommand(callback: (data: { command: string; args: any[] }) => void): () => void;
      onMessage(callback: (message: any) => void): () => void;
    };
  }
}

export function ExtensionPanel({ onOpenExtension }: ExtensionPanelProps = {}) {
  const [loading, setLoading] = useState(false);
  const [extensions, setExtensions] = useState<string[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{
    percent: number;
    downloaded: number;
    total: number;
  } | null>(null);

  const loadExtensions = useCallback(async () => {
    try {
      if (!window.extensions?.getLoadedExtensions) return;
      const result = await window.extensions.getLoadedExtensions();
      if (result.success && result.extensions) {
        setExtensions(result.extensions);
      }
    } catch (err: any) {
      console.error('Failed to load extensions:', err);
    }
  }, []);

  useEffect(() => {
    void loadExtensions();

    const cleanup1 = window.extensions?.onMessage?.((message) => {
      setMessages((prev) => [...prev.slice(-19), message]);
    }) || (() => {});

    const cleanup2 = window.extensions?.onCommand?.((data) => {
      console.log('Extension command:', data);
    }) || (() => {});

    const cleanup3 =
      window.ide?.onDownloadProgress?.((progress) => {
        setDownloadProgress(progress);
      }) || (() => {});

    return () => {
      cleanup1();
      cleanup2();
      cleanup3();
    };
  }, [loadExtensions]);

  const handleInstallClaudeCode = async () => {
    setLoading(true);
    setError(null);
    setSuccessMsg(null);
    setDownloadProgress(null);
    try {
      const result = await window.extensions.installClaudeCode();
      if (result.success) {
        await loadExtensions();
        setSuccessMsg('Claude Code 官方扩展安装就绪！');
      } else {
        setError(result.error || '安装失败');
      }
    } catch (err: any) {
      setError(err.message || '安装过程中发生异常');
    } finally {
      setLoading(false);
      setDownloadProgress(null);
    }
  };

  const handleLoadFromPath = async () => {
    setLoading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const filePath = await window.ide.pickFile([{ name: 'VSCode 扩展包', extensions: ['vsix'] }]);
      if (!filePath) {
        setLoading(false);
        return;
      }

      const result = await window.extensions.loadFromPath(filePath);
      if (result.success) {
        await loadExtensions();
        setSuccessMsg(`扩展包「${filePath.split(/[/\\\\]/).pop()}」加载成功！`);
      } else {
        setError(result.error || '加载本地扩展包失败');
      }
    } catch (err: any) {
      setError(err.message || '加载扩展时出错');
    } finally {
      setLoading(false);
    }
  };

  const isClaudeInstalled = extensions.includes('Anthropic.claude-code');

  return (
    <div className="ext-panel-container">
      {/* 提示横幅 */}
      {error && (
        <div className="ext-alert ext-alert-error">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{error}</span>
          <button type="button" className="ext-alert-close" onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {successMsg && (
        <div className="ext-alert ext-alert-success">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <span>{successMsg}</span>
          <button type="button" className="ext-alert-close" onClick={() => setSuccessMsg(null)}>✕</button>
        </div>
      )}

      {/* 特色官方扩展 Hero 卡片 */}
      <div className="ext-hero-card">
        <div className="ext-hero-left">
          <div className="ext-brand-avatar">
            <span style={{ fontSize: 24 }}>⚡</span>
          </div>
          <div>
            <div className="ext-hero-title-row">
              <span className="ext-hero-title">Claude Code for VS Code</span>
              <span className="ext-pill ext-pill-official">官方推荐</span>
              {isClaudeInstalled && <span className="ext-pill ext-pill-active">✓ 已安装</span>}
            </div>
            <p className="ext-hero-desc">
              深度整合 Anthropic 官方 Agent 编程助手，提供终端交互、代码重构与实时工程分析能力
            </p>
          </div>
        </div>

        <div className="ext-hero-actions">
          {isClaudeInstalled ? (
            <button
              type="button"
              className="panel-standard-btn primary"
              onClick={() => onOpenExtension?.('Anthropic.claude-code')}
            >
              打开扩展
            </button>
          ) : (
            <button
              type="button"
              className="panel-standard-btn primary"
              onClick={handleInstallClaudeCode}
              disabled={loading}
            >
              {loading ? '安装中…' : '一键在线安装'}
            </button>
          )}
        </div>
      </div>

      {/* 下载进度条 */}
      {downloadProgress && (
        <div className="ext-progress-card">
          <div className="ext-progress-header">
            <span style={{ fontWeight: 600 }}>正在下载扩展组件…</span>
            <span className="ext-progress-stat">
              {downloadProgress.percent.toFixed(1)}% (
              {(downloadProgress.downloaded / 1024 / 1024).toFixed(1)}MB /
              {(downloadProgress.total / 1024 / 1024).toFixed(1)}MB)
            </span>
          </div>
          <div className="ext-progress-track">
            <div className="ext-progress-bar" style={{ width: `${downloadProgress.percent}%` }} />
          </div>
        </div>
      )}

      {/* 本地 VSIX 加载入口卡片 */}
      <div className="ext-install-local-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="ext-local-icon">📦</div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)' }}>
              本地安装离线扩展包 (.vsix)
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
              支持直接从磁盘选取已下载的 VSCode 插件安装包导入运行
            </div>
          </div>
        </div>
        <button
          type="button"
          className="panel-standard-btn"
          onClick={handleLoadFromPath}
          disabled={loading}
        >
          从路径载入…
        </button>
      </div>

      {/* 已安装扩展列表 */}
      <div className="ext-section">
        <div className="ext-section-header">
          <span className="ext-section-title">已安装的扩展</span>
          <span className="ext-section-count">({extensions.length})</span>
        </div>

        {extensions.length === 0 ? (
          <div className="ext-empty-placeholder">
            <span style={{ fontSize: 26, opacity: 0.5 }}>🧩</span>
            <span>暂未载入任何第三方扩展包，点击上方按钮即可一键添加</span>
          </div>
        ) : (
          <div className="ext-grid">
            {extensions.map((ext) => (
              <div key={ext} className="ext-item-card">
                <div className="ext-item-info">
                  <div className="ext-item-icon">🧩</div>
                  <div style={{ minWidth: 0 }}>
                    <div className="ext-item-name" title={ext}>{ext}</div>
                    <div className="ext-item-meta">
                      <span className="ext-status-dot" />
                      <span>已启用</span>
                    </div>
                  </div>
                </div>

                <div className="ext-item-btns">
                  <button
                    type="button"
                    className="panel-standard-btn"
                    onClick={() => onOpenExtension?.(ext)}
                  >
                    管理
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 消息与日志折叠栏 */}
      {messages.length > 0 && (
        <div className="ext-logs-section">
          <button
            type="button"
            className="ext-logs-toggle-btn"
            onClick={() => setShowLogs(!showLogs)}
          >
            <span>扩展通信日志 ({messages.length})</span>
            <span>{showLogs ? '▲ 收起' : '▼ 展开'}</span>
          </button>

          {showLogs && (
            <div className="ext-logs-content">
              {messages.map((msg, idx) => (
                <div key={idx} className="ext-log-line">
                  <span className="ext-log-type">[{msg.type}]</span>
                  <span className="ext-log-text">{JSON.stringify(msg)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 现代模态框封装，支持上下左右全向拖拽调整尺寸与持久化
 */
export function ExtensionModal({ open, onClose, onOpenExtension }: ExtensionModalProps) {
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_extension_modal_size',
    defaultWidth: 760,
    defaultHeight: 580,
    minWidth: 540,
    minHeight: 420,
  });

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

  if (!open) return null;

  const safeOverlay = createSafeOverlayHandlers(onClose);

  return (
    <div className="settings-overlay" {...safeOverlay}>
      <div
        className="ide-modal modern-extension-modal"
        style={{
          width: modalSize.width,
          height: modalSize.height,
          maxWidth: '96vw',
          maxHeight: '94vh',
          position: 'relative',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="ide-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18 }}>🧩</span>
            <div>
              <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, color: 'var(--text-bright)' }}>
                扩展与插件管理 (Extensions)
              </h2>
              <p className="ide-modal-desc" style={{ marginTop: 2 }}>
                管理 VSCode 插件生态、Claude AI 扩展及本地 VSIX 安装包
              </p>
            </div>
          </div>
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
        </header>

        {/* Body */}
        <div className="ide-modal-body" style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          <ExtensionPanel onOpenExtension={onOpenExtension} onClose={onClose} />
        </div>

        {/* 右下角全向拖拽手柄 */}
        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>
  );
}
