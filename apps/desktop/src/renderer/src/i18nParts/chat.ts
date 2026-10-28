/**
 * AI 对话面板（ChatPanel）的文案分片。
 *
 * 为什么字典要分片：i18n 铺开阶段有多个改动在并行加 key，
 * 全塞进 i18n.ts 同一个对象里几乎必然冲突。分片后「一个领域一个文件」
 * （这里是 `chat.*`），合并顺序集中在 i18n.ts 一处。
 *
 * 注意：`'当前对话'` / `'对话'` / `'New Chat'` 这几个**历史默认标题**曾经在五个组件里
 * 被逐字比较（判定「用户是否改过标题」），它们是**哨兵值**而不是文案。该判定现已收进
 * `utils.ts` 的 `isCustomSessionTitle`（连同 `DEFAULT_SESSION_TITLE` /
 * `AUTO_SESSION_TITLE_FALLBACK` 两个常量），**别再把字面量散回各组件**。
 * 下面这两条只是它们的展示形态，用 `workspaceSessionBinding.test.ts` 钉住两者相等。
 */
export const chatDict: Record<string, { zh: string; en: string }> = {
  // ---- Tab 栏与头部操作 ----
  'chat.titleCurrent': { zh: '当前对话', en: 'Current chat' },
  'chat.titleDefault': { zh: '对话', en: 'Chat' },
  'chat.tabInactiveTitle': { zh: '{title} (点击切换)', en: '{title} (click to switch)' },
  'chat.tabRunning': { zh: '运行中…', en: 'Running…' },
  'chat.tabClose': { zh: '关闭 Tab', en: 'Close tab' },
  'chat.exported': { zh: '已导出 Markdown', en: 'Markdown exported' },
  'chat.exportTip': {
    zh: '导出当前会话为 Markdown 文件',
    en: 'Export this session as a Markdown file',
  },
  'chat.clearChat': { zh: '清空当前对话记录', en: 'Clear current chat' },
  'chat.newChat': { zh: '新建对话', en: 'New chat' },
  // 代码引用 pill / chip 的悬停提示。{path} 后面可能还跟着 `:12-18` 这样的行号标签，
  // 拼接规则在组件里，所以整句进字典、行号当参数传进来。
  'chat.openRefFile': {
    zh: '点击打开文件并定位高亮: {path}',
    en: 'Click to open the file and highlight it: {path}',
  },
  'chat.openRef': { zh: '点击打开：{path}', en: 'Click to open: {path}' },
  'chat.history': { zh: '历史会话', en: 'Session history' },

  // ---- 消息级操作 ----
  'chat.copyMsg': { zh: '复制消息内容', en: 'Copy message' },
  'chat.rollbackTip': {
    zh: '回退到此消息（清除此后的 AI 回复）',
    en: 'Roll back to this message (discards later AI replies)',
  },
  'chat.revertTurn': { zh: '撤销本轮改动', en: 'Undo this turn' },
  'chat.revertTurnTip': {
    zh: '还原本轮改动的 {n} 处文件操作',
    en: 'Revert {n} file operations from this turn',
  },
  'chat.revertIncompleteTip': {
    zh: '本轮有操作无法完整留底：{reason}',
    en: 'Some operations in this turn could not be fully recorded: {reason}',
  },
  'chat.unknownReason': { zh: '未知原因', en: 'unknown reason' },

  // ---- 运行中追加消息的送达状态 ----
  'chat.deliveryQueuedTip': {
    zh: '将在 AI 完成当前步骤后送达',
    en: 'Delivered after the AI finishes the current step',
  },
  'chat.deliveryQueued': {
    zh: '排队中，将在当前步骤结束后送达',
    en: 'Queued — delivered after the current step ends',
  },
  'chat.deliveryUndeliveredTip': {
    zh: '本轮任务在读到这条消息前就结束了，它没有被 AI 看到',
    en: 'The turn ended before this message was read; the AI never saw it',
  },
  'chat.deliveryUndelivered': {
    zh: '未送达：本轮任务已结束，请重新发送',
    en: 'Not delivered: the turn has ended, please send it again',
  },

  // ---- 空态 ----
  'chat.emptyTitle': { zh: 'Echoly AI 编程助手', en: 'Echoly AI Coding Assistant' },
  'chat.emptySubtitle': {
    zh: '随时提问，或点击下方快捷指令针对当前代码上下文开展分析',
    en: 'Ask anything, or pick a shortcut below to analyze the current code context',
  },
  'chat.projectHistoryTitle': { zh: '项目历史会话', en: 'Project Sessions' },
  'chat.projectHistorySubtitle': {
    zh: '选择已有会话继续，或直接提问开启新探索',
    en: 'Pick an existing session to resume, or ask a new question below',
  },
  'chat.viewAllSessions': { zh: '查看全部 ({n})', en: 'View All ({n})' },
  'chat.viewMoreSessions': {
    zh: '查看更多历史会话（共 {n} 个）→',
    en: 'View all sessions ({n} total) →',
  },
  'chat.orNewQuestion': { zh: '或开始全新提问', en: 'Or ask a new question' },
  'chat.openInTab': { zh: '已在标签打开', en: 'Open in tab' },
  'chat.sessionMessagesCount': { zh: '{n} 条对话', en: '{n} messages' },
  'chat.deleteSession': { zh: '删除会话', en: 'Delete session' },
  'chat.deleteSessionConfirm': {
    zh: '确定删除历史会话「{title}」？此操作不可撤销。',
    en: 'Delete session "{title}"? This cannot be undone.',
  },
  'chat.justNow': { zh: '刚刚', en: 'Just now' },
  'chat.minsAgo': { zh: '{n} 分钟前', en: '{n}m ago' },
  'chat.hoursAgo': { zh: '{n} 小时前', en: '{n}h ago' },
  'chat.yesterday': { zh: '昨天', en: 'Yesterday' },
  'chat.daysAgo': { zh: '{n} 天前', en: '{n}d ago' },
  'chat.quickExplainSelection': { zh: '解释选中的代码', en: 'Explain the selected code' },
  'chat.quickExplain': { zh: '解释当前代码逻辑', en: 'Explain the current code' },
  'chat.quickOptimize': { zh: '审查与优化执行性能', en: 'Review and optimize performance' },
  'chat.quickTest': { zh: '生成全面单元测试', en: 'Generate thorough unit tests' },
  'chat.quickBug': { zh: '排查潜在 Bug 与安全隐患', en: 'Hunt for bugs and security risks' },
  'chat.jumpLatest': { zh: '↓ 回到最新', en: '↓ Back to latest' },

  // ---- 待审阅改动（输入框上方的文件清单） ----
  'chat.diffViewTip': { zh: '点击查看 {path} 差异', en: 'Click to view the diff of {path}' },
  'chat.diffFilesWithChanges': { zh: '{n} 个文件有改动', en: '{n} Files With Changes' },
  'chat.diffExpandList': { zh: '展开文件清单', en: 'Expand file list' },
  'chat.diffCollapseList': { zh: '折叠文件清单', en: 'Collapse file list' },
  'chat.diffRejectAll': { zh: '全部拒绝', en: 'Reject all' },
  'chat.diffAcceptAll': { zh: '全部接受', en: 'Accept all' },

  // ---- AI 问答 / 步数上限弹层 ----
  'chat.askAnswerPh': { zh: '输入回答后提交…', en: 'Type an answer and submit…' },
  'chat.submit': { zh: '提交', en: 'Submit' },
  'chat.allow': { zh: '允许', en: 'Allow' },
  'chat.deny': { zh: '拒绝', en: 'Deny' },
  'chat.maxStepsTitle': { zh: '已达步数上限', en: 'Step limit reached' },
  'chat.maxStepsDetail': {
    zh: '已完成 {done} 步，尚未给出最终答案。可再继续 {chunk} 步。',
    en: 'Completed {done} steps without a final answer yet. You can continue for {chunk} more steps.',
  },
  'chat.continueBtn': { zh: '继续', en: 'Continue' },
  'chat.stopBtn': { zh: '停止', en: 'Stop' },
  'chat.send': { zh: '发送', en: 'Send' },

  // ---- @ 引用下拉 ----
  'chat.currentFileDesc': { zh: '当前文件 · {path}', en: 'Current file · {path}' },

  // ---- 附件 ----
  'chat.zoomTip': { zh: '点击放大', en: 'Click to enlarge' },
  'chat.zoomElementTip': { zh: '点击放大元素截图', en: 'Click to enlarge the element screenshot' },
  'chat.domElementWithShot': { zh: 'DOM 元素 · 含截图', en: 'DOM element · with screenshot' },
  'chat.domElement': { zh: 'DOM 元素', en: 'DOM element' },
  'chat.webPage': { zh: '网页页面', en: 'Web page' },
  'chat.removeAttachment': { zh: '移除附件', en: 'Remove attachment' },
  'chat.attachmentImgTip': {
    zh: '{name} ({size}) - 点击放大',
    en: '{name} ({size}) - click to enlarge',
  },
  'chat.elementRefTip': {
    zh: '网页元素: {name}\n页面: {url}\n选择器: {selector}\n\n点击复制 outerHTML',
    en: 'Web element: {name}\nPage: {url}\nSelector: {selector}\n\nClick to copy outerHTML',
  },
  'chat.pageRefTip': {
    zh: '网页页面: {title}\n{url}{errors}',
    en: 'Web page: {title}\n{url}{errors}',
  },
  'chat.pageRefErrors': {
    zh: '\n\n引用时的控制台报错 ({n} 条):\n{list}',
    en: '\n\nConsole errors when referenced ({n}):\n{list}',
  },
  'chat.pageErrorsBadge': { zh: '页面 · {n} 报错', en: 'Page · {n} errors' },
  'chat.pageBadge': { zh: '页面', en: 'Page' },
  'chat.mentionSnapshotTip': {
    zh: '{name} 引用（提交时抓取的快照）\n\n{content}',
    en: '{name} reference (snapshot captured at submit)\n\n{content}',
  },
  'chat.contextBadge': { zh: '上下文', en: 'Context' },
  'chat.addAttachment': { zh: '添加附件（图片/文件）', en: 'Add attachment (image/file)' },

  // ---- 模型下拉框 ----
  'chat.selectModel': { zh: '选择大模型', en: 'Select model' },
  'chat.manageModels': { zh: '⚙ 管理模型', en: '⚙ Manage models' },
  'chat.noHealthyModel': {
    zh: '⚠️ 暂无连通正常的模型，请点击右上角【管理模型】测试连通性。',
    en: '⚠️ No model is currently connected. Click “Manage models” at the top right to test connectivity.',
  },
  'chat.untestedDivider': {
    zh: '未通过连通测试 (不可选)',
    en: 'Failed connectivity test (unavailable)',
  },
  'chat.modelUntestedTip': {
    zh: '该模型未通过连通测试，不可选择。请前往【管理模型】测试通过后再使用。',
    en: 'This model failed the connectivity test and cannot be selected. Test it in “Manage models” first.',
  },
  'chat.modelHealthyTip': {
    zh: '连通测试正常，可选用',
    en: 'Connectivity test passed; available for use',
  },
  'chat.thinkingMode': { zh: '· 思考模式', en: '· Thinking mode' },
  'chat.modelHealthyBadge': { zh: '● 正常', en: '● OK' },
  'chat.modelUntestedBadge': { zh: '未连通·不可选', en: 'Disconnected · unavailable' },
  'chat.modelCurrentTip': {
    zh: '当前模型: {name} ({model}){status}',
    en: 'Current model: {name} ({model}){status}',
  },
  'chat.modelStatusHealthy': { zh: ' [连通正常]', en: ' [connected]' },
  'chat.modelStatusUntested': { zh: ' [未通过连通测试]', en: ' [connectivity test failed]' },

  // ---- 底部工具栏 ----
  'chat.modeTip': { zh: '模式: {mode}', en: 'Mode: {mode}' },
  'chat.permTip': { zh: '权限: {perm}', en: 'Permission: {perm}' },
  'chat.rulesActiveTip': {
    zh: '项目规则 (.echolyrules): 已生效，点击打开编辑',
    en: 'Project rules (.echolyrules): active, click to edit',
  },
  'chat.rulesInactiveTip': {
    zh: '项目规则: 未设置，点击创建 .echolyrules 项目规则文件',
    en: 'Project rules: not set, click to create a .echolyrules file',
  },
  'chat.contextUsageTip': {
    zh: '上下文使用率: {pct}% ({used} / {window})',
    en: 'Context usage: {pct}% ({used} / {window})',
  },
  'chat.appendTip': {
    zh: '追加到当前任务（AI 完成当前步骤后读到）',
    en: 'Append to the current task (read after the AI finishes the current step)',
  },
  'chat.close': { zh: '关闭', en: 'Close' },

  // ---- 权限短标签 / 完整标签（由模板字符串动态拼出） ----
  'chat.permShort.allow_all_extreme': { zh: '全放行·极', en: 'All allowed · max' },
  'chat.permShort.allow_all': { zh: '全自动', en: 'Auto' },
  'chat.permShort.ask': { zh: '需确认', en: 'Ask' },
  'chat.permShort.deny_all': { zh: '只读', en: 'Read-only' },
  'chat.permFull.allow_all_extreme': { zh: '允许所有操作·极', en: 'Allow all · max' },
  'chat.permFull.allow_all': { zh: '允许所有操作', en: 'Allow all' },
  'chat.permFull.ask': { zh: '询问后允许', en: 'Ask before allowing' },
  'chat.permFull.deny_all': { zh: '不允许任何操作', en: 'Allow nothing' },

  // ---- 回退到某条消息的确认框 ----
  'chat.rollbackTitle': { zh: '回退到此消息', en: 'Roll back to this message' },
  'chat.rollbackIntro': {
    zh: '这条消息之后的**全部对话内容都会被丢弃**（含 AI 回复与思考过程），且**无法撤销**。',
    en: '**All conversation after this message will be discarded** (including AI replies and reasoning), and this **cannot be undone**.',
  },
  'chat.rollbackNote': {
    zh: '消息正文会被放回输入框，改完可以直接重新发送。',
    en: 'The message text is put back in the input box, so you can edit and resend it.',
  },
  'chat.rollbackDropped': { zh: '丢弃', en: 'Discard' },
  'chat.rollbackDroppedValue': { zh: '{n} 条消息', en: '{n} messages' },
  'chat.rollbackRunning': { zh: '进行中', en: 'In progress' },
  'chat.rollbackRunningValue': {
    zh: '有 AI 任务正在执行，会被中断',
    en: 'An AI task is running and will be interrupted',
  },
  'chat.rollbackConfirm': { zh: '确认回退', en: 'Confirm rollback' },

  // ---- 附件体积限制 ----
  'chat.fileTooLarge20': {
    zh: '文件 {name} 超过 20MB 限制',
    en: 'File {name} exceeds the 20MB limit',
  },
  'chat.fileTooLarge5': {
    zh: '文件 {name} 超过 5MB 限制',
    en: 'File {name} exceeds the 5MB limit',
  },

  // ---- 重复引用提示 ----
  'chat.elementExists': {
    zh: '该元素已在输入框中，无需重复引用',
    en: 'This element is already in the input; no need to reference it again',
  },
  'chat.pageExists': {
    zh: '该页面已在输入框中，无需重复引用',
    en: 'This page is already in the input; no need to reference it again',
  },

  // ---- 轮次结束 / 报错 ----
  'chat.workedFoldHint': {
    zh: '已完成执行，详细操作步骤已收折在上方「Worked for」面板中，点击即可展开查看。',
    en: 'Execution finished. The detailed steps are folded into the “Worked for” panel above — click to expand.',
  },
  'chat.taskCompleted': { zh: '任务已全部执行完成', en: 'Task completed' },
  'chat.modelConnWarning': {
    zh: '⚠️ **模型连通性异常**：连接大语言模型服务失败 ({msg})。\n\n> **诊断与恢复指引**：\n> 1. 若使用本地自建模型（如 Ollama / LM Studio），请检查服务是否运行或端口是否正确监听；\n> 2. 若在离线局域网环境，请检查网络路由与内网代理是否正常；\n> 3. 建议在顶部模型下拉框中，一键切换至当前标记为绿色的备用可用模型。',
    en: '⚠️ **Model connectivity problem**: failed to reach the LLM service ({msg}).\n\n> **Diagnosis and recovery**:\n> 1. For a self-hosted model (e.g. Ollama / LM Studio), check that the service is running and the port is correct;\n> 2. On an offline LAN, check the network routes and internal proxy;\n> 3. Consider switching to a backup model marked green in the model dropdown at the top.',
  },
  'chat.errorPrefix': { zh: '错误：{msg}', en: 'Error: {msg}' },
  'chat.analyzeImage': { zh: '请分析图片', en: 'Please analyze the image' },
  'chat.analyzeAttachment': { zh: '请分析附件', en: 'Please analyze the attachment' },

  // ---- 撤销本轮改动 ----
  'chat.revertIncompleteAlert': {
    zh: '本轮有操作无法完整留底（{reason}），已放弃自动撤销。\n请使用 Git 还原工作区。',
    en: 'Some operations in this turn could not be fully recorded ({reason}); automatic undo was skipped.\nPlease restore the workspace with Git.',
  },
  /**
   * 撤销结果的提示标题。
   *
   * 撤销结果是「一段可以很长、需要逐条核对」的文本（哪些还原了、哪些跳过了、为什么），
   * 弹窗式的 `alert` 只能整个吞下去。改成 toast 之后：标题给出结论，明细作为 detail，
   * 点击 toast 会展开成可滚动的明细弹窗 —— 用户不需要在「一眼看完」和「看全」之间二选一。
   */
  'chat.revertNotPossible': {
    zh: '本轮改动无法自动撤销',
    en: 'These changes can’t be undone automatically',
  },
  'chat.revertFailed': { zh: '撤销失败', en: 'Undo failed' },
  'chat.revertTitle': { zh: '撤销本轮 AI 改动', en: 'Undo this turn’s AI changes' },
  'chat.revertIntro': {
    zh: '这一轮里 AI 写过的文件会被还原到它动手之前的内容，**新建的文件会被删除**，且**无法通过「重做」恢复**。',
    en: 'Files written by the AI in this turn are restored to their pre-edit content, **newly created files are deleted**, and this **cannot be recovered with “redo”**.',
  },
  'chat.revertNote1': {
    zh: '本轮之后你自己改过、或再没被这段改动碰过的文件不会被覆盖。',
    en: 'Files you edited afterwards, or that this turn never touched, will not be overwritten.',
  },
  'chat.revertNote2': {
    zh: '未被还原的部分会在结果里逐条列出。',
    en: 'Anything not restored is listed item by item in the result.',
  },
  'chat.revertDetailLabel': { zh: '改动', en: 'Changes' },
  'chat.revertDetailValue': { zh: '{n} 处文件操作', en: '{n} file operations' },
  'chat.revertConfirm': { zh: '确认撤销', en: 'Confirm undo' },
  'chat.revertResult': { zh: '已还原 {n} 处改动。', en: 'Reverted {n} changes.' },
  'chat.revertConflicts': {
    zh: '\n以下文件在本轮之后又被修改过，为避免覆盖你的改动已跳过：\n{list}',
    en: '\nThese files were modified again after this turn, so they were skipped to avoid overwriting your changes:\n{list}',
  },
  'chat.revertSkipped': {
    zh: '\n以下内容未能自动还原：\n{list}',
    en: '\nThe following could not be restored automatically:\n{list}',
  },

  // ---- 关闭 Tab 的确认框 ----
  'chat.closeTabTitle': { zh: '关闭对话标签', en: 'Close chat tab' },
  'chat.closeTabIntro': {
    zh: '这个标签下**正在运行的 AI 任务会被中断**，且**无法续跑**（对话记录本身会保留在历史会话里）。',
    en: 'The **running AI task in this tab will be interrupted** and **cannot be resumed** (the chat record itself stays in session history).',
  },
  'chat.labelTitle': { zh: '标题', en: 'Title' },
  'chat.untitled': { zh: '（无标题）', en: '(untitled)' },
  'chat.labelStatus': { zh: '状态', en: 'Status' },
  'chat.statusRunning': { zh: '执行中', en: 'Running' },
  'chat.closeTabConfirm': { zh: '确认关闭', en: 'Confirm close' },

  // ---- 导出 Markdown ----
  'chat.exportDefaultTitle': { zh: 'AI 对话记录', en: 'AI Chat Log' },
  'chat.exportMeta': {
    zh: '> 导出时间：{date} | 模式：{mode}',
    en: '> Exported at: {date} | Mode: {mode}',
  },
  'chat.exportThinking': { zh: '💭 思考过程 (Thinking)', en: '💭 Thinking' },

  // ---- Plan 模式的结构化计划面板（PlanPanel） ----
  'plan.title': { zh: '计划', en: 'Plan' },
  'plan.execute': { zh: '开始执行', en: 'Start executing' },
  'plan.dismiss': { zh: '关闭', en: 'Dismiss' },
  'plan.titlePlaceholder': { zh: '计划标题', en: 'Plan title' },
  'plan.summaryPlaceholder': { zh: '计划摘要', en: 'Plan summary' },
  'plan.todoPlaceholder': { zh: '待办步骤', en: 'Todo step' },
  'plan.removeTodo': { zh: '删除', en: 'Remove' },
  'plan.addTodo': { zh: '+ 添加步骤', en: '+ Add step' },

  // ---- 清空当前对话的确认框 ----
  'chat.clearTitle': { zh: '清空当前对话记录', en: 'Clear current chat' },
  'chat.clearIntro': {
    zh: '当前 Tab 里的全部消息、思考链与计划都会被清除，且**无法撤销**（历史会话列表里若已保存过副本则不受影响）。',
    en: 'All messages, reasoning chains and plans in this tab will be cleared, and this **cannot be undone** (an already-saved copy in session history is unaffected).',
  },
  'chat.labelMessages': { zh: '消息', en: 'Messages' },
  'chat.clearMessagesValue': { zh: '{n} 条', en: '{n}' },
  'chat.clearConfirm': { zh: '确认清空', en: 'Confirm clear' },

  // ---- 会话分叉、历史折叠与分支联动 ----
  'chat.forkTip': { zh: '基于此轮对话创建新分支会话 (Fork)', en: 'Fork conversation from this turn' },
  'chat.forkSession': { zh: '分叉当前会话为新 Tab (Fork)', en: 'Fork current session into new tab' },
  'chat.forkSuffix': { zh: '分支', en: 'Fork' },
  'chat.showOlderTurns': { zh: '展开更早的 {n} 轮历史对话', en: 'Show {n} earlier conversation turns' },
  'chat.hideOlderTurns': { zh: '折叠更早的历史对话', en: 'Collapse earlier conversation turns' },
  'chat.currentBranchFilter': { zh: '仅当前分支', en: 'Current branch only' },
  'chat.branchFilterActive': { zh: '已启用', en: 'Active' },
  'chat.branchBadge': { zh: '分支: {branch}', en: 'Branch: {branch}' },
};
