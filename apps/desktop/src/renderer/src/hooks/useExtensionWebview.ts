/**
 * 扩展 webview 的公共接线：`<webview>` 的两条消息通道 + 主题 + 就绪前的缓冲。
 *
 * 抽出来是因为有两个消费者：侧栏视图（`ExtensionViewPanel`）和自定义编辑器
 * （`ExtensionEditorView`）。它们除了「跟谁解析、消息发给谁」之外完全一样 ——
 * 复制一份出来的结果是修好一个、另一个还是坏的。
 */

import { useEffect, useRef, useCallback } from 'react';

/** 访客 preload 里约定的通道名（见 preload/webviewGuest.ts，改一处就要改三处）。 */
export const GUEST_MESSAGE_CHANNEL = 'echoly-ext-message';
export const HOST_MESSAGE_CHANNEL = 'echoly-ext-host-message';
export const THEME_MESSAGE_CHANNEL = 'echoly-ext-theme';

export interface UseExtensionWebviewOptions {
  /** 页面地址（`echoly-webview://…`）。空串表示还没解析出来。 */
  src: string;
  /** 访客 preload 的 file:// 地址。 */
  preload: string;
  /** 页面发回来的消息（扩展界面的用户操作）。 */
  onGuestMessage: (payload: unknown) => void;
  /**
   * 订阅宿主消息。**必须**在页面就绪之前就订上：扩展在 resolve 的过程中就会推消息，
   * 那会儿页面还不存在，直接丢的话界面起来时缺第一帧状态。
   *
   * 参数是「把一个消息灌进访客页面」的函数；返回退订函数。
   */
  subscribeHost: (send: (message: unknown) => void) => () => void;
}

export function useExtensionWebview({
  src,
  preload,
  onGuestMessage,
  subscribeHost,
}: UseExtensionWebviewOptions) {
  const webviewRef = useRef<any>(null);
  /** 页面就绪（dom-ready）之前收到的消息先存着。 */
  const pendingRef = useRef<unknown[]>([]);
  const readyRef = useRef(false);
  /** 回调放在 ref 里：effect 不该因为调用方每次渲染换了函数就重建订阅。 */
  const onGuestMessageRef = useRef(onGuestMessage);
  onGuestMessageRef.current = onGuestMessage;

  /** 把一个消息交给访客页面；没就绪就先存着。 */
  const sendToGuest = useCallback((message: unknown) => {
    const webview = webviewRef.current;
    if (!readyRef.current || !webview) {
      pendingRef.current.push(message);
      return;
    }
    try {
      webview.send(HOST_MESSAGE_CHANNEL, message);
    } catch (err) {
      console.error('[extension-webview] 转发消息到扩展界面失败：', err);
    }
  }, []);

  // 订阅宿主消息：不依赖 src，resolve 期间推来的也要接住
  useEffect(() => {
    readyRef.current = false;
    pendingRef.current = [];
    return subscribeHost(sendToGuest);
  }, [subscribeHost, sendToGuest]);

  // 主题热更新（首屏那次由主进程写进 HTML 的 <link>，这里只管切主题）
  useEffect(() => {
    const unsubscribe = window.ide.onWebviewTheme?.(({ vars }) => {
      const webview = webviewRef.current;
      if (!webview || !readyRef.current) return;
      try {
        webview.send(THEME_MESSAGE_CHANNEL, vars);
      } catch (err) {
        console.error('[extension-webview] 推送主题失败：', err);
      }
    });
    return () => unsubscribe?.();
  }, []);

  // 页面就绪时才把攒下的消息灌进去：访客 preload 那时才注册好 ipcRenderer.on
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !src) return;

    const handleDomReady = () => {
      readyRef.current = true;
      for (const message of pendingRef.current) {
        try {
          webview.send(HOST_MESSAGE_CHANNEL, message);
        } catch (err) {
          console.error('[extension-webview] 补发消息失败：', err);
        }
      }
      pendingRef.current = [];
    };

    const handleIpcMessage = (event: any) => {
      if (event.channel !== GUEST_MESSAGE_CHANNEL) return;
      onGuestMessageRef.current(event.args?.[0]);
    };

    const handleError = (e: any) => {
      console.error('[extension-webview] webview error:', e);
    };

    webview.addEventListener('dom-ready', handleDomReady);
    webview.addEventListener('ipc-message', handleIpcMessage);
    webview.addEventListener('did-fail-load', handleError);
    return () => {
      webview.removeEventListener('dom-ready', handleDomReady);
      webview.removeEventListener('ipc-message', handleIpcMessage);
      webview.removeEventListener('did-fail-load', handleError);
    };
  }, [src]);

  return { webviewRef };
}
