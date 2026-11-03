/**
 * 左侧栏的面板清单（活动栏图标 + 「更多面板」菜单共用一份定义）。
 *
 * 单一来源的理由：这两个地方展示的是同一批面板，只是形态不同（图标 vs 带名字的列表）。
 * 各写一份时最典型的结果是「菜单里有一个面板，活动栏上却没有对应图标」——
 * 或者反过来，图标点开是空的。定义只此一份，两边都从这里渲染。
 */

import { DEFAULT_PINNED_PANELS, type LeftPanelId } from '@deepseek-ide/shared';

export type { LeftPanelId };
// 默认固定列表定义在 shared（它要跟着 LayoutSettings 一起持久化），
// 这里再导出一次，让调用方只需要认这一个模块。
export { DEFAULT_PINNED_PANELS };

export interface LeftPanelDef {
  id: LeftPanelId;
  /** 显示名的 i18n key */
  labelKey: string;
  /**
   * 真实存在的快捷键。**没有对应快捷键的面板不要写这里** ——
   * 菜单里印一个按不出效果的组合键，和挂一个点不动的按钮是一回事。
   */
  shortcut?: { mac: string; other: string };
  /** 只在 Maven 项目里有意义的面板 */
  mavenOnly?: boolean;
  /** 不参与活动栏与菜单（有意停用 / 内部面板） */
  hidden?: boolean;
}

export const LEFT_PANEL_DEFS: LeftPanelDef[] = [
  {
    id: 'explorer',
    labelKey: 'app.tabFiles',
    shortcut: { mac: '⌘⇧E', other: 'Ctrl+Shift+E' },
  },
  {
    id: 'search',
    labelKey: 'app.tabSearch',
    shortcut: { mac: '⌘⇧F', other: 'Ctrl+Shift+F' },
  },
  {
    id: 'git',
    labelKey: 'app.tabSourceControl',
    shortcut: { mac: '⌘⇧G', other: 'Ctrl+Shift+G' },
  },
  {
    id: 'extensions',
    labelKey: 'app.tabExtensions',
    shortcut: { mac: '⌘⇧X', other: 'Ctrl+Shift+X' },
  },
  { id: 'maven', labelKey: 'app.tabMaven', mavenOnly: true },
  { id: 'database', labelKey: 'app.tabDatabase' },
  { id: 'agent-tasks', labelKey: 'app.tabAgentTasks', hidden: true },
];

/** 当前上下文里可用的面板（按定义顺序）。 */
export function availablePanels(isMavenProject: boolean): LeftPanelDef[] {
  return LEFT_PANEL_DEFS.filter((def) => !def.hidden && (!def.mavenOnly || isMavenProject));
}

/**
 * 把存档里的固定列表收敛成当前可用的形状。
 *
 * 存档是上一台机器 / 上一个项目写下的：可能含已停用的面板、未知 id、
 * 重复项，也可能是空的（用户全取消了固定）。这里一律过滤而不是相信它 ——
 * 一个未知 id 渲染出来就是一个点不动的图标。
 */
export function normalizePinned(pinned: unknown, isMavenProject: boolean): LeftPanelId[] {
  const known = new Set(availablePanels(isMavenProject).map((def) => def.id));
  if (!Array.isArray(pinned)) return [...DEFAULT_PINNED_PANELS];
  const out: LeftPanelId[] = [];
  for (const raw of pinned) {
    if (typeof raw !== 'string') continue;
    const id = raw as LeftPanelId;
    if (!known.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * 切换某个面板的固定状态。
 *
 * 允许取消到「一个都不剩」：活动栏上至少还有 chevron，菜单里仍能进所有面板，
 * 所以这不构成死路。硬性保留一个反而会让「取消固定」这个动作时灵时不灵。
 */
export function togglePinned(
  pinned: LeftPanelId[],
  id: LeftPanelId,
  isMavenProject: boolean,
): LeftPanelId[] {
  const base = normalizePinned(pinned, isMavenProject);
  return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
}
