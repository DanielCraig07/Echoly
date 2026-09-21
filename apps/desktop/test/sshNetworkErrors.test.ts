import { describe, expect, it, vi } from 'vitest';
import { SshSessionManager } from '../src/main/ssh/SshSessionManager';
import { Client } from 'ssh2';

vi.mock('ssh2', () => {
  const ClientMock = vi.fn().mockImplementation(function () {
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

    // Mock Client.connect to trigger error on direct and fallback
    vi.mocked(Client).mockImplementation(function () {
      const listeners: Record<string, ((...args: any[]) => void)[]> = {};
      const clientInstance = {
        on: (event: string, cb: (...args: any[]) => void) => {
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

  it('formats helpful local network diagnosis on Connection lost before handshake', async () => {
    const mockSession = { webContentsId: 1, workspace: { setRemoteBackend: vi.fn(), getRoot: () => '/home' } };
    const manager = new SshSessionManager(() => mockSession as any, '/tmp/test-user-data', () => null);

    vi.mocked(Client).mockImplementation(function () {
      const listeners: Record<string, ((...args: any[]) => void)[]> = {};
      const clientInstance = {
        on: (event: string, cb: (...args: any[]) => void) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(cb);
          return clientInstance;
        },
        connect: () => {
          process.nextTick(() => {
            listeners['error']?.forEach((cb) =>
              cb(new Error('Connection lost before handshake')),
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
    expect(res.detail).toContain('Connection lost before handshake');
    if (process.platform === 'darwin') {
      expect(res.detail).toContain('本地网络');
    }
  });

  it('formats user-friendly error on All configured authentication methods failed without retrying via nc', async () => {
    const mockSession = { webContentsId: 1, workspace: { setRemoteBackend: vi.fn(), getRoot: () => '/home' } };
    const manager = new SshSessionManager(() => mockSession as any, '/tmp/test-user-data', () => null);

    let connectCount = 0;
    vi.mocked(Client).mockImplementation(function () {
      const listeners: Record<string, ((...args: any[]) => void)[]> = {};
      const clientInstance = {
        on: (event: string, cb: (...args: any[]) => void) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(cb);
          return clientInstance;
        },
        connect: () => {
          connectCount++;
          process.nextTick(() => {
            listeners['error']?.forEach((cb) =>
              cb(new Error('All configured authentication methods failed')),
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
      password: 'wrong-password',
    });

    expect(res.ok).toBe(false);
    expect(res.detail).toContain('认证失败：请检查用户名、密码或私钥口令是否正确');
    expect(connectCount).toBe(1); // should not retry via nc on auth failure
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
    expect(mockStream.write).toHaveBeenCalledWith(expect.stringContaining('cd '));
    expect(mockStream.write).toHaveBeenCalledWith('echo hello\n');
  });

  it('automatically retries on transient Channel open failure and succeeds without exiting', async () => {
    vi.useFakeTimers();
    try {
      let shellCallCount = 0;
      const callbacks: Array<(err: any, stream: any) => void> = [];
      const mockClient = {
        shell: vi.fn().mockImplementation((_opts: any, cb: (err: any, stream: any) => void) => {
          shellCallCount++;
          callbacks.push(cb);
        }),
      };

      const manager = new SshSessionManager(
        () => ({ webContentsId: 1, workspace: 'ssh-1' }),
        '/tmp/user-data',
        () => null,
      );
      (manager as any).liveForCurrent = vi.fn().mockReturnValue({
        client: mockClient,
        workspace: { getRoot: () => '/remote/home' },
      });

      const onData = vi.fn();
      const onClose = vi.fn();
      const handle = manager.openShell(onData, onClose, 100, 30);
      expect(handle).not.toBeNull();
      expect(shellCallCount).toBe(1);

      // Attempt 1 fails with transient Channel open failure
      callbacks[0](new Error('(SSH) Channel open failure: open failed'), null);

      // Must NOT exit immediately
      expect(onClose).not.toHaveBeenCalled();
      expect(onData).not.toHaveBeenCalled();

      // Fast forward backoff timer
      vi.advanceTimersByTime(200);

      // Attempt 2 was triggered
      expect(shellCallCount).toBe(2);

      // Attempt 2 succeeds
      const mockStream = {
        setWindow: vi.fn(),
        write: vi.fn(),
        on: vi.fn(),
        stderr: { on: vi.fn() },
      };
      callbacks[1](null, mockStream);

      // Successfully ready
      expect(onClose).not.toHaveBeenCalled();
      expect(mockStream.write).toHaveBeenCalledWith(expect.stringContaining('cd '));
    } finally {
      vi.useRealTimers();
    }
  });
});
