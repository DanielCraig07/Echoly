/**
 * MCP（Model Context Protocol）的 JSON-RPC 2.0 线上格式。
 *
 * 只实现 stdio 传输用得到的那一层：请求 / 响应 / 通知三种消息，
 * 以及一个能吞任意分片的行解码器。
 *
 * 为什么这层要独立成文件、而不是写进 transport：它是唯一一处**不依赖子进程**的逻辑，
 * 因此可以在没有 Electron、没有真实 MCP server 的情况下单测。
 * 解码器尤其需要 —— 子进程 stdout 的分片边界完全不受我们控制，
 * 一个 JSON 消息被切成三段是常态，"按 chunk 直接 JSON.parse" 是这类实现最常见的 bug。
 */

/** 协议版本号。服务端不认识时会在 initialize 响应里返回它自己支持的版本。 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** 客户端标识，会随 initialize 一起发给服务端。 */
export const MCP_CLIENT_INFO = { name: 'echoly', version: '1.0.0' } as const;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number | string;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export function isJsonRpcResponse(msg: unknown): msg is JsonRpcResponse {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  if (m.jsonrpc !== '2.0') return false;
  // 有 id 且带 result 或 error 的才是响应；带 method 的是请求/通知
  if ('method' in m) return false;
  if (!('id' in m)) return false;
  return 'result' in m || 'error' in m;
}

export function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  return m.jsonrpc === '2.0' && typeof m.method === 'string' && 'id' in m;
}

export function isJsonRpcNotification(msg: unknown): msg is JsonRpcNotification {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  return m.jsonrpc === '2.0' && typeof m.method === 'string' && !('id' in m);
}

/** MCP 错误码里对我们有意义的那几个，其余原样透传给模型看。 */
export const MCP_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * 行分隔的 JSON 解码器。
 *
 * MCP 的 stdio 传输**不是** LSP 那种 `Content-Length:` 头 + 正文，
 * 而是每行一个完整 JSON。这带来两个必须处理的现实问题：
 *
 * 1. **分片**：一次 `data` 事件可能只到半个 JSON，也可能一口气到三个。
 *    因此维护一个未消化的尾缓冲，只在遇到 `\n` 时才尝试解析。
 * 2. **污染**：很多 server 会往 stdout 打日志（那是 stderr 该干的事，但它们不）。
 *    遇到解析不了的行不能整个崩掉 —— 丢掉这一行、继续读下一行，
 *    否则一个 server 的日志就能让整个 MCP 功能静默失效。
 *
 * 解析失败的行会被交给 `onJunk`，由调用方并入 stderr 诊断日志，方便用户自查。
 */
export class LineJsonRpcDecoder {
  private buffer = '';

  constructor(private readonly onJunk?: (line: string) => void) {}

  /** 喂入一段分片，返回本次能完整解析出来的消息（可能为空数组）。 */
  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const out: unknown[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.trim().length === 0) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // 不是合法 JSON：大概率是 server 误打到 stdout 的日志
        this.onJunk?.(line);
      }
    }
    return out;
  }

  /** 进程结束时调用：把没有换行符收尾的残余也试一次。 */
  flush(): unknown[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (!rest) return [];
    try {
      return [JSON.parse(rest)];
    } catch {
      this.onJunk?.(rest);
      return [];
    }
  }
}

/**
 * 把 MCP 的工具返回拍平成纯文本，喂给模型。
 *
 * MCP 的 `tools/call` 返回的是 `content: [{type:'text'|'image'|'resource', ...}]`。
 * 图片与内嵌资源在我们的工具结果通道里没有承载物（工具返回值就是一个字符串），
 * 所以这里不静默丢弃，而是写一行占位说明 —— 让模型知道"这里本来有东西但它拿不到"，
 * 比让它以为结果是空的要好。
 */
export function flattenMcpContent(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result ?? '');
  const blocks = (result as { content?: unknown }).content;
  if (!Array.isArray(blocks)) {
    // 少数 server 直接返回结构化对象（违反规范但存在），原样序列化
    return JSON.stringify(result);
  }
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    } else if (b.type === 'image') {
      parts.push(
        `[图片内容：${String(b.mimeType ?? '未知类型')}，当前工具结果通道不支持图片，未传入]`,
      );
    } else if (b.type === 'resource') {
      const res = b.resource as Record<string, unknown> | undefined;
      if (res && typeof res.text === 'string') parts.push(res.text);
      else parts.push(`[内嵌资源：${String(res?.uri ?? '未知')}]`);
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  if (parts.length === 0) return '(空结果)';
  return parts.join('\n');
}

/**
 * 把 server 名 + 工具名拼成模型可见的工具名。
 *
 * 约束来自 OpenAI 的工具名格式要求：只允许 `[a-zA-Z0-9_-]`，且长度有上限。
 * 因此这里做的是**有损规范化**（非法字符换成 `_`、超长截断），
 * 而反向映射不靠解析名字，靠 Manager 里那张显式表 —— 有损变换是不可逆的，
 * 靠字符串猜回去必然在某个 server 上出错。
 */
export function mcpToolName(serverId: string, toolName: string): string {
  const raw = `${serverId}__${toolName}`;
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  return safe.length <= 64 ? safe : safe.slice(0, 64);
}
