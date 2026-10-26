/**
 * Claude Extension Webview Panel
 * 显示 Claude Code 扩展的侧边栏 UI
 */

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';

// Electron webview 标签类型声明
declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        nodeintegration?: string;
        webpreferences?: string;
        partition?: string;
      };
    }
  }
}

interface ClaudePanelProps {
  viewId?: string;
  onClose?: () => void;
}

export function ClaudePanel({ viewId = 'claudeVSCodeSidebar', onClose }: ClaudePanelProps) {
  const { t } = useI18n();
  const [html, setHtml] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [htmlFile, setHtmlFile] = useState<string>('');
  const webviewRef = useRef<any>(null);

  useEffect(() => {
    let isMounted = true;

    // 请求解析 webview
    const loadWebview = async () => {
      try {
        setLoading(true);
        setError('');

        console.log(`[ClaudePanel] Resolving webview: ${viewId}`);
        const result = await window.ide.extensionResolveWebview(viewId);

        if (!isMounted) return;

        if (result.success && result.html) {
          console.log(`[ClaudePanel] Got HTML content, length: ${result.html.length}`);
          console.log(`[ClaudePanel] HTML preview:`, result.html.substring(0, 200));
          setHtml(result.html);

          // 使用主进程返回的真实 userData 路径（不再硬编码旧品牌目录）
          const filePath = result.filePath || '';
          setHtmlFile(filePath ? `file://${filePath}` : '');
          console.log(`[ClaudePanel] Webview file path:`, filePath);
        } else {
          setError(result.error || t('ext.claudeLoadUiFailed'));
        }
      } catch (err: any) {
        if (!isMounted) return;
        console.error('[ClaudePanel] Error loading webview:', err);
        setError(err.message || t('ext.claudeLoadFailed'));
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    loadWebview();

    return () => {
      isMounted = false;
    };
  }, [viewId]);

  // 监听 webview 加载和消息
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !htmlFile) return;

    const handleLoad = () => {
      console.log('[ClaudePanel] webview loaded successfully');
    };

    const handleError = (e: any) => {
      console.error('[ClaudePanel] webview error:', e);
      setError(t('ext.claudeLoadFailedDetail', { msg: e.message || t('ext.claudeUnknownError') }));
    };

    const handleConsole = (e: any) => {
      console.log('[ClaudePanel webview]', e.message);
    };

    webview.addEventListener('did-finish-load', handleLoad);
    webview.addEventListener('did-fail-load', handleError);
    webview.addEventListener('console-message', handleConsole);

    return () => {
      webview.removeEventListener('did-finish-load', handleLoad);
      webview.removeEventListener('did-fail-load', handleError);
      webview.removeEventListener('console-message', handleConsole);
    };
  }, [htmlFile]);

  if (loading) {
    return (
      <div className="claude-panel loading">
        <div className="loading-spinner">
          <div className="spinner"></div>
          <div>{t('ext.claudeLoading')}</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="claude-panel error">
        <div className="error-message">
          <div className="error-icon">⚠️</div>
          <div className="error-text">{error}</div>
          {onClose && (
            <button className="btn-close" onClick={onClose}>
              {t('ext.claudeClose')}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!htmlFile && !loading && !error) {
    return (
      <div className="claude-panel loading">
        <div>{t('ext.claudePreparing')}</div>
      </div>
    );
  }

  return (
    <div className="claude-panel">
      <div className="claude-panel-content">
        {htmlFile ? (
          <webview
            ref={webviewRef}
            src={htmlFile}
            className="claude-webview"
            style={{ width: '100%', height: '100%' }}
            nodeintegration={false}
            webpreferences="allowRunningInsecureContent=yes,contextIsolation=no,sandbox=no"
            partition="persist:claude-extension"
          />
        ) : (
          <div style={{ padding: '20px', color: 'var(--text-secondary)' }}>
            {t('ext.claudeWaitingHtml')}
            <div style={{ marginTop: '10px', fontSize: '12px' }}>
              {t('ext.claudeFileLabel', { name: htmlFile || t('ext.claudeNotSet') })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
