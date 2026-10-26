import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  AppSettings,
  PermissionMode,
  SkillInfo,
  AiProvider,
  ModelProfile,
  ModelProviderType,
  ReasoningEffort,
  UpdateFeedConfig,
  McpServerConfig,
  McpServerStatus,
} from '@deepseek-ide/shared';
import {
  AI_PROVIDER_LABELS,
  DEFAULT_PROVIDERS,
  DEFAULT_MODELS,
  REASONING_EFFORT_LABELS,
  APP_VERSION,
} from '@deepseek-ide/shared';
import { translateSegments, useI18n } from '../i18n';
import { EnvironmentSettingsSection } from './EnvironmentSettingsSection';
import { useModalResize, ModalResizeHandle } from '../hooks/useModalResize';
import echolyAppIcon from '../assets/echoly-icon.png';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: (settings: AppSettings) => void;
  /** 应用内非阻塞提示（用于替代原生 alert） */
  onShowToast?: (
    title: string,
    detail?: string,
    type?: 'success' | 'error' | 'info' | 'warn',
  ) => void;
  initialTab?: 'models' | 'runtime' | 'environment' | 'general' | 'skills' | 'mcp' | 'update' | 'about';
  workspace?: string | null;
}

const PERMISSION_ORDER: PermissionMode[] = ['allow_all_extreme', 'allow_all', 'ask', 'deny_all'];

/**
 * 权限档位文案。存 key 而不是文案：这张表是模块级常量，
 * 直接存文案的话语言切换后不会重建，只能用最初始的语言。
 * （`packages/shared` 里的 `PERMISSION_MODE_LABELS` 只有中文，不能直接用。）
 */
const PERMISSION_LABEL_KEYS: Record<PermissionMode, string> = {
  allow_all_extreme: 'settings.permLabel.allow_all_extreme',
  allow_all: 'settings.permLabel.allow_all',
  ask: 'settings.permLabel.ask',
  deny_all: 'settings.permLabel.deny_all',
};

const PERMISSION_HINT_KEYS: Record<PermissionMode, string> = {
  allow_all_extreme: 'settings.permHint.allow_all_extreme',
  allow_all: 'settings.permHint.allow_all',
  ask: 'settings.permHint.ask',
  deny_all: 'settings.permHint.deny_all',
};

/** 协议类型与思考档位同理：共享包里是中文常量，这里只存 key。 */
const PROVIDER_LABEL_KEYS: Record<ModelProviderType, string> = {
  deepseek: 'settings.providerLabel.deepseek',
  openai: 'settings.providerLabel.openai',
  anthropic: 'settings.providerLabel.anthropic',
  custom: 'settings.providerLabel.custom',
};

const EFFORT_LABEL_KEYS: Record<ReasoningEffort, string> = {
  none: 'settings.effortLabel.none',
  low: 'settings.effortLabel.low',
  high: 'settings.effortLabel.high',
  xhigh: 'settings.effortLabel.xhigh',
  max: 'settings.effortLabel.max',
};

export function SettingsModal({
  open,
  onClose,
  onSaved,
  onShowToast,
  initialTab,
  workspace,
}: Props) {
  const { locale, t, setLocale } = useI18n();
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_settings_modal_size',
    defaultWidth: 920,
    defaultHeight: 680,
    minWidth: 640,
    minHeight: 440,
  });
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [probe, setProbe] = useState<string>('');
  const [probing, setProbing] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsDir, setSkillsDir] = useState<string>('');
  // MCP 服务器：状态由主进程持有（子进程在那里），这里只做展示与配置编辑
  const [mcpStatuses, setMcpStatuses] = useState<McpServerStatus[]>([]);
  const [mcpReloading, setMcpReloading] = useState(false);
  /** 正在编辑的服务器草稿。null 表示没有展开任何一条。 */
  const [editingMcpId, setEditingMcpId] = useState<string | null>(null);
  /** 待确认删除的 MCP 服务器 id。 */
  const [pendingMcpDelete, setPendingMcpDelete] = useState<string | null>(null);
  // Multi-model management state
  const [editingModel, setEditingModel] = useState<ModelProfile | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [modelProbingId, setModelProbingId] = useState<string | null>(null);
  const [modelProbeResults, setModelProbeResults] = useState<
    Record<string, { ok: boolean; detail: string }>
  >({});
  // 待确认删除的模型
  const [deletingModel, setDeletingModel] = useState<ModelProfile | null>(null);
  // 更新下载进度状态：下载中显示进度条，完成/失败后隐藏。
  // 注意：必须放在条件早退(if(!open||!settings) return null)之前，否则违反 Hook 规则。
  const [updating, setUpdating] = useState<{ phase: 'download' | 'done'; percent: number } | null>(
    null,
  );
  // 更新检查结果提示（显示在「软件更新」页内，替代右下角 toast）
  const [updateMsg, setUpdateMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );
  // 待确认的更新信息（有新版本时触发确认弹窗）
  const [pendingUpdate, setPendingUpdate] = useState<{
    version: string;
    notes: string;
    current: string;
  } | null>(null);
  // 确认更新：开始下载 → 打开安装包 → 退出应用
  const [downloading, setDownloading] = useState(false);
  // 检查更新请求进行中：禁用按钮并显示「正在检查更新…」
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    const unsub = window.ide.onUpdateProgress((p) => {
      setUpdating(p.phase === 'done' ? null : { phase: 'download', percent: p.percent });
    });
    return () => unsub();
  }, []);

  const MODEL_PRESETS: Array<{
    /** 预设名与模型显示别名的字典 key —— 表是模块内的，存 key 才能在切语言后跟着变。 */
    labelKey: string;
    nameKey: string;
    provider: ModelProviderType;
    baseUrl: string;
    model: string;
    enableThinking?: boolean;
    thinkingTokens?: number;
    reasoningEffort?: ReasoningEffort;
    reasoningEffortFine?: number;
    thinkingTokenBudget?: number;
  }> = [
    {
      labelKey: 'settings.preset.deepseekVllm',
      nameKey: 'settings.preset.deepseekVllmName',
      provider: 'deepseek',
      baseUrl: 'http://192.168.10.241:8002',
      model: 'deepseek-v4.1-flash',
      reasoningEffort: 'low',
    },
    {
      labelKey: 'settings.preset.deepseekGateway',
      nameKey: 'settings.preset.deepseekGatewayName',
      provider: 'deepseek',
      baseUrl: 'http://192.168.10.241:1333',
      model: 'deepseek-v4.1-flash',
      reasoningEffort: 'low',
    },
    {
      labelKey: 'settings.preset.deepseekOfficial',
      nameKey: 'settings.preset.deepseekOfficialName',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    },
    {
      labelKey: 'settings.preset.deepseekReasoner',
      nameKey: 'settings.preset.deepseekReasonerName',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-reasoner',
    },
    {
      labelKey: 'settings.preset.openaiGpt4o',
      nameKey: 'settings.preset.openaiGpt4oName',
      provider: 'openai',
      baseUrl: 'https://api.openai.com',
      model: 'gpt-4o',
    },
    {
      labelKey: 'settings.preset.openaiGpt4oMini',
      nameKey: 'settings.preset.openaiGpt4oMiniName',
      provider: 'openai',
      baseUrl: 'https://api.openai.com',
      model: 'gpt-4o-mini',
    },
    {
      labelKey: 'settings.preset.claude37Sonnet',
      nameKey: 'settings.preset.claude37SonnetName',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-3-7-sonnet-20250219',
      enableThinking: true,
      thinkingTokens: 8000,
    },
    {
      labelKey: 'settings.preset.claude35Haiku',
      nameKey: 'settings.preset.claude35HaikuName',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-3-5-haiku-20241022',
    },
    {
      labelKey: 'settings.preset.agentRouter',
      nameKey: 'settings.preset.agentRouterName',
      provider: 'anthropic',
      baseUrl: 'https://agentrouter.org',
      model: 'glm-5.3',
      enableThinking: true,
      thinkingTokens: 8000,
    },
    {
      labelKey: 'settings.preset.customOllama',
      nameKey: 'settings.preset.customOllamaName',
      provider: 'custom',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3',
    },
  ];

  // Tab state — 持久化到 localStorage，下次打开时恢复上次停留位置
  const SETTINGS_TAB_KEY = 'echoly_settings_last_tab';
  type SettingsTab =
    'models' | 'runtime' | 'environment' | 'general' | 'skills' | 'mcp' | 'update' | 'about';
  const ALL_TABS: SettingsTab[] = [
    'models',
    'runtime',
    'environment',
    'general',
    'skills',
    'mcp',
    'update',
    'about',
  ];

  function readPersistedTab(): SettingsTab {
    try {
      const stored = localStorage.getItem(SETTINGS_TAB_KEY) as SettingsTab | null;
      if (stored && ALL_TABS.includes(stored)) return stored;
    } catch {
      // localStorage unavailable
    }
    return 'models';
  }

  const [activeTab, setActiveTabRaw] = useState<SettingsTab>(
    // 外部强制指定时优先用 initialTab，否则恢复上次位置
    initialTab || readPersistedTab(),
  );
  const [showApiKey, setShowApiKey] = useState(false);

  /** 切换 tab 并同时持久化 */
  function setActiveTab(tab: SettingsTab): void {
    setActiveTabRaw(tab);
    try {
      localStorage.setItem(SETTINGS_TAB_KEY, tab);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    // 仅当外部明确传入 initialTab 时才强制跳转（如从关于页点击「检查更新」）
    if (open && initialTab) {
      setActiveTab(initialTab);
    }
  }, [open, initialTab]);

  async function probeSingleModel(model: ModelProfile): Promise<void> {
    setModelProbingId(model.id);
    try {
      const res = await window.ide.probeLlm({
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        model: model.model,
        provider: model.provider,
      });
      setModelProbeResults((prev) => ({
        ...prev,
        [model.id]: { ok: res.ok, detail: res.detail },
      }));
      setEditingModel((prev) =>
        prev && prev.id === model.id ? { ...prev, lastProbeOk: res.ok } : prev,
      );
      if (settings?.models?.some((x) => x.id === model.id)) {
        const updatedModels = settings.models.map((x) =>
          x.id === model.id ? { ...x, lastProbeOk: res.ok } : x,
        );
        void persistSettings({ ...settings, models: updatedModels });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setModelProbeResults((prev) => ({
        ...prev,
        [model.id]: { ok: false, detail: errMsg },
      }));
      setEditingModel((prev) =>
        prev && prev.id === model.id ? { ...prev, lastProbeOk: false } : prev,
      );
      if (settings?.models?.some((x) => x.id === model.id)) {
        const updatedModels = settings.models.map((x) =>
          x.id === model.id ? { ...x, lastProbeOk: false } : x,
        );
        void persistSettings({ ...settings, models: updatedModels });
      }
    } finally {
      setModelProbingId(null);
    }
  }

  async function persistSettings(newSettings: AppSettings) {
    setSettings(newSettings);
    try {
      const saved = await window.ide.saveSettings(newSettings);
      setSettings(saved);
      onSaved?.(saved);
    } catch (err) {
      console.error('Failed to save settings:', err);
    }
  }

  function handleSaveEditingModel(m: ModelProfile) {
    if (!settings) return;
    const probeRes = modelProbeResults[m.id];
    const toSave: ModelProfile = {
      ...m,
      lastProbeOk: probeRes ? probeRes.ok : m.lastProbeOk,
    };
    const exists = settings.models?.some((x) => x.id === toSave.id);
    let nextModels = settings.models || [];

    if (toSave.isDefault) {
      // 设为默认模型时，自动排在首位
      const others = nextModels
        .filter((x) => x.id !== toSave.id)
        .map((x) => ({ ...x, isDefault: false }));
      nextModels = [{ ...toSave, isDefault: true }, ...others];
    } else {
      if (exists) {
        nextModels = nextModels.map((x) => (x.id === toSave.id ? toSave : x));
      } else {
        // 新增非默认模型时，插入在默认模型之后（排在第 2 位），确保新模型直接可见且整体顺序整洁
        const defaultIdx = nextModels.findIndex(
          (x) => x.isDefault || x.id === settings.activeModelId,
        );
        if (defaultIdx >= 0) {
          nextModels = [
            ...nextModels.slice(0, defaultIdx + 1),
            toSave,
            ...nextModels.slice(defaultIdx + 1),
          ];
        } else {
          nextModels = [toSave, ...nextModels];
        }
      }
    }

    const activeId = toSave.isDefault ? toSave.id : settings.activeModelId || nextModels[0]?.id;
    const nextSettings: AppSettings = {
      ...settings,
      models: nextModels,
      activeModelId: activeId,
      currentProvider: toSave.provider,
    };
    void persistSettings(nextSettings);
    setEditingModel(null);
    setIsCreatingNew(false);
  }

  function handleDeleteModel(id: string) {
    if (!settings || (settings.models?.length || 0) <= 1) return;
    const nextModels = settings.models.filter((m) => m.id !== id);
    let nextActive = settings.activeModelId;
    if (nextActive === id) {
      nextActive = nextModels[0]?.id || '';
      nextModels[0] = { ...nextModels[0], isDefault: true };
    }
    const nextSettings: AppSettings = {
      ...settings,
      models: nextModels,
      activeModelId: nextActive,
    };
    void persistSettings(nextSettings);
  }

  function handleSetDefaultModel(id: string) {
    if (!settings) return;
    const target = settings.models?.find((m) => m.id === id);
    if (!target) return;
    const others = (settings.models || [])
      .filter((m) => m.id !== id)
      .map((m) => ({ ...m, isDefault: false }));
    // 设为默认模型时自动排在第 1 位
    const nextModels = [{ ...target, isDefault: true }, ...others];
    const nextSettings: AppSettings = {
      ...settings,
      models: nextModels,
      activeModelId: id,
      currentProvider: target.provider || settings.currentProvider,
    };
    void persistSettings(nextSettings);
  }

  function handleMoveModel(id: string, direction: 'up' | 'down') {
    if (!settings?.models) return;
    const list = [...settings.models];
    const idx = list.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= list.length) return;
    const [item] = list.splice(idx, 1);
    list.splice(targetIdx, 0, item);
    const nextSettings: AppSettings = {
      ...settings,
      models: list,
    };
    void persistSettings(nextSettings);
  }

  useEffect(() => {
    if (!open) return;
    void window.ide.getSettings().then(setSettings);
    void window.ide.listSkills().then(setSkills);
    setProbe('');
  }, [open]);

  // 按 Esc 关闭设置弹窗或删除确认弹窗
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (deletingModel) {
          setDeletingModel(null);
          return;
        }
        if (pendingMcpDelete) {
          setPendingMcpDelete(null);
          return;
        }
        if (pendingUpdate && !downloading) {
          setPendingUpdate(null);
          return;
        }
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose, deletingModel, pendingMcpDelete, pendingUpdate, downloading]);

  if (!open || !settings) return null;

  async function save(): Promise<void> {
    const next = await window.ide.saveSettings(settings!);
    onSaved?.(next);
    onClose();
  }

  async function runProbe(): Promise<void> {
    setProbing(true);
    setProbe('');
    try {
      await window.ide.saveSettings(settings!);
      const result = await window.ide.probeLlm();
      setProbe(result.ok ? `OK: ${result.detail}` : `FAIL: ${result.detail}`);
    } finally {
      setProbing(false);
    }
  }

  async function openSkills(): Promise<void> {
    const dir = await window.ide.openUserSkillsDir();
    setSkillsDir(dir);
    setSkills(await window.ide.listSkills());
  }

  // ---- MCP 服务器 ----

  /**
   * 拉取各服务器状态。
   *
   * 状态由主进程持有（子进程在那里），渲染层只做展示。因此每次进入 MCP 页都重新拉一遍 ——
   * 组件里缓存的状态会过期，而「显示绿灯但实际已经掉线」是这里最坏的失败方式：
   * 用户会以为工具能用，直到它真的被调用。
   */
  async function refreshMcpStatus(): Promise<void> {
    try {
      setMcpStatuses(await window.ide.mcpStatus());
    } catch {
      setMcpStatuses([]);
    }
  }

  /** 保存配置并让主进程按新配置重连。 */
  async function saveMcpServers(
    servers: McpServerConfig[],
    nextTab?: SettingsTab,
  ): Promise<void> {
    if (!settings) return;
    await persistSettings({ ...settings, mcpServers: servers });
    setMcpReloading(true);
    try {
      // 重连可能很慢（npx 冷启动），但不该阻塞界面 —— 先把「正在连接」显示出来，
      // 否则用户点保存后没有任何反馈，会以为没生效而反复点击。
      setMcpStatuses(await window.ide.mcpReload());
    } catch (err) {
      setMcpStatuses([]);
      console.error('MCP reload failed', err);
    } finally {
      setMcpReloading(false);
      if (nextTab) setActiveTab(nextTab);
    }
  }

  function handleAddMcpServer(): void {
    if (!settings) return;
    const servers = settings.mcpServers ?? [];
    // id 必须唯一且稳定 —— 它是工具名前缀，改动 id 等价于换一个服务器
    let n = servers.length + 1;
    const existing = new Set(servers.map((s) => s.id));
    while (existing.has(`server-${n}`)) n++;
    const draft: McpServerConfig = {
      id: `server-${n}`,
      name: t('settings.mcp.newServerName', { n }),
      enabled: false,
      command: '',
      args: [],
      access: 'write',
    };
    setSettings({ ...settings, mcpServers: [...servers, draft] });
    setEditingMcpId(draft.id);
  }

  /**
   * 就地改配置，**不落盘**。
   *
   * 保存推迟到用户点「保存并连接」：每敲一个字符就写设置并重连一次，
   * 会让用户在半成品的命令上反复 spawn 子进程（且必然失败），既慢又刷屏错误。
   */
  function patchMcpServer(id: string, patch: Partial<McpServerConfig>): void {
    if (!settings) return;
    const servers = (settings.mcpServers ?? []).map((s) =>
      s.id === id ? { ...s, ...patch } : s,
    );
    setSettings({ ...settings, mcpServers: servers });
  }

  async function handleDeleteMcpServer(id: string): Promise<void> {
    if (!settings) return;
    const servers = (settings.mcpServers ?? []).filter((s) => s.id !== id);
    setPendingMcpDelete(null);
    setEditingMcpId(null);
    await saveMcpServers(servers);
  }

  /** 把主进程报回的状态与本地配置按 id 对齐，取 id 的并集。 */
  const mcpRows = (settings?.mcpServers ?? []).map((cfg) => ({
    cfg,
    status: mcpStatuses.find((s) => s.id === cfg.id),
  }));

  // 进入 MCP 页时刷新一次状态
  useEffect(() => {
    if (open && activeTab === 'mcp') void refreshMcpStatus();
  }, [open, activeTab]);

  async function checkUpdateNow(): Promise<void> {
    if (!settings || checking) return;
    setUpdateMsg(null);
    setChecking(true);
    try {
      // 先保存当前更新配置，再触发检查，确保 token / owner / repo 已生效
      const next = await window.ide.saveSettings(settings);
      setSettings(next);
      const res = await window.ide.checkUpdate();
      if (!res.ok) {
        setUpdateMsg({
          type: 'error',
          text: `${t('settings.update.checkFail')}${res.detail || ''}`,
        });
        return;
      }
      if (!res.hasUpdate) {
        setUpdateMsg({ type: 'success', text: res.detail || t('settings.update.checkOk') });
        return;
      }
      // 有新版本：弹窗确认，展示版本号与更新说明
      setPendingUpdate({
        version: res.version || '',
        notes: res.releaseNotes || '',
        current: res.current || '',
      });
    } finally {
      setChecking(false);
    }
  }

  // 待确认的更新信息（有新版本时触发确认弹窗）
  async function confirmUpdate(): Promise<void> {
    if (!pendingUpdate) return;
    setDownloading(true);
    setPendingUpdate(null);
    const res = await window.ide.downloadUpdate();
    if (!res.ok) {
      setUpdateMsg({ type: 'error', text: res.detail || t('settings.update.downloadFailed') });
      setDownloading(false);
    }
    // 成功时主进程会退出应用，无需处理
  }

  /** 返回一个非空的 updateFeed，避免 spread undefined 导致类型不完整。 */
  function feedWith(patch: Partial<UpdateFeedConfig>): UpdateFeedConfig {
    const base: UpdateFeedConfig = settings?.updateFeed ?? { provider: 'github' };
    return { ...base, ...patch };
  }

  async function handleCopySystemInfo(): Promise<void> {
    const info = [
      `App: Echoly`,
      `Version: v${APP_VERSION} (Release)`,
      `Developer: Daniel (@DanielCraig07)`,
      `Platform: ${navigator.userAgent.includes('Macintosh') ? 'macOS (Darwin)' : 'Linux/Windows'}`,
      `User Agent: ${navigator.userAgent}`,
      `Date: ${new Date().toISOString()}`,
    ].join('\n');

    try {
      await navigator.clipboard.writeText(info);
      onShowToast?.(
        t('settings.about.copied'),
        t('settings.about.copiedDetail', { version: APP_VERSION }),
        'success',
      );
    } catch {
      onShowToast?.(
        t('settings.about.copyFailedTitle'),
        t('settings.about.copyFailedDetail'),
        'error',
      );
    }
  }

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="settings-overlay">
      <div
        className="settings-modal modern-settings"
        style={{
          width: modalSize.width,
          height: modalSize.height,
          maxWidth: '96vw',
          maxHeight: '94vh',
          position: 'relative',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部标题栏 */}
        <div className="settings-header">
          <div className="settings-header-left">
            <div className="settings-logo-pill">Echoly</div>
            <h2>{t('settings.title')}</h2>
          </div>
          <button
            type="button"
            className="panel-action-btn"
            onClick={onClose}
            title={t('settings.closeEsc')}
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
        </div>

        {/* 主体两栏布局 */}
        <div className="settings-layout">
          {/* 左侧导航栏 */}
          <aside className="settings-sidebar">
            <button
              type="button"
              className={`settings-nav-item ${activeTab === 'models' ? 'active' : ''}`}
              onClick={() => setActiveTab('models')}
            >
              <span className="nav-icon">🤖</span>
              <div className="nav-text">
                <span className="nav-title">{t('settings.nav.models')}</span>
                <span className="nav-sub">{t('settings.nav.modelsDesc')}</span>
              </div>
            </button>

            <button
              type="button"
              className={`settings-nav-item ${activeTab === 'runtime' ? 'active' : ''}`}
              onClick={() => setActiveTab('runtime')}
            >
              <span className="nav-icon">⚡</span>
              <div className="nav-text">
                <span className="nav-title">{t('settings.nav.runtime')}</span>
                <span className="nav-sub">{t('settings.nav.runtimeDesc')}</span>
              </div>
            </button>

            <button
              type="button"
              className={`settings-nav-item ${activeTab === 'environment' ? 'active' : ''}`}
              onClick={() => setActiveTab('environment')}
            >
              <span className="nav-icon">⚙️</span>
              <div className="nav-text">
                <span className="nav-title">{t('settings.nav.buildEnv')}</span>
                <span className="nav-sub">{t('settings.nav.buildEnvDesc')}</span>
              </div>
            </button>

            <button
              type="button"
              className={`settings-nav-item ${activeTab === 'general' ? 'active' : ''}`}
              onClick={() => setActiveTab('general')}
            >
              <span className="nav-icon">🎨</span>
              <div className="nav-text">
                <span className="nav-title">{t('settings.nav.general')}</span>
                <span className="nav-sub">{t('settings.nav.generalDesc')}</span>
              </div>
            </button>

            <button
              type="button"
              className={`settings-nav-item ${activeTab === 'skills' ? 'active' : ''}`}
              onClick={() => setActiveTab('skills')}
            >
              <span className="nav-icon">🧩</span>
              <div className="nav-text">
                <span className="nav-title">{t('settings.nav.skills')}</span>
                <span className="nav-sub">{t('settings.nav.skillsDesc')}</span>
              </div>
            </button>

            <button
              type="button"
              className={`settings-nav-item ${activeTab === 'mcp' ? 'active' : ''}`}
              onClick={() => setActiveTab('mcp')}
            >
              <span className="nav-icon">🔌</span>
              <div className="nav-text">
                <span className="nav-title">{t('settings.nav.mcp')}</span>
                <span className="nav-sub">{t('settings.nav.mcpDesc')}</span>
              </div>
            </button>

            <button
              type="button"
              className={`settings-nav-item ${activeTab === 'update' ? 'active' : ''}`}
              onClick={() => setActiveTab('update')}
            >
              <span className="nav-icon">🔄</span>
              <div className="nav-text">
                <span className="nav-title">{t('settings.nav.update')}</span>
                <span className="nav-sub">{t('settings.nav.updateDesc')}</span>
              </div>
            </button>

            <button
              type="button"
              className={`settings-nav-item ${activeTab === 'about' ? 'active' : ''}`}
              onClick={() => setActiveTab('about')}
            >
              <span className="nav-icon">✨</span>
              <div className="nav-text">
                <span className="nav-title">{t('settings.nav.about')}</span>
                <span className="nav-sub">{t('settings.nav.aboutDesc')}</span>
              </div>
            </button>
          </aside>

          {/* 右侧面板内容 */}
          <main className="settings-content">
            {/* 1. AI 模型配置 Tab */}
            {activeTab === 'models' && (
              <div className="settings-panel-section">
                <div className="panel-title-bar">
                  <div>
                    <h3 className="panel-h3">{t('settings.models.title')}</h3>
                    <p className="panel-desc">{t('settings.models.desc')}</p>
                  </div>
                  <button
                    type="button"
                    className="add-model-btn"
                    onClick={() => {
                      setEditingModel({
                        id: `model_${Date.now()}`,
                        name: t('settings.models.newModelName'),
                        provider: 'deepseek',
                        baseUrl: 'http://192.168.10.241:1333',
                        model: 'deepseek-v4.1-flash',
                        apiKey: '',
                      });
                      setIsCreatingNew(true);
                    }}
                  >
                    {t('settings.models.add')}
                  </button>
                </div>

                {/* 编辑/新建模型渲染函数 */}
                {(() => {
                  const renderModelEditBox = (isNew: boolean) => {
                    if (!editingModel) return null;
                    return (
                      <div className="model-edit-box" key={editingModel.id}>
                        <div className="model-edit-box-header">
                          <div className="edit-title">
                            <span className="edit-dot" />
                            <strong>
                              {isNew
                                ? t('settings.models.newTitle')
                                : t('settings.models.editTitle', { name: editingModel.name })}
                            </strong>
                            {(modelProbeResults[editingModel.id]?.ok ||
                              (!modelProbeResults[editingModel.id] &&
                                editingModel.lastProbeOk)) && (
                              <span
                                className="connected-pill"
                                title={t('settings.models.probeOkTitle')}
                              >
                                <span className="status-dot" /> {t('settings.models.connected')}
                              </span>
                            )}
                          </div>
                          <div className="preset-quick-select">
                            <span className="preset-label">{t('settings.models.quickPreset')}</span>
                            <select
                              className="preset-select"
                              onChange={(e) => {
                                const preset = MODEL_PRESETS.find(
                                  (p) => t(p.labelKey) === e.target.value,
                                );
                                if (preset) {
                                  setEditingModel({
                                    ...editingModel,
                                    provider: preset.provider,
                                    name: t(preset.nameKey),
                                    baseUrl: preset.baseUrl,
                                    model: preset.model,
                                    enableThinking: preset.enableThinking,
                                    thinkingTokens: preset.thinkingTokens,
                                    reasoningEffort: preset.reasoningEffort,
                                    reasoningEffortFine: preset.reasoningEffortFine,
                                    thinkingTokenBudget: preset.thinkingTokenBudget,
                                  });
                                }
                              }}
                              defaultValue=""
                            >
                              <option value="" disabled>
                                {t('settings.models.presetPlaceholder')}
                              </option>
                              {MODEL_PRESETS.map((p) => (
                                <option key={p.labelKey} value={t(p.labelKey)}>
                                  {t(p.labelKey)}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>

                        {/* ── 基础信息 ───────────────────────────────────────── */}
                        <div className="edit-section">
                          <div className="edit-section-title">
                            <span className="edit-section-bar" />
                            {t('settings.models.basicInfo')}
                          </div>
                          <div className="settings-grid-2">
                            <div className="settings-row">
                              <label>{t('settings.models.provider')}</label>
                              <select
                                className="modern-select"
                                value={editingModel.provider}
                                onChange={(e) => {
                                  const p = e.target.value as ModelProviderType;
                                  setEditingModel({ ...editingModel, provider: p });
                                }}
                              >
                                {(Object.keys(AI_PROVIDER_LABELS) as ModelProviderType[]).map(
                                  (k) => (
                                    <option key={k} value={k}>
                                      {t(PROVIDER_LABEL_KEYS[k])}
                                    </option>
                                  ),
                                )}
                              </select>
                            </div>
                            <div className="settings-row">
                              <label>{t('settings.models.displayName')}</label>
                              <input
                                className="modern-input"
                                value={editingModel.name}
                                placeholder={t('settings.models.displayNamePh')}
                                onChange={(e) =>
                                  setEditingModel({ ...editingModel, name: e.target.value })
                                }
                              />
                            </div>
                          </div>
                        </div>

                        {/* ── 端点与鉴权 ─────────────────────────────────────── */}
                        <div className="edit-section">
                          <div className="edit-section-title">
                            <span className="edit-section-bar" />
                            {t('settings.models.endpointSection')}
                          </div>
                          <div className="settings-row">
                            <label>{t('settings.models.baseUrl')}</label>
                            <input
                              className="modern-input mono-font"
                              value={editingModel.baseUrl}
                              placeholder={t('settings.models.baseUrlPh')}
                              onChange={(e) =>
                                setEditingModel({ ...editingModel, baseUrl: e.target.value })
                              }
                            />
                          </div>
                          <div className="settings-grid-2">
                            <div className="settings-row">
                              <label>{t('settings.models.modelId')}</label>
                              <input
                                className="modern-input mono-font"
                                value={editingModel.model}
                                placeholder={t('settings.models.modelIdPh')}
                                onChange={(e) =>
                                  setEditingModel({ ...editingModel, model: e.target.value })
                                }
                              />
                            </div>
                            <div className="settings-row">
                              <div className="label-with-action">
                                <label>API Key</label>
                                <button
                                  type="button"
                                  className="toggle-eye-btn"
                                  onClick={() => setShowApiKey(!showApiKey)}
                                >
                                  {showApiKey
                                    ? t('settings.models.hideKey')
                                    : t('settings.models.showKey')}
                                </button>
                              </div>
                              <input
                                type={showApiKey ? 'text' : 'password'}
                                className="modern-input mono-font"
                                value={editingModel.apiKey || ''}
                                placeholder={
                                  editingModel.provider === 'deepseek'
                                    ? t('settings.models.keyPhInternal')
                                    : t('settings.models.keyPhGeneric')
                                }
                                onChange={(e) =>
                                  setEditingModel({ ...editingModel, apiKey: e.target.value })
                                }
                              />
                            </div>
                          </div>
                        </div>

                        {/* ── 思考深度 ───────────────────────────────────────── */}
                        <div className="edit-section">
                          <div className="edit-section-title">
                            <span className="edit-section-bar" />
                            {t('settings.models.thinkingSection')}
                          </div>

                          {editingModel.provider === 'anthropic' ? (
                            /* Anthropic 走自己的 extended thinking 预算，与 OpenAI 兼容端点的
                               档位字段不是一回事，因此两套控件互斥出现，不再并排误导。 */
                            <div className="settings-grid-2">
                              <div className="settings-row">
                                <label>{t('settings.models.extendedThinking')}</label>
                                <label className="modern-checkbox-label" style={{ marginTop: 4 }}>
                                  <input
                                    type="checkbox"
                                    checked={editingModel.enableThinking ?? false}
                                    onChange={(e) =>
                                      setEditingModel({
                                        ...editingModel,
                                        enableThinking: e.target.checked,
                                        thinkingTokens: editingModel.thinkingTokens || 8000,
                                      })
                                    }
                                  />
                                  <span>{t('settings.models.enableThinkingOutput')}</span>
                                </label>
                              </div>
                              {editingModel.enableThinking && (
                                <div className="settings-row">
                                  <label>{t('settings.models.thinkingTokens')}</label>
                                  <input
                                    type="number"
                                    className="modern-input mono-font"
                                    min="1000"
                                    max="64000"
                                    step="1000"
                                    value={editingModel.thinkingTokens || 8000}
                                    onChange={(e) =>
                                      setEditingModel({
                                        ...editingModel,
                                        thinkingTokens: Number(e.target.value) || 8000,
                                      })
                                    }
                                  />
                                </div>
                              )}
                            </div>
                          ) : (
                            <>
                              <div className="settings-grid-2">
                                <div className="settings-row">
                                  <label>{t('settings.models.reasoningEffort')}</label>
                                  <select
                                    className="modern-select"
                                    value={editingModel.reasoningEffort ?? ''}
                                    onChange={(e) =>
                                      setEditingModel({
                                        ...editingModel,
                                        reasoningEffort:
                                          (e.target.value as ReasoningEffort) || undefined,
                                      })
                                    }
                                  >
                                    <option value="">{t('settings.models.reasoningDefault')}</option>
                                    {(
                                      Object.keys(REASONING_EFFORT_LABELS) as ReasoningEffort[]
                                    ).map((k) => (
                                      <option key={k} value={k}>
                                        {t(EFFORT_LABEL_KEYS[k])}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                                <div className="settings-row">
                                  <label>
                                    {t('settings.models.fineEffort')}
                                    <span className="label-hint">
                                      {t('settings.models.fineEffortHint')}
                                    </span>
                                  </label>
                                  <input
                                    type="number"
                                    className="modern-input mono-font"
                                    min="1"
                                    max="100"
                                    step="1"
                                    placeholder={t('settings.models.leaveEmpty')}
                                    value={editingModel.reasoningEffortFine ?? ''}
                                    onChange={(e) => {
                                      const v = e.target.value.trim();
                                      setEditingModel({
                                        ...editingModel,
                                        reasoningEffortFine:
                                          v === ''
                                            ? undefined
                                            : Math.min(100, Math.max(1, Number(v))),
                                      });
                                    }}
                                  />
                                </div>
                              </div>
                              <div className="settings-grid-2">
                                <div className="settings-row">
                                  <label>
                                    {t('settings.models.thinkingBudget')}
                                    <span className="label-hint">
                                      {t('settings.models.thinkingBudgetHint')}
                                    </span>
                                  </label>
                                  <input
                                    type="number"
                                    className="modern-input mono-font"
                                    min="0"
                                    step="256"
                                    placeholder="0"
                                    value={editingModel.thinkingTokenBudget ?? 0}
                                    onChange={(e) =>
                                      setEditingModel({
                                        ...editingModel,
                                        thinkingTokenBudget: Math.max(
                                          0,
                                          Number(e.target.value) || 0,
                                        ),
                                      })
                                    }
                                  />
                                </div>
                                <div className="settings-row">
                                  <label>{t('settings.models.effortNote')}</label>
                                  <div className="edit-inline-note">
                                    {t('settings.models.effortNoteText')}
                                  </div>
                                </div>
                              </div>
                              <p className="edit-section-hint">
                                {t('settings.models.fineEffortDesc')}
                              </p>
                            </>
                          )}
                        </div>

                        {/* 编辑卡片内的即时连通性测试反馈 */}
                        {(modelProbingId === editingModel.id ||
                          modelProbeResults[editingModel.id] ||
                          editingModel.lastProbeOk) && (
                          <div
                            className={`probe-result-bubble ${
                              modelProbingId === editingModel.id
                                ? 'probe-testing'
                                : (modelProbeResults[editingModel.id]?.ok ??
                                    editingModel.lastProbeOk)
                                  ? 'probe-success'
                                  : 'probe-error'
                            }`}
                            style={{
                              margin: '12px 0 6px 0',
                              padding: '8px 12px',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              borderRadius: 6,
                              fontSize: 12,
                              width: '100%',
                              boxSizing: 'border-box',
                            }}
                          >
                            <span className="probe-icon">
                              {modelProbingId === editingModel.id
                                ? '⟳'
                                : (modelProbeResults[editingModel.id]?.ok ??
                                    editingModel.lastProbeOk)
                                  ? '✓'
                                  : '✕'}
                            </span>
                            <span className="probe-text" style={{ wordBreak: 'break-all' }}>
                              {modelProbingId === editingModel.id
                                ? t('settings.models.probingEndpoint')
                                : (modelProbeResults[editingModel.id]?.ok ??
                                    editingModel.lastProbeOk)
                                  ? t('settings.models.probeOkDetail', {
                                      detail:
                                        modelProbeResults[editingModel.id]?.detail ||
                                        t('settings.models.probeOkDefault'),
                                    })
                                  : t('settings.models.probeFailDetail', {
                                      detail:
                                        modelProbeResults[editingModel.id]?.detail ||
                                        t('settings.models.probeFailDefault'),
                                    })}
                            </span>
                          </div>
                        )}

                        <div className="model-edit-box-footer">
                          <label className="modern-checkbox-label">
                            <input
                              type="checkbox"
                              checked={
                                editingModel.isDefault === true ||
                                settings.activeModelId === editingModel.id
                              }
                              onChange={(e) =>
                                setEditingModel({ ...editingModel, isDefault: e.target.checked })
                              }
                            />
                            <span>{t('settings.models.setAsDefaultCheckbox')}</span>
                          </label>
                          <div className="edit-btn-group">
                            <button
                              type="button"
                              className="test-btn"
                              disabled={modelProbingId === editingModel.id}
                              onClick={() => void probeSingleModel(editingModel)}
                            >
                              {modelProbingId === editingModel.id
                                ? t('settings.models.testing')
                                : t('settings.models.testConnectivity')}
                            </button>
                            <button
                              type="button"
                              className="cancel-btn"
                              onClick={() => {
                                setEditingModel(null);
                                setIsCreatingNew(false);
                              }}
                            >
                              {t('common.cancel')}
                            </button>
                            <button
                              type="button"
                              className="primary save-model-btn"
                              onClick={() => handleSaveEditingModel(editingModel)}
                            >
                              {t('settings.models.saveConfig')}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  };

                  return (
                    <>
                      {/* 仅在新建模型时在列表顶部渲染编辑框 */}
                      {isCreatingNew && editingModel && renderModelEditBox(true)}

                      {/* 模型列表 */}
                      <div className="modern-model-list">
                        {(settings.models || []).map((m, mIdx) => {
                          // 如果正在编辑当前已有模型，则原地展开编辑表单，不展示重复卡片
                          if (editingModel && !isCreatingNew && editingModel.id === m.id) {
                            return renderModelEditBox(false);
                          }
                          const isActive = settings.activeModelId === m.id || m.isDefault;
                          const probeRes = modelProbeResults[m.id];
                          const isProbing = modelProbingId === m.id;
                          return (
                            <div
                              key={m.id}
                              className={`modern-model-card ${isActive ? 'is-active' : ''} prov-${m.provider || 'custom'}`}
                            >
                              <div className="model-card-left">
                                <div className={`model-provider-badge prov-${m.provider}`}>
                                  {m.provider === 'anthropic'
                                    ? 'Claude'
                                    : m.provider === 'deepseek'
                                      ? 'DeepSeek'
                                      : m.provider === 'openai'
                                        ? 'OpenAI'
                                        : t('settings.models.providerCustom')}
                                </div>
                                <div className="model-info-block">
                                  <div className="model-name-line">
                                    <span className="model-display-name" title={m.name}>
                                      {m.name}
                                    </span>
                                    {isActive && (
                                      <span className="active-glow-pill">
                                        {t('settings.models.activeSelected')}
                                      </span>
                                    )}
                                    {((probeRes && probeRes.ok) ||
                                      (!probeRes && m.lastProbeOk)) && (
                                      <span
                                        className="connected-pill"
                                        title={t('settings.models.probeOkTitle')}
                                      >
                                        <span className="status-dot" />{' '}
                                        {t('settings.models.connected')}
                                      </span>
                                    )}
                                    {probeRes && !probeRes.ok && (
                                      <span
                                        className="probe-fail-pill"
                                        title={t('settings.models.probeErrorTitle', {
                                          detail:
                                            probeRes.detail ||
                                            t('settings.models.probeErrorDefault'),
                                        })}
                                      >
                                        {t('settings.models.connectAbnormal')}
                                      </span>
                                    )}
                                    {m.enableThinking && (
                                      <span className="thinking-pill">
                                        {t('settings.models.deepThinking')}
                                      </span>
                                    )}
                                    {m.provider !== 'anthropic' &&
                                      (m.reasoningEffortFine != null || m.reasoningEffort) && (
                                        <span
                                          className="thinking-pill"
                                          title={t('settings.models.effortTitle')}
                                        >
                                          🧠{' '}
                                          {m.reasoningEffortFine != null
                                            ? t('settings.models.fineEffortValue', {
                                                n: m.reasoningEffortFine,
                                              })
                                            : t(EFFORT_LABEL_KEYS[m.reasoningEffort!])}
                                        </span>
                                      )}
                                  </div>
                                  <div className="model-meta-line">
                                    <code className="model-id-code">{m.model}</code>
                                    <span className="meta-sep">•</span>
                                    <span className="model-endpoint-text" title={m.baseUrl}>
                                      {m.baseUrl}
                                    </span>
                                    <span className="meta-sep">•</span>
                                    {m.apiKey ? (
                                      <span className="key-state has-key">
                                        {t('settings.models.keyConfigured')}
                                      </span>
                                    ) : (
                                      <span className="key-state no-key">
                                        {t('settings.models.keyNone')}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>

                              <div className="model-card-right-column">
                                {/* 右上角默认模型开关 */}
                                <div className="model-card-top-right">
                                  <label
                                    className={`model-default-switch ${isActive ? 'is-active' : ''}`}
                                    title={
                                      isActive
                                        ? t('settings.models.currentDefault')
                                        : t('settings.models.clickSetDefault')
                                    }
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (!isActive) handleSetDefaultModel(m.id);
                                    }}
                                  >
                                    <span className="switch-text">
                                      {isActive
                                        ? t('settings.models.defaultModel')
                                        : t('settings.models.setDefault')}
                                    </span>
                                    <span className={`switch-pill ${isActive ? 'checked' : ''}`}>
                                      <span className="switch-thumb" />
                                    </span>
                                  </label>
                                </div>

                                {/* 操作按钮组 */}
                                <div className="model-card-right-actions">
                                  <button
                                    type="button"
                                    className="card-action-btn move-btn"
                                    title={t('settings.models.moveUp')}
                                    disabled={mIdx === 0}
                                    onClick={() => handleMoveModel(m.id, 'up')}
                                  >
                                    ↑
                                  </button>
                                  <button
                                    type="button"
                                    className="card-action-btn move-btn"
                                    title={t('settings.models.moveDown')}
                                    disabled={mIdx === (settings.models?.length || 0) - 1}
                                    onClick={() => handleMoveModel(m.id, 'down')}
                                  >
                                    ↓
                                  </button>

                                  <button
                                    type="button"
                                    className="card-action-btn probe-btn"
                                    title={t('settings.models.probeConnectivity')}
                                    disabled={isProbing}
                                    onClick={() => void probeSingleModel(m)}
                                  >
                                    {isProbing ? t('common.probing') : t('settings.models.probe')}
                                  </button>
                                  <button
                                    type="button"
                                    className="card-action-btn edit-btn"
                                    title={t('settings.models.editModelParams')}
                                    onClick={() => {
                                      setEditingModel({ ...m });
                                      setIsCreatingNew(false);
                                    }}
                                  >
                                    {t('settings.models.edit')}
                                  </button>
                                  {(settings.models?.length || 0) > 1 && (
                                    <button
                                      type="button"
                                      className="card-action-btn delete-btn"
                                      title={t('settings.models.deleteModelTitle')}
                                      onClick={() => setDeletingModel(m)}
                                    >
                                      🗑
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  );
                })()}
              </div>
            )}

            {/* 2. 运行与推理参数 Tab */}
            {activeTab === 'runtime' && (
              <div className="settings-panel-section">
                <div className="panel-title-bar">
                  <div>
                    <h3 className="panel-h3">{t('settings.runtime.title')}</h3>
                    <p className="panel-desc">{t('settings.runtime.desc')}</p>
                  </div>
                </div>

                <div className="modern-card-group">
                  <div className="setting-card">
                    <div className="setting-card-title">
                      <strong>{t('settings.runtime.temperature')}</strong>
                      <span className="card-current-val">{settings.temperature}</span>
                    </div>
                    <p className="setting-card-desc">{t('settings.runtime.temperatureDesc')}</p>
                    <input
                      type="range"
                      min="0"
                      max="1.5"
                      step="0.05"
                      className="modern-range"
                      value={settings.temperature}
                      onChange={(e) =>
                        setSettings({ ...settings, temperature: Number(e.target.value) || 0 })
                      }
                    />
                  </div>

                  <div className="setting-card">
                    <div className="setting-card-title">
                      <strong>{t('settings.runtime.maxSteps')}</strong>
                      <span className="card-current-val">
                        {t('settings.runtime.steps', { n: settings.maxAgentSteps })}
                      </span>
                    </div>
                    <p className="setting-card-desc">{t('settings.runtime.maxStepsDesc')}</p>
                    <input
                      type="number"
                      min="5"
                      max="200"
                      className="modern-input"
                      value={settings.maxAgentSteps}
                      onChange={(e) =>
                        setSettings({ ...settings, maxAgentSteps: Number(e.target.value) || 50 })
                      }
                    />
                  </div>

                  <div className="setting-card">
                    <div className="setting-card-title">
                      <strong>{t('settings.runtime.contextWindow')}</strong>
                      <span className="card-current-val">
                        {settings.contextWindowTokens.toLocaleString()} tokens
                      </span>
                    </div>
                    <p className="setting-card-desc">{t('settings.runtime.contextWindowDesc')}</p>
                    <input
                      type="number"
                      min="4000"
                      step="4000"
                      className="modern-input"
                      value={settings.contextWindowTokens}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          contextWindowTokens: Number(e.target.value) || 128000,
                        })
                      }
                    />
                  </div>

                  <div className="setting-card">
                    <div className="setting-card-title">
                      <strong>{t('settings.runtime.maxOutput')}</strong>
                      <span className="card-current-val">
                        {(settings.maxOutputTokens ?? 32768).toLocaleString()} tokens
                      </span>
                    </div>
                    <p className="setting-card-desc">{t('settings.runtime.maxOutputDesc')}</p>
                    <input
                      type="number"
                      min="0"
                      step="1024"
                      className="modern-input"
                      value={settings.maxOutputTokens ?? 32768}
                      onChange={(e) =>
                        setSettings({ ...settings, maxOutputTokens: Number(e.target.value) || 0 })
                      }
                    />
                  </div>

                  <div className="setting-card">
                    <div className="setting-card-title">
                      <strong>{t('settings.runtime.repetitionGuard')}</strong>
                      <span className="card-current-val">
                        {settings.repetitionGuard === false
                          ? t('settings.runtime.off')
                          : t('settings.runtime.on')}
                      </span>
                    </div>
                    <p className="setting-card-desc">{t('settings.runtime.repetitionGuardDesc')}</p>
                    <label
                      className="modern-checkbox-label"
                      style={{ fontSize: 13, fontWeight: 500 }}
                    >
                      <input
                        type="checkbox"
                        checked={settings.repetitionGuard !== false}
                        onChange={(e) =>
                          setSettings({ ...settings, repetitionGuard: e.target.checked })
                        }
                      />
                      <span>
                        {settings.repetitionGuard === false
                          ? t('settings.runtime.disabling')
                          : t('settings.runtime.enabling')}
                      </span>
                    </label>
                  </div>

                  <div className="setting-card">
                    <div className="setting-card-title">
                      <strong>{t('settings.runtime.serverDetection')}</strong>
                      <span className="card-current-val">
                        {settings.serverRepetitionDetection === false
                          ? t('settings.runtime.off')
                          : t('settings.runtime.on')}
                      </span>
                    </div>
                    <p className="setting-card-desc">
                      {t('settings.runtime.serverDetectionDesc')}
                      <br />
                      <strong>{t('settings.runtime.noteLabel')}</strong>
                      {t('settings.runtime.serverDetectionNote')}
                    </p>
                    <label
                      className="modern-checkbox-label"
                      style={{ fontSize: 13, fontWeight: 500 }}
                    >
                      <input
                        type="checkbox"
                        checked={settings.serverRepetitionDetection !== false}
                        onChange={(e) =>
                          setSettings({ ...settings, serverRepetitionDetection: e.target.checked })
                        }
                      />
                      <span>
                        {settings.serverRepetitionDetection === false
                          ? t('settings.runtime.disabling')
                          : t('settings.runtime.enabling')}
                      </span>
                    </label>
                  </div>

                  <div className="setting-card">
                    <div className="setting-card-title">
                      <strong>{t('settings.runtime.frequencyPenalty')}</strong>
                      <span className="card-current-val">
                        {(settings.frequencyPenalty ?? 0.3).toFixed(2)}
                      </span>
                    </div>
                    <p className="setting-card-desc">
                      {t('settings.runtime.frequencyPenaltyDesc')}
                    </p>
                    <input
                      type="range"
                      min="0"
                      max="2"
                      step="0.05"
                      className="modern-range"
                      value={settings.frequencyPenalty ?? 0.3}
                      onChange={(e) =>
                        setSettings({ ...settings, frequencyPenalty: Number(e.target.value) || 0 })
                      }
                    />
                  </div>

                  <div className="setting-card">
                    <div className="setting-card-title">
                      <strong>{t('settings.runtime.presencePenalty')}</strong>
                      <span className="card-current-val">
                        {(settings.presencePenalty ?? 0.3).toFixed(2)}
                      </span>
                    </div>
                    <p className="setting-card-desc">
                      {t('settings.runtime.presencePenaltyDesc')}
                    </p>
                    <input
                      type="range"
                      min="0"
                      max="2"
                      step="0.05"
                      className="modern-range"
                      value={settings.presencePenalty ?? 0.3}
                      onChange={(e) =>
                        setSettings({ ...settings, presencePenalty: Number(e.target.value) || 0 })
                      }
                    />
                  </div>
                </div>
              </div>
            )}

            {/* 3. 外观与权限 Tab */}
            {activeTab === 'general' && (
              <div className="settings-panel-section">
                <div className="panel-title-bar">
                  <div>
                    <h3 className="panel-h3">{t('settings.general.title')}</h3>
                    <p className="panel-desc">{t('settings.appearanceDesc')}</p>
                  </div>
                </div>

                <div className="modern-card-group">
                  <div className="setting-card">
                    <div className="setting-card-title">
                      <strong>{t('settings.language')}</strong>
                    </div>
                    <select
                      className="modern-select"
                      value={locale}
                      onChange={(e) => setLocale(e.target.value as 'zh' | 'en')}
                    >
                      <option value="zh">{t('settings.language.zh')}</option>
                      <option value="en">{t('settings.language.en')}</option>
                    </select>
                  </div>

                  <div className="setting-card">
                    <div className="setting-card-title">
                      <strong>{t('settings.permission')}</strong>
                    </div>
                    <p className="setting-card-desc">{t('settings.permissionDesc')}</p>
                    <select
                      className="modern-select"
                      value={settings.permissionMode}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          permissionMode: e.target.value as PermissionMode,
                        })
                      }
                    >
                      {PERMISSION_ORDER.map((m) => (
                        <option key={m} value={m}>
                          {t(PERMISSION_LABEL_KEYS[m])}
                        </option>
                      ))}
                    </select>
                    <div className="perm-hint-bubble">
                      ℹ️ {t(PERMISSION_HINT_KEYS[settings.permissionMode])}
                    </div>
                  </div>

                  <div className="setting-card">
                    <div className="setting-card-title">
                      <strong>{t('settings.general.keymap')}</strong>
                    </div>
                    <p className="setting-card-desc">{t('settings.general.keymapDesc')}</p>
                    <select
                      className="modern-select"
                      value={settings.keymapPreset || 'vscode'}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          keymapPreset: e.target.value as 'vscode' | 'intellij',
                        })
                      }
                    >
                      <option value="vscode">{t('settings.general.keymapVscode')}</option>
                      <option value="intellij">{t('settings.general.keymapIntellij')}</option>
                    </select>
                  </div>

                  <div className="setting-card">
                    <label
                      className="modern-checkbox-label"
                      style={{ fontSize: 13, fontWeight: 500 }}
                    >
                      <input
                        type="checkbox"
                        checked={settings.autoSave === true}
                        onChange={(e) => setSettings({ ...settings, autoSave: e.target.checked })}
                      />
                      <span>{t('settings.general.autosaveFull')}</span>
                    </label>
                  </div>
                  <div className="setting-card" style={{ marginTop: 12 }}>
                    <label
                      className="modern-checkbox-label"
                      style={{ fontSize: 13, fontWeight: 500 }}
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(settings.formatOnSave)}
                        onChange={(e) =>
                          setSettings({ ...settings, formatOnSave: e.target.checked })
                        }
                      />
                      <span>{t('settings.general.formatOnSave')}</span>
                    </label>
                  </div>
                  <div className="setting-control-group" style={{ marginTop: 12 }}>
                    <label
                      className="modern-checkbox-label"
                      style={{ fontSize: 13, fontWeight: 500 }}
                    >
                      <input
                        type="checkbox"
                        checked={settings.gitBlameInline !== false}
                        onChange={(e) =>
                          setSettings({ ...settings, gitBlameInline: e.target.checked })
                        }
                      />
                      <span>{t('settings.general.blameInline')}</span>
                    </label>
                  </div>

                  <div className="setting-card" style={{ marginTop: 12 }}>
                    <div className="setting-card-title">
                      <strong>{t('settings.hoverDelay')}</strong>
                    </div>
                    <p className="setting-card-desc">{t('settings.hoverDelayDesc')}</p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                      <input
                        type="number"
                        min={500}
                        step={100}
                        className="modern-input"
                        style={{ width: 140 }}
                        value={settings.hoverDelay ?? 500}
                        onChange={(e) => {
                          const val = Math.max(500, Number(e.target.value) || 500);
                          setSettings({ ...settings, hoverDelay: val });
                        }}
                      />
                      <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                        {t('settings.general.msUnit')}
                      </span>
                    </div>
                  </div>

                  <div className="setting-control-group" style={{ marginTop: 12 }}>
                    <label
                      className="modern-checkbox-label"
                      style={{ fontSize: 13, fontWeight: 500 }}
                    >
                      <input
                        type="checkbox"
                        checked={settings.minimap !== false}
                        onChange={(e) => setSettings({ ...settings, minimap: e.target.checked })}
                      />
                      <span>{t('settings.minimap')}</span>
                    </label>
                  </div>

                  <div className="setting-control-group" style={{ marginTop: 12 }}>
                    <label
                      className="modern-checkbox-label"
                      style={{ fontSize: 13, fontWeight: 500 }}
                    >
                      <input
                        type="checkbox"
                        checked={settings.selectionAiFloat !== false}
                        onChange={(e) =>
                          setSettings({ ...settings, selectionAiFloat: e.target.checked })
                        }
                      />
                      <span>{t('settings.selectionAiFloat')}</span>
                    </label>
                  </div>

                  <div className="setting-card" style={{ marginTop: 12 }}>
                    <div className="setting-card-title">
                      <strong>{t('settings.general.scrollback')}</strong>
                    </div>
                    <p className="setting-card-desc">{t('settings.general.scrollbackDesc')}</p>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        marginTop: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      <input
                        type="number"
                        min={1000}
                        max={100000}
                        step={1000}
                        className="modern-input"
                        style={{ width: 140 }}
                        value={settings.terminalScrollback ?? 10000}
                        onChange={(e) => {
                          const val = Math.min(
                            100000,
                            Math.max(1000, Number(e.target.value) || 10000),
                          );
                          setSettings({ ...settings, terminalScrollback: val });
                        }}
                      />
                      <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                        {t('settings.general.linesUnit')}
                      </span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {[5000, 10000, 20000, 50000].map((preset) => {
                          const selected = (settings.terminalScrollback ?? 10000) === preset;
                          return (
                            <button
                              key={preset}
                              type="button"
                              className="preset-tag-btn"
                              style={{
                                padding: '3px 9px',
                                fontSize: 12,
                                borderRadius: 4,
                                border:
                                  '1px solid ' + (selected ? 'var(--accent)' : 'var(--border)'),
                                background: selected ? 'var(--accent)' : 'transparent',
                                color: selected ? '#fff' : 'var(--fg)',
                                cursor: 'pointer',
                                transition: 'all 0.15s ease',
                              }}
                              onClick={() =>
                                setSettings({ ...settings, terminalScrollback: preset })
                              }
                            >
                              {t('settings.general.linesValue', { n: preset.toLocaleString() })}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="setting-card" style={{ marginTop: 12 }}>
                    <div className="setting-card-title">
                      <strong>{t('settings.theme')}</strong>
                    </div>
                    <div className="theme-selector-cards">
                      <div
                        className={`theme-card ${settings.theme === 'dark' ? 'selected' : ''}`}
                        onClick={() => setSettings({ ...settings, theme: 'dark' })}
                      >
                        <div className="theme-preview dark-preview" />
                        <span>{t('settings.theme.dark')}</span>
                      </div>
                      <div
                        className="theme-card disabled"
                        title={t('settings.theme.light.disabledHint')}
                      >
                        <div className="theme-preview light-preview" />
                        <div className="theme-card-label-row">
                          <span>{t('settings.theme.light')}</span>
                          <span className="theme-card-tag">{t('settings.theme.adapting')}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 开发与构建环境 Tab */}
            {activeTab === 'environment' && (
              <EnvironmentSettingsSection
                workspace={workspace || undefined}
                onShowToast={onShowToast}
              />
            )}

            {/* 4. Skills 扩展库 Tab */}
            {activeTab === 'skills' && (
              <div className="settings-panel-section">
                <div className="panel-title-bar">
                  <div>
                    <h3 className="panel-h3">{t('settings.skills.title')}</h3>
                    <p className="panel-desc">{t('settings.skills.desc')}</p>
                  </div>
                  <button
                    type="button"
                    className="open-skills-btn"
                    onClick={() => void openSkills()}
                  >
                    {t('settings.skills.openDir')}
                  </button>
                </div>

                {skillsDir && (
                  <div className="skills-dir-badge">
                    <span>{t('settings.skills.userPath')}</span>
                    <code>{skillsDir}</code>
                  </div>
                )}

                {skills.length === 0 ? (
                  <div className="skills-empty-state">
                    <span className="empty-icon">🧩</span>
                    <p>{t('settings.skills.empty')}</p>
                    <span className="empty-sub">
                      {translateSegments('settings.skills.placeHint', locale, {
                        cursorPath: '.cursor/skills/*/SKILL.md',
                        deepseekPath: '.deepseek/skills/*/SKILL.md',
                      }).map((seg, i) =>
                        seg.emphasis ? <code key={i}>{seg.text}</code> : <span key={i}>{seg.text}</span>,
                      )}
                    </span>
                  </div>
                ) : (
                  <div className="skills-grid-list">
                    {skills.map((s) => (
                      <div key={s.path} className="skill-card-item">
                        <div className="skill-card-header">
                          <strong>{s.name}</strong>
                          <span className="skill-source-pill">{s.source}</span>
                        </div>
                        <p className="skill-card-desc">{s.description || s.path}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* MCP 服务器 */}
            {activeTab === 'mcp' && (
              <div className="settings-panel-section">
                <div className="panel-title-bar">
                  <div>
                    <h3 className="panel-h3">{t('settings.mcp.title')}</h3>
                    <p className="panel-desc">{t('settings.mcp.desc')}</p>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="open-skills-btn"
                      disabled={mcpReloading}
                      onClick={() => {
                        setMcpReloading(true);
                        void window.ide
                          .mcpReload()
                          .then(setMcpStatuses)
                          .catch(() => setMcpStatuses([]))
                          .finally(() => setMcpReloading(false));
                      }}
                    >
                      {mcpReloading ? t('settings.mcp.connecting') : t('settings.mcp.reconnect')}
                    </button>
                    <button type="button" className="open-skills-btn" onClick={handleAddMcpServer}>
                      {t('settings.mcp.addServer')}
                    </button>
                  </div>
                </div>

                <div className="mcp-security-note">
                  <strong>{t('settings.mcp.secLabel')}</strong>
                  {translateSegments('settings.mcp.secBody', locale, {
                    outside: t('settings.mcp.secOutside'),
                    never: t('settings.mcp.secNever'),
                  }).map((seg, i) =>
                    seg.emphasis ? <b key={i}>{seg.text}</b> : <span key={i}>{seg.text}</span>,
                  )}
                </div>

                {mcpRows.length === 0 ? (
                  <div className="skills-empty-state">
                    <span className="empty-icon">🔌</span>
                    <p>{t('settings.mcp.empty')}</p>
                    <span className="empty-sub">
                      {t('settings.mcp.exampleLabel')}
                      <code>npx -y @modelcontextprotocol/server-filesystem /path</code>
                    </span>
                  </div>
                ) : (
                  <div className="mcp-server-list">
                    {mcpRows.map(({ cfg, status }) => {
                      const expanded = editingMcpId === cfg.id;
                      return (
                        <div key={cfg.id} className="mcp-server-card">
                          <div className="mcp-server-head">
                            <button
                              type="button"
                              className="mcp-server-toggle"
                              onClick={() => setEditingMcpId(expanded ? null : cfg.id)}
                            >
                              <span className={`mcp-dot ${status?.state ?? 'idle'}`} />
                              <strong>{cfg.name || cfg.id}</strong>
                              {status && status.state === 'ready' && (
                                <span className="mcp-pill ok">
                                  {t('settings.mcp.toolCount', { n: status.toolCount })}
                                </span>
                              )}
                              {status && status.truncated > 0 && (
                                <span className="mcp-pill warn">
                                  {t('settings.mcp.truncatedMore', { n: status.truncated })}
                                </span>
                              )}
                              <span className={`mcp-pill ${cfg.access === 'readonly' ? 'ok' : 'warn'}`}>
                                {cfg.access === 'readonly'
                                  ? t('settings.mcp.readonly')
                                  : t('settings.mcp.writable')}
                              </span>
                              <span className="mcp-caret">{expanded ? '▾' : '▸'}</span>
                            </button>
                            <div className="mcp-server-actions">
                              <label className="mcp-enable-label">
                                <input
                                  type="checkbox"
                                  checked={cfg.enabled}
                                  onChange={(e) => {
                                    patchMcpServer(cfg.id, { enabled: e.target.checked });
                                    // 启用/停用是一个完整的动作，立刻生效才有意义
                                    void saveMcpServers(
                                      (settings?.mcpServers ?? []).map((s) =>
                                        s.id === cfg.id ? { ...s, enabled: e.target.checked } : s,
                                      ),
                                    );
                                  }}
                                />
                                {t('settings.mcp.enable')}
                              </label>
                              <button
                                type="button"
                                className="mcp-danger-btn"
                                onClick={() => setPendingMcpDelete(cfg.id)}
                              >
                                {t('settings.mcp.delete')}
                              </button>
                            </div>
                          </div>

                          {status?.state === 'error' && (
                            <div className="mcp-error-box">
                              <div className="mcp-error-title">{t('settings.mcp.connectFailed')}</div>
                              <div className="mcp-error-msg">{status.error}</div>
                              {status.stderr && <pre className="mcp-stderr">{status.stderr}</pre>}
                            </div>
                          )}

                          {expanded && (
                            <div className="mcp-editor">
                              <label className="mcp-field">
                                <span>{t('settings.mcp.fieldId')}</span>
                                <input
                                  value={cfg.id}
                                  onChange={(e) =>
                                    patchMcpServer(cfg.id, {
                                      id: e.target.value.replace(/[^a-zA-Z0-9_-]/g, '-'),
                                    })
                                  }
                                />
                                <em>
                                  {translateSegments('settings.mcp.fieldIdHint', locale, {
                                    prefix: `${cfg.id || 'id'}__${t('settings.mcp.toolNameSuffix')}`,
                                  }).map((seg, i) =>
                                    seg.emphasis ? (
                                      <code key={i}>{seg.text}</code>
                                    ) : (
                                      <span key={i}>{seg.text}</span>
                                    ),
                                  )}
                                </em>
                              </label>
                              <label className="mcp-field">
                                <span>{t('settings.mcp.fieldName')}</span>
                                <input
                                  value={cfg.name}
                                  onChange={(e) => patchMcpServer(cfg.id, { name: e.target.value })}
                                />
                              </label>
                              <label className="mcp-field">
                                <span>{t('settings.mcp.fieldCommand')}</span>
                                <input
                                  value={cfg.command}
                                  placeholder="npx"
                                  onChange={(e) =>
                                    patchMcpServer(cfg.id, { command: e.target.value })
                                  }
                                />
                              </label>
                              <label className="mcp-field">
                                <span>{t('settings.mcp.fieldArgs')}</span>
                                <textarea
                                  rows={3}
                                  value={(cfg.args ?? []).join('\n')}
                                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path'}
                                  onChange={(e) =>
                                    patchMcpServer(cfg.id, {
                                      args: e.target.value
                                        .split('\n')
                                        .map((s) => s.trim())
                                        .filter(Boolean),
                                    })
                                  }
                                />
                              </label>
                              <label className="mcp-field">
                                <span>{t('settings.mcp.fieldCwd')}</span>
                                <input
                                  value={cfg.cwd ?? ''}
                                  onChange={(e) =>
                                    patchMcpServer(cfg.id, { cwd: e.target.value || undefined })
                                  }
                                />
                              </label>
                              <label className="mcp-field">
                                <span>{t('settings.mcp.fieldEnv')}</span>
                                <textarea
                                  rows={2}
                                  value={Object.entries(cfg.env ?? {})
                                    .map(([k, v]) => `${k}=${v}`)
                                    .join('\n')}
                                  onChange={(e) => {
                                    const env: Record<string, string> = {};
                                    for (const line of e.target.value.split('\n')) {
                                      const i = line.indexOf('=');
                                      if (i <= 0) continue;
                                      env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
                                    }
                                    patchMcpServer(cfg.id, { env });
                                  }}
                                />
                                <em>{t('settings.mcp.fieldEnvHint')}</em>
                              </label>
                              <label className="mcp-field">
                                <span>{t('settings.mcp.fieldAccess')}</span>
                                <select
                                  value={cfg.access ?? 'write'}
                                  onChange={(e) =>
                                    patchMcpServer(cfg.id, {
                                      access: e.target.value as 'readonly' | 'write',
                                    })
                                  }
                                >
                                  <option value="write">{t('settings.mcp.accessWrite')}</option>
                                  <option value="readonly">{t('settings.mcp.accessReadonly')}</option>
                                </select>
                                <em>{t('settings.mcp.fieldAccessHint')}</em>
                              </label>
                              <div className="mcp-editor-footer">
                                <button
                                  type="button"
                                  className="mcp-save-btn"
                                  onClick={() => {
                                    void saveMcpServers(settings?.mcpServers ?? []).then(() => {
                                      setEditingMcpId(null);
                                    });
                                  }}
                                >
                                  {t('settings.mcp.saveConnect')}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* 5. 软件更新 Tab */}
            {activeTab === 'update' && (
              <div className="settings-panel-section">
                <div className="panel-title-bar">
                  <div>
                    <h3 className="panel-h3">{t('settings.update.title')}</h3>
                    <p className="panel-desc">{t('settings.update.desc')}</p>
                  </div>
                </div>

                <div className="modern-card-group">
                  <div className="setting-card">
                    <div className="setting-card-title">
                      <strong>{t('settings.update.provider')}</strong>
                    </div>
                    <select
                      className="modern-select"
                      value={settings.updateFeed?.provider ?? 'github'}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          updateFeed: feedWith({
                            provider: e.target.value as 'github' | 'generic',
                          }),
                        })
                      }
                    >
                      <option value="github">GitHub Releases</option>
                      <option value="generic">{t('settings.update.providerGeneric')}</option>
                    </select>
                  </div>

                  {(settings.updateFeed?.provider ?? 'github') === 'github' && (
                    <>
                      <div className="setting-card">
                        <div className="setting-card-title">
                          <strong>{t('settings.update.ownerRepo')}</strong>
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                          <input
                            className="modern-input"
                            placeholder={t('settings.update.ownerPh')}
                            value={settings.updateFeed?.owner ?? 'DanielCraig07'}
                            onChange={(e) =>
                              setSettings({
                                ...settings,
                                updateFeed: feedWith({ owner: e.target.value }),
                              })
                            }
                          />
                          <input
                            className="modern-input"
                            placeholder={t('settings.update.repoPh')}
                            value={settings.updateFeed?.repo ?? 'Echoly'}
                            onChange={(e) =>
                              setSettings({
                                ...settings,
                                updateFeed: feedWith({ repo: e.target.value }),
                              })
                            }
                          />
                        </div>
                      </div>
                      <div className="setting-card">
                        <div className="setting-card-title">
                          <strong>{t('settings.update.token')}</strong>
                        </div>
                        <input
                          className="modern-input"
                          type="password"
                          placeholder="ghp_… / github_pat_…"
                          value={settings.updateFeed?.token ?? ''}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              updateFeed: feedWith({ token: e.target.value }),
                            })
                          }
                        />
                      </div>
                    </>
                  )}

                  {settings.updateFeed?.provider === 'generic' && (
                    <div className="setting-card">
                      <div className="setting-card-title">
                        <strong>{t('settings.update.genericUrl')}</strong>
                      </div>
                      <input
                        className="modern-input"
                        placeholder="https://updates.example.com/echoly/"
                        value={settings.updateFeed?.genericUrl ?? ''}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            updateFeed: feedWith({ genericUrl: e.target.value }),
                          })
                        }
                      />
                    </div>
                  )}

                  <div className="setting-card">
                    <button
                      type="button"
                      className="primary save-all-btn"
                      onClick={() => void checkUpdateNow()}
                      disabled={checking || downloading}
                    >
                      {checking ? t('settings.update.checking') : t('settings.update.check')}
                    </button>
                    {updateMsg && (
                      <div
                        className={`update-result-msg ${updateMsg.type === 'error' ? 'is-error' : 'is-ok'}`}
                        style={{ marginTop: 10 }}
                      >
                        {updateMsg.type === 'error' ? '✕ ' : '✓ '}
                        {updateMsg.text}
                      </div>
                    )}
                    {updating && (
                      <div className="update-progress" style={{ marginTop: 10 }}>
                        <div className="update-progress-track">
                          <div
                            className="update-progress-fill"
                            style={{ width: `${Math.max(4, updating.percent)}%` }}
                          />
                        </div>
                        <span className="update-progress-text">
                          {t('settings.update.downloading')} {updating.percent}%
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* 6. 关于作者与版本 Tab */}
            {activeTab === 'about' && (
              <div className="settings-panel-section about-panel-section">
                {/* Brand Hero Card */}
                <div className="about-hero-card">
                  <div className="about-hero-top">
                    <div className="about-logo-wrapper">
                      <img
                        src={echolyAppIcon}
                        alt="Echoly App Icon"
                        className="about-app-icon-img"
                      />
                    </div>
                    <div className="about-hero-text">
                      <div className="about-hero-title-row">
                        <h2 className="about-app-name">Echoly</h2>
                        <span className="about-version-tag">v{APP_VERSION}</span>
                        <span className="about-badge-status">{t('settings.about.releaseBadge')}</span>
                      </div>
                      <p className="about-tagline">{t('settings.about.desc')}</p>
                    </div>
                  </div>

                  <div className="about-hero-actions">
                    <button
                      type="button"
                      className="about-action-btn primary"
                      onClick={() => setActiveTab('update')}
                    >
                      <span className="btn-icon">🔄</span>
                      <span>{t('settings.about.checkUpdate')}</span>
                    </button>
                    <button
                      type="button"
                      className="about-action-btn secondary"
                      onClick={() => void handleCopySystemInfo()}
                    >
                      <span className="btn-icon">📋</span>
                      <span>{t('settings.about.copyInfo')}</span>
                    </button>
                    <a
                      href="https://github.com/DanielCraig07"
                      target="_blank"
                      rel="noreferrer"
                      className="about-action-btn secondary"
                    >
                      <span className="btn-icon">👨‍💻</span>
                      <span>{t('settings.about.authorGithub')}</span>
                    </a>
                  </div>
                </div>

                {/* Author Card */}
                <div className="about-author-card">
                  <div className="about-author-avatar-wrap">
                    <img
                      src="https://avatars.githubusercontent.com/u/104928236?v=4"
                      alt="Daniel"
                      className="about-author-avatar"
                      onError={(e) => {
                        (e.target as HTMLElement).style.display = 'none';
                      }}
                    />
                    <div className="about-avatar-fallback">⚡</div>
                  </div>
                  <div className="about-author-content">
                    <div className="about-author-header">
                      <div className="about-author-name-group">
                        <h3 className="about-author-name">{t('settings.about.authorName')}</h3>
                        <a
                          href="https://github.com/DanielCraig07"
                          target="_blank"
                          rel="noreferrer"
                          className="about-author-handle"
                        >
                          {t('settings.about.authorHandle')} ↗
                        </a>
                      </div>
                      <span className="about-author-role">{t('settings.about.developer')}</span>
                    </div>
                    <p className="about-author-bio">{t('settings.about.authorBio')}</p>
                    <div className="about-author-tags">
                      <span className="about-chip">🚀 Full-Stack & AI Agent</span>
                      <span className="about-chip">⚡ Tree-sitter & AST</span>
                      <span className="about-chip">💻 Electron & React</span>
                      <span className="about-chip">🛡️ Safe Tool Execution</span>
                    </div>
                  </div>
                </div>

                {/* Feature Highlights Grid */}
                <div className="about-section-header">
                  <h4 className="about-section-title">{t('settings.about.features')}</h4>
                </div>
                <div className="about-features-grid">
                  <div className="about-feat-card">
                    <div className="about-feat-header">
                      <span className="about-feat-icon">⚡</span>
                      <strong className="about-feat-name">{t('settings.about.featAst')}</strong>
                    </div>
                    <p className="about-feat-desc">{t('settings.about.featAstDesc')}</p>
                  </div>

                  <div className="about-feat-card">
                    <div className="about-feat-header">
                      <span className="about-feat-icon">🤖</span>
                      <strong className="about-feat-name">{t('settings.about.featAgent')}</strong>
                    </div>
                    <p className="about-feat-desc">{t('settings.about.featAgentDesc')}</p>
                  </div>

                  <div className="about-feat-card">
                    <div className="about-feat-header">
                      <span className="about-feat-icon">🌐</span>
                      <strong className="about-feat-name">{t('settings.about.featRemote')}</strong>
                    </div>
                    <p className="about-feat-desc">{t('settings.about.featRemoteDesc')}</p>
                  </div>
                </div>

                {/* Environment & Diagnostic Card */}
                <div className="about-info-card">
                  <div className="about-info-header">
                    <strong>{t('settings.about.systemInfo')}</strong>
                    <button
                      type="button"
                      className="about-copy-btn"
                      onClick={() => void handleCopySystemInfo()}
                    >
                      📋 {t('settings.about.copyInfo')}
                    </button>
                  </div>
                  <div className="about-info-table">
                    <div className="about-info-row">
                      <span className="about-info-k">{t('settings.about.runtimeVersion')}</span>
                      <span className="about-info-v font-mono">v{APP_VERSION} (Production)</span>
                    </div>
                    <div className="about-info-row">
                      <span className="about-info-k">{t('settings.about.runtimeArch')}</span>
                      <span className="about-info-v font-mono">Darwin arm64 (Apple Silicon)</span>
                    </div>
                    <div className="about-info-row">
                      <span className="about-info-k">{t('settings.about.runtimeStack')}</span>
                      <span className="about-info-v font-mono">
                        Electron 35.7.5 · React 18 · TypeScript
                      </span>
                    </div>
                    <div className="about-info-row">
                      <span className="about-info-k">{t('settings.about.license')}</span>
                      <span className="about-info-v font-mono">
                        {t('settings.about.licenseVal')}
                      </span>
                    </div>
                    <div className="about-info-row">
                      <span className="about-info-k">{t('settings.about.copyright')}</span>
                      <span className="about-info-v font-mono">
                        {t('settings.about.copyrightVal')}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </main>
        </div>

        {/* 底部 Footer 统一保存栏 */}
        <div className="settings-footer-bar">
          <div className="footer-probe-zone">
            {probe && (
              <span className={`probe-status-text ${probe.startsWith('OK') ? 'is-ok' : 'is-fail'}`}>
                {probe.startsWith('OK') ? '✓ ' : '✕ '} {probe}
              </span>
            )}
          </div>
          <div className="footer-actions">
            <button
              type="button"
              className="probe-all-btn"
              onClick={() => void runProbe()}
              disabled={probing}
            >
              {probing ? t('common.probing') : t('common.probe')}
            </button>
            <button type="button" className="cancel-btn" onClick={onClose}>
              {t('common.close')}
            </button>
            <button type="button" className="primary save-all-btn" onClick={() => void save()}>
              {t('common.applySave')}
            </button>
          </div>
        </div>

        {/* 新版本确认弹窗 */}
        {pendingUpdate && (
          <div
            className="confirm-update-overlay"
            onClick={() => {
              if (!downloading) setPendingUpdate(null);
            }}
          >
            <div className="confirm-update-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="confirm-update-header">
                <div className="confirm-update-icon-wrap">
                  <svg
                    width="22"
                    height="22"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.85.83 6.72 2.24" />
                    <path d="M21 3v6h-6" />
                  </svg>
                </div>
                <div className="confirm-update-title-area">
                  <h3 className="confirm-update-title">{t('settings.update.confirmTitle')}</h3>
                  <div className="confirm-update-version-row">
                    <span className="confirm-update-new-badge">v{pendingUpdate.version}</span>
                    {pendingUpdate.current && (
                      <span className="confirm-update-current-text">
                        {t('settings.update.currentLabel')} v{pendingUpdate.current}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="confirm-update-body">
                <div className="confirm-update-notes-title">
                  {t('settings.update.notesTitle')}
                </div>
                {pendingUpdate.notes ? (
                  <div className="confirm-update-notes-box">{pendingUpdate.notes}</div>
                ) : (
                  <div className="confirm-update-notes-empty">{t('settings.update.noNotes')}</div>
                )}
              </div>

              <div className="confirm-update-footer">
                <button
                  type="button"
                  className="cancel-btn"
                  disabled={downloading}
                  onClick={() => setPendingUpdate(null)}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="primary save-all-btn"
                  style={{
                    background: 'linear-gradient(135deg, #2563eb, #3b82f6)',
                    color: '#fff',
                    padding: '6px 18px',
                    fontWeight: 600,
                  }}
                  disabled={downloading}
                  onClick={() => void confirmUpdate()}
                >
                  {downloading ? t('settings.update.downloading') : t('settings.update.confirmBtn')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 删除模型确认弹窗 */}
        {deletingModel && (
          <div className="confirm-delete-overlay" onClick={() => setDeletingModel(null)}>
            <div className="confirm-delete-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="confirm-delete-header">
                <div className="confirm-delete-icon">
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 6h18" />
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                    <line x1="10" y1="11" x2="10" y2="17" />
                    <line x1="14" y1="11" x2="14" y2="17" />
                  </svg>
                </div>
                <div className="confirm-delete-title-wrap">
                  <h3 className="confirm-delete-title">
                    {t('settings.models.confirmDeleteTitle')}
                  </h3>
                  <p className="confirm-delete-desc">
                    {t('settings.models.confirmDeleteDesc')}
                  </p>
                </div>
              </div>

              <div className="confirm-delete-card">
                <div className="confirm-delete-model-name">
                  <strong>{deletingModel.name}</strong>
                  <code className="model-id-code">{deletingModel.model}</code>
                </div>
                <div className="confirm-delete-endpoint">{deletingModel.baseUrl}</div>
                {(deletingModel.id === settings?.activeModelId || deletingModel.isDefault) && (
                  <div className="confirm-delete-warning">
                    {t('settings.models.confirmDeleteDefaultWarning')}
                  </div>
                )}
              </div>

              <div className="confirm-delete-actions">
                <button type="button" className="cancel-btn" onClick={() => setDeletingModel(null)}>
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="danger-confirm-btn"
                  onClick={() => {
                    handleDeleteModel(deletingModel.id);
                    setDeletingModel(null);
                  }}
                >
                  {t('settings.models.confirmDeleteBtn')}
                </button>
              </div>
            </div>
          </div>
        )}
        {/* MCP 服务器删除确认 */}
        {pendingMcpDelete && (
          <div className="confirm-delete-overlay" onClick={() => setPendingMcpDelete(null)}>
            <div className="confirm-delete-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="confirm-delete-header">
                <div className="confirm-delete-icon">
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 6h18" />
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                  </svg>
                </div>
                <div className="confirm-delete-title-wrap">
                  <h3 className="confirm-delete-title">
                    {t('settings.mcp.confirmDeleteTitle')}
                  </h3>
                  <p className="confirm-delete-desc">
                    {t('settings.mcp.confirmDeleteDesc')}
                  </p>
                </div>
              </div>

              <div className="confirm-delete-card">
                <div className="confirm-delete-model-name">
                  <strong>
                    {(settings?.mcpServers ?? []).find((s) => s.id === pendingMcpDelete)?.name}
                  </strong>
                  <code className="model-id-code">{pendingMcpDelete}</code>
                </div>
                <div className="confirm-delete-endpoint">
                  {(settings?.mcpServers ?? []).find((s) => s.id === pendingMcpDelete)?.command}
                </div>
              </div>

              <div className="confirm-delete-actions">
                <button type="button" className="cancel-btn" onClick={() => setPendingMcpDelete(null)}>
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="danger-confirm-btn"
                  onClick={() => void handleDeleteMcpServer(pendingMcpDelete)}
                >
                  {t('settings.mcp.confirmDeleteBtn')}
                </button>
              </div>
            </div>
          </div>
        )}
        {/* 右下角全向可拖拽调整手柄 */}
        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>,
    document.body,
  );
}
