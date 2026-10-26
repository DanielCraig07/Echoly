import { app } from 'electron';
import { McpManager, type McpServerStatus } from '@deepseek-ide/agent';
import type { McpServerConfig } from '@deepseek-ide/shared';
import type { ToolResult } from '@deepseek-ide/tools';
import type { SettingsStore } from './settings';

/**
 * MCP 服务器在应用里的宿主：把「设置里的配置」与「实际跑着的子进程」接起来。
 *
 * 为什么是进程级单例而不是每个窗口一份：stdio 子进程不绑定任何工作区，
 * 一个窗口连三个服务器、另开一个窗口又连一遍，等于同一台机器上跑六份
 * （它们可能各自持有数据库连接、索引缓存）。多窗口共享一份连接既是资源上的正确做法，
 * 也避免了「在窗口 A 里改配置，窗口 B 用的还是老进程」这种难以解释的状态。
 *
 * 反复 reload 的安全性是本文件的核心关切：设置页每保存一次都会触发 reload，
 * 而 reload 若重建所有连接，正在跑的任务会瞬间失去全部 MCP 工具。
 * 因此真正的「配置有无变化」判断下沉到 `McpManager.apply`，这里只负责传配置。
 */
export class McpService {
  private readonly inner = new McpManager();
  /** 首次 reload 之前的惰性状态：没人调用过就不启动任何子进程。 */
  private loaded = false;

  constructor(private readonly settings: SettingsStore) {}

  private configs(): McpServerConfig[] {
    return (this.settings.get().mcpServers ?? []).filter((c) => c && c.id && c.command);
  }

  /**
   * 按当前设置重连。返回各服务器状态。
   *
   * 只在真的需要时才连：用户在设置里改了别的选项（主题、字号）也会走 save，
   * 若那次 save 顺带把 MCP 全部重连一遍，体感就是「改个主题把 Agent 弄卡了」。
   */
  async reload(): Promise<McpServerStatus[]> {
    this.loaded = true;
    return await this.inner.apply(this.configs());
  }

  /** 首次需要工具时才启动 —— 没用 MCP 的会话不该被塞进一堆子进程。 */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.inner.apply(this.configs());
  }

  async status(): Promise<McpServerStatus[]> {
    if (!this.loaded) return [];
    return this.inner.status();
  }

  async disposeAll(): Promise<void> {
    this.loaded = false;
    await this.inner.disposeAll();
  }

  /**
   * 暴露 Manager 本身给 Agent 循环：它需要一次性拿到 definitions / readonlyNames / meta
   * 三项，且必须来自同一时刻（分三次调用之间可能有服务器掉线，拼出来的清单会自相矛盾）。
   */
  manager(): McpManager {
    return this.inner;
  }

  /** 供 Agent 循环调用。错误在这里被转成 ToolResult，不让它抛穿整个工具链。 */
  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.inner.callTool(name, args);
    return { content: result.content, isError: result.isError };
  }
}

/** 用户级命令目录，与 skills 同级。 */
export function userCommandsDir(): string {
  return `${app.getPath('userData')}/commands`;
}
