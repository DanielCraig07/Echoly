import { describe, it, expect } from 'vitest';
import type { GitBranchInfo } from '@deepseek-ide/shared';

describe('Git Panel Modals & Operations', () => {
  it('validates branch names according to git ref rules', () => {
    const invalidCharsRegex = /[\s~^:?*\[\\]/;
    expect(invalidCharsRegex.test('feature/new-button')).toBe(false);
    expect(invalidCharsRegex.test('fix/issue-123')).toBe(false);
    expect(invalidCharsRegex.test('main')).toBe(false);

    expect(invalidCharsRegex.test('feature branch')).toBe(true);
    expect(invalidCharsRegex.test('fix~1')).toBe(true);
    expect(invalidCharsRegex.test('test^branch')).toBe(true);
    expect(invalidCharsRegex.test('branch:name')).toBe(true);
    expect(invalidCharsRegex.test('branch*')).toBe(true);
  });

  it('filters branches case-insensitively', () => {
    const branches: GitBranchInfo[] = [
      {
        name: 'main',
        current: true,
        remote: false,
        lastCommit: {
          hash: 'd73f652',
          message: 'feat: update workspace detection',
          relativeDate: '2 hours ago',
          author: 'danielcraig',
        },
      },
      {
        name: 'develop',
        current: false,
        remote: false,
        lastCommit: {
          hash: 'a1b2c3d',
          message: 'fix: button alignment',
          relativeDate: '1 day ago',
          author: 'developer',
        },
      },
      { name: 'feature/auth', current: false, remote: false },
      { name: 'origin/main', current: false, remote: true },
      { name: 'origin/feature/auth', current: false, remote: true },
    ];

    const filterBranches = (query: string) =>
      branches.filter((b) => b.name.toLowerCase().includes(query.trim().toLowerCase()));

    expect(filterBranches('dev')).toHaveLength(1);
    expect(filterBranches('dev')[0].name).toBe('develop');
    expect(filterBranches('dev')[0].lastCommit?.hash).toBe('a1b2c3d');
    expect(filterBranches('AUTH')).toHaveLength(2);
    expect(filterBranches('origin')).toHaveLength(2);
    expect(filterBranches('not-exist')).toHaveLength(0);
  });

  it('correctly calculates status counts for staged, unstaged, and untracked', () => {
    const entries = [
      { path: 'src/A.ts', staged: true, untracked: false, index: 'M', workTree: ' ' },
      { path: 'src/B.ts', staged: false, untracked: false, index: ' ', workTree: 'M' },
      { path: 'src/C.ts', staged: false, untracked: true, index: '?', workTree: '?' },
      { path: 'src/D.ts', staged: true, untracked: false, index: 'A', workTree: ' ' },
    ];

    const stagedCount = entries.filter((e) => e.staged).length;
    const unstagedCount = entries.filter((e) => !e.staged && !e.untracked).length;
    const untrackedCount = entries.filter((e) => e.untracked).length;

    expect(stagedCount).toBe(2);
    expect(unstagedCount).toBe(1);
    expect(untrackedCount).toBe(1);
  });

  it('detects uncommitted changes before checkout and flags warning condition', () => {
    const checkShouldWarn = (entries: { staged: boolean; untracked: boolean }[]) => {
      return entries.length > 0;
    };

    expect(checkShouldWarn([])).toBe(false);
    expect(checkShouldWarn([{ staged: false, untracked: false }])).toBe(true);
    expect(checkShouldWarn([{ staged: true, untracked: false }])).toBe(true);
    expect(checkShouldWarn([{ staged: false, untracked: true }])).toBe(true);
  });

  it('correctly parses git for-each-ref branch output lines with commit records', () => {
    const lines = [
      'refs/heads/main|d73f652|feat: 升级项目类型精准识别|23 hours ago|danielcraig',
      'refs/heads/wzh|b58a129|fix: 修复右键菜单|2 days ago|wzh',
      'refs/remotes/origin/HEAD|d73f652|feat: 升级项目类型精准识别|23 hours ago|danielcraig',
      'refs/remotes/origin/main|d73f652|feat: 升级项目类型精准识别|23 hours ago|danielcraig',
      'refs/remotes/origin/wzh|b58a129|fix: 修复右键菜单|2 days ago|wzh',
    ];

    const currentBranchName = 'main';
    const branches: GitBranchInfo[] = [];

    for (const line of lines) {
      const [refname, hash, subject, relativeDate, author] = line.split('|');
      let name = '';
      let remote = false;

      if (refname.startsWith('refs/heads/')) {
        name = refname.slice('refs/heads/'.length);
        remote = false;
      } else if (refname.startsWith('refs/remotes/')) {
        name = refname.slice('refs/remotes/'.length);
        remote = true;
        if (name.endsWith('/HEAD') || name === 'HEAD') continue;
      } else {
        continue;
      }

      branches.push({
        name,
        current: !remote && name === currentBranchName,
        remote,
        lastCommit: hash ? { hash, message: subject, relativeDate, author } : undefined,
      });
    }

    expect(branches).toHaveLength(4);
    expect(branches[0].name).toBe('main');
    expect(branches[0].current).toBe(true);
    expect(branches[0].lastCommit?.hash).toBe('d73f652');
    expect(branches[0].lastCommit?.message).toBe('feat: 升级项目类型精准识别');

    expect(branches[1].name).toBe('wzh');
    expect(branches[1].current).toBe(false);
    expect(branches[1].lastCommit?.hash).toBe('b58a129');

    expect(branches[2].name).toBe('origin/main');
    expect(branches[2].remote).toBe(true);

    expect(branches[3].name).toBe('origin/wzh');
    expect(branches[3].remote).toBe(true);
  });
});
