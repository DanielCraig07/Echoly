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

  it('converts absolute path back to posix relative', () => {
    expect(toPosixRel(root, '/workspace/project/src/App.tsx')).toBe('src/App.tsx');
    expect(toPosixRel(root, '/workspace/project')).toBe('');
  });
});
