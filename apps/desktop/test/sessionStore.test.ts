import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionStore } from '../src/main/sessions';
import type { ChatSession } from '@deepseek-ide/shared';

describe('SessionStore with lightweight indexing', () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echoly-sessions-test-'));
    store = new SessionStore(tmpDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('saves session and creates lightweight index file', () => {
    const session: ChatSession = {
      id: 'sess-1',
      title: '优化活动页',
      customTitle: true,
      messages: [
        { id: 'm1', role: 'user', content: '请帮我优化活动页', createdAt: 1000 },
        { id: 'm2', role: 'assistant', content: '我已分析代码结构并提出3点优化', createdAt: 2000 },
      ],
      updatedAt: 2000,
      workspacePath: '/Users/test/project-a',
      projectName: 'project-a',
      gitBranch: 'feature/opt',
    };

    store.save(session);

    // 1. Session file exists with full content
    const full = store.get('sess-1');
    expect(full).not.toBeNull();
    expect(full?.title).toBe('优化活动页');
    expect(full?.messages.length).toBe(2);
    expect(full?.gitBranch).toBe('feature/opt');

    // 2. Index file exists
    const indexPath = path.join(tmpDir, 'sessions', '_sessions_index.json');
    expect(fs.existsSync(indexPath)).toBe(true);

    // 3. list() returns fast summary with snippet and messageCount
    const list = store.list();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe('sess-1');
    expect(list[0].title).toBe('优化活动页');
    expect(list[0].messageCount).toBe(2);
    expect(list[0].gitBranch).toBe('feature/opt');
    expect(list[0].snippet).toContain('我已分析代码结构');
  });

  it('automatically migrates pre-existing unindexed sessions on first list()', () => {
    const sessionsDir = path.join(tmpDir, 'sessions');
    const legacySession: ChatSession = {
      id: 'sess-legacy',
      title: '旧会话',
      messages: [
        { id: 'm1', role: 'user', content: '修复登录问题', createdAt: 500 },
        { id: 'm2', role: 'assistant', content: '已排查到 token 过期逻辑', createdAt: 600 },
      ],
      updatedAt: 600,
      workspacePath: '/Users/test/legacy-app',
      projectName: 'legacy-app',
    };

    // Write file directly into disk without index
    fs.writeFileSync(
      path.join(sessionsDir, 'sess-legacy.json'),
      JSON.stringify(legacySession),
      'utf8',
    );

    // Creating fresh store
    const freshStore = new SessionStore(tmpDir);
    const list = freshStore.list();

    expect(list.length).toBe(1);
    expect(list[0].id).toBe('sess-legacy');
    expect(list[0].title).toBe('旧会话');
    expect(list[0].messageCount).toBe(2);

    // Index file should now be created
    expect(fs.existsSync(path.join(sessionsDir, '_sessions_index.json'))).toBe(true);
  });

  it('updates index when deleting session', () => {
    const session: ChatSession = {
      id: 'sess-del',
      title: '待删除会话',
      messages: [{ id: 'm1', role: 'user', content: 'hello', createdAt: 100 }],
      updatedAt: 100,
    };
    store.save(session);
    expect(store.list().length).toBe(1);

    store.delete('sess-del');
    expect(store.get('sess-del')).toBeNull();
    expect(store.list().length).toBe(0);
  });
});
