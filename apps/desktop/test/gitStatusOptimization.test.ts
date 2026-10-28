import { describe, expect, it, vi } from 'vitest';
import { parsePorcelainBranchLine, GitService } from '../src/main/gitService';
import { WorkspaceService } from '../src/main/workspace';

describe('parsePorcelainBranchLine', () => {
  it('parses branch with both ahead and behind', () => {
    const res = parsePorcelainBranchLine('## main...origin/main [ahead 2, behind 3]');
    expect(res).toEqual({
      branch: 'main',
      ahead: 2,
      behind: 3,
    });
  });

  it('parses branch with only ahead', () => {
    const res = parsePorcelainBranchLine('## feature/login...origin/feature/login [ahead 5]');
    expect(res).toEqual({
      branch: 'feature/login',
      ahead: 5,
      behind: 0,
    });
  });

  it('parses branch with only behind', () => {
    const res = parsePorcelainBranchLine('## master...origin/master [behind 1]');
    expect(res).toEqual({
      branch: 'master',
      ahead: 0,
      behind: 1,
    });
  });

  it('parses branch with tracking and in-sync', () => {
    const res = parsePorcelainBranchLine('## dev...origin/dev');
    expect(res).toEqual({
      branch: 'dev',
      ahead: 0,
      behind: 0,
    });
  });

  it('parses local branch without remote tracking', () => {
    const res = parsePorcelainBranchLine('## work-branch');
    expect(res).toEqual({
      branch: 'work-branch',
      ahead: 0,
      behind: 0,
    });
  });

  it('parses empty repo unborn branch with No commits yet', () => {
    const res = parsePorcelainBranchLine('## No commits yet on main');
    expect(res).toEqual({
      branch: 'main',
      ahead: 0,
      behind: 0,
    });
  });

  it('parses empty repo unborn branch with Initial commit', () => {
    const res = parsePorcelainBranchLine('## Initial commit on master');
    expect(res).toEqual({
      branch: 'master',
      ahead: 0,
      behind: 0,
    });
  });

  it('parses detached HEAD state', () => {
    const res = parsePorcelainBranchLine('## HEAD (no branch)');
    expect(res).toEqual({
      branch: 'HEAD',
      ahead: 0,
      behind: 0,
    });
  });

  it('returns null branch for invalid input', () => {
    expect(parsePorcelainBranchLine('')).toEqual({ branch: null, ahead: 0, behind: 0 });
    expect(parsePorcelainBranchLine('M src/index.ts')).toEqual({
      branch: null,
      ahead: 0,
      behind: 0,
    });
  });
});

describe('GitService SSH Status Fault Tolerance & Caching', () => {
  it('falls back to last known valid cache on network timeout without losing branch/status', async () => {
    const workspace = new WorkspaceService();
    // Simulate an SSH remote backend
    workspace.setRemoteBackend(
      {
        kind: 'ssh',
        root: '/home/user/project',
        listDir: vi.fn(),
        stat: vi.fn(),
        readFile: vi.fn(),
        writeFile: vi.fn(),
        mkdir: vi.fn(),
        remove: vi.fn(),
        rename: vi.fn(),
        copy: vi.fn(),
        exists: vi.fn(),
      } as any,
      'ssh user@remote:/home/user/project',
    );

    const mockRunCommand = vi.fn();
    const mockSsh: any = {
      runCommand: mockRunCommand,
    };

    const gitService = new GitService(
      () => workspace,
      () => null,
      mockSsh,
    );

    const SEP = '===ECHOLY_STATUS_SEP===';

    // 1. First run: Successful SSH status check
    mockRunCommand.mockResolvedValueOnce({
      code: 0,
      stdout: [
        'true',
        SEP,
        '## main...origin/main [ahead 1]\n M src/app.ts\n?? newfile.ts\n!! node_modules/',
        SEP,
        '1\t0\tsrc/app.ts',
      ].join('\n'),
      stderr: '',
    });

    const status1 = await gitService.status();
    expect(status1.ok).toBe(true);
    expect(status1.isRepo).toBe(true);
    expect(status1.branch).toBe('main');
    expect(status1.ahead).toBe(1);
    expect(status1.entries.length).toBe(2);
    expect(status1.entries[0].path).toBe('src/app.ts');
    expect(status1.ignoredPaths).toEqual(['node_modules/']);

    // 2. Second run after cache expiry: SSH command times out (exit code 124)
    // Advance time or invalidate short-term cache
    gitService.invalidateStatusCache('/home/user/project');

    mockRunCommand.mockResolvedValueOnce({
      code: 124,
      stdout: '',
      stderr: '[ssh-timeout] 命令执行超时 (10000ms): git rev-parse',
    });

    const status2 = await gitService.status();
    // Must gracefully retain last known repo status instead of wiping UI!
    expect(status2.ok).toBe(true);
    expect(status2.isRepo).toBe(true);
    expect(status2.branch).toBe('main');
    expect(status2.ahead).toBe(1);
    expect(status2.entries.length).toBe(2);
    expect(status2.detail).toContain('远程连接响应缓慢');
  });
});
