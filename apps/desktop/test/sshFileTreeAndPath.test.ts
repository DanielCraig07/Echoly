import { describe, expect, it, vi } from 'vitest';
import { SftpBackend, SshSessionManager } from '../src/main/ssh/SshSessionManager';
import { WorkspaceService } from '../src/main/workspace';

describe('SftpBackend listDir & Path Resolution', () => {
  it('filters out . and .. entries and resolves symlinked directories', async () => {
    const mockSftp = {
      readdir: vi.fn((dirPath, cb) => {
        cb(null, [
          { filename: '.', attrs: { mode: 0o040755 } },
          { filename: '..', attrs: { mode: 0o040755 } },
          { filename: 'src', attrs: { mode: 0o040755 } },
          { filename: 'index.ts', attrs: { mode: 0o100644 } },
          { filename: 'linked-dir', attrs: { mode: 0o120777 } },
          { filename: 'linked-file', attrs: { mode: 0o120777 } },
        ]);
      }),
      stat: vi.fn((filePath, cb) => {
        if (filePath.endsWith('linked-dir')) {
          cb(null, { mode: 0o040755 }); // target is directory
        } else {
          cb(null, { mode: 0o100644 }); // target is file
        }
      }),
    } as any;

    const backend = new SftpBackend('/remote/project', {} as any, mockSftp);
    const entries = await backend.listDir('.');

    expect(entries.map((e) => e.name)).toEqual(['src', 'index.ts', 'linked-dir', 'linked-file']);
    expect(entries.find((e) => e.name === '.')).toBeUndefined();
    expect(entries.find((e) => e.name === '..')).toBeUndefined();

    // Verify directory flags
    expect(entries.find((e) => e.name === 'src')?.isDirectory).toBe(true);
    expect(entries.find((e) => e.name === 'index.ts')?.isDirectory).toBe(false);
    expect(entries.find((e) => e.name === 'linked-dir')?.isDirectory).toBe(true);
    expect(entries.find((e) => e.name === 'linked-file')?.isDirectory).toBe(false);
  });

  it('WorkspaceService.listDir never includes . or .. and handles SftpBackend', async () => {
    const mockSftp = {
      readdir: vi.fn((dirPath, cb) => {
        cb(null, [
          { filename: '.', attrs: { mode: 0o040755 } },
          { filename: '..', attrs: { mode: 0o040755 } },
          { filename: 'file1.txt', attrs: { mode: 0o100644 } },
        ]);
      }),
    } as any;

    const backend = new SftpBackend('/remote/project', {} as any, mockSftp);
    const ws = new WorkspaceService();
    ws.setRemoteBackend(backend, 'ssh test');

    const nodes = await ws.listDir('.');
    expect(nodes.map((n) => n.name)).toEqual(['file1.txt']);
  });

  it('SshSessionManager resolveRemotePath expands ~, relative paths, and preserves absolute paths', async () => {
    const mockClient = {
      exec: vi.fn((cmd, cb) => {
        const stream = {
          on: vi.fn((event, handler) => {
            if (event === 'data') {
              handler(Buffer.from('/home/developer\n'));
            } else if (event === 'close') {
              handler(0);
            }
            return stream;
          }),
        };
        cb(null, stream);
      }),
    } as any;

    const manager = new SshSessionManager(
      () => ({}) as any,
      '/mock/userData',
      () => null,
    );
    const resolve = (manager as any).resolveRemotePath.bind(manager);

    expect(await resolve(mockClient, '', 'developer')).toBe('/home/developer');
    expect(await resolve(mockClient, '.', 'developer')).toBe('/home/developer');
    expect(await resolve(mockClient, '~', 'developer')).toBe('/home/developer');
    expect(await resolve(mockClient, '~/workspace/echoly', 'developer')).toBe(
      '/home/developer/workspace/echoly',
    );
    expect(await resolve(mockClient, 'my-folder', 'developer')).toBe('/home/developer/my-folder');
    expect(await resolve(mockClient, '/opt/apps/echoly', 'developer')).toBe('/opt/apps/echoly');
    expect(await resolve(mockClient, '/var/www/', 'developer')).toBe('/var/www');
  });
});

/**
 * 远端工作区根就是 `/` 时的路径校验。
 *
 * 这是用户报的那个 bug：「连接服务器 → 打开根目录 → 展开子目录」直接报
 * `[ssh] 路径经符号链接逃出工作区: opt`。`toRel` 用 `root + '/'` 拼前缀，
 * 根是 `/` 时拼出 `//`，`/opt` 剥不掉前缀就原样返回，调用方见「以 / 开头」
 * 便判成逃逸 —— 根下**每一个**目录都打不开，文件树整个展不平。
 */
describe('SftpBackend.resolveSafe 在远端根为 / 时的判定', () => {
  /** realpath 一律解析成自身（不涉及软链），只用来观察前缀判定。 */
  function makeSftp() {
    return {
      realpath: vi.fn((p: string, cb: any) => cb(null, p)),
      readdir: vi.fn((_p, cb) => cb(null, [])),
    } as any;
  }

  it('根为 / 时，根下一级目录不算逃逸', async () => {
    const backend = new SftpBackend('/', {} as any, makeSftp());
    const entries = await backend.listDir('opt');
    expect(entries).toEqual([]);
  });

  it('根为 / 时，多级路径同样放行', async () => {
    const backend = new SftpBackend('/', {} as any, makeSftp());
    await expect(backend.listDir('opt/apps/echoly')).resolves.toEqual([]);
  });

  it('根为 / 时，根自身（.）放行', async () => {
    const backend = new SftpBackend('/', {} as any, makeSftp());
    await expect(backend.listDir('.')).resolves.toEqual([]);
  });

  it('根为普通目录时行为不变', async () => {
    const backend = new SftpBackend('/remote/project', {} as any, makeSftp());
    await expect(backend.listDir('src')).resolves.toEqual([]);
  });

  it('软链真的指向工作区外时仍然拦下', async () => {
    const sftp = {
      realpath: vi.fn((p: string, cb: any) =>
        cb(null, p === '/remote/project/escape' ? '/etc' : p),
      ),
      readdir: vi.fn((_p, cb) => cb(null, [])),
    } as any;
    const backend = new SftpBackend('/remote/project', {} as any, sftp);
    await expect(backend.listDir('escape')).rejects.toThrow(/逃出工作区/);
  });

  it('指向根内的软链仍放行', async () => {
    const sftp = {
      realpath: vi.fn((p: string, cb: any) =>
        cb(null, p === '/remote/project/alias' ? '/remote/project/real' : p),
      ),
      readdir: vi.fn((_p, cb) => cb(null, [])),
    } as any;
    const backend = new SftpBackend('/remote/project', {} as any, sftp);
    await expect(backend.listDir('alias')).resolves.toEqual([]);
  });

  it('名字以 .. 开头的目录不算逃逸（..cache / ..eslintrc 这类）', async () => {
    // `startsWith('..')` 的朴素写法会把它们当成上级目录，目录怎么都打不开
    const backend = new SftpBackend('/remote/project', {} as any, makeSftp());
    await expect(backend.listDir('..cache')).resolves.toEqual([]);
    await expect(backend.listDir('..eslintrc')).resolves.toEqual([]);
  });
});
