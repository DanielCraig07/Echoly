import fs from 'node:fs';
import path from 'node:path';
import type { ChatSession, ChatSessionMessage } from '@deepseek-ide/shared';
import { writeFileAtomic } from './atomicWrite';

export interface SessionIndexItem {
  id: string;
  title: string;
  customTitle?: boolean;
  updatedAt: number;
  workspacePath?: string;
  projectName?: string;
  workspaceKind?: 'local' | 'ssh';
  gitBranch?: string;
  messageCount: number;
  snippet?: string;
  firstMsgSnippet?: string;
  lastMsgSnippet?: string;
}

export class SessionStore {
  private readonly dir: string;
  private readonly indexPath: string;
  private indexCache: Map<string, SessionIndexItem> | null = null;

  constructor(userDataPath: string) {
    this.dir = path.join(userDataPath, 'sessions');
    this.indexPath = path.join(this.dir, '_sessions_index.json');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  /**
   * 从会话实体生成轻量索引条目
   */
  private buildIndexItem(session: ChatSession): SessionIndexItem {
    const msgs = session.messages || [];
    const firstMsg = msgs[0]?.content || '';
    const lastMsg = msgs[msgs.length - 1]?.content || '';

    // 生成纯净文本摘要（过滤 markdown、代码块标记及换行）
    let snippet = session.snippet || '';
    if (!snippet) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (
          (m.role === 'user' || m.role === 'assistant') &&
          !m.isIntermediate &&
          m.content?.trim()
        ) {
          snippet = m.content
            .replace(/```[\s\S]*?```/g, '')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/#+\s*/g, '')
            .replace(/[*_~>]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (snippet) {
            snippet = snippet.length > 80 ? snippet.slice(0, 80) + '…' : snippet;
            break;
          }
        }
      }
    }

    return {
      id: session.id,
      title: session.title,
      customTitle: session.customTitle,
      updatedAt: session.updatedAt || Date.now(),
      workspacePath: session.workspacePath,
      projectName: session.projectName,
      workspaceKind: session.workspaceKind,
      gitBranch: session.gitBranch,
      messageCount: session.messageCount ?? msgs.length,
      snippet,
      firstMsgSnippet: firstMsg.slice(0, 100),
      lastMsgSnippet: lastMsg.slice(0, 100),
    };
  }

  /**
   * 将索引持久化落盘
   */
  private flushIndex(): void {
    if (!this.indexCache) return;
    try {
      const items = Array.from(this.indexCache.values());
      writeFileAtomic(this.indexPath, JSON.stringify(items, null, 2));
    } catch (err) {
      console.warn('[SessionStore] Failed to write sessions index', err);
    }
  }

  /**
   * 确保索引就绪。优先从轻量索引文件载入，如发现增量或初次运行则自动扫描补齐
   */
  private ensureIndex(): Map<string, SessionIndexItem> {
    if (this.indexCache) {
      return this.indexCache;
    }

    const map = new Map<string, SessionIndexItem>();
    let loadedFromDisk = false;

    if (fs.existsSync(this.indexPath)) {
      try {
        const raw = fs.readFileSync(this.indexPath, 'utf8');
        const parsed = JSON.parse(raw) as SessionIndexItem[];
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && item.id) {
              map.set(item.id, item);
            }
          }
          loadedFromDisk = true;
        }
      } catch (err) {
        console.warn('[SessionStore] Index corrupt or read failed, rebuilding', err);
      }
    }

    // 检查是否有磁盘文件尚未收录到索引中（例如外部复制、版本升级或索引缺失）
    try {
      const files = fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.json') && !f.startsWith('_') && !f.startsWith('.'));

      let changed = !loadedFromDisk;
      for (const f of files) {
        const id = f.slice(0, -5);
        if (!map.has(id)) {
          try {
            const fullPath = path.join(this.dir, f);
            const session = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as ChatSession;
            map.set(session.id, this.buildIndexItem(session));
            changed = true;
          } catch {
            // 跳过无法解析的废弃损坏文件
          }
        }
      }

      // 如果有磁盘已删除了的文件，从索引中摘除
      const fileIdSet = new Set(files.map((f) => f.slice(0, -5)));
      for (const id of map.keys()) {
        if (!fileIdSet.has(id)) {
          map.delete(id);
          changed = true;
        }
      }

      this.indexCache = map;
      if (changed) {
        this.flushIndex();
      }
    } catch (err) {
      console.warn('[SessionStore] Failed to scan session files', err);
      this.indexCache = map;
    }

    return this.indexCache;
  }

  /**
   * 极速返回会话列表摘要（基于轻量索引，毫秒级响应，不触碰大体积全量会话文件）
   */
  list(): ChatSession[] {
    const index = this.ensureIndex();
    const items = Array.from(index.values());

    // 按照更新时间从新到旧排序
    items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    // 智能去重：识别相同工作区、相同消息数、首末消息完全相同的重复会话
    const uniqueSessions: ChatSession[] = [];
    const seenFingerprints = new Set<string>();

    for (const item of items) {
      const ws = item.workspacePath || '';
      const first = item.firstMsgSnippet || '';
      const last = item.lastMsgSnippet || '';
      const fingerprint =
        item.messageCount === 0
          ? `empty_${item.id}`
          : `${ws}##${item.messageCount}##${item.title}##${first}##${last}`;

      if (seenFingerprints.has(fingerprint)) {
        continue;
      }
      seenFingerprints.add(fingerprint);

      // 为兼容前端现存的消息过滤逻辑，构建精简的伪消息骨架
      const skeletonMessages: ChatSessionMessage[] = [];
      if (item.messageCount > 0) {
        skeletonMessages.push({
          id: `${item.id}_preview`,
          role: 'user',
          content: item.firstMsgSnippet || item.title || '',
          createdAt: item.updatedAt,
        });
        if (item.snippet) {
          skeletonMessages.push({
            id: `${item.id}_snippet`,
            role: 'assistant',
            content: item.snippet,
            createdAt: item.updatedAt,
          });
        }
      }

      uniqueSessions.push({
        id: item.id,
        title: item.title,
        customTitle: item.customTitle,
        messages: skeletonMessages,
        updatedAt: item.updatedAt,
        workspacePath: item.workspacePath,
        projectName: item.projectName,
        workspaceKind: item.workspaceKind,
        gitBranch: item.gitBranch,
        messageCount: item.messageCount,
        snippet: item.snippet,
      });
    }

    return uniqueSessions;
  }

  get(id: string): ChatSession | null {
    const p = this.file(id);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')) as ChatSession;
    } catch {
      return null;
    }
  }

  save(session: ChatSession): void {
    const filePath = this.file(session.id);
    let sessionToSave = session;

    // 核心安全防护：绝不允许用骨架消息或轻量索引条目覆盖破坏磁盘上的真实完整会话
    if (fs.existsSync(filePath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ChatSession;
        const incomingMessages = session.messages || [];
        const existingMessages = existing.messages || [];

        const incomingHasSkeleton =
          incomingMessages.length > 0 &&
          incomingMessages.some(
            (m) =>
              typeof m.id === 'string' && (m.id.endsWith('_preview') || m.id.endsWith('_snippet')),
          );

        const isDegradedOrSkeleton =
          incomingHasSkeleton ||
          (!incomingMessages.length && existingMessages.length > 0) ||
          (existingMessages.length > incomingMessages.length &&
            incomingMessages.length <= 2 &&
            existingMessages[0]?.id !== incomingMessages[0]?.id);

        if (isDegradedOrSkeleton) {
          sessionToSave = {
            ...session,
            messages: existingMessages,
            messageCount: existing.messageCount ?? existingMessages.length,
          };
        }
      } catch (err) {
        console.warn('[SessionStore] Failed to read existing session for safe merge', err);
      }
    }

    // 1. 原子写：写独立会话完整文件
    writeFileAtomic(filePath, JSON.stringify(sessionToSave, null, 2));

    // 2. 增量更新内存索引与轻量索引文件
    const index = this.ensureIndex();
    index.set(sessionToSave.id, this.buildIndexItem(sessionToSave));
    this.flushIndex();
  }

  /**
   * 独立重命名接口，只更新会话元数据（标题），杜绝触碰消息体
   */
  rename(id: string, newTitle: string): void {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    const existing = this.get(id);
    if (!existing) {
      // 容错：如果仅在索引中存在
      const index = this.ensureIndex();
      const item = index.get(id);
      if (item) {
        item.title = trimmed;
        item.customTitle = true;
        item.updatedAt = Date.now();
        this.flushIndex();
      }
      return;
    }
    existing.title = trimmed;
    existing.customTitle = true;
    existing.updatedAt = Date.now();
    this.save(existing);
  }

  delete(id: string): void {
    const p = this.file(id);
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch (err) {
        console.warn(`[SessionStore] Failed to unlink ${p}:`, err);
      }
    }

    const index = this.ensureIndex();
    if (index.has(id)) {
      index.delete(id);
      this.flushIndex();
    }
  }
}
