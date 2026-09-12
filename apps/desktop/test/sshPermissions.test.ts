import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { SftpBackend } from '../src/main/ssh/SshSessionManager';

describe('SftpBackend Permission Preservation', () => {
  function createMockSftp() {
    const sftp = {
      stat: vi.fn(),
      mkdir: vi.fn((path, options, cb) => {
        if (typeof options === 'function') cb = options;
        cb?.(null);
      }),
      chmod: vi.fn((path, mode, cb) => {
        cb?.(null);
      }),
      createWriteStream: vi.fn((path, options) => {
        const stream = new EventEmitter() as any;
        stream.end = vi.fn((chunk, encoding, cb) => {
          process.nextTick(() => {
            stream.emit('close');
            cb?.();
          });
        });
        return stream;
      }),
      createReadStream: vi.fn((path) => {
        const stream = new EventEmitter() as any;
        stream.pipe = vi.fn((dest) => {
          process.nextTick(() => {
            dest.emit('close');
          });
        });
        return stream;
      }),
    };
    return sftp as any;
  }

  it('writeFile preserves existing 0755 permissions and avoids default 0666 fchmod', async () => {
    const sftp = createMockSftp();
    // Simulate existing file with 0755 permissions
    sftp.stat.mockImplementation((path: string, cb: any) => {
      cb(null, { mode: 0o100755 });
    });

    const backend = new SftpBackend('/remote/workspace', {} as any, sftp);
    await backend.writeFile('configs/doris.yaml', 'doris:\n  host: remote\n');

    // Must call createWriteStream with mode: 0o755 (preventing ssh2 default 0o666)
    expect(sftp.createWriteStream).toHaveBeenCalledWith(
      '/remote/workspace/configs/doris.yaml',
      expect.objectContaining({ mode: 0o755 }),
    );

    // Must explicitly call chmod to guarantee permission preservation against umask
    expect(sftp.chmod).toHaveBeenCalledWith(
      '/remote/workspace/configs/doris.yaml',
      0o755,
      expect.any(Function),
    );
  });

  it('writeFile uses standard 0644 for new files (avoiding 0666/0777)', async () => {
    const sftp = createMockSftp();
    // Simulate non-existent file
    sftp.stat.mockImplementation((path: string, cb: any) => {
      cb(new Error('No such file'));
    });

    const backend = new SftpBackend('/remote/workspace', {} as any, sftp);
    await backend.writeFile('newfile.txt', 'hello');

    expect(sftp.createWriteStream).toHaveBeenCalledWith(
      '/remote/workspace/newfile.txt',
      expect.objectContaining({ mode: 0o644 }),
    );
  });

  it('mkdirp creates directories with mode 0o755 so execution bit is preserved', async () => {
    const sftp = createMockSftp();
    sftp.stat.mockImplementation((path: string, cb: any) => cb(new Error('No such file')));

    const backend = new SftpBackend('/remote/workspace', {} as any, sftp);
    await backend.mkdir('new/dir/path');

    expect(sftp.mkdir).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ mode: 0o755 }),
      expect.any(Function),
    );
  });

  it('copy preserves mode of source file and applies chmod to destination', async () => {
    const sftp = createMockSftp();
    sftp.stat.mockImplementation((path: string, cb: any) => {
      if (path.includes('src-script.sh')) {
        cb(null, { mode: 0o100755 });
      } else {
        cb(new Error('No such file'));
      }
    });

    const backend = new SftpBackend('/remote/workspace', {} as any, sftp);
    await backend.copy('src-script.sh', 'dest-script.sh');

    expect(sftp.createWriteStream).toHaveBeenCalledWith(
      '/remote/workspace/dest-script.sh',
      expect.objectContaining({ mode: 0o755 }),
    );
    expect(sftp.chmod).toHaveBeenCalledWith(
      '/remote/workspace/dest-script.sh',
      0o755,
      expect.any(Function),
    );
  });
});
