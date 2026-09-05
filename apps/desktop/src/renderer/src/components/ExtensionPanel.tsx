/**
 * Extension Panel - 扩展管理面板
 * 用于安装、管理和控制 VSCode 扩展
 */

import { useState, useEffect } from 'react';

interface ExtensionPanelProps {
  onOpenExtension?: (extensionId: string) => void;
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
  const [downloadProgress, setDownloadProgress] = useState<{
    percent: number;
    downloaded: number;
    total: number;
  } | null>(null);

  // 加载已安装的扩展
  useEffect(() => {
    loadExtensions();

    // 监听扩展消息
    const cleanup1 = window.extensions.onMessage((message) => {
      console.log('Extension message:', message);
      setMessages((prev) => [...prev.slice(-19), message]); // 保留最近20条
    });

    // 监听扩展命令
    const cleanup2 = window.extensions.onCommand((data) => {
      console.log('Extension command:', data);
    });

    // 监听下载进度
    const cleanup3 =
      window.ide.onDownloadProgress?.((progress) => {
        setDownloadProgress(progress);
      }) || (() => {});

    return () => {
      cleanup1();
      cleanup2();
      if (typeof cleanup3 === 'function') cleanup3();
    };
  }, []);

  const loadExtensions = async () => {
    try {
      const result = await window.extensions.getLoadedExtensions();
      if (result.success && result.extensions) {
        setExtensions(result.extensions);
      }
    } catch (err: any) {
      console.error('Failed to load extensions:', err);
    }
  };

  const handleInstallClaudeCode = async () => {
    setLoading(true);
    setError(null);
    setDownloadProgress(null);
    try {
      const result = await window.extensions.installClaudeCode();
      if (result.success) {
        await loadExtensions();
        setDownloadProgress(null);
        alert('Claude Code 扩展安装成功！');
      } else {
        setError(result.error || '安装失败');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
      setDownloadProgress(null);
    }
  };

  const handleExecuteCommand = async (command: string) => {
    try {
      const result = await window.extensions.executeCommand(command);
      if (result.success) {
        console.log('Command executed:', result.result);
      } else {
        alert(`命令执行失败: ${result.error}`);
      }
    } catch (err: any) {
      alert(`命令执行错误: ${err.message}`);
    }
  };

  const handleLoadFromPath = async () => {
    setLoading(true);
    setError(null);

    try {
      // 使用 Electron 的文件选择对话框
      const filePath = await window.ide.pickFile([{ name: 'VSCode 扩展', extensions: ['vsix'] }]);

      if (!filePath) {
        setLoading(false);
        return;
      }

      const result = await window.extensions.loadFromPath(filePath);
      if (result.success) {
        await loadExtensions();
        console.log('扩展加载成功！文件：', filePath);
        setError(null);
      } else {
        setError(result.error || '加载失败');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="extension-panel">
      <div className="extension-panel-header">
        <h2>扩展管理</h2>
      </div>

      <div className="extension-panel-body">
        {/* 安装 Claude Code */}
        <section className="extension-section">
          <h3>Claude Code 扩展</h3>
          <p className="extension-desc">
            官方 Claude Code for VS Code 扩展，提供完整的 Claude AI 功能
          </p>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <button
              type="button"
              onClick={handleInstallClaudeCode}
              disabled={loading || extensions.includes('Anthropic.claude-code')}
              className="extension-btn primary"
            >
              {loading
                ? '安装中...'
                : extensions.includes('Anthropic.claude-code')
                  ? '已安装'
                  : '在线安装'}
            </button>
            <button
              type="button"
              onClick={handleLoadFromPath}
              disabled={loading}
              className="extension-btn"
            >
              从路径加载
            </button>
          </div>

          {/* 下载进度 */}
          {downloadProgress && (
            <div className="download-progress">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${downloadProgress.percent}%` }} />
              </div>
              <div className="progress-text">
                {downloadProgress.percent.toFixed(1)}% (
                {(downloadProgress.downloaded / 1024 / 1024).toFixed(1)}MB /
                {(downloadProgress.total / 1024 / 1024).toFixed(1)}MB)
              </div>
            </div>
          )}

          {error && <div className="extension-error">{error}</div>}
        </section>

        {/* 已安装的扩展列表 */}
        <section className="extension-section">
          <h3>已安装的扩展 ({extensions.length})</h3>
          {extensions.length === 0 ? (
            <p className="extension-empty">暂无已安装的扩展</p>
          ) : (
            <ul className="extension-list">
              {extensions.map((ext) => (
                <li key={ext} className="extension-item">
                  <span className="extension-name">{ext}</span>
                  <button
                    type="button"
                    className="extension-btn small"
                    onClick={() => {
                      if (onOpenExtension) {
                        onOpenExtension(ext);
                      } else {
                        handleExecuteCommand('extension.open');
                      }
                    }}
                  >
                    打开
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 扩展消息日志 */}
        {messages.length > 0 && (
          <section className="extension-section">
            <h3>扩展消息</h3>
            <div className="extension-messages">
              {messages.map((msg, idx) => (
                <div key={idx} className="extension-message">
                  <span className="extension-message-type">[{msg.type}]</span>
                  <span className="extension-message-text">{JSON.stringify(msg, null, 2)}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      <style>{`
        .download-progress {
          margin-top: 16px;
        }

        .progress-bar {
          width: 100%;
          height: 8px;
          background: var(--bg);
          border-radius: 4px;
          overflow: hidden;
          margin-bottom: 8px;
        }

        .progress-fill {
          height: 100%;
          background: linear-gradient(90deg, var(--accent), var(--accent-2));
          transition: width 0.3s ease;
          border-radius: 4px;
        }

        .progress-text {
          font-size: 13px;
          color: var(--muted);
          text-align: center;
        }

        .extension-panel {
          height: 100%;
          display: flex;
          flex-direction: column;
          background: var(--bg);
          color: var(--text);
        }

        .extension-panel-header {
          padding: 16px 20px;
          border-bottom: 1px solid var(--border);
        }

        .extension-panel-header h2 {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
        }

        .extension-panel-body {
          flex: 1;
          overflow-y: auto;
          padding: 20px;
        }

        .extension-section {
          margin-bottom: 32px;
        }

        .extension-section h3 {
          margin: 0 0 12px;
          font-size: 16px;
          font-weight: 600;
        }

        .extension-desc {
          margin: 0 0 16px;
          color: var(--text-secondary);
          font-size: 14px;
          line-height: 1.5;
        }

        .extension-btn {
          padding: 8px 16px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--panel);
          color: var(--text);
          font-size: 14px;
          cursor: pointer;
          transition: all 0.15s;
        }

        .extension-btn:hover:not(:disabled) {
          background: var(--panel-hover);
          border-color: var(--accent);
        }

        .extension-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .extension-btn.primary {
          background: var(--accent);
          border-color: var(--accent);
          color: white;
        }

        .extension-btn.primary:hover:not(:disabled) {
          background: var(--accent-hover);
        }

        .extension-btn.small {
          padding: 4px 12px;
          font-size: 12px;
        }

        .extension-error {
          margin-top: 12px;
          padding: 12px;
          border-radius: 6px;
          background: rgba(255, 100, 100, 0.1);
          border: 1px solid rgba(255, 100, 100, 0.3);
          color: #ff6464;
          font-size: 13px;
        }

        .extension-empty {
          color: var(--text-secondary);
          font-size: 14px;
        }

        .extension-list {
          list-style: none;
          margin: 0;
          padding: 0;
        }

        .extension-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px;
          margin-bottom: 8px;
          border-radius: 6px;
          background: var(--panel);
          border: 1px solid var(--border);
        }

        .extension-name {
          font-size: 14px;
          font-family: monospace;
        }

        .extension-messages {
          max-height: 300px;
          overflow-y: auto;
          padding: 12px;
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: 6px;
          font-family: monospace;
          font-size: 12px;
        }

        .extension-message {
          margin-bottom: 8px;
          padding-bottom: 8px;
          border-bottom: 1px solid var(--border);
        }

        .extension-message:last-child {
          margin-bottom: 0;
          padding-bottom: 0;
          border-bottom: none;
        }

        .extension-message-type {
          display: inline-block;
          margin-right: 8px;
          color: var(--accent);
        }

        .extension-message-text {
          color: var(--text-secondary);
        }
      `}</style>
    </div>
  );
}
