import { describe, expect, it } from 'vitest';
import { resolveInWorkspace, toPosixRel, PathJailError } from '../src/pathJail';

describe('pathJail', () => {
  const root = '/workspace/project';

  it('resolves a normal relative path inside workspace', () => {
    expect(resolveInWorkspace(root, 'src/index.ts')).toBe('/workspace/project/src/index.ts');
  });

  it('resolves "." to the workspace root', () => {
    expect(resolveInWorkspace(root, '.')).toBe('/workspace/project');
  });

  it('rejects path traversal with ..', () => {
    expect(() => resolveInWorkspace(root, '../secret')).toThrow(PathJailError);
    expect(() => resolveInWorkspace(root, '../../etc/passwd')).toThrow(PathJailError);
  });

  it('rejects absolute paths', () => {
    expect(() => resolveInWorkspace(root, '/etc/passwd')).toThrow(PathJailError);
    // absolute path embedded after a traversal
    expect(() => resolveInWorkspace(root, 'foo/../../etc')).toThrow(PathJailError);
  });

  it('rejects paths that escape via symlink-like parent', () => {
    // path.relative of /workspace/project and /workspace/other is "..", so escapes
    expect(() => resolveInWorkspace(root, '../other')).toThrow(PathJailError);
  });

  it('rejects the reserved multiroot logical prefix', () => {
    // 多根工作区的附加文件夹用 `multiroot:` 编址，这个前缀是保留的：
    // 一旦被当成普通相对路径放行，主根下会凭空多出一个名叫 `multiroot:xxx` 的目录。
    expect(() => resolveInWorkspace(root, 'multiroot:docs-abc123/src/a.ts')).toThrow(PathJailError);
    expect(() => resolveInWorkspace(root, 'multiroot:')).toThrow(PathJailError);
  });

  it('converts absolute path back to posix relative', () => {
    expect(toPosixRel(root, '/workspace/project/src/App.tsx')).toBe('src/App.tsx');
    expect(toPosixRel(root, '/workspace/project')).toBe('');
  });
});
