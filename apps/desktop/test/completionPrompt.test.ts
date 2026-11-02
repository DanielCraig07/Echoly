import { describe, it, expect } from 'vitest';
import {
  buildCompletionPrompt,
  extractFirstJsonObject,
  formatRecentEdits,
  parseCompletionResponse,
  stripCodeFences,
} from '../src/main/completionPrompt';

/**
 * 补全 prompt 与响应解析。
 *
 * 结构化输出最大的风险是**把解析变成新的失败点**：模型偶尔不守规矩，
 * 若解析器只认一种形态，那些响应就会从「能用的补全」变成「没有补全」。
 * 所以这里的重点全在降级路径上。
 */

describe('buildCompletionPrompt', () => {
  it('明确要求只回 JSON 里的插入区间', () => {
    const prompt = buildCompletionPrompt({ prefix: 'const a = ', suffix: ';\n' });
    expect(prompt).toContain('{"insertText"');
    // 「不要重复前后缀」这条是结构化输出真正的目的：防模型把光标前后抄一遍
    expect(prompt).toContain('不要重复前缀');
    expect(prompt).toContain('不要重复后缀');
    expect(prompt).toContain('const a = ');
    expect(prompt).toContain(';\n');
  });

  it('带语言时把它写进提示，不带时不留下空行', () => {
    expect(buildCompletionPrompt({ prefix: 'a', suffix: 'b', language: 'python' })).toContain(
      '当前语言：python',
    );
    expect(buildCompletionPrompt({ prefix: 'a', suffix: 'b' })).not.toContain('当前语言');
  });

  it('带上最近编辑时写进提示词，没有时不出现该段落', () => {
    const withEdits = buildCompletionPrompt({
      prefix: 'a',
      suffix: 'b',
      recentEdits: [{ inserted: 'accountId', deleted: 'userId' }],
    });
    expect(withEdits).toContain('用户最近的编辑');
    expect(withEdits).toContain('userId');

    const without = buildCompletionPrompt({ prefix: 'a', suffix: 'b' });
    expect(without).not.toContain('用户最近的编辑');
  });

  it('明确鼓励多行补全，但要求「不确定时给最短的」', () => {
    const prompt = buildCompletionPrompt({ prefix: 'a', suffix: 'b' });
    expect(prompt).toContain('可以给出多行补全');
    // 只写「鼓励多行」会把模型推向长篇大论，必须同时给出回退口径
    expect(prompt).toContain('最短的合理补全');
    expect(prompt).toContain('缩进');
  });

  it('超长前后缀按上限截断（保留靠近光标的部分）', () => {
    const prefix = 'x'.repeat(5000) + 'NEAR_CURSOR';
    const suffix = 'SUFFIX_HEAD' + 'y'.repeat(5000);
    const prompt = buildCompletionPrompt({ prefix, suffix });
    expect(prompt).toContain('NEAR_CURSOR'); // 光标前的内容必须保留
    expect(prompt).toContain('SUFFIX_HEAD'); // 光标后的开头必须保留
    expect(prompt).not.toContain('x'.repeat(3000)); // 远端前缀被截掉
  });
});

describe('formatRecentEdits', () => {
  it('没有编辑时返回空串，不在提示词里留一个空标题', () => {
    expect(formatRecentEdits(undefined)).toBe('');
    expect(formatRecentEdits([])).toBe('');
  });

  it('用「删除/插入」的 diff 形式表达，而不是整段代码', () => {
    const text = formatRecentEdits([{ inserted: 'accountId', deleted: 'userId' }]);
    expect(text).toContain('删除「userId」');
    expect(text).toContain('插入「accountId」');
    expect(text).toContain('从旧到新');
  });

  it('纯插入不出现空的删除项', () => {
    expect(formatRecentEdits([{ inserted: 'foo', deleted: '' }])).toBe(
      '\n用户最近的编辑（从旧到新，用来判断当前意图）：\n1. 插入「foo」\n',
    );
  });

  it('空白与换行被压成单行，超长截断', () => {
    const text = formatRecentEdits([{ inserted: 'if (a) {\n  return 1;\n}', deleted: '' }]);
    expect(text).toContain('if (a) { return 1; }');
    expect(text).not.toContain('\n  return');

    const long = formatRecentEdits([{ inserted: 'q'.repeat(500), deleted: '' }]);
    expect(long).toContain('…');
    expect(long.length).toBeLessThan(400);
  });
});

describe('stripCodeFences', () => {
  it('剥掉带语言的围栏', () => {
    expect(stripCodeFences('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
  });

  it('剥掉不带语言的围栏', () => {
    expect(stripCodeFences('```\nfoo()\n```')).toBe('foo()');
  });

  it('没有围栏时原样返回（只裁空白）', () => {
    expect(stripCodeFences('  return 1;  ')).toBe('return 1;');
  });
});

describe('extractFirstJsonObject', () => {
  it('从夹杂的解释文字里抠出对象', () => {
    expect(extractFirstJsonObject('好的，结果如下：{"insertText":"x"} 以上')).toBe(
      '{"insertText":"x"}',
    );
  });

  it('字符串里的花括号不参与配对', () => {
    expect(extractFirstJsonObject('{"insertText":"if (a) { b(); }"}')).toBe(
      '{"insertText":"if (a) { b(); }"}',
    );
  });

  it('转义的引号不会提前结束字符串', () => {
    const text = '{"insertText":"say \\"hi\\" {ok}"}';
    expect(extractFirstJsonObject(text)).toBe(text);
  });

  it('没有完整对象时返回 null', () => {
    expect(extractFirstJsonObject('没有花括号')).toBeNull();
    expect(extractFirstJsonObject('{"a": 1')).toBeNull();
  });
});

describe('parseCompletionResponse', () => {
  it('正常 JSON 走 json 一路', () => {
    const parsed = parseCompletionResponse('{"insertText":"return token;"}');
    expect(parsed).toEqual({ insertText: 'return token;', source: 'json' });
  });

  it('JSON 里的换行转义被还原', () => {
    const parsed = parseCompletionResponse('{"insertText":"if (x) {\\n  return 1;\\n}"}');
    expect(parsed?.insertText).toBe('if (x) {\n  return 1;\n}');
  });

  it('围栏包着的 JSON 也能解析', () => {
    const parsed = parseCompletionResponse('```json\n{"insertText":"foo()"}\n```');
    expect(parsed).toEqual({ insertText: 'foo()', source: 'json' });
  });

  it('JSON 外面裹着解释文字时走 embedded 一路', () => {
    const parsed = parseCompletionResponse('好的，补全如下 {"insertText":"bar()"} ');
    expect(parsed).toEqual({ insertText: 'bar()', source: 'embedded' });
  });

  it('模型完全无视 JSON 时回退成裸文本（与改造前一致）', () => {
    const parsed = parseCompletionResponse('```ts\nbaz();\n```');
    expect(parsed).toEqual({ insertText: 'baz();', source: 'raw' });
  });

  it('明确的「无需补全」是一个结论，不是解析失败', () => {
    expect(parseCompletionResponse('{"insertText":""}')).toEqual({
      insertText: '',
      source: 'json',
    });
  });

  it('兼容旧字段名 completion', () => {
    expect(parseCompletionResponse('{"completion":"old()"}')).toEqual({
      insertText: 'old()',
      source: 'json',
    });
  });

  it('字段类型不对时继续降级，而不是当成文本插入', () => {
    // {"insertText": 42} 解析成功但取不到字符串 —— 此时整个响应退化成 raw，
    // 而 raw 会把它当代码插进去。所以这里断言的是「不会给出 42」。
    const parsed = parseCompletionResponse('{"insertText":42}');
    expect(parsed?.insertText).not.toBe('42');
  });

  it('空响应与纯空白返回 null', () => {
    expect(parseCompletionResponse('')).toBeNull();
    expect(parseCompletionResponse('   \n  ')).toBeNull();
    expect(parseCompletionResponse(null as unknown as string)).toBeNull();
  });

  it('不因为畸形输入抛错', () => {
    for (const bad of ['{', '}{', '{"insertText":', '```json\n```']) {
      expect(() => parseCompletionResponse(bad)).not.toThrow();
    }
  });
});
