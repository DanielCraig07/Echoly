import { describe, expect, it } from 'vitest';
import { parseXmlToolCalls } from '../src/index';

/**
 * 无原生 tool_calls 时的兜底解析。
 *
 * 判定方向必须偏松：漏掉一个工具调用 = Agent 什么都没做就结束（一次空回合），
 * 多解析一个畸形条目 = 一次看得懂的参数错误，模型下一轮能自己改。
 * 唯一的例外是「没有 tool 标记的围栏」—— 那种情况下宽松会去**真的执行**一个
 * 从普通回答里抠出来的「工具调用」，代价远大于漏判。
 */
describe('parseXmlToolCalls', () => {
  it('解析标准的 json tool 代码块', () => {
    const calls = parseXmlToolCalls(
      '```json tool\n{"name":"read_file","arguments":{"path":"a.ts"}}\n```',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
    expect(calls[0].args).toBe('{"path":"a.ts"}');
  });

  it('容忍围栏标记的写法差异', () => {
    const variants = [
      '```jsontool\n{"name":"a","arguments":{}}\n```',
      '```json  tool\n{"name":"a","arguments":{}}\n```',
      '```TOOL\n{"name":"a","arguments":{}}\n```',
      '``` tool\n{"name":"a","arguments":{}}\n```',
    ];
    for (const text of variants) {
      expect(parseXmlToolCalls(text), text.split('\n')[0]).toHaveLength(1);
    }
  });

  it('接受只有 json 标记、但同时带 name 与 arguments 的块', () => {
    // 模型最自然的写法就是 ```json —— 一个带 arguments 的对象显然是工具调用。
    const calls = parseXmlToolCalls(
      '```json\n{"name":"glob_files","arguments":{"pattern":"*.ts"}}\n```',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('glob_files');
  });

  it('不把贴出来的普通 JSON（如 package.json）当成工具调用', () => {
    // 这是最危险的一类误判：它会真的去执行。
    const calls = parseXmlToolCalls('```json\n{"name":"my-app","version":"1.0.0"}\n```');
    expect(calls).toHaveLength(0);
  });

  it('接受 args 作为 arguments 的别名', () => {
    const calls = parseXmlToolCalls('```json tool\n{"name":"a","args":{"x":1}}\n```');
    expect(calls[0].args).toBe('{"x":1}');
  });

  it('arguments 已经是字符串时原样透传', () => {
    const calls = parseXmlToolCalls('```json tool\n{"name":"a","arguments":"{\\"x\\":1}"}\n```');
    expect(calls[0].args).toBe('{"x":1}');
  });

  it('没有 name 的块被跳过，而不是造出 name: undefined', () => {
    const calls = parseXmlToolCalls('```json tool\n{"arguments":{"x":1}}\n```');
    expect(calls).toHaveLength(0);
  });

  it('name 为空的块被跳过', () => {
    expect(parseXmlToolCalls('```json tool\n{"name":"   ","arguments":{}}\n```')).toHaveLength(0);
  });

  it('前后带说明文字时也能取出 JSON', () => {
    const calls = parseXmlToolCalls(
      '```json tool\n好的，我来读取这个文件：{"name":"read_file","arguments":{"path":"a.ts"}}\n```',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
  });

  it('修掉尾随逗号', () => {
    const calls = parseXmlToolCalls('```json tool\n{"name":"a","arguments":{"x":1,},}\n```');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toBe('{"x":1}');
  });

  it('修掉中文引号', () => {
    const calls = parseXmlToolCalls('```json tool\n{“name”:“a”,“arguments”:{}}\n```');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('a');
  });

  it('一个回复里的多个工具调用全部取出', () => {
    const calls = parseXmlToolCalls(
      '先看目录\n```json tool\n{"name":"list_dir","arguments":{}}\n```\n再看文件\n```json tool\n{"name":"read_file","arguments":{"path":"a.ts"}}\n```',
    );
    expect(calls.map((c) => c.name)).toEqual(['list_dir', 'read_file']);
  });

  it('坏 JSON 被跳过而不是抛出', () => {
    expect(parseXmlToolCalls('```json tool\n{不是 JSON\n```')).toHaveLength(0);
    expect(parseXmlToolCalls('```json tool\n[1,2,3]\n```')).toHaveLength(0);
  });

  it('每个调用拿到独立的 id', () => {
    const calls = parseXmlToolCalls(
      '```json tool\n{"name":"a","arguments":{}}\n```\n```json tool\n{"name":"b","arguments":{}}\n```',
    );
    expect(calls[0].id).not.toBe(calls[1].id);
  });
});
