/**
 * 轻量级 i18n：中英文切换。
 *
 * 采用极简字典方案（无第三方依赖），默认中文（符合项目约定）。
 * 通过 localStorage 记住语言选择。使用 React Context 提供全局 locale，
 * 任一组件调用 setLocale() 会让所有消费 useI18n() 的组件一起重渲染。
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { gitDict } from './i18nParts/git';
import { editorDict } from './i18nParts/editor';
import { dbDict } from './i18nParts/db';
import { runtimeDict } from './i18nParts/runtime';
import { miscDict } from './i18nParts/misc';
import { chatDict } from './i18nParts/chat';
import { settingsDict } from './i18nParts/settings';

export type Locale = 'zh' | 'en';

export const LOCALE_STORAGE_KEY = 'echoly_locale';

/**
 * 字典本体。
 *
 * 导出**只为测试**：i18n 正在往各组件铺开，手工维护一份「要检查的 key 列表」
 * 会在第一次忘记更新时失效，而缺英文这件事本身在中文环境下完全看不出来。
 * 测试需要遍历真实字典，所以这里必须导出。
 */
export const CORE_DICT: Record<string, { zh: string; en: string }> = {
  'app.name': { zh: 'Echoly', en: 'Echoly' },

  // 面板标题
  'panel.explorer': { zh: '资源管理器', en: 'Explorer' },
  'panel.project': { zh: '项目', en: 'Project' },
  'panel.sourceControl': { zh: '源代码管理', en: 'Source Control' },
  'panel.extensions': { zh: '扩展', en: 'Extensions' },
  'panel.settings': { zh: '设置', en: 'Settings' },
  'panel.chat': { zh: 'AI 助手', en: 'AI Assistant' },
  'panel.terminal': { zh: '终端', en: 'Terminal' },
  'panel.editor': { zh: '编辑器', en: 'Editor' },
  'panel.problems': { zh: '问题', en: 'Problems' },
  'panel.database': { zh: '数据库', en: 'Database' },
  'panel.noWorkspace': { zh: '未打开工作区', en: 'No Workspace' },

  // 菜单
  'menu.file': { zh: '文件', en: 'File' },
  'menu.edit': { zh: '编辑', en: 'Edit' },
  'menu.view': { zh: '查看', en: 'View' },
  'menu.window': { zh: '窗口', en: 'Window' },
  'menu.newFile': { zh: '新建文本文件', en: 'New Text File' },
  'menu.openFolder': { zh: '打开文件夹…', en: 'Open Folder…' },
  'menu.save': { zh: '保存', en: 'Save' },
  'menu.closeEditor': { zh: '关闭编辑器', en: 'Close Editor' },

  // 设置 - 导航
  'settings.nav.models': { zh: 'AI 模型配置', en: 'AI Models' },
  'settings.nav.modelsDesc': { zh: '多模型端点与密钥', en: 'Endpoints & keys' },
  'settings.nav.runtime': { zh: '运行与推理', en: 'Runtime & Reasoning' },
  'settings.nav.runtimeDesc': { zh: '温度、步数与窗口', en: 'Temp, steps & window' },
  'settings.nav.general': { zh: '外观与权限', en: 'Appearance & Permissions' },
  'settings.nav.generalDesc': { zh: '主题、放行策略', en: 'Theme & approval' },
  'settings.nav.skills': { zh: 'Skills 技能库', en: 'Skills Library' },
  'settings.nav.skillsDesc': { zh: 'Cursor / 本地技能', en: 'Cursor / local skills' },
  'settings.nav.update': { zh: '软件更新', en: 'Updates' },
  'settings.nav.updateDesc': { zh: '在线更新配置', en: 'Online update' },
  'settings.nav.about': { zh: '关于作者', en: 'About Author' },
  'settings.nav.aboutDesc': { zh: '开发者与项目信息', en: 'Developer & Project' },

  // 设置 - 通用文案
  'settings.title': { zh: '偏好设置', en: 'Preferences' },
  'settings.language': { zh: '界面语言', en: 'Display Language' },
  'settings.language.zh': { zh: '中文', en: 'Chinese' },
  'settings.language.en': { zh: 'English', en: 'English' },
  'settings.theme': { zh: '界面主题 (Theme)', en: 'Interface Theme' },
  'settings.theme.dark': { zh: '深色极客 Dark (默认)', en: 'Dark (default)' },
  'settings.theme.light': { zh: '浅色雅致 Light', en: 'Light' },
  'settings.theme.light.disabledHint': {
    zh: '🚧 浅色主题正在深度适配优化中，暂未开放，敬请期待！',
    en: '🚧 Light theme is currently under optimization, coming soon!',
  },
  'settings.theme.adapting': { zh: '适配中', en: 'Coming Soon' },
  'settings.autosave': { zh: '代码编辑自动保存到磁盘', en: 'Auto-save edits to disk' },
  'settings.permission': { zh: '工具执行安全策略 (Permission Mode)', en: 'Tool Permission Mode' },
  'settings.permissionDesc': {
    zh: '控制 AI 在尝试修改本地代码或在终端执行命令时的放行准则。',
    en: 'Control how AI may modify code or run terminal commands.',
  },
  'settings.appearanceDesc': {
    zh: '设置 IDE 视觉主题、自动保存以及 AI 工具调用执行时的授权安全策略。',
    en: 'Set theme, auto-save and AI tool permission policy.',
  },
  'settings.hoverDelay': { zh: '鼠标悬浮提示延迟 (Hover Delay)', en: 'Hover Tooltip Delay' },
  'settings.hoverDelayDesc': {
    zh: '控制界面元素悬停气泡及代码提示弹出的等待时间，单位毫秒（ms），最低 500ms。',
    en: 'Delay before UI tooltips and code hover popups appear, in ms (minimum 500ms).',
  },
  'settings.minimap': {
    zh: '开启编辑器右侧代码缩略图 (Minimap)',
    en: 'Enable editor minimap on right side',
  },
  'settings.selectionAiFloat': {
    zh: '选中文本时显示浮动 AI 提问/编辑快捷栏',
    en: 'Show floating AI action bar on text selection',
  },

  // 设置 - 更新
  'settings.update.title': { zh: '在线更新', en: 'Online Update' },
  'settings.update.desc': {
    zh: '配置在线自动更新源。私有 GitHub 仓库需填写访问令牌（Token），令牌仅保存在本机且加密存储。',
    en: 'Configure the online update feed. Private GitHub repos need an access token (stored locally & encrypted).',
  },
  'settings.update.provider': { zh: '更新源 (Provider)', en: 'Update Provider' },
  'settings.update.ownerRepo': { zh: '仓库 Owner / Repo', en: 'Repo Owner / Repo' },
  'settings.update.ownerPh': { zh: 'Owner，如 DanielCraig07', en: 'Owner, e.g. DanielCraig07' },
  'settings.update.repoPh': { zh: 'Repo，如 Echoly', en: 'Repo, e.g. Echoly' },
  'settings.update.token': { zh: '访问令牌 (Token)', en: 'Access Token' },
  'settings.update.tokenDesc': {
    zh: '用于私有仓库拉取更新（GitHub PAT，需该仓库 Contents: Read 权限）。留空表示公开仓库。',
    en: 'For pulling from private repos (GitHub PAT with Contents: Read). Leave empty for public repos.',
  },
  'settings.update.genericUrl': { zh: '更新服务器地址', en: 'Update Server URL' },
  'settings.update.check': { zh: '🔄 立即检查更新', en: '🔄 Check for Updates' },
  'settings.update.checking': { zh: '正在检查更新…', en: 'Checking for updates…' },
  'settings.update.checkOk': {
    zh: '已启动更新检查，请留意下载进度。',
    en: 'Update check started, watch download progress.',
  },
  'settings.update.checkFail': { zh: '检查更新失败：', en: 'Update check failed: ' },
  'settings.update.downloading': { zh: '下载更新中', en: 'Downloading update' },
  'settings.update.confirmTitle': { zh: '发现新版本', en: 'New Version Available' },
  'settings.update.versionLabel': { zh: '新版本：', en: 'Version:' },
  'settings.update.currentLabel': { zh: '当前版本', en: 'Current:' },
  'settings.update.confirmBtn': { zh: '是，立即更新', en: 'Yes, Update Now' },
  'settings.update.noNotes': { zh: '（该版本暂无更新说明）', en: '(No release notes)' },

  // 设置 - 关于作者
  'settings.about.title': { zh: '关于 Echoly 与开发者', en: 'About Echoly & Developer' },
  'settings.about.desc': {
    zh: '新一代基于原生大模型与本地智能代理深度融合的轻巧型智能开发环境。',
    en: 'Next-generation lightweight intelligent IDE deeply integrating LLMs and local agents.',
  },
  'settings.about.developer': { zh: '核心开发者', en: 'Core Developer' },
  'settings.about.authorName': { zh: 'Daniel', en: 'Daniel' },
  'settings.about.authorHandle': { zh: '@DanielCraig07', en: '@DanielCraig07' },
  'settings.about.authorBio': {
    zh: '专注现代智能开发工具与 AI Agent 架构研发，打造极速、轻量、无缝协同的新一代智能编程生产力环境。',
    en: 'Focused on modern developer tools & AI Agent architectures, building a blazing-fast, lightweight next-gen productivity IDE.',
  },
  'settings.about.version': { zh: '当前版本', en: 'Current Version' },
  'settings.about.authorGithub': { zh: '开发者主页', en: 'Developer Profile' },
  'settings.about.license': { zh: '软件授权', en: 'Software License' },
  'settings.about.licenseVal': { zh: '专有软件 (Proprietary)', en: 'Proprietary Software' },
  'settings.about.copyright': { zh: '版权所有', en: 'Copyright' },
  'settings.about.copyrightVal': {
    zh: '© 2026 Daniel. All rights reserved.',
    en: '© 2026 Daniel. All rights reserved.',
  },
  'settings.about.features': { zh: '核心特性', en: 'Core Highlights' },
  'settings.about.featAst': { zh: '毫秒级 AST 符号跳转', en: 'Instant AST Navigation' },
  'settings.about.featAstDesc': {
    zh: '内置 Tree-sitter，毫秒级跨文件定义跳转与符号引用查找。',
    en: 'Built-in Tree-sitter for millisecond cross-file definition & reference lookup.',
  },
  'settings.about.featAgent': { zh: 'AI Agent 深度共构', en: 'Deep AI Agent Co-Programming' },
  'settings.about.featAgentDesc': {
    zh: '支持 DeepSeek、Claude、GPT 及本地 Ollama，多步自主执行与工具放行安全拦截。',
    en: 'Supports DeepSeek, Claude, GPT & Ollama with autonomous multi-step execution.',
  },
  'settings.about.featRemote': { zh: '远程 SSH 统一开发', en: 'Remote SSH Development' },
  'settings.about.featRemoteDesc': {
    zh: '无缝连接远程云主机与 Linux 服务器，统一工作空间和远程终端。',
    en: 'Seamless connection to remote cloud Linux instances with unified workspace & terminal.',
  },
  'settings.about.systemInfo': { zh: '运行环境', en: 'Runtime Environment' },
  'settings.about.copyInfo': { zh: '复制环境信息', en: 'Copy Environment Info' },
  'settings.about.copied': { zh: '已复制到剪贴板', en: 'Copied to clipboard' },
  'settings.about.checkUpdate': { zh: '检查版本更新', en: 'Check for Updates' },

  // 通用
  'common.close': { zh: '关闭', en: 'Close' },
  'common.cancel': { zh: '取消', en: 'Cancel' },
  'common.confirm': { zh: '确定', en: 'Confirm' },
  'common.save': { zh: '保存', en: 'Save' },
  'common.search': { zh: '搜索', en: 'Search' },
  'common.loading': { zh: '加载中…', en: 'Loading…' },
  'common.probe': { zh: '⚡ 探测默认模型', en: '⚡ Probe default model' },
  'common.probing': { zh: '探测中…', en: 'Probing…' },
  'common.applySave': { zh: '应用并保存配置', en: 'Apply & Save' },
  'common.refresh': { zh: '刷新', en: 'Refresh' },
  'common.rebuild': { zh: '重建', en: 'Rebuild' },
  'common.build': { zh: '建立', en: 'Build' },

  // 状态栏（始终可见的底部栏）
  //
  // 这一组几乎全是 `title`（悬停提示）。它们看着不起眼，但对新用户来说
  // 「这个图标点了会发生什么」全靠它 —— 状态栏上一排十几个无文字图标，
  // 没有提示就只能靠逐个试。
  'status.remote': {
    zh: '远程连接与主机环境 · 点击连接 SSH 主机或配置服务器',
    en: 'Remote connection & host environment · Click to connect SSH or configure',
  },
  'status.branchLine': {
    zh: '当前 Git 分支: {branch} · 点击切换分支或标签',
    en: 'Current branch: {branch} · Click to switch branch or tag',
  },
  'status.branchLineDirty': {
    zh: '当前 Git 分支: {branch} (有未提交改动) · 点击切换分支或标签',
    en: 'Current branch: {branch} (uncommitted changes) · Click to switch branch or tag',
  },
  'status.dirty': { zh: '有未提交改动', en: 'Uncommitted changes' },
  'status.ahead': { zh: '{n} 个未推送提交', en: '{n} commits to push' },
  'status.behind': { zh: '{n} 个未拉取提交', en: '{n} commits to pull' },
  'status.sync': { zh: 'Git 仓库状态 · 点击立即刷新同步', en: 'Git status · Click to sync now' },
  'status.syncOk': { zh: 'Git 状态已同步', en: 'Git status synced' },
  'status.syncFail': { zh: 'Git 同步失败', en: 'Git sync failed' },
  'status.problems': {
    zh: '错误与警告 · 点击展开或折叠底部控制台与终端面板',
    en: 'Errors & warnings · Toggle bottom console and terminal',
  },
  'status.lastCommit': { zh: '最近提交:', en: 'Last commit:' },
  'status.cursor': {
    zh: '光标所在行与列 · 点击输入行号精准跳转',
    en: 'Cursor position · Click to jump to a line',
  },
  'status.line': { zh: '行', en: 'Ln' },
  'status.col': { zh: '列', en: 'Col' },
  'status.goto': { zh: '跳转到指定行', en: 'Go to Line' },
  'status.gotoRange': { zh: '范围 1 - ', en: 'Range 1 - ' },
  'status.gotoPh': { zh: '输入行号...', en: 'Enter line number...' },
  'status.jump': { zh: '跳转', en: 'Go' },
  'status.gotoEllipsis': { zh: '跳转到指定行...', en: 'Go to line...' },
  'status.indent': { zh: '缩进设置 · 点击更改缩进大小', en: 'Indentation · Click to change size' },
  'status.indentLabel': { zh: '空格:', en: 'Spaces:' },
  'status.spaces': { zh: ' 个空格', en: ' spaces' },
  'status.spacesRecommended': { zh: ' 个空格 (推荐)', en: ' spaces (recommended)' },
  'status.indentChanged': { zh: '缩进已更改为', en: 'Indentation changed to' },
  'status.encoding': { zh: '字符编码 · 点击切换当前编码', en: 'Encoding · Click to change' },
  'status.encodingTitle': { zh: '字符编码', en: 'Encoding' },
  'status.encodingUtf8': { zh: 'UTF-8 (推荐)', en: 'UTF-8 (recommended)' },
  'status.encodingGbk': {
    zh: 'GBK (简体中文 / Windows)',
    en: 'GBK (Simplified Chinese / Windows)',
  },
  'status.encodingChanged': { zh: '编码已选择为', en: 'Encoding set to' },
  'status.eol': {
    zh: '行尾换行序列 · 点击在 LF 与 CRLF 间快速切换',
    en: 'End of line · Click to toggle LF / CRLF',
  },
  'status.eolChanged': { zh: '行尾序列已切换为', en: 'End-of-line set to' },
  'status.language': {
    zh: '文件语言模式 · 点击切换语法模式与高亮',
    en: 'Language mode · Click to change syntax highlighting',
  },
  'status.languagePh': { zh: '搜索语言模式...', en: 'Search language modes...' },
  'status.stats': {
    zh: '文档统计数据 · 点击查看字数与行数统计详情',
    en: 'Document stats · Click for details',
  },
  'status.statsLines': { zh: '行', en: 'Ln' },
  'status.statsChars': { zh: '字数', en: 'Chars' },
  'status.statsTitle': { zh: '文档统计详情', en: 'Document Statistics' },
  'status.statsTotalLines': { zh: '总行数:', en: 'Total lines:' },
  'status.statsTotalChars': { zh: '总字符数:', en: 'Total characters:' },
  'status.statsCursor': { zh: '当前光标:', en: 'Cursor:' },
  'status.statsLine': { zh: ' 行', en: ' lines' },
  'status.statsChar': { zh: ' 字符', en: ' chars' },
  'status.statsAtLine': { zh: '第 ', en: 'Line ' },
  'status.statsAtCol': { zh: ' 行, 第 ', en: ', column ' },
  'status.statsAtColEnd': { zh: ' 列', en: '' },
  'status.statsPath': { zh: '文件路径:', en: 'File path:' },
  'status.untitled': { zh: '未命名', en: 'Untitled' },
  'status.copilotGenerating': {
    zh: 'AI Copilot 正在生成行内代码补全建议...',
    en: 'AI Copilot is generating inline completion...',
  },
  'status.copilotReady': {
    zh: 'AI Copilot 行内补全: 已就绪 (Tab 键采纳建议)',
    en: 'AI Copilot inline: Ready (Tab to accept)',
  },
  'status.copilotPaused': {
    zh: 'AI Copilot 行内补全: 已暂停 (点击启用)',
    en: 'AI Copilot inline: Paused (click to enable)',
  },
  'status.copilotOn': { zh: 'AI 行内代码补全已启用', en: 'Inline AI completion enabled' },
  'status.copilotOff': { zh: 'AI 行内代码补全已暂停', en: 'Inline AI completion paused' },
  'status.versionClick': { zh: ' · 点击检查版本更新', en: ' · Click to check for updates' },
  'status.devClick': { zh: ' · 点击查看关于作者与系统设置', en: ' · Click for about & settings' },
  'status.newVersion': { zh: '发现新版本 v', en: 'New version v' },
  'status.newVersionHint': {
    zh: '点击设置关于页面可下载更新',
    en: 'Open Settings → About to download',
  },
  'status.upToDate': { zh: '当前已是最新版本 (v', en: 'Already up to date (v' },
  'status.updateUnreachable': { zh: '无法连接更新服务器', en: 'Update server unreachable' },

  // 搜索面板
  'search.title': { zh: '搜索', en: 'Search' },
  'search.semanticOn': {
    zh: '语义搜索模式已启用（符号名 + 注释 + 代码体的 BM25 检索）',
    en: 'Semantic search enabled (BM25 over names, docs, bodies)',
  },
  'search.semanticOff': {
    zh: '开启 @codebase 自然语言搜索（本地 BM25 索引，非向量）',
    en: 'Enable @codebase search (local BM25 index, not vectors)',
  },
  'search.searching': { zh: '搜索中...', en: 'Searching...' },
  'search.noResults': { zh: '未找到匹配的结果', en: 'No matches found' },
  'search.indexing': { zh: '正在建立索引…', en: 'Building index…' },
  'search.indexProgress': {
    zh: '正在建立索引… {scanned}/{total} 个文件（{pct}%，复用 {reused}）',
    en: 'Building index… {scanned}/{total} files ({pct}%, {reused} reused)',
  },
  'search.indexMissing': {
    zh: '尚未建立索引，语义搜索会返回空结果。',
    en: 'No index yet — semantic search will return nothing.',
  },
  'search.indexSummary': {
    zh: '已索引 {files} 个文件 / {symbols} 个符号',
    en: 'Indexed {files} files / {symbols} symbols',
  },
  'search.rebuildTitle': {
    zh: '重新解析全部文件（不信任时间戳缓存）',
    en: 'Re-parse every file (ignore the timestamp cache)',
  },
  // 语序在中英文之间是反的（"Found 12 results in 3 files"），整句进字典而不是拼接
  'search.resultsSummary': {
    zh: '在 {files} 个文件中找到了 {matches} 个结果 ({mode})',
    en: 'Found {matches} results in {files} files ({mode})',
  },
  'search.modeTree': { zh: '树结构', en: 'tree' },
  'search.modeList': { zh: '列表模式', en: 'list' },
  'search.viewTree': { zh: '按树结构显示', en: 'Show as tree' },
  'search.viewList': { zh: '按列表显示', en: 'Show as list' },
  'search.expandAll': { zh: '全部展开', en: 'Expand all' },
  'search.collapseAll': { zh: '全部折叠', en: 'Collapse all' },
  'search.refresh': { zh: '刷新搜索', en: 'Refresh search' },
  'search.clear': { zh: '清空搜索结果', en: 'Clear results' },
  'search.searchPlaceholder': { zh: '搜索 (↑↓ 历史)', en: 'Search (↑↓ history)' },
  'search.searchPlaceholderTitle': {
    zh: '搜索 (使用 ↑↓ 查看历史记录)',
    en: 'Search (use ↑↓ for history)',
  },
  'search.caseSensitive': { zh: '区分大小写 (Alt+C)', en: 'Match case (Alt+C)' },
  'search.wholeWord': { zh: '全字匹配 (Alt+W)', en: 'Match whole word (Alt+W)' },
  'search.useRegex': { zh: '使用正则表达式 (Alt+R)', en: 'Use regular expression (Alt+R)' },
  'search.replacePlaceholder': { zh: '替换', en: 'Replace' },
  'search.preserveCase': { zh: '保留大小写', en: 'Preserve case' },
  'search.replaceAll': { zh: '全部替换 (Alt+Enter)', en: 'Replace all (Alt+Enter)' },
  'search.toggleReplace': { zh: '显示替换', en: 'Show replace' },
  'search.hideReplace': { zh: '隐藏替换', en: 'Hide replace' },
  'search.showFilters': { zh: '包含 / 排除的文件... ▼', en: 'Files to include / exclude... ▼' },
  'search.hideFilters': { zh: '隐藏过滤选项 ▲', en: 'Hide filter options ▲' },
  'search.filesToInclude': { zh: '包含的文件', en: 'Files to include' },
  'search.filesToExclude': { zh: '排除的文件', en: 'Files to exclude' },

  // 聊天：slash 命令下拉
  'chat.commandHeader': { zh: '命令模板 (/)', en: 'Command Templates (/)' },
  'chat.mentionHeader': { zh: '上下文引用与文件关联 (@)', en: 'Context References (@)' },
  'chat.suggestTip': {
    zh: '↑↓ 切换 · ↵ / Tab 采纳 · Esc 取消',
    en: '↑↓ navigate · ↵ / Tab accept · Esc cancel',
  },
  'chat.mentionGitDesc': {
    zh: '引用当前工作区 Git 变更与状态',
    en: 'Reference the workspace Git changes and status',
  },
  'chat.mentionTerminalDesc': {
    zh: '引用终端最近执行输出与报错',
    en: 'Reference recent terminal output and errors',
  },
  'chat.mentionProblemsDesc': {
    zh: '引用当前代码报错与诊断信息',
    en: 'Reference current errors and diagnostics',
  },
  // 占位文案里「@ 引用上下文，/ 调用命令」是必须被用户看到的功能指引，
  // 中英文括号与顿号都不同，所以整句进字典
  'chat.placeholderAsk': {
    zh: '提问关于代码的问题…（@ 引用上下文，/ 调用命令，Enter 发送）',
    en: 'Ask about the code… (@ to reference context, / for commands, Enter to send)',
  },
  'chat.placeholderPlan': {
    zh: '描述目标，生成可执行计划…（@ 引用上下文，/ 调用命令，Enter 发送）',
    en: 'Describe the goal to get a plan… (@ to reference context, / for commands, Enter to send)',
  },
  'chat.placeholderAgent': {
    zh: '描述任务…（@ 引用上下文，/ 调用命令，Enter 发送）',
    en: 'Describe the task… (@ to reference context, / for commands, Enter to send)',
  },
  'chat.placeholderRunning': {
    zh: 'AI 正在执行，输入内容将在当前步骤结束后追加给它…',
    en: 'AI is running — your input is queued until the current step finishes…',
  },
  'chat.needWorkspace': { zh: '请先打开工作区', en: 'Open a workspace first' },
  'chat.commandBadgeWorkspace': { zh: '工作区', en: 'Workspace' },
  'chat.commandBadgeUser': { zh: '用户', en: 'User' },
  'chat.commandBadgeBuiltin': { zh: '内置', en: 'Built-in' },
  'chat.commandEmpty': {
    zh: '没有找到命令。在上面的目录里新建一个 {fileName}，它就会出现在这里。',
    en: 'No commands found. Create a {fileName} in the directory above and it will show up here.',
  },
  // 路径与 $ARGUMENTS 要显示成等宽（它们是用户得原样敲进去的 token），
  // 所以这里用 {code} 占位符标出需要包 <code> 的片段，由 translateSegments 切出来。
  // 中英两种写法必须保持**同样的出现顺序**，否则切出来的片段会错位 —— 见下面对英文的改写。
  'chat.commandFooter': {
    zh: '工作区 {wsDir}（兼容 {cursorDir}、{deepseekDir}）或用户命令目录下的 {fileName}；正文里的 {args} 会被命令后的文字替换。',
    en: 'Workspace {wsDir} (also {cursorDir}, {deepseekDir}) or a {fileName} under the user commands dir; {args} in the body is replaced by the text after the command.',
  },

  // 欢迎页
  'welcome.subtitle': {
    zh: '选择一种方式打开项目，即刻开启全自动 Agent 辅助编程',
    en: 'Pick how to open a project and start agent-assisted coding right away',
  },
  'welcome.localTitle': { zh: '本地文件夹', en: 'Local Folder' },
  'welcome.localDesc': {
    zh: '打开本机已有目录作为工作区',
    en: 'Open an existing directory as the workspace',
  },
  'welcome.sshTitle': { zh: 'SSH 远程主机', en: 'SSH Host' },
  'welcome.sshDesc': {
    zh: '通过 SSH / SFTP 安全连接远程服务',
    en: 'Connect securely over SSH / SFTP',
  },
  'welcome.cloneTitle': { zh: '从 Git 克隆', en: 'Clone from Git' },
  'welcome.cloneDesc': {
    zh: '拉取远程代码仓库至本地并即刻就绪',
    en: 'Pull a remote repository locally, ready to go',
  },
  'welcome.wizardTitle': { zh: '新建标准工程向导', en: 'New Project Wizard' },
  'welcome.wizardDesc': {
    zh: '生成 Java、Python、Go、Node 或 C++ 标准开发与调试工程',
    en: 'Scaffold a Java, Python, Go, Node or C++ project with debug config',
  },
  'welcome.recent': { zh: '最近打开', en: 'Recent' },
  'welcome.clear': { zh: '清空', en: 'Clear' },
  'welcome.noRecent': { zh: '暂无历史记录', en: 'No history yet' },
  'welcome.kindLocal': { zh: '本地', en: 'Local' },
  'welcome.techTooltip': { zh: '智能识别技术栈: {label}', en: 'Detected stack: {label}' },
  'welcome.branchTooltip': { zh: '当前分支: {branch}', en: 'Current branch: {branch}' },
  // 「(3 个未提交修改)」跟在分支名后面，中英文括号与量词都不同，所以单独成条
  'welcome.branchDirty': { zh: ' ({n} 个未提交修改)', en: ' ({n} uncommitted)' },
  'welcome.removeRecent': { zh: '从记录中移除', en: 'Remove from history' },
  'welcome.viewAll': { zh: '查看全部（{n}）', en: 'View all ({n})' },
  'welcome.justNow': { zh: '刚刚', en: 'Just now' },
  'welcome.minutesAgo': { zh: '{n}分钟前', en: '{n} min ago' },
  'welcome.hoursAgo': { zh: '{n}小时前', en: '{n} h ago' },
  'welcome.daysAgo': { zh: '{n}天前', en: '{n} d ago' },

  // 文件树：右键菜单
  'tree.newFile': { zh: '新建文件...', en: 'New File...' },
  'tree.newFolder': { zh: '新建文件夹...', en: 'New Folder...' },
  'tree.openTerminal': { zh: '在集成终端中打开', en: 'Open in Integrated Terminal' },
  'tree.addToChat': { zh: '添加到聊天', en: 'Add to Chat' },
  'tree.addToNewChat': { zh: '在新对话中添加', en: 'Add to New Chat' },
  'tree.findInFolder': { zh: '在文件夹中查找...', en: 'Find in Folder...' },
  'tree.cut': { zh: '剪切', en: 'Cut' },
  'tree.copy': { zh: '复制', en: 'Copy' },
  'tree.paste': { zh: '粘贴', en: 'Paste' },
  'tree.rollback': { zh: '放弃更改 (Rollback)...', en: 'Discard Changes (Rollback)...' },
  'tree.copyPath': { zh: '复制路径', en: 'Copy Path' },
  'tree.copyRelativePath': { zh: '复制相对路径', en: 'Copy Relative Path' },
  'tree.revealInFinder': { zh: '在访达中显示', en: 'Reveal in Finder' },
  'tree.revealInExplorer': { zh: '在资源管理器中显示', en: 'Reveal in File Explorer' },
  'tree.rename': { zh: '重命名...', en: 'Rename...' },
  'tree.deletePermanently': { zh: '永久删除', en: 'Delete Permanently' },
  'tree.gitAnnotate': { zh: '显示 Git 追溯标注', en: 'Annotate with Git Blame' },
  'tree.gitShowDiff': { zh: '显示差异', en: 'Show Diff' },
  'tree.gitCompareRevision': { zh: '与历史版本对比...', en: 'Compare with Revision...' },
  'tree.gitCompareBranch': { zh: '与分支或标签对比...', en: 'Compare with Branch or Tag...' },
  'tree.gitHistory': { zh: '显示文件历史记录', en: 'Show File History' },
  'tree.gitCurrentRevision': { zh: '查看当前提交版本', en: 'Show Current Revision' },
  'tree.gitRollback': { zh: '回滚修改...', en: 'Rollback...' },
  'tree.folderName': { zh: '文件夹名', en: 'Folder name' },
  'tree.fileName': { zh: '文件名', en: 'File name' },
  'tree.emptyOpen': { zh: '打开一个工作区以浏览文件', en: 'Open a workspace to browse files' },
  // 文件名/路径不适合放进字典（它们是用户数据），但包着它们的句子不适合拼接，
  // 所以这类「动词 + 用户数据」的提示整句进字典，数据用占位符传入
  'tree.moveFailed': { zh: '无法移动', en: 'Cannot move' },
  // 拖动被拒的三种原因，键名与 validateMove 返回的 code 一一对应
  'tree.moveReject.move-into-self': {
    zh: '不能将文件/目录移动到自身',
    en: "Can't move an item onto itself",
  },
  'tree.moveReject.move-into-child': {
    zh: '不能将文件夹移动到自身的子文件夹中',
    en: "Can't move a folder into its own subfolder",
  },
  'tree.moveReject.already-in-target': { zh: '文件已在目标目录中', en: 'Already in that folder' },
  'tree.moveOk': { zh: '移动成功', en: 'Moved' },
  'tree.moveOkDetail': { zh: '已将 {name} 移动至 {target}', en: 'Moved {name} to {target}' },
  'tree.moveFail': { zh: '移动失败', en: 'Move failed' },
  'tree.rootDir': { zh: '根目录', en: 'root' },
  'tree.nameExistsFile': { zh: '已存在同名文件', en: 'A file with that name already exists' },
  'tree.nameExistsFolder': { zh: '已存在同名文件夹', en: 'A folder with that name already exists' },
  'tree.targetExists': { zh: '目标已存在', en: 'The target already exists' },
  'tree.operationFailed': { zh: '操作未完成', en: 'Operation failed' },
  'tree.deleteFolderTitle': { zh: '永久删除文件夹', en: 'Delete Folder Permanently' },
  'tree.deleteFileTitle': { zh: '永久删除文件', en: 'Delete File Permanently' },
  'tree.deleteFolderBody': {
    zh: '该文件夹及其**全部内容**会从磁盘上永久删除，**不进回收站、无法撤销**。',
    en: 'This folder and **everything inside it** will be permanently deleted from disk — **not to the trash, and not undoable**.',
  },
  'tree.deleteFileBody': {
    zh: '该文件会从磁盘上永久删除，**不进回收站、无法撤销**。',
    en: 'This file will be permanently deleted from disk — **not to the trash, and not undoable**.',
  },
  'tree.labelPath': { zh: '路径', en: 'Path' },
  'tree.labelType': { zh: '类型', en: 'Type' },
  'tree.typeFolderRecursive': { zh: '文件夹（递归删除）', en: 'Folder (recursive)' },
  'tree.confirmDelete': { zh: '确认删除', en: 'Delete' },

  // 文件树：文件夹内查找
  'findInFolder.title': { zh: '在文件夹中查找', en: 'Find in Folder' },
  'findInFolder.close': { zh: '关闭 (Esc)', en: 'Close (Esc)' },
  'findInFolder.filterPh': { zh: '按文件名或路径过滤…', en: 'Filter by file name or path…' },
  'findInFolder.clear': { zh: '清空', en: 'Clear' },
  'findInFolder.scanning': { zh: '正在扫描文件夹文件…', en: 'Scanning folder…' },
  'findInFolder.noMatch': { zh: '未找到匹配文件', en: 'No matching files' },
  'findInFolder.noFiles': { zh: '文件夹内暂无文件', en: 'No files in this folder' },
  'findInFolder.scanningShort': { zh: '扫描中…', en: 'Scanning…' },
  'findInFolder.count': { zh: '共 {n} 个文件', en: '{n} files' },
  // 三个动词拆开而不是整句进字典：键位图标 <kbd> 是 JSX 元素，
  // 而它们的位置在两种语言里是一样的（都是「键 → 动作」），拆开反而更好维护
  'findInFolder.navNav': { zh: '导航', en: 'navigate' },
  'findInFolder.navOpen': { zh: '打开', en: 'open' },
  'findInFolder.navClose': { zh: '关闭', en: 'close' },
  'findInFolder.closeBtn': { zh: '关闭', en: 'Close' },

  // 终端面板
  'terminal.brand': { zh: '终端', en: 'Terminal' },
  'terminal.kindSsh': { zh: 'SSH 远程', en: 'SSH Remote' },
  'terminal.kindLocal': { zh: '本地', en: 'Local' },
  // 标签名是「种类 + 序号」，两种语言的词序一致，但空格规则不同（中文数字前不加空格）
  'terminal.tabLabelSsh': { zh: 'SSH {n}', en: 'SSH {n}' },
  'terminal.tabLabelLocal': { zh: '本地 {n}', en: 'Local {n}' },
  'terminal.iconMaven': { zh: 'Maven 构建', en: 'Maven build' },
  'terminal.iconJava': { zh: 'Java 运行环境', en: 'Java runtime' },
  'terminal.iconSsh': { zh: 'SSH 远程主机', en: 'SSH host' },
  'terminal.iconShell': { zh: '终端会话', en: 'Terminal session' },
  'terminal.findPh': { zh: '在终端中查找...', en: 'Find in terminal...' },
  'terminal.findCase': { zh: '区分大小写 (Alt+C)', en: 'Match case (Alt+C)' },
  'terminal.findWord': { zh: '全字匹配 (Alt+W)', en: 'Match whole word (Alt+W)' },
  'terminal.findRegex': { zh: '使用正则表达式 (Alt+R)', en: 'Use regular expression (Alt+R)' },
  'terminal.findNoResult': { zh: '无结果', en: 'No results' },
  'terminal.findCount': { zh: '{n} 项', en: '{n} matches' },
  'terminal.findPrev': { zh: '上一个匹配项 (Shift+Enter)', en: 'Previous match (Shift+Enter)' },
  'terminal.findNext': { zh: '下一个匹配项 (Enter)', en: 'Next match (Enter)' },
  'terminal.findClose': { zh: '关闭搜索 (Esc)', en: 'Close search (Esc)' },
  'terminal.debugpyMissing': {
    zh: '⚠️  [Echoly 调试诊断] 当前 Python 环境未安装 debugpy 调试模块。',
    en: '⚠️  [Echoly debug] The current Python environment does not have the debugpy module installed.',
  },
  'terminal.debugpyHint': {
    zh: '💡 提示: 请在下方终端执行命令安装依赖后重试: pip3 install debugpy (或 python3 -m pip install debugpy)',
    en: '💡 Tip: install the dependency in the terminal below and retry: pip3 install debugpy (or python3 -m pip install debugpy)',
  },
  'terminal.debugpyMissingDetail': {
    zh: '当前 Python 环境缺少 debugpy 模块。请在终端执行: pip3 install debugpy',
    en: 'The current Python environment is missing the debugpy module. Run: pip3 install debugpy',
  },
  'terminal.findCaseShort': { zh: '区分大小写', en: 'Match case' },
  'terminal.findWordShort': { zh: '全字匹配', en: 'Whole word' },
  'terminal.findRegexShort': { zh: '正则表达式', en: 'Regular expression' },
  'terminal.findPrevShort': { zh: '上一个匹配项', en: 'Previous match' },
  'terminal.findNextShort': { zh: '下一个匹配项', en: 'Next match' },
  'terminal.copy': { zh: '复制', en: 'Copy' },
  'terminal.paste': { zh: '粘贴', en: 'Paste' },
  'terminal.selectAll': { zh: '全选', en: 'Select All' },
  'terminal.askAiSelection': {
    zh: '⚡️ 让 AI 诊断/修复选中内容',
    en: '⚡️ Ask AI to diagnose / fix selection',
  },
  'terminal.clearScreen': { zh: '清空屏幕 (Clear)', en: 'Clear Screen' },
  'terminal.askAiDiagnoseErr': { zh: '⚡️ AI 诊断报错', en: '⚡️ AI diagnose error' },
  'terminal.askAiTitle': {
    zh: '向 AI 咨询终端输出 / 诊断 (Ask AI)',
    en: 'Ask AI about terminal output',
  },
  'terminal.genCommandTitle': {
    zh: 'AI 生成并执行命令 (⌘K)',
    en: 'AI generate & run command (⌘K)',
  },
  'terminal.unsplit': { zh: '关闭分屏 (恢复单屏全宽)', en: 'Close split (back to single pane)' },
  'terminal.split': { zh: '拆分终端协同工作', en: 'Split terminal' },
  'terminal.splitToHorizontal': { zh: '切换为上下拆分', en: 'Switch to vertical split' },
  'terminal.splitToVertical': { zh: '切换为左右拆分', en: 'Switch to horizontal split' },
  'terminal.new': { zh: '新建终端', en: 'New Terminal' },
  'terminal.wrapOn': {
    zh: '自动换行: 已启用 (点击切换为单行横向滚动模式)',
    en: 'Word wrap: on (click for horizontal scrolling)',
  },
  'terminal.wrapOff': {
    zh: '自动换行: 已禁用 (点击启用自适应视口换行)',
    en: 'Word wrap: off (click to enable)',
  },
  'terminal.searchTitle': {
    zh: '在终端中搜索 (Ctrl+F / ⌘F)',
    en: 'Search in terminal (Ctrl+F / ⌘F)',
  },
  'terminal.scrollTop': { zh: '滚动到最上方 (Scroll to Top)', en: 'Scroll to top' },
  'terminal.scrollBottom': { zh: '滚动到最下方 (Scroll to Bottom)', en: 'Scroll to bottom' },
  'terminal.clearTitle': { zh: '清空终端内容 (Clear)', en: 'Clear terminal' },
  'terminal.killTab': { zh: '删除当前终端标签 (Kill)', en: 'Kill this terminal tab' },
  'terminal.closeTabTitle': { zh: '关闭终端标签', en: 'Close Terminal Tab' },
  'terminal.collapse': { zh: '折叠终端', en: 'Collapse terminal' },
  'terminal.removeTab': { zh: '删除终端标签', en: 'Remove terminal tab' },
  'terminal.dragSplitRatio': { zh: '拖动调整分屏比例', en: 'Drag to resize split' },
  'terminal.tipUp': { zh: '(上)', en: '(top)' },
  'terminal.tipDown': { zh: '(下)', en: '(bottom)' },
  'terminal.tipLeft': { zh: '(左)', en: '(left)' },
  'terminal.tipRight': { zh: '(右)', en: '(right)' },
  'terminal.labelTab': { zh: '标签', en: 'Tab' },
  'terminal.labelKind': { zh: '类型', en: 'Type' },
  'terminal.confirmCloseTab': { zh: '确认关闭', en: 'Close' },
  'terminal.closeTabBody': {
    zh: '这个终端会被销毁：**滚动的历史输出会丢失**，其中正在运行的进程也会被终止，且**无法撤销**。',
    en: 'This terminal will be destroyed: **its scrollback is lost**, any process still running in it is killed, and this **cannot be undone**.',
  },
  'terminal.portForwardOk': {
    zh: 'SSH 端口 :{port} 已建立本地隧道转发至 :{localPort}，点击在浏览器中打开',
    en: 'SSH port :{port} is tunneled to local port :{localPort} — click to open in browser',
  },
  'terminal.portForwardOffer': {
    zh: 'SSH 远程服务监听 :{port}，点击建立本地转发隧道并在浏览器中预览',
    en: 'SSH service listening on :{port} — click to forward it locally and preview',
  },
  'terminal.portLocalOk': {
    zh: '本地网络服务已在端口 :{port} 监听，点击在浏览器中打开 http://localhost:{port}',
    en: 'Local service listening on port :{port} — click to open http://localhost:{port}',
  },
  'terminal.errorBanner': {
    zh: '终端命令执行失败 (退出码 {code})，点击向 AI 求助诊断错误',
    en: 'Command failed (exit code {code}) — click to ask AI for help',
  },

  // 命令面板
  //
  // 这一组是**可搜索的**：用户敲「终端」或 "terminal" 都应当命中，
  // 所以标题必须跟着语言走，不能只翻界面上的固定文案。
  'cmd.categoryAi': { zh: 'AI', en: 'AI' },
  'cmd.categoryView': { zh: '视图', en: 'View' },
  'cmd.categoryTerminal': { zh: '终端', en: 'Terminal' },
  'cmd.categoryGit': { zh: 'Git', en: 'Git' },
  'cmd.categorySettings': { zh: '设置', en: 'Settings' },
  'cmd.categoryWorkspace': { zh: '工作区', en: 'Workspace' },
  'cmd.categoryRemote': { zh: '远程', en: 'Remote' },
  'cmd.categoryWindow': { zh: '窗口', en: 'Window' },
  'cmd.openComposer': {
    zh: 'Composer: 多文件智能重构协同编辑 (⌘I)',
    en: 'Composer: multi-file refactor editor (⌘I)',
  },
  'cmd.newChat': { zh: 'AI: 新建对话会话', en: 'AI: New Chat Session' },
  'cmd.toggleSidebar': { zh: '视图: 展开/折叠左侧边栏', en: 'View: Toggle Sidebar' },
  'cmd.toggleAi': { zh: '视图: 展开/折叠 AI 助手', en: 'View: Toggle AI Assistant' },
  'cmd.focusAi': { zh: 'AI: 提问 / 聚焦 AI 助手', en: 'AI: Ask / Focus AI Assistant' },
  'cmd.openBrowser': {
    zh: '视图: 打开内置浏览器 (Browser Preview)',
    en: 'View: Open Built-in Browser (Preview)',
  },
  'cmd.toggleTerminal': { zh: '终端: 展开/折叠底部控制台', en: 'Terminal: Toggle Bottom Console' },
  'cmd.newTerminal': { zh: '终端: 新建终端标签页', en: 'Terminal: New Terminal Tab' },
  'cmd.gitStatus': { zh: 'Git: 查看源代码版本控制', en: 'Git: Show Source Control' },
  'cmd.gitBranch': { zh: 'Git: 切换分支 / Tag 标签', en: 'Git: Switch Branch / Tag' },
  'cmd.gitPull': { zh: 'Git: 拉取远端更新 (Pull)', en: 'Git: Pull from Remote' },
  'cmd.gitDiscard': { zh: 'Git: 放弃工作区所有更改 (Discard All)', en: 'Git: Discard All Changes' },
  'cmd.gitHistory': { zh: 'Git: 查看当前文件提交历史', en: 'Git: File Commit History' },
  'cmd.gitLog': { zh: 'Git: 查看提交历史与图谱 (Commit Graph)', en: 'Git: Commit History & Graph' },
  'cmd.openSettings': {
    zh: '首选项: 打开 IDE 设置与多模型管理',
    en: 'Preferences: Open Settings & Model Management',
  },
  'cmd.switchWorkspace': {
    zh: '工作区: 打开或切换工作区目录',
    en: 'Workspace: Open or Switch Workspace',
  },
  'cmd.sshConnect': { zh: '工作区: 连接远程 SSH 主机', en: 'Workspace: Connect to SSH Host' },
  'cmd.cloneRepo': { zh: 'Git: 从远程 URL 克隆仓库 (Clone)', en: 'Git: Clone from Remote URL' },
  'cmd.reloadWindow': { zh: '窗口: 重载窗口 (Reload Window)', en: 'Window: Reload Window' },

  // 工具栏 / 面板标题
  'app.searchOrCommand': {
    zh: '搜索动作或文件 (⌘P / ⌘⇧P)',
    en: 'Search actions or files (⌘P / ⌘⇧P)',
  },
  'app.searchOrCommandWin': {
    zh: '搜索动作或文件 (Ctrl+P / Ctrl+Shift+P)',
    en: 'Search actions or files (Ctrl+P / Ctrl+Shift+P)',
  },
  'app.commandSearch': { zh: '命令 / 搜索', en: 'Commands / Search' },
  'app.collapseSidebar': { zh: '折叠左侧边栏 (⌘⇧B)', en: 'Collapse sidebar (⌘⇧B)' },
  'app.expandSidebar': { zh: '展开左侧边栏 (⌘⇧B)', en: 'Expand sidebar (⌘⇧B)' },
  'app.collapseSidebarWin': {
    zh: '折叠左侧边栏 (Ctrl+Shift+B)',
    en: 'Collapse sidebar (Ctrl+Shift+B)',
  },
  'app.expandSidebarWin': {
    zh: '展开左侧边栏 (Ctrl+Shift+B)',
    en: 'Expand sidebar (Ctrl+Shift+B)',
  },
  'app.collapseTerminal': { zh: '折叠底部终端 (⌘J)', en: 'Collapse bottom terminal (⌘J)' },
  'app.expandTerminal': { zh: '展开底部终端 (⌘J)', en: 'Expand bottom terminal (⌘J)' },
  'app.collapseTerminalWin': {
    zh: '折叠底部终端 (Ctrl+J)',
    en: 'Collapse bottom terminal (Ctrl+J)',
  },
  'app.expandTerminalWin': { zh: '展开底部终端 (Ctrl+J)', en: 'Expand bottom terminal (Ctrl+J)' },
  'app.collapseAi': { zh: '折叠右侧 AI 面板 (⌘B)', en: 'Collapse AI panel (⌘B)' },
  'app.expandAi': { zh: '展开右侧 AI 面板 (⌘B)', en: 'Expand AI panel (⌘B)' },
  'app.collapseAiWin': { zh: '折叠右侧 AI 面板 (Ctrl+B)', en: 'Collapse AI panel (Ctrl+B)' },
  'app.expandAiWin': { zh: '展开右侧 AI 面板 (Ctrl+B)', en: 'Expand AI panel (Ctrl+B)' },
  'app.browserTitle': { zh: '内置浏览器 (⌘⌥B)', en: 'Built-in browser (⌘⌥B)' },
  'app.browserTitleWin': { zh: '内置浏览器 (Ctrl+Alt+B)', en: 'Built-in browser (Ctrl+Alt+B)' },
  'app.settingsTitle': { zh: '设置 (⌘,)', en: 'Settings (⌘,)' },
  'app.settingsTitleWin': { zh: '设置 (Ctrl+,)', en: 'Settings (Ctrl+,)' },
  'app.remoteServer': { zh: '远程服务器 {host}', en: 'Remote server {host}' },
  'app.tabFiles': { zh: '文件', en: 'Files' },
  'app.tabSearch': { zh: '搜索', en: 'Search' },
  'app.tabSourceControl': { zh: '版本控制', en: 'Source Control' },
  'app.tabMaven': { zh: 'Maven 管理', en: 'Maven' },
  'app.tabDatabase': { zh: '轻量数据库', en: 'Database' },
  'app.locateCurrentFile': { zh: '定位当前文件 ({name})', en: 'Locate current file ({name})' },
  'app.locateCurrentFilePlain': { zh: '定位到当前打开的文件', en: 'Locate the current file' },
  'app.noOpenFile': { zh: '当前没有打开的文件', en: 'No file is currently open' },
  'app.located': { zh: '已定位: {name}', en: 'Located: {name}' },
  'app.newFile': { zh: '新建文件', en: 'New File' },
  'app.newFolder': { zh: '新建文件夹', en: 'New Folder' },
  'app.refreshTree': { zh: '刷新文件树', en: 'Refresh file tree' },
  'app.expandAll': { zh: '全部展开', en: 'Expand all' },
  'app.collapseAll': { zh: '全部折叠', en: 'Collapse all' },
  'app.resizeTree': { zh: '拖拽调整资源树宽度', en: 'Drag to resize the explorer' },
  'app.resizeBottom': { zh: '拖拽调整底栏高度', en: 'Drag to resize the bottom panel' },
  'app.resizeChat': { zh: '拖拽调整聊天面板宽度', en: 'Drag to resize the chat panel' },
  'app.terminalTab': { zh: '切换至终端面板', en: 'Show terminal' },
  'app.terminalTabLabel': { zh: '终端 (Terminal)', en: 'Terminal' },
  'app.debugTab': { zh: '切换至调试工作台', en: 'Show debug console' },
  'app.debugTabLabel': { zh: '调试控制台 (Debug)', en: 'Debug Console' },
  'app.problemsTab': { zh: '切换至代码问题与诊断面板', en: 'Show problems & diagnostics' },
  'app.problemsTabLabel': { zh: '问题 (Problems)', en: 'Problems' },
  'app.problemsCount': { zh: '共 {n} 处诊断', en: '{n} diagnostics' },
  'app.problemsNone': { zh: '未发现代码问题', en: 'No problems found' },
  'app.terminalKindSsh': { zh: '远程 SSH 终端', en: 'Remote SSH terminal' },
  'app.terminalKindLocal': { zh: '本地终端', en: 'Local terminal' },
  'app.debugPaused': { zh: '调试已暂停', en: 'Debugging paused' },
  'app.debugRunning': { zh: '调试进行中', en: 'Debugging' },
  'app.debugIdle': { zh: '未在调试 (就绪)', en: 'Not debugging (ready)' },
  'app.restorePanel': { zh: '还原面板高度', en: 'Restore panel height' },
  'app.maximizePanel': { zh: '最大化面板高度', en: 'Maximize panel height' },
  'app.collapsePanel': { zh: '折叠面板', en: 'Collapse panel' },
  'app.chatTab': { zh: 'AI 对话', en: 'AI Chat' },
  'app.claudeTab': { zh: 'Claude 扩展', en: 'Claude' },
  'app.jumpedToLine': { zh: '已跳转到第 {line} 行', en: 'Jumped to line {line}' },
  'app.languageChanged': { zh: '语言模式已切换为 {lang}', en: 'Language mode set to {lang}' },
  'app.copyHint': { zh: '复制提示内容', en: 'Copy prompt content' },
  'app.viewFullDetail': { zh: '弹窗查看完整详情', en: 'View full details' },
  'app.copiedFull': { zh: '✓ 已复制完整内容', en: '✓ Full content copied' },
  'app.copyContent': { zh: '复制内容', en: 'Copy content' },
  'app.browserTab': { zh: '内置浏览器', en: 'Built-in Browser' },
  'app.newTab': { zh: '新标签页', en: 'New Tab' },
  'app.terminalTitle': { zh: '终端: {name}', en: 'Terminal: {name}' },
  'app.runCommand': { zh: '运行命令', en: 'Run Command' },
  'app.debugStartFailed': { zh: '⚠️ 调试启动失败', en: '⚠️ Failed to start debugging' },
  'app.debugMissingDebugpy': {
    zh: '⚠️ Python 缺少 debugpy 模块',
    en: '⚠️ Python is missing the debugpy module',
  },
  'app.previewImageFailed': { zh: '无法预览图片：{msg}', en: 'Cannot preview image: {msg}' },
  'app.saveOutsideWorkspace': {
    zh: '请将文件保存到当前工作区内',
    en: 'Save the file inside the current workspace',
  },
  'app.cannotWriteWorkspace': {
    zh: '当前无法写入工作区，请先打开文件夹',
    en: 'Cannot write to the workspace — open a folder first',
  },
  'app.openWorkspaceToSave': {
    zh: '请先打开工作区后再保存未命名文件',
    en: 'Open a workspace before saving an untitled file',
  },
  'app.sshWorkspaceSwitched': { zh: '✓ 已切换远程工作区', en: '✓ Remote workspace switched' },
  'app.sshWorkspaceSwitchFailed': {
    zh: '✕ 切换远程工作区失败',
    en: '✕ Failed to switch remote workspace',
  },
  'app.sshWorkspaceConnected': { zh: '✓ 已连接远程工作区', en: '✓ Remote workspace connected' },
  'app.sshWorkspaceConnectFailed': {
    zh: '✕ 连接远程工作区失败',
    en: '✕ Failed to connect remote workspace',
  },
  'app.debugTerminated': { zh: '调试已终止', en: 'Debugging terminated' },
  'app.openScriptFailed': { zh: '打开脚本失败', en: 'Failed to open script' },

  // 渲染错误兜底页（components/ErrorBoundary.tsx）
  'errorBoundary.title': { zh: '应用遇到渲染错误', en: 'The app hit a rendering error' },
  'errorBoundary.panelTitle': { zh: '{name} 无法显示', en: '{name} could not be displayed' },
  'errorBoundary.hint': {
    zh: '界面某处渲染失败了。其他面板仍可正常使用；若整块界面都没有反应，请刷新页面。',
    en: 'Something in the UI failed to render. Other panels still work; if the whole window is unresponsive, reload the page.',
  },
  'errorBoundary.reload': { zh: '刷新页面', en: 'Reload page' },

  // 通用危险操作确认
  'app.confirmClearRecent': { zh: '确认清空', en: 'Clear' },
  'app.clearRecentTitle': { zh: '清空最近打开记录', en: 'Clear Recent Workspaces' },
  'app.clearRecentIntro': {
    zh: '全部最近打开记录都会被清除，且**无法撤销**。',
    en: 'The entire recent-workspaces list will be cleared and this **cannot be undone**.',
  },
  'app.clearRecentNotes': {
    zh: '只清空这份列表，**磁盘上的项目文件不受影响**；需要时重新打开目录即可。',
    en: 'Only this list is cleared — **the project files on disk are untouched**; just reopen the folder if you need it.',
  },
  'app.clearRecentNotes2': {
    zh: '各项目记录的文件树展开状态与已打开文件列表会一并清除。',
    en: 'Remembered tree expansion state and open-file lists for each project are cleared too.',
  },
  'app.labelCount': { zh: '数量', en: 'Count' },
  'app.countRecords': { zh: '{n} 条记录', en: '{n} entries' },
  'app.closeWorkspaceTitle': { zh: '关闭工作区', en: 'Close Workspace' },
  'app.closeWorkspaceIntro': {
    zh: '关闭后**未保存的修改会丢失**，且**无法撤销**。',
    en: 'After closing, **unsaved changes are lost** and this **cannot be undone**.',
  },
  'app.closeWorkspaceNotes': {
    zh: '已保存到磁盘的内容不受影响，重新打开工作区即可继续。',
    en: 'Content already saved to disk is unaffected — reopen the workspace to continue.',
  },
  'app.labelUnsaved': { zh: '未保存', en: 'Unsaved' },
  'app.labelFile': { zh: '文件', en: 'File' },
  'app.moreFiles': { zh: '…另有 {n} 个文件', en: '…and {n} more files' },
  'app.confirmCloseAnyway': { zh: '仍然关闭', en: 'Close Anyway' },
  'app.confirmDiscardAll': { zh: '确认放弃', en: 'Discard' },
  'app.discardAllTitle': { zh: '放弃全部未提交修改', en: 'Discard All Uncommitted Changes' },
  'app.discardFilesTitle': { zh: '放弃 {n} 个文件的修改', en: 'Discard changes in {n} files' },
  'app.discardTitle': { zh: '放弃更改', en: 'Discard Changes' },
  'app.discardAllIntro': {
    zh: '工作区中**所有未提交的修改**都会被还原到 HEAD，且**无法撤销**。',
    en: '**Every uncommitted change** in the workspace is reverted to HEAD and this **cannot be undone**.',
  },
  'app.discardOneIntro': {
    zh: '该文件未提交的修改会被还原到 HEAD，且**无法撤销**。',
    en: "This file's uncommitted changes are reverted to HEAD and this **cannot be undone**.",
  },
  'app.discardNote': {
    zh: '已暂存（git add）但尚未提交的改动也会一并还原。',
    en: 'Changes already staged with git add are reverted too.',
  },
  'app.labelScope': { zh: '范围', en: 'Scope' },
  'app.scopeAllDirty': {
    zh: '工作区中全部未提交的修改',
    en: 'All uncommitted changes in the workspace',
  },
  'app.scopeFileCount': { zh: '{n} 个文件', en: '{n} files' },
  'app.discardFailed': { zh: '放弃修改失败', en: 'Discard failed' },
  'app.gitRestoreFailed': { zh: 'Git 还原失败', en: 'git restore failed' },
  'app.discardedOk': { zh: '✓ 已放弃修改', en: '✓ Changes discarded' },
  'app.discardedOkDetail': { zh: '已恢复至 Git 最新提交版本', en: 'Reverted to the latest commit' },
  'app.diffTitle': { zh: 'Git 本地更改(工作树) - {path}', en: 'Git working-tree changes - {path}' },
  'app.diffOriginal': { zh: '最新提交 (HEAD)', en: 'Latest commit (HEAD)' },
  'app.diffModified': { zh: '当前工作区 (未提交更改)', en: 'Working tree (uncommitted)' },
  'app.diffToHead': { zh: 'Git 对比', en: 'Git diff' },
  'app.diffNoChange': {
    zh: '当前文件与最新提交 (HEAD) 无差异',
    en: 'No difference between this file and HEAD',
  },
  'app.diffFailed': { zh: '获取差异失败', en: 'Failed to get diff' },
  'app.diffFailedDetail': { zh: '无法对比该文件', en: 'Cannot diff this file' },
  'app.blameTitle': { zh: 'Git 追溯 (Blame)', en: 'Git Blame' },
  'app.blameOff': { zh: '已关闭代码追溯标注', en: 'Blame annotations turned off' },
  'app.blameOn': { zh: '已开启代码追溯标注栏', en: 'Blame annotation gutter turned on' },
  'app.headSnapshot': { zh: 'Git 当前版本', en: 'Git HEAD revision' },
  'app.headSnapshotLoaded': {
    zh: '已载入 {name} 的 HEAD 提交快照 (只读)',
    en: 'Loaded the HEAD snapshot of {name} (read-only)',
  },
  'app.headSnapshotFailed': { zh: '无法查看当前版本', en: 'Cannot show the current revision' },
  'app.headSnapshotFailedDetail': {
    zh: '版本库中未找到该文件',
    en: 'The repository does not track this file',
  },
  'app.noFileHistory': { zh: '无法查看文件历史', en: 'Cannot show file history' },
  'app.noFileHistoryDetail': {
    zh: '请先在编辑器中打开一个文件',
    en: 'Open a file in the editor first',
  },
  'app.deleteScriptTitle': { zh: '删除查询脚本', en: 'Delete Query Script' },
  'app.deleteScriptIntro': {
    zh: '这个脚本文件会从磁盘上删除，且**无法撤销**。',
    en: 'This script file is deleted from disk and this **cannot be undone**.',
  },
  'app.labelName': { zh: '名称', en: 'Name' },
  'app.labelFilePath': { zh: '路径', en: 'Path' },
  'app.confirmDeleteScript': { zh: '确认删除', en: 'Delete' },
  'app.scriptDeleted': { zh: '已删除脚本', en: 'Script deleted' },
  'app.scriptDeleteFailed': { zh: '删除脚本失败', en: 'Failed to delete script' },
};

/**
 * 完整字典 = 主表 + i18nParts/* 各领域分片。
 *
 * 拆分的理由见 i18nParts/README.md：铺开阶段多个改动并行加 key，集中在同一个对象里必然冲突。
 * 后加的分片覆盖先加的 —— 分片之间 key 不应重复，重复由 test/i18n.test.ts 兜底。
 */
/** 各领域分片，键是分片名 —— 供 test/i18n.test.ts 检查 key 不跨片重复 */
export const DICT_PARTS: Record<string, Record<string, { zh: string; en: string }>> = {
  git: gitDict,
  chat: chatDict,
  editor: editorDict,
  db: dbDict,
  runtime: runtimeDict,
  misc: miscDict,
  settings: settingsDict,
};

export const DICT: Record<string, { zh: string; en: string }> = {
  ...CORE_DICT,
  ...gitDict,
  ...chatDict,
  ...editorDict,
  ...dbDict,
  ...runtimeDict,
  ...miscDict,
  ...settingsDict,
};

export function getLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
    return saved === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

export function persistLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* ignore */
  }
}

export function translate(key: string, locale: Locale): string {
  const entry = DICT[key];
  if (!entry) return key;
  return entry[locale] ?? entry.zh;
}

/**
 * 带参数插值的翻译。
 *
 * 为什么需要它：中英文的**语序不同**。「在 3 个文件中找到了 12 个结果」翻成英文是
 * "Found 12 results in 3 files" —— 数字出现的顺序反过来了。用「中文串 + 数字 + 中文串」
 * 拼接的写法在这种情况下只能二选一地出错，所以整句连同 `{占位符}` 一起放进字典。
 *
 * 未在 params 里给出的占位符原样保留：这样字典写错时，界面上显示的是
 * `{count}` 这种一眼能认出的东西，而不是一个悄悄消失的空洞。
 */
export function translateWith(
  key: string,
  locale: Locale,
  params: Record<string, string | number>,
): string {
  return translate(key, locale).replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

export interface TextSegment {
  text: string;
  /** 这一段在源文案里被 `{...}` 包住，调用方应当渲染成等宽/强调样式。 */
  emphasis: boolean;
}

/**
 * 把带占位符的句子切成「普通文本 / 强调片段」两段式的数组。
 *
 * 为什么不能像以前那样直接在 JSX 里拼 `<code>`：一旦把 `<code>` 写进 JSX，
 * 整句话就被钉死在中文语序上了（`工作区 <code>X</code>（兼容 ...）`）。
 * 英文里路径出现的位置和数量都可能不同，只有整句进字典才能让两种语言各自成立。
 *
 * 相邻的普通文本会合并，避免 React 因为一堆无意义的相邻节点反复重建。
 * 未配对的花括号（比如代码片段里的 `{`）按普通文本原样输出，不会被吃掉。
 */
export function translateSegments(
  key: string,
  locale: Locale,
  params: Record<string, string | number>,
): TextSegment[] {
  const raw = translate(key, locale);
  const segments: TextSegment[] = [];
  const push = (text: string, emphasis: boolean) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last && last.emphasis === emphasis) last.text += text;
    else segments.push({ text, emphasis });
  };
  const pattern = /\{(\w+)\}/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(raw)) !== null) {
    push(raw.slice(cursor, m.index), false);
    // 漏传参数时保留 `{name}` 原样，和 translateWith 保持一致：
    // 界面上露出一眼能认出的占位符，好过悄悄少一段信息
    push(m[1] in params ? String(params[m[1]]) : m[0], true);
    cursor = m.index + m[0].length;
  }
  push(raw.slice(cursor), false);
  return segments;
}

/**
 * 翻译函数的类型。
 *
 * 单独导出是因为有一批**纯函数**（相对时间格式化、标签命名）拿不到 hook，
 * 只能在调用时把 t 传进去。给它们一个名字好过到处写
 * `(key: string, params?: Record<string, string | number>) => string`。
 */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

interface I18nValue {
  locale: Locale;
  /** 带插值：`t('x', { n: 3 })` 会把字典里的 `{n}` 换掉。 */
  t: Translate;
  setLocale: (l: Locale) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

/** 提供全局 locale 的 Provider，包裹整个应用。 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => getLocale());

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) =>
      params ? translateWith(key, locale, params) : translate(key, locale),
    [locale],
  );
  const setLocale = useCallback((l: Locale) => {
    persistLocale(l);
    setLocaleState(l);
  }, []);

  const value = useMemo<I18nValue>(() => ({ locale, t, setLocale }), [locale, t, setLocale]);
  return createElement(I18nContext.Provider, { value }, children);
}

/** React hook：返回当前语言与切换方法。 */
export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // 兜底：未包裹 Provider 时用本地 state，避免抛错。
    return useLocalFallback();
  }
  return ctx;
}

function useLocalFallback(): I18nValue {
  const [locale, setLocaleState] = useState<Locale>(() => getLocale());
  const t = useCallback(
    (key: string, params?: Record<string, string | number>) =>
      params ? translateWith(key, locale, params) : translate(key, locale),
    [locale],
  );
  const setLocale = useCallback((l: Locale) => {
    persistLocale(l);
    setLocaleState(l);
  }, []);
  return { locale, t, setLocale };
}
