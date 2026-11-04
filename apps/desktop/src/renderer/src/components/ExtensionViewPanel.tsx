/**
 * 扩展自带的 webview 视图 —— 在编辑器区打开的「扩展界面」标签。
 *
 * 一个扩展装好之后，除了「已安装」这个状态，它自己贡献的界面得有个入口能用 ——
 * 这才是「插件真正接入应用」。视图的来源是扩展的 `contributes.views`：
 * 激活时它调 `registerWebviewViewProvider` 注册一个 provider，主进程拿这个 provider
 * 生成一份 HTML，这里用一个 `<webview>` 把它挂上来。
 *
 * 这里**不认识任何具体扩展**：视图 id 由调用方给（面板/详情页按该扩展贡献的 views
 * 决定开哪一个），地址与访客 preload 由主进程在 `extensionResolveWebview` 里一并返回。
 *
 * 消息是双向的，缺一半界面就是「能看不能用」：
 * - 页面 → 扩展：`<webview>` 的 `ipc-message` 事件（访客 preload 用 sendToHost 发出来）
 *   → 主进程 → 扩展的 onDidReceiveMessage；
 * - 扩展 → 页面：主进程广播 `extension:webview-message` → 这里 `webview.send()`
 *   把消息打进访客页面的 preload。
 */

import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { EXTENSION_WEBVIEW_PARTITION } from '@deepseek-ide/shared';
import { useExtensionWebview } from '../hooks/useExtensionWebview';

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
        preload?: string;
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
  const [src, setSrc] = useState('');
  const [preload, setPreload] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  /**
   * 向主进程要这个视图的地址。
   *
   * provider 已经注册过才会拿到；扩展没激活起来 / 视图 id 不对时主进程回一个 error，
   * 由下面转成看得见的提示。抽 `useExtensionWebview` 的时候这段曾经被一起删掉过 ——
   * 表现是面板永远停在转圈上（`src` 一直是空串，`<webview>` 根本没挂上来），
   * 而所有消息通道都是好的。别删。
   */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');

    void window.ide
      .extensionResolveWebview(viewId)
      .then((result) => {
        if (cancelled) return;
        if (result.success && result.url) {
          setSrc(result.url);
          setPreload(result.preloadUrl || '');
        } else {
          setError(result.error || t('extView.loadUiFailed'));
        }
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || t('extView.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // viewId 决定拉哪一份 HTML；t 只影响错误文案，多跑一次 IPC 可以接受。
  }, [viewId, t]);

  const { webviewRef } = useExtensionWebview({
    src,
    preload,
    onGuestMessage: useCallback(
      (payload: unknown) => {
        void window.ide.extensionWebviewPost?.(viewId, payload);
      },
      [viewId],
    ),
    subscribeHost: useCallback(
      (send: (message: unknown) => void) =>
        window.ide.onExtensionWebviewMessage?.((data) => {
          if (data.viewId !== viewId) return;
          send(data.message);
        }) ?? (() => {}),
      [viewId],
    ),
  });

  /** 加载失败时把原因显示出来（不要只留一个空面板）。 */
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const handleError = (e: any) => {
      console.error('[ExtensionViewPanel] webview error:', e);
      setError(t('extView.loadFailedDetail', { msg: e.message || t('extView.unknownError') }));
    };
    webview.addEventListener('did-fail-load', handleError);
    return () => webview.removeEventListener('did-fail-load', handleError);
  }, [src, t, webviewRef]);

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

  return (
    <div className="claude-panel">
      <div className="claude-panel-content">
        {/*
          partition 必须与主进程注册协议的那个 session 一致（EXTENSION_WEBVIEW_PARTITION）：
          两边对不上时视图进程里任何 echoly-webview:// 请求都取不到内容，
          表现是一片空白，而不是一条能看懂的报错。
        */}
        <webview
          ref={webviewRef}
          src={src}
          className="claude-webview"
          style={{ width: '100%', height: '100%' }}
          {...(preload ? { preload } : {})}
          /*
            刻意**不写** nodeintegration。Electron 对 webview 的布尔属性是按
            「属性在不在」判断的，`nodeintegration="false"` 这种写法等于打开它 ——
            扩展界面的 JS 会拿到完整的 Node。默认就是关的，不写最安全。
          */
          partition={EXTENSION_WEBVIEW_PARTITION}
        />
      </div>
    </div>
  );
}
