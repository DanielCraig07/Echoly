import { describe, it, expect } from 'vitest';
import {
  createCell,
  isNotebookPath,
  joinSource,
  parseNotebook,
  serializeNotebook,
  splitSource,
  summarizeNotebook,
} from '../src/renderer/src/services/notebook';

/**
 * `.ipynb` 往返。
 *
 * 这一层唯一的目标是**不丢数据**：改一个单元、保存，不该顺手丢掉别的单元的
 * 输出、执行计数与扩展字段。这类错误不会有任何报错，只表现为「打开保存一下，图没了」。
 */

/** 一个「该有的都有」的笔记本：两种 source 写法、输出、执行计数、扩展字段、单元 id。 */
const SAMPLE = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { name: 'python3', display_name: 'Python 3' },
    language_info: { name: 'python' },
  },
  cells: [
    {
      id: 'intro',
      cell_type: 'markdown',
      metadata: { collapsed: true },
      source: ['# 标题\n', '\n', '说明文字'],
    },
    {
      id: 'code-1',
      cell_type: 'code',
      execution_count: 7,
      metadata: {},
      outputs: [
        { output_type: 'stream', name: 'stdout', text: ['hello\n'] },
        { output_type: 'display_data', data: { 'image/png': 'BASE64===' } },
      ],
      source: 'print("hello")\n',
    },
  ],
  // 笔记本级别的扩展字段（比如某些工具写进来的自定义键）
  my_extension: { keep: 'me' },
};

const parseOk = (text: string) => {
  const result = parseNotebook(text);
  if (!result.ok) throw new Error(`期望解析成功，实际失败：${result.error}`);
  return result.notebook;
};

describe('isNotebookPath', () => {
  it('按扩展名判断，大小写不敏感', () => {
    expect(isNotebookPath('a/b.ipynb')).toBe(true);
    expect(isNotebookPath('A.IPYNB')).toBe(true);
    expect(isNotebookPath('a.ipynb.bak')).toBe(false);
    expect(isNotebookPath('a.py')).toBe(false);
    expect(isNotebookPath(null)).toBe(false);
  });
});

describe('source 的两种写法', () => {
  it('数组与字符串都能读成同一个文本', () => {
    expect(joinSource(['a\n', 'b'])).toBe('a\nb');
    expect(joinSource('a\nb')).toBe('a\nb');
  });

  it('拆回数组时每行保留结尾换行（与 Jupyter 的写法一致）', () => {
    expect(splitSource('a\nb')).toEqual(['a\n', 'b']);
    expect(splitSource('a\n')).toEqual(['a\n']);
    expect(splitSource('')).toEqual([]);
  });

  it('数组 ↔ 字符串往返不变', () => {
    for (const text of ['', 'a', 'a\n', 'a\nb', '\n', 'a\n\nb']) {
      expect(joinSource(splitSource(text))).toBe(text);
    }
  });

  it('数组里混进非字符串不会崩', () => {
    expect(joinSource(['a', 1, null, 'b'])).toBe('ab');
  });
});

describe('parseNotebook', () => {
  it('读出单元类型与源码', () => {
    const nb = parseOk(JSON.stringify(SAMPLE));
    expect(nb.cells.map((c) => c.kind)).toEqual(['markdown', 'code']);
    expect(nb.cells[0].source).toBe('# 标题\n\n说明文字');
    expect(nb.cells[1].source).toBe('print("hello")\n');
  });

  it('非法 JSON 与结构不对时返回原因，而不是尽力而为', () => {
    // 调用方据此退回纯文本编辑 —— 格式非法的笔记本仍要能打开、能修
    expect(parseNotebook('{ 不是 json')).toMatchObject({ ok: false });
    expect(parseNotebook('[]')).toMatchObject({ ok: false });
    expect(parseNotebook('{"a":1}')).toMatchObject({ ok: false });
    const result = parseNotebook('{"a":1}');
    if (!result.ok) expect(result.error).toContain('cells');
  });

  it('认不出的单元类型被跳过，不影响其余单元', () => {
    const nb = parseOk(
      JSON.stringify({
        cells: [
          { cell_type: 'future_type', source: 'x' },
          { cell_type: 'code', source: 'y' },
        ],
      }),
    );
    expect(nb.cells).toHaveLength(1);
    expect(nb.cells[0].kind).toBe('code');
  });

  it('缺 nbformat 时给出默认值', () => {
    const nb = parseOk(JSON.stringify({ cells: [] }));
    expect(nb.nbformat).toBe(4);
    expect(nb.nbformatMinor).toBe(5);
  });
});

describe('序列化往返保真', () => {
  it('其余单元的输出、执行计数、单元 id、扩展字段全部保留', () => {
    const nb = parseOk(JSON.stringify(SAMPLE));
    const again = parseOk(serializeNotebook(nb));
    expect(again).toEqual(nb);

    const written = JSON.parse(serializeNotebook(nb));
    // 独立确认关键字段确实落进了产物，而不是被我们「重建」掉了
    expect(written.cells[0].id).toBe('intro');
    expect(written.cells[0].metadata).toEqual({ collapsed: true });
    expect(written.cells[1].execution_count).toBe(7);
    expect(written.cells[1].outputs).toHaveLength(2);
    expect(written.cells[1].outputs[1].data['image/png']).toBe('BASE64===');
    expect(written.metadata.kernelspec.name).toBe('python3');
    expect(written.my_extension).toEqual({ keep: 'me' });
  });

  it('改源码不影响同单元的输出与元数据', () => {
    const nb = parseOk(JSON.stringify(SAMPLE));
    nb.cells[1] = { ...nb.cells[1], source: 'print("changed")\n' };
    const written = JSON.parse(serializeNotebook(nb));
    expect(written.cells[1].source).toEqual(['print("changed")\n']);
    expect(written.cells[1].outputs).toHaveLength(2);
    expect(written.cells[1].execution_count).toBe(7);
  });

  it('新建的代码单元补上 nbformat 要求的 outputs / execution_count', () => {
    const nb = parseOk(JSON.stringify({ cells: [] }));
    nb.cells.push(createCell('code', 1));
    const written = JSON.parse(serializeNotebook(nb));
    expect(written.cells[0]).toMatchObject({
      cell_type: 'code',
      outputs: [],
      execution_count: null,
      source: [],
    });
  });

  it('markdown 单元不会被塞上 outputs（那是代码单元专有字段）', () => {
    const nb = parseOk(JSON.stringify({ cells: [] }));
    nb.cells.push(createCell('markdown', 1));
    const written = JSON.parse(serializeNotebook(nb));
    expect(written.cells[0].outputs).toBeUndefined();
    expect(written.cells[0].execution_count).toBeUndefined();
  });

  it('产物末尾带换行（文本文件的惯例）', () => {
    const nb = parseOk(JSON.stringify({ cells: [] }));
    expect(serializeNotebook(nb).endsWith('\n')).toBe(true);
  });
});

describe('summarizeNotebook', () => {
  it('统计代码/文档单元数与已执行的代码单元数', () => {
    const nb = parseOk(JSON.stringify(SAMPLE));
    expect(summarizeNotebook(nb)).toEqual({ total: 2, code: 1, markdown: 1, executed: 1 });
  });

  it('execution_count 为 null 时不算已执行', () => {
    const nb = parseOk(
      JSON.stringify({ cells: [{ cell_type: 'code', source: '', execution_count: null }] }),
    );
    expect(summarizeNotebook(nb).executed).toBe(0);
  });
});
