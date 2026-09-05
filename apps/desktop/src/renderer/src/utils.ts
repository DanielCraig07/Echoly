import type { ChatSession, WorkspaceInfo, WorkspaceKind } from '@deepseek-ide/shared';

const IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'svg',
  'avif',
]);

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
  if (isUntitledPath(filePath)) return 'plaintext';
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    cts: 'typescript',
    mts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    cjs: 'javascript',
    mjs: 'javascript',
    json: 'json',
    json5: 'json',
    jsonc: 'json',
    md: 'markdown',
    css: 'css',
    wxml: 'html',
    wxss: 'css',
    wxs: 'javascript',
    vue: 'html',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'cpp',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    ps1: 'powershell',
    sql: 'sql',
    xml: 'xml',
    toml: 'ini',
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
