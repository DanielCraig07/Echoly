import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

export class PathJailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathJailError';
  }
}

export function resolveInWorkspace(workspaceRoot: string, relPath = '.'): string {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, relPath);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathJailError(`Path escapes workspace: ${relPath}`);
  }
  return target;
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
