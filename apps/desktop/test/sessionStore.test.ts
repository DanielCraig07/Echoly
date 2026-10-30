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

  it('renames a session safely without touching messages', () => {
    const session: ChatSession = {
      id: 'sess-rename',
      title: '原标题',
      messages: [
        { id: 'm1', role: 'user', content: 'hello', createdAt: 100 },
        { id: 'm2', role: 'assistant', content: 'world', createdAt: 200 },
      ],
      updatedAt: 100,
    };
    store.save(session);

    store.rename('sess-rename', '新标题');
    const updated = store.get('sess-rename');
    expect(updated?.title).toBe('新标题');
    expect(updated?.customTitle).toBe(true);
    expect(updated?.messages.length).toBe(2);

    const list = store.list();
    expect(list[0].title).toBe('新标题');
    expect(list[0].messageCount).toBe(2);
  });

  it('guards full session history from being overwritten by skeleton messages', () => {
    const fullSession: ChatSession = {
      id: 'sess-full',
      title: '长对话会话',
      messages: [
        { id: 'msg-1', role: 'user', content: '问题1', createdAt: 100 },
        { id: 'msg-2', role: 'assistant', content: '回答1', createdAt: 200 },
        { id: 'msg-3', role: 'user', content: '问题2', createdAt: 300 },
        { id: 'msg-4', role: 'assistant', content: '回答2', createdAt: 400 },
        { id: 'msg-5', role: 'user', content: '问题3', createdAt: 500 },
      ],
      updatedAt: 500,
      workspacePath: '/path/test',
    };
    store.save(fullSession);
    expect(store.get('sess-full')?.messages.length).toBe(5);

    // List returns skeleton with 2 fake messages
    const list = store.list();
    expect(list[0].messages.length).toBe(2);
    expect(list[0].messages[0].id).toContain('_preview');

    // Attempt to save the skeleton item back (e.g. from an unpatched modal)
    const skeletonSession: ChatSession = {
      ...list[0],
      title: '修改标题',
    };
    store.save(skeletonSession);

    // Full session on disk MUST still have all 5 original messages!
    const saved = store.get('sess-full');
    expect(saved).not.toBeNull();
    expect(saved?.title).toBe('修改标题');
    expect(saved?.messages.length).toBe(5);
    expect(saved?.messages[0].id).toBe('msg-1');
    expect(saved?.messages[4].id).toBe('msg-5');
  });

  it('allows legitimate rollback when first message matches and contains no skeleton', () => {
    const fullSession: ChatSession = {
      id: 'sess-rollback',
      title: '回滚测试会话',
      messages: [
        { id: 'm1', role: 'user', content: '问题1', createdAt: 100 },
        { id: 'm2', role: 'assistant', content: '回答1', createdAt: 200 },
        { id: 'm3', role: 'user', content: '问题2', createdAt: 300 },
        { id: 'm4', role: 'assistant', content: '回答2', createdAt: 400 },
      ],
      updatedAt: 400,
    };
    store.save(fullSession);
    expect(store.get('sess-rollback')?.messages.length).toBe(4);

    // 用户在第一轮点击重新编辑（回滚至第一轮，剩下 2 条真实消息）
    const rolledBackSession: ChatSession = {
      ...fullSession,
      messages: [
        { id: 'm1', role: 'user', content: '问题1(已编辑)', createdAt: 100 },
        { id: 'm2', role: 'assistant', content: '回答1', createdAt: 200 },
      ],
      updatedAt: 450,
    };
    store.save(rolledBackSession);

    const saved = store.get('sess-rollback');
    expect(saved?.messages.length).toBe(2);
    expect(saved?.messages[0].content).toBe('问题1(已编辑)');
  });
});
