import { describe, expect, it, vi } from 'vitest';
import { SshSessionManager } from '../src/main/ssh/SshSessionManager';
import { WorkspaceService } from '../src/main/workspace';

describe('SshSessionManager browseOnly and disconnectBrowse isolation', () => {
  it('browseLive keeps active workspace intact when browsing and disconnecting', async () => {
    const ws = new WorkspaceService();
    ws.setRoot('/local/project');

    const mockSession = {
      workspace: ws,
      webContentsId: 101,
    };

    const manager = new SshSessionManager(
      () => mockSession as any,
      '/mock/userData',
      () => null,
    );

    // Simulate active SSH workspace
    const mockLiveClient = { end: vi.fn(), on: vi.fn() } as any;
    const mockLiveSftp = { stat: vi.fn(), readdir: vi.fn() } as any;
    (manager as any).live.set(101, {
      client: mockLiveClient,
      sftp: mockLiveSftp,
      workspace: ws,
      webContentsId: 101,
      host: 'active-host',
      port: 22,
      username: 'active-user',
      browseOnly: false,
    });

    // Simulate browse session
    const mockBrowseClient = { end: vi.fn(), on: vi.fn() } as any;
    const mockBrowseSftp = {
      readdir: vi.fn((dirPath, cb) => {
        cb(null, [{ filename: 'remote-child', attrs: { mode: 0o040755 } }]);
      }),
      stat: vi.fn(),
    } as any;

    (manager as any).browseLive.set(101, {
      client: mockBrowseClient,
      sftp: mockBrowseSftp,
      workspace: ws,
      webContentsId: 101,
      host: 'browse-host',
      port: 22,
      username: 'browse-user',
      browseOnly: true,
    });

    // listRemoteDir should prioritize browseLive
    const dirRes = await manager.listRemoteDir('/opt/remote');
    expect(dirRes.ok).toBe(true);
    expect(dirRes.entries?.map((e) => e.name)).toEqual(['remote-child']);

    // Disconnecting browse session must NOT touch active live session or clear workspace
    await manager.disconnectBrowse(101);
    expect(mockBrowseClient.end).toHaveBeenCalled();
    expect((manager as any).browseLive.has(101)).toBe(false);

    // Active live session must still be present and workspace untouched!
    expect((manager as any).live.has(101)).toBe(true);
    expect(mockLiveClient.end).not.toHaveBeenCalled();
    expect(ws.getRoot()).toBe('/local/project');
  });
});
