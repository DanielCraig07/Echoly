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

/**
 * 扩展详情（`GET /api/{namespace}/{name}` 的产物）。
 *
 * 详情页要展示的东西比搜索结果多得多：体积、发布时间、许可、分类、仓库地址。
 * 这些都是注册表**详情接口**才有字段，搜索接口给不了 —— 所以详情页单独拉一次，
 * 而不是把搜索结果凑合着渲染出一个缺胳膊少腿的页面。
 */
export interface MarketplaceDetail extends MarketplaceExtension {
  /** 发布时间（注册表给的是当前版本的时间戳） */
  timestamp?: string;
  /** 体积（字节）。注册表按平台给，取通用构建那一份 */
  size?: number;
  license?: string;
  repository?: string;
  bugs?: string;
  homepage?: string;
  categories?: string[];
  verified?: boolean;
  preview?: boolean;
  reviewCount?: number;
  /** 该扩展声明支持的编辑器版本 */
  engines?: Record<string, string>;
  /**
   * 注册表给的 README 地址（`files.readme`）。
   *
   * 详情页以前是拿 `版本` 拼地址去抓 README 的，对**平台专属**扩展会 404：
   * Open VSX 把这类扩展的文件挂在平台路径下
   * （`/api/Anthropic/claude-code/alpine-arm64/2.1.317/file/README.md`），
   * 而不是 `/{version}/file/README.md`。注册表自己给了地址就用它。
   */
  readmeUrl?: string;
}

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

/**
 * 当前机器对应的注册表平台标识（`darwin-arm64` / `win32-x64` …）。
 *
 * 注册表按「os-arch」给平台命名，和 VS Code 的 `targetPlatform` 是同一套。
 * 认不出来的组合返回 undefined —— **不猜**：猜错等于把「只适用于别的平台」的包
 * 当成能用的包，而失败要等到解压加载时才看得出来。
 */
const KNOWN_TARGET_PLATFORMS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'linux-armhf',
  'win32-x64',
  'win32-arm64',
]);

export function registryTargetPlatform(platform: string, arch: string): string | undefined {
  const candidate = `${platform}-${arch}`;
  return KNOWN_TARGET_PLATFORMS.has(candidate) ? candidate : undefined;
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
  return isRegistryOriginUrl(registryBase, iconUrl);
}

/**
 * 地址是不是「配置的那个注册表」上的 http(s) 资源。
 *
 * 主进程会替渲染进程去抓图标和 README —— 那就是一个「拿内网端口当探针」的能力。
 * 所以范围锁死在注册表 origin 上：这些文件本来就放在注册表里，换来源没有正当理由。
 */
export function isRegistryOriginUrl(registryBase: string, url: unknown): boolean {
  if (typeof url !== 'string' || !url) return false;
  let target: URL;
  let base: URL;
  try {
    target = new URL(url);
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

/**
 * 解析扩展详情。
 *
 * 与搜索解析共用同一套防御（坏数据整条丢弃、下载地址取注册表给的字段），
 * 额外多认几个只在本接口出现的字段。识别不了就返回 null，
 * 由调用方退回「用搜索结果那一份渲染」—— 少几行元信息，不该让详情页变成错误页。
 */
export function parseOpenVsxDetail(
  payload: unknown,
  registryBase: string,
): MarketplaceDetail | null {
  const [base] = parseOpenVsxSearch({ extensions: [payload] }, registryBase);
  if (!base) return null;
  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
  const detail: MarketplaceDetail = { ...base };

  const timestamp = asString(record.timestamp);
  if (timestamp) detail.timestamp = timestamp;
  const license = asString(record.license);
  if (license) detail.license = license;
  const repository = asString(record.repository);
  if (repository) detail.repository = repository;
  const bugs = asString(record.bugs);
  if (bugs) detail.bugs = bugs;
  const homepage = asString(record.homepage);
  if (homepage) detail.homepage = homepage;

  const categories = Array.isArray(record.categories)
    ? record.categories.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : [];
  if (categories.length > 0) detail.categories = categories;

  // README 地址：只认注册表自己给的、且**同一个 origin** 的那一个。
  // 这个地址会变成主进程的一次 fetch，所以来源必须锁死（判定同图标）。
  const readmeUrl = asString(((record.files ?? {}) as Record<string, unknown>).readme);
  if (isRegistryOriginUrl(registryBase, readmeUrl)) detail.readmeUrl = readmeUrl;

  const reviewCount = asNumber(record.reviewCount);
  if (reviewCount !== undefined) detail.reviewCount = reviewCount;
  if (record.verified === true) detail.verified = true;
  if (record.preview === true) detail.preview = true;

  const engines = record.engines;
  if (typeof engines === 'object' && engines !== null) {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(engines as Record<string, unknown>)) {
      const text = asString(value);
      if (text) out[key] = text;
    }
    if (Object.keys(out).length > 0) detail.engines = out;
  }

  // 体积按平台给（`{universal: 123, "darwin-arm64": 456}`）。优先通用构建：
  // 展示一个「当前机器专属包」的大小会让人以为换台机器也是这个数。
  const sizes = record.downloadSizes;
  if (typeof sizes === 'object' && sizes !== null) {
    const table = sizes as Record<string, unknown>;
    const size = asNumber(table.universal) ?? asNumber(Object.values(table)[0]);
    if (size !== undefined) detail.size = size;
  }

  return detail;
}

/** 详情页要抓的 README。注册表把它当普通文件放在 `/file/` 下。 */
export const README_FILE_NAME = 'README.md';

/** `buildReadmeUrl` 的「最新版本」引用。见 buildReadmeCandidates 里对它的说明。 */
export const LATEST_REF = 'latest';

export function buildReadmeUrl(registryBase: string, id: string, ref: string): string {
  const base = normalizeRegistryBase(registryBase);
  const [namespace, name] = id.split('.');
  return `${base}/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(ref)}/file/${README_FILE_NAME}`;
}

/**
 * README 的候选地址，**按成功率从高到低**排。
 *
 * 三条都实测过（open-vsx.org，2026-11）：
 * - `files.readme`（注册表自己给的）：平台专属扩展唯一的正确地址，
 *   例如 `Anthropic.claude-code` 是 `/api/Anthropic/claude-code/alpine-arm64/{v}/file/README.md`。
 * - `/{version}/file/README.md`：通用扩展一直是这条，能用。
 * - `/latest/file/README.md`：注册表只为**当前版本**保留文件，
 *   平台专属扩展带上版本号（哪怕版本对得上）会 404 —— 例如
 *   `/api/Anthropic/claude-code/2.1.317/file/README.md` 是 404，`latest` 那条是 200。
 *
 * 去重后返回，调用方按顺序试，第一条拿到正文的就用。
 */
export function buildReadmeCandidates(
  registryBase: string,
  id: string,
  version: string,
  readmeUrl?: string,
): string[] {
  const out: string[] = [];
  // 不信任传进来的地址：这里再核一遍 origin（它是主进程要去 fetch 的 URL）
  if (readmeUrl && isRegistryOriginUrl(registryBase, readmeUrl)) out.push(readmeUrl);
  out.push(buildReadmeUrl(registryBase, id, version));
  if (version !== LATEST_REF) out.push(buildReadmeUrl(registryBase, id, LATEST_REF));
  return [...new Set(out)];
}

/**
 * 这个下载地址能不能直接装到本机。
 *
 * 搜索接口**不返回** `targetPlatform`（实测是 null），平台只能从
 * `files.download` 的文件名后缀读出来 —— 于是「搜索结果那一行的安装按钮」
 * 会去下一个给 Alpine（musl）用的包，而用户可能正在 macOS 上点它。
 * 这个函数只做判断，网络那一半（按平台再问一次注册表）留给调用方。
 */
export type PlatformDownloadDecision =
  /** 通用构建，或者本来就是本机平台那一份 —— 直接用 */
  | { kind: 'as-is' }
  /** 注册表把这份挂在了别的平台下：该去问本机平台那一份 */
  | { kind: 'needs-local-build'; wantedPlatform: string; givenPlatform: string }
  /** 连本机是什么平台都认不出来 —— 别猜，照原样装 */
  | { kind: 'unknown-platform' };

export function decidePlatformDownload(
  downloadUrl: string,
  platform: string,
  arch: string,
): PlatformDownloadDecision {
  const wantedPlatform = registryTargetPlatform(platform, arch);
  if (!wantedPlatform) return { kind: 'unknown-platform' };
  const givenPlatform = parseTargetPlatform(downloadUrl);
  if (!givenPlatform || givenPlatform === wantedPlatform) return { kind: 'as-is' };
  return { kind: 'needs-local-build', wantedPlatform, givenPlatform };
}

/**
 * 详情地址。带上 `targetPlatform` 就是**那一个平台**的详情。
 *
 * 注册表把同一扩展不同平台的文件分开挂：`/api/Anthropic/claude-code/darwin-arm64`
 * 给的 `files.download` 就是 darwin 那一份。
 * `?targetPlatform=` 查询参数是**不生效**的（实测三个取值返回的都是同一份），
 * 所以只能走路径段。
 */
export function buildDetailUrl(registryBase: string, id: string, targetPlatform?: string): string {
  const base = normalizeRegistryBase(registryBase);
  const [namespace, name] = id.split('.');
  const suffix = targetPlatform ? `/${encodeURIComponent(targetPlatform)}` : '';
  return `${base}/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}${suffix}`;
}

/** 从 `publisher.name` 拆出注册表 API 需要的两段。id 不合法时返回 null。 */
export function splitExtensionId(id: string): { namespace: string; name: string } | null {
  if (!isSafeExtensionId(id)) return null;
  const [namespace, name] = id.split('.');
  return { namespace, name };
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
