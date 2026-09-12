import { describe, it, expect } from 'vitest';
import { detectInstalledJdks, getAvailableOnlineJdks, resolveJavaHome, getEcholyJdksDir } from '../src/main/javaService';
import fs from 'fs';
import path from 'path';

describe('javaService', () => {
  it('detectInstalledJdks returns installed java list or empty array without throwing', async () => {
    const list = await detectInstalledJdks();
    expect(Array.isArray(list)).toBe(true);
    if (list.length > 0) {
      const first = list[0];
      expect(first.path).toBeDefined();
      expect(fs.existsSync(first.path)).toBe(true);
    }
  });

  it('getAvailableOnlineJdks returns official LTS versions', async () => {
    const online = await getAvailableOnlineJdks();
    expect(online.length).toBeGreaterThanOrEqual(4);
    const versions = online.map((o) => o.version);
    expect(versions).toContain('21');
    expect(versions).toContain('17');
    expect(versions).toContain('11');
    expect(versions).toContain('8');

    for (const jdk of online) {
      expect(jdk.downloadUrl).toMatch(/^https?:\/\//);
      expect(jdk.name).toBeTruthy();
    }
  });

  it('getEcholyJdksDir returns writable valid path', () => {
    const dir = getEcholyJdksDir();
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('resolveJavaHome resolves java home correctly', () => {
    expect(resolveJavaHome('/non/existent/path')).toBeNull();
  });
});
