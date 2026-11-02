/**
 * 把文档源能力装成注入给 Agent 的 `ctx.docs`。
 *
 * 与 `createWebToolHost` 并列而不是合并：两者的授权模型不同。
 * 联网工具面向**开放网络**（任意检索），由「允许联网」开关控制；
 * 文档源是用户**点名信任的几个站点**，`read_doc` 只在这些站的同源地址上取页面。
 * 混成一个 host 之后，这个边界就要靠调用方记得加判断，而「忘了加」不会有任何报错。
 *
 * 取数复用 `fetchWebPage` —— SSRF 防护、逐跳重定向校验、字节上限都在那一层。
 */

import { homedir } from 'node:os';
import { DEFAULT_URL_POLICY, type UrlPolicy } from '@deepseek-ide/tools';
import type { AppSettings } from '@deepseek-ide/shared';
import {
  DocsService,
  isUnderSources,
  type DocSourceConfig,
  type DocSourceStatus,
} from './docsService';
import { fetchWebPage } from './webService';

/** 与索引缓存共用目录：都是纯派生数据，用户想清掉整个 `~/.echoly/docs` 即可。 */
export function docsCacheDir(homeDir: string): string {
  return `${homeDir}/.echoly/docs`;
}

/** 只保留填写完整的来源；半条配置只会让检索结果莫名其妙地少。 */
export function configuredDocSources(settings: AppSettings): DocSourceConfig[] {
  return (settings.docSources ?? []).filter(
    (source) => source?.url?.trim() && source?.name?.trim(),
  );
}

function createDocsService(settings: AppSettings, homeDir?: string): DocsService {
  const policy: UrlPolicy = {
    ...DEFAULT_URL_POLICY,
    allowedPrivateHosts: settings.webAllowedHosts ?? [],
  };
  return new DocsService({
    cacheDir: docsCacheDir(homeDir ?? homedir()),
    fetchPage: (url: string) => fetchWebPage(url, { policy }),
  });
}

/**
 * 检查各文档源是否可用（设置页的「检查」按钮）。
 *
 * 单独开一个入口而不是让设置页自己拼请求：判断「这个站有没有 llms.txt」
 * 和对齐缓存目录的逻辑都在这儿，两处各写一遍迟早会出现「设置页说没问题、
 * Agent 却搜不到」的错位。
 */
export async function checkDocsSources(
  settings: AppSettings,
  homeDir?: string,
  options: { force?: boolean } = {},
): Promise<DocSourceStatus[]> {
  const sources = configuredDocSources(settings);
  if (sources.length === 0) return [];
  return await createDocsService(settings, homeDir).statuses(sources, options);
}

export function createDocsToolHost(settings: AppSettings, homeDir?: string) {
  const sources = configuredDocSources(settings);
  if (sources.length === 0) return undefined;
  // 隐私模式切断一切额外出网，文档源也不例外 —— 否则「隐私模式」就有了一条
  // 用户没预期的绕过路径（只要配过文档源，就仍然在往那些站点发请求）。
  if (settings.privacyMode === true) return undefined;

  const service = createDocsService(settings, homeDir);

  return {
    search: async (query: string, limit?: number) => {
      const hits = await service.search(sources, query, limit ?? 8);
      return hits.map((hit) => ({
        source: hit.source,
        title: hit.title,
        url: hit.url,
        description: hit.description,
        section: hit.section,
      }));
    },
    read: async (url: string) => {
      // 只允许读用户登记过的站：`read_doc` 收的是模型给的任意字符串，
      // 不设边界它就是一个没有名字的万能抓取器。
      if (!isUnderSources(url, sources)) {
        const allowed = sources.map((s) => s.url).join('、');
        return {
          ok: false,
          url,
          error: `该地址不在已配置的文档源内。read_doc 只能读这些站点：${allowed}。需要读其它页面请用 fetch_url。`,
        };
      }
      return await service.read(url);
    },
  };
}
