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

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { EXTENSION_WEBVIEW_PARTITION } from '@deepseek-ide/shared';

/**
 * 扩展视图标签的虚拟路径前缀：`ext://view/<viewId>`。
 *
 * 与 `EXTENSION_DETAIL_PREFIX` 同一套路：打开方（面板/详情页）与渲染方（编辑器）
 * 都要用它，各写一份字面量迟早漂移成两个不同的字符串。
 */
export const EXTENSION_VIEW_PREFIX = 'ext://view/';

/** 访客 preload 里用的通道名，必须与 webviewGuest.ts / extensionManager 里的一致。 */
const GUEST_MESSAGE_CHANNEL = 'echoly-ext-message';
const HOST_MESSAGE_CHANNEL = 'echoly-ext-host-message';
/** 主题变量走单独一条通道，别和扩展自己的消息混在一起（见 webviewGuest.ts） */
const THEME_MESSAGE_CHANNEL = 'echoly-ext-theme';

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
  const webviewRef = useRef<any>(null);

  /**
   * 页面就绪之前收到的消息先存着。
   *
   * 扩展在 `resolveWebviewView` 里就会往界面推消息（Claude Code 一上来就
   * `updateSidebarActiveState` → `send(...)`），那会儿访客页面还不存在 ——
   * 直接丢的话，界面起来时缺了第一帧状态，看起来就是「加载了但空着」。
   */
  const pendingRef = useRef<unknown[]>([]);
  const readyRef = useRef(false);

  useEffect(() => {
    let isMounted = true;

    // 向主进程要这个视图的地址：provider 已经注册过才会拿到，
    // 扩展没激活起来 / 视图 id 不对时主进程会回一个 error，由下面转成可见的提示。
    const loadWebview = async () => {
      try {
        setLoading(true);
        setError('');

        const result = await window.ide.extensionResolveWebview(viewId);

        if (!isMounted) return;

        if (result.success && result.url) {
          setSrc(result.url);
          setPreload(result.preloadUrl || '');
        } else {
          setError(result.error || t('extView.loadUiFailed'));
        }
      } catch (err: any) {
        if (!isMounted) return;
        console.error('[ExtensionViewPanel] Error resolving webview:', err);
        setError(err.message || t('extView.loadFailed'));
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    void loadWebview();

    return () => {
      isMounted = false;
    };
    // viewId 决定拉哪一份 HTML；t 只影响错误文案，多跑一次 IPC 可以接受。
  }, [viewId, t]);

  /**
   * 扩展 → 页面。**不依赖 src**：resolve 过程中扩展开手就推的消息也得接住，
   * 接住之后先存着，等访客页面 dom-ready 再倒过去。
   */
  useEffect(() => {
    readyRef.current = false;
    pendingRef.current = [];

    const unsubscribe = window.ide.onExtensionWebviewMessage?.((data) => {
      if (data.viewId !== viewId) return;
      const webview = webviewRef.current;
      if (!readyRef.current || !webview) {
        pendingRef.current.push(data.message);
        return;
      }
      try {
        webview.send(HOST_MESSAGE_CHANNEL, data.message);
      } catch (err) {
        console.error('[ExtensionViewPanel] 转发消息到扩展界面失败：', err);
      }
    });

    return () => unsubscribe?.();
  }, [viewId]);

  /**
   * 用户切主题时，已经打开的扩展界面立刻跟着换色。
   *
   * 首屏那次不用管：样式表是主进程写进 HTML 的 `<link>`。
   */
  useEffect(() => {
    const unsubscribe = window.ide.onWebviewTheme?.(({ vars }) => {
      const webview = webviewRef.current;
      if (!webview || !readyRef.current) return;
      try {
        webview.send(THEME_MESSAGE_CHANNEL, vars);
      } catch (err) {
        console.error('[ExtensionViewPanel] 推送主题到扩展界面失败：', err);
      }
    });
    return () => unsubscribe?.();
  }, []);

  /** 页面就绪 + 页面 → 扩展 + 加载失败提示。依赖 src：`<webview>` 挂上来才有 ref。 */
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !src) return;

    /** 访客页面的 preload 已经跑起来了（它注册了 ipcRenderer.on），可以灌消息了。 */
    const handleDomReady = () => {
      readyRef.current = true;
      for (const message of pendingRef.current) {
        try {
          webview.send(HOST_MESSAGE_CHANNEL, message);
        } catch (err) {
          console.error('[ExtensionViewPanel] 补发消息失败：', err);
        }
      }
      pendingRef.current = [];
    };

    /** 页面 → 扩展。payload 就是访客页面 postMessage 出去的那个对象。 */
    const handleIpcMessage = (event: any) => {
      if (event.channel !== GUEST_MESSAGE_CHANNEL) return;
      const payload = event.args?.[0];
      void window.ide.extensionWebviewPost?.(viewId, payload);
    };

    const handleError = (e: any) => {
      console.error('[ExtensionViewPanel] webview error:', e);
      setError(t('extView.loadFailedDetail', { msg: e.message || t('extView.unknownError') }));
    };

    const handleConsole = (e: any) => {
      console.log('[ExtensionViewPanel webview]', e.message);
    };

    webview.addEventListener('dom-ready', handleDomReady);
    webview.addEventListener('ipc-message', handleIpcMessage);
    webview.addEventListener('did-fail-load', handleError);
    webview.addEventListener('console-message', handleConsole);

    return () => {
      webview.removeEventListener('dom-ready', handleDomReady);
      webview.removeEventListener('ipc-message', handleIpcMessage);
      webview.removeEventListener('did-fail-load', handleError);
      webview.removeEventListener('console-message', handleConsole);
    };
  }, [src, viewId, t]);

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
