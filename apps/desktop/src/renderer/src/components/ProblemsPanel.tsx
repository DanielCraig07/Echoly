import React, { useState, useEffect, useMemo, useCallback } from 'react';
import * as monaco from 'monaco-editor';
import { useI18n } from '../i18n';

interface Props {
  workspace?: string | null;
  onOpenFile?: (path: string, line?: number, column?: number) => void;
  onCountChange?: (count: number) => void;
}

interface ProblemItem {
  id: string;
  filePath: string;
  fileName: string;
  message: string;
  severity: monaco.MarkerSeverity;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  source?: string;
}

export const ProblemsPanel: React.FC<Props> = ({
  workspace,
  onOpenFile,
  onCountChange,
}) => {
  const { t } = useI18n();
  const [filterText, setFilterText] = useState('');
  const [severityFilter, setSeverityFilter] = useState<'all' | 'error' | 'warning'>('all');
  const [markers, setMarkers] = useState<ProblemItem[]>([]);

  const refreshMarkers = useCallback(() => {
    try {
      const allMarkers = monaco.editor.getModelMarkers({});
      const items: ProblemItem[] = allMarkers
        .filter((m) => m.severity === monaco.MarkerSeverity.Error || m.severity === monaco.MarkerSeverity.Warning)
        .map((m, idx) => {
          const rawPath = m.resource.path || m.resource.fsPath || '';
          const cleanedPath = rawPath.startsWith('/') && rawPath.length > 2 && rawPath[2] === ':' 
            ? rawPath.slice(1) // Windows path fix /C:/... -> C:/...
            : rawPath;
          const fileName = cleanedPath.split('/').pop()?.split('\\').pop() || cleanedPath;

          return {
            id: `${cleanedPath}-${m.startLineNumber}-${m.startColumn}-${idx}`,
            filePath: cleanedPath,
            fileName,
            message: m.message,
            severity: m.severity,
            startLine: m.startLineNumber,
            startColumn: m.startColumn,
            endLine: m.endLineNumber,
            endColumn: m.endColumn,
            source: m.source,
          };
        });

      setMarkers(items);
      onCountChange?.(items.length);
    } catch {
      // ignore
    }
  }, [onCountChange]);

  useEffect(() => {
    refreshMarkers();
    const disposable = monaco.editor.onDidChangeMarkers(() => {
      refreshMarkers();
    });
    return () => {
      disposable.dispose();
    };
  }, [refreshMarkers]);

  const filteredMarkers = useMemo(() => {
    return markers.filter((m) => {
      if (severityFilter === 'error' && m.severity !== monaco.MarkerSeverity.Error) return false;
      if (severityFilter === 'warning' && m.severity !== monaco.MarkerSeverity.Warning) return false;
      if (filterText.trim()) {
        const text = filterText.toLowerCase();
        return (
          m.message.toLowerCase().includes(text) ||
          m.fileName.toLowerCase().includes(text) ||
          m.filePath.toLowerCase().includes(text) ||
          (m.source && m.source.toLowerCase().includes(text))
        );
      }
      return true;
    });
  }, [markers, severityFilter, filterText]);

  // 按文件分组
  const groupedByFile = useMemo(() => {
    const map = new Map<string, ProblemItem[]>();
    for (const item of filteredMarkers) {
      const list = map.get(item.filePath) || [];
      list.push(item);
      map.set(item.filePath, list);
    }
    return Array.from(map.entries());
  }, [filteredMarkers]);

  /**
   * 下面两处拼的是**送给模型的 prompt**（经 `echoly:askAi` 自动提交），
   * 不是界面文案 —— 与 `services/specialMentions.ts` 里那批同类，故不进字典。
   * 把「错误 (Error)」翻成 "Error (Error)" 只会改变模型的输入分布，不会让用户更看得懂。
   * 面板上真正显示给用户的那份文案（筛选项、空态、分组标题）才是翻的。
   */
  const handleDiagnose = (item: ProblemItem, e: React.MouseEvent) => {
    e.stopPropagation();
    const sevLabel = item.severity === monaco.MarkerSeverity.Error ? '错误 (Error)' : '警告 (Warning)';
    const prompt = `请协助诊断并修复以下代码诊断问题：\n- 文件：\`${item.filePath}\` (第 ${item.startLine} 行, 第 ${item.startColumn} 列)\n- 级别：${sevLabel}\n- 描述：${item.message}\n${item.source ? `- 规则来源：${item.source}\n` : ''}\n请针对该文件给出修复方案并提供修改后的代码。`;

    window.dispatchEvent(
      new CustomEvent('echoly:askAi', {
        detail: {
          prompt,
          autoSubmit: true,
        },
      }),
    );
  };

  const handleDiagnoseAll = () => {
    if (filteredMarkers.length === 0) return;
    const topProblems = filteredMarkers.slice(0, 5);
    const details = topProblems
      .map(
        (p, i) =>
          `${i + 1}. \`${p.fileName}\` (L${p.startLine}): [${p.severity === monaco.MarkerSeverity.Error ? '错误' : '警告'}] ${p.message}`,
      )
      .join('\n');

    const prompt = `请协助批量分析并修复当前工程检测出的代码问题 (共 ${filteredMarkers.length} 个，以下列出前 ${topProblems.length} 项)：\n${details}\n\n请按优先级给出综合分析与修复指引。`;

    window.dispatchEvent(
      new CustomEvent('echoly:askAi', {
        detail: {
          prompt,
          autoSubmit: true,
        },
      }),
    );
  };

  return (
    <div className="problems-panel-root" style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', background: 'var(--bg-editor, #1e1e1e)' }}>
      {/* 二级顶部工具栏 - 严格对齐 Maven / AGENTS.md 规范 (height: 30, padding: 0 10px) */}
      <div
        style={{
          height: 30,
          padding: '0 10px',
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.05em', color: 'var(--text)' }}>
            {t('problems.title', { n: filteredMarkers.length })}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
            <button
              type="button"
              className={`problems-filter-pill ${severityFilter === 'all' ? 'active' : ''}`}
              onClick={() => setSeverityFilter('all')}
            >
              {t('problems.filterAll')}
            </button>
            <button
              type="button"
              className={`problems-filter-pill ${severityFilter === 'error' ? 'active' : ''}`}
              onClick={() => setSeverityFilter('error')}
            >
              {t('problems.filterError')}
            </button>
            <button
              type="button"
              className={`problems-filter-pill ${severityFilter === 'warning' ? 'active' : ''}`}
              onClick={() => setSeverityFilter('warning')}
            >
              {t('problems.filterWarning')}
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="text"
            className="problems-search-input"
            placeholder={t('problems.filterPh')}
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />

          {filteredMarkers.length > 0 && (
            <button
              type="button"
              className="panel-action-btn"
              onClick={handleDiagnoseAll}
              title={t('problems.diagnoseAllTitle')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </button>
          )}

          <button
            type="button"
            className="panel-action-btn"
            onClick={refreshMarkers}
            title={t('problems.refreshTitle')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        </div>
      </div>

      {/* 列表内容区 */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 10px' }}>
        {groupedByFile.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--muted)', fontSize: 13, gap: 8 }}>
            <span>✓</span>
            <span>{t('problems.allGood')}</span>
          </div>
        ) : (
          groupedByFile.map(([filePath, items]) => {
            const relPath = workspace && filePath.startsWith(workspace)
              ? filePath.slice(workspace.length).replace(/^[/\\]/, '')
              : filePath;

            return (
              <div key={filePath} style={{ marginBottom: 12 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 6px',
                    borderRadius: 4,
                    background: 'rgba(255, 255, 255, 0.03)',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--text)',
                    cursor: 'pointer',
                  }}
                  onClick={() => onOpenFile?.(filePath)}
                >
                  <span style={{ opacity: 0.7 }}>📄</span>
                  <span>{relPath}</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 4 }}>
                    {t('problems.fileProblemCount', { n: items.length })}
                  </span>
                </div>

                <div style={{ paddingLeft: 16, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {items.map((item) => {
                    const isError = item.severity === monaco.MarkerSeverity.Error;
                    return (
                      <div
                        key={item.id}
                        className="problems-item-row"
                        onClick={() => onOpenFile?.(item.filePath, item.startLine, item.startColumn)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '3px 8px',
                          borderRadius: 4,
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                          <span
                            style={{
                              color: isError ? '#f87171' : '#fbbf24',
                              fontWeight: 700,
                              fontSize: 11,
                              flexShrink: 0,
                            }}
                          >
                            {isError ? '✕' : '⚠'}
                          </span>
                          <span style={{ color: 'var(--muted)', fontSize: 11, flexShrink: 0 }}>
                            [{item.startLine}:{item.startColumn}]
                          </span>
                          <span
                            style={{
                              color: 'var(--text)',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                            title={item.message}
                          >
                            {item.message}
                          </span>
                          {item.source && (
                            <span
                              style={{
                                fontSize: 10,
                                padding: '1px 5px',
                                borderRadius: 3,
                                background: 'rgba(255, 255, 255, 0.06)',
                                color: 'var(--muted)',
                                flexShrink: 0,
                              }}
                            >
                              {item.source}
                            </span>
                          )}
                        </div>

                        <button
                          type="button"
                          className="problems-fix-ai-btn"
                          onClick={(e) => handleDiagnose(item, e)}
                          title={t('problems.fixTitle')}
                        >
                          {t('problems.fix')}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
