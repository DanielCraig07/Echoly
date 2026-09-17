import { describe, it, expect } from 'vitest';
import { extractRepoName, detectGitProtocol } from '../src/renderer/src/components/CloneRepoModal';

describe('CloneRepoModal utility functions', () => {
  it('extracts repo name correctly from various git URLs', () => {
    expect(extractRepoName('https://github.com/vuejs/core.git')).toBe('core');
    expect(extractRepoName('https://github.com/vuejs/core')).toBe('core');
    expect(extractRepoName('git@github.com:facebook/react.git')).toBe('react');
    expect(extractRepoName('https://gitee.com/antigravity/echoly.git')).toBe('echoly');
    expect(extractRepoName('https://gitlab.example.com/team/subgroup/my-service.git/')).toBe('my-service');
    expect(extractRepoName('git://github.com/torvalds/linux.git')).toBe('linux');
    expect(extractRepoName('')).toBe('');
  });

  it('detects git protocols accurately', () => {
    expect(detectGitProtocol('https://github.com/foo/bar.git')).toBe('HTTPS');
    expect(detectGitProtocol('http://localhost:3000/foo/bar.git')).toBe('HTTPS');
    expect(detectGitProtocol('git@github.com:foo/bar.git')).toBe('SSH');
    expect(detectGitProtocol('ssh://git@myhost.net/repo.git')).toBe('SSH');
    expect(detectGitProtocol('git://myhost.net/repo.git')).toBe('Git');
    expect(detectGitProtocol('unknown-format')).toBe(null);
  });
});
