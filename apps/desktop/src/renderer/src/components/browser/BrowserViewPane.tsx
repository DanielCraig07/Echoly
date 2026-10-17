import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { BrowserElementRef } from '@deepseek-ide/shared';
import {
  INJECTED_INSPECT_SCRIPT,
  CANCEL_INSPECT_SCRIPT,
  ROUTE_SYNC_SCRIPT,
  PASSWORD_INTERCEPTOR_SCRIPT,
  buildAutofillScript,
} from './browserInspectScript';
import {
  extractOrigin,
  getCredentialsForOrigin,
  saveCredential,
  deleteCredential,
  type SavedCredential,
} from '../../services/browserPasswordManager';

export interface BrowserViewPaneProps {
  initialUrl?: string;
  tabTitle?: string;
  isActive?: boolean;
  onUpdateTab?: (patch: { title?: string; path?: string; virtual?: any }) => void;
  onOpenNewTab?: (url?: string) => void;
  onAddElementToChat?: (ref: BrowserElementRef) => void;
  onAddPageToChat?: (pageInfo: { url: string; title: string; errors?: string[] }) => void;
  onShowToast?: (message: string, type?: 'info' | 'error' | 'success') => void;
}
interface ConsoleMessage {
  id: string;
  level: 'log' | 'warn' | 'error' | 'info';
  message: string;
  sourceId?: string;
  line?: number;
  timestamp: number;
}

/**
 * 图1中所示的 Inspect / Pick Element 检查选取图标
 * 虚线圆角方框，右下角带箭头指向框内/左上方
 */
export function IconInspectElement({ active }: { active?: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke={active ? '#60a5fa' : 'currentColor'}
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        filter: active ? 'drop-shadow(0 0 4px rgba(59, 130, 246, 0.6))' : 'none',
        transition: 'all 0.15s ease',
      }}
    >
      {/* 虚线选择框 */}
      <rect x="3" y="3" width="18" height="18" rx="4" strokeDasharray="3 3" />
      {/* 对角箭头指向框内左上 */}
      <path d="M16 16L9.5 9.5" />
      <path d="M16 9.5H9.5V16" />
    </svg>
  );
}

/**
 * Memoized 内置 webview 容器：
 * 绝不由父级组件的状态（如 isDevToolsOpen、输入框文字等）重新渲染，
 * 保证挂载时有权威的 initialSrc 触发 Electron guest 实例创建，
 * 且后续 React reconciler 绝不触碰 webview 的 src 属性，彻底杜绝误重载。
 */
const WebviewInner = React.memo(
  React.forwardRef<HTMLWebViewElement, { initialSrc: string; isNewTab?: boolean }>(function WebviewInner(
    { initialSrc, isNewTab },
    ref,
  ) {
    return (
      <webview
        ref={ref as any}
        src={initialSrc || 'about:blank'}
        partition="persist:echoly-browser"
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          border: 'none',
          backgroundColor: isNewTab ? 'transparent' : '#ffffff',
          colorScheme: isNewTab ? 'dark' : 'normal',
        }}
        allowpopups={true}
      />
    );
  }),
);

export const BrowserViewPane: React.FC<BrowserViewPaneProps> = ({
  initialUrl = '',
  tabTitle,
  isActive = true,
  onUpdateTab,
  onOpenNewTab,
  onAddElementToChat,
  onAddPageToChat,
  onShowToast,
}) => {
  // 获取当前上下文基准 Origin (例如 http://localhost:5173 或 http://localhost:3000 等)
  const getBaseOrigin = () => {
    try {
      if (currentUrl && (currentUrl.startsWith('http://') || currentUrl.startsWith('https://'))) {
        const parsed = new URL(currentUrl);
        // 如果当前是 573 笔误或者处于加载错误状态，安全降级到本地活跃的 5173 端口
        if (parsed.port === '573' || loadError) {
          return 'http://localhost:5173';
        }
        return parsed.origin;
      }
    } catch {}
    return 'http://localhost:5173';
  };

  // 规范化 URL 与路由，杜绝硬性拦截为外网搜索引擎
  const normalizeUrl = (raw: string) => {
    let u = raw.trim();
    if (!u) return '';

    // 智能纠正开发者常见的端口笔误 (573 -> 5173)
    if (/^(https?:\/\/)?(localhost|127\.0\.0\.1):573(\/.*)?$/i.test(u)) {
      u = u.replace(':573', ':5173');
    }

    // 1. 已包含协议头：直接信任，若为根域名则标准化追加末尾斜杠对齐 Chromium 规范
    if (/^https?:\/\//i.test(u) || /^about:/i.test(u) || /^file:\/\//i.test(u)) {
      if (/^https?:\/\/[^/]+$/i.test(u)) {
        return `${u}/`;
      }
      return u;
    }

    // 2. 以斜杠开头表示相对当前站点的路由路径 (例如: "/users", "/admin/dashboard", "/api/data")
    if (u.startsWith('/')) {
      return `${getBaseOrigin()}${u}`;
    }

    // 3. 以冒号开头的端口表示当前机器端口 (例如: ":5173", ":8080/api")
    if (u.startsWith(':')) {
      if (u === ':573' || u.startsWith(':573/')) {
        u = u.replace(':573', ':5173');
      }
      const portUrl = `http://localhost${u}`;
      return /^http:\/\/localhost:\d+$/i.test(portUrl) ? `${portUrl}/` : portUrl;
    }

    // 4. 以 localhost 或本地 IP 开头 (例如: "localhost:5173", "127.0.0.1:3000", "0.0.0.0:8000")
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/.*)?$/i.test(u)) {
      const full = `http://${u}`;
      return /^http:\/\/[^/]+$/i.test(full) ? `${full}/` : full;
    }

    // 5. 局域网 IP (例如: "192.168.1.10:3000", "10.0.0.2:8080")
    if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(u)) {
      const full = `http://${u}`;
      return /^http:\/\/[^/]+$/i.test(full) ? `${full}/` : full;
    }

    // 6. 常见域名格式 (例如: "github.com", "baidu.com", "vitejs.dev", "sub.domain.org/path")
    if (/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+(:[0-9]+)?(\/.*)?$/.test(u)) {
      const full = `https://${u}`;
      return /^https:\/\/[^/]+$/i.test(full) ? `${full}/` : full;
    }

    // 7. 如果用户输入包含空格，判定为搜索意图
    if (u.includes(' ')) {
      return `https://www.google.com/search?q=${encodeURIComponent(u)}`;
    }

    // 8. 若当前处在新标签页（无活动站点）且输入不具备路径或域名特征，判定为搜索意图
    if ((!currentUrl || currentUrl === 'about:blank') && !u.includes('.') && !u.includes('/') && !u.includes(':')) {
      return `https://www.google.com/search?q=${encodeURIComponent(u)}`;
    }

    // 9. 默认情况：作为相对路由直接挂载在当前开发站点上 (例如直接敲 "users", "login", "order/detail?id=1")
    return `${getBaseOrigin()}/${u}`;
  };

  const parseRawInitialUrl = (raw?: string) => {
    let u = (raw || '').trim();
    if (u.startsWith('browser://')) {
      u = u.slice('browser://'.length);
    }
    if (u.includes('#tab=')) {
      u = u.split('#tab=')[0];
    }
    if (!u || u.startsWith('chrome-error://') || u.startsWith('chrome://')) {
      return '';
    }
    if (/^(https?:\/\/)?(localhost|127\.0\.0\.1):573(\/.*)?$/i.test(u)) {
      return u.replace(':573', ':5173');
    }
    return u;
  };

  const initialParsedUrl = parseRawInitialUrl(initialUrl);

  const initialSrcRef = useRef(initialParsedUrl || '');
  const [urlInput, setUrlInput] = useState(initialParsedUrl || '');
  const [currentUrl, setCurrentUrl] = useState(initialParsedUrl || '');
  const [pageTitle, setPageTitle] = useState(tabTitle || (initialParsedUrl ? '内置浏览器' : '新标签页'));
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [inspectActive, setInspectActive] = useState(false);
  const [isDevToolsOpen, setIsDevToolsOpen] = useState(false);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const centerInputRef = useRef<HTMLInputElement | null>(null);

  // 当处于新标签页时，自动聚焦居中快速搜索输入框
  useEffect(() => {
    if (!currentUrl || currentUrl === '' || currentUrl === 'about:blank') {
      const timer = setTimeout(() => {
        centerInputRef.current?.focus();
      }, 60);
      return () => clearTimeout(timer);
    }
  }, [currentUrl]);

  // 密码管理器状态与当前站点凭据同步
  const [pendingPasswordPrompt, setPendingPasswordPrompt] = useState<{
    origin: string;
    username: string;
    password: string;
    isUpdate?: boolean;
  } | null>(null);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showPlainPasswordId, setShowPlainPasswordId] = useState<string | null>(null);
  const [siteCredentials, setSiteCredentials] = useState<SavedCredential[]>([]);
  const passwordModalRef = useRef<HTMLDivElement | null>(null);
  const passwordBtnRef = useRef<HTMLButtonElement | null>(null);

  // 监听已保存密码弹窗的外部点击与 Esc 键取消
  useEffect(() => {
    if (!showPasswordModal && !pendingPasswordPrompt) return;

    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (passwordModalRef.current?.contains(target)) return;
      if (passwordBtnRef.current?.contains(target)) return;
      setShowPasswordModal(false);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (showPasswordModal) setShowPasswordModal(false);
        if (pendingPasswordPrompt) setPendingPasswordPrompt(null);
      }
    };

    window.addEventListener('mousedown', handlePointerDown, true);
    window.addEventListener('touchstart', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown, true);

    return () => {
      window.removeEventListener('mousedown', handlePointerDown, true);
      window.removeEventListener('touchstart', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [showPasswordModal, pendingPasswordPrompt]);

  useEffect(() => {
    if (currentUrl && !currentUrl.startsWith('about:blank')) {
      setSiteCredentials(getCredentialsForOrigin(currentUrl));
    } else {
      setSiteCredentials([]);
    }
  }, [currentUrl]);

  const [consoleLogs, setConsoleLogs] = useState<ConsoleMessage[]>([]);
  const [loadError, setLoadError] = useState<{
    code: number;
    description: string;
    url: string;
  } | null>(null);

  const webviewRef = useRef<any>(null);
  const webviewContainerRef = useRef<HTMLDivElement | null>(null);
  const [devToolsHeight, setDevToolsHeight] = useState(() =>
    Math.min(320, Math.max(180, Math.round(window.innerHeight * 0.35))),
  );
  const [isDraggingDevTools, setIsDraggingDevTools] = useState(false);
  const isDraggingDevToolsRef = useRef(false);
  // 以 ref 承载当前高度：让 calcDevToolsBounds / syncDevToolsBounds 保持引用稳定，
  // 避免拖动时因依赖变化反复销毁重建原生 WebContentsView
  const devToolsHeightRef = useRef(devToolsHeight);
  devToolsHeightRef.current = devToolsHeight;

  const currentUrlRef = useRef(currentUrl);
  currentUrlRef.current = currentUrl;
  const pageTitleRef = useRef(pageTitle);
  pageTitleRef.current = pageTitle;
  const onUpdateTabRef = useRef(onUpdateTab);
  onUpdateTabRef.current = onUpdateTab;

  const onOpenNewTabRef = useRef(onOpenNewTab);
  useEffect(() => {
    onOpenNewTabRef.current = onOpenNewTab;
  }, [onOpenNewTab]);

  const lastNewWindowTimeRef = useRef<{ url: string; time: number } | null>(null);

  // 新建标签页：地址栏给空，让用户手动输入
  const handleCreateNewTab = useCallback(() => {
    if (onOpenNewTabRef.current) {
      onOpenNewTabRef.current('');
    } else {
      window.dispatchEvent(
        new CustomEvent('echoly:openBrowser', {
          detail: { url: '', forceNew: true },
        }),
      );
    }
  }, []);

  // 首页回到新标签页状态，不打开任何地址
  const handleGoHome = useCallback(() => {
    setUrlInput('');
    setCurrentUrl('');
    currentUrlRef.current = '';
    setPageTitle('新标签页');
    pageTitleRef.current = '新标签页';
    setLoadError(null);
    setInspectActive(false);
    onUpdateTabRef.current?.({
      title: '新标签页',
      virtual: {
        browser: {
          url: '',
        },
      },
    });
    const wv = webviewRef.current;
    if (wv) {
      try {
        wv.loadURL('about:blank');
      } catch {}
    }
    setTimeout(() => {
      if (centerInputRef.current) {
        centerInputRef.current.focus();
      } else {
        addressInputRef.current?.focus();
      }
    }, 50);
  }, []);

  // 打开或关闭 Google Chrome 原生 DevTools 开发者控制台 (在浏览器下方展示，不新开窗口/标签)
  const toggleGoogleDevTools = useCallback(() => {
    setIsDevToolsOpen((prev) => !prev);
  }, []);

  const targetWebContentsIdRef = useRef<number | null>(null);

  // 安全获取 WebContentsId，杜绝未触发 dom-ready 前同步调用抛出异常
  const getSafeWebContentsId = useCallback((): number | null => {
    const wv = webviewRef.current;
    if (!wv) return targetWebContentsIdRef.current;
    try {
      if (typeof wv.getWebContentsId === 'function') {
        const id = wv.getWebContentsId();
        if (id) {
          targetWebContentsIdRef.current = id;
          return id;
        }
      }
    } catch {
      // 实例尚未就绪或未发出 dom-ready，安全吸收异常并返回缓存的 ID 或 null
    }
    return targetWebContentsIdRef.current;
  }, []);

  // 计算 DevTools 原生视图的布局（CSS 像素坐标）：
  // 核心原则：DevTools 必须 100% 紧贴 webviewContainerRef 的最底边，杜绝任何中间悬空或黑条！
  // 注意：这里刻意输出 CSS 像素，而不是换算成 DIP —— 缩放因子由主进程统一权威处理，
  // 渲染层一旦自行换算，zoom 取错就会整体上浮、右侧留黑边。
  const calcDevToolsBounds = useCallback((explicitHeight?: number) => {
    const container = webviewContainerRef.current;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    // 允许控制台高度在 80px 到容器高度 88% 之间
    const rawH = explicitHeight ?? devToolsHeightRef.current;
    const clampedHeight = Math.min(Math.round(rect.height * 0.88), Math.max(80, Math.round(rawH)));
    const resizerHeight = 12; // 上方拖拽条把手高度，必须与 .browser-devtools-resizer 的 12px 严格一致
    const bottomInset = resizerHeight + 1; // 另加 1px 消除 dock 顶部边框的取整误差，控制台正好落在其下方
    const contentHeight = Math.max(0, clampedHeight - bottomInset);

    return {
      x: Math.max(0, Math.round(rect.left)),
      // 以容器最底边为基准反推 y，天然规避边框盒模型带来的 1~2px 累计误差，
      // 保证 y + height 恰好落在容器底部，两侧与底部严丝合缝
      y: Math.max(0, Math.round(rect.bottom) - contentHeight),
      width: Math.max(0, Math.round(rect.width)),
      height: contentHeight,
    };
  }, []);

  // 同步 DevTools 视图布局到主进程（主进程负责 CSS 像素 → DIP 的换算）
  const syncDevToolsBounds = useCallback(
    (explicitHeight?: number) => {
      const targetId = getSafeWebContentsId();
      if (!targetId || !window.ide?.updateDevToolsViewBounds) return;
      const bounds = calcDevToolsBounds(explicitHeight);
      if (bounds) {
        window.ide.updateDevToolsViewBounds(targetId, { bounds });
      }
    },
    [getSafeWebContentsId, calcDevToolsBounds],
  );

  // 监听底部原生 WebContentsView 挂载、Chrome DevTools 绑定与全量请求联动
  useEffect(() => {
    if (!isDevToolsOpen) {
      const targetId = targetWebContentsIdRef.current;
      if (targetId && window.ide?.closeDevToolsView) {
        window.ide.closeDevToolsView(targetId);
      }
      return;
    }

    const wv = webviewRef.current;
    if (!wv) return;

    let cancelled = false;

    const setupDevTools = async () => {
      // 等待 Webview guest 实例就绪并触发 dom-ready
      let targetId = getSafeWebContentsId();
      let attempts = 0;
      while (!targetId && attempts < 35 && !cancelled) {
        attempts++;
        await new Promise((r) => setTimeout(r, 60));
        targetId = getSafeWebContentsId();
      }
      if (!targetId || cancelled) return;

      const bounds = calcDevToolsBounds();
      if (!bounds) {
        setTimeout(setupDevTools, 50);
        return;
      }

      if (window.ide?.openDevToolsView) {
        const ok = await window.ide.openDevToolsView(targetId, { bounds });
        if (ok && !cancelled) {
          // 挂载后轻量双重校验对齐，确保视图 100% 吸底
          setTimeout(() => {
            syncDevToolsBounds();
          }, 80);
          setTimeout(() => {
            syncDevToolsBounds();
          }, 240);

        }
      }
    };

    setupDevTools();

    return () => {
      cancelled = true;
      const targetId = targetWebContentsIdRef.current;
      if (targetId && window.ide?.closeDevToolsView) {
        window.ide.closeDevToolsView(targetId);
      }
    };
  }, [isDevToolsOpen, calcDevToolsBounds, syncDevToolsBounds, getSafeWebContentsId]);

  // 当浏览器标签页切至后台（如切换至代码编辑器）时，暂时隐藏 DevTools 原生视图；切回时平滑恢复
  useEffect(() => {
    if (!isDevToolsOpen) return;
    const targetId = targetWebContentsIdRef.current;
    if (!targetId || !window.ide?.updateDevToolsViewBounds) return;

    if (isActive === false) {
      window.ide.updateDevToolsViewBounds(targetId, {
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      });
    } else {
      syncDevToolsBounds();
    }
  }, [isActive, isDevToolsOpen, syncDevToolsBounds]);

  // 监听容器尺寸变化或面板拖拽，实时平滑同步 DevTools 原生视图 Bounds (100% 保持吸底)
  useEffect(() => {
    if (!isDevToolsOpen) return;
    const container = webviewContainerRef.current;
    if (!container) return;

    const handleResize = () => {
      syncDevToolsBounds();
    };

    const onDragEnd = () => {
      // 原生视图在无边框拖动/尺寸变更期间位置可能滞后，停手后强制再对齐一次
      syncDevToolsBounds();
    };

    const ro = new ResizeObserver(() => {
      handleResize();
    });
    ro.observe(container);

    window.addEventListener('resize', handleResize);
    window.addEventListener('mouseup', onDragEnd);

    // 缩放因子变化（Ctrl+±/0 或菜单缩放）后，容器的 CSS 像素尺寸随之改变，必须重新上报坐标
    const offZoom = window.ide?.onZoomChanged?.(() => {
      // 布局在缩放后需要一帧才稳定，延迟同步以取到新的 getBoundingClientRect
      requestAnimationFrame(() => syncDevToolsBounds());
      setTimeout(() => syncDevToolsBounds(), 120);
    });

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('mouseup', onDragEnd);
      offZoom?.();
    };
  }, [isDevToolsOpen, syncDevToolsBounds]);

  // 上下拖动调整 Google DevTools 高度
  // 关键点：DevTools 是原生 WebContentsView，会覆盖在宿页面上方并独占该区域的指针事件。
  // 因此拖动期间绝不能把它隐藏或移出可视区（那样用户全程只看到一块黑屏），
  // 而是让它每一帧都按新高度实时重排，同时把原生视图重新提到顶层子视图，
  // 并把指针事件全部绑定在 window 上，保证拖动全程跟手、画面不黑。
  const handleDevToolsPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = devToolsHeightRef.current;
      const targetId = getSafeWebContentsId();
      let rafId: number | null = null;

      isDraggingDevToolsRef.current = true;
      setIsDraggingDevTools(true);
      // 进入拖动态：主进程会保证原生视图置顶，并按每帧坐标实时重排
      if (targetId) window.ide?.setDevToolsDragging?.(targetId, true);

      const onPointerMove = (ev: PointerEvent) => {
        if (!isDraggingDevToolsRef.current) return;
        const delta = startY - ev.clientY; // 向上拖动高度增加
        const containerH =
          webviewContainerRef.current?.getBoundingClientRect().height || window.innerHeight;
        const newHeight = Math.max(80, Math.min(containerH * 0.88, startHeight + delta));
        const roundedHeight = Math.round(newHeight);
        // 宿页面高度与原生视图同步跟手：控制台随拖动实时改变高度
        setDevToolsHeight(roundedHeight);
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          syncDevToolsBounds(roundedHeight);
        });
      };

      const onPointerUp = () => {
        if (rafId) cancelAnimationFrame(rafId);
        isDraggingDevToolsRef.current = false;
        setIsDraggingDevTools(false);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
        window.removeEventListener('blur', onPointerUp);
        // 按终态兜底对齐一次，再解除拖动态
        syncDevToolsBounds(undefined);
        if (targetId) {
          window.ide?.setDevToolsDragging?.(targetId, false);
        }
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
      window.addEventListener('blur', onPointerUp);
    },
    [syncDevToolsBounds, getSafeWebContentsId],
  );

  // 导航到指定 URL (平滑加载，杜绝 stop() 造成的页面跳动和网络中断)
  const navigateTo = useCallback((targetUrl: string) => {
    const norm = normalizeUrl(targetUrl);
    setUrlInput(norm);
    setCurrentUrl(norm);
    currentUrlRef.current = norm;
    setLoadError(null);
    const wv = webviewRef.current;
    if (wv) {
      try {
        const p = wv.loadURL(norm);
        if (p && typeof p.catch === 'function') {
          p.catch((err: any) => {
            // 安全吸收加载被取消或网络拒绝时的异步异常，避免控制台产生未捕获报错
            console.warn('[BrowserViewPane] loadURL rejected:', err);
          });
        }
      } catch (err) {
        console.warn('Failed to load url:', err);
      }
    }
  }, []);

  // 提交地址栏输入：失去焦点以确保页面获得焦点，消除光标跳动与选区闪烁
  const handleAddressSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    addressInputRef.current?.blur();
    if (urlInput.trim()) {
      navigateTo(urlInput);
    }
  };

  // 切换 Inspect / 选取元素模式
  const toggleInspectMode = useCallback(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    if (inspectActive) {
      setInspectActive(false);
      try {
        wv.executeJavaScript(CANCEL_INSPECT_SCRIPT);
      } catch {}
      onShowToast?.('已退出元素选取模式', 'info');
      return;
    }

    setInspectActive(true);
    onShowToast?.('请点击页面中的目标元素进行引用 (↑/↓ 切换父/子级，Esc 退出)', 'info');

    // 注入脚本返回一个 Promise：用户点击元素或按 Esc 时 resolve。
    // 早期实现走 console.log 哨兵串回传，页面一旦包装 console.log 拾取就静默失效，
    // 现在直接 await 返回值，通道更可靠。
    let picked: string | null = null;
    try {
      picked = wv.executeJavaScript(INJECTED_INSPECT_SCRIPT);
    } catch (err) {
      console.error('Failed to execute inspect script:', err);
      setInspectActive(false);
      return;
    }

    if (!picked || typeof (picked as any).then !== 'function') {
      setInspectActive(false);
      return;
    }

    (picked as unknown as Promise<string | null>)
      .then(async (raw) => {
        // 走到这里说明这一次拾取会话已经结束（点击拾取 / 按 Esc / 被取消），
        // 无论有没有拿到结果都要收起选取态，否则按 Esc 后按钮与提示条会一直亮着。
        setInspectActive(false);
        if (!raw) return;

        let payload: BrowserElementRef;
        try {
          payload = JSON.parse(raw);
        } catch (err) {
          console.error('Failed to parse inspect payload:', err);
          return;
        }

        // 同步抓取元素渲染截图：命中主进程 capturePage，失败（元素已滚出视口等）则静默跳过
        const targetId = getSafeWebContentsId();
        if (targetId && payload.rect && window.ide?.captureBrowserElement) {
          try {
            const shot = await window.ide.captureBrowserElement(targetId, payload.rect);
            if (shot) payload.screenshotDataUrl = shot;
          } catch (err) {
            console.warn('[BrowserViewPane] capture element failed:', err);
          }
        }

        handleElementPickedRef.current?.(payload);
      })
      .catch((err) => {
        // 页面在拾取过程中导航/销毁会让 Promise 以异常收尾，属预期情况
        console.warn('[BrowserViewPane] inspect promise rejected:', err);
        setInspectActive(false);
      });
  }, [inspectActive, onShowToast, getSafeWebContentsId]);

  // 处理拾取到的元素数据
  const handleElementPicked = useCallback(
    (payload: BrowserElementRef) => {
      const label = `<${payload.tagName}${payload.id ? '#' + payload.id : ''}>`;
      const dupTip =
        payload.selectorMatchCount && payload.selectorMatchCount > 1
          ? ` (选择器命中 ${payload.selectorMatchCount} 个同类元素)`
          : '';
      onShowToast?.(`已拾取元素 ${label}${dupTip}`, 'success');
      if (onAddElementToChat) {
        onAddElementToChat(payload);
      } else {
        // 全局事件回退
        window.dispatchEvent(
          new CustomEvent('echoly:addBrowserElementRefToChat', {
            detail: payload,
          }),
        );
      }
    },
    [onAddElementToChat, onShowToast],
  );
  const handleElementPickedRef = useRef(handleElementPicked);
  handleElementPickedRef.current = handleElementPicked;

  // 一键将整页引用到对话框
  const handleQuotePageToChat = useCallback(() => {
    const errorMessages = consoleLogs
      .filter((l) => l.level === 'error')
      .slice(-5)
      .map((l) => l.message);

    const info = {
      url: currentUrl,
      title: pageTitle,
      errors: errorMessages,
    };

    if (onAddPageToChat) {
      onAddPageToChat(info);
    } else {
      window.dispatchEvent(
        new CustomEvent('echoly:addBrowserRefToChat', {
          detail: info,
        }),
      );
    }
    onShowToast?.(`已将标签页 "${pageTitle}" 引用至 AI 对话`, 'success');
  }, [currentUrl, pageTitle, consoleLogs, onAddPageToChat, onShowToast]);

  // 绑定 Webview 事件：只在组件挂载时执行一次，生命周期完全稳定
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    // SPA 路由订阅：一次订阅只上报一次路由变化，收到后自动续订。
    // routeToken 用于文档切换时废弃上一份订阅，避免旧 Promise 的回调把新文档的订阅顶掉。
    let routeWatchCancelled = false;
    let routeToken = 0;
    const syncCurrentUrlRef: { current: ((url?: string) => void) | null } = { current: null };

    const armRouteWatch = () => {
      const myToken = ++routeToken;
      const subscribe = () => {
        if (routeWatchCancelled || myToken !== routeToken) return;
        let ret: any;
        try {
          ret = wv.executeJavaScript(ROUTE_SYNC_SCRIPT);
        } catch {
          return;
        }
        if (!ret || typeof ret.then !== 'function') return;
        (ret as Promise<string | null>)
          .then((href) => {
            if (routeWatchCancelled || myToken !== routeToken) return;
            if (href) syncCurrentUrlRef.current?.(href);
            subscribe();
          })
          .catch(() => {
            // 页面导航/销毁会让订阅 Promise 以异常收尾，dom-ready 时会重新挂载
          });
      };
      subscribe();
    };

    const syncCurrentUrl = (newUrl?: string) => {
      const actual = (newUrl || (typeof wv.getURL === 'function' ? wv.getURL() : '') || '').trim();
      // 绝不同步空白页、Chromium 内部错误页及扩展地址，保持用户原本请求的目标地址
      if (
        !actual ||
        actual === 'about:blank' ||
        actual.startsWith('chrome-error://') ||
        actual.startsWith('chrome://') ||
        actual.startsWith('devtools://')
      ) {
        return;
      }
      if (actual !== currentUrlRef.current) {
        currentUrlRef.current = actual;
        setCurrentUrl(actual);
        // 若用户当前没有在输入框内处于交互打字状态，平滑同步实际 URL，避免文字跳动
        if (document.activeElement !== addressInputRef.current) {
          setUrlInput(actual);
        }
        setLoadError(null);
        onUpdateTabRef.current?.({
          virtual: { browser: { url: actual, title: pageTitleRef.current } },
        });
        // 页面地址变化后必须让页面内的拾取会话一并收尾：
        // SPA pushState 导航不会重新加载页面，注入的监听器与高亮框会继续存活，
        // 只改 React 状态会让按钮显示为未激活、语义反转（再点一次反而变成取消）。
        setInspectActive(false);
        try {
          wv.executeJavaScript(CANCEL_INSPECT_SCRIPT);
        } catch {}
      }
    };
    syncCurrentUrlRef.current = syncCurrentUrl;

    const handleDidStartLoading = () => {
      setIsLoading(true);
      setLoadError(null);
    };

    const injectPasswordInterceptors = () => {
      try {
        wv.executeJavaScript(PASSWORD_INTERCEPTOR_SCRIPT);
      } catch {}

      const creds = getCredentialsForOrigin(currentUrlRef.current);
      if (creds.length > 0) {
        setTimeout(() => {
          try {
            wv.executeJavaScript(buildAutofillScript(creds[0].username, creds[0].password));
          } catch {}
        }, 200);
      }
    };

    const handleDidStopLoading = () => {
      setIsLoading(false);
      syncCurrentUrl(wv.getURL?.());
      try {
        setCanGoBack(wv.canGoBack());
        setCanGoForward(wv.canGoForward());
      } catch {}
      injectPasswordInterceptors();
    };

    const handleDomReady = () => {
      try {
        if (typeof wv.getWebContentsId === 'function') {
          targetWebContentsIdRef.current = wv.getWebContentsId();
        }
      } catch {}
      syncCurrentUrl(wv.getURL?.());
      // 文档已就绪：重新武装 SPA 路由订阅（上一份订阅随旧文档一起失效）
      armRouteWatch();
      // 注入账号密码表单拦截器并尝试智能自动填充
      injectPasswordInterceptors();
    };

    const handlePageTitleUpdated = (e: any) => {
      const t = e.title || '内置浏览器';
      // 忽略 Chromium 错误页标题
      if (t.includes('chromewebdata') || t.includes('chrome-error://')) return;
      setPageTitle(t);
      onUpdateTabRef.current?.({
        title: t,
        virtual: { browser: { url: currentUrlRef.current, title: t } },
      });
    };

    const handleDidNavigate = (e: any) => {
      if (e?.url && !e.url.startsWith('chrome-error://') && !e.url.startsWith('chrome://')) {
        syncCurrentUrl(e.url);
      }
    };

    const handleNewWindow = (e: any) => {
      e?.preventDefault?.();
      const u = (e?.url || '').trim();
      if (!u || u === 'about:blank') return;

      const now = Date.now();
      if (
        lastNewWindowTimeRef.current &&
        lastNewWindowTimeRef.current.url === u &&
        now - lastNewWindowTimeRef.current.time < 800
      ) {
        return;
      }
      lastNewWindowTimeRef.current = { url: u, time: now };

      // 对新的路由和弹窗都不要拦截：直接在内置浏览器的新标签页中打开，无缝浏览
      if (onOpenNewTabRef.current) {
        onOpenNewTabRef.current(u);
      } else {
        window.dispatchEvent(
          new CustomEvent('echoly:openBrowser', {
            detail: { url: u, forceNew: true },
          }),
        );
      }
    };

    const handleDidFailLoad = (e: any) => {
      // 忽略用户主动停止加载 (-3: ERR_ABORTED)
      if (e.errorCode === -3) return;
      setIsLoading(false);
      setLoadError({
        code: e.errorCode,
        description: e.errorDescription || '无法连接到该地址',
        url: e.validatedURL || currentUrlRef.current,
      });
    };

    const handleConsoleMessage = (e: any) => {
      const msg = e.message || '';

      // 捕获页面提交的账号密码表单并提示保存
      if (msg.startsWith('__ECHOLY_PW_CAPTURED__:')) {
        try {
          const payload = JSON.parse(msg.slice('__ECHOLY_PW_CAPTURED__:'.length));
          if (payload?.origin && payload?.password) {
            const userStr = (payload.username || '').trim();
            const pwStr = payload.password || '';
            const existing = getCredentialsForOrigin(payload.origin);
            const identical = existing.some(
              (c) => c.username.toLowerCase() === userStr.toLowerCase() && c.password === pwStr,
            );
            if (!identical) {
              setPendingPasswordPrompt({
                origin: payload.origin,
                username: userStr,
                password: pwStr,
                isUpdate: existing.some((c) => c.username.toLowerCase() === userStr.toLowerCase()),
              });
            }
          }
        } catch {}
        return;
      }

      // 捕获页面新标签页打开请求 (如 target="_blank" 或 window.open)
      if (msg.startsWith('__ECHOLY_OPEN_NEW_TAB__:')) {
        const targetUrl = msg.slice('__ECHOLY_OPEN_NEW_TAB__:'.length).trim();
        if (targetUrl) {
          handleNewWindow({ url: targetUrl });
        }
        return;
      }

      // 正常记录控制台日志。
      // Electron 的 console-message level 语义为 0=verbose / 1=info / 2=warning / 3=error，
      // 实测 console.log 落在 1、console.warn 落在 2、console.error 落在 3。
      // 早前把 2 当 error、1 当 warn，导致普通日志被染红、真正的报错反而从未被统计进 errorCount。
      const level: ConsoleMessage['level'] =
        e.level === 3 ? 'error' : e.level === 2 ? 'warn' : e.level === 1 ? 'log' : 'info';

      setConsoleLogs((prev) => [
        ...prev.slice(-199), // 保留最新 200 条
        {
          id: `${Date.now()}-${Math.random()}`,
          level,
          message: msg,
          sourceId: e.sourceId,
          line: e.line,
          timestamp: Date.now(),
        },
      ]);
    };

    const handleDevToolsOpened = () => setIsDevToolsOpen(true);
    const handleDevToolsClosed = () => setIsDevToolsOpen(false);

    wv.addEventListener('did-start-loading', handleDidStartLoading);
    wv.addEventListener('did-stop-loading', handleDidStopLoading);
    wv.addEventListener('dom-ready', handleDomReady);
    wv.addEventListener('page-title-updated', handlePageTitleUpdated);
    wv.addEventListener('did-navigate', handleDidNavigate);
    wv.addEventListener('did-navigate-in-page', handleDidNavigate);
    wv.addEventListener('did-redirect-navigation', handleDidNavigate);
    wv.addEventListener('will-navigate', handleDidNavigate);
    wv.addEventListener('new-window', handleNewWindow);
    wv.addEventListener('did-fail-load', handleDidFailLoad);
    wv.addEventListener('console-message', handleConsoleMessage);
    wv.addEventListener('devtools-opened', handleDevToolsOpened);
    wv.addEventListener('devtools-closed', handleDevToolsClosed);

    // 定时检查原生 URL，精准捕获 SPA 路由重定向 (如 / 自动重定向到 /login)，不再需要用户手动补全
    const spaRouteCheckTimer = setInterval(() => {
      try {
        const u = wv.getURL?.();
        if (u && !u.startsWith('about:blank') && !u.startsWith('chrome-error://') && !u.startsWith('devtools://')) {
          syncCurrentUrl(u);
        }
      } catch {}
    }, 200);

    return () => {
      routeWatchCancelled = true;
      clearInterval(spaRouteCheckTimer);
      wv.removeEventListener('did-start-loading', handleDidStartLoading);
      wv.removeEventListener('did-stop-loading', handleDidStopLoading);
      wv.removeEventListener('dom-ready', handleDomReady);
      wv.removeEventListener('page-title-updated', handlePageTitleUpdated);
      wv.removeEventListener('did-navigate', handleDidNavigate);
      wv.removeEventListener('did-navigate-in-page', handleDidNavigate);
      wv.removeEventListener('did-redirect-navigation', handleDidNavigate);
      wv.removeEventListener('will-navigate', handleDidNavigate);
      wv.removeEventListener('new-window', handleNewWindow);
      wv.removeEventListener('did-fail-load', handleDidFailLoad);
      wv.removeEventListener('console-message', handleConsoleMessage);
      wv.removeEventListener('devtools-opened', handleDevToolsOpened);
      wv.removeEventListener('devtools-closed', handleDevToolsClosed);
    };
  }, []);

  const errorCount = consoleLogs.filter((l) => l.level === 'error').length;

  const triggerAutofill = useCallback((cred: SavedCredential) => {
    const wv = webviewRef.current;
    if (wv) {
      try {
        wv.executeJavaScript(buildAutofillScript(cred.username, cred.password));
      } catch {}
    }
  }, []);

  const isNewTabPage = !currentUrl || currentUrl === '' || currentUrl === 'about:blank';

  return (
    <div
      className="echoly-browser-pane"
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: 'var(--bg-editor, #141414)',
        color: 'var(--text)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* 拖拽控制台高度时的全局事件捕获透明遮罩，彻底杜绝鼠标穿透至 webview 导致丢失事件或劫持光标 */}
      {isDraggingDevTools && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 999999,
            cursor: 'row-resize',
            userSelect: 'none',
            background: 'transparent',
          }}
        />
      )}
      {/* ── 顶部浏览器工具栏 (高度严格 30px, 对齐 IDE / Maven 面板规范) ── */}
      <div
        className="browser-toolbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 30,
          padding: '0 10px',
          background: 'rgba(255, 255, 255, 0.03)',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
          boxSizing: 'border-box',
          userSelect: 'none',
        }}
      >
        {/* 导航按钮组 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            className="panel-action-btn"
            title="后退 (Alt+Left)"
            disabled={!canGoBack}
            onClick={() => webviewRef.current?.goBack?.()}
            style={{ opacity: canGoBack ? 1 : 0.4 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button
            type="button"
            className="panel-action-btn"
            title="前进 (Alt+Right)"
            disabled={!canGoForward}
            onClick={() => webviewRef.current?.goForward?.()}
            style={{ opacity: canGoForward ? 1 : 0.4 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
          <button
            type="button"
            className="panel-action-btn"
            title={isLoading ? '停止加载' : '重新加载 (Cmd/Ctrl+R)'}
            onClick={() => {
              if (isLoading) webviewRef.current?.stop?.();
              else webviewRef.current?.reload?.();
            }}
          >
            {isLoading ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M23 4v6h-6" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="panel-action-btn"
            title="首页 (显示新标签页，不打开任何地址)"
            onClick={handleGoHome}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          </button>
          {/* 新增标签页 */}
          <button
            type="button"
            className="panel-action-btn"
            title="新建浏览器标签页"
            onClick={handleCreateNewTab}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>

        {/* 地址栏输入框 */}
        <form
          onSubmit={handleAddressSubmit}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            position: 'relative',
            minWidth: 160,
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: 10,
              display: 'flex',
              alignItems: 'center',
              pointerEvents: 'none',
              color: currentUrl.startsWith('https://') ? '#4ade80' : 'var(--muted)',
            }}
          >
            {currentUrl.startsWith('https://') ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
            )}
          </div>
          <input
            ref={addressInputRef}
            type="text"
            className="browser-address-input"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => {
              if (currentUrlRef.current) {
                setUrlInput(currentUrlRef.current);
              }
            }}
            placeholder="输入网址或页面路由 (如 localhost:5173，按回车访问)..."
            autoFocus={!initialParsedUrl}
            style={{
              width: '100%',
              height: 22,
              background: 'rgba(0, 0, 0, 0.35)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: 5,
              paddingLeft: 26,
              paddingRight: 26,
              color: '#ffffff',
              fontSize: 12,
              outline: 'none',
              boxSizing: 'border-box',
              transition: 'all 0.15s ease',
            }}
          />
          {isLoading && (
            <div
              style={{
                position: 'absolute',
                right: 8,
                width: 12,
                height: 12,
                border: '2px solid rgba(255, 255, 255, 0.2)',
                borderTopColor: 'var(--accent, #3b82f6)',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite',
              }}
            />
          )}
        </form>

        {/* ── 右侧控制与引用操作区 ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {/* 【核心功能：图1 检查元素并引用到聊天框按钮】 */}
          <button
            type="button"
            className={`panel-action-btn ${inspectActive ? 'active' : ''}`}
            title={inspectActive ? '正在选取元素 (点击页面任意元素，按 Esc 取消)' : '检查元素：直接选取页面特定元素引用到聊天框'}
            onClick={toggleInspectMode}
            style={{
              background: inspectActive ? 'rgba(59, 130, 246, 0.25)' : undefined,
              borderColor: inspectActive ? 'rgba(59, 130, 246, 0.6)' : undefined,
              color: inspectActive ? '#60a5fa' : undefined,
              boxShadow: inspectActive ? '0 0 8px rgba(59, 130, 246, 0.3)' : undefined,
            }}
          >
            <IconInspectElement active={inspectActive} />
          </button>

          {/* 引用整个页面到对话 */}
          <button
            type="button"
            className="panel-action-btn"
            title="将当前页面标签引用到聊天框"
            onClick={handleQuotePageToChat}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              <line x1="9" y1="10" x2="15" y2="10" />
              <line x1="12" y1="7" x2="12" y2="13" />
            </svg>
          </button>

          {/* 浏览器右上角的终端：直接在下方展示 Google 开发者控制台 (Chrome DevTools)，不新开窗口/标签 */}
          <button
            type="button"
            className={`panel-action-btn ${isDevToolsOpen ? 'active' : ''}`}
            title={isDevToolsOpen ? "关闭下方 Google 控制台 (Chrome DevTools)" : "在下方展开 Google 控制台 (Chrome DevTools)"}
            onClick={toggleGoogleDevTools}
            style={{ position: 'relative' }}
          >
            <svg style={{ pointerEvents: 'none' }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            {errorCount > 0 && !isDevToolsOpen && (
              <span
                style={{
                  position: 'absolute',
                  top: 2,
                  right: 2,
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: '#ef4444',
                  pointerEvents: 'none',
                }}
              />
            )}
          </button>


          {/* 密码管理器与自动回填快捷入口 */}
          <button
            ref={passwordBtnRef}
            type="button"
            className={`panel-action-btn ${siteCredentials.length > 0 ? 'active' : ''}`}
            title={
              siteCredentials.length > 0
                ? `密码管理器：此站点已保存 ${siteCredentials.length} 个账号密码 (点击查看/一键填入)`
                : '密码管理器：查看与管理此站点保存的密码'
            }
            onClick={() => setShowPasswordModal((prev) => !prev)}
            style={{
              color: siteCredentials.length > 0 ? '#38bdf8' : undefined,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="7.5" cy="15.5" r="4.5" />
              <path d="M21 2l-9.6 9.6" />
              <path d="M15.5 7.5l3 3" />
            </svg>
          </button>

          {/* 外部默认浏览器打开 */}
          <button
            type="button"
            className="panel-action-btn"
            title="在系统外部浏览器中打开"
            onClick={() => {
              if (window.ide?.openExternal) {
                window.ide.openExternal(currentUrl);
              } else {
                window.open(currentUrl, '_blank');
              }
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── 检查模式提示栏 ── */}
      {inspectActive && (
        <div
          style={{
            height: 26,
            background: 'linear-gradient(90deg, #1d4ed8, #2563eb)',
            color: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 12px',
            fontSize: 11.5,
            fontWeight: 500,
            flexShrink: 0,
            boxShadow: '0 2px 8px rgba(37, 99, 235, 0.3)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-flex', animation: 'pulse 1.5s infinite' }}>🎯</span>
            <span>元素检查选取模式已开启：移动鼠标查看元素高亮，点击即可精准引用至聊天框</span>
          </div>
          <button
            type="button"
            onClick={toggleInspectMode}
            style={{
              background: 'rgba(255, 255, 255, 0.2)',
              border: 'none',
              borderRadius: 3,
              color: '#ffffff',
              padding: '1px 8px',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            退出 (Esc)
          </button>
        </div>
      )}

      {/* ── 主页面 Webview 视口 + 底部 Google 原生 DevTools 控制台 ── */}
      <div
        ref={webviewContainerRef}
        className="browser-webview-container"
        style={{
          flex: 1,
          width: '100%',
          minHeight: 0,
          position: 'relative',
          background: isNewTabPage ? 'var(--bg-editor, #141414)' : '#ffffff',
          colorScheme: isNewTabPage ? 'dark' : 'normal',
          overflow: 'hidden',
        }}
      >
        {/*
          主页面 Webview：
          当 DevTools 开启时，高度严格限制在顶部至控制台上方，彻底杜绝网页内容延伸至控制台下方。
          拖动时同样按新高度实时跟手（原生控制台视图保持原位可见，不参与重排，
          因此这里无需额外让出热区，也不会出现黑屏）。
        */}
        {/* 密码保存/更新询问浮窗 (Chrome 风格) */}
        {pendingPasswordPrompt && (
          <div
            className="browser-password-save-prompt"
            style={{
              position: 'absolute',
              top: 10,
              right: 12,
              width: 320,
              background: '#1e1e1e',
              border: '1px solid rgba(255, 255, 255, 0.16)',
              borderRadius: 8,
              boxShadow: '0 8px 30px rgba(0, 0, 0, 0.65)',
              zIndex: 100,
              padding: '14px 16px',
              color: '#f3f4f6',
              boxSizing: 'border-box',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13 }}>
                <span style={{ fontSize: 16 }}>🔑</span>
                <span>{pendingPasswordPrompt.isUpdate ? '更新此网站的密码？' : '保存此网站的密码？'}</span>
              </div>
              <button
                type="button"
                className="panel-action-btn"
                title="关闭"
                onClick={() => setPendingPasswordPrompt(null)}
              >
                ✕
              </button>
            </div>

            <div style={{ fontSize: 12, color: 'var(--muted, #9ca3af)', marginBottom: 10, wordBreak: 'break-all' }}>
              站点：<strong style={{ color: '#e5e7eb' }}>{pendingPasswordPrompt.origin}</strong>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
              <div>
                <label style={{ fontSize: 11, color: 'var(--muted, #9ca3af)', display: 'block', marginBottom: 3 }}>
                  用户名 / 账号
                </label>
                <input
                  type="text"
                  value={pendingPasswordPrompt.username}
                  onChange={(e) =>
                    setPendingPasswordPrompt((prev) => (prev ? { ...prev, username: e.target.value } : null))
                  }
                  placeholder="未识别到用户名，可手动输入"
                  style={{
                    width: '100%',
                    height: 28,
                    background: 'rgba(0, 0, 0, 0.4)',
                    border: '1px solid rgba(255, 255, 255, 0.12)',
                    borderRadius: 4,
                    padding: '0 8px',
                    color: '#fff',
                    fontSize: 12,
                    boxSizing: 'border-box',
                    outline: 'none',
                  }}
                />
              </div>

              <div>
                <label style={{ fontSize: 11, color: 'var(--muted, #9ca3af)', display: 'block', marginBottom: 3 }}>
                  密码
                </label>
                <input
                  type="password"
                  value={pendingPasswordPrompt.password}
                  readOnly
                  style={{
                    width: '100%',
                    height: 28,
                    background: 'rgba(0, 0, 0, 0.4)',
                    border: '1px solid rgba(255, 255, 255, 0.12)',
                    borderRadius: 4,
                    padding: '0 8px',
                    color: '#9ca3af',
                    fontSize: 12,
                    boxSizing: 'border-box',
                    outline: 'none',
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                className="btn secondary"
                onClick={() => setPendingPasswordPrompt(null)}
                style={{ fontSize: 12, padding: '4px 12px' }}
              >
                暂不
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  saveCredential(
                    pendingPasswordPrompt.origin,
                    pendingPasswordPrompt.username,
                    pendingPasswordPrompt.password,
                  );
                  const updated = getCredentialsForOrigin(pendingPasswordPrompt.origin);
                  setSiteCredentials(updated);
                  onShowToast?.(
                    pendingPasswordPrompt.isUpdate ? '已更新该站点的密码' : '已保存该站点的账号密码',
                    'success',
                  );
                  setPendingPasswordPrompt(null);
                }}
                style={{ fontSize: 12, padding: '4px 14px' }}
              >
                {pendingPasswordPrompt.isUpdate ? '更新' : '保存'}
              </button>
            </div>
          </div>
        )}

        {/* 当前站点已保存密码管理弹层 */}
        {showPasswordModal && (
          <>
            <div
              className="browser-password-backdrop"
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 99,
                background: 'transparent',
              }}
              onMouseDown={() => setShowPasswordModal(false)}
            />
            <div
              ref={passwordModalRef}
              className="browser-password-manager-dropdown"
              style={{
                position: 'absolute',
                top: 10,
                right: 12,
                width: 340,
                background: '#1e1e1e',
                border: '1px solid rgba(255, 255, 255, 0.16)',
                borderRadius: 8,
                boxShadow: '0 8px 30px rgba(0, 0, 0, 0.65)',
                zIndex: 100,
                padding: '14px 16px',
                color: '#f3f4f6',
                boxSizing: 'border-box',
              }}
            >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13 }}>
                <span>🔑</span>
                <span>已保存的密码 ({siteCredentials.length})</span>
              </div>
              <button
                type="button"
                className="panel-action-btn"
                title="关闭"
                onClick={() => setShowPasswordModal(false)}
              >
                ✕
              </button>
            </div>

            <div style={{ fontSize: 12, color: 'var(--muted, #9ca3af)', marginBottom: 12 }}>
              当前站点：<span style={{ color: '#60a5fa' }}>{extractOrigin(currentUrl) || '无活动网页'}</span>
            </div>

            {siteCredentials.length === 0 ? (
              <div style={{ padding: '16px 0', textAlign: 'center', fontSize: 12, color: 'var(--muted, #9ca3af)' }}>
                当前站点尚未保存账号密码
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 220, overflowY: 'auto' }}>
                {siteCredentials.map((cred) => (
                  <div
                    key={cred.id}
                    style={{
                      background: 'rgba(255, 255, 255, 0.04)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: 6,
                      padding: '8px 10px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#f3f4f6' }}>
                        {cred.username || '未命名账号'}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <button
                          type="button"
                          className="btn secondary"
                          title="自动填入当前登录页"
                          onClick={() => {
                            triggerAutofill(cred);
                            onShowToast?.(`已自动填入账号 ${cred.username}`, 'info');
                            setShowPasswordModal(false);
                          }}
                          style={{ fontSize: 11, padding: '2px 8px' }}
                        >
                          填入
                        </button>
                        <button
                          type="button"
                          className="panel-action-btn"
                          title="删除此凭据"
                          onClick={() => {
                            deleteCredential(cred.id);
                            const updated = getCredentialsForOrigin(currentUrl);
                            setSiteCredentials(updated);
                            onShowToast?.('已删除该账号凭据', 'info');
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted, #9ca3af)' }}>
                      <span>
                        密码：{showPlainPasswordId === cred.id ? cred.password : '••••••••'}
                      </span>
                      <button
                        type="button"
                        style={{ background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', padding: 0, fontSize: 11 }}
                        onClick={() =>
                          setShowPlainPasswordId(showPlainPasswordId === cred.id ? null : cred.id)
                        }
                      >
                        {showPlainPasswordId === cred.id ? '隐藏' : '显示'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          </>
        )}

        <div
          className="browser-webview-viewport"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            width: '100%',
            height: isDevToolsOpen ? `calc(100% - ${devToolsHeight}px)` : '100%',
            display: 'flex',
            background: isNewTabPage ? 'transparent' : '#ffffff',
            colorScheme: isNewTabPage ? 'dark' : 'normal',
            visibility: isNewTabPage ? 'hidden' : 'visible',
            pointerEvents: (isNewTabPage || isDraggingDevTools) ? 'none' : 'auto',
          }}
        >
          <WebviewInner
            ref={webviewRef}
            initialSrc={initialParsedUrl || 'about:blank'}
            isNewTab={isNewTabPage}
          />
        </div>

        {/* 拖动遮罩由面板顶层那一处统一承担（position: fixed 相对视口，重复渲染没有意义） */}

        {/*
          Google 原生控制台 (Chrome DevTools)：
          使用 position: absolute; bottom: 0 强力锁定停靠在浏览器视口最底部！
        */}
        {isDevToolsOpen && (
          <div
            className="browser-devtools-dock"
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              width: '100%',
              height: devToolsHeight,
              display: 'flex',
              flexDirection: 'column',
              background: '#202124',
              zIndex: 20,
              borderTop: '1px solid rgba(255, 255, 255, 0.12)',
            }}
          >
            {/* 上下拖拽分界线及触控手柄 */}
            <div
              className="browser-devtools-resizer"
              onPointerDown={handleDevToolsPointerDown}
              title="上下拖动调整控制台高度（按住并上下拖拽）"
              style={{
                height: 12,
                cursor: 'row-resize',
                background: isDraggingDevTools ? 'rgba(59, 130, 246, 0.4)' : 'rgba(255, 255, 255, 0.06)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '100%',
                flexShrink: 0,
                userSelect: 'none',
                position: 'relative',
                zIndex: 30,
                transition: 'background 0.15s ease',
              }}
            >
              {/* 向上扩 6px 的热区：原生控制台视图紧贴拖拽条下方，热区只向上扩，避免压到原生视图上反而抓不到 */}
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: -6,
                  bottom: 0,
                  cursor: 'row-resize',
                }}
              />
              <div
                style={{
                  width: 44,
                  height: 4,
                  borderRadius: 2,
                  background: isDraggingDevTools ? '#3b82f6' : 'rgba(255, 255, 255, 0.45)',
                  transition: 'background 0.15s ease',
                  pointerEvents: 'none',
                }}
              />
            </div>
            {/* DevTools 原生容器挂载占位区 (WebContentsView 精准对齐并覆盖于此) */}
            <div
              style={{
                flex: 1,
                width: '100%',
                position: 'relative',
                background: '#202124',
                overflow: 'hidden',
              }}
            />
          </div>
        )}

        {/* 空地址栏时呈现的新标签页起始界面 */}
        {isNewTabPage && (
          <div
            className="browser-newtab-welcome"
            style={{
              position: 'absolute',
              inset: 0,
              background: 'var(--bg-editor, #141414)',
              color: 'var(--text)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '32px 24px',
              textAlign: 'center',
              zIndex: 10,
              userSelect: 'none',
            }}
          >
            {/* 浏览器 Logo 徽章 */}
            <div
              style={{
                width: 60,
                height: 60,
                borderRadius: 18,
                background: 'rgba(56, 189, 248, 0.08)',
                border: '1px solid rgba(56, 189, 248, 0.25)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 16,
                color: '#38bdf8',
              }}
            >
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
            </div>

            <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 8px', color: '#f3f4f6', letterSpacing: '-0.02em' }}>
              新标签页
            </h2>
            <p style={{ fontSize: 13, color: 'var(--muted, #9ca3af)', margin: '0 0 24px', maxWidth: 440 }}>
              输入网址或页面路由，按回车即可立即访问
            </p>

            {/* 居中快速搜索与网址输入框 */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (urlInput.trim()) {
                  navigateTo(urlInput);
                }
              }}
              style={{
                width: '100%',
                maxWidth: 520,
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                marginBottom: 28,
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: 14,
                  display: 'flex',
                  alignItems: 'center',
                  color: 'var(--muted, #9ca3af)',
                  pointerEvents: 'none',
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </div>
              <input
                ref={centerInputRef}
                type="text"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="搜索或输入网址 (如 localhost:5173、:3000、域名等)..."
                style={{
                  width: '100%',
                  height: 44,
                  padding: '0 44px 0 42px',
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid var(--border-strong, rgba(255, 255, 255, 0.16))',
                  borderRadius: 22,
                  color: 'var(--text, #fff)',
                  fontSize: 13,
                  outline: 'none',
                  boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)',
                  transition: 'all 0.2s ease',
                  boxSizing: 'border-box',
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = 'var(--accent, #38bdf8)';
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                  e.currentTarget.style.boxShadow = '0 0 0 3px rgba(56, 189, 248, 0.2)';
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border-strong, rgba(255, 255, 255, 0.16))';
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                  e.currentTarget.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.3)';
                }}
              />
              <button
                type="submit"
                style={{
                  position: 'absolute',
                  right: 7,
                  width: 30,
                  height: 30,
                  borderRadius: 15,
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--accent, #38bdf8)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  opacity: urlInput.trim() ? 1 : 0.4,
                }}
                title="前往"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </form>

            {/* 本地开发服务（5173、3000、8080）与常用入口磁贴 */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--muted, #9ca3af)', letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600 }}>
                本地开发服务与常用磁贴
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 560 }}>
                {[
                  { label: '⚡ 本地服务 (5173)', url: 'http://localhost:5173', tip: 'Vite 开发服务' },
                  { label: '⚛️ 本地服务 (3000)', url: 'http://localhost:3000', tip: 'Node / React 服务' },
                  { label: '☕ 本地服务 (8080)', url: 'http://localhost:8080', tip: 'Spring / 后端 API 服务' },
                  { label: '🔍 Google 搜索', url: 'https://www.google.com', tip: '搜索引擎' },
                  { label: '🐙 GitHub', url: 'https://github.com', tip: '代码托管与开源平台' },
                ].map((item) => (
                  <button
                    key={item.url}
                    type="button"
                    onClick={() => navigateTo(item.url)}
                    style={{
                      padding: '8px 14px',
                      borderRadius: 8,
                      background: 'rgba(255, 255, 255, 0.04)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      color: 'var(--text-secondary, #d1d5db)',
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      transition: 'all 0.15s ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(56, 189, 248, 0.12)';
                      e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.4)';
                      e.currentTarget.style.color = '#38bdf8';
                      e.currentTarget.style.transform = 'translateY(-1px)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
                      e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                      e.currentTarget.style.color = 'var(--text-secondary, #d1d5db)';
                      e.currentTarget.style.transform = 'none';
                    }}
                    title={`点击立即前往 ${item.url} (${item.tip})`}
                  >
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* 无法连接或加载失败时的友好提示层 */}
        {loadError && (
          <div
            className="browser-error-overlay"
            style={{
              position: 'absolute',
              inset: 0,
              background: 'var(--bg-editor, #141414)',
              color: 'var(--text)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
              textAlign: 'center',
              zIndex: 10,
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: '50%',
                background: 'rgba(239, 68, 68, 0.12)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 14,
                color: '#ef4444',
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 8px', color: '#f8fafc' }}>
              无法访问此网页
            </h3>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 6px', maxWidth: 460 }}>
              无法连接至 <code style={{ color: '#60a5fa', background: 'rgba(255,255,255,0.06)', padding: '2px 6px', borderRadius: 4 }}>{loadError.url}</code>
            </p>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 18px', maxWidth: 440, lineHeight: 1.6 }}>
              {loadError.url.includes(':573') ? (
                <span style={{ color: '#f59e0b' }}>
                  提示：端口可能是笔误（573 少输入了 1），当前机器活跃开发服务在 <strong>5173</strong> 端口。
                </span>
              ) : (
                `${loadError.description} (${loadError.code})。如果这是本地开发项目，请确认服务已在对应端口启动。`
              )}
            </p>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
              <button
                type="button"
                className="btn primary"
                onClick={() => navigateTo('http://localhost:5173')}
                style={{ fontSize: 12, padding: '5px 16px' }}
              >
                立即打开活跃服务 (http://localhost:5173)
              </button>
              <button
                type="button"
                className="btn secondary"
                onClick={() => navigateTo(loadError.url)}
                style={{ fontSize: 12, padding: '5px 12px' }}
              >
                重试加载当前地址
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default BrowserViewPane;
