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

export type Locale = 'zh' | 'en';

export const LOCALE_STORAGE_KEY = 'echoly_locale';

const DICT: Record<string, { zh: string; en: string }> = {
  'app.name': { zh: 'Echoly', en: 'Echoly' },

  // 面板标题
  'panel.explorer': { zh: '资源管理器', en: 'Explorer' },
  'panel.project': { zh: '项目', en: 'Project' },
  'panel.sourceControl': { zh: '源代码管理', en: 'Source Control' },
  'panel.extensions': { zh: '扩展', en: 'Extensions' },
  'panel.settings': { zh: '设置', en: 'Settings' },
  'panel.chat': { zh: 'AI 助手', en: 'AI Assistant' },
  'panel.terminal': { zh: '终端', en: 'Terminal' },
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
  'settings.about.copyrightVal': { zh: '© 2026 Daniel. All rights reserved.', en: '© 2026 Daniel. All rights reserved.' },
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

interface I18nValue {
  locale: Locale;
  t: (key: string) => string;
  setLocale: (l: Locale) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

/** 提供全局 locale 的 Provider，包裹整个应用。 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => getLocale());

  const t = useCallback((key: string) => translate(key, locale), [locale]);
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
  const t = useCallback((key: string) => translate(key, locale), [locale]);
  const setLocale = useCallback((l: Locale) => {
    persistLocale(l);
    setLocaleState(l);
  }, []);
  return { locale, t, setLocale };
}
