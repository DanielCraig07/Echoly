import fs from 'node:fs';
import path from 'node:path';
import type { ChatSession } from '@deepseek-ide/shared';
import { writeFileAtomic } from './atomicWrite';

export class SessionStore {
  private readonly dir: string;

  constructor(userDataPath: string) {
    this.dir = path.join(userDataPath, 'sessions');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  list(): ChatSession[] {
    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    const sessions: ChatSession[] = [];
    for (const f of files) {
      try {
        sessions.push(JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as ChatSession);
      } catch {
        // skip
      }
    }
    // 按照更新时间从新到旧排序
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    // 智能去重
    // 识别相同工作区、相同消息数、首末消息完全相同的重复会话
    //
    // **只影响返回的列表，不删磁盘上的文件**。旧实现在这里 `unlinkSync` 掉
    // 「重复」的那个会话，而这个指纹是启发式的（工作区 + 条数 + 标题 + 首末各 100 字符），
    // 两次正常对话完全可能撞上同一个指纹 —— 那是一次静默的、不可撤销的删除，
    // 而且发生在 list() 里：用户只是**打开会话列表看一眼**就会丢数据。
    // 读取操作不该有副作用；真要清理得由用户显式触发。
    const uniqueSessions: ChatSession[] = [];
    const seenFingerprints = new Set<string>();

    for (const session of sessions) {
      const msgs = session.messages || [];
      const firstMsg = msgs[0]?.content || '';
      const lastMsg = msgs[msgs.length - 1]?.content || '';
      const ws = session.workspacePath || '';
      // 构建指纹：工作区 + 消息数 + 标题 + 首条和末条内容
      const fingerprint =
        msgs.length === 0
          ? `empty_${session.id}`
          : `${ws}##${msgs.length}##${session.title}##${firstMsg.slice(0, 100)}##${lastMsg.slice(0, 100)}`;

      if (seenFingerprints.has(fingerprint)) {
        // 内容与已保留的会话一致：不出现在列表里，但文件原样留着，
        // 靠 id 依然能直接打开（会话 Tab 恢复用的就是 id）。
        continue;
      }
      seenFingerprints.add(fingerprint);
      uniqueSessions.push(session);
    }

    return uniqueSessions;
  }

  get(id: string): ChatSession | null {
    const p = this.file(id);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as ChatSession;
  }

  save(session: ChatSession): void {
    // 原子写：会话文件是用户唯一的对话记录，写到一半断电会留下一个
    // 解析不了的 JSON —— 而 `list()` 对解析失败是**静默跳过**的，
    // 表现就是「这次对话凭空消失了」。先写临时文件再 rename，保证要么旧要么新。
    writeFileAtomic(this.file(session.id), JSON.stringify(session, null, 2));
  }

  delete(id: string): void {
    const p = this.file(id);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}
