/**
 * 轻量级 i18n：中英文切换。
 *
 * 采用极简字典方案（无第三方依赖），默认中文（符合项目约定）。
 * 通过 localStorage 记住语言选择，提供 `t()` 与 React hook `useI18n()`。
 */
import { useCallback, useState } from 'react';

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

  // 设置
  'settings.general': { zh: '通用', en: 'General' },
  'settings.model': { zh: '模型', en: 'Model' },
  'settings.language': { zh: '界面语言', en: 'Display Language' },
  'settings.language.zh': { zh: '中文', en: 'Chinese' },
  'settings.language.en': { zh: 'English', en: 'English' },
  'settings.theme': { zh: '主题', en: 'Theme' },
  'settings.theme.dark': { zh: '深色', en: 'Dark' },
  'settings.theme.light': { zh: '浅色', en: 'Light' },
  'settings.autosave': { zh: '自动保存', en: 'Auto Save' },
  'settings.maxSteps': { zh: '最大 Agent 步数', en: 'Max Agent Steps' },
  'settings.permission': { zh: '权限模式', en: 'Permission Mode' },
  'settings.warning': { zh: '设置', en: 'Settings' },

  // 通用
  'common.close': { zh: '关闭', en: 'Close' },
  'common.cancel': { zh: '取消', en: 'Cancel' },
  'common.confirm': { zh: '确定', en: 'Confirm' },
  'common.save': { zh: '保存', en: 'Save' },
  'common.search': { zh: '搜索', en: 'Search' },
  'common.loading': { zh: '加载中…', en: 'Loading…' },
};

export function getLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
    return saved === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

export function setLocale(locale: Locale): void {
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

/** React hook：返回当前语言与切换方法，并触发重渲染。 */
export function useI18n(): {
  locale: Locale;
  t: (key: string) => string;
  setLocale: (l: Locale) => void;
} {
  const [locale, setLocaleState] = useState<Locale>(() => getLocale());
  const t = useCallback((key: string) => translate(key, locale), [locale]);
  const changeLocale = useCallback((l: Locale) => {
    setLocale(l);
    setLocaleState(l);
  }, []);
  return { locale, t, setLocale: changeLocale };
}
