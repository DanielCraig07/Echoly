import { describe, expect, it } from 'vitest';
import {
  LineJsonRpcDecoder,
  flattenMcpContent,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  mcpToolName,
} from '../src/mcp/protocol';

describe('LineJsonRpcDecoder', () => {
  it('parses one message per line', () => {
    const d = new LineJsonRpcDecoder();
    const out = d.push('{"a":1}\n{"a":2}\n');
    expect(out).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('reassembles a message split across chunks', () => {
    // 这是本解码器存在的全部理由：stdout 的分片边界由操作系统决定，
    // 一条 JSON 被切成三段是常态，按 chunk 直接 JSON.parse 必然失败。
    const d = new LineJsonRpcDecoder();
    expect(d.push('{"jsonrpc":"2.0","id":1,"res')).toEqual([]);
    expect(d.push('ult":{"ok":')).toEqual([]);
    expect(d.push('true}}\n')).toEqual([{ jsonrpc: '2.0', id: 1, result: { ok: true } }]);
  });

  it('handles three messages arriving in one chunk', () => {
    const d = new LineJsonRpcDecoder();
    const out = d.push('{"n":1}\n{"n":2}\n{"n":3}\n{"n":4');
    expect(out).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    // 尾部残留必须留在缓冲里，不能丢
    expect(d.push('}\n')).toEqual([{ n: 4 }]);
  });

  it('skips junk lines instead of throwing', () => {
    // 很多 MCP server 会往 stdout 打日志。整个解码器若因为一行日志崩掉，
    // 一个 server 的疏忽就能让功能静默失效 —— 所以这里是「跳过并上报」。
    const junk: string[] = [];
    const d = new LineJsonRpcDecoder((line) => junk.push(line));
    const out = d.push('Server listening on port 3000\n{"n":1}\nnot json either\n');
    expect(out).toEqual([{ n: 1 }]);
    expect(junk).toEqual(['Server listening on port 3000', 'not json either']);
  });

  it('tolerates CRLF line endings', () => {
    const d = new LineJsonRpcDecoder();
    expect(d.push('{"n":1}\r\n')).toEqual([{ n: 1 }]);
  });

  it('ignores blank lines', () => {
    const d = new LineJsonRpcDecoder();
    expect(d.push('\n\n{"n":1}\n\n')).toEqual([{ n: 1 }]);
  });

  it('flush recovers a final message with no trailing newline', () => {
    // 有些 server 最后一条响应不换行就退出；不 flush 的话这条会永远丢掉
    const d = new LineJsonRpcDecoder();
    expect(d.push('{"n":1}')).toEqual([]);
    expect(d.flush()).toEqual([{ n: 1 }]);
  });

  it('flush reports junk rather than throwing', () => {
    const junk: string[] = [];
    const d = new LineJsonRpcDecoder((l) => junk.push(l));
    d.push('half a mes');
    expect(d.flush()).toEqual([]);
    expect(junk).toEqual(['half a mes']);
  });
});

describe('JSON-RPC message discrimination', () => {
  it('recognises a response by id + result', () => {
    expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, result: {} })).toBe(true);
    expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } })).toBe(
      true,
    );
  });

  it('does not classify a request as a response even though it has an id', () => {
    // 请求也有 id。若这里判错，我们会对自己的出站请求做出「响应」处理，
    // 然后因为找不到待决项而静默丢弃真正的响应。
    expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBe(false);
  });

  it('separates requests from notifications by the presence of id', () => {
    // 规范里这就是唯一的区别。判错方向影响很大：把通知当请求会回一条错的响应，
    // 把请求当通知则会让 server 无限等待（规范要求客户端必须回应反向请求）。
    expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'roots/list' })).toBe(true);
    expect(isJsonRpcNotification({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(
      true,
    );
    expect(isJsonRpcNotification({ jsonrpc: '2.0', id: 1, method: 'roots/list' })).toBe(false);
  });

  it('rejects messages from another protocol version', () => {
    expect(isJsonRpcResponse({ jsonrpc: '1.0', id: 1, result: {} })).toBe(false);
  });
});

describe('flattenMcpContent', () => {
  it('joins text blocks', () => {
    const out = flattenMcpContent({
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    });
    expect(out).toBe('a\nb');
  });

  it('names images instead of silently dropping them', () => {
    // 我们的工具结果通道只能装字符串。静默丢弃会让模型以为「这里什么都没有」，
    // 从而得出错误结论；写一行占位说明至少让它知道自己缺了什么。
    const out = flattenMcpContent({ content: [{ type: 'image', mimeType: 'image/png' }] });
    expect(out).toContain('image/png');
    expect(out).toContain('未传入');
  });

  it('inlines embedded resource text', () => {
    const out = flattenMcpContent({
      content: [{ type: 'resource', resource: { uri: 'file:///a.ts', text: 'const a = 1' } }],
    });
    expect(out).toBe('const a = 1');
  });

  it('falls back to the uri when a resource has no text', () => {
    const out = flattenMcpContent({
      content: [{ type: 'resource', resource: { uri: 'file:///bin' } }],
    });
    expect(out).toContain('file:///bin');
  });

  it('serialises a non-conforming structured result', () => {
    // 少数 server 直接返回对象而不包 content 数组。原样序列化比报错好，
    // 模型至少还能读到内容。
    expect(flattenMcpContent({ rows: [1, 2] })).toBe('{"rows":[1,2]}');
  });

  it('marks an empty content array explicitly', () => {
    expect(flattenMcpContent({ content: [] })).toBe('(空结果)');
  });
});

describe('mcpToolName', () => {
  it('prefixes with the server id', () => {
    expect(mcpToolName('github', 'create_issue')).toBe('github__create_issue');
  });

  it('replaces characters the tool-name grammar forbids', () => {
    // OpenAI 的工具名只允许 [a-zA-Z0-9_-]。带点的 server id（如 `my.server`）
    // 若不规范化，整个请求会被网关以 400 拒掉 —— 而错误信息通常不会指向名字。
    expect(mcpToolName('my.server', 'do/it')).toBe('my_server__do_it');
  });

  it('truncates over-long names', () => {
    const long = mcpToolName('s'.repeat(40), 't'.repeat(40));
    expect(long.length).toBe(64);
  });

  it('is not injective — which is why the manager never parses names back', () => {
    // 有损变换不可逆：这两个不同的 (server, tool) 落到同一个暴露名上。
    // 因此反向映射必须靠 Manager 里的显式表，靠解析字符串必然出错。
    expect(mcpToolName('a.b', 'c')).toBe(mcpToolName('a_b', 'c'));
  });
});
