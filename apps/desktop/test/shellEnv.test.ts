import { describe, it, expect } from 'vitest';
import {
  ensureSystemEnv,
  getLocalTerminalEnv,
  isSystemEnvProbed,
  primeSystemEnv,
} from '../src/main/shellEnv';

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

  it('ensureSystemEnv 是同步且极快的（不再同步等登录 Shell）', () => {
    // 这条断言保护的是一个**启动体验**上的回归：旧实现会在主进程启动路径上
    // 同步 execFileSync 一个登录 Shell，最多阻塞 2.5 秒，窗口迟迟不出现。
    // 只要把登录 Shell 探测塞回同步路径，这个耗时就回来了。
    const start = Date.now();
    ensureSystemEnv();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('primeSystemEnv 返回同一个 promise，重复调用不会重复起 shell', async () => {
    const a = primeSystemEnv();
    const b = primeSystemEnv();
    expect(a).toBe(b);
    await a;
    expect(isSystemEnvProbed()).toBe(true);
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
