/**
 * 扩展自带的 webview 视图 —— 在编辑器区打开的「扩展界面」标签。
 *
 * 一个扩展装好之后，除了「已安装」这个状态，它自己贡献的界面得有个入口能用 ——
 * 这才是「插件真正接入应用」。视图的来源是扩展的 `contributes.views`：
 * 激活时它调 `registerWebviewViewProvider` 注册一个 provider，主进程拿这个 provider
 * 生成一份 HTML 落盘，这里用一个 `<webview>` 把它挂上来。
 *
 * 这个组件**不认识 Claude**：视图 id 由调用方给（面板/详情页按该扩展贡献的 views 决定
 * 开哪一个）。以前它叫 ClaudePanel、默认视图 id 写死成 `claudeVSCodeSidebar`，
 * 于是除了 Claude Code 之外的扩展即使注册了视图也没有任何地方能显示它们。
 */

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';

/**
 * 扩展视图标签的虚拟路径前缀：`ext://view/<viewId>`。
 *
 * 与 `EXTENSION_DETAIL_PREFIX` 同一套路：打开方（面板/详情页）与渲染方（编辑器）
 * 都要用它，各写一份字面量迟早漂移成两个不同的字符串。
 */
export const EXTENSION_VIEW_PREFIX = 'ext://view/';

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

interface ExtensionViewPanelProps {
  /** 扩展贡献的视图 id（注册时那个 `viewId`）。 */
  viewId: string;
  onClose?: () => void;
}

export function ExtensionViewPanel({ viewId, onClose }: ExtensionViewPanelProps) {
  const { t } = useI18n();
  const [html, setHtml] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [htmlFile, setHtmlFile] = useState<string>('');
  const webviewRef = useRef<any>(null);

  useEffect(() => {
    let isMounted = true;

    // 向主进程要这个视图的 HTML：provider 已经注册过才会拿到内容，
    // 扩展没激活起来 / 视图 id 不对时主进程会回一个 error，由下面转成可见的提示。
    const loadWebview = async () => {
      try {
        setLoading(true);
        setError('');

        const result = await window.ide.extensionResolveWebview(viewId);

        if (!isMounted) return;

        if (result.success && result.html) {
          setHtml(result.html);

          // 使用主进程返回的真实 userData 路径（不硬编码品牌目录）
          const filePath = result.filePath || '';
          setHtmlFile(filePath ? `file://${filePath}` : '');
        } else {
          setError(result.error || t('extView.loadUiFailed'));
        }
      } catch (err: any) {
        if (!isMounted) return;
        console.error('[ExtensionViewPanel] Error loading webview:', err);
        setError(err.message || t('extView.loadFailed'));
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
    // t 进去会随语言切换重跑一次请求；代价是可以接受的（一次 IPC），换来切语言后
    // 错误文案也一起变。viewId 才是真正决定拉哪一份 HTML 的东西。
  }, [viewId, t]);

  // 监听 webview 加载和消息
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !htmlFile) return;

    const handleLoad = () => {
      console.log('[ExtensionViewPanel] webview loaded successfully');
    };

    const handleError = (e: any) => {
      console.error('[ExtensionViewPanel] webview error:', e);
      setError(t('extView.loadFailedDetail', { msg: e.message || t('extView.unknownError') }));
    };

    const handleConsole = (e: any) => {
      console.log('[ExtensionViewPanel webview]', e.message);
    };

    webview.addEventListener('did-finish-load', handleLoad);
    webview.addEventListener('did-fail-load', handleError);
    webview.addEventListener('console-message', handleConsole);

    return () => {
      webview.removeEventListener('did-finish-load', handleLoad);
      webview.removeEventListener('did-fail-load', handleError);
      webview.removeEventListener('console-message', handleConsole);
    };
  }, [htmlFile, t]);

  if (loading) {
    return (
      <div className="claude-panel loading">
        <div className="loading-spinner">
          <div className="spinner"></div>
          <div>{t('extView.loading')}</div>
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
              {t('extView.close')}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!htmlFile && !loading && !error) {
    return (
      <div className="claude-panel loading">
        <div>{t('extView.preparing')}</div>
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
            {t('extView.waitingHtml')}
            <div style={{ marginTop: '10px', fontSize: '12px' }}>
              {t('extView.fileLabel', { name: htmlFile || t('extView.notSet') })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
