import type { ChatSession, WorkspaceInfo, WorkspaceKind } from '@deepseek-ide/shared';
import { NO_WORKSPACE_LABEL } from '@deepseek-ide/shared';
import type { Translate } from './i18n';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif']);

export function isImagePath(filePath: string): boolean {
  if (isUntitledPath(filePath)) return false;
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTS.has(ext);
}

export function isUntitledPath(filePath: string): boolean {
  return filePath.startsWith('untitled:');
}

/**
 * 内置虚拟标签页（草稿 untitled: / 数据库 db:// 数据视图、DDL、SQL 控制台 / 内置浏览器 browser://）。
 * 这些路径不对应磁盘文件，既不能进「打开文件」持久化，也不能被文件系统变更回调当作已删除清理掉。
 */
export function isVirtualPath(filePath: string): boolean {
  return isUntitledPath(filePath) || isDbPath(filePath) || isBrowserPath(filePath);
}

/** 数据库内置视图标签页（db://data|ddl|console/...），内容只存在于标签页状态里 */
export function isDbPath(filePath: string): boolean {
  return filePath.startsWith('db://');
}

/** 内置浏览器虚拟标签页（browser://...） */
export function isBrowserPath(filePath: string): boolean {
  return filePath.startsWith('browser://');
}

/**
 * 路径匹配是否必须走精确比较（不做 `endsWith` 双向追赶）。
 *
 * `endsWith('/' + p)` 这类宽松匹配是给「同一文件在磁盘绝对路径与工作区相对路径下各有一份 tab」
 * 的历史遗留兜底用的；但内置虚拟标签（`db://...` / `untitled:` / `git-head:`）与磁盘文件是
 * 两套互不相干的东西，一旦参与追赶匹配就可能把对虚拟标签的编辑回写到某个代码文件标签上。
 */
export function requiresExactPathMatch(filePath: string): boolean {
  return isVirtualPath(filePath) || filePath.startsWith('git-head:');
}

/** 路径归一化：统一分隔符、剥离 file:// 协议头并去掉开头的斜杠，供路径比较统一使用 */
export function normalizePathKey(filePath: string): string {
  let p = filePath.replace(/\\/g, '/');
  if (p.startsWith('file://')) {
    p = p.slice('file://'.length);
    try {
      p = decodeURIComponent(p);
    } catch {}
  }
  return p.replace(/^\/+/, '');
}

/**
 * 统一的「同一个文件」判定。
 *
 * 磁盘路径保留 `endsWith` 双向追赶（同一文件在磁盘绝对路径与工作区相对路径下各有一份 tab 的
 * 历史遗留兜底）；虚拟标签（草稿 / `db://` / `git-head:`）只认精确相等，绝不参与追赶，
 * 否则一次表结构或 SQL 控制台的回流就可能落到某个代码文件标签上。
 */
export function isSameFileByPath(a: string, b: string): boolean {
  const x = normalizePathKey(a);
  const y = normalizePathKey(b);
  if (x === y) return true;
  if (requiresExactPathMatch(x) || requiresExactPathMatch(y)) return false;
  return x.endsWith('/' + y) || y.endsWith('/' + x);
}

export function untitledTabLabel(filePath: string): string {
  return isUntitledPath(filePath) ? filePath.slice('untitled:'.length) : filePath;
}

export function languageFromPath(filePath: string): string {
  if (!filePath || isUntitledPath(filePath)) return 'plaintext';

  // Normalize path and extract filename
  const normalized = filePath.replace(/\\/g, '/');
  const filename = normalized.split('/').pop()?.trim() || '';
  const lower = filename.toLowerCase();

  // 1. Dockerfile & Containerfile variants
  if (
    lower === 'dockerfile' ||
    lower.startsWith('dockerfile.') ||
    lower.endsWith('.dockerfile') ||
    lower === 'containerfile' ||
    lower.startsWith('containerfile.') ||
    lower.endsWith('.containerfile')
  ) {
    return 'dockerfile';
  }

  // 2. Makefile variants
  if (
    lower === 'makefile' ||
    lower === 'gnumakefile' ||
    lower.startsWith('makefile.') ||
    lower.endsWith('.mk')
  ) {
    return 'makefile';
  }

  // 3. Ruby special files
  if (lower === 'gemfile' || lower === 'rakefile' || lower === 'podfile' || lower === 'vagrantfile') {
    return 'ruby';
  }

  // 4. Jenkinsfile variants (Groovy DSL)
  if (
    lower === 'jenkinsfile' ||
    lower.startsWith('jenkinsfile.')
  ) {
    return 'groovy';
  }

  // 4. Shell & dotfiles
  if (
    lower === '.bashrc' ||
    lower === '.bash_profile' ||
    lower === '.bash_aliases' ||
    lower === '.bash_logout' ||
    lower === '.zshrc' ||
    lower === '.zshenv' ||
    lower === '.zprofile' ||
    lower === '.profile'
  ) {
    return 'shell';
  }

  // 5. Config files (ini format in Monaco)
  if (
    lower === '.env' ||
    lower.startsWith('.env.') ||
    lower === '.gitignore' ||
    lower === '.gitattributes' ||
    lower === '.gitmodules' ||
    lower === '.gitconfig' ||
    lower === '.editorconfig' ||
    lower === '.dockerignore' ||
    lower === '.npmrc' ||
    lower === '.yarnrc' ||
    lower === '.eslintignore' ||
    lower === '.prettierignore'
  ) {
    return 'ini';
  }

  // 6. CMake
  if (lower === 'cmakelists.txt') {
    return 'cmake';
  }

  // 7. Extensions
  const parts = filename.split('.');
  const ext = parts.length > 1 ? parts.pop()!.toLowerCase() : '';

  if (IMAGE_EXTS.has(ext)) return 'image';

  const map: Record<string, string> = {
    // TypeScript & JavaScript
    ts: 'typescript',
    tsx: 'typescript',
    cts: 'typescript',
    mts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    cjs: 'javascript',
    mjs: 'javascript',

    // Web & Markup
    html: 'html',
    htm: 'html',
    wxml: 'html',
    vue: 'html',
    svelte: 'html',
    css: 'css',
    wxss: 'css',
    wxs: 'javascript',
    scss: 'scss',
    sass: 'scss',
    less: 'less',
    xml: 'xml',
    svg: 'xml',
    md: 'markdown',
    markdown: 'markdown',
    mdx: 'mdx',

    // Config & Data
    json: 'json',
    json5: 'json',
    jsonc: 'json',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'ini',
    ini: 'ini',
    cfg: 'ini',
    conf: 'ini',
    properties: 'ini',
    inf: 'ini',

    // Shell & Scripts
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    ksh: 'shell',
    csh: 'shell',
    ps1: 'powershell',
    psm1: 'powershell',
    psd1: 'powershell',
    bat: 'bat',
    cmd: 'bat',

    // Systems & Compiled Languages
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    hpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hh: 'cpp',
    hxx: 'cpp',
    cs: 'csharp',
    csx: 'csharp',
    java: 'java',
    jav: 'java',
    go: 'go',
    rs: 'rust',
    swift: 'swift',
    kt: 'kotlin',
    kts: 'kotlin',

    // Scripting & Dynamic Languages
    py: 'python',
    pyw: 'python',
    wsgi: 'python',
    rb: 'ruby',
    rbw: 'ruby',
    gemspec: 'ruby',
    php: 'php',
    phtml: 'php',
    php3: 'php',
    php4: 'php',
    php5: 'php',
    lua: 'lua',
    r: 'r',
    pl: 'perl',
    pm: 'perl',
    dart: 'dart',
    scala: 'scala',
    sc: 'scala',
    clj: 'clojure',
    cljs: 'clojure',
    cljc: 'clojure',
    edn: 'clojure',
    ex: 'elixir',
    exs: 'elixir',
    m: 'objective-c',
    mm: 'objective-c',
    fs: 'fsharp',
    fsi: 'fsharp',
    fsx: 'fsharp',

    // Database & Query
    sql: 'sql',
    mysql: 'mysql',
    pgsql: 'pgsql',
    graphql: 'graphql',
    gql: 'graphql',

    // Containers, DevOps & Infra
    dockerfile: 'dockerfile',
    containerfile: 'dockerfile',
    tf: 'hcl',
    tfvars: 'hcl',
    hcl: 'hcl',
    groovy: 'groovy',
    gvy: 'groovy',
    gy: 'groovy',

    // Protocols & Schemas
    proto: 'protobuf',
    protobuf: 'protobuf',
    sol: 'solidity',

    // Others
    diff: 'diff',
    patch: 'diff',
    cmake: 'cmake',
  };

  return map[ext] ?? 'plaintext';
}

export function uid(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 会话标题的**自动标题**（没见过用户消息时用的占总位符）。
 *
 * 它是哨兵不是文案：`isCustomSessionTitle` 靠几个历史默认标题的**字面量**判断
 * 「用户有没有自己改过标题」。这些值会随会话落盘，跨版本、跨语言都还在 ——
 * 所以它们必须永远保持下面这几个字符串，**不能进字典**。
 */
const AUTO_SESSION_TITLES = new Set(['New Chat', '当前对话', '对话']);

/**
 * 判断一条会话的标题是「自动生成的」还是「用户改过的」。
 *
 * 为什么收成一个函数：这段判定原先在 ChatPanel 里抄了 4 份、SessionDrawer 里 1 份、
 * 测试里又抄了 3 份，任何一处改了另几处都不会跟着变。而它同时又是个**哨兵比较**：
 * 一旦哪天有人把 `'当前对话'` 顺手翻成 `'Current chat'` 并让这个新值落盘，
 * 老会话的标题就再也匹配不上这个集合，判定全部翻成「用户改过的」——
 * 表现是标题在某轮对话之后**不再自动更新**，不报错、不崩，只是看起来「卡住了」。
 *
 * `customTitle === true` 是显式标志（新数据走这条）；下面的字面量比较是给
 * 存量数据兜底的。
 */
export function isCustomSessionTitle(
  title: string | undefined,
  firstUserSnippet: string,
  customTitle?: boolean,
): boolean {
  if (customTitle === true) return true;
  if (!title) return false;
  if (AUTO_SESSION_TITLES.has(title)) return false;
  return !firstUserSnippet || title !== firstUserSnippet;
}

/** 新会话的默认标题（**哨兵值**，故意不进字典，理由见 isCustomSessionTitle） */
export const DEFAULT_SESSION_TITLE = '当前对话';

/**
 * 自动标题兜底用的短标题（`'对话'`）。
 *
 * 同样是哨兵：它会被写进 `saveSession` 落盘，之后 `isCustomSessionTitle` 要靠认出
 * 这个字面量才判定得出「这条标题不是用户写的」。翻了它，存量会话的判定就崩了。
 */
export const AUTO_SESSION_TITLE_FALLBACK = '对话';


export function folderNameFromPath(p: string): string {
  const cleaned = p.replace(/^ssh:\/\//i, '').replace(/^ssh\s+/i, '');
  const pathPart =
    cleaned.includes(':') && /[/\\]/.test(cleaned)
      ? cleaned.slice(cleaned.indexOf(':') + 1)
      : cleaned;
  return pathPart.split(/[/\\]/).filter(Boolean).pop() || pathPart || p;
}

/** Persistable workspace fields for a chat session. */
export function buildSessionWorkspaceMeta(
  info: WorkspaceInfo | null | undefined,
): Pick<ChatSession, 'workspacePath' | 'projectName' | 'workspaceKind'> {
  if (!info?.root) return {};
  if (info.kind === 'ssh') {
    // Prefer label so reopen can recover host (root alone is ambiguous).
    const key = info.label && info.label !== NO_WORKSPACE_LABEL ? info.label : info.root;
    return {
      workspaceKind: 'ssh',
      workspacePath: key,
      projectName: folderNameFromPath(info.root),
    };
  }
  return {
    workspaceKind: 'local',
    workspacePath: info.root,
    projectName: folderNameFromPath(info.root),
  };
}

export function inferSessionWorkspaceKind(session: ChatSession): WorkspaceKind | null {
  if (session.workspaceKind === 'local' || session.workspaceKind === 'ssh') {
    return session.workspaceKind;
  }
  const p = session.workspacePath || '';
  if (!p) return null;
  if (/^ssh(\s|:|\/\/)/i.test(p) || /@.+:/.test(p)) return 'ssh';
  return 'local';
}

export function sessionWorkspaceHost(session: ChatSession): string | null {
  const p = session.workspacePath || '';
  if (!p) return null;
  const m =
    p.match(/^ssh\s+([^@\s]+@)?([^:/\s]+)/i) ||
    p.match(/^ssh:\/\/([^@/\s]+@)?([^:/\s]+)/i) ||
    p.match(/^([^@/\s]+@)?([^:/\s]+):/);
  return m?.[2] || null;
}

/** History list subtitle: badge + project (+ host for SSH). */
export function formatSessionWorkspaceLine(
  session: ChatSession,
  t: Translate,
): {
  kind: WorkspaceKind | null;
  badge: string;
  text: string;
  title: string;
} {
  const kind = inferSessionWorkspaceKind(session);
  const path = session.workspacePath || '';
  const project = session.projectName || (path ? folderNameFromPath(path) : '');

  if (!kind && !project && !path) {
    return { kind: null, badge: '', text: t('session.wsUnbound'), title: '' };
  }

  if (kind === 'ssh') {
    const host = sessionWorkspaceHost(session);
    const fallback = t('session.wsRemoteProject');
    return {
      kind: 'ssh',
      badge: 'SSH',
      text: host ? `${host} · ${project || fallback}` : project || fallback,
      title: path || project,
    };
  }

  return {
    kind: 'local',
    badge: t('workspace.kindLocal'),
    text: project || path || t('session.wsLocalProject'),
    title: path || project,
  };
}
