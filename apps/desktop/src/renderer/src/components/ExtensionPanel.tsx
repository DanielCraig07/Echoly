/**
 * 扩展面板 —— 市场浏览与已安装管理。
 *
 * 布局对齐参考稿：顶部一个搜索框；下面按分区（已安装 / 推荐，搜索时换成搜索结果）
 * 列出扩展，每条一行：图标 + 标题行（名称 + 右侧统计）+ 描述 + 发布者行（右侧操作）。
 *
 * 三个刻意的取舍，都是同一句话：「宁可少一个控件，也不要一个点不动的控件」。
 *
 * 1. **不做齿轮菜单。** 参考稿每条右下角有个齿轮，本应用没有「禁用 / 卸载」这两个能力，
 *    挂一个点开是空的齿轮比不放更糟 —— 这正是之前那个「假的暂停补全按钮」的同类问题。
 * 2. **推荐列表只收通用构建。** 见主进程 getRecommendedExtensions。
 * 3. **搜索框右侧两个图标都有真实行为**：清空、隐藏已安装。参考稿那两个图标在这里
 *    对应得上，所以保留；否则宁可不画。
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useI18n } from '../i18n';
import type { MarketplaceDetailEntry, MarketplaceEntry } from '@deepseek-ide/shared';
import { EXTENSION_INSTALLED_EVENT } from './ExtensionDetailView';
import { DbConfirmModal } from './DbConfirmModal';
import {
  formatDownloadCount,
  formatRating,
  friendlyExtensionName,
  iconInitial,
  publisherOf,
} from '../services/extensionDisplay';

export interface ExtensionPanelProps {
  /**
   * 打开扩展详情（在编辑器区开一个标签，不是弹窗）。
   * 传 RowView 而不是精简的 id/名字：调用方要用到标题做标签名，
   * 重新声明一个更窄的形状只会让两边慢慢对不上。
   *
   * 「已安装」那一行的「管理」按钮也走这条 —— 它以前走的是另一个回调，
   * 那个回调打开的是右侧 AI 区（见 App.tsx 的说明），于是点任何一个已安装扩展的
   * 「管理」都会弹出一个跟这个扩展毫无关系的对话面板。
   */
  onOpenDetail?: (row: RowView) => void;
  onClose?: () => void;
}

/**
 * 一条「已安装扩展」的展示数据。
 *
 * 与主进程 `InstalledExtensionInfo` 对应。`enabled` 与 `active` 是两回事：
 * 启用了的扩展也可能因为激活失败而没跑起来，管理界面要能区分这两种状态。
 */
interface InstalledExtensionRow {
  id: string;
  displayName: string;
  version?: string;
  enabled: boolean;
  active: boolean;
  /** 它注册的命令（带标题） */
  commands: { command: string; title: string }[];
  /** 它注册的视图（id + 展示名） */
  views: { id: string; name: string }[];
}

declare global {
  interface Window {
    extensions: {
      loadFromPath(extensionPath: string): Promise<{ success: boolean; error?: string }>;
      searchMarketplace(
        query: string,
        size?: number,
      ): Promise<{ ok: boolean; error?: string; extensions: MarketplaceEntry[] }>;
      getRecommendedExtensions(
        size?: number,
      ): Promise<{ ok: boolean; error?: string; extensions: MarketplaceEntry[] }>;
      getIconDataUrl(iconUrl: string): Promise<string | null>;
      /** Claude Code 的专用安装通道（它是平台专属构建，走注册表会装错平台）。消费者是详情页 */
      installClaudeCode(): Promise<{ success: boolean; error?: string }>;
      getExtensionDetail(id: string): Promise<{
        ok: boolean;
        error?: string;
        detail?: MarketplaceDetailEntry;
        readme?: string;
      }>;
      installFromMarketplace(extension: {
        id: string;
        downloadUrl: string;
        version?: string;
      }): Promise<{ success: boolean; error?: string; warning?: string }>;
      executeCommand(
        command: string,
        ...args: any[]
      ): Promise<{ success: boolean; result?: any; error?: string }>;
      getLoadedExtensions(): Promise<{ success: boolean; extensions?: string[] }>;
      /** 已安装扩展的登记表（版本 / 启用状态 / 贡献的命令与视图） */
      listInstalled(): Promise<{
        success: boolean;
        extensions?: InstalledExtensionRow[];
        error?: string;
      }>;
      /** 所有扩展贡献的命令（命令面板用） */
      listCommands(): Promise<{
        success: boolean;
        commands?: { command: string; extensionId?: string; title?: string }[];
      }>;
      /** 启用 / 禁用；启用会就地激活 */
      setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
      /** 卸载：停用并删除本地文件 */
      uninstall(id: string): Promise<{ ok: boolean; error?: string }>;
      onCommand(callback: (data: { command: string; args: any[] }) => void): () => void;
      onMessage(callback: (message: any) => void): () => void;
    };
  }
}

/** 输入停止多久之后真正去查注册表。太短会在连打时打出一串请求，太长会显得卡。 */
const SEARCH_DEBOUNCE_MS = 400;

/** 推荐列表要几条。与主进程默认值一致，改一处就够。 */
const RECOMMENDED_COUNT = 8;

/** 一行的全部展示数据。两种来源（已安装 / 市场条目）都先归一到这里再渲染。 */
/** 一条下载中的进度（顶部卡片与行内进度共用）。 */
interface DownloadState {
  name: string;
  percent: number;
  downloaded: number;
  total: number;
}

export interface RowView {
  key: string;
  /** 有 id 才开得了详情页（已安装列表里也有 id，但那是本机扩展，同样能开） */
  extensionId?: string;
  title: string;
  description: string;
  publisher: string;
  /** 标题行右侧的统计（下载量 / 评分 / 状态） */
  stats: React.ReactNode;
  /** 发布者行右侧的操作按钮 */
  actions: React.ReactNode;
  iconUrl?: string;
}

/**
 * 单行渲染。
 *
 * 图标三种情况：拿到了 data URL 用图片；有 iconUrl 但还没抓回来用首字母占位
 * （不留空位，否则列表会随着图标陆续到位而跳动）；没有 iconUrl 直接用首字母。
 */
function ExtensionRow({
  view,
  iconData,
  download,
  onOpenDetail,
}: {
  view: RowView;
  iconData?: string | null;
  /** 这个扩展正在下载时传入进度：那一行下面直接显示进度，而不是只留一个按钮 */
  download?: DownloadState;
  onOpenDetail?: (view: RowView) => void;
}) {
  const { t } = useI18n();
  const initial = iconInitial(view.title);
  // 标题与图标这一块整体是「打开详情」的按钮：行内已经有安装/管理按钮，
  // 给整行挂 onClick 会做出嵌套的可点区域 —— 键盘与读屏都读不清谁是谁。
  const openable = Boolean(onOpenDetail && view.extensionId);
  return (
    <div className="ext-row">
      <button
        type="button"
        className="ext-row-open"
        disabled={!openable}
        onClick={() => openable && onOpenDetail?.({ ...view, extensionId: view.extensionId! })}
        title={openable ? t('extDetail.openTab') : undefined}
      >
        <span className="ext-row-icon">
          {iconData ? (
            <img src={iconData} alt="" draggable={false} />
          ) : (
            <span className="ext-row-icon-letter">{initial}</span>
          )}
        </span>
      </button>
      <div className="ext-row-body">
        <div className="ext-row-top">
          <button
            type="button"
            className="ext-row-name"
            disabled={!openable}
            onClick={() => openable && onOpenDetail?.({ ...view, extensionId: view.extensionId! })}
          >
            {view.title}
          </button>
          <span className="ext-row-stats">{view.stats}</span>
        </div>
        {view.description && (
          <div className="ext-row-desc" title={view.description}>
            {view.description}
          </div>
        )}
        <div className="ext-row-foot">
          <span className="ext-publisher" title={view.publisher}>
            <VerifiedBadge />
            <span className="ext-publisher-name">{view.publisher}</span>
          </span>
          <span className="ext-row-actions">
            {download ? (
              <span className="ext-row-progress" title={`${download.percent.toFixed(1)}%`}>
                <span className="ext-progress-track">
                  <span className="ext-progress-bar" style={{ width: `${download.percent}%` }} />
                </span>
                <span className="ext-row-progress-pct">{download.percent.toFixed(1)}%</span>
              </span>
            ) : (
              view.actions
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * 发布者前面的小徽标。
 *
 * 参考稿里是一个蓝色花结 + 对勾。这里画成同一个语义的简化形状：
 * 它表达的是「这条来自注册表上的发布者」，不是「官方认证」——
 * 本地 VSIX 装进来的扩展没有这个徽标，本来就不该有。
 */
function VerifiedBadge() {
  return (
    <svg
      className="ext-verified"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2.6 14.5 5l3.4-.3.9 3.3 3 1.7-1.4 3.1 1.4 3.1-3 1.7-.9 3.3-3.4-.3L12 22.6 9.5 20.2l-3.4.3-.9-3.3-3-1.7L3.6 12.4 2.2 9.3l3-1.7.9-3.3 3.4.3z" />
      <path d="m10.8 14.8-2.6-2.6 1.1-1.1 1.5 1.5 3.9-3.9 1.1 1.1z" fill="var(--bg-panel)" />
    </svg>
  );
}

/** 分区标题：可折叠，右侧一个计数徽标。 */
function SectionHeader({
  label,
  count,
  collapsed,
  onToggle,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="ext-section-header"
      onClick={onToggle}
      aria-expanded={!collapsed}
    >
      <svg
        className={`ext-section-chevron${collapsed ? ' collapsed' : ''}`}
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
      <span className="ext-section-title">{label}</span>
      <span className="ext-section-count">{count}</span>
    </button>
  );
}

export function ExtensionPanel({ onOpenDetail }: ExtensionPanelProps = {}) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  /** 已安装扩展的 id 列表（只用来判断市场里的条目「装没装」）。 */
  const [extensions, setExtensions] = useState<string[]>([]);
  /** 已安装扩展的完整信息（管理动作要靠它）。 */
  const [installed, setInstalled] = useState<InstalledExtensionRow[]>([]);
  /** 正在执行管理动作（禁用/启用/卸载）的扩展 id，用来禁掉它自己的按钮。 */
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 待确认卸载的扩展；非空时弹确认框。 */
  const [confirmUninstall, setConfirmUninstall] = useState<InstalledExtensionRow | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  /**
   * 正在下载的扩展，按 id 收。
   *
   * 用表而不是单个对象：面板里可以同时装好几个，而一条没有身份的进度
   * 既说不清在装什么，也放不下第二条。
   */
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({});

  // ── 市场：搜索与推荐 ──
  const [marketQuery, setMarketQuery] = useState('');
  const [marketResults, setMarketResults] = useState<MarketplaceEntry[]>([]);
  const [marketState, setMarketState] = useState<'idle' | 'searching' | 'done'>('idle');
  const [marketError, setMarketError] = useState<string | null>(null);
  const [recommended, setRecommended] = useState<MarketplaceEntry[]>([]);
  const [recommendedState, setRecommendedState] = useState<'idle' | 'loading' | 'done'>('idle');
  const [recommendedError, setRecommendedError] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);

  // ── 视图状态 ──
  const [hideInstalled, setHideInstalled] = useState(false);
  const [installedCollapsed, setInstalledCollapsed] = useState(false);
  const [marketCollapsed, setMarketCollapsed] = useState(false);

  /**
   * 图标 data URL 缓存，键是扩展 id。
   *
   * 放在组件里而不是每次都问主进程：列表每次重渲染（比如打字触发搜索）都会重排，
   * 没有这层缓存就是每次重渲染都把整屏图标重新抓一遍。主进程那边还有一层持久缓存，
   * 这层挡的是**同一次会话内的重复往返**。
   */
  const [iconData, setIconData] = useState<Record<string, string | null>>({});
  /** 已经发过请求的 id。用 ref 而不是看 iconData：否则 effect 会被自己的写入重新触发。 */
  const requestedIcons = useRef<Set<string>>(new Set());
  /** 搜索序号。用户连打时多个请求会并发返回，只认最后一次。 */
  const searchSeq = useRef(0);

  const loadExtensions = useCallback(async () => {
    try {
      // 优先用带状态的登记表；它还没接线时（旧 preload）退回旧的 id 列表，
      // 至少不把「已安装」分区整块弄没。
      if (window.extensions?.listInstalled) {
        const result = await window.extensions.listInstalled();
        if (result.success && result.extensions) {
          setInstalled(result.extensions);
          // 市场条目的「已安装」判定用 id 列表：禁用了也仍然是「已安装」。
          setExtensions(result.extensions.map((e) => e.id));
          return;
        }
      }
      if (!window.extensions?.getLoadedExtensions) return;
      const result = await window.extensions.getLoadedExtensions();
      if (result.success && result.extensions) {
        setExtensions(result.extensions);
        setInstalled([]);
      }
    } catch (err: any) {
      console.error('Failed to load extensions:', err);
    }
  }, []);

  /**
   * 启用 / 禁用。启用会就地激活，所以做完立刻重拉一次列表把状态刷新出来。
   */
  const handleToggleEnabled = useCallback(
    async (ext: InstalledExtensionRow) => {
      if (busyId) return;
      setBusyId(ext.id);
      try {
        const res = await window.extensions.setEnabled(ext.id, !ext.enabled);
        if (res?.ok) {
          setSuccessMsg(
            ext.enabled
              ? t('ext.disabledToast', { name: ext.displayName })
              : t('ext.enabledToast', { name: ext.displayName }),
          );
          await loadExtensions();
        } else {
          setError(t('ext.toggleFailed', { msg: res?.error || t('extView.unknownError') }));
        }
      } catch (err: any) {
        setError(t('ext.toggleFailed', { msg: err?.message || String(err) }));
      } finally {
        setBusyId(null);
      }
    },
    [busyId, loadExtensions, t],
  );

  /** 卸载：先弹确认（会删本地文件），确认后调主进程并刷新列表。 */
  const performUninstall = useCallback(async () => {
    const ext = confirmUninstall;
    setConfirmUninstall(null);
    if (!ext) return;
    setBusyId(ext.id);
    try {
      const res = await window.extensions.uninstall(ext.id);
      if (res?.ok) {
        setSuccessMsg(t('ext.uninstalledToast', { name: ext.displayName }));
        await loadExtensions();
      } else {
        setError(t('ext.uninstallFailed', { msg: res?.error || t('extView.unknownError') }));
      }
    } catch (err: any) {
      setError(t('ext.uninstallFailed', { msg: err?.message || String(err) }));
    } finally {
      setBusyId(null);
    }
  }, [confirmUninstall, loadExtensions, t]);

  /** 拉推荐列表。失败只影响这一个分区，不动全局 error。 */
  const loadRecommended = useCallback(async () => {
    if (!window.extensions?.getRecommendedExtensions) return;
    setRecommendedState('loading');
    setRecommendedError(null);
    try {
      const res = await window.extensions.getRecommendedExtensions(RECOMMENDED_COUNT);
      if (!res?.ok) {
        setRecommended([]);
        setRecommendedError(res?.error || t('ext.recommendedFailed'));
        return;
      }
      setRecommended(res.extensions);
    } catch (err: any) {
      setRecommended([]);
      setRecommendedError(err?.message || t('ext.recommendedFailed'));
    } finally {
      setRecommendedState('done');
    }
  }, [t]);

  /**
   * 详情页是另一个组件（在编辑器区），它装完扩展后这边必须跟着刷新 ——
   * 否则刚装好的扩展在面板里还显示「安装」，两边说的不是一回事。
   * 用一个 window 事件解耦，比把状态提到共同祖先再层层传下来轻得多。
   */
  useEffect(() => {
    const onInstalled = () => void loadExtensions();
    window.addEventListener(EXTENSION_INSTALLED_EVENT, onInstalled);
    return () => window.removeEventListener(EXTENSION_INSTALLED_EVENT, onInstalled);
  }, [loadExtensions]);

  useEffect(() => {
    void loadExtensions();
    void loadRecommended();

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
        setDownloads((prev) => {
          const next = { ...prev };
          if (progress.done) {
            // 结束（成功或失败）就摘掉：失败时留着一条不动的进度条，
            // 看起来像还在下载
            delete next[progress.id];
            return next;
          }
          next[progress.id] = {
            name: progress.name || progress.id,
            percent: progress.percent,
            downloaded: progress.downloaded,
            total: progress.total,
          };
          return next;
        });
      }) || (() => {});

    return () => {
      cleanup1();
      cleanup2();
      cleanup3();
    };
  }, [loadExtensions, loadRecommended]);

  /**
   * 图标抓取。
   *
   * 依赖只写两个列表：`iconData` 故意不进依赖 —— 这个 effect 会写它，
   * 放进去就成自触发循环。去重靠 requestedIcons 这个 ref。
   */
  const visibleEntries = useMemo(
    () => [...recommended, ...marketResults],
    [recommended, marketResults],
  );
  useEffect(() => {
    const pending = visibleEntries.filter(
      (entry) => entry.iconUrl && !requestedIcons.current.has(entry.id),
    );
    if (pending.length === 0) return;
    for (const entry of pending) requestedIcons.current.add(entry.id);
    let cancelled = false;
    void Promise.all(
      pending.map(async (entry) => {
        let data: string | null = null;
        try {
          data = await window.extensions.getIconDataUrl(entry.iconUrl!);
        } catch {
          // 图标抓不到不是错误，回退首字母即可
          data = null;
        }
        return [entry.id, data] as const;
      }),
    ).then((pairs) => {
      if (cancelled) return;
      setIconData((prev) => {
        const next = { ...prev };
        for (const [id, data] of pairs) next[id] = data;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [visibleEntries]);

  /**
   * 在市场里搜索。
   *
   * 网络失败只把错误显示在市场分区，不设全局 error ——
   * 「注册表连不上」不该让已经装好的扩展、本地 VSIX 安装这些入口看起来也坏了。
   */
  const runMarketSearch = useCallback(
    async (query: string) => {
      const seq = ++searchSeq.current;
      setMarketState('searching');
      setMarketError(null);
      try {
        const res = await window.extensions.searchMarketplace(query, 20);
        // 用户已经改了关键词，这一份结果作废 —— 不加这个会把旧结果盖在新结果上
        if (seq !== searchSeq.current) return;
        if (!res?.ok) {
          setMarketResults([]);
          setMarketError(res?.error || t('ext.marketFailed'));
          return;
        }
        setMarketResults(res.extensions);
      } catch (err: any) {
        if (seq !== searchSeq.current) return;
        setMarketResults([]);
        setMarketError(err?.message || t('ext.marketFailed'));
      } finally {
        if (seq === searchSeq.current) setMarketState('done');
      }
    },
    [t],
  );

  // 输入即搜（防抖）。参考稿的搜索框旁边没有搜索按钮，回车只是「别等了」的快捷键。
  useEffect(() => {
    const query = marketQuery.trim();
    if (!query) {
      searchSeq.current++;
      setMarketResults([]);
      setMarketState('idle');
      setMarketError(null);
      return;
    }
    const timer = setTimeout(() => void runMarketSearch(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [marketQuery, runMarketSearch]);

  const handleMarketInstall = async (extension: MarketplaceEntry) => {
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
        // 装好了但没激活起来：把原因一并说出来，而不是只报「已安装」
        setSuccessMsg(
          result.warning
            ? `${t('ext.marketInstalled', { name: extension.displayName })} —— ${result.warning}`
            : t('ext.marketInstalled', { name: extension.displayName }),
        );
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
        setSuccessMsg(t('ext.localLoadOk', { name: filePath.split(/[/\\]/).pop() ?? '' }));
      } else {
        setError(result.error || t('ext.localLoadFailed'));
      }
    } catch (err: any) {
      setError(err.message || t('ext.localLoadError'));
    } finally {
      setLoading(false);
    }
  };

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

  const showingResults = marketQuery.trim().length > 0;

  /**
   * 「已安装」分区的行。
   *
   * 每条给出四个入口：打开（这个扩展贡献的界面，没有视图就没有这个按钮）、
   * 管理（详情页）、禁用/启用、卸载。禁用与卸载以前根本不存在 ——
   * 装错一个扩展就只能去手删 userData 目录。
   */
  const installedRows: RowView[] = useMemo(
    () =>
      installed.map((ext) => {
        // 先有 row 再有按钮：按钮点开的就是这一行自己的详情页，
        // 和「点名字/图标」走的是同一个入口（详情页里有安装状态、README、元信息）。
        const row: RowView = {
          key: ext.id,
          extensionId: ext.id,
          title: ext.displayName || friendlyExtensionName(ext.id),
          description: ext.version ? `v${ext.version}` : '',
          publisher: publisherOf(ext.id),
          stats: (
            <span className={`ext-row-status${ext.enabled ? '' : ' is-disabled'}`}>
              <span className="ext-status-dot" />
              {ext.enabled ? t('ext.enabled') : t('ext.disabled')}
            </span>
          ),
          actions: null,
        };
        const busy = busyId === ext.id;
        row.actions = (
          <>
            {ext.views.length > 0 && (
              <button
                type="button"
                className="ext-btn ext-btn-primary"
                disabled={busy}
                title={t('ext.openViewTitle')}
                onClick={() =>
                  // 打开的是扩展自己注册的视图（在编辑器区开一个标签），
                  // 不是这个扩展的说明页 —— 「能真正用上它」靠的就是这一步。
                  window.dispatchEvent(
                    new CustomEvent('echoly:open-extension-view', {
                      detail: {
                        viewId: ext.views[0].id,
                        // 用视图自己的名字当标签：不然它和「扩展详情」那个标签一模一样，
                        // 顶栏会出现两个同名的标签，分不清哪个是哪个
                        title: ext.views[0].name || ext.displayName || ext.id,
                      },
                    }),
                  )
                }
              >
                {t('ext.openView')}
              </button>
            )}
            <button
              type="button"
              className="ext-btn"
              disabled={busy}
              onClick={() => onOpenDetail?.(row)}
              title={t('extDetail.openTab')}
            >
              {t('ext.manage')}
            </button>
            <button
              type="button"
              className="ext-btn"
              disabled={busy}
              onClick={() => void handleToggleEnabled(ext)}
            >
              {ext.enabled ? t('ext.disable') : t('ext.enable')}
            </button>
            <button
              type="button"
              className="ext-btn"
              disabled={busy}
              onClick={() => setConfirmUninstall(ext)}
            >
              {t('ext.uninstall')}
            </button>
          </>
        );
        return row;
      }),
    // 「隐藏已安装」只作用于市场那一侧：在「已安装」分区里再按它过滤，
    // 结果就是打开过滤器把这个分区清空 —— 那不是过滤，是自相矛盾。
    [installed, onOpenDetail, t, busyId, handleToggleEnabled],
  );

  /** 市场条目的行（推荐与搜索结果共用）。 */
  const marketRow = useCallback(
    (entry: MarketplaceEntry): RowView => {
      const installed = isExtensionLoaded(entry.id);
      const downloads = formatDownloadCount(entry.downloads);
      const rating = formatRating(entry.rating);
      const row: RowView = {
        key: entry.id,
        extensionId: entry.id,
        title: entry.displayName || friendlyExtensionName(entry.id),
        description: entry.description,
        publisher: publisherOf(entry.id),
        iconUrl: entry.iconUrl,
        stats: (
          <>
            {downloads && (
              <span className="ext-row-stat" title={t('ext.downloadsLabel')}>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M12 3v11" />
                  <polyline points="7.5 9.5 12 14 16.5 9.5" />
                  <path d="M4.5 20h15" />
                </svg>
                {downloads}
              </span>
            )}
            {rating && (
              <span className="ext-row-stat ext-row-rating" title={t('ext.ratingLabel')}>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="m12 3.6 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9 6.8 19.7l1-5.8L3.5 9.8l5.9-.8z" />
                </svg>
                {rating}
              </span>
            )}
          </>
        ),
        actions: installed ? (
          <button
            type="button"
            className="ext-btn"
            onClick={() => onOpenDetail?.(row)}
            title={t('extDetail.openTab')}
          >
            {t('ext.manage')}
          </button>
        ) : (
          <button
            type="button"
            className="ext-btn ext-btn-primary"
            disabled={installingId !== null}
            onClick={() => void handleMarketInstall(entry)}
          >
            {installingId === entry.id ? t('ext.installing') : t('ext.marketInstall')}
          </button>
        ),
      };
      return row;
    },
    // 刻意不把 handleMarketInstall 放进依赖：它每次渲染都是新函数，放进去 useCallback 就白做了。
    // 它读到的 installingId / t / loadExtensions 都在下面这几个依赖里，不会有陈旧闭包。
    [installingId, extensions, onOpenDetail, t],
  );

  const recommendedRows = useMemo(
    () => recommended.filter((e) => !hideInstalled || !isExtensionLoaded(e.id)).map(marketRow),
    // isExtensionLoaded 读的是 extensions，和 marketRow 一样都已在依赖里
    [recommended, hideInstalled, extensions, marketRow],
  );

  const resultRows = useMemo(
    () => marketResults.filter((e) => !hideInstalled || !isExtensionLoaded(e.id)).map(marketRow),
    [marketResults, hideInstalled, extensions, marketRow],
  );

  const rows = showingResults ? resultRows : recommendedRows;

  /**
   * 当前**没有对应行**的下载。
   *
   * 进度优先显示在它自己那一行下面；但安装也可能从详情页发起（那一行此刻不一定在
   * 视野里），这种就退到顶部卡片里列一行。
   * 只列一份，不做两处都显示 —— 同一个进度出现两次只会让人怀疑是不是装了两个。
   */
  const orphanDownloads = useMemo(() => {
    const visible = new Set<string>();
    for (const view of [...installedRows, ...rows]) {
      if (view.extensionId) visible.add(view.extensionId.toLowerCase());
    }
    return Object.entries(downloads)
      .filter(([id]) => !visible.has(id.toLowerCase()))
      .map(([id, state]) => ({ id, ...state }));
  }, [downloads, installedRows, rows]);
  const marketLabel = showingResults ? t('ext.sectionResults') : t('ext.sectionRecommended');

  return (
    <div className="ext-panel-container">
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

      {/* 搜索框：右侧两个图标分别是「清空」与「隐藏已安装」，都有实际行为。
          它和进度条留在滚动区之外 —— 面板现在常驻左侧栏，列表滚到底部时
          搜索框跟着滚走会很难用。 */}
      <div className="ext-search">
        <input
          type="text"
          className="ext-search-input"
          value={marketQuery}
          placeholder={t('ext.searchPlaceholder')}
          onChange={(e) => setMarketQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && marketQuery.trim()) void runMarketSearch(marketQuery.trim());
            if (e.key === 'Escape' && marketQuery) setMarketQuery('');
          }}
        />
        {marketQuery && (
          <button
            type="button"
            className="ext-search-icon"
            onClick={() => setMarketQuery('')}
            title={t('ext.clearSearch')}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className={`ext-search-icon${hideInstalled ? ' active' : ''}`}
          onClick={() => setHideInstalled((v) => !v)}
          title={hideInstalled ? t('ext.showInstalled') : t('ext.hideInstalled')}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 5h18l-7 8v6l-4 2v-8z" />
          </svg>
        </button>
      </div>

      {orphanDownloads.length > 0 && (
        <div className="ext-progress-card">
          <div className="ext-progress-header">
            <span style={{ fontWeight: 600 }}>{t('ext.downloading')}</span>
          </div>
          {/* 这些扩展当前没有可见的行（例如在详情页点的安装），所以在这里各占一行、带上名字 */}
          {orphanDownloads.map((d) => (
            <div key={d.id} className="ext-progress-item">
              <div className="ext-progress-item-head">
                <span className="ext-progress-name" title={d.name}>
                  {d.name}
                </span>
                <span className="ext-progress-stat">
                  {d.percent.toFixed(1)}% ({(d.downloaded / 1024 / 1024).toFixed(1)}MB /
                  {(d.total / 1024 / 1024).toFixed(1)}MB)
                </span>
              </div>
              <div className="ext-progress-track">
                <div className="ext-progress-bar" style={{ width: `${d.percent}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="ext-panel-scroll">
        <div className="ext-section">
          <SectionHeader
            label={t('ext.installedSection')}
            count={installedRows.length}
            collapsed={installedCollapsed}
            onToggle={() => setInstalledCollapsed((v) => !v)}
          />
          {!installedCollapsed &&
            (installedRows.length === 0 ? (
              <div className="ext-empty-placeholder">
                <span style={{ fontSize: 26, opacity: 0.5 }}>🧩</span>
                <span>{t('ext.empty')}</span>
              </div>
            ) : (
              <div className="ext-rows">
                {installedRows.map((view) => (
                  <ExtensionRow
                    key={view.key}
                    view={view}
                    download={view.extensionId ? downloads[view.extensionId] : undefined}
                    onOpenDetail={onOpenDetail}
                  />
                ))}
              </div>
            ))}
        </div>

        <div className="ext-section">
          <SectionHeader
            label={marketLabel}
            count={rows.length}
            collapsed={marketCollapsed}
            onToggle={() => setMarketCollapsed((v) => !v)}
          />
          {!marketCollapsed && (
            <>
              {showingResults && marketState === 'searching' && (
                <div className="ext-section-note">{t('ext.marketSearching')}</div>
              )}
              {showingResults && marketError && (
                <div className="ext-section-note ext-note-error">
                  {marketError}
                  <button
                    type="button"
                    className="ext-btn"
                    onClick={() => void runMarketSearch(marketQuery.trim())}
                  >
                    {t('ext.retry')}
                  </button>
                </div>
              )}
              {!showingResults && recommendedError && (
                <div className="ext-section-note ext-note-error">
                  {recommendedError}
                  <button type="button" className="ext-btn" onClick={() => void loadRecommended()}>
                    {t('ext.retry')}
                  </button>
                </div>
              )}
              {!showingResults && !recommendedError && recommendedState === 'loading' && (
                <div className="ext-section-note">{t('ext.loadingRecommended')}</div>
              )}
              {!showingResults &&
                !recommendedError &&
                recommendedState === 'done' &&
                rows.length === 0 && <div className="ext-section-note">{t('ext.marketEmpty')}</div>}
              {showingResults && marketState === 'done' && !marketError && rows.length === 0 && (
                <div className="ext-section-note">{t('ext.marketEmpty')}</div>
              )}
              {rows.length > 0 && (
                <div className="ext-rows">
                  {rows.map((view) => (
                    <ExtensionRow
                      key={view.key}
                      view={view}
                      iconData={iconData[view.key]}
                      download={view.extensionId ? downloads[view.extensionId] : undefined}
                      onOpenDetail={onOpenDetail}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* 离线/内网场景的兜底入口。参考稿没有这一条，但它是本地 VSIX 唯一的入口 */}
        <div className="ext-footer">
          <button
            type="button"
            className="ext-footer-btn"
            onClick={handleLoadFromPath}
            disabled={loading}
            title={t('ext.localDesc')}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 8v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8" />
              <path d="M2 4h20v4H2z" />
              <line x1="10" y1="12" x2="14" y2="12" />
            </svg>
            <span>{t('ext.localTitle')}</span>
          </button>
        </div>

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

      {/*
        卸载确认。复用数据库那套确认弹窗（它本来就是通用确认框，只是名字带 db）：
        卸载会删本地文件，必须让用户看清删的是哪一个，而不是一个 window.confirm。
      */}
      <DbConfirmModal
        isOpen={confirmUninstall !== null}
        title={t('ext.uninstallTitle')}
        content={t('ext.uninstallConfirm', {
          name: confirmUninstall?.displayName || confirmUninstall?.id || '',
        })}
        details={
          confirmUninstall
            ? [
                { label: t('extDetail.identifier'), value: confirmUninstall.id },
                ...(confirmUninstall.version
                  ? [{ label: t('extDetail.version'), value: confirmUninstall.version }]
                  : []),
              ]
            : undefined
        }
        tone="danger"
        confirmLabel={t('ext.uninstall')}
        onConfirm={() => void performUninstall()}
        onCancel={() => setConfirmUninstall(null)}
      />
    </div>
  );
}
