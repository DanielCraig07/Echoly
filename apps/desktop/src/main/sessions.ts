import fs from 'node:fs';
import path from 'node:path';
import type { ChatSession } from '@deepseek-ide/shared';

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

    // 智能去重与多余副本文件清理
    // 识别相同工作区、相同消息数、首末消息完全相同的重复会话
    const uniqueSessions: ChatSession[] = [];
    const seenFingerprints = new Map<string, string>(); // fingerprint -> kept session id

    for (const session of sessions) {
      const msgs = session.messages || [];
      const firstMsg = msgs[0]?.content || '';
      const lastMsg = msgs[msgs.length - 1]?.content || '';
      const ws = session.workspacePath || '';
      // 构建指纹：工作区 + 消息数 + 标题 + 首条和末条内容
      const fingerprint = msgs.length === 0
        ? `empty_${session.id}`
        : `${ws}##${msgs.length}##${session.title}##${firstMsg.slice(0, 100)}##${lastMsg.slice(0, 100)}`;

      if (seenFingerprints.has(fingerprint)) {
        // 已有相同内容的最新会话，清理磁盘上的冗余重复文件
        try {
          const dupFile = this.file(session.id);
          if (fs.existsSync(dupFile)) {
            fs.unlinkSync(dupFile);
          }
        } catch {
          // ignore unlink error
        }
      } else {
        seenFingerprints.set(fingerprint, session.id);
        uniqueSessions.push(session);
      }
    }

    return uniqueSessions;
  }

  get(id: string): ChatSession | null {
    const p = this.file(id);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as ChatSession;
  }

  save(session: ChatSession): void {
    fs.writeFileSync(this.file(session.id), JSON.stringify(session, null, 2), 'utf8');
  }

  delete(id: string): void {
    const p = this.file(id);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}
