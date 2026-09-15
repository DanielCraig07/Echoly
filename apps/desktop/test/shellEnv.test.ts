import { describe, it, expect } from 'vitest';
import { ensureSystemEnv, getLocalTerminalEnv } from '../src/main/shellEnv';

describe('shellEnv and Terminal Environment Integration', () => {
  it('ensures system environment and preserves or populates PATH', () => {
    ensureSystemEnv();
    expect(process.env.PATH).toBeDefined();
    expect(process.env.PATH!.length).toBeGreaterThan(0);

    if (process.platform === 'darwin') {
      // On macOS, PATH must contain Homebrew or standard bin directories
      const hasBrewOrUsr =
        process.env.PATH!.includes('/opt/homebrew/bin') ||
        process.env.PATH!.includes('/usr/local/bin') ||
        process.env.PATH!.includes('/usr/bin');
      expect(hasBrewOrUsr).toBe(true);
    }
  });

  it('getLocalTerminalEnv provides complete environment for PTY', () => {
    const cwd = process.cwd();
    const env = getLocalTerminalEnv(cwd);

    expect(env.PWD).toBe(cwd);
    expect(env.TERM).toBe('xterm-256color');
    expect(env.COLORTERM).toBe('truecolor');
    expect(env.PATH).toBeDefined();
    expect(env.PATH.length).toBeGreaterThan(0);

    if (process.platform === 'darwin') {
      const hasBrewOrUsr =
        env.PATH.includes('/opt/homebrew/bin') ||
        env.PATH.includes('/usr/local/bin') ||
        env.PATH.includes('/usr/bin');
      expect(hasBrewOrUsr).toBe(true);
    }
  });
});
