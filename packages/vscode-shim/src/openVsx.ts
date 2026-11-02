/**
 * Open VSX 注册表的纯逻辑：搜索响应解析与地址构造。
 *
 * 为什么是 Open VSX 而不是微软的 marketplace：后者的使用条款明确只允许
 * VS Code 及其官方衍生品去拉取扩展。Open VSX 是同一个协议下的开放注册表，
 * 也是 VSCodium / Theia 这些项目的选择。
 *
 * 这一层不碰网络，所以能完整测到 —— 而它最容易出错的两处恰好都不会报错：
 * 扩展 id 里含路径分隔符时把它拼进文件路径（目录穿越），
 * 以及下载地址取错字段（拿到 404 的页面而不是 vsix）。
 */

export interface MarketplaceExtension {
  /** `namespace.name`，与 VS Code 的 `publisher.name` 同形 */
  id: string;
  namespace: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  /** 直接可下载的 .vsix 地址 */
  downloadUrl: string;
  homepage?: string;
  iconUrl?: string;
  downloads?: number;
  /** 平均评分（0-5），Open VSX 的字段名是 averageRating */
  rating?: number;
  /**
   * 产物针对的平台（`darwin-arm64` / `linux-x64` …）。
   *
   * 有值意味着**这份 .vsix 只适用于那个平台**。搜索接口不会按当前机器过滤
   * （实测连 `targetPlatform` 查询参数都不生效），所以热门榜里会混进别的
   * OS/架构的构建 —— 装上去轻则原生模块加载失败，重则直接崩。
   * 渲染层据此标注，推荐列表据此过滤。
   */
  targetPlatform?: string;
}

export const DEFAULT_OPEN_VSX_REGISTRY = 'https://open-vsx.org';

/** 搜索一页的条数上限。注册表侧也有限制，这里只做防御性收敛。 */
export const MAX_MARKETPLACE_PAGE_SIZE = 50;

/**
 * 扩展 id 的合法形状。
 *
 * **这不只是格式校验，是一道安全边界**：id 会被拼进 `extensionsDir` 下的
 * 文件与目录名（`<id>.vsix`、`<id>/`）。一个含 `../` 的 id 能把解压目标
 * 指到扩展目录之外 —— 而且 `unzip -o` 会老老实实照着写。
 * 所以不合格的条目直接丢弃，而不是「清理一下再用」：清理规则一旦有疏漏，
 * 后果是任意路径写入。
 */
const SAFE_EXTENSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z0-9][a-zA-Z0-9-]*$/;

export function isSafeExtensionId(id: string): boolean {
  return SAFE_EXTENSION_ID.test(id);
}

/** 把用户填的注册表地址规范化：去掉尾斜杠，补默认值。 */
export function normalizeRegistryBase(input?: string | null): string {
  const text = (input ?? '').trim();
  if (!text) return DEFAULT_OPEN_VSX_REGISTRY;
  return text.replace(/\/+$/, '');
}

/**
 * 构造搜索地址。
 *
 * `includeAllVersions=false` 是必须的：默认会把同一扩展的每个历史版本都列一遍，
 * 结果里十条有九条是同一个扩展的旧版本。
 */
export function buildSearchUrl(
  registryBase: string,
  query: string,
  size = 20,
  sort?: { by: MarketplaceSortBy; order?: MarketplaceSortOrder },
): string {
  const base = normalizeRegistryBase(registryBase);
  const params = new URLSearchParams({
    query,
    size: String(Math.max(1, Math.min(MAX_MARKETPLACE_PAGE_SIZE, size))),
    includeAllVersions: 'false',
  });
  if (sort) {
    params.set('sortBy', sort.by);
    params.set('sortOrder', sort.order ?? 'desc');
  }
  return `${base}/api/-/search?${params.toString()}`;
}

/** Open VSX 搜索接口支持的排序维度。 */
export type MarketplaceSortBy = 'relevance' | 'timestamp' | 'downloadCount' | 'averageRating';
export type MarketplaceSortOrder = 'asc' | 'desc';

/** 推荐列表默认取几条 —— 与参考稿一致，一屏能看全，不用滚。 */
export const DEFAULT_RECOMMENDED_SIZE = 8;

/**
 * 「推荐」用的搜索地址：空 query + 按下载量倒序。
 *
 * 为什么单独一条路径：`searchMarketplace` 会**主动拒掉空 query**（用户随手敲一下回车
 * 不该刷出一屏噪音）。而推荐列表要的恰恰是「最热门的几个」——同一个接口，
 * 相反的意图，所以不共用「有没有 query」这个判断。
 */
export function buildRecommendedUrl(registryBase: string, size = DEFAULT_RECOMMENDED_SIZE): string {
  return buildSearchUrl(registryBase, '', size, { by: 'downloadCount', order: 'desc' });
}

/**
 * 从下载地址里读出平台后缀。
 *
 * 注册表用文件名后缀区分平台构建：`Anthropic.claude-code-2.1.316@alpine-arm64.vsix`。
 * 解析的是 **`files.download` 这个注册表给的真实地址**，不是从 id 猜的 ——
 * 扩展作者怎么命名版本号我们管不着，但这个后缀是注册表自己拼上去的。
 */
export function parseTargetPlatform(downloadUrl: string): string | undefined {
  const fileName = safeDecode(downloadUrl.split('?')[0].split('/').pop() ?? '');
  const match = /@([^@/]+)\.vsix$/i.exec(fileName);
  return match ? match[1] : undefined;
}

/**
 * 是不是「通用构建」（不带平台后缀）。
 *
 * 推荐列表只收通用构建：那个列表是我们替用户挑的，挑一个在当前机器上装不了的
 * 版本不是「少推一个」的问题，是「点了安装必然出问题」。宁可少几项。
 */
export function isPlatformAgnosticDownload(downloadUrl: string): boolean {
  return parseTargetPlatform(downloadUrl) === undefined;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // 编解码失败时用原串：这里的用途是「找出 @platform 后缀」，
    // 拿到一个没解码的名字顶多解析不出平台，不应该抛错打断整批结果。
    return value;
  }
}

/**
 * 图标地址是否允许抓取。
 *
 * 图标要走主进程代理（渲染进程的 CSP 只允许 `img-src 'self' data:`，加载不了远端图），
 * 而「主进程替渲染进程抓任意 URL」本身就是一个可以把内网端口当探针用的能力。
 * 这里把范围锁死在**配置的那个注册表**上：图标本来就放在注册表里，
 * 换一个来源没有正当理由。
 */
export function isAllowedIconUrl(registryBase: string, iconUrl: unknown): boolean {
  if (typeof iconUrl !== 'string' || !iconUrl) return false;
  let target: URL;
  let base: URL;
  try {
    target = new URL(iconUrl);
    base = new URL(normalizeRegistryBase(registryBase));
  } catch {
    return false;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return false;
  return target.origin === base.origin;
}

/**
 * 从搜索结果里挑出下载地址。
 *
 * 优先用响应里的 `files.download`（注册表自己给的完整地址，跟着注册表走），
 * 缺失时按官方路径规则拼一个 —— 拼的这条只在极少数响应缺字段时才会用到。
 */
export function buildDownloadUrl(
  registryBase: string,
  namespace: string,
  name: string,
  version: string,
  filesDownload?: unknown,
): string {
  if (typeof filesDownload === 'string' && /^https?:\/\//i.test(filesDownload)) {
    return filesDownload;
  }
  const base = normalizeRegistryBase(registryBase);
  return `${base}/api/${namespace}/${name}/${version}/file/${namespace}.${name}-${version}.vsix`;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 解析搜索响应。
 *
 * 逐条校验、坏条目跳过而不是整批失败：注册表上存在字段缺失的扩展，
 * 一条坏数据不该让整个搜索结果打不开。
 */
export function parseOpenVsxSearch(payload: unknown, registryBase: string): MarketplaceExtension[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const raw = (payload as { extensions?: unknown }).extensions;
  if (!Array.isArray(raw)) return [];

  const out: MarketplaceExtension[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const namespace = asString(record.namespace).trim();
    const name = asString(record.name).trim();
    const version = asString(record.version).trim();
    if (!namespace || !name || !version) continue;

    const id = `${namespace}.${name}`;
    // 见 SAFE_EXTENSION_ID 的说明：id 会变成文件路径的一部分
    if (!isSafeExtensionId(id)) continue;

    const files = (record.files ?? {}) as Record<string, unknown>;
    const out_extension: MarketplaceExtension = {
      id,
      namespace,
      name,
      displayName: asString(record.displayName).trim() || name,
      description: asString(record.description).trim(),
      version,
      downloadUrl: buildDownloadUrl(registryBase, namespace, name, version, files.download),
    };
    const homepage = asString(record.homepage ?? record.repository);
    if (homepage) out_extension.homepage = homepage;
    const iconUrl = asString(files.icon);
    if (iconUrl) out_extension.iconUrl = iconUrl;
    const targetPlatform = parseTargetPlatform(out_extension.downloadUrl);
    if (targetPlatform) out_extension.targetPlatform = targetPlatform;
    const downloads = asNumber(record.downloadCount);
    if (downloads !== undefined) out_extension.downloads = downloads;
    const rating = asNumber(record.averageRating);
    if (rating !== undefined) out_extension.rating = rating;

    out.push(out_extension);
  }
  return out;
}
