import { useEffect, useState } from 'react';
import type { AppSettings, PermissionMode, SkillInfo, AiProvider, ModelProfile, ModelProviderType } from '@deepseek-ide/shared';
import { PERMISSION_MODE_LABELS, AI_PROVIDER_LABELS, DEFAULT_PROVIDERS, DEFAULT_MODELS } from '@deepseek-ide/shared';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: (settings: AppSettings) => void;
}

const PERMISSION_ORDER: PermissionMode[] = [
  'allow_all_extreme',
  'allow_all',
  'ask',
  'deny_all',
];

const PERMISSION_HINTS: Record<PermissionMode, string> = {
  allow_all_extreme: '写操作与终端自动放行，ask_user 也不弹窗。',
  allow_all: '写操作与终端自动放行，ask_user 仍会询问。',
  ask: '写操作与非只读终端需要确认后才会执行。',
  deny_all: '拦截全部工具调用，仅可查看不可修改。',
};

export function SettingsModal({ open, onClose, onSaved }: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [probe, setProbe] = useState<string>('');
  const [probing, setProbing] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsDir, setSkillsDir] = useState<string>('');
  // Multi-model management state
  const [editingModel, setEditingModel] = useState<ModelProfile | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [modelProbingId, setModelProbingId] = useState<string | null>(null);
  const [modelProbeResults, setModelProbeResults] = useState<Record<string, { ok: boolean; detail: string }>>({});

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
      label: '自定义 (OpenAI 兼容接口 / 本地 Ollama)',
      provider: 'custom',
      name: '本地 Ollama 模型',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3',
    },
  ];

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
    } catch (err) {
      setModelProbeResults((prev) => ({
        ...prev,
        [model.id]: { ok: false, detail: err instanceof Error ? err.message : String(err) },
      }));
    } finally {
      setModelProbingId(null);
    }
  }

  function handleSaveEditingModel(m: ModelProfile) {
    if (!settings) return;
    const exists = settings.models?.some((x) => x.id === m.id);
    let nextModels = settings.models || [];
    if (exists) {
      nextModels = nextModels.map((x) => (x.id === m.id ? m : x));
    } else {
      nextModels = [...nextModels, m];
    }
    // If set as default, update activeModelId and flags
    let activeId = settings.activeModelId;
    if (m.isDefault) {
      activeId = m.id;
      nextModels = nextModels.map((x) => ({ ...x, isDefault: x.id === m.id }));
    }
    setSettings({
      ...settings,
      models: nextModels,
      activeModelId: activeId,
      currentProvider: m.provider,
    });
    setEditingModel(null);
    setIsCreatingNew(false);
  }

  function handleDeleteModel(id: string) {
    if (!settings || (settings.models?.length || 0) <= 1) return;
    const nextModels = settings.models.filter((m) => m.id !== id);
    let nextActive = settings.activeModelId;
    if (nextActive === id) {
      nextActive = nextModels[0]?.id || '';
    }
    setSettings({
      ...settings,
      models: nextModels,
      activeModelId: nextActive,
    });
  }

  function handleSetDefaultModel(id: string) {
    if (!settings) return;
    const nextModels = settings.models.map((m) => ({
      ...m,
      isDefault: m.id === id,
    }));
    const target = settings.models.find((m) => m.id === id);
    setSettings({
      ...settings,
      models: nextModels,
      activeModelId: id,
      currentProvider: target?.provider || settings.currentProvider,
    });
  }

  useEffect(() => {
    if (!open) return;
    void window.ide.getSettings().then(setSettings);
    void window.ide.listSkills().then(setSkills);
    setProbe('');
  }, [open]);

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

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>设置</h2>
          <button type="button" className="settings-close-btn" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>

        <div className="settings-body">
          <section className="settings-section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <h3 style={{ margin: 0 }}>AI 模型管理</h3>
                <p className="muted" style={{ margin: '4px 0 0', fontSize: 11 }}>
                  可自由配置多个 GPT、DeepSeek、Claude 或本地 Ollama 兼容模型，并在聊天时随时切换
                </p>
              </div>
              <button
                type="button"
                className="primary"
                style={{ padding: '4px 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
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
                + 添加模型
              </button>
            </div>

            {/* Editing / Creating Model Form */}
            {editingModel && (
              <div className="model-edit-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <strong style={{ fontSize: 13, color: 'var(--accent)' }}>
                    {isCreatingNew ? '➕ 添加新 AI 模型' : `✎ 编辑模型: ${editingModel.name}`}
                  </strong>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>快捷预设:</span>
                    <select
                      style={{ fontSize: 11, padding: '2px 6px', background: 'var(--bg-input)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4 }}
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
                      <option value="" disabled>选择预设模板填充…</option>
                      {MODEL_PRESETS.map((p) => (
                        <option key={p.label} value={p.label}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="settings-grid-2">
                  <div className="settings-row">
                    <label>模型协议类型 (Provider)</label>
                    <select
                      value={editingModel.provider}
                      onChange={(e) => {
                        const p = e.target.value as ModelProviderType;
                        setEditingModel({ ...editingModel, provider: p });
                      }}
                    >
                      {(Object.keys(AI_PROVIDER_LABELS) as ModelProviderType[]).map((k) => (
                        <option key={k} value={k}>{AI_PROVIDER_LABELS[k]}</option>
                      ))}
                    </select>
                  </div>
                  <div className="settings-row">
                    <label>显示名称 (Display Name)</label>
                    <input
                      value={editingModel.name}
                      placeholder="如：DeepSeek (内网) / GPT-4o"
                      onChange={(e) => setEditingModel({ ...editingModel, name: e.target.value })}
                    />
                  </div>
                </div>

                <div className="settings-row">
                  <label>Base URL (接口地址)</label>
                  <input
                    className="mono-input"
                    value={editingModel.baseUrl}
                    placeholder="如：https://api.openai.com 或 http://192.168.10.241:8002"
                    onChange={(e) => setEditingModel({ ...editingModel, baseUrl: e.target.value })}
                  />
                </div>

                <div className="settings-grid-2">
                  <div className="settings-row">
                    <label>模型标识 (Model ID)</label>
                    <input
                      className="mono-input"
                      value={editingModel.model}
                      placeholder="如：gpt-4o, deepseek-v4-flash, claude-3-7-sonnet-20250219"
                      onChange={(e) => setEditingModel({ ...editingModel, model: e.target.value })}
                    />
                  </div>
                  <div className="settings-row">
                    <label>API Key</label>
                    <input
                      type="password"
                      className="mono-input"
                      value={editingModel.apiKey}
                      placeholder={editingModel.provider === 'deepseek' ? '内网或官方 API Key' : '必填 API Key'}
                      onChange={(e) => setEditingModel({ ...editingModel, apiKey: e.target.value })}
                    />
                  </div>
                </div>

                {(editingModel.provider === 'anthropic' || editingModel.model.includes('reasoner') || editingModel.model.includes('r1')) && (
                  <div className="settings-grid-2">
                    <div className="settings-row">
                      <label>深度思考 (Extended Thinking)</label>
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={editingModel.enableThinking !== false}
                          onChange={(e) => setEditingModel({ ...editingModel, enableThinking: e.target.checked })}
                        />
                        <span>启用深度思考</span>
                      </label>
                    </div>
                    <div className="settings-row">
                      <label>Thinking Tokens</label>
                      <input
                        type="number"
                        min="1000"
                        step="1000"
                        value={editingModel.thinkingTokens || 8000}
                        onChange={(e) => setEditingModel({ ...editingModel, thinkingTokens: Number(e.target.value) || 8000 })}
                      />
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                  <label className="checkbox-label" style={{ fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={editingModel.isDefault === true || settings.activeModelId === editingModel.id}
                      onChange={(e) => setEditingModel({ ...editingModel, isDefault: e.target.checked })}
                    />
                    <span>设为默认优先模型</span>
                  </label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      disabled={modelProbingId === editingModel.id}
                      onClick={() => void probeSingleModel(editingModel)}
                    >
                      {modelProbingId === editingModel.id ? '测试中…' : '⚡ 测试连通性'}
                    </button>
                    <button type="button" onClick={() => { setEditingModel(null); setIsCreatingNew(false); }}>
                      取消
                    </button>
                    <button type="button" className="primary" onClick={() => handleSaveEditingModel(editingModel)}>
                      保存此模型
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Models Cards List */}
            <div className="model-cards-list">
              {(settings.models || []).map((m) => {
                const isActive = settings.activeModelId === m.id || m.isDefault;
                const probeRes = modelProbeResults[m.id];
                const isProbing = modelProbingId === m.id;
                return (
                  <div key={m.id} className={`model-card-item ${isActive ? 'active' : ''}`}>
                    <div className="model-card-main">
                      <div className="model-card-header-row">
                        <span className={`model-tag ${m.provider}`}>
                          {m.provider === 'anthropic' ? 'Claude' : m.provider === 'deepseek' ? 'DeepSeek' : m.provider === 'openai' ? 'OpenAI' : '自定义'}
                        </span>
                        <strong className="model-card-title">{m.name}</strong>
                        {isActive && <span className="default-badge">★ 默认选中</span>}
                      </div>
                      <div className="model-card-sub-row">
                        <span className="model-code-badge">{m.model}</span>
                        <span className="model-url-text" title={m.baseUrl}>{m.baseUrl}</span>
                        {m.apiKey ? <span className="key-set-badge">已设 Key</span> : <span className="key-missing-badge">未设 Key</span>}
                      </div>
                      {probeRes && (
                        <div className={`model-probe-badge ${probeRes.ok ? 'ok' : 'err'}`}>
                          {probeRes.ok ? '✓ 连通正常' : `✕ 连通失败: ${probeRes.detail}`}
                        </div>
                      )}
                    </div>
                    <div className="model-card-actions">
                      <button
                        type="button"
                        className="model-action-btn"
                        title="测试此模型接口连通性"
                        disabled={isProbing}
                        onClick={() => void probeSingleModel(m)}
                      >
                        {isProbing ? '…' : '⚡ 探测'}
                      </button>
                      {!isActive && (
                        <button
                          type="button"
                          className="model-action-btn"
                          title="设为此 IDE 的默认模型"
                          onClick={() => handleSetDefaultModel(m.id)}
                        >
                          ★ 设为默认
                        </button>
                      )}
                      <button
                        type="button"
                        className="model-action-btn"
                        title="编辑模型参数"
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
                          className="model-action-btn danger"
                          title="删除此模型"
                          onClick={() => handleDeleteModel(m.id)}
                        >
                          🗑
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="settings-section">
            <h3>运行参数</h3>
            <div className="settings-grid-2">
              <div className="settings-row">
                <label>Temperature</label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={settings.temperature}
                  onChange={(e) =>
                    setSettings({ ...settings, temperature: Number(e.target.value) || 0 })
                  }
                />
              </div>
              <div className="settings-row">
                <label>Max Agent Steps</label>
                <input
                  type="number"
                  min="1"
                  value={settings.maxAgentSteps}
                  onChange={(e) =>
                    setSettings({ ...settings, maxAgentSteps: Number(e.target.value) || 50 })
                  }
                />
              </div>
            </div>
            <div className="settings-row">
              <label>上下文窗口（tokens）</label>
              <input
                type="number"
                min="1000"
                step="1000"
                value={settings.contextWindowTokens}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    contextWindowTokens: Number(e.target.value) || 128000,
                  })
                }
              />
            </div>
          </section>

          <section className="settings-section">
            <h3>界面与行为</h3>
            <div className="settings-grid-2">
              <div className="settings-row">
                <label>界面主题</label>
                <select
                  value={settings.theme}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      theme: e.target.value as 'dark' | 'light',
                    })
                  }
                >
                  <option value="dark">深色 Dark</option>
                  <option value="light">浅色 Light · TSINGTEC</option>
                </select>
              </div>
              <div className="settings-row">
                <label>工具权限</label>
                <select
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
              </div>
            </div>
            <p className="settings-inline-hint">{PERMISSION_HINTS[settings.permissionMode]}</p>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={settings.autoSave === true}
                onChange={(e) => setSettings({ ...settings, autoSave: e.target.checked })}
              />
              编辑后自动写入磁盘（约 0.8 秒）
            </label>
          </section>

          <section className="settings-section">
            <h3>Skills</h3>
            <p className="muted">
              工作区：<code>.cursor/skills/*/SKILL.md</code> 或{' '}
              <code>.deepseek/skills/*/SKILL.md</code>
              <br />
              用户目录：<code>userData/skills/*/SKILL.md</code>（兼容 Cursor frontmatter）
            </p>
            <div className="settings-row-inline">
              <button type="button" onClick={() => void openSkills()}>
                打开用户 Skills 文件夹
              </button>
              {skillsDir && <span className="muted">{skillsDir}</span>}
            </div>
            {skills.length === 0 ? (
              <div className="muted">当前未发现 skills</div>
            ) : (
              <ul className="skills-list">
                {skills.map((s) => (
                  <li key={s.path}>
                    <strong>{s.name}</strong> <span className="muted">({s.source})</span>
                    <div className="muted">{s.description || s.path}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="settings-footer">
          {probe && (
            <div className={probe.startsWith('OK') ? 'probe-ok' : 'probe-fail'}>{probe}</div>
          )}
          <div className="settings-actions">
            <button onClick={() => void runProbe()} disabled={probing}>
              {probing ? '探测中…' : '探测模型'}
            </button>
            <button onClick={onClose}>取消</button>
            <button className="primary" onClick={() => void save()}>
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
