import { useEffect, useState } from 'react';
import type {
  AppSettings,
  PermissionMode,
  SkillInfo,
  AiProvider,
  ModelProfile,
  ModelProviderType,
  UpdateFeedConfig,
} from '@deepseek-ide/shared';
import {
  PERMISSION_MODE_LABELS,
  AI_PROVIDER_LABELS,
  DEFAULT_PROVIDERS,
  DEFAULT_MODELS,
} from '@deepseek-ide/shared';
import { useI18n } from '../i18n';

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
}

const PERMISSION_ORDER: PermissionMode[] = ['allow_all_extreme', 'allow_all', 'ask', 'deny_all'];

const PERMISSION_HINTS: Record<PermissionMode, string> = {
  allow_all_extreme: '写操作与终端自动放行，ask_user 也不弹窗。',
  allow_all: '写操作与终端自动放行，ask_user 仍会询问。',
  ask: '写操作与非只读终端需要确认后才会执行。',
  deny_all: '拦截全部工具调用，仅可查看不可修改。',
};

export function SettingsModal({ open, onClose, onSaved, onShowToast }: Props) {
  const { locale, t, setLocale } = useI18n();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [probe, setProbe] = useState<string>('');
  const [probing, setProbing] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsDir, setSkillsDir] = useState<string>('');
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
    label: string;
    provider: ModelProviderType;
    name: string;
    baseUrl: string;
    model: string;
    enableThinking?: boolean;
    thinkingTokens?: number;
  }> = [
    {
      label: 'DeepSeek (内网部署)',
      provider: 'deepseek',
      name: 'DeepSeek (内网)',
      baseUrl: 'http://192.168.10.241:8002',
      model: 'deepseek-v4-flash',
    },
    {
      label: 'DeepSeek (官方 API)',
      provider: 'deepseek',
      name: 'DeepSeek Chat (官方)',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    },
    {
      label: 'DeepSeek Reasoner (R1 推理)',
      provider: 'deepseek',
      name: 'DeepSeek R1 (推理)',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-reasoner',
    },
    {
      label: 'OpenAI (GPT-4o)',
      provider: 'openai',
      name: 'GPT-4o',
      baseUrl: 'https://api.openai.com',
      model: 'gpt-4o',
    },
    {
      label: 'OpenAI (GPT-4o-mini 极速)',
      provider: 'openai',
      name: 'GPT-4o-mini',
      baseUrl: 'https://api.openai.com',
      model: 'gpt-4o-mini',
    },
    {
      label: 'Claude 3.7 Sonnet (Anthropic)',
      provider: 'anthropic',
      name: 'Claude 3.7 Sonnet',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-3-7-sonnet-20250219',
      enableThinking: true,
      thinkingTokens: 8000,
    },
    {
      label: 'Claude 3.5 Haiku',
      provider: 'anthropic',
      name: 'Claude 3.5 Haiku',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-3-5-haiku-20241022',
    },
    {
      label: 'AgentRouter (Claude 协议代理 / glm-5.3)',
      provider: 'anthropic',
      name: 'Claude 3.7 (AgentRouter)',
      baseUrl: 'https://agentrouter.org',
      model: 'glm-5.3',
      enableThinking: true,
      thinkingTokens: 8000,
    },
    {
      label: '自定义 (OpenAI 兼容接口 / 本地 Ollama)',
      provider: 'custom',
      name: '本地 Ollama 模型',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3',
    },
  ];

  // Tab state
  const [activeTab, setActiveTab] = useState<
    'models' | 'runtime' | 'general' | 'skills' | 'update'
  >('models');
  const [showApiKey, setShowApiKey] = useState(false);

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
        if (pendingUpdate && !downloading) {
          setPendingUpdate(null);
          return;
        }
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose, deletingModel, pendingUpdate, downloading]);

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
      setUpdateMsg({ type: 'error', text: res.detail || '下载失败' });
      setDownloading(false);
    }
    // 成功时主进程会退出应用，无需处理
  }

  /** 返回一个非空的 updateFeed，避免 spread undefined 导致类型不完整。 */
  function feedWith(patch: Partial<UpdateFeedConfig>): UpdateFeedConfig {
    const base: UpdateFeedConfig = settings?.updateFeed ?? { provider: 'github' };
    return { ...base, ...patch };
  }

  return (
    <div className="settings-overlay">
      <div className="settings-modal modern-settings" onClick={(e) => e.stopPropagation()}>
        {/* 顶部标题栏 */}
        <div className="settings-header">
          <div className="settings-header-left">
            <div className="settings-logo-pill">Echoly</div>
            <h2>{t('settings.title')}</h2>
          </div>
          <button
            type="button"
            className="settings-close-btn"
            onClick={onClose}
            title={t('common.close')}
          >
            ✕
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
                <span className="nav-title">Skills 技能库</span>
                <span className="nav-sub">Cursor / 本地技能</span>
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
          </aside>

          {/* 右侧面板内容 */}
          <main className="settings-content">
            {/* 1. AI 模型配置 Tab */}
            {activeTab === 'models' && (
              <div className="settings-panel-section">
                <div className="panel-title-bar">
                  <div>
                    <h3 className="panel-h3">AI 模型管理与端点</h3>
                    <p className="panel-desc">
                      支持 DeepSeek、Claude、OpenAI (GPT) 及本地 Ollama
                      兼容端点，随时在聊天中按需切换。
                    </p>
                  </div>
                  <button
                    type="button"
                    className="add-model-btn"
                    onClick={() => {
                      setEditingModel({
                        id: `model_${Date.now()}`,
                        name: '新模型',
                        provider: 'deepseek',
                        baseUrl: 'http://192.168.10.241:8002',
                        model: 'deepseek-v4-flash',
                        apiKey: '',
                      });
                      setIsCreatingNew(true);
                    }}
                  >
                    + 添加新模型
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
                              {isNew ? '配置新 AI 模型' : `编辑模型: ${editingModel.name}`}
                            </strong>
                            {((modelProbeResults[editingModel.id]?.ok) ||
                              (!modelProbeResults[editingModel.id] && editingModel.lastProbeOk)) && (
                              <span className="connected-pill" title="端点连通性测试正常">
                                <span className="status-dot" /> 连通正常
                              </span>
                            )}
                          </div>
                          <div className="preset-quick-select">
                            <span className="preset-label">快速套用预设:</span>
                            <select
                              className="preset-select"
                              onChange={(e) => {
                                const preset = MODEL_PRESETS.find((p) => p.label === e.target.value);
                                if (preset) {
                                  setEditingModel({
                                    ...editingModel,
                                    provider: preset.provider,
                                    name: preset.name,
                                    baseUrl: preset.baseUrl,
                                    model: preset.model,
                                    enableThinking: preset.enableThinking,
                                    thinkingTokens: preset.thinkingTokens,
                                  });
                                }
                              }}
                              defaultValue=""
                            >
                              <option value="" disabled>
                                选择预设模板填充…
                              </option>
                              {MODEL_PRESETS.map((p) => (
                                <option key={p.label} value={p.label}>
                                  {p.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>

                        <div className="settings-grid-2">
                          <div className="settings-row">
                            <label>协议类型 (Provider)</label>
                            <select
                              className="modern-select"
                              value={editingModel.provider}
                              onChange={(e) => {
                                const p = e.target.value as ModelProviderType;
                                setEditingModel({ ...editingModel, provider: p });
                              }}
                            >
                              {(Object.keys(AI_PROVIDER_LABELS) as ModelProviderType[]).map((k) => (
                                <option key={k} value={k}>
                                  {AI_PROVIDER_LABELS[k]}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="settings-row">
                            <label>显示别名 (Display Name)</label>
                            <input
                              className="modern-input"
                              value={editingModel.name}
                              placeholder="例如：DeepSeek (内网) 或 GPT-4o"
                              onChange={(e) =>
                                setEditingModel({ ...editingModel, name: e.target.value })
                              }
                            />
                          </div>
                        </div>

                        <div className="settings-row">
                          <label>API 接口地址 (Base URL)</label>
                          <input
                            className="modern-input mono-font"
                            value={editingModel.baseUrl}
                            placeholder="例如：https://api.deepseek.com 或 http://192.168.10.241:8002"
                            onChange={(e) =>
                              setEditingModel({ ...editingModel, baseUrl: e.target.value })
                            }
                          />
                        </div>

                        <div className="settings-grid-2">
                          <div className="settings-row">
                            <label>模型标识 (Model ID)</label>
                            <input
                              className="modern-input mono-font"
                              value={editingModel.model}
                              placeholder="如 deepseek-v4-flash, gpt-4o, claude-3-7-sonnet"
                              onChange={(e) =>
                                setEditingModel({ ...editingModel, model: e.target.value })
                              }
                            />
                          </div>
                          <div className="settings-row">
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                              }}
                            >
                              <label>API Key</label>
                              <button
                                type="button"
                                className="toggle-eye-btn"
                                onClick={() => setShowApiKey(!showApiKey)}
                              >
                                {showApiKey ? '隐藏 Key' : '显示 Key'}
                              </button>
                            </div>
                            <input
                              type={showApiKey ? 'text' : 'password'}
                              className="modern-input mono-font"
                              value={editingModel.apiKey || ''}
                              placeholder={
                                editingModel.provider === 'deepseek'
                                  ? '内网可留空，官方 API 必填'
                                  : '填入对应的 API Key（留空即免鉴权）'
                              }
                              onChange={(e) =>
                                setEditingModel({ ...editingModel, apiKey: e.target.value })
                              }
                            />
                          </div>
                        </div>

                        <div className="settings-grid-2 thinking-config-row">
                          <div className="settings-row">
                            <label>深度思考模式 (Extended Thinking)</label>
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
                              <span>启用推理思考过程输出</span>
                            </label>
                          </div>
                          {editingModel.enableThinking && (
                            <div className="settings-row">
                              <label>Thinking Tokens 上限</label>
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

                        {/* 编辑卡片内的即时连通性测试反馈 */}
                        {(modelProbingId === editingModel.id ||
                          modelProbeResults[editingModel.id] ||
                          editingModel.lastProbeOk) && (
                          <div
                            className={`probe-result-bubble ${
                              modelProbingId === editingModel.id
                                ? 'probe-testing'
                                : (modelProbeResults[editingModel.id]?.ok ?? editingModel.lastProbeOk)
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
                                : (modelProbeResults[editingModel.id]?.ok ?? editingModel.lastProbeOk)
                                  ? '✓'
                                  : '✕'}
                            </span>
                            <span className="probe-text" style={{ wordBreak: 'break-all' }}>
                              {modelProbingId === editingModel.id
                                ? '正在进行端点连通性探测，请稍候…'
                                : (modelProbeResults[editingModel.id]?.ok ?? editingModel.lastProbeOk)
                                  ? `连通性正常: ${modelProbeResults[editingModel.id]?.detail || '端点连接畅通'}`
                                  : `连通性异常: ${modelProbeResults[editingModel.id]?.detail || '连接失败'}`}
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
                            <span>设为当前默认优先模型</span>
                          </label>
                          <div className="edit-btn-group">
                            <button
                              type="button"
                              className="test-btn"
                              disabled={modelProbingId === editingModel.id}
                              onClick={() => void probeSingleModel(editingModel)}
                            >
                              {modelProbingId === editingModel.id ? '正在连接测试…' : '⚡ 连通性测试'}
                            </button>
                            <button
                              type="button"
                              className="cancel-btn"
                              onClick={() => {
                                setEditingModel(null);
                                setIsCreatingNew(false);
                              }}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className="primary save-model-btn"
                              onClick={() => handleSaveEditingModel(editingModel)}
                            >
                              保存配置
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
                              className={`modern-model-card ${isActive ? 'is-active' : ''}`}
                            >
                        <div className="model-card-left">
                          <div className={`model-provider-badge prov-${m.provider}`}>
                            {m.provider === 'anthropic'
                              ? 'Claude'
                              : m.provider === 'deepseek'
                                ? 'DeepSeek'
                                : m.provider === 'openai'
                                  ? 'OpenAI'
                                  : 'Ollama / 自定义'}
                          </div>
                          <div className="model-info-block">
                            <div className="model-name-line">
                              <span className="model-display-name" title={m.name}>{m.name}</span>
                              {isActive && <span className="active-glow-pill">★ 默认选中</span>}
                              {((probeRes && probeRes.ok) || (!probeRes && m.lastProbeOk)) && (
                                <span className="connected-pill" title="端点连通性测试正常">
                                  <span className="status-dot" /> 连通正常
                                </span>
                              )}
                              {probeRes && !probeRes.ok && (
                                <span className="probe-fail-pill" title={`探测异常: ${probeRes.detail || '端点连接失败'}`}>
                                  ✕ 连通异常
                                </span>
                              )}
                              {m.enableThinking && (
                                <span className="thinking-pill">⚡ 深度思考</span>
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
                                <span className="key-state has-key">已配置密钥</span>
                              ) : (
                                <span className="key-state no-key">免密钥/未配置</span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="model-card-right-column">
                          {/* 右上角默认模型开关 */}
                          <div className="model-card-top-right">
                            <label
                              className={`model-default-switch ${isActive ? 'is-active' : ''}`}
                              title={isActive ? '当前默认优先模型' : '点击设为默认模型'}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!isActive) handleSetDefaultModel(m.id);
                              }}
                            >
                              <span className="switch-text">{isActive ? '默认模型' : '设为默认'}</span>
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
                              title="上移排序"
                              disabled={mIdx === 0}
                              onClick={() => handleMoveModel(m.id, 'up')}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="card-action-btn move-btn"
                              title="下移排序"
                              disabled={mIdx === (settings.models?.length || 0) - 1}
                              onClick={() => handleMoveModel(m.id, 'down')}
                            >
                              ↓
                            </button>

                            <button
                              type="button"
                              className="card-action-btn probe-btn"
                              title="连通性探测"
                              disabled={isProbing}
                              onClick={() => void probeSingleModel(m)}
                            >
                              {isProbing ? '探测中…' : '⚡ 探测'}
                            </button>
                            <button
                              type="button"
                              className="card-action-btn edit-btn"
                              title="编辑此模型参数"
                              onClick={() => {
                                setEditingModel({ ...m });
                                setIsCreatingNew(false);
                              }}
                            >
                              ✎ 编辑
                            </button>
                            {(settings.models?.length || 0) > 1 && (
                              <button
                                type="button"
                                className="card-action-btn delete-btn"
                                title="删除此模型"
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
                    <h3 className="panel-h3">运行与推理参数</h3>
                    <p className="panel-desc">
                      精细调节模型生成多样性、Agent 自主执行深度及上下文记忆容量。
                    </p>
                  </div>
                </div>

                <div className="modern-card-group">
                  <div className="setting-card">
                    <div className="setting-card-title">
                      <strong>采样温度 (Temperature)</strong>
                      <span className="card-current-val">{settings.temperature}</span>
                    </div>
                    <p className="setting-card-desc">
                      控制输出的随机性。数值越小越精确严谨（建议编程设为 0.0 - 0.2）。
                    </p>
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
                      <strong>Max Agent Steps (自主执行步数上限)</strong>
                      <span className="card-current-val">{settings.maxAgentSteps} 步</span>
                    </div>
                    <p className="setting-card-desc">
                      单次任务中 AI 连续执行工具（读写文件、运行命令）的最大循环次数。
                    </p>
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
                      <strong>上下文窗口容量 (Context Window Tokens)</strong>
                      <span className="card-current-val">
                        {settings.contextWindowTokens.toLocaleString()} tokens
                      </span>
                    </div>
                    <p className="setting-card-desc">
                      超出此限制将自动进行会话历史精简压缩，防止请求超出模型容量限制。
                    </p>
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
                </div>
              </div>
            )}

            {/* 3. 外观与权限 Tab */}
            {activeTab === 'general' && (
              <div className="settings-panel-section">
                <div className="panel-title-bar">
                  <div>
                    <h3 className="panel-h3">外观与工作流权限</h3>
                    <p className="panel-desc">
                      设置 IDE 视觉主题、自动保存以及 AI 工具调用执行时的授权安全策略。
                    </p>
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

                  <div className="setting-card">
                    <div className="setting-card-title">
                      <strong>工具执行安全策略 (Permission Mode)</strong>
                    </div>
                    <p className="setting-card-desc">
                      控制 AI 在尝试修改本地代码或在终端执行命令时的放行准则。
                    </p>
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
                          {PERMISSION_MODE_LABELS[m]}
                        </option>
                      ))}
                    </select>
                    <div className="perm-hint-bubble">
                      ℹ️ {PERMISSION_HINTS[settings.permissionMode]}
                    </div>
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
                      <span>代码编辑自动保存到磁盘 (编辑停止约 0.8 秒后写入)</span>
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
                      <span>光标所在行常驻显示 Git Blame (提交人、时间与提交摘要)</span>
                    </label>
                  </div>

                  <div className="setting-card" style={{ marginTop: 12 }}>
                    <div className="setting-card-title">
                      <strong>{t('settings.hoverDelay')}</strong>
                    </div>
                    <p className="setting-card-desc">
                      {t('settings.hoverDelayDesc')}
                    </p>
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
                      <span style={{ fontSize: 13, color: 'var(--muted)' }}>毫秒 (ms)</span>
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
                        onChange={(e) => setSettings({ ...settings, selectionAiFloat: e.target.checked })}
                      />
                      <span>{t('settings.selectionAiFloat')}</span>
                    </label>
                  </div>
                </div>
              </div>
            )}

            {/* 4. Skills 扩展库 Tab */}
            {activeTab === 'skills' && (
              <div className="settings-panel-section">
                <div className="panel-title-bar">
                  <div>
                    <h3 className="panel-h3">Skills 技能扩展库</h3>
                    <p className="panel-desc">
                      兼容 Cursor frontmatter 技能协议，赋予 AI 专属的代码生成与工程工作流能力。
                    </p>
                  </div>
                  <button
                    type="button"
                    className="open-skills-btn"
                    onClick={() => void openSkills()}
                  >
                    📂 打开用户 Skills 目录
                  </button>
                </div>

                {skillsDir && (
                  <div className="skills-dir-badge">
                    <span>用户技能路径:</span>
                    <code>{skillsDir}</code>
                  </div>
                )}

                {skills.length === 0 ? (
                  <div className="skills-empty-state">
                    <span className="empty-icon">🧩</span>
                    <p>当前未发现已安装的 Skills</p>
                    <span className="empty-sub">
                      可将技能放置在 <code>.cursor/skills/*/SKILL.md</code> 或{' '}
                      <code>.deepseek/skills/*/SKILL.md</code>
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
                      <option value="generic">自建服务器 (Generic)</option>
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
            <div
              className="confirm-update-dialog"
              onClick={(e) => e.stopPropagation()}
            >
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
                <div className="confirm-update-notes-title">更新说明 (Release Notes)</div>
                {pendingUpdate.notes ? (
                  <div className="confirm-update-notes-box">
                    {pendingUpdate.notes}
                  </div>
                ) : (
                  <div className="confirm-update-notes-empty">
                    {t('settings.update.noNotes')}
                  </div>
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
          <div
            className="confirm-delete-overlay"
            onClick={() => setDeletingModel(null)}
          >
            <div
              className="confirm-delete-dialog"
              onClick={(e) => e.stopPropagation()}
            >
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
                  <h3 className="confirm-delete-title">确认删除此模型配置？</h3>
                  <p className="confirm-delete-desc">
                    删除后该模型将无法在对话中继续使用，此操作无法撤销。
                  </p>
                </div>
              </div>

              <div className="confirm-delete-card">
                <div className="confirm-delete-model-name">
                  <strong>{deletingModel.name}</strong>
                  <code className="model-id-code">{deletingModel.model}</code>
                </div>
                <div className="confirm-delete-endpoint">
                  {deletingModel.baseUrl}
                </div>
                {(deletingModel.id === settings?.activeModelId || deletingModel.isDefault) && (
                  <div className="confirm-delete-warning">
                    ⚠️ 当前模型为默认优先模型，删除后将自动将其他模型设为默认。
                  </div>
                )}
              </div>

              <div className="confirm-delete-actions">
                <button
                  type="button"
                  className="cancel-btn"
                  onClick={() => setDeletingModel(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="danger-confirm-btn"
                  onClick={() => {
                    handleDeleteModel(deletingModel.id);
                    setDeletingModel(null);
                  }}
                >
                  确认删除
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
