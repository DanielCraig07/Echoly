import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

export class PathJailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathJailError';
  }
}

/**
 * 词法校验：确认 `relPath` 解析后落在 `workspaceRoot` 内。
 *
 * 这一步**只做字符串层面**的判断，不碰文件系统，所以对符号链接是盲的 ——
 * 工作区里一个指向 `/etc` 的软链能让 `link/hosts` 通过这里。真正要防逃逸必须
 * 再过一遍 `assertRealPathInside`。
 */
export function resolveInWorkspace(workspaceRoot: string, relPath = '.'): string {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, relPath);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathJailError(`Path escapes workspace: ${relPath}`);
  }
  return target;
}

/**
 * 解析符号链接后再次确认仍在工作区内。
 *
 * 存在的路径直接 realpath；不存在的路径（`write_file` 要新建文件）回溯到最近的
 * 已存在祖先再 realpath —— 这样 `link/newdir/new.txt` 也会因为 `link` 指向工作区外
 * 而被挡下，而不是等到写入时才由内核决定落在哪里。
 */
export async function assertRealPathInside(workspaceRoot: string, absPath: string): Promise<void> {
  const realRoot = await realpathOrSelf(path.resolve(workspaceRoot));
  if (realRoot === null) {
    // 工作区根不存在（尚未打开工作区）。此时没有可比对的基准，交由上层处理。
    throw new PathJailError(`Workspace root is not accessible: ${workspaceRoot}`);
  }
  const root = realRoot;
  let probe = path.resolve(absPath);
  // 逐级上溯到第一个真实存在的路径。上限只是防御性的，正常一两次就命中。
  for (let i = 0; i < 64; i++) {
    const real = await realpathOrSelf(probe);
    if (real !== null) {
      const rel = path.relative(root, real);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new PathJailError(`Path escapes workspace via symlink: ${absPath}`);
      }
      return;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  throw new PathJailError(`Unable to verify path stays inside workspace: ${absPath}`);
}

/** realpath；路径不存在时返回 null（而不是抛错），供上溯逻辑使用。 */
async function realpathOrSelf(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

export function toPosixRel(workspaceRoot: string, absPath: string): string {
  const root = path.resolve(workspaceRoot);
  const rel = path.relative(root, absPath);
  return rel.split(path.sep).join('/');
}

export async function ensureParentDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 });
}

export function pathExists(p: string): boolean {
  return existsSync(p);
}
