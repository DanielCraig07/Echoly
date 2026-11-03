/**
 * 扩展 webview 的地址规则与请求解析。
 *
 * 为什么要有自定义协议：VS Code 里扩展 webview 的资源走 `vscode-webview://` /
 * `https://*.vscode-cdn.net`，不是 `file://`。我们最早也试过 `file://`，
 * 结果是 Claude Code 的面板直接报「webview/index.js could not be fetched」——
 * 两个原因叠在一起：
 *
 * 1. 它的 bundle 是 `<script type="module">`。Chromium **禁止**从 `file://` 加载
 *    module script（来源是 null，模块请求按 CORS 处理，file: 不在允许的协议里）；
 * 2. `file://` 的路径不编码空格（`Application Support`），拼出来的 URL 本身就取不到。
 *
 * 换成注册过的自定义协议之后，页面有了正常的 origin（`echoly-webview://ext`），
 * 同源的 module script、CSS、字体都能正常加载，扩展自己写的那段
 * `style-src ${webview.cspSource}` 也正好对上（见 cspSource 的注释）。
 *
 * 这个文件只放纯函数：URL 怎么拼、请求怎么解析、路径怎么防越界。
 * 真正发响应的是 extensionManager（那边要碰 electron 的 protocol/net）。
 */

/** 自定义协议名。必须在 app ready 之前 registerSchemesAsPrivileged 过（见 main/index.ts）。 */
export const EXTENSION_WEBVIEW_SCHEME = 'echoly-webview';

/**
 * 协议里的固定主机名。
 *
 * 视图 id 之所以放在**路径**而不是主机名里：URL 的主机名会被强制转小写，
 * 而视图 id 是大小写敏感的（`claudeVSCodeSidebar`、`claudeCodeManager.view`），
 * 放进主机名那一刻就和注册表里的 id 对不上了。
 */
export const EXTENSION_WEBVIEW_HOST = 'ext';

/** 目录外的文件（扩展引用了扩展目录之外的东西）走这个前缀，后面跟 base64url 的绝对路径。 */
const ABS_PREFIX = '-/abs/';

/** 视图初始 HTML 在协议里的固定路径。 */
export const WEBVIEW_INDEX_PATH = 'index.html';

/**
 * 主题变量样式表在协议里的固定路径。
 *
 * 走**链接**而不是内联 `<style>`：扩展页面自己的 CSP 是
 * `style-src ${cspSource} 'unsafe-inline'`，`cspSource` 就是我们这个 origin ——
 * 链接一定能加载；而内联样式要靠 `'unsafe-inline'`，不是每个扩展都给。
 */
export const WEBVIEW_THEME_PATH = '__echoly-theme.css';

/** `echoly-webview://ext` —— 也就是该页面的 origin，扩展的 CSP 里 `'self'` 指的就是它。 */
export function buildWebviewOrigin(): string {
  return `${EXTENSION_WEBVIEW_SCHEME}://${EXTENSION_WEBVIEW_HOST}`;
}

/**
 * 拼一个资源地址：`echoly-webview://ext/<viewId>/<relPath>`。
 *
 * 逐段 `encodeURIComponent`：路径里可能有空格（macOS 的 `Application Support`）、
 * `#`、`?` —— 整体 encode 会漏掉分隔符，逐段 encode 才是对的。
 */
export function buildWebviewUrl(viewId: string, relPath: string): string {
  const encoded = relPath
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/');
  return `${buildWebviewOrigin()}/${encodeURIComponent(viewId)}/${encoded}`;
}

/** 把绝对路径编成 `-/abs/<base64url>`（base64url 不含 `/`、`+`、`=`，可以安全进 URL）。 */
function encodeAbsPath(fsPath: string): string {
  return Buffer.from(fsPath, 'utf8').toString('base64url');
}

function decodeAbsPath(token: string): string | null {
  try {
    const text = Buffer.from(token, 'base64url').toString('utf8');
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** 统一成分隔符为 `/` 的形式，便于比较前缀（Windows 上 path 给的是 `\`）。 */
function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * 把一个磁盘绝对路径转成协议里的相对路径。
 *
 * 在扩展目录内 → 相对路径（最常见，扩展的资源都在自己目录里）；
 * 在扩展目录外 → `-/abs/<base64url>`。后者不像相对路径那样受目录约束，
 * 所以解析时会单独放行（它只可能来自扩展自己调 asWebviewUri）。
 */
/**
 * 把一个**不在扩展目录里**的绝对路径编进协议地址（不走扩展目录的相对路径）。
 *
 * webview 面板（`window.createWebviewPanel`）的资源地址要现算，而那时我们不一定
 * 拿得到扩展目录 —— 面板的 HTML 是扩展在自己的代码里拼的，`asWebviewUri` 收到的是
 * 绝对路径。直接编成 `-/abs/<base64url>`，协议处理器那边会单独放行这一种。
 */
export function toAbsWebviewResourcePath(fsPath: string): string {
  return `${ABS_PREFIX}${encodeAbsPath(fsPath)}`;
}

export function toWebviewResourcePath(extensionRoot: string, fsPath: string): string {
  const root = toPosix(extensionRoot).replace(/\/+$/, '');
  const target = toPosix(fsPath);
  if (target === root) return '';
  if (target.startsWith(`${root}/`)) return target.slice(root.length + 1);
  return `${ABS_PREFIX}${encodeAbsPath(fsPath)}`;
}

/**
 * 解析 `echoly-webview://` 请求。
 *
 * 返回 null 表示「不是本协议的请求」或形状不对 —— 调用方据此回 404，不要抛，
 * 一个取不到的图标不该把协议处理链路带崩。
 */
export function parseWebviewRequest(rawUrl: string): { viewId: string; relPath: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${EXTENSION_WEBVIEW_SCHEME}:`) return null;
  if (url.hostname !== EXTENSION_WEBVIEW_HOST) return null;

  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    // 路径里有坏的百分号转义
    return null;
  }
  if (segments.length < 2) return null;
  const [viewId, ...rest] = segments;
  return { viewId, relPath: rest.join('/') };
}

/**
 * 从扩展传进来的「URI」里取磁盘路径。
 *
 * 扩展调 `asWebviewUri` 时给的是 `vscode.Uri` 对象（shim 里就是 `{ fsPath, path }`），
 * 但有些扩展会图省事直接给字符串。两种都收下 —— 收不下的话它那块资源就 404，
 * 而报错位置离这里十万八千里。
 */
export function extractFsPath(uri: unknown): string {
  if (typeof uri === 'string') return uri;
  if (uri && typeof uri === 'object') {
    const record = uri as { fsPath?: unknown; path?: unknown };
    if (typeof record.fsPath === 'string' && record.fsPath.length > 0) return record.fsPath;
    if (typeof record.path === 'string' && record.path.length > 0) return record.path;
  }
  return String(uri);
}

/**
 * 把相对路径解析成磁盘绝对路径，并挡住目录穿越。
 *
 * 挡住穿越不是走过场：`../../../../etc/passwd` 这种请求同一个扩展页面里的
 * 任意脚本都能发出来，而它拿到的会是本机上任意可读文件。
 * 返回 null 表示这个路径不许访问。
 */
export function resolveWebviewFilePath(extensionRoot: string, relPath: string): string | null {
  if (!relPath) return null;

  if (relPath.startsWith(ABS_PREFIX)) {
    return decodeAbsPath(relPath.slice(ABS_PREFIX.length));
  }

  const root = toPosix(extensionRoot).replace(/\/+$/, '');
  const joined = toPosix(`${root}/${relPath}`);
  // 归一化 `..` 之后再比前缀：直接字符串比较会被 `a/../..` 绕过
  const normalized = normalizePosix(joined);
  if (normalized !== root && !normalized.startsWith(`${root}/`)) return null;
  return normalized;
}

/** 纯字符串版的路径归一化（不依赖 node:path，方便单测跨平台跑）。 */
function normalizePosix(value: string): string {
  const isAbsolute = value.startsWith('/');
  const out: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!isAbsolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  return `${isAbsolute ? '/' : ''}${out.join('/')}`;
}
