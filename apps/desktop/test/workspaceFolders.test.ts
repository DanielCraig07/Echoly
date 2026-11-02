import { describe, expect, it } from 'vitest';
import {
  MULTIROOT_PREFIX,
  findFolder,
  makeFolderId,
  normalizeFolders,
  parseLogicalPath,
  toLogicalPath,
  type WorkspaceFolder,
} from '../src/main/workspaceFolders';

describe('workspaceFolders 逻辑路径编址', () => {
  it('前缀是保留常量，且以冒号结尾（避免与真实目录名混淆的写法）', () => {
    expect(MULTIROOT_PREFIX).toBe('multiroot:');
  });

  it('toLogicalPath / parseLogicalPath 往返一致', () => {
    const logical = toLogicalPath('docs-1a2b3c4d', 'src/a.ts');
    expect(logical).toBe('multiroot:docs-1a2b3c4d/src/a.ts');
    expect(parseLogicalPath(logical)).toEqual({ folderId: 'docs-1a2b3c4d', rel: 'src/a.ts' });
  });

  it('文件夹根节点的逻辑路径只有前缀段，解析回来 rel 为 "."', () => {
    const logical = toLogicalPath('docs-1a2b3c4d');
    expect(logical).toBe('multiroot:docs-1a2b3c4d');
    expect(parseLogicalPath(logical)).toEqual({ folderId: 'docs-1a2b3c4d', rel: '.' });
  });

  it('普通主根路径不带前缀，原样解析', () => {
    expect(parseLogicalPath('src/index.ts')).toEqual({ folderId: null, rel: 'src/index.ts' });
    expect(parseLogicalPath('.')).toEqual({ folderId: null, rel: '.' });
    expect(parseLogicalPath('')).toEqual({ folderId: null, rel: '.' });
  });

  it('toLogicalPath 容忍前导斜杠与反斜杠', () => {
    expect(toLogicalPath('f1', '/src/a.ts')).toBe('multiroot:f1/src/a.ts');
    expect(toLogicalPath('f1', 'src\\win\\a.ts')).toBe('multiroot:f1/src/win/a.ts');
  });

  it('makeFolderId 对同一路径稳定，对不同路径不同，且不含分隔符', () => {
    const same = makeFolderId('/Users/me/proj/docs');
    expect(makeFolderId('/Users/me/proj/docs')).toBe(same);
    const other = makeFolderId('/Users/me/other/docs');
    expect(other).not.toBe(same);
    // 目录名重名时靠哈希尾部区分，所以两边都叫 docs 也不会撞
    expect(same.startsWith('docs-')).toBe(true);
    for (const id of [same, other]) {
      expect(id).not.toContain('/');
      expect(id).not.toContain('\\');
    }
  });

  it('normalizeFolders 去重、丢掉空项，并补全 label', () => {
    const input: WorkspaceFolder[] = [
      { id: '', label: '', absPath: '/a/docs' },
      { id: '', label: '', absPath: '/a/docs' }, // 同一目录重复
      { id: 'x', label: '  项目根  ', absPath: '/a/app' },
    ];
    const out = normalizeFolders(input);
    expect(out).toHaveLength(2);
    expect(out[0].label).toBe('docs');
    expect(out[1].label).toBe('项目根');
    expect(out[1].id).toBe('x');
  });

  it('findFolder 按 id 命中，未知 id 返回 null', () => {
    const folders: WorkspaceFolder[] = [{ id: 'a', label: 'A', absPath: '/a' }];
    expect(findFolder(folders, 'a')?.absPath).toBe('/a');
    expect(findFolder(folders, 'nope')).toBeNull();
    expect(findFolder(folders, null)).toBeNull();
  });
});
