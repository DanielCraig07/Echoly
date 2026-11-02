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
export function buildSearchUrl(registryBase: string, query: string, size = 20): string {
  const base = normalizeRegistryBase(registryBase);
  const params = new URLSearchParams({
    query,
    size: String(Math.max(1, Math.min(MAX_MARKETPLACE_PAGE_SIZE, size))),
    includeAllVersions: 'false',
  });
  return `${base}/api/-/search?${params.toString()}`;
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
    const downloads = asNumber(record.downloadCount);
    if (downloads !== undefined) out_extension.downloads = downloads;
    const rating = asNumber(record.averageRating);
    if (rating !== undefined) out_extension.rating = rating;

    out.push(out_extension);
  }
  return out;
}
