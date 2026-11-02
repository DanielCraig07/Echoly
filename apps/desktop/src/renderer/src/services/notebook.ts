/**
 * `.ipynb` 的解析与序列化。
 *
 * 这一层唯一的目标是**往返保真**：用户在一个笔记本里改一个代码单元、保存，
 * 不应该顺手丢掉其余单元的输出、执行计数、单元 id、以及 nbformat 的各种扩展字段。
 * 「打开保存一下，图都没了」是这类编辑器最不能犯的错，而且它不会有任何报错。
 *
 * 所以做法是：**只认自己需要的字段，其余一律原样留在一个 extra 袋子里带回去**，
 * 而不是「按已知字段重建」。前者对未知字段天然宽容，后者每遇到一个新字段就丢一次数据。
 *
 * 解析失败时明确返回错误而不是尽力而为：调用方据此退回纯文本编辑 ——
 * 一个格式非法的 .ipynb 仍然要能打开、能修，不能因为「看不懂」就被锁住。
 */

export type NotebookCellKind = 'code' | 'markdown' | 'raw';

export interface NotebookCell {
  /** 界面内用的稳定标识。不写回文件（文件里的 `id` 在 `extra` 里原样保留）。 */
  id: string;
  kind: NotebookCellKind;
  source: string;
  /** 其余字段原样保留：outputs / execution_count / metadata / id / 未知扩展字段 */
  extra: Record<string, unknown>;
}

export interface ParsedNotebook {
  nbformat: number;
  nbformatMinor: number;
  metadata: Record<string, unknown>;
  cells: NotebookCell[];
  /** 笔记本级别的其余字段，同样原样带回 */
  extra: Record<string, unknown>;
}

export type NotebookParseResult =
  { ok: true; notebook: ParsedNotebook } | { ok: false; error: string };

export function isNotebookPath(path: string | null | undefined): boolean {
  return typeof path === 'string' && /\.ipynb$/i.test(path);
}

/**
 * 把 `source` 统一成字符串。
 *
 * nbformat 允许它既是字符串也是「一行一个元素」的数组，两种写法在实际文件里都常见。
 */
export function joinSource(source: unknown): string {
  if (typeof source === 'string') return source;
  if (Array.isArray(source))
    return source.map((line) => (typeof line === 'string' ? line : '')).join('');
  return '';
}

/**
 * 拆回数组形式。
 *
 * Jupyter 自己写出来的是数组（每行带结尾换行），跟着它的写法走可以让
 * 「另一个工具打开这个文件」产生的 diff 只有真正改动的那几行。
 */
export function splitSource(text: string): string[] {
  if (!text) return [];
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeKind(value: unknown): NotebookCellKind | null {
  if (value === 'code' || value === 'markdown' || value === 'raw') return value;
  return null;
}

export function parseNotebook(text: string): NotebookParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '不是合法的 JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '顶层不是一个对象' };
  }

  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.cells)) {
    return { ok: false, error: '缺少 cells 数组（可能不是 Jupyter 笔记本）' };
  }

  const cells: NotebookCell[] = [];
  for (const [index, item] of record.cells.entries()) {
    const cellRecord = asRecord(item);
    const kind = normalizeKind(cellRecord.cell_type);
    // 认不出的单元类型跳过而不是整篇打不开：将来 nbformat 加新类型时，
    // 至少其余单元还能编辑，且这些单元因为不在 cells 里不会被写回去。
    if (!kind) continue;

    const { cell_type: _kind, source: _source, ...extra } = cellRecord;
    cells.push({
      id: `cell-${index}`,
      kind,
      source: joinSource(cellRecord.source),
      extra,
    });
  }

  const { cells: _cells, nbformat, nbformat_minor: nbformatMinor, metadata, ...extra } = record;

  return {
    ok: true,
    notebook: {
      nbformat: typeof nbformat === 'number' ? nbformat : 4,
      nbformatMinor: typeof nbformatMinor === 'number' ? nbformatMinor : 5,
      metadata: asRecord(metadata),
      cells,
      extra,
    },
  };
}

export function serializeNotebook(notebook: ParsedNotebook): string {
  const cells = notebook.cells.map((cell) => {
    const out: Record<string, unknown> = {
      cell_type: cell.kind,
      // extra 在前：它带着原始文件里的字段，不该被我们后写的值覆盖的只有未知字段，
      // 而 cell_type / source 是我们唯一真正拥有所有权的两个字段。
      ...cell.extra,
      source: splitSource(cell.source),
    };
    if (cell.kind === 'code') {
      // nbformat 要求代码单元必须带这两个字段；新建的单元没有，补上默认值。
      if (!Array.isArray(out.outputs)) out.outputs = [];
      if (!('execution_count' in out)) out.execution_count = null;
    }
    return out;
  });

  const payload = {
    ...notebook.extra,
    cells,
    metadata: notebook.metadata,
    nbformat: notebook.nbformat,
    nbformat_minor: notebook.nbformatMinor,
  };

  // Jupyter 自己写的是缩进两格的 JSON，跟着它能让 diff 保持小
  return `${JSON.stringify(payload, null, 1)}\n`;
}

/** 新建一个空代码单元。 */
export function createCell(kind: NotebookCellKind = 'code', index = 0): NotebookCell {
  return { id: `cell-new-${Date.now()}-${index}`, kind, source: '', extra: {} };
}

/** 统计信息，用于工具栏上的概览。 */
export function summarizeNotebook(notebook: ParsedNotebook): {
  total: number;
  code: number;
  markdown: number;
  executed: number;
} {
  let code = 0;
  let markdown = 0;
  let executed = 0;
  for (const cell of notebook.cells) {
    if (cell.kind === 'code') {
      code += 1;
      const count = cell.extra.execution_count;
      if (typeof count === 'number') executed += 1;
    } else if (cell.kind === 'markdown') {
      markdown += 1;
    }
  }
  return { total: notebook.cells.length, code, markdown, executed };
}
