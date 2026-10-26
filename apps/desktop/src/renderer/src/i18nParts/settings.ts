/**
 * 偏好设置弹窗（SettingsModal）的文案分片。
 *
 * 主表 CORE_DICT 里已有的 `settings.nav.*` / `settings.permission` / `settings.about.*`
 * 等骨架期 key 直接沿用，这里只放铺开过程中新翻的条目 —— 重复定义会被
 * `test/i18n.test.ts` 的「分片之间没有重复 key」抓出来。
 *
 * 凡是「模型预设名 / 档位名」这类**给用户看的标签**都在这里给出中英两版；
 * 模型 id（`deepseek-v4.1-flash`）、协议字段名（`reasoning_effort`、`chat_template_kwargs`）、
 * `<option value=...>` 的取值（`generic` / `write` / `readonly`）都不翻。
 */
export const settingsDict: Record<string, { zh: string; en: string }> = {
  // ── 左侧导航（主表已有 models / runtime / general / skills / update / about） ──
  'settings.nav.buildEnv': { zh: '构建与运行环境', en: 'Build & Runtime' },
  'settings.nav.buildEnvDesc': { zh: 'Java (JDK) / Maven 配置', en: 'Java (JDK) / Maven' },
  'settings.nav.mcp': { zh: 'MCP 服务器', en: 'MCP Servers' },
  'settings.nav.mcpDesc': { zh: '接入外部工具', en: 'Connect external tools' },

  // ── 通用小件 ──
  'settings.closeEsc': { zh: '关闭 (Esc)', en: 'Close (Esc)' },

  // ── 权限档位标签（packages/shared 的 PERMISSION_MODE_LABELS 是中文常量，这里给本地翻译） ──
  'settings.permLabel.allow_all_extreme': { zh: '允许所有操作·极', en: 'Allow All · Extreme' },
  'settings.permLabel.allow_all': { zh: '允许所有操作', en: 'Allow All' },
  'settings.permLabel.ask': { zh: '询问后允许', en: 'Ask First' },
  'settings.permLabel.deny_all': { zh: '不允许任何操作', en: 'Deny All' },
  // 档位说明：整句进字典，不拼接（中英文语序不同）
  'settings.permHint.allow_all_extreme': {
    zh: '写操作与终端自动放行，ask_user 也不弹窗。',
    en: 'Writes and terminal commands run without approval, and ask_user does not prompt either.',
  },
  'settings.permHint.allow_all': {
    zh: '写操作与终端自动放行，ask_user 仍会询问。',
    en: 'Writes and terminal commands run without approval, but ask_user still prompts.',
  },
  'settings.permHint.ask': {
    zh: '写操作与非只读终端需要确认后才会执行。',
    en: 'Writes and non-read-only terminal commands require confirmation before running.',
  },
  'settings.permHint.deny_all': {
    zh: '拦截全部工具调用，仅可查看不可修改。',
    en: 'Blocks every tool call — read-only viewing, no modifications.',
  },

  // ── 协议类型标签（AI_PROVIDER_LABELS 同为中文常量） ──
  'settings.providerLabel.deepseek': { zh: 'DeepSeek', en: 'DeepSeek' },
  'settings.providerLabel.openai': { zh: 'OpenAI', en: 'OpenAI' },
  'settings.providerLabel.anthropic': { zh: 'Claude (Anthropic)', en: 'Claude (Anthropic)' },
  'settings.providerLabel.custom': { zh: '自定义 (OpenAI 兼容)', en: 'Custom (OpenAI-compatible)' },

  // ── 思考档位标签（REASONING_EFFORT_LABELS，值 none/low/high/xhigh/max 不翻） ──
  'settings.effortLabel.none': { zh: '关闭思考', en: 'Thinking off' },
  'settings.effortLabel.low': { zh: '低', en: 'Low' },
  'settings.effortLabel.high': { zh: '高', en: 'High' },
  'settings.effortLabel.xhigh': { zh: '极高', en: 'Very high' },
  'settings.effortLabel.max': { zh: '最大', en: 'Max' },

  // ── AI 模型配置 Tab ──
  'settings.models.title': { zh: 'AI 模型管理与端点', en: 'AI Models & Endpoints' },
  'settings.models.desc': {
    zh: '支持 DeepSeek、Claude、OpenAI (GPT) 及本地 Ollama 兼容端点，随时在聊天中按需切换。',
    en: 'Supports DeepSeek, Claude, OpenAI (GPT) and local Ollama-compatible endpoints — switch any time in chat.',
  },
  'settings.models.add': { zh: '+ 添加新模型', en: '+ Add Model' },
  'settings.models.newTitle': { zh: '配置新 AI 模型', en: 'Configure a New AI Model' },
  'settings.models.editTitle': { zh: '编辑模型: {name}', en: 'Edit model: {name}' },
  'settings.models.newModelName': { zh: '新模型', en: 'New Model' },
  'settings.models.connected': { zh: '连通正常', en: 'Connected' },
  'settings.models.probeOkTitle': {
    zh: '端点连通性测试正常',
    en: 'Endpoint connectivity test passed',
  },
  'settings.models.quickPreset': { zh: '快速套用预设:', en: 'Quick presets:' },
  'settings.models.presetPlaceholder': { zh: '选择预设模板填充…', en: 'Pick a preset to fill in…' },
  'settings.models.basicInfo': { zh: '基础信息', en: 'Basics' },
  'settings.models.provider': { zh: '协议类型 (Provider)', en: 'Provider Protocol' },
  'settings.models.displayName': { zh: '显示别名 (Display Name)', en: 'Display Name' },
  'settings.models.displayNamePh': {
    zh: '例如：DeepSeek (内网) 或 GPT-4o',
    en: 'e.g. DeepSeek (Intranet) or GPT-4o',
  },
  'settings.models.endpointSection': { zh: '端点与鉴权', en: 'Endpoint & Auth' },
  'settings.models.baseUrl': { zh: 'API 接口地址 (Base URL)', en: 'API Base URL' },
  'settings.models.baseUrlPh': {
    zh: '例如：https://api.deepseek.com 或 http://192.168.10.241:8002',
    en: 'e.g. https://api.deepseek.com or http://192.168.10.241:8002',
  },
  'settings.models.modelId': { zh: '模型标识 (Model ID)', en: 'Model ID' },
  'settings.models.modelIdPh': {
    zh: '如 deepseek-v4.1-flash, gpt-4o',
    en: 'e.g. deepseek-v4.1-flash, gpt-4o',
  },
  'settings.models.hideKey': { zh: '隐藏 Key', en: 'Hide Key' },
  'settings.models.showKey': { zh: '显示 Key', en: 'Show Key' },
  'settings.models.keyPhInternal': {
    zh: '内网可留空，官方 API 必填',
    en: 'Optional on the intranet, required for the official API',
  },
  'settings.models.keyPhGeneric': {
    zh: '填入对应的 API Key（留空即免鉴权）',
    en: 'Enter the matching API Key (leave empty for no auth)',
  },
  'settings.models.thinkingSection': { zh: '思考深度', en: 'Thinking Depth' },
  'settings.models.extendedThinking': {
    zh: '深度思考模式 (Extended Thinking)',
    en: 'Extended Thinking',
  },
  'settings.models.enableThinkingOutput': {
    zh: '启用推理思考过程输出',
    en: 'Emit the reasoning process',
  },
  'settings.models.thinkingTokens': { zh: 'Thinking Tokens 预算', en: 'Thinking Tokens Budget' },
  'settings.models.reasoningEffort': { zh: '思考档位 (Reasoning Effort)', en: 'Reasoning Effort' },
  'settings.models.reasoningDefault': {
    zh: '默认（不发送，沿用服务端档位）',
    en: 'Default (not sent — keep the server-side level)',
  },
  'settings.models.fineEffort': { zh: '细粒度档位', en: 'Fine-grained Level' },
  'settings.models.fineEffortHint': {
    zh: '1–100，留空则不启用',
    en: '1–100; leave empty to disable',
  },
  'settings.models.leaveEmpty': { zh: '留空', en: 'Leave empty' },
  'settings.models.thinkingBudget': { zh: '思考 Token 硬上限', en: 'Thinking Token Hard Cap' },
  'settings.models.thinkingBudgetHint': {
    zh: '截断而非缩放，0 = 不限制',
    en: 'Truncates rather than scales; 0 = no limit',
  },
  'settings.models.effortNote': { zh: '档位说明', en: 'Level Notes' },
  'settings.models.effortNoteText': {
    zh: '内网 DeepSeek-V4.1 只认 none / low / high / xhigh / max',
    en: 'Intranet DeepSeek-V4.1 only accepts none / low / high / xhigh / max',
  },
  'settings.models.fineEffortDesc': {
    zh: '细粒度档位与上面的档位是同一个旋钮，填了就优先用它（走 chat_template_kwargs）；硬上限则是独立的截断阀门，可与两者共存。',
    en: 'The fine-grained level is the same knob as the level above — when filled it takes precedence (sent via chat_template_kwargs). The hard cap is a separate truncation valve and can coexist with either.',
  },
  'settings.models.probingEndpoint': {
    zh: '正在进行端点连通性探测，请稍候…',
    en: 'Testing endpoint connectivity, please wait…',
  },
  'settings.models.probeOkDetail': { zh: '连通性正常: {detail}', en: 'Connectivity OK: {detail}' },
  'settings.models.probeOkDefault': { zh: '端点连接畅通', en: 'endpoint reachable' },
  'settings.models.probeFailDetail': {
    zh: '连通性异常: {detail}',
    en: 'Connectivity failed: {detail}',
  },
  'settings.models.probeFailDefault': { zh: '连接失败', en: 'connection failed' },
  'settings.models.probeErrorTitle': { zh: '探测异常: {detail}', en: 'Probe failed: {detail}' },
  'settings.models.probeErrorDefault': { zh: '端点连接失败', en: 'endpoint unreachable' },
  'settings.models.connectAbnormal': { zh: '✕ 连通异常', en: '✕ Not connected' },
  'settings.models.deepThinking': { zh: '⚡ 深度思考', en: '⚡ Deep thinking' },
  'settings.models.effortTitle': {
    zh: '思考深度档位（reasoning_effort）',
    en: 'Thinking depth level (reasoning_effort)',
  },
  'settings.models.fineEffortValue': { zh: '细粒度 {n}', en: 'Fine {n}' },
  'settings.models.keyConfigured': { zh: '已配置密钥', en: 'Key configured' },
  'settings.models.keyNone': { zh: '免密钥/未配置', en: 'No key / not set' },
  'settings.models.setAsDefaultCheckbox': {
    zh: '设为当前默认优先模型',
    en: 'Set as the current default model',
  },
  'settings.models.testing': { zh: '正在连接测试…', en: 'Testing connection…' },
  'settings.models.testConnectivity': { zh: '⚡ 连通性测试', en: '⚡ Test connectivity' },
  'settings.models.saveConfig': { zh: '保存配置', en: 'Save Config' },
  'settings.models.providerCustom': { zh: 'Ollama / 自定义', en: 'Ollama / Custom' },
  'settings.models.activeSelected': { zh: '★ 默认选中', en: '★ Active' },
  'settings.models.currentDefault': { zh: '当前默认优先模型', en: 'Current default model' },
  'settings.models.clickSetDefault': { zh: '点击设为默认模型', en: 'Click to set as default' },
  'settings.models.defaultModel': { zh: '默认模型', en: 'Default' },
  'settings.models.setDefault': { zh: '设为默认', en: 'Set default' },
  'settings.models.moveUp': { zh: '上移排序', en: 'Move up' },
  'settings.models.moveDown': { zh: '下移排序', en: 'Move down' },
  'settings.models.probeConnectivity': { zh: '连通性探测', en: 'Test connectivity' },
  'settings.models.probe': { zh: '⚡ 探测', en: '⚡ Probe' },
  'settings.models.editModelParams': { zh: '编辑此模型参数', en: 'Edit this model' },
  'settings.models.edit': { zh: '✎ 编辑', en: '✎ Edit' },
  'settings.models.deleteModelTitle': { zh: '删除此模型', en: 'Delete this model' },
  'settings.models.confirmDeleteTitle': {
    zh: '确认删除此模型配置？',
    en: 'Delete this model configuration?',
  },
  'settings.models.confirmDeleteDesc': {
    zh: '删除后该模型将无法在对话中继续使用，此操作无法撤销。',
    en: 'Once deleted, this model can no longer be used in chat. This cannot be undone.',
  },
  'settings.models.confirmDeleteBtn': { zh: '确认删除', en: 'Delete' },
  'settings.models.confirmDeleteDefaultWarning': {
    zh: '⚠️ 当前模型为默认优先模型，删除后将自动将其他模型设为默认。',
    en: '⚠️ This is the current default model. After deleting it, another model is set as default automatically.',
  },

  // ── 模型预设名（下拉框里给用户看的标签；模型 id / baseUrl 原样保留） ──
  'settings.preset.deepseekVllm': {
    zh: 'DeepSeek V4.1 (内网 vLLM 直连)',
    en: 'DeepSeek V4.1 (Intranet vLLM direct)',
  },
  'settings.preset.deepseekVllmName': {
    zh: 'DeepSeek V4.1 (内网)',
    en: 'DeepSeek V4.1 (Intranet)',
  },
  'settings.preset.deepseekGateway': {
    zh: 'DeepSeek V4.1 (内网网关 1333)',
    en: 'DeepSeek V4.1 (Intranet gateway 1333)',
  },
  'settings.preset.deepseekGatewayName': {
    zh: 'DeepSeek V4.1 (网关)',
    en: 'DeepSeek V4.1 (Gateway)',
  },
  'settings.preset.deepseekOfficial': { zh: 'DeepSeek (官方 API)', en: 'DeepSeek (Official API)' },
  'settings.preset.deepseekOfficialName': {
    zh: 'DeepSeek Chat (官方)',
    en: 'DeepSeek Chat (Official)',
  },
  'settings.preset.deepseekReasoner': {
    zh: 'DeepSeek Reasoner (R1 推理)',
    en: 'DeepSeek Reasoner (R1)',
  },
  'settings.preset.deepseekReasonerName': {
    zh: 'DeepSeek R1 (推理)',
    en: 'DeepSeek R1 (Reasoning)',
  },
  'settings.preset.openaiGpt4o': { zh: 'OpenAI (GPT-4o)', en: 'OpenAI (GPT-4o)' },
  'settings.preset.openaiGpt4oName': { zh: 'GPT-4o', en: 'GPT-4o' },
  'settings.preset.openaiGpt4oMini': {
    zh: 'OpenAI (GPT-4o-mini 极速)',
    en: 'OpenAI (GPT-4o-mini Fast)',
  },
  'settings.preset.openaiGpt4oMiniName': { zh: 'GPT-4o-mini', en: 'GPT-4o-mini' },
  'settings.preset.claude37Sonnet': {
    zh: 'Claude 3.7 Sonnet (Anthropic)',
    en: 'Claude 3.7 Sonnet (Anthropic)',
  },
  'settings.preset.claude37SonnetName': { zh: 'Claude 3.7 Sonnet', en: 'Claude 3.7 Sonnet' },
  'settings.preset.claude35Haiku': { zh: 'Claude 3.5 Haiku', en: 'Claude 3.5 Haiku' },
  'settings.preset.claude35HaikuName': { zh: 'Claude 3.5 Haiku', en: 'Claude 3.5 Haiku' },
  'settings.preset.agentRouter': {
    zh: 'AgentRouter (Claude 协议代理 / glm-5.3)',
    en: 'AgentRouter (Claude protocol proxy / glm-5.3)',
  },
  'settings.preset.agentRouterName': {
    zh: 'Claude 3.7 (AgentRouter)',
    en: 'Claude 3.7 (AgentRouter)',
  },
  'settings.preset.customOllama': {
    zh: '自定义 (OpenAI 兼容接口 / 本地 Ollama)',
    en: 'Custom (OpenAI-compatible / local Ollama)',
  },
  'settings.preset.customOllamaName': { zh: '本地 Ollama 模型', en: 'Local Ollama model' },

  // ── 运行与推理 Tab ──
  'settings.runtime.title': { zh: '运行与推理参数', en: 'Runtime & Reasoning' },
  'settings.runtime.desc': {
    zh: '精细调节模型生成多样性、Agent 自主执行深度及上下文记忆容量。',
    en: 'Fine-tune generation diversity, autonomous agent depth and context capacity.',
  },
  'settings.runtime.temperature': { zh: '采样温度 (Temperature)', en: 'Temperature' },
  'settings.runtime.temperatureDesc': {
    zh: '控制输出的随机性。数值越小越精确严谨（建议编程设为 0.0 - 0.2）。',
    en: 'Controls output randomness. Lower is more precise and rigorous (0.0 - 0.2 is recommended for coding).',
  },
  'settings.runtime.maxSteps': {
    zh: 'Max Agent Steps (自主执行步数上限)',
    en: 'Max Agent Steps',
  },
  'settings.runtime.steps': { zh: '{n} 步', en: '{n} steps' },
  'settings.runtime.maxStepsDesc': {
    zh: '单次任务中 AI 连续执行工具（读写文件、运行命令）的最大循环次数。',
    en: 'Maximum number of consecutive tool rounds (file edits, commands) the AI may run in one task.',
  },
  'settings.runtime.contextWindow': {
    zh: '上下文窗口容量 (Context Window Tokens)',
    en: 'Context Window Tokens',
  },
  'settings.runtime.contextWindowDesc': {
    zh: '超出此限制将自动进行会话历史精简压缩，防止请求超出模型容量限制。',
    en: 'Beyond this limit the conversation history is compacted automatically so requests stay within model capacity.',
  },
  'settings.runtime.maxOutput': {
    zh: '输出长度上限 (Max Output Tokens)',
    en: 'Max Output Tokens',
  },
  'settings.runtime.maxOutputDesc': {
    zh: '单次生成的 token 上界，含推理模型的思考 token。当模型陷入「重复同一句话」时，这是最终兜底；主要防线是下面的重复熔断。填入 0 表示不发送该字段（部分网关不识别）。',
    en: 'Upper bound of tokens per generation, including thinking tokens of reasoning models. It is the last resort when a model gets stuck repeating one sentence; the main defense is the repetition guard below. A value of 0 means the field is not sent (some gateways do not recognize it).',
  },
  'settings.runtime.repetitionGuard': {
    zh: '重复熔断保护 (Repetition Guard)',
    en: 'Repetition Guard',
  },
  'settings.runtime.repetitionGuardDesc': {
    zh: '实时监测思考与正文是否出现周期性重复（同一句话或同几句话反复输出）。一旦命中立即中止该次生成并保留已产出的内容，避免无限复读卡死。 周期上限 1200 字符，重复 5–6 遍即判定；这是网关吞掉服务端检测时唯一生效的一层。',
    en: 'Watches thinking and output for periodic repetition (the same sentence or few sentences repeating). On a hit it aborts that generation immediately and keeps what was already produced, avoiding an endless loop. Period cap is 1200 characters; 5–6 repeats triggers it. This is the only layer that still works when a gateway swallows the server-side detector.',
  },
  'settings.runtime.serverDetection': {
    zh: '服务端原生重复检测 (Server-side Repetition Detection)',
    en: 'Server-side Repetition Detection',
  },
  'settings.runtime.serverDetectionDesc': {
    zh: '请求推理引擎（vLLM）在生成过程中自行掐断重复片段，命中时 finish_reason 变为 repetition。它比客户端熔断更早生效 —— 退化 token 根本不会产生，省下的是真实算力。',
    en: 'Asks the inference engine (vLLM) to cut repetition off during generation; on a hit finish_reason becomes repetition. It kicks in earlier than the client-side guard — the degenerate tokens are never produced, saving real compute.',
  },
  'settings.runtime.noteLabel': { zh: '注意：', en: 'Note: ' },
  'settings.runtime.serverDetectionNote': {
    zh: '该字段只有直连 vLLM（如 8002）时才有效。经 New API 一类网关转发（如 1333）时字段会被网关按白名单丢掉，开了也不生效 —— 不会报错，只是静默无效。此时防护仍由上面的客户端熔断承担。',
    en: 'This field only works when talking to vLLM directly (e.g. 8002). Behind a gateway such as New API (e.g. 1333) the field is dropped by its allowlist, so enabling it does nothing — no error, just silent. The client-side guard above still covers you in that case.',
  },
  'settings.runtime.off': { zh: '已关闭', en: 'Off' },
  'settings.runtime.on': { zh: '已开启', en: 'On' },
  'settings.runtime.disabling': { zh: '关闭中', en: 'Turning off' },
  'settings.runtime.enabling': { zh: '开启中', en: 'Turning on' },
  'settings.runtime.frequencyPenalty': {
    zh: '频率惩罚 (Frequency Penalty)',
    en: 'Frequency Penalty',
  },
  'settings.runtime.frequencyPenaltyDesc': {
    zh: '按 token 出现频次施加惩罚，从采样层面降低逐字复读概率。建议 0.2 - 0.5； 设为 0 表示不发送该字段。',
    en: 'Penalizes tokens by how often they appear, reducing verbatim repetition at the sampling level. 0.2 - 0.5 is recommended; 0 means the field is not sent.',
  },
  'settings.runtime.presencePenalty': { zh: '存在惩罚 (Presence Penalty)', en: 'Presence Penalty' },
  'settings.runtime.presencePenaltyDesc': {
    zh: '按 token 是否已经出现过施加惩罚，抑制反复复述同一段内容。建议 0.2 - 0.5； 设为 0 表示不发送该字段。',
    en: 'Penalizes tokens that have already appeared, discouraging repeated restatement of the same passage. 0.2 - 0.5 is recommended; 0 means the field is not sent.',
  },

  // ── 外观与权限 Tab ──
  'settings.general.title': { zh: '外观与工作流权限', en: 'Appearance & Permissions' },
  'settings.general.keymap': {
    zh: '快捷键操作习惯 (Keymap Preset)',
    en: 'Keymap Preset',
  },
  'settings.general.keymapDesc': {
    zh: '选择您习惯的 IDE 键位方案。两套方案共用大部分快捷键（双击 Shift 全局搜索、Cmd/Ctrl+Alt+L 代码格式化、Alt+F12 切换终端等），差异在「打开文件」：VS Code 用 ⌘P，IntelliJ 用 ⌘⇧O。',
    en: 'Pick the IDE keymap you are used to. Both presets share most shortcuts (double Shift for global search, Cmd/Ctrl+Alt+L to format, Alt+F12 for the terminal); they differ on opening files: VS Code uses ⌘P, IntelliJ uses ⌘⇧O.',
  },
  'settings.general.keymapVscode': {
    zh: 'VS Code 风格 (默认 - ⌘P 快速文件，⌘⇧P 命令面板)',
    en: 'VS Code style (default — ⌘P quick file, ⌘⇧P command palette)',
  },
  'settings.general.keymapIntellij': {
    zh: 'IntelliJ IDEA 风格 (双击 Shift 全局搜索，⌘⌥L 格式化)',
    en: 'IntelliJ IDEA style (double Shift global search, ⌘⌥L format)',
  },
  'settings.general.autosaveFull': {
    zh: '代码编辑自动保存到磁盘 (编辑停止约 0.8 秒后写入)',
    en: 'Auto-save edits to disk (written ~0.8s after typing stops)',
  },
  'settings.general.formatOnSave': {
    zh: '保存时自动格式化 (Format on Save) — 触发保存时自动规范代码排版',
    en: 'Format on Save — normalize code layout whenever a save is triggered',
  },
  'settings.general.blameInline': {
    zh: '光标所在行常驻显示 Git Blame (提交人、时间与提交摘要)',
    en: 'Always show Git Blame on the cursor line (author, time and commit summary)',
  },
  'settings.general.msUnit': { zh: '毫秒 (ms)', en: 'milliseconds (ms)' },
  'settings.general.scrollback': {
    zh: '终端缓存条数上限 (Scrollback Lines)',
    en: 'Scrollback Lines',
  },
  'settings.general.scrollbackDesc': {
    zh: '控制每个终端窗口在内存中保留的历史运行日志行数上限。增加上限可回滚查看更多历史日志，默认 10,000 行。',
    en: 'Caps how many lines of history each terminal keeps in memory. A higher cap lets you scroll back further; the default is 10,000 lines.',
  },
  'settings.general.linesUnit': { zh: '行', en: 'lines' },
  'settings.general.linesValue': { zh: '{n} 行', en: '{n} lines' },

  // ── Skills Tab ──
  'settings.skills.title': { zh: 'Skills 技能扩展库', en: 'Skills Library' },
  'settings.skills.desc': {
    zh: '兼容 Cursor frontmatter 技能协议，赋予 AI 专属的代码生成与工程工作流能力。',
    en: 'Compatible with the Cursor frontmatter skill protocol, giving the AI purpose-built coding and workflow abilities.',
  },
  'settings.skills.openDir': {
    zh: '📂 打开用户 Skills 目录',
    en: '📂 Open user Skills folder',
  },
  'settings.skills.userPath': { zh: '用户技能路径:', en: 'User skills path:' },
  'settings.skills.empty': {
    zh: '当前未发现已安装的 Skills',
    en: 'No installed Skills found',
  },
  'settings.skills.placeHint': {
    zh: '可将技能放置在 {cursorPath} 或 {deepseekPath}',
    en: 'Place skills at {cursorPath} or {deepseekPath}',
  },

  // ── MCP Tab ──
  'settings.mcp.title': { zh: 'MCP 服务器', en: 'MCP Servers' },
  'settings.mcp.desc': {
    zh: '通过 Model Context Protocol 接入外部工具（数据库、工单系统、内部 API 等）。AI 在 Agent 模式下可直接调用它们。',
    en: 'Connect external tools (databases, ticketing systems, internal APIs) over the Model Context Protocol. The AI can call them directly in Agent mode.',
  },
  'settings.mcp.connecting': { zh: '连接中…', en: 'Connecting…' },
  'settings.mcp.reconnect': { zh: '↻ 重新连接', en: '↻ Reconnect' },
  'settings.mcp.addServer': { zh: '＋ 添加服务器', en: '+ Add Server' },
  'settings.mcp.secLabel': { zh: '安全提示：', en: 'Security note:' },
  // 句中的两处强调（<b>）用占位符标出，位置随语言变化
  'settings.mcp.secBody': {
    zh: 'MCP 工具运行在{outside}：它们能读写你配置的外部系统，改动可能不可逆。标记为「可写」的服务器，其工具在 Ask / Plan 模式下{never}出现；即使出现，每次调用也会先请求确认（除非权限设为「允许所有」）。请只添加你信任的服务器。',
    en: 'MCP tools run {outside}: they can read and write the external systems you configure, and changes may be irreversible. Tools of servers marked "writable" do {never} appear in Ask / Plan mode; even when they do, every call asks for confirmation first (unless permission is set to "Allow all"). Only add servers you trust.',
  },
  'settings.mcp.secOutside': { zh: '工作区之外', en: 'outside your workspace' },
  'settings.mcp.secNever': { zh: '不会', en: 'not' },
  'settings.mcp.empty': { zh: '尚未配置 MCP 服务器', en: 'No MCP servers configured yet' },
  'settings.mcp.newServerName': { zh: '新服务器 {n}', en: 'New server {n}' },
  'settings.mcp.exampleLabel': { zh: '常用示例：', en: 'Common example:' },
  'settings.mcp.toolCount': { zh: '{n} 个工具', en: '{n} tools' },
  'settings.mcp.truncatedMore': { zh: '另有 {n} 个未加载', en: '{n} more not loaded' },
  'settings.mcp.readonly': { zh: '只读', en: 'Read-only' },
  'settings.mcp.writable': { zh: '可写', en: 'Writable' },
  'settings.mcp.enable': { zh: '启用', en: 'Enable' },
  'settings.mcp.delete': { zh: '删除', en: 'Delete' },
  'settings.mcp.connectFailed': { zh: '连接失败', en: 'Connection failed' },
  'settings.mcp.fieldId': { zh: '标识 (id)', en: 'ID' },
  'settings.mcp.fieldIdHint': {
    zh: 'AI 看到的工具名前缀（{prefix}）。改名等于换一个服务器。',
    en: 'The tool-name prefix the AI sees ({prefix}). Renaming it equals switching to a different server.',
  },
  'settings.mcp.toolNameSuffix': { zh: '工具名', en: 'toolname' },
  'settings.mcp.fieldName': { zh: '显示名', en: 'Display name' },
  'settings.mcp.fieldCommand': { zh: '启动命令', en: 'Command' },
  'settings.mcp.fieldArgs': { zh: '参数（每行一个）', en: 'Arguments (one per line)' },
  'settings.mcp.fieldCwd': { zh: '工作目录（可选）', en: 'Working directory (optional)' },
  'settings.mcp.fieldEnv': {
    zh: '环境变量（可选，每行 KEY=VALUE）',
    en: 'Environment variables (optional, KEY=VALUE per line)',
  },
  'settings.mcp.fieldEnvHint': {
    zh: '密钥放这里，不要放参数 —— 参数会出现在系统进程列表里，同机器上任何用户都能看到。',
    en: 'Put secrets here, not in the arguments — arguments show up in the system process list and are visible to any user on the machine.',
  },
  'settings.mcp.fieldAccess': { zh: '影响面', en: 'Access' },
  'settings.mcp.accessWrite': {
    zh: '可写（Agent 模式可用，调用需确认）',
    en: 'Writable (available in Agent mode, calls need confirmation)',
  },
  'settings.mcp.accessReadonly': {
    zh: '只读（Ask / Plan 模式也可用）',
    en: 'Read-only (also available in Ask / Plan mode)',
  },
  'settings.mcp.fieldAccessHint': {
    zh: '协议无法告知一个工具会不会改数据，所以这里由你声明。不确定就保持「可写」。',
    en: 'The protocol cannot tell whether a tool mutates data, so you declare it here. When unsure, keep it Writable.',
  },
  'settings.mcp.saveConnect': { zh: '保存并连接', en: 'Save & Connect' },
  'settings.mcp.confirmDeleteTitle': {
    zh: '确认删除此 MCP 服务器？',
    en: 'Delete this MCP server?',
  },
  'settings.mcp.confirmDeleteDesc': {
    zh: '删除后其提供的工具会立即从 AI 的可用工具中移除，正在运行的任务将无法再调用它们。',
    en: 'Its tools are removed from the AI toolset immediately, and any running task can no longer call them.',
  },
  'settings.mcp.confirmDeleteBtn': { zh: '确认删除', en: 'Delete' },

  // ── 软件更新 Tab（主表 settings.update.* 之外的补充） ──
  'settings.update.providerGeneric': {
    zh: '自建服务器 (Generic)',
    en: 'Self-hosted server (Generic)',
  },
  'settings.update.notesTitle': { zh: '更新说明 (Release Notes)', en: 'Release Notes' },
  'settings.update.downloadFailed': { zh: '下载失败', en: 'Download failed' },

  // ── 关于 Tab（主表 settings.about.* 之外的补充） ──
  'settings.about.releaseBadge': { zh: '正式发行版', en: 'Latest Release' },
  'settings.about.runtimeVersion': { zh: 'Echoly 版本', en: 'Echoly Version' },
  'settings.about.runtimeArch': { zh: '目标架构', en: 'Target Architecture' },
  'settings.about.runtimeStack': { zh: '运行时栈', en: 'Runtime Stack' },
  'settings.about.copiedDetail': {
    zh: 'Echoly v{version} 诊断与环境信息已成功复制到剪贴板',
    en: 'Echoly v{version} diagnostics and environment info copied to the clipboard',
  },
  'settings.about.copyFailedTitle': { zh: '复制失败', en: 'Copy failed' },
  'settings.about.copyFailedDetail': {
    zh: '请手动选中文本复制',
    en: 'Select the text and copy it manually',
  },
};
