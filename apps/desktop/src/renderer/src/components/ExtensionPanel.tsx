/**
 * Extension Panel - 现代扩展与插件管理面板
 * 用于安装、管理和控制 VSCode / Claude 等核心扩展生态
 */

import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  useModalResize,
  ModalResizeHandle,
  createSafeOverlayHandlers,
} from '../hooks/useModalResize';
import { useI18n } from '../i18n';

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
      searchMarketplace(
        query: string,
        size?: number,
      ): Promise<{
        ok: boolean;
        error?: string;
        extensions: {
          id: string;
          displayName: string;
          description: string;
          version: string;
          downloadUrl: string;
          downloads?: number;
          rating?: number;
        }[];
      }>;
      installFromMarketplace(extension: {
        id: string;
        downloadUrl: string;
        version?: string;
      }): Promise<{ success: boolean; error?: string }>;
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
  const { t } = useI18n();
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
  // 扩展市场（Open VSX）
  const [marketQuery, setMarketQuery] = useState('');
  const [marketResults, setMarketResults] = useState<
    {
      id: string;
      displayName: string;
      description: string;
      version: string;
      downloadUrl: string;
      downloads?: number;
      rating?: number;
    }[]
  >([]);
  const [marketState, setMarketState] = useState<'idle' | 'searching' | 'done'>('idle');
  const [marketError, setMarketError] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);

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

    const cleanup1 =
      window.extensions?.onMessage?.((message) => {
        setMessages((prev) => [...prev.slice(-19), message]);
      }) || (() => {});

    const cleanup2 =
      window.extensions?.onCommand?.((data) => {
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
        setSuccessMsg(t('ext.claudeInstalled'));
      } else {
        setError(result.error || t('ext.installFailed'));
      }
    } catch (err: any) {
      setError(err.message || t('ext.installError'));
    } finally {
      setLoading(false);
      setDownloadProgress(null);
    }
  };

  /**
   * 在市场里搜索。
   *
   * 网络失败只把错误显示在搜索区，不设全局 error ——
   * 「注册表连不上」不该让已经装好的扩展、本地 VSIX 安装这些入口看起来也坏了。
   */
  const handleMarketSearch = async () => {
    const query = marketQuery.trim();
    if (!query || marketState === 'searching') return;
    setMarketState('searching');
    setMarketError(null);
    try {
      const res = await window.extensions.searchMarketplace(query, 20);
      if (!res?.ok) {
        setMarketResults([]);
        setMarketError(res?.error || t('ext.marketFailed'));
        return;
      }
      setMarketResults(res.extensions);
    } catch (err: any) {
      setMarketResults([]);
      setMarketError(err?.message || t('ext.marketFailed'));
    } finally {
      setMarketState('done');
    }
  };

  const handleMarketInstall = async (extension: {
    id: string;
    downloadUrl: string;
    version: string;
    displayName: string;
  }) => {
    if (installingId) return;
    setInstallingId(extension.id);
    setError(null);
    setSuccessMsg(null);
    try {
      const result = await window.extensions.installFromMarketplace({
        id: extension.id,
        downloadUrl: extension.downloadUrl,
        version: extension.version,
      });
      if (result.success) {
        await loadExtensions();
        setSuccessMsg(t('ext.marketInstalled', { name: extension.displayName }));
      } else {
        setError(result.error || t('ext.installFailed'));
      }
    } catch (err: any) {
      setError(err?.message || t('ext.installError'));
    } finally {
      setInstallingId(null);
    }
  };

  const handleLoadFromPath = async () => {
    setLoading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const filePath = await window.ide.pickFile([
        { name: t('ext.vsixFilterName'), extensions: ['vsix'] },
      ]);
      if (!filePath) {
        setLoading(false);
        return;
      }

      const result = await window.extensions.loadFromPath(filePath);
      if (result.success) {
        await loadExtensions();
        setSuccessMsg(t('ext.localLoadOk', { name: filePath.split(/[/\\\\]/).pop() ?? '' }));
      } else {
        setError(result.error || t('ext.localLoadFailed'));
      }
    } catch (err: any) {
      setError(err.message || t('ext.localLoadError'));
    } finally {
      setLoading(false);
    }
  };

  const isClaudeInstalled = extensions.includes('Anthropic.claude-code');

  /**
   * 已加载判定：扩展自报的 id 可能是 `publisher.name`，也可能是别的写法，
   * 所以按「id 相等 或 包含其中一段」宽松匹配 —— 装完之后按钮应当立刻变成「已安装」。
   */
  const isExtensionLoaded = (id: string) =>
    extensions.some((loaded) => {
      const normalized = loaded.toLowerCase();
      const target = id.toLowerCase();
      return normalized === target || normalized.includes(target) || target.includes(normalized);
    });

  return (
    <div className="ext-panel-container">
      {/* 提示横幅 */}
      {error && (
        <div className="ext-alert ext-alert-error">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{error}</span>
          <button type="button" className="ext-alert-close" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}

      {successMsg && (
        <div className="ext-alert ext-alert-success">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <span>{successMsg}</span>
          <button type="button" className="ext-alert-close" onClick={() => setSuccessMsg(null)}>
            ✕
          </button>
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
              <span className="ext-pill ext-pill-official">{t('ext.official')}</span>
              {isClaudeInstalled && (
                <span className="ext-pill ext-pill-active">{t('ext.installed')}</span>
              )}
            </div>
            <p className="ext-hero-desc">{t('ext.heroDesc')}</p>
          </div>
        </div>

        <div className="ext-hero-actions">
          {isClaudeInstalled ? (
            <button
              type="button"
              className="panel-standard-btn primary"
              onClick={() => onOpenExtension?.('Anthropic.claude-code')}
            >
              {t('ext.open')}
            </button>
          ) : (
            <button
              type="button"
              className="panel-standard-btn primary"
              onClick={handleInstallClaudeCode}
              disabled={loading}
            >
              {loading ? t('ext.installing') : t('ext.installOnline')}
            </button>
          )}
        </div>
      </div>

      {/* 下载进度条 */}
      {downloadProgress && (
        <div className="ext-progress-card">
          <div className="ext-progress-header">
            <span style={{ fontWeight: 600 }}>{t('ext.downloading')}</span>
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
              {t('ext.localTitle')}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
              {t('ext.localDesc')}
            </div>
          </div>
        </div>
        <button
          type="button"
          className="panel-standard-btn"
          onClick={handleLoadFromPath}
          disabled={loading}
        >
          {t('ext.loadFromPath')}
        </button>
      </div>

      {/* 扩展市场（Open VSX） */}
      <div className="ext-section">
        <div className="ext-section-header">
          <span className="ext-section-title">{t('ext.marketTitle')}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            type="text"
            value={marketQuery}
            placeholder={t('ext.marketPlaceholder')}
            onChange={(e) => setMarketQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleMarketSearch();
            }}
            style={{
              flex: 1,
              padding: '6px 10px',
              fontSize: 'var(--ui-font-size, 12px)',
              color: 'var(--text)',
              background: 'var(--bg-input)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              boxSizing: 'border-box',
            }}
          />
          <button
            type="button"
            className="panel-standard-btn"
            onClick={() => void handleMarketSearch()}
            disabled={marketState === 'searching' || !marketQuery.trim()}
          >
            {marketState === 'searching' ? t('ext.marketSearching') : t('ext.marketSearch')}
          </button>
        </div>

        {marketError && (
          <div style={{ marginTop: 8, fontSize: 11, color: '#f87171' }}>{marketError}</div>
        )}

        {marketState === 'done' && !marketError && marketResults.length === 0 && (
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>
            {t('ext.marketEmpty')}
          </div>
        )}

        {marketResults.map((item) => (
          <div
            key={item.id}
            style={{
              marginTop: 8,
              padding: '8px 10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--bg-elevated, #1e1e1e)',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 'var(--ui-font-size, 12px)' }}>
                {item.displayName}
                <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>
                  v{item.version}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--muted)',
                  marginTop: 2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={item.description}
              >
                {item.description || item.id}
              </div>
            </div>
            <button
              type="button"
              className="panel-standard-btn"
              disabled={installingId !== null || isExtensionLoaded(item.id)}
              onClick={() => void handleMarketInstall(item)}
            >
              {isExtensionLoaded(item.id)
                ? t('ext.installed')
                : installingId === item.id
                  ? t('ext.installing')
                  : t('ext.marketInstall')}
            </button>
          </div>
        ))}
      </div>

      {/* 已安装扩展列表 */}
      <div className="ext-section">
        <div className="ext-section-header">
          <span className="ext-section-title">{t('ext.installedSection')}</span>
          <span className="ext-section-count">({extensions.length})</span>
        </div>

        {extensions.length === 0 ? (
          <div className="ext-empty-placeholder">
            <span style={{ fontSize: 26, opacity: 0.5 }}>🧩</span>
            <span>{t('ext.empty')}</span>
          </div>
        ) : (
          <div className="ext-grid">
            {extensions.map((ext) => (
              <div key={ext} className="ext-item-card">
                <div className="ext-item-info">
                  <div className="ext-item-icon">🧩</div>
                  <div style={{ minWidth: 0 }}>
                    <div className="ext-item-name" title={ext}>
                      {ext}
                    </div>
                    <div className="ext-item-meta">
                      <span className="ext-status-dot" />
                      <span>{t('ext.enabled')}</span>
                    </div>
                  </div>
                </div>

                <div className="ext-item-btns">
                  <button
                    type="button"
                    className="panel-standard-btn"
                    onClick={() => onOpenExtension?.(ext)}
                  >
                    {t('ext.manage')}
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
            <span>{t('ext.logs', { n: messages.length })}</span>
            <span>{showLogs ? t('ext.collapse') : t('ext.expand')}</span>
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
  const { t } = useI18n();
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

  if (!open || typeof document === 'undefined') return null;

  const safeOverlay = createSafeOverlayHandlers(onClose);

  return createPortal(
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
                {t('ext.modalTitle')}
              </h2>
              <p className="ide-modal-desc" style={{ marginTop: 2 }}>
                {t('ext.modalDesc')}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="panel-action-btn"
            onClick={onClose}
            title={t('ext.closeEsc')}
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

        {/* Body */}
        {/* 不覆盖 padding：.ide-modal-body 的默认值是 18px 20px，与其它弹窗一致。
            这里原本写死 20，比别处松一档。 */}
        <div className="ide-modal-body" style={{ flex: 1, overflowY: 'auto' }}>
          <ExtensionPanel onOpenExtension={onOpenExtension} onClose={onClose} />
        </div>

        {/* 右下角全向拖拽手柄 */}
        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>,
    document.body,
  );
}
