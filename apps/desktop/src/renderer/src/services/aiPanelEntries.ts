/**
 * 标题栏那几个「AI 面板入口」该是哪些 —— 纯逻辑，单独放出来是为了能直接测。
 *
 * 规则：
 * - **一个扩展一个入口**。一个扩展可能贡献好几个视图（Claude 就有三个：侧栏、
 *   次级侧栏、会话列表），标题栏上摆三个几乎一样的图标只会让人更糊涂。
 * - 取「已经固定到 AI 面板的那个」，没有固定的就取它注册的第一个。别的视图仍旧
 *   能从扩展详情页固定 / 打开。
 * - 入口**不要求先固定**：装了就出现，点一下才固定并展开右侧面板。
 *   踩过的坑：以前入口是从「固定列表」推出来的，于是装完扩展还得先去扩展面板点一次
 *   「打开」，右上角才会冒出图标 —— 用户完全看不出这两件事有关。
 */

export interface AiPanelEntry {
  viewId: string;
  title: string;
  extensionId: string;
  /** 扩展此刻有没有真的跑起来。没跑起来的入口点了是空的，不摆。 */
  available: boolean;
  icon?: string;
}

/** 主进程 `listInstalledExtensions()` 回来的一条（只用到这几项）。 */
export interface InstalledForEntries {
  id: string;
  displayName: string;
  active?: boolean;
  enabled?: boolean;
  views?: { id: string; name?: string; icon?: string }[];
}

export function buildAiPanelEntries(
  installed: InstalledForEntries[],
  pinnedViewIds: string[],
  activeExtensionIds: Set<string>,
): AiPanelEntry[] {
  const entries: AiPanelEntry[] = [];
  for (const extension of installed) {
    // 被禁用的扩展不显示右上角入口
    if (extension.enabled === false) continue;
    const views = extension.views ?? [];
    if (views.length === 0) continue;
    const preferred = views.find((view) => pinnedViewIds.includes(view.id)) ?? views[0];
    const isRunning =
      Boolean(extension.active) || activeExtensionIds.has(extension.id.toLowerCase());
    entries.push({
      viewId: preferred.id,
      title: preferred.name || extension.displayName,
      extensionId: extension.id,
      available: isRunning,
      icon: preferred.icon,
    });
  }
  return entries;
}
