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

  // 设置 - 通用文案
  'settings.title': { zh: '偏好设置', en: 'Preferences' },
  'settings.language': { zh: '界面语言', en: 'Display Language' },
  'settings.language.zh': { zh: '中文', en: 'Chinese' },
  'settings.language.en': { zh: 'English', en: 'English' },
  'settings.theme': { zh: '界面主题 (Theme)', en: 'Interface Theme' },
  'settings.theme.dark': { zh: '深色极客 Dark (默认)', en: 'Dark (default)' },
  'settings.theme.light': { zh: '浅色雅致 Light', en: 'Light' },
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
  'settings.update.tokenHow': {
    zh: '如何获取 Token：登录 GitHub → 右上角头像 → Settings → Developer settings → Personal access tokens → Generate new token（建议选 Fine-grained，仅勾选本仓库的 Contents: Read 权限），生成后粘贴到下方。',
    en: 'How to get a token: GitHub → Settings → Developer settings → Personal access tokens → Generate new token (recommend Fine-grained, only Contents: Read for this repo), then paste it below.',
  },
  'settings.update.genericUrl': { zh: '更新服务器地址', en: 'Update Server URL' },
  'settings.update.check': { zh: '🔄 立即检查更新', en: '🔄 Check for Updates' },
  'settings.update.checkOk': {
    zh: '已启动更新检查，请留意下载进度。',
    en: 'Update check started, watch download progress.',
  },
  'settings.update.checkFail': { zh: '检查更新失败：', en: 'Update check failed: ' },

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
