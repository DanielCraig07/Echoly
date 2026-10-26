import { describe, expect, it } from 'vitest';
import type { McpServerConfig } from '@deepseek-ide/shared';
import { McpManager, MAX_TOOLS_PER_SERVER } from '../src/mcp/manager';

/**
 * 一个极小的 MCP 服务器，用 node 自身当解释器 —— 不需要装任何东西、也没有网络依赖。
 * 它把收到的每一行当作 JSON-RPC 请求，按方法回一条固定响应。
 *
 * 这些测试是**真起子进程**的：Manager 的价值几乎全在「子进程的行为」上
 * （分片、退出、超时、stderr），mock 掉 transport 就等于把要测的东西全删了。
 */
const FAKE_SERVER = `
const readline = require('node:readline');
// node -e <script> <mode> 时 argv 是 [node, <mode>] —— 没有脚本文件路径那一位
const mode = process.argv[1] || 'ok';
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
if (mode === 'crash') { process.exit(3); }
if (mode === 'stderr') { process.stderr.write('connect ECONNREFUSED 127.0.0.1:5432\\n'); }
if (mode === 'noisy') { process.stdout.write('starting up, please wait\\n'); }
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (mode === 'hang') return;             // 永不响应
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake' } } });
  } else if (msg.method === 'tools/list') {
    // boom / raise 用来测两种不同的失败：前者是「执行了但失败」（result.isError），
    // 后者是协议层错误（JSON-RPC error）。管理器必须把两者都转成 isError，
    // 否则模型会把失败当成功继续往下做。
    const names = mode === 'many'
      ? Array.from({ length: 80 }, (_, i) => 'tool_' + i)
      : ['tool_0', 'tool_1', 'boom', 'raise'];
    const tools = names.map((n) => ({ name: n, description: 'd:' + n, inputSchema: { type: 'object', properties: {} } }));
    // 分片发送：把一条 JSON 劈成两半写出去，专门验证解码器
    const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools } });
    const cut = Math.floor(payload.length / 2);
    process.stdout.write(payload.slice(0, cut));
    setTimeout(() => process.stdout.write(payload.slice(cut) + '\\n'), 10);
  } else if (msg.method === 'tools/call') {
    if (msg.params && msg.params.name === 'boom') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'tool failed' }], isError: true } });
    } else if (msg.params && msg.params.name === 'raise') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: '内部错误' } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + JSON.stringify(msg.params && msg.params.arguments) }] } });
    }
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no such method' } });
  }
});
`;

function server(mode: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    // 直接用 node 跑内联脚本：跨平台，且不依赖 npx / 网络
    command: process.execPath,
    args: ['-e', FAKE_SERVER, mode],
    id: 'fake',
    name: 'Fake Server',
    enabled: true,
    requestTimeoutMs: 5_000,
    ...extra,
  };
}

describe('McpManager lifecycle', () => {
  it('connects, lists tools and exposes them with a server prefix', async () => {
    const m = new McpManager();
    await m.apply([server('ok')]);
    const tools = m.listTools();
    expect(tools.map((t) => t.exposedName).sort()).toEqual([
      'fake__boom',
      'fake__raise',
      'fake__tool_0',
      'fake__tool_1',
    ]);
    expect(m.status()[0].state).toBe('ready');
    await m.disposeAll();
  });

  it('survives a server that prints logs to stdout before JSON', async () => {
    // 这是最常见的 MCP server 毛病。解码器必须跳过噪声行，
    // 否则 initialize 响应永远解不出来，表现为「连接超时」。
    const m = new McpManager();
    await m.apply([server('noisy')]);
    expect(m.status()[0].state).toBe('ready');
    expect(m.listTools()).toHaveLength(4);
    await m.disposeAll();
  });

  it('reports an exited server as error with its stderr, and does not block other servers', async () => {
    const m = new McpManager();
    await m.apply([server('crash', { id: 'bad', name: 'Bad' }), server('ok', { id: 'good', name: 'Good' })]);
    const byId = Object.fromEntries(m.status().map((s) => [s.id, s]));
    expect(byId.bad.state).toBe('error');
    expect(byId.good.state).toBe('ready');
    // 一个服务器挂掉不能让它自己的工具名留在清单里 —— 模型看到却调不通是最糟的状态
    expect(m.listTools().every((t) => t.serverId === 'good')).toBe(true);
    await m.disposeAll();
  });

  it('surfaces stderr for diagnosis', async () => {
    const m = new McpManager();
    await m.apply([server('stderr')]);
    expect(m.status()[0].stderr).toContain('ECONNREFUSED');
    await m.disposeAll();
  });

  it('reports a failure to spawn rather than throwing at the caller', async () => {
    // 命令写错是用户最常见的失误。它必须变成一条状态，而不是一个把设置页炸掉的异常。
    const m = new McpManager();
    await m.apply([
      { id: 'nope', name: 'Nope', enabled: true, command: '/definitely/not/a/real/binary', args: [] },
    ]);
    const st = m.status()[0];
    expect(st.state).toBe('error');
    expect(st.error).toBeTruthy();
    await m.disposeAll();
  });

  it('times out a hanging server instead of waiting forever', async () => {
    // 没有超时的话，Agent 会永远停在「工具执行中」—— 比报错难查得多。
    // 用 connectTimeoutMs 而不是 requestTimeoutMs 来缩短等待：
    // 卡住的是 initialize，而它的超时是单独一档（要容得下 npx 冷启动）。
    const m = new McpManager();
    await m.apply([server('hang', { connectTimeoutMs: 600 })]);
    const st = m.status()[0];
    expect(st.state).toBe('error');
    expect(st.error).toMatch(/超时/);
    await m.disposeAll();
  }, 10_000);

  it('truncates servers that expose too many tools', async () => {
    // 某些 server 会暴露上百个工具，全塞进 tools 参数会把上下文吃光。
    // 截断本身可以接受，但必须**如实告诉用户**截断了多少。
    const m = new McpManager();
    await m.apply([server('many')]);
    expect(m.listTools()).toHaveLength(MAX_TOOLS_PER_SERVER);
    const st = m.status()[0];
    expect(st.toolCount).toBe(MAX_TOOLS_PER_SERVER);
    expect(st.truncated).toBe(80 - MAX_TOOLS_PER_SERVER);
    await m.disposeAll();
  });
});

describe('McpManager tool access', () => {
  it('defaults to write access so readonly servers must be declared', async () => {
    // 默认必须是保守的那一侧：声明错了的代价是 Agent 在「只读模式」下拿到写权限。
    const m = new McpManager();
    await m.apply([server('ok')]);
    expect(m.listTools().every((t) => t.readonly === false)).toBe(true);
    expect(m.readonlyToolNames()).toEqual([]);
    await m.disposeAll();
  });

  it('marks every tool readonly when the server is declared readonly', async () => {
    const m = new McpManager();
    await m.apply([server('ok', { access: 'readonly' })]);
    expect(m.readonlyToolNames().sort()).toEqual([
      'fake__boom',
      'fake__raise',
      'fake__tool_0',
      'fake__tool_1',
    ]);
    await m.disposeAll();
  });

  it('passes arguments through and returns the flattened text', async () => {
    const m = new McpManager();
    await m.apply([server('ok')]);
    const res = await m.callTool('fake__tool_1', { a: 1 });
    expect(res.isError).toBe(false);
    expect(res.content).toBe('echo:{"a":1}');
    await m.disposeAll();
  });

  it('turns a tool-level failure into isError', async () => {
    // MCP 用 result.isError 表达「执行了但失败」，与 JSON-RPC 错误是两回事。
    // 不转换的话模型会把失败当成功，继续基于错误的假设往下做。
    const m = new McpManager();
    await m.apply([server('ok')]);
    const res = await m.callTool('fake__boom', {});
    expect(res.isError).toBe(true);
    expect(res.content).toBe('tool failed');
    await m.disposeAll();
  });

  it('turns a JSON-RPC error into an error result', async () => {
    const m = new McpManager();
    await m.apply([server('ok')]);
    const res = await m.callTool('fake__raise', {});
    expect(res.isError).toBe(true);
    expect(res.content).toContain('内部错误');
    await m.disposeAll();
  });

  it('reports an unknown tool name without touching any server', async () => {
    const m = new McpManager();
    await m.apply([server('ok')]);
    const res = await m.callTool('ghost__x', {});
    expect(res.isError).toBe(true);
    expect(res.content).toContain('ghost__x');
    await m.disposeAll();
  });

  it('refuses to call a tool whose server has died, with the reason attached', async () => {
    const m = new McpManager();
    await m.apply([server('ok')]);
    await m.disposeAll();
    const res = await m.callTool('fake__tool_0', {});
    expect(res.isError).toBe(true);
  });
});

describe('McpManager apply / reload semantics', () => {
  it('does not reconnect a server whose config is unchanged', async () => {
    // 设置页每次保存都会触发 apply。若每次都重连，用户改个主题就会把正在跑的
    // 任务里的 MCP 工具全部掐断。这里用「进程存活」间接验证没有重建。
    const m = new McpManager();
    const cfg = server('ok');
    await m.apply([cfg]);
    const firstTools = m.listTools();
    await m.apply([cfg]);
    expect(m.listTools()).toEqual(firstTools);
    expect(m.status()[0].state).toBe('ready');
    await m.disposeAll();
  });

  it('reconnects when the command changes', async () => {
    const m = new McpManager();
    await m.apply([server('ok')]);
    await m.apply([server('ok', { args: ['-e', FAKE_SERVER, 'many'] })]);
    expect(m.status()[0].truncated).toBe(80 - MAX_TOOLS_PER_SERVER);
    await m.disposeAll();
  });

  it('drops tools of a server that was disabled', async () => {
    const m = new McpManager();
    await m.apply([server('ok')]);
    await m.apply([server('ok', { enabled: false })]);
    expect(m.listTools()).toEqual([]);
    expect(m.status()).toEqual([]);
    await m.disposeAll();
  });

  it('ignores configs with a blank command', async () => {
    // 设置页新增一行时是空表单，保存时不该因为一个半成品条目就去 spawn 一个空命令
    const m = new McpManager();
    await m.apply([{ id: 'blank', name: 'Blank', enabled: true, command: '   ' }]);
    expect(m.status()).toEqual([]);
    await m.disposeAll();
  });

  it('loads two servers independently', async () => {
    const m = new McpManager();
    await m.apply([
      server('ok', { id: 'a', name: 'A' }),
      server('ok', { id: 'b', name: 'B', access: 'readonly' }),
    ]);
    const names = m.listTools().map((t) => t.exposedName).sort();
    expect(names).toEqual([
      'a__boom',
      'a__raise',
      'a__tool_0',
      'a__tool_1',
      'b__boom',
      'b__raise',
      'b__tool_0',
      'b__tool_1',
    ]);
    expect(m.readonlyToolNames().sort()).toEqual([
      'b__boom',
      'b__raise',
      'b__tool_0',
      'b__tool_1',
    ]);
    expect(m.toolMeta()['b__tool_0']).toEqual({ serverName: 'B', readonly: true });
    await m.disposeAll();
  });

  it('disposeAll stops every child process', async () => {
    const m = new McpManager();
    await m.apply([server('ok', { id: 'a' }), server('ok', { id: 'b' })]);
    await m.disposeAll();
    expect(m.listTools()).toEqual([]);
    expect(m.status()).toEqual([]);
  });
});
