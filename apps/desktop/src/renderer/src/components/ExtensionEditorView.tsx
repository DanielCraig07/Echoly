/**
 * 扩展提供的**自定义编辑器** —— 打开 .md / .xlsx 这类文件时用扩展自己的界面渲染。
 *
 * 与 `ExtensionViewPanel`（侧栏视图）是两回事：
 * - 侧栏视图对着「扩展 + 视图 id」，一个扩展一个界面；
 * - 自定义编辑器对着**一个文件**：同一个 viewType 可以同时开好几份（两个 .md 并排），
 *   所以面板是按文件建的，key 也按文件分配。
 *
 * 没有它，装了 Office Viewer 也看不出任何变化 —— 文件仍然走内置编辑器。
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useI18n } from '../i18n';
import { useExtensionWebview } from '../hooks/useExtensionWebview';
import { EXTENSION_WEBVIEW_PARTITION } from '@deepseek-ide/shared';

/**
 * 自定义编辑器标签的虚拟路径前缀：`ext://editor/<encodeURIComponent(绝对路径)>`。
 *
 * 用绝对路径而不是相对路径：一个文件可能在附加文件夹里（多根工作区），
 * 相对主根的写法既表达不了，也会让「同一个文件开两次」这种判断出错。
 */
export const CUSTOM_EDITOR_PREFIX = 'ext://editor/';

/** 从虚拟路径里取回绝对路径。 */
export function filePathFromCustomEditorTab(tabPath: string): string {
  try {
    return decodeURIComponent(tabPath.slice(CUSTOM_EDITOR_PREFIX.length));
  } catch {
    // 手动拼出来的坏路径：原样返回，让调用方自己去失败
    return tabPath.slice(CUSTOM_EDITOR_PREFIX.length);
  }
}

/** 把绝对路径编成虚拟标签路径。 */
export function customEditorTabPath(filePath: string): string {
  return `${CUSTOM_EDITOR_PREFIX}${encodeURIComponent(filePath)}`;
}

interface ExtensionEditorViewProps {
  /** 文件的绝对路径。 */
  filePath: string;
  /** 扩展给的编辑器名字（标签已由 App 决定，这里只用于界面里的提示）。 */
  displayName?: string;
  /** 打不开（扩展没注册 / 渲染失败）时退回内置编辑器。 */
  onFallback: (reason: string) => void;
}

export function ExtensionEditorView({
  filePath,
  displayName,
  onFallback,
}: ExtensionEditorViewProps) {
  const { t } = useI18n();
  const [src, setSrc] = useState('');
  const [preload, setPreload] = useState('');
  const [panelKey, setPanelKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  /**
   * 面板 key 放 ref 里给卸载逻辑用。
   *
   * 卸载 effect 只能依赖 `filePath`（那个才是稳定身份）：把 panelKey 放进依赖的话，
   * 它一变化就会先跑一遍卸载、把刚建好的面板关掉。
   */
  const panelKeyRef = useRef('');

  /**
   * 回调放 ref 里，**不进依赖数组**。
   *
   * 调用方（编辑器面板）传的是内联箭头函数，每次渲染都是新的。把它放进依赖数组，
   * 这个 effect 就会在每一轮渲染后重跑 —— 重跑 = 重新 `openCustomEditor` = 新的
   * panelKey = 新的 state = 再渲染一轮。结果是一个停不下来的循环，界面上就是
   * 「编辑器一直在闪」，而且每轮都会把上一个面板 dispose 掉。
   */
  const onFallbackRef = useRef(onFallback);
  onFallbackRef.current = onFallback;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');

    void window.ide
      .openCustomEditor(filePath)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          // 明确退回内置编辑器，而不是留一个空白标签页
          onFallbackRef.current(result.error);
          return;
        }
        panelKeyRef.current = result.panelKey;
        setPanelKey(result.panelKey);
        setSrc(result.url);
        setPreload(result.preloadUrl);
      })
      .catch((err: any) => {
        if (!cancelled) onFallbackRef.current(err?.message || String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      // 关标签 / 切走时释放面板：扩展的 onDidDispose 要跑，它可能在里面收尾
      if (panelKeyRef.current) {
        void window.ide.customEditorDispose?.(panelKeyRef.current);
        panelKeyRef.current = '';
      }
    };
    // 只认 filePath：同一个文件面板要一直开着，换文件才整个重建（key 也是它）
  }, [filePath]);

  const { webviewRef } = useExtensionWebview({
    src,
    preload,
    onGuestMessage: useCallback((payload: unknown) => {
      if (!panelKeyRef.current) return;
      void window.ide.customEditorPost?.(panelKeyRef.current, payload);
    }, []),
    subscribeHost: useCallback(
      (send: (message: unknown) => void) =>
        window.ide.onCustomEditorMessage?.((data) => {
          if (data.panelKey !== panelKeyRef.current) return;
          send(data.message);
        }) ?? (() => {}),
      [],
    ),
  });

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const handleError = (e: any) => {
      console.error('[ExtensionEditorView] webview error:', e);
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
          <div>{t('extEditor.loading', { name: displayName || t('extEditor.fallbackName') })}</div>
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
        </div>
      </div>
    );
  }

  return (
    <div className="claude-panel">
      <div className="claude-panel-content">
        <webview
          ref={webviewRef}
          src={src}
          className="claude-webview"
          style={{ width: '100%', height: '100%' }}
          {...(preload ? { preload } : {})}
          partition={EXTENSION_WEBVIEW_PARTITION}
        />
      </div>
    </div>
  );
}
