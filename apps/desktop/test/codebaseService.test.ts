import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CodebaseService } from '../src/main/codebaseService';

describe('CodebaseService', () => {
  let tmpDir: string;
  let fakeWorkspace: any;
  let service: CodebaseService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echoly-codebase-test-'));
    fakeWorkspace = {
      getRoot: () => tmpDir,
    };
    service = new CodebaseService(() => fakeWorkspace);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('initializes with idle status', () => {
    const status = service.getStatus();
    expect(status.isIndexing).toBe(false);
    expect(status.indexedFiles).toBe(0);
    expect(status.totalSymbols).toBe(0);
  });

  it('indexes source files and extracts symbols and chunks', async () => {
    // 写入一个测试 TS 文件
    const tsCode = `
/**
 * 校验用户登录凭证并生成 Token
 */
export async function authenticateUser(username: string, passwordHash: string) {
  if (!username) {
    throw new Error('用户名不能为空');
  }
  return { token: 'jwt-xyz', username };
}

export interface UserSessionPayload {
  userId: string;
  role: 'admin' | 'user';
}
`;
    fs.writeFileSync(path.join(tmpDir, 'authService.ts'), tsCode, 'utf-8');

    // 建立一个应被忽略的 node_modules 目录
    const nmDir = path.join(tmpDir, 'node_modules', 'dep');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, 'ignored.ts'), 'export const secret = 123;', 'utf-8');

    const status = await service.buildIndex();
    expect(status.indexedFiles).toBe(1);
    expect(status.totalSymbols).toBeGreaterThanOrEqual(1);

    // 语义检索测试
    const hits = await service.search('用户登录 凭证 token');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].name).toBe('authenticateUser');
    expect(hits[0].filePath).toContain('authService.ts');
    expect(hits[0].content).toContain('authenticateUser');

    // 接口检索测试
    const interfaceHits = await service.search('UserSessionPayload');
    expect(interfaceHits.length).toBeGreaterThanOrEqual(1);
    expect(interfaceHits[0].name).toBe('UserSessionPayload');
    expect(interfaceHits[0].kind).toBe('interface');
  });

  it('handles empty workspace gracefully', async () => {
    const emptyWorkspace = {
      getRoot: () => null,
    };
    const emptyService = new CodebaseService(() => emptyWorkspace as any);
    const status = await emptyService.buildIndex();
    expect(status.indexedFiles).toBe(0);
    const hits = await emptyService.search('test');
    expect(hits).toEqual([]);
  });
});
