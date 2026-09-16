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

    const manager = new SshSessionManager(() => ({} as any), '/mock/userData', () => null);
    const resolve = (manager as any).resolveRemotePath.bind(manager);

    expect(await resolve(mockClient, '', 'developer')).toBe('/home/developer');
    expect(await resolve(mockClient, '.', 'developer')).toBe('/home/developer');
    expect(await resolve(mockClient, '~', 'developer')).toBe('/home/developer');
    expect(await resolve(mockClient, '~/workspace/echoly', 'developer')).toBe('/home/developer/workspace/echoly');
    expect(await resolve(mockClient, 'my-folder', 'developer')).toBe('/home/developer/my-folder');
    expect(await resolve(mockClient, '/opt/apps/echoly', 'developer')).toBe('/opt/apps/echoly');
    expect(await resolve(mockClient, '/var/www/', 'developer')).toBe('/var/www');
  });
});
