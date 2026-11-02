/**
 * 扩展图标代理（主进程侧）。
 *
 * 为什么不让渲染进程直接 `<img src="https://open-vsx.org/...">`：
 * 渲染进程的 CSP 是 `img-src 'self' data: blob:`，远端图片一律加载不了。
 * 放宽 CSP 到 `https:` 看起来更省事，但那等于给整个渲染进程开了一条
 * 「向任意主机发请求」的通道，而且内网 http 镜像的图标仍然加载不了。
 *
 * 所以图标走主进程抓取、转成 data URL（`data:` 本来就在白名单里）。
 * 抓取范围由 openVsx.ts 的 `isAllowedIconUrl` 锁死在配置的注册表 origin 上。
 */

/**
 * 图标体积上限。
 *
 * 这只是个图标，正常都在几十 KB 以内；给一个上限是因为 data URL 会**内联进
 * DOM 属性**，一份几 MB 的图会让整棵节点树变得又大又慢。
 * 超限的图标直接放弃（列表回退到首字母头像），不截断 —— 截断出来的图是坏的。
 */
export const MAX_ICON_BYTES = 512 * 1024;

/** 图标抓取超时。注册表慢的时候不该拖着一排行在那里转圈。 */
export const ICON_FETCH_TIMEOUT_MS = 8000;

/** 缓存条数上限。超出后整体清空：图标是纯展示数据，重建代价低，不值得做 LRU。 */
export const ICON_CACHE_LIMIT = 200;

/**
 * 响应体是不是图片。
 *
 * 必须校验：抓回来的东西可能是一个 HTML 错误页（注册表 200 + 错误页），
 * 那种内容转成 data URL 塞进 `<img>` 只会得到一个破图，不如直接放弃。
 */
export function isImageContentType(contentType: string | null | undefined): boolean {
  if (typeof contentType !== 'string') return false;
  return contentType.trim().toLowerCase().startsWith('image/');
}

/**
 * 组装 data URL。
 *
 * content-type 只取 `;` 之前的一段：Open VSX 会返回 `image/svg+xml;charset=utf-8`
 * 这种带参数的形式，整串塞进 data URL 的 MIME 位在部分浏览器内核里会解析失败。
 * 体积超限或类型不对时返回 null，由调用方回退。
 */
export function toIconDataUrl(
  contentType: string | null | undefined,
  bytes: Uint8Array,
): string | null {
  if (!isImageContentType(contentType)) return null;
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ICON_BYTES) return null;
  const mime = String(contentType).split(';')[0].trim().toLowerCase();
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}
