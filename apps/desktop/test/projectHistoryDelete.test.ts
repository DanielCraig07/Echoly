import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatSession } from '@deepseek-ide/shared';
import { buildSqlConfirmMarkdown } from '../src/renderer/src/services/dbConfirmContent';

describe('Project History Session Deletion Logic', () => {
  const sampleSessions: ChatSession[] = [
    {
      id: 'session-1',
      title: '分析项目',
      workspacePath: '/Users/test/catering-mini-app',
      messageCount: 52,
      messages: [
        { id: 'm1', role: 'user', content: '项目分析', createdAt: 1730000000000 },
        { id: 'm2', role: 'assistant', content: '餐饮营销系统', createdAt: 1730000000000 },
      ],
      updatedAt: 1730000000000,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates correct confirmation payload with session title and message count', () => {
    const t = (k: string, vars?: any) => {
      if (k === 'session.turnsCount') return `${vars?.n} 条对话`;
      if (k === 'chat.deleteSessionConfirm')
        return `确定删除历史会话「${vars?.title}」？此操作不可撤销。`;
      return k;
    };

    const target = sampleSessions[0];
    const confirmPayload = {
      title: t('session.deleteTitle'),
      content: buildSqlConfirmMarkdown({
        t: t as any,
        intro: t('chat.deleteSessionConfirm', { title: target.title }),
        statements: [],
      }),
      details: [
        { label: t('session.labelTitle'), value: target.title },
        {
          label: t('session.labelTurns'),
          value: t('session.turnsCount', {
            n: target.messageCount,
          }),
        },
      ],
      tone: 'danger',
      confirmLabel: t('session.confirmDelete'),
    };

    expect(confirmPayload.tone).toBe('danger');
    expect(confirmPayload.details[0].value).toBe('分析项目');
    expect(confirmPayload.details[1].value).toBe('52 条对话');
  });

  it('executes deletion and invokes callback when confirmed', async () => {
    const deleteSessionMock = vi.fn().mockResolvedValue(true);
    const onSessionDeleted = vi.fn();
    let sessions = [...sampleSessions];

    const handleDelete = async (id: string, ok: string | null) => {
      if (ok === null) return;
      sessions = sessions.filter((s) => s.id !== id);
      await deleteSessionMock(id);
      onSessionDeleted(id);
    };

    // 模拟确认删除
    await handleDelete('session-1', '');
    expect(deleteSessionMock).toHaveBeenCalledWith('session-1');
    expect(onSessionDeleted).toHaveBeenCalledWith('session-1');
    expect(sessions).toHaveLength(0);
  });

  it('aborts deletion when user cancels', async () => {
    const deleteSessionMock = vi.fn().mockResolvedValue(true);
    const onSessionDeleted = vi.fn();
    let sessions = [...sampleSessions];

    const handleDelete = async (id: string, ok: string | null) => {
      if (ok === null) return;
      sessions = sessions.filter((s) => s.id !== id);
      await deleteSessionMock(id);
      onSessionDeleted(id);
    };

    // 模拟取消
    await handleDelete('session-1', null);
    expect(deleteSessionMock).not.toHaveBeenCalled();
    expect(onSessionDeleted).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(1);
  });
});
