import React, { useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { useI18n } from '../i18n';
import {
  createCell,
  parseNotebook,
  serializeNotebook,
  summarizeNotebook,
  type NotebookCell,
  type NotebookCellKind,
  type ParsedNotebook,
} from '../services/notebook';

interface Props {
  path: string;
  content: string;
  readOnly?: boolean;
  onChange: (next: string) => void;
}

interface NotebookMeta {
  nbformat: number;
  nbformatMinor: number;
  metadata: Record<string, unknown>;
  extra: Record<string, unknown>;
}

/**
 * `.ipynb` 的单元式编辑器。
 *
 * 关于「运行」：这里**不执行代码**。执行笔记本需要一个内核（ipykernel / Jupyter 协议），
 * 那是另一个量级的工程；假装能跑（例如把代码塞进终端执行）会让执行计数、输出、
 * 状态都处于半真半假的状态，比明确不支持更糟。所以这一版只做
 * 「看得清、改得动、存得住」：单元增删改与上下移动，输出以只读形式保留展示。
 *
 * 编辑结果通过 `onChange` 交回上层**当作普通文本保存**：保存、脏标记、撤销、
 * Agent 写文件这些既有链路全都不用动，笔记本不会变成一条特殊的旁路。
 */
export function NotebookEditor({ path, content, readOnly, onChange }: Props) {
  const { t } = useI18n();

  const [cells, setCells] = useState<NotebookCell[]>([]);
  const [meta, setMeta] = useState<NotebookMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * 只在「外面给的文本真的变了」时重建单元列表。
   *
   * 不能每次渲染都解析：用户正在某个单元里打字时上层会因为 setState 重新传 content，
   * 无条件重建会把光标顶到单元开头。所以记住「上一次外部值」与「我们自己写出去的值」，
   * 只有这次的外部值两者都不是时，才认为来源变了。
   */
  const lastExternalRef = useRef<string | null>(null);
  const lastSerializedRef = useRef<string>('');

  useEffect(() => {
    if (lastExternalRef.current === content) return;
    lastExternalRef.current = content;
    // 自己刚写出去的内容回来了，不必重建（重建会打断正在进行的编辑）
    if (content === lastSerializedRef.current) return;

    const parsed = parseNotebook(content);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    setMeta({
      nbformat: parsed.notebook.nbformat,
      nbformatMinor: parsed.notebook.nbformatMinor,
      metadata: parsed.notebook.metadata,
      extra: parsed.notebook.extra,
    });
    setCells(parsed.notebook.cells);
  }, [content]);

  const commit = (nextCells: NotebookCell[]) => {
    if (!meta) return;
    setCells(nextCells);
    const notebook: ParsedNotebook = { ...meta, cells: nextCells };
    const text = serializeNotebook(notebook);
    lastSerializedRef.current = text;
    onChange(text);
  };

  const patchCell = (id: string, patch: Partial<NotebookCell>) => {
    commit(cells.map((cell) => (cell.id === id ? { ...cell, ...patch } : cell)));
  };

  const moveCell = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= cells.length) return;
    const next = [...cells];
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  };

  const removeCell = (id: string) => commit(cells.filter((cell) => cell.id !== id));

  const insertCell = (index: number, kind: NotebookCellKind) => {
    const next = [...cells];
    next.splice(index, 0, createCell(kind, next.length + 1));
    commit(next);
  };

  const summary = useMemo(
    () =>
      meta
        ? summarizeNotebook({ ...meta, cells })
        : { total: 0, code: 0, markdown: 0, executed: 0 },
    [meta, cells],
  );

  if (error || !meta) {
    // 解析不了就如实说明。上层据此退回纯文本编辑（见 EditorPane 的判断）。
    return (
      <div style={{ padding: 20, color: 'var(--muted)', fontSize: 'var(--ui-font-size, 12px)' }}>
        {t('notebook.parseFailed', { reason: error ?? '' })}
      </div>
    );
  }

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-editor, #1e1e1e)',
        color: 'var(--text)',
      }}
    >
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '6px 14px',
          borderBottom: '1px solid var(--border)',
          fontSize: 'var(--ui-font-size, 12px)',
        }}
      >
        <span style={{ fontWeight: 600 }} title={path}>
          {t('notebook.title')}
          <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 8 }}>
            {t('notebook.summary', {
              total: summary.total,
              code: summary.code,
              markdown: summary.markdown,
            })}
          </span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: 'var(--muted)' }}>{t('notebook.noKernel')}</span>
          <button
            type="button"
            className="panel-action-btn"
            disabled={readOnly}
            onClick={() => insertCell(cells.length, 'code')}
          >
            {t('notebook.addCode')}
          </button>
          <button
            type="button"
            className="panel-action-btn"
            disabled={readOnly}
            onClick={() => insertCell(cells.length, 'markdown')}
          >
            {t('notebook.addMarkdown')}
          </button>
        </span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '10px 14px 40px' }}>
        {cells.length === 0 && (
          <div style={{ color: 'var(--muted)', padding: '18px 0' }}>{t('notebook.empty')}</div>
        )}
        {cells.map((cell, index) => (
          <NotebookCellView
            key={cell.id}
            cell={cell}
            index={index}
            total={cells.length}
            readOnly={readOnly}
            onPatch={(patch) => patchCell(cell.id, patch)}
            onMove={(delta) => moveCell(index, delta)}
            onRemove={() => removeCell(cell.id)}
            onInsertBelow={(kind) => insertCell(index + 1, kind)}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

interface CellProps {
  cell: NotebookCell;
  index: number;
  total: number;
  readOnly?: boolean;
  onPatch: (patch: Partial<NotebookCell>) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onInsertBelow: (kind: NotebookCellKind) => void;
  t: ReturnType<typeof useI18n>['t'];
}

function NotebookCellView({
  cell,
  index,
  total,
  readOnly,
  onPatch,
  onMove,
  onRemove,
  onInsertBelow,
  t,
}: CellProps) {
  // 输出是「打开时的既有结果」，原样只读展示：编辑源码不会让它消失 ——
  // 我们并没有重算它的能力，删掉才是真的数据丢失。
  const outputs = Array.isArray(cell.extra.outputs) ? cell.extra.outputs : [];
  const executionCount = cell.extra.execution_count;

  const label =
    cell.kind === 'markdown'
      ? t('notebook.kindMarkdown')
      : cell.kind === 'raw'
        ? t('notebook.kindRaw')
        : typeof executionCount === 'number'
          ? `[${executionCount}]`
          : '[ ]';

  return (
    <div
      style={{
        marginTop: 10,
        border: '1px solid var(--border)',
        borderRadius: 8,
        overflow: 'hidden',
        background: 'var(--bg-elevated, #1e1e1e)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '4px 10px',
          fontSize: 11,
          color: 'var(--muted)',
          borderBottom: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.05))',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{label}</span>
          <button
            type="button"
            className="panel-action-btn panel-action-btn--compact"
            disabled={readOnly}
            title={t('notebook.toggleKind')}
            onClick={() => onPatch({ kind: cell.kind === 'markdown' ? 'code' : 'markdown' })}
          >
            {cell.kind === 'markdown'
              ? t('notebook.kindMarkdownShort')
              : t('notebook.kindCodeShort')}
          </button>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            className="panel-action-btn panel-action-btn--compact"
            disabled={readOnly || index === 0}
            title={t('notebook.moveUp')}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="panel-action-btn panel-action-btn--compact"
            disabled={readOnly || index === total - 1}
            title={t('notebook.moveDown')}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="panel-action-btn panel-action-btn--compact"
            disabled={readOnly}
            title={t('notebook.insertBelow')}
            onClick={() => onInsertBelow('code')}
          >
            +
          </button>
          <button
            type="button"
            className="panel-action-btn panel-action-btn--compact"
            disabled={readOnly}
            title={t('notebook.deleteCell')}
            onClick={onRemove}
          >
            ✕
          </button>
        </span>
      </div>

      <div style={{ height: cell.kind === 'markdown' ? 140 : 180 }}>
        <Editor
          value={cell.source}
          language={cell.kind === 'markdown' ? 'markdown' : 'python'}
          theme="vs-dark"
          onChange={(value) => onPatch({ source: value ?? '' })}
          options={{
            readOnly: Boolean(readOnly),
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            lineNumbers: 'off',
            glyphMargin: false,
            folding: false,
            renderLineHighlight: 'none',
            wordWrap: 'on',
            fontSize: 13,
            automaticLayout: true,
            tabSize: 4,
            scrollbar: { vertical: 'auto', horizontal: 'auto' },
          }}
        />
      </div>

      {outputs.length > 0 && (
        <div
          style={{
            borderTop: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.05))',
            padding: '6px 10px',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--muted)',
            maxHeight: 220,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
          }}
        >
          {outputs.map((output, i) => (
            <div key={i}>{formatOutput(output)}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 把一条输出压成一行可读文本。
 *
 * 图片之类的二进制输出只给一句占位说明：把 base64 铺在界面上既没用，又会明显卡住渲染。
 */
export function formatOutput(output: unknown): string {
  if (typeof output !== 'object' || output === null) return String(output);
  const record = output as Record<string, unknown>;
  const text = record.text;
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.join('');

  const data = record.data;
  if (typeof data === 'object' && data !== null) {
    const entries = Object.entries(data as Record<string, unknown>);
    const plain = entries.find(([mime]) => mime === 'text/plain');
    if (plain) return Array.isArray(plain[1]) ? plain[1].join('') : String(plain[1]);
    const mime = entries[0]?.[0] ?? 'unknown';
    return `[${mime} 输出]`;
  }

  const ename = record.ename;
  const evalue = record.evalue;
  if (typeof ename === 'string' || typeof evalue === 'string') {
    return `${ename ?? ''}: ${evalue ?? ''}`;
  }
  return `[${String(record.output_type ?? '输出')}]`;
}
