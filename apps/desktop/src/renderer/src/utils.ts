import type { ChatSession, WorkspaceInfo, WorkspaceKind } from '@deepseek-ide/shared';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif']);

export function isImagePath(filePath: string): boolean {
  if (isUntitledPath(filePath)) return false;
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTS.has(ext);
}

export function isUntitledPath(filePath: string): boolean {
  return filePath.startsWith('untitled:');
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
    const key = info.label && info.label !== '未打开工作区' ? info.label : info.root;
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
export function formatSessionWorkspaceLine(session: ChatSession): {
  kind: WorkspaceKind | null;
  badge: string;
  text: string;
  title: string;
} {
  const kind = inferSessionWorkspaceKind(session);
  const path = session.workspacePath || '';
  const project = session.projectName || (path ? folderNameFromPath(path) : '');

  if (!kind && !project && !path) {
    return { kind: null, badge: '', text: '未绑定工作区', title: '' };
  }

  if (kind === 'ssh') {
    const host = sessionWorkspaceHost(session);
    return {
      kind: 'ssh',
      badge: 'SSH',
      text: host ? `${host} · ${project || '远程项目'}` : project || '远程项目',
      title: path || project,
    };
  }

  return {
    kind: 'local',
    badge: '本地',
    text: project || path || '本地项目',
    title: path || project,
  };
}
