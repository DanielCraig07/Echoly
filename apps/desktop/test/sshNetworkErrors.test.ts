import { describe, expect, it, vi } from 'vitest';
import { SshSessionManager } from '../src/main/ssh/SshSessionManager';
import { Client } from 'ssh2';

vi.mock('ssh2', () => {
  const ClientMock = vi.fn().mockImplementation(() => {
    return {
      on: vi.fn().mockReturnThis(),
      connect: vi.fn().mockReturnThis(),
      end: vi.fn(),
      exec: vi.fn(),
      sftp: vi.fn(),
      shell: vi.fn(),
    };
  });
  return { Client: ClientMock };
});

describe('SshSessionManager Local Network Error Diagnosis', () => {
  it('formats helpful local network permission diagnosis on EHOSTUNREACH for LAN IPs', async () => {
    const mockSession = { webContentsId: 1, workspace: { setRemoteBackend: vi.fn(), getRoot: () => '/home' } };
    const manager = new SshSessionManager(() => mockSession as any, '/tmp/test-user-data', () => null);

    // Mock Client.connect to trigger error
    vi.mocked(Client).mockImplementationOnce(function () {
      const listeners: Record<string, Function[]> = {};
      const clientInstance = {
        on: (event: string, cb: Function) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(cb);
          return clientInstance;
        },
        connect: () => {
          process.nextTick(() => {
            listeners['error']?.forEach((cb) =>
              cb(new Error('connect EHOSTUNREACH 192.168.10.208:22')),
            );
          });
          return clientInstance;
        },
        end: vi.fn(),
      };
      return clientInstance as any;
    });

    const res = await manager.connect({
      host: '192.168.10.208',
      port: 22,
      username: 'root',
      password: 'password',
    });

    expect(res.ok).toBe(false);
    expect(res.detail).toContain('无法连接');
    expect(res.detail).toContain('192.168.10.208:22');
    if (process.platform === 'darwin') {
      expect(res.detail).toContain('本地网络');
      expect(res.detail).toContain('系统设置');
    }
  });

  it('buffers resize and write before shell channel opens and applies on ready', async () => {
    const mockSession = { webContentsId: 1, workspace: { setRemoteBackend: vi.fn(), getRoot: () => '/remote/home' } };
    const manager = new SshSessionManager(() => mockSession as any, '/tmp/test-user-data', () => null);
    let shellCallback: any;
    const mockClient = {
      shell: vi.fn((opts, cb) => {
        shellCallback = cb;
      }),
    };
    (manager as any).liveForCurrent = vi.fn().mockReturnValue({
      client: mockClient,
      workspace: { getRoot: () => '/remote/home' },
    });

    const onData = vi.fn();
    const onClose = vi.fn();
    const handle = manager.openShell(onData, onClose, 120, 40);

    expect(handle).not.toBeNull();
    // Initially passed to shell
    expect(mockClient.shell).toHaveBeenCalledWith(
      expect.objectContaining({ cols: 120, rows: 40 }),
      expect.any(Function),
    );

    // Call resize and write before callback runs
    handle!.resize(140, 45);
    handle!.write('echo hello\n');

    // Now simulate shell channel ready
    const mockStream = {
      setWindow: vi.fn(),
      write: vi.fn(),
      on: vi.fn(),
      stderr: { on: vi.fn() },
    };
    shellCallback(null, mockStream);

    // Must have applied buffered resize
    expect(mockStream.setWindow).toHaveBeenCalledWith(45, 140, 0, 0);
    // Must have applied cd root and buffered write
    expect(mockStream.write).toHaveBeenCalledWith(expect.stringContaining('cd '));
    expect(mockStream.write).toHaveBeenCalledWith('echo hello\n');
  });
});
