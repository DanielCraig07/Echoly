import { describe, it, expect, afterEach } from 'vitest';
import { applyPrivacyModeEnv } from '../src/main/privacyMode';

/**
 * 隐私模式落到环境变量。
 *
 * 这里的价值在于「只有一个真相来源」：语义检索的开关本来就由 `ECHOLY_EMBEDDING_*`
 * 决定，设置页开关如果另起一套状态，就会出现「设置页关了、环境变量还开着」
 * 这种自相矛盾的组合 —— 而它表现为「有时候还是会联网」，最难排查。
 */

describe('applyPrivacyModeEnv', () => {
  afterEach(() => {
    delete process.env.ECHOLY_EMBEDDING_OFFLINE;
  });

  it('开启隐私模式时置上离线标记', () => {
    delete process.env.ECHOLY_EMBEDDING_OFFLINE;
    applyPrivacyModeEnv(true);
    expect(process.env.ECHOLY_EMBEDDING_OFFLINE).toBe('1');
  });

  it('关闭隐私模式时清掉标记（而不是置成 0）', () => {
    process.env.ECHOLY_EMBEDDING_OFFLINE = '1';
    applyPrivacyModeEnv(false);
    expect(process.env.ECHOLY_EMBEDDING_OFFLINE).toBeUndefined();
  });

  it('反复切换保持幂等', () => {
    applyPrivacyModeEnv(true);
    applyPrivacyModeEnv(true);
    expect(process.env.ECHOLY_EMBEDDING_OFFLINE).toBe('1');
    applyPrivacyModeEnv(false);
    applyPrivacyModeEnv(false);
    expect(process.env.ECHOLY_EMBEDDING_OFFLINE).toBeUndefined();
  });
});
