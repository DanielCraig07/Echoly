/**
 * SQL 控制台脚本的落盘：路径派生与文件命名。
 *
 * 为什么脚本要落盘、而不是只活在标签状态里：用户心里的那个东西是**一段 SQL**，不是一次会话。
 * 只留在内存里的话，关掉标签、切个项目就没了 —— 而这一整个 IDE 的其它东西
 * （文件、连接配置、打开的标签）都是跟项目走的，控制台没有理由例外。
 *
 * 落在项目配置目录的 `queries/<连接>/<库>/` 之下（该目录的绝对位置见主进程 projectConfig.ts：
 * `~/.echoly/projects/<工作区哈希>/`，**不在工作区里**）：
 * - 不写进工作区，用户的项目里就不会凭空多出一个目录，也不会出现在文件树 / git status /
 *   打包脚本的遍历里。
 * - 按「连接 → 库」分层：同名脚本在不同库里各有一份是常态，平铺到一个目录里必然打架。
 *
 * 这里只做纯字符串推导（无 React、无 IO），文件读写由调用方走
 * `window.ide.readProjectConfigFile / writeProjectConfigFile`。
 */

/**
 * 脚本存放目录，**相对项目配置目录**（POSIX 分隔）。
 *
 * 注意它不是工作区相对路径：传给 `window.ide.*ProjectConfig*` 的那组通道时，
 * 主进程会把它映射到 `~/.echoly/projects/<哈希>/queries/…`。
 */
export const QUERIES_DIR = 'queries';

/** 新脚本的默认主名，序号后缀由 {@link nextScriptFileName} 补 */
const DEFAULT_BASE_NAME = '查询';

/** 脚本名后缀 */
const SCRIPT_EXT = '.sql';

/**
 * 把一个名字压成安全的单层路径片段。
 *
 * 连接 id 是 `db_mysql_<sha1 前 12 位>` 这种安全形态，不用操心；但**库名**是用户可控的
 * （MySQL 允许 `@`、空格、中文，理论上还能带分隔符），直接拼进路径就可能写出 `../`，
 * 把文件落到 `queries/` 之外去。分隔符和路径上有特殊含义的字符一律替换掉。
 */
export function safeScriptSegment(raw: string | undefined, fallback: string): string {
  const cleaned = (raw ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    // `..` 单独处理：只替换分隔符的话，`a..b` 无害，但 `..` 会变成上一级
    .replace(/\.{2,}/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : fallback;
}

/** 某个「连接 × 库」的脚本目录 */
export function scriptDirFor(connectionId: string, schemaName?: string): string {
  return `${QUERIES_DIR}/${safeScriptSegment(connectionId, 'default')}/${safeScriptSegment(schemaName, '_')}`;
}

/**
 * 「项目级」脚本目录的库段。
 *
 * 脚本存进 `queries/<连接>/<库>/` 时，**库名就成了文件名的一部分**：同一个脚本想换个库跑，
 * 文件得跟着搬一次家。可库只是「这条 SQL 打到哪里去」的执行目标 —— 它不该决定脚本存在哪。
 * 新开的脚本一律落到这个固定的 `_project` 段下，换库只更新会话目标、文件不动。
 *
 * 下划线开头是为了不与真实库名相撞：`safeScriptSegment` 不会剥掉下划线，
 * 而 MySQL / PG 里带下划线开头且恰好叫 `_project` 的库现实中并不存在。
 */
export const PROJECT_SCRIPT_SCOPE = '_project';

/** 新脚本的落盘路径：连接 + 固定项目段，**与当前库无关** */
export function projectScriptPathFor(connectionId: string, fileName: string): string {
  return scriptPathFor(connectionId, PROJECT_SCRIPT_SCOPE, fileName);
}

/**
 * 从脚本相对路径里取出「连接 / 库段 / 文件名」三段。
 *
 * 早期脚本落在 `queries/<连接>/<库>/` 下，新脚本落在 `queries/<连接>/_project/` 下 ——
 * 两种布局并存（老脚本**不迁移**：搬家要在磁盘上删文件，中途失败就会留下两份，
 * 而它们照样能在列表里列出来、照样能打开，没有非搬不可的理由）。
 * 换连接时要把脚本挪到新连接的目录下，「挪到哪一段」得看它现在在哪一段。
 */
export function parseScriptRelPath(
  relPath: string,
): { connectionId: string; scope: string; fileName: string } | null {
  const parts = relPath.split('/').filter(Boolean);
  // 五段及以上的形态（连接名里若含分隔符会被 safeScriptSegment 压掉，正常不会出现）取尾三段
  if (parts.length < 4) return null;
  const fileName = parts[parts.length - 1];
  const scope = parts[parts.length - 2];
  const connectionId = parts[parts.length - 3];
  return { connectionId, scope, fileName };
}

/** 拼出脚本的完整相对路径 */
export function scriptPathFor(
  connectionId: string,
  schemaName: string | undefined,
  fileName: string,
): string {
  return `${scriptDirFor(connectionId, schemaName)}/${safeScriptSegment(fileName, DEFAULT_BASE_NAME + SCRIPT_EXT)}`;
}

/**
 * 从控制台标签路径里取出脚本文件名。
 *
 * 标签路径形如 `db://console/<连接 id>/<脚本文件名>`，**不含库**：
 * 库只是「这条 SQL 打到哪里去」的执行目标，换它不该把用户手里的脚本挪个地方。
 * 兼容早期的 `<连接>/<库>/<实例 id>.sql` 三段式。
 */
export function scriptFileNameFromTabPath(tabPath: string): string {
  const parts = tabPath.replace('db://console/', '').split('/');
  const last = parts[parts.length - 1] || '';
  return decodeURIComponent(last);
}

/** 从标签路径里取出连接 id */
export function connectionIdFromTabPath(tabPath: string): string {
  const parts = tabPath.replace('db://console/', '').split('/');
  return decodeURIComponent(parts[0] || '');
}

/** 控制台标签路径（连接 + 脚本文件名，两条信息各占一段） */
export function consoleTabPath(connectionId: string, fileName: string): string {
  return `db://console/${encodeURIComponent(connectionId)}/${encodeURIComponent(fileName)}`;
}

/**
 * 为「新开一个查询」挑一个没被占用的文件名。
 *
 * 序号从 1 起往上找第一个空位（而不是取最大值 +1）：用户删掉中间几个之后，
 * 新开的应该补上空缺，否则号码会一路涨到「查询 37」这种让人以为丢了东西的数。
 *
 * `taken` 要传**同一连接下所有已知脚本名**（已落盘的 + 已打开标签的）：
 * 标签路径不含库，同名文件在不同库里虽然落盘不冲突，却会让两个标签撞成同一个路径。
 */
export function nextScriptFileName(taken: readonly string[], base: string = DEFAULT_BASE_NAME): string {
  const used = new Set(taken);
  for (let i = 1; i <= 9999; i += 1) {
    const candidate = `${base} ${i}${SCRIPT_EXT}`;
    if (!used.has(candidate)) return candidate;
  }
  // 四位序号都用满只可能是极端情况，退回时间戳保证不重名
  return `${base} ${Date.now()}${SCRIPT_EXT}`;
}

/** 标签标题：去掉后缀，让「查询 1.sql」在标签上显示成「查询 1」 */
export function scriptTitleFromFileName(fileName: string): string {
  const base = fileName.replace(/\.sql$/i, '').trim();
  return base || DEFAULT_BASE_NAME;
}

/** 新建控制台时预置的语句 */
export const NEW_CONSOLE_SQL =
  '-- Cmd+Enter 执行选中 / 当前语句，Cmd+Shift+Enter 执行全部\nSELECT 1;';

/** 判断某个名字是不是本模块管理的脚本文件 */
export function isQueryScriptName(name: string): boolean {
  return name.toLowerCase().endsWith(SCRIPT_EXT);
}
