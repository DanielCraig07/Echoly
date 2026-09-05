import type { PendingDiff } from '@deepseek-ide/shared';

interface Props {
  diffs: PendingDiff[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onAcceptAll: () => void;
}

function computeLineDiffStats(original?: string, modified?: string): { added: number; deleted: number } {
  const origText = original ?? '';
  const modText = modified ?? '';
  if (!origText) {
    const lines = modText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return { added: lines.length || 1, deleted: 0 };
  }
  if (!modText) {
    const lines = origText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return { added: 0, deleted: lines.length || 1 };
  }

  const origLines = origText.split(/\r?\n/);
  const modLines = modText.split(/\r?\n/);

  let added = 0;
  let deleted = 0;
  let oi = 0;
  let mi = 0;

  while (oi < origLines.length || mi < modLines.length) {
    if (oi < origLines.length && mi < modLines.length && origLines[oi] === modLines[mi]) {
      oi++;
      mi++;
    } else {
      const findOrig = origLines.indexOf(modLines[mi], oi);
      const findMod = modLines.indexOf(origLines[oi], mi);

      if (findOrig !== -1 && (findMod === -1 || findOrig - oi <= findMod - mi)) {
        deleted += findOrig - oi;
        oi = findOrig;
      } else if (findMod !== -1) {
        added += findMod - mi;
        mi = findMod;
      } else {
        if (oi < origLines.length) {
          deleted++;
          oi++;
        }
        if (mi < modLines.length) {
          added++;
          mi++;
        }
      }
    }
  }

  return { added, deleted };
}

export function DiffPanel({ diffs, activeId, onSelect, onAccept, onReject, onAcceptAll }: Props) {
  return (
    <div className="bottom-section" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="panel-title" style={{ fontSize: 12, padding: '6px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border)' }}>
        <span>待确认修改 ({diffs.length})</span>
        {diffs.length > 0 && (
          <button className="btn btn-primary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={onAcceptAll}>
            全部接收
          </button>
        )}
      </div>
      <div className="diff-list" style={{ padding: 8, gap: 6 }}>
        {diffs.length === 0 && <div className="empty-state" style={{ padding: 12, fontSize: 12 }}>暂无待确认改动</div>}
        {diffs.map((d) => {
          const { added, deleted } = computeLineDiffStats(d.original, d.modified);
          return (
            <div
              key={d.id}
              className={`diff-item ${activeId === d.id ? 'active' : ''}`}
              style={{ outline: activeId === d.id ? '1px solid var(--accent)' : undefined, padding: '6px 10px', borderRadius: 4 }}
            >
              <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                <span className="diff-path" onClick={() => onSelect(d.id)} style={{ cursor: 'pointer', fontSize: 12, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 6 }} title={d.path}>
                  <span>📄 {d.path.split('/').pop() || d.path}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, display: 'inline-flex', gap: 4 }}>
                    <span style={{ color: '#388e3c', fontWeight: 600 }}>+{added}</span>
                    <span style={{ color: '#f87171', fontWeight: 600 }}>-{deleted}</span>
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 'normal' }}>({d.path})</span>
                </span>
                <div className="diff-actions" style={{ display: 'flex', gap: 4 }}>
                  <button className="primary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => onAccept(d.id)}>
                    接收
                  </button>
                  <button className="danger" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => onReject(d.id)}>
                    拒绝
                  </button>
                </div>
              </header>
              <div style={{ color: 'var(--muted)', fontSize: 11 }}>{d.description ?? '修改文件'}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
