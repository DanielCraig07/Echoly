/**
 * 多根工作区的「逻辑路径」编址。
 *
 * 现状：整个应用（文件树、打开/保存、搜索、索引、Git、终端）都假设「一个工作区 = 一个根」，
 * 路径是**相对主根**的，并且经由 `pathJail` 保证逃不出去。真正把多根做穿，
 * 等于把这些链路全部重写一遍。
 *
 * 所以这里选的做法是：**在主根之外，用一层逻辑前缀给附加文件夹编址**，
 * 前缀在唯一的一个入口（`WorkspaceService` 的文件操作）被解析成
 * 「哪个文件夹的哪个相对路径」，然后照旧交给各自的 `LocalFsBackend`。
 * `pathJail` 一行都不用改 —— 每个 backend 拿到的仍然是一个普通相对路径。
 *
 * 两条不能含糊的规矩：
 * 1. **前缀是保留的**。它一旦泄漏成普通相对路径，主根下会出现一个名叫
 *    `multiroot:xxx` 的真实文件 —— 写错了还看不出来。所以 `pathJail` 会显式拒绝它。
 * 2. **解析只看前缀，不做字符串猜测**。附加文件夹的判定完全由前缀决定，
 *    不去猜「这个绝对路径是不是在某个附加文件夹里」—— 那种猜测在嵌套目录下必然出错。
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { MULTIROOT_PREFIX } from '@deepseek-ide/tools';

/** 附加文件夹的逻辑前缀。保留值，见文件头第 1 条。 */
export { MULTIROOT_PREFIX };

export interface WorkspaceFolder {
  /** 稳定短 id，用于拼逻辑路径。 */
  id: string;
  /** 展示名（默认取目录名）。 */
  label: string;
  /** 绝对路径。 */
  absPath: string;
}

/**
 * 由绝对路径派生一个稳定、可读、且**不含分隔符**的 id。
 *
 * 用「目录名 + 路径哈希前 8 位」：纯哈希在界面上没法认，纯目录名会撞车
 * （两个项目里都叫 `docs`）。截断到 8 位是为了让逻辑路径短一些。
 */
export function makeFolderId(absPath: string): string {
  const normalized = path.resolve(absPath);
  const base = path.basename(normalized).replace(/[^a-zA-Z0-9._-]/g, '') || 'root';
  const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

/** `('abc', 'src/a.ts')` → `'multiroot:abc/src/a.ts'`；`rel` 为 `.`/空时只返回前缀段。 */
export function toLogicalPath(folderId: string, rel = '.'): string {
  const clean = rel === '.' || rel === '' ? '' : rel.replace(/^\/+/, '').replace(/\\/g, '/');
  return clean ? `${MULTIROOT_PREFIX}${folderId}/${clean}` : `${MULTIROOT_PREFIX}${folderId}`;
}

export interface ParsedLogicalPath {
  /** 附加文件夹的 id；主根路径为 null */
  folderId: string | null;
  /** 该文件夹内的相对路径（主根路径时即原样返回） */
  rel: string;
}

export function parseLogicalPath(input: string): ParsedLogicalPath {
  const text = input ?? '';
  if (!text.startsWith(MULTIROOT_PREFIX)) {
    return { folderId: null, rel: text || '.' };
  }
  const rest = text.slice(MULTIROOT_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return { folderId: rest, rel: '.' };
  return { folderId: rest.slice(0, slash), rel: rest.slice(slash + 1) || '.' };
}

/** 按 id 找附加文件夹；找不到返回 null（调用方据此报错，而不是退回主根）。 */
export function findFolder(
  folders: readonly WorkspaceFolder[],
  folderId: string | null,
): WorkspaceFolder | null {
  if (!folderId) return null;
  return folders.find((folder) => folder.id === folderId) ?? null;
}

/**
 * 归一化用户添加的文件夹列表。
 *
 * 去重（同一个目录被添加两次会让 id 相同、树里出现两个一样的节点）、
 * 丢掉空项、并把 label 补成目录名。
 */
export function normalizeFolders(input: readonly WorkspaceFolder[]): WorkspaceFolder[] {
  const out: WorkspaceFolder[] = [];
  const seen = new Set<string>();
  for (const folder of input) {
    if (!folder?.absPath) continue;
    const absPath = path.resolve(folder.absPath);
    if (seen.has(absPath)) continue;
    seen.add(absPath);
    out.push({
      id: folder.id || makeFolderId(absPath),
      label: folder.label?.trim() || path.basename(absPath) || absPath,
      absPath,
    });
  }
  return out;
}
