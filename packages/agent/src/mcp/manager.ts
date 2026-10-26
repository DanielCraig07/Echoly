import type { ToolDefinition } from '@deepseek-ide/shared';
import type { McpServerConfig, McpServerStatus } from '@deepseek-ide/shared';
import { StdioMcpTransport, type StdioTransportOptions } from './transport.js';
import {
  MCP_CLIENT_INFO,
  MCP_PROTOCOL_VERSION,
  flattenMcpContent,
  mcpToolName,
} from './protocol.js';

/**
 * MCP 服务器连接管理：把若干 stdio 子进程变成一组可调用的工具。
 *
 * 为什么不引 `@modelcontextprotocol/sdk`：本仓库的 main 进程把第三方依赖全部 externalize
 * （`electron.vite.config.ts` 的 `externalizeDepsPlugin`），新增一个运行时依赖意味着
 * 打包产物必须带上它、且要经得起 Electron 的 ABI/模块格式折腾。而 stdio + JSON-RPC +
 * 三个方法（initialize / tools/list / tools/call）的实现成本很低 —— 自己写反而更可控，
 * 也让整条链路可以在没有 Electron 的环境里单测。
 *
 * 三条设计约束贯穿本文件：
 *
 * 1. **一个服务器挂了不能拖垮其它服务器**：连接失败只影响它自己，工具的命名空间
 *    （`<serverId>__<tool>`）保证模型仍能正常调用其它服务器的工具。
 * 2. **工具数量要有上界**：某些 server 会暴露上百个工具，全塞进 `tools` 参数会
 *    把上下文吃光。超限时截断，并把截断事实记进 `status()`，让界面能如实告诉用户。
 * 3. **只读性由用户声明，不靠猜**：MCP 工具的作用完全取决于它连的是什么系统，
 *    协议里没有任何东西能告诉我们它会不会改数据。所以 `access` 是配置项，
 *    默认 `write`（保守），只有用户显式声明才进 ask/plan 模式。
 */

/** 单个服务器暴露的工具数上限。超出部分会被截断并在状态里标明。 */
export const MAX_TOOLS_PER_SERVER = 60;

/**
 * 配置与状态类型定义在 `@deepseek-ide/shared`：设置界面与主进程的持久化层都要用它们，
 * 而渲染层不能反向依赖 agent 包。这里只做转出，方便执行侧引用。
 */
export type { McpServerConfig, McpServerStatus };

export interface McpToolInfo {
  /** 暴露给模型的完整工具名（`<serverId>__<tool>`）。 */
  exposedName: string;
  /** server 侧的原始工具名。 */
  originalName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverId: string;
  readonly: boolean;
}

interface ServerRuntime {
  config: McpServerConfig;
  transport: StdioMcpTransport | null;
  tools: McpToolInfo[];
  truncated: number;
  state: McpServerStatus['state'];
  error?: string;
}

/**
 * initialize 的响应。
 *
 * `protocolVersion` 是服务端**实际**采用的版本，可能与我们请求的不同 ——
 * 规范要求客户端据此降级，而不是拒绝连接。这里记录下来仅供状态展示，
 * 因为我们要用的三个方法在已知各版本里签名一致。
 */
interface InitializeResult {
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
}

interface ToolsListResult {
  tools?: Array<{
    name?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
}

interface ToolCallResult {
  content?: unknown;
  isError?: boolean;
}

export class McpManager {
  private servers = new Map<string, ServerRuntime>();
  /** 暴露名 → 归属信息。反向映射靠这张表，不靠解析名字（有损规范化不可逆）。 */
  private toolIndex = new Map<string, McpToolInfo>();
  /** 防止多个调用方同时触发同一服务器的连接。 */
  private connecting = new Map<string, Promise<void>>();

  /**
   * 应用配置。已连接的服务器若配置未变则保持连接不动 —— 每次保存设置都重连
   * 会让正在跑的任务里的工具调用全部中断，而用户可能只是改了个别的设置项。
   */
  async apply(configs: McpServerConfig[]): Promise<McpServerStatus[]> {
    const wanted = new Map(configs.filter((c) => c.enabled && c.command.trim()).map((c) => [c.id, c]));

    for (const [id, runtime] of [...this.servers]) {
      const next = wanted.get(id);
      if (!next || !sameServer(runtime.config, next)) {
        await this.disconnect(id);
      }
    }

    const results = await Promise.all(
      [...wanted.values()].map((cfg) => this.ensureConnected(cfg).catch(() => undefined)),
    );
    void results;
    return this.status();
  }

  private async ensureConnected(config: McpServerConfig): Promise<void> {
    const existing = this.servers.get(config.id);
    if (existing?.state === 'ready') return;
    const inFlight = this.connecting.get(config.id);
    if (inFlight) return inFlight;

    const promise = this.connect(config).finally(() => this.connecting.delete(config.id));
    this.connecting.set(config.id, promise);
    return promise;
  }

  private async connect(config: McpServerConfig): Promise<void> {
    const runtime: ServerRuntime = {
      config,
      transport: null,
      tools: [],
      truncated: 0,
      state: 'connecting',
    };
    this.servers.set(config.id, runtime);
    this.dropToolsOf(config.id);

    const options: StdioTransportOptions = {
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
      shell: config.shell,
      requestTimeoutMs: config.requestTimeoutMs,
    };

    try {
      const transport = new StdioMcpTransport(options);
      // 先登记再 start：子进程可能在 start() 返回前就报错退出，
      // 那时 exit 处理器需要能通过 runtime 找到自己来写错误状态。
      runtime.transport = transport;
      transport.start();

      await transport.request<InitializeResult>(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          clientInfo: MCP_CLIENT_INFO,
        },
        // 冷启动要留给 npx 下载包的时间，比普通请求宽得多。用户可以显式设 connectTimeoutMs
        // 覆盖（例如服务器是本地已装好的二进制，启动只要几十毫秒）。
        config.connectTimeoutMs ?? Math.max(config.requestTimeoutMs ?? 30_000, 60_000),
      );
      // 规范要求：initialize 响应后必须回一个 initialized 通知，否则部分 server 不会
      // 开始接受 tools/list。
      transport.notify('notifications/initialized', {});

      const listed = await transport.request<ToolsListResult>('tools/list', {});
      const all = (listed.tools ?? []).filter(
        (t): t is { name: string; description?: string; inputSchema?: Record<string, unknown> } =>
          typeof t?.name === 'string' && t.name.length > 0,
      );
      runtime.truncated = Math.max(0, all.length - MAX_TOOLS_PER_SERVER);
      runtime.tools = all.slice(0, MAX_TOOLS_PER_SERVER).map((t) => this.toToolInfo(config, t));
      for (const info of runtime.tools) this.toolIndex.set(info.exposedName, info);
      runtime.state = 'ready';
      runtime.error = undefined;
    } catch (err) {
      runtime.state = 'error';
      runtime.error = err instanceof Error ? err.message : String(err);
      runtime.tools = [];
      this.dropToolsOf(config.id);
      // 连接失败就把进程收掉：留着一个半死的子进程既占资源，又会在下次 apply 时
      // 因为 state !== 'ready' 而被重复启动。
      await runtime.transport?.close().catch(() => undefined);
      runtime.transport = null;
    }
  }

  private toToolInfo(
    config: McpServerConfig,
    tool: { name: string; description?: string; inputSchema?: Record<string, unknown> },
  ): McpToolInfo {
    const readonly = config.access === 'readonly';
    return {
      exposedName: mcpToolName(config.id, tool.name),
      originalName: tool.name,
      description: tool.description?.trim() || `MCP 工具 ${tool.name}`,
      // 没有 inputSchema 时给一个空 object schema：MCP 规范允许无参数工具省略它，
      // 但 OpenAI 的 tools 参数要求 parameters 必须存在。
      inputSchema:
        tool.inputSchema && typeof tool.inputSchema === 'object'
          ? tool.inputSchema
          : { type: 'object', properties: {} },
      serverId: config.id,
      readonly,
    };
  }

  private dropToolsOf(serverId: string): void {
    for (const [name, info] of [...this.toolIndex]) {
      if (info.serverId === serverId) this.toolIndex.delete(name);
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const runtime = this.servers.get(serverId);
    if (!runtime) return;
    this.dropToolsOf(serverId);
    await runtime.transport?.close().catch(() => undefined);
    this.servers.delete(serverId);
  }

  async disposeAll(): Promise<void> {
    const ids = [...this.servers.keys()];
    await Promise.all(ids.map((id) => this.disconnect(id)));
    this.toolIndex.clear();
  }

  /** 已就绪服务器暴露的工具。未就绪的服务器不贡献工具，模型因此不会看到调不通的名字。 */
  listTools(): McpToolInfo[] {
    return [...this.toolIndex.values()];
  }

  /** 转成 LLM 的 tools 参数格式。 */
  toToolDefinitions(): ToolDefinition[] {
    return this.listTools().map((info) => ({
      type: 'function' as const,
      function: {
        name: info.exposedName,
        description: `${info.description}\n（来自 MCP 服务器「${this.servers.get(info.serverId)?.config.name ?? info.serverId}」）`,
        parameters: info.inputSchema,
      },
    }));
  }

  /** 只读工具的暴露名集合，供 Ask/Plan 模式筛选。 */
  readonlyToolNames(): string[] {
    return this.listTools().filter((t) => t.readonly).map((t) => t.exposedName);
  }

  /**
   * 暴露名 → 归属信息，直接喂给 `AgentRunOptions.mcp.meta`。
   *
   * 放在这里而不是让宿主自己拼：服务器名与只读性都只存在于 Manager 内部
   * （配置 + runtime），宿主手里只有一份 `ToolDefinition[]`，拼出来必然缺字段。
   */
  toolMeta(): Record<string, { serverName: string; readonly: boolean }> {
    const out: Record<string, { serverName: string; readonly: boolean }> = {};
    for (const info of this.listTools()) {
      out[info.exposedName] = {
        serverName: this.servers.get(info.serverId)?.config.name ?? info.serverId,
        readonly: info.readonly,
      };
    }
    return out;
  }

  isMcpTool(name: string): boolean {
    return this.toolIndex.has(name);
  }

  /**
   * 调用一个 MCP 工具。
   *
   * 传进来的 `name` 必须是暴露名（模型看到的就是它）。参数原样透传 —— 校验是 server 的
   * 职责，我们这边只做一次「是不是对象」的保险，防止把字符串塞进要求 object 的字段。
   */
  async callTool(name: string, args: unknown): Promise<{ content: string; isError: boolean }> {
    const info = this.toolIndex.get(name);
    if (!info) {
      return { content: `未知的 MCP 工具：${name}`, isError: true };
    }
    const runtime = this.servers.get(info.serverId);
    if (!runtime?.transport || runtime.state !== 'ready') {
      return {
        content: `MCP 服务器「${runtime?.config.name ?? info.serverId}」当前不可用${
          runtime?.error ? `：${runtime.error}` : ''
        }。请在设置 → MCP 中检查该服务器。`,
        isError: true,
      };
    }

    try {
      const result = await runtime.transport.request<ToolCallResult>('tools/call', {
        name: info.originalName,
        arguments: args && typeof args === 'object' ? args : {},
      });
      const text = flattenMcpContent(result);
      // MCP 用 result.isError 表达「工具执行了但失败」，与 JSON-RPC 错误是两回事。
      // 必须转成我们自己的 isError，否则模型会把失败当成功继续往下走。
      return { content: text, isError: result.isError === true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 连接层错误往往意味着进程死了，如实反映到状态里，界面上就能看到红点
      if (runtime.state === 'ready' && !runtime.transport.isRunning) {
        runtime.state = 'error';
        runtime.error = message;
      }
      return { content: `调用 MCP 工具 ${info.exposedName} 失败：${message}`, isError: true };
    }
  }

  status(): McpServerStatus[] {
    return [...this.servers.values()].map((runtime) => ({
      id: runtime.config.id,
      name: runtime.config.name,
      enabled: runtime.config.enabled,
      state: runtime.state,
      toolCount: runtime.tools.length,
      truncated: runtime.truncated,
      error: runtime.error,
      stderr: runtime.transport?.stderrTail(12),
    }));
  }
}

/** 判断两个配置是否指向「同一个进程」——变了才需要重连。 */
function sameServer(a: McpServerConfig, b: McpServerConfig): boolean {
  return (
    a.command === b.command &&
    a.cwd === b.cwd &&
    a.shell === b.shell &&
    a.access === b.access &&
    a.requestTimeoutMs === b.requestTimeoutMs &&
    a.connectTimeoutMs === b.connectTimeoutMs &&
    JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []) &&
    JSON.stringify(a.env ?? {}) === JSON.stringify(b.env ?? {})
  );
}
