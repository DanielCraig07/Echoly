import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { GitService } from '../src/main/gitService';
import { WorkspaceService } from '../src/main/workspace';

describe('GitService Smart Branch State Preservation', () => {
  let tmpDir: string;
  let workspace: WorkspaceService;
  let gitService: GitService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echoly-git-test-'));
    // Initialize git repository with user info
    execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });

    // Initial commit
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'version 1\n');
    execSync('git add file.txt && git commit -m "initial"', { cwd: tmpDir, stdio: 'ignore' });

    // Create branch-b
    execSync('git branch branch-b', { cwd: tmpDir, stdio: 'ignore' });

    workspace = new WorkspaceService();
    workspace.setRoot(tmpDir);

    gitService = new GitService(
      () => workspace,
      () => null,
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('preserves branch uncommitted changes when switching and restores on return', async () => {
    // 1. On main: modify file.txt
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'version 1 - modified on main\n');

    const statusBefore = await gitService.status();
    expect(statusBefore.ok).toBe(true);
    expect(statusBefore.branch).toBe('main');
    expect(statusBefore.entries.length).toBe(1);
    expect(statusBefore.entries[0].path).toBe('file.txt');

    // 2. Checkout branch-b
    const switchRes = await gitService.checkout('branch-b');
    expect(switchRes.ok).toBe(true);

    const statusOnB = await gitService.status();
    expect(statusOnB.ok).toBe(true);
    expect(statusOnB.branch).toBe('branch-b');
    // On branch-b, file.txt should be clean (initial state)
    const contentOnB = fs.readFileSync(path.join(tmpDir, 'file.txt'), 'utf8');
    expect(contentOnB).toBe('version 1\n');

    // 3. Switch back to main
    const returnRes = await gitService.checkout('main');
    expect(returnRes.ok).toBe(true);

    const statusBackOnMain = await gitService.status();
    expect(statusBackOnMain.ok).toBe(true);
    expect(statusBackOnMain.branch).toBe('main');

    // file.txt modifications on main should be automatically restored!
    const contentBackOnMain = fs.readFileSync(path.join(tmpDir, 'file.txt'), 'utf8');
    expect(contentBackOnMain).toBe('version 1 - modified on main\n');
    expect(statusBackOnMain.entries.length).toBe(1);
    expect(statusBackOnMain.entries[0].path).toBe('file.txt');
  });
});
