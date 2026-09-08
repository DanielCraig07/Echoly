import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SearchCodeHit } from '@deepseek-ide/shared';
import { RenderFileTreeIcon } from './FileTree';

interface Props {
  onOpenFile: (path: string, line?: number) => void;
  onRevealLine?: (line: number) => void;
}

interface FileGroup {
  path: string;
  dirPath: string;
  fileName: string;
  hits: SearchCodeHit[];
}

interface SearchTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: SearchTreeNode[];
  hits?: SearchCodeHit[];
}

function buildSearchTree(groups: FileGroup[]): SearchTreeNode[] {
  const rootNodes: SearchTreeNode[] = [];
  const map = new Map<string, SearchTreeNode>();

  for (const g of groups) {
    const parts = g.path.split('/');
    let currentPath = '';
    let parentChildren = rootNodes;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      let node = map.get(currentPath);
      if (!node) {
        node = {
          name: part,
          path: currentPath,
          isDirectory: !isFile,
          children: [],
          hits: isFile ? g.hits : undefined,
        };
        map.set(currentPath, node);
        parentChildren.push(node);
      }
      parentChildren = node.children;
    }
  }

  return rootNodes;
}

function SearchTreeNodeView({
  node,
  depth = 0,
  query,
  isCaseSensitive,
  collapsedMap,
  toggleCollapse,
  onOpenFile,
  onRevealLine,
  highlightMatch,
}: {
  node: SearchTreeNode;
  depth?: number;
  query: string;
  isCaseSensitive: boolean;
  collapsedMap: Record<string, boolean>;
  toggleCollapse: (path: string) => void;
  onOpenFile: (path: string, line?: number) => void;
  onRevealLine?: (line: number) => void;
  highlightMatch: (text: string, q: string) => React.ReactNode;
}) {
  const isCollapsed = !!collapsedMap[node.path];

  if (node.isDirectory) {
    return (
      <div>
        <div
          onClick={() => toggleCollapse(node.path)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            paddingLeft: 12 + depth * 14,
            paddingTop: 4,
            paddingBottom: 4,
            cursor: 'pointer',
            fontSize: 12,
            userSelect: 'none',
          }}
          className="search-result-item"
        >
          <span
            className="chevron"
            style={{ fontSize: 11, color: 'var(--muted)', width: 12, display: 'inline-block' }}
          >
            {isCollapsed ? '▸' : '▾'}
          </span>
          <RenderFileTreeIcon name={node.name} isDirectory={true} isOpen={!isCollapsed} />
          <span style={{ color: 'var(--text)', fontWeight: 500 }}>{node.name}</span>
        </div>
        {!isCollapsed && (
          <div>
            {node.children.map((child) => (
              <SearchTreeNodeView
                key={child.path}
                node={child}
                depth={depth + 1}
                query={query}
                isCaseSensitive={isCaseSensitive}
                collapsedMap={collapsedMap}
                toggleCollapse={toggleCollapse}
                onOpenFile={onOpenFile}
                onRevealLine={onRevealLine}
                highlightMatch={highlightMatch}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // File node
  const hits = node.hits || [];
  return (
    <div>
      <div
        onClick={() => toggleCollapse(node.path)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingLeft: 12 + depth * 14,
          paddingTop: 4,
          paddingBottom: 4,
          cursor: 'pointer',
          fontSize: 12,
          userSelect: 'none',
        }}
        className="search-result-item"
      >
        <span
          className="chevron"
          style={{ fontSize: 11, color: 'var(--muted)', width: 12, display: 'inline-block' }}
        >
          {isCollapsed ? '▸' : '▾'}
        </span>
        <RenderFileTreeIcon name={node.name} isDirectory={false} />
        <span style={{ color: 'var(--text)', fontWeight: 600 }}>{node.name}</span>
        <span
          style={{
            marginLeft: 'auto',
            marginRight: 8,
            fontSize: 11,
            background: 'var(--bg-hover)',
            padding: '1px 6px',
            borderRadius: 10,
            color: 'var(--muted)',
          }}
        >
          {hits.length}
        </span>
      </div>
      {!isCollapsed && (
        <div>
          {hits.map((hit, idx) => (
            <div
              key={`${hit.path}-${hit.line}-${idx}`}
              onClick={() => {
                // 直接将行号传给 onOpenFile，由调用方(openFile)统一处理时序
                // 避免 onOpenFile(path) + 立即 onRevealLine(line) 的时序竞争
                onOpenFile(hit.path, hit.line);
              }}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                paddingLeft: 28 + depth * 14,
                paddingTop: 3,
                paddingBottom: 3,
                cursor: 'pointer',
                fontSize: 12,
                fontFamily: 'var(--font-mono)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              className="search-result-item"
            >
              <span
                style={{ color: 'var(--accent)', fontSize: 11, minWidth: 24, textAlign: 'right', flexShrink: 0 }}
              >
                {hit.line}:
              </span>
              <span
                style={{
                  flex: '1 1 auto',
                  minWidth: 0,
                  color: 'var(--text)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {highlightMatch(hit.preview, query)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SearchPanel({ onOpenFile, onRevealLine }: Props) {
  const [query, setQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [showReplace, setShowReplace] = useState(true);
  const [isCaseSensitive, setIsCaseSensitive] = useState(false);
  const [isWholeWord, setIsWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [preserveCase, setPreserveCase] = useState(false);
  const [displayMode, setDisplayMode] = useState<'list' | 'tree'>('list');

  const [showDetails, setShowDetails] = useState(false);
  const [includesPattern, setIncludesPattern] = useState('');
  const [excludesPattern, setExcludesPattern] = useState('');

  const [loading, setLoading] = useState(false);
  const [rawHits, setRawHits] = useState<SearchCodeHit[]>([]);
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});
  const [allCollapsed, setAllCollapsed] = useState(false);

  const seq = useRef(0);

  // Perform real-time project-wide search
  const performSearch = useCallback(async (q: string, caseSensitive: boolean) => {
    if (!q.trim()) {
      setRawHits([]);
      setLoading(false);
      return;
    }
    const currentSeq = ++seq.current;
    setLoading(true);
    try {
      const hits = await window.ide.searchCode({
        query: q,
        caseInsensitive: !caseSensitive,
        max: 300,
      });
      if (currentSeq === seq.current) {
        setRawHits(hits);
        setLoading(false);
      }
    } catch {
      if (currentSeq === seq.current) {
        setRawHits([]);
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void performSearch(query, isCaseSensitive);
    }, 150);
    return () => clearTimeout(timer);
  }, [query, isCaseSensitive, performSearch]);

  // Client-side filtering for Whole Word and Regex
  const filteredHits = rawHits.filter((hit) => {
    if (!query) return false;
    let text = hit.preview;
    let searchStr = query;
    if (!isCaseSensitive) {
      text = text.toLowerCase();
      searchStr = searchStr.toLowerCase();
    }
    if (isWholeWord) {
      const regex = new RegExp(
        `\\b${searchStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
        isCaseSensitive ? '' : 'i',
      );
      if (!regex.test(hit.preview)) return false;
    }
    if (isRegex) {
      try {
        const regex = new RegExp(query, isCaseSensitive ? '' : 'i');
        if (!regex.test(hit.preview)) return false;
      } catch {
        return false;
      }
    }
    if (includesPattern.trim()) {
      const patterns = includesPattern
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      if (patterns.length > 0 && !patterns.some((p) => hit.path.includes(p))) return false;
    }
    if (excludesPattern.trim()) {
      const patterns = excludesPattern
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      if (patterns.length > 0 && patterns.some((p) => hit.path.includes(p))) return false;
    }
    return true;
  });

  // Group hits by file
  const groups: FileGroup[] = [];
  const groupMap = new Map<string, SearchCodeHit[]>();
  for (const hit of filteredHits) {
    const list = groupMap.get(hit.path) || [];
    list.push(hit);
    groupMap.set(hit.path, list);
  }
  for (const [filePath, hits] of groupMap.entries()) {
    const parts = filePath.split('/');
    const fileName = parts.pop() || filePath;
    const dirPath = parts.join('/');
    groups.push({ path: filePath, dirPath, fileName, hits });
  }

  const treeNodes = buildSearchTree(groups);
  const totalMatches = filteredHits.length;
  const totalFiles = groups.length;

  const toggleFileCollapse = (filePath: string) => {
    setCollapsedFiles((prev) => ({ ...prev, [filePath]: !prev[filePath] }));
  };

  const toggleAllCollapse = () => {
    const next = !allCollapsed;
    setAllCollapsed(next);
    const updated: Record<string, boolean> = {};
    const collapseRecursive = (nodes: SearchTreeNode[]) => {
      for (const n of nodes) {
        updated[n.path] = next;
        if (n.children.length > 0) collapseRecursive(n.children);
      }
    };
    for (const g of groups) {
      updated[g.path] = next;
    }
    collapseRecursive(treeNodes);
    setCollapsedFiles(updated);
  };

  const handleClear = () => {
    setQuery('');
    setRawHits([]);
  };

  const handleReplaceAll = async () => {
    if (!query || groups.length === 0) return;
    for (const g of groups) {
      try {
        const content = await window.ide.readFile(g.path);
        let newContent = content;
        if (isRegex) {
          const regex = new RegExp(query, isCaseSensitive ? 'g' : 'gi');
          newContent = content.replace(regex, replaceQuery);
        } else if (isWholeWord) {
          const regex = new RegExp(
            `\\b${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
            isCaseSensitive ? 'g' : 'gi',
          );
          newContent = content.replace(regex, replaceQuery);
        } else {
          const regex = new RegExp(
            query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            isCaseSensitive ? 'g' : 'gi',
          );
          newContent = content.replace(regex, replaceQuery);
        }
        if (newContent !== content) {
          await window.ide.writeFile(g.path, newContent);
        }
      } catch {
        // ignore
      }
    }
    void performSearch(query, isCaseSensitive);
  };

  const highlightMatch = (text: string, q: string) => {
    if (!q) return text;
    try {
      const regex = new RegExp(
        `(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`,
        isCaseSensitive ? 'g' : 'gi',
      );
      const parts = text.split(regex);
      return parts.map((part, i) =>
        regex.test(part) ? (
          <mark
            key={i}
            style={{
              background: 'var(--accent)',
              color: '#fff',
              padding: '0 2px',
              borderRadius: 2,
            }}
          >
            {part}
          </mark>
        ) : (
          part
        ),
      );
    } catch {
      return text;
    }
  };

  return (
    <div
      className="search-panel"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        minWidth: 0,
        width: '100%',
        overflow: 'hidden',
      }}
    >
      {/* 1. Header Bar */}
      <div
        className="search-panel-header"
        style={{
          padding: '0 10px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: '1px solid var(--border)',
          height: 30,
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--text)',
            letterSpacing: '0.05em',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span className="chevron" style={{ fontSize: 12, color: 'var(--muted)' }}>
            ▾
          </span>{' '}
          搜索
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <button
            type="button"
            title="刷新搜索"
            onClick={() => void performSearch(query, isCaseSensitive)}
            style={{
              padding: 4,
              background: 'transparent',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
          <button
            type="button"
            title="清空搜索结果"
            onClick={handleClear}
            style={{
              padding: 4,
              background: 'transparent',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          <button
            type="button"
            title={displayMode === 'list' ? '按树结构显示' : '按列表显示'}
            onClick={() => setDisplayMode((m) => (m === 'list' ? 'tree' : 'list'))}
            style={{
              padding: 4,
              background: displayMode === 'tree' ? 'var(--bg-hover)' : 'transparent',
              border: 'none',
              color: displayMode === 'tree' ? 'var(--text)' : 'var(--muted)',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {displayMode === 'tree' ? (
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 4h4v4H4zM12 16h4v4h-4zM12 8h8M12 8v12M8 6h4" />
              </svg>
            ) : (
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            )}
          </button>
          <button
            type="button"
            title={allCollapsed ? '全部展开' : '全部折叠'}
            onClick={toggleAllCollapse}
            style={{
              padding: 4,
              background: 'transparent',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <rect x="8" y="8" width="12" height="12" rx="2" ry="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
              <line x1="11" y1="14" x2="17" y2="14" />
              {allCollapsed && <line x1="14" y1="11" x2="14" y2="17" />}
            </svg>
          </button>
        </div>
      </div>

      {/* 2. Inputs Area */}
      <div
        style={{
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          borderBottom: '1px solid var(--border)',
        }}
      >
        {/* Search Input Row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            onClick={() => setShowReplace((v) => !v)}
            title={showReplace ? '隐藏替换' : '显示替换'}
            style={{
              padding: 2,
              background: 'transparent',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
              fontSize: 12,
              transform: showReplace ? 'rotate(90deg)' : 'none',
              transition: 'transform 0.15s',
            }}
          >
            ▸
          </button>
          <div
            style={{
              flex: 1,
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              background: 'var(--bg-input, #12161c)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              paddingRight: 80,
            }}
          >
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索 (↑↓ 历史)"
              title="搜索 (使用 ↑↓ 查看历史记录)"
              style={{
                flex: 1,
                minWidth: 0,
                padding: '6px 8px',
                paddingRight: 86,
                background: 'transparent',
                border: 'none',
                color: 'var(--text)',
                fontSize: 12,
                outline: 'none',
              }}
            />
            {/* Action Toggles Inside Input */}
            <div
              style={{
                position: 'absolute',
                right: 4,
                display: 'flex',
                gap: 2,
                alignItems: 'center',
              }}
            >
              <button
                type="button"
                title="区分大小写 (Alt+C)"
                onClick={() => setIsCaseSensitive((v) => !v)}
                style={{
                  padding: '2px 5px',
                  fontSize: 11,
                  fontWeight: 'bold',
                  fontFamily: 'monospace',
                  background: isCaseSensitive ? 'var(--accent)' : 'transparent',
                  color: isCaseSensitive ? '#fff' : 'var(--muted)',
                  border: 'none',
                  borderRadius: 3,
                  cursor: 'pointer',
                }}
              >
                Aa
              </button>
              <button
                type="button"
                title="全字匹配 (Alt+W)"
                onClick={() => setIsWholeWord((v) => !v)}
                style={{
                  padding: '2px 5px',
                  fontSize: 11,
                  fontWeight: 'bold',
                  fontFamily: 'monospace',
                  textDecoration: isWholeWord ? 'underline' : 'none',
                  background: isWholeWord ? 'var(--accent)' : 'transparent',
                  color: isWholeWord ? '#fff' : 'var(--muted)',
                  border: 'none',
                  borderRadius: 3,
                  cursor: 'pointer',
                }}
              >
                ab
              </button>
              <button
                type="button"
                title="使用正则表达式 (Alt+R)"
                onClick={() => setIsRegex((v) => !v)}
                style={{
                  padding: '2px 5px',
                  fontSize: 11,
                  fontWeight: 'bold',
                  fontFamily: 'monospace',
                  background: isRegex ? 'var(--accent)' : 'transparent',
                  color: isRegex ? '#fff' : 'var(--muted)',
                  border: 'none',
                  borderRadius: 3,
                  cursor: 'pointer',
                }}
              >
                .*
              </button>
            </div>
          </div>
        </div>

        {/* Replace Input Row (Collapsible) */}
        {showReplace && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 18 }}>
            <div
              style={{
                flex: 1,
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                background: 'var(--bg-input, #12161c)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                paddingRight: 60,
              }}
            >
              <input
                type="text"
                value={replaceQuery}
                onChange={(e) => setReplaceQuery(e.target.value)}
                placeholder="替换"
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text)',
                  fontSize: 12,
                  outline: 'none',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  right: 4,
                  display: 'flex',
                  gap: 4,
                  alignItems: 'center',
                }}
              >
                <button
                  type="button"
                  title="保留大小写"
                  onClick={() => setPreserveCase((v) => !v)}
                  style={{
                    padding: '2px 4px',
                    fontSize: 10,
                    fontWeight: 'bold',
                    background: preserveCase ? 'var(--accent)' : 'transparent',
                    color: preserveCase ? '#fff' : 'var(--muted)',
                    border: 'none',
                    borderRadius: 3,
                    cursor: 'pointer',
                  }}
                >
                  AB
                </button>
                <button
                  type="button"
                  title="全部替换 (Alt+Enter)"
                  onClick={() => void handleReplaceAll()}
                  style={{
                    padding: '2px 6px',
                    fontSize: 12,
                    background: 'transparent',
                    color: 'var(--muted)',
                    border: 'none',
                    borderRadius: 3,
                    cursor: 'pointer',
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <polyline points="17 1 21 5 17 9" />
                    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                    <polyline points="7 23 3 19 7 15" />
                    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* More Details Toggle (Includes / Excludes) */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 2 }}>
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--muted)',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            {showDetails ? '隐藏过滤选项 ▲' : '包含 / 排除的文件... ▼'}
          </button>
        </div>

        {showDetails && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>包含的文件</span>
            <input
              type="text"
              value={includesPattern}
              onChange={(e) => setIncludesPattern(e.target.value)}
              placeholder="e.g. *.ts, src/**"
              style={{
                width: '100%',
                padding: '4px 8px',
                background: 'var(--bg-input, #12161c)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                color: 'var(--text)',
                fontSize: 12,
                outline: 'none',
              }}
            />
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>排除的文件</span>
            <input
              type="text"
              value={excludesPattern}
              onChange={(e) => setExcludesPattern(e.target.value)}
              placeholder="e.g. node_modules, dist"
              style={{
                width: '100%',
                padding: '4px 8px',
                background: 'var(--bg-input, #12161c)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                color: 'var(--text)',
                fontSize: 12,
                outline: 'none',
              }}
            />
          </div>
        )}
      </div>

      {/* 3. Search Results Summary & List / Tree View */}
      <div
        className="search-results-scroll"
        style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0, minWidth: 0 }}
      >
        {loading && (
          <div style={{ padding: 12, color: 'var(--muted)', fontSize: 12 }}>Searching...</div>
        )}
        {!loading && query && groups.length === 0 && (
          <div style={{ padding: 12, color: 'var(--muted)', fontSize: 12 }}>未找到匹配的结果</div>
        )}

        {!loading && groups.length > 0 && (
          <div>
            <div
              style={{
                padding: '6px 12px',
                fontSize: 11,
                color: 'var(--muted)',
                borderBottom: '1px solid var(--border)',
              }}
            >
              在 {totalFiles} 个文件中找到了 {totalMatches} 个结果 (
              {displayMode === 'tree' ? '树结构' : '列表模式'})
            </div>

            {displayMode === 'tree' ? (
              <div>
                {treeNodes.map((node) => (
                  <SearchTreeNodeView
                    key={node.path}
                    node={node}
                    depth={0}
                    query={query}
                    isCaseSensitive={isCaseSensitive}
                    collapsedMap={collapsedFiles}
                    toggleCollapse={toggleFileCollapse}
                    onOpenFile={onOpenFile}
                    onRevealLine={onRevealLine}
                    highlightMatch={highlightMatch}
                  />
                ))}
              </div>
            ) : (
              <div>
                {groups.map((group) => {
                  const isCollapsed = !!collapsedFiles[group.path];
                  return (
                    <div
                      key={group.path}
                      style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)' }}
                    >
                      {/* File Header */}
                      <div
                        onClick={() => toggleFileCollapse(group.path)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '6px 12px',
                          cursor: 'pointer',
                          background: 'rgba(255, 255, 255, 0.02)',
                          userSelect: 'none',
                        }}
                      >
                        <span style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}>
                          {isCollapsed ? '▸' : '▾'}
                        </span>
                        <RenderFileTreeIcon name={group.fileName} isDirectory={false} />
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color: 'var(--text)',
                            flexShrink: 0,
                            maxWidth: '40%',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {group.fileName}
                        </span>
                        {group.dirPath && (
                          <span
                            style={{
                              fontSize: 11,
                              color: 'var(--muted)',
                              flex: '1 1 auto',
                              minWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {group.dirPath}
                          </span>
                        )}
                        <span
                          style={{
                            marginLeft: 'auto',
                            flexShrink: 0,
                            fontSize: 11,
                            background: 'var(--bg-hover)',
                            padding: '1px 6px',
                            borderRadius: 10,
                            color: 'var(--muted)',
                          }}
                        >
                          {group.hits.length}
                        </span>
                      </div>

                      {/* Match Lines */}
                      {!isCollapsed && (
                        <div>
                          {group.hits.map((hit, idx) => (
                            <div
                              key={`${hit.path}-${hit.line}-${idx}`}
                              onClick={() => {
                                onOpenFile(hit.path, hit.line);
                                if (onRevealLine) onRevealLine(hit.line);
                              }}
                              style={{
                                display: 'flex',
                                alignItems: 'baseline',
                                gap: 8,
                                padding: '4px 12px 4px 28px',
                                cursor: 'pointer',
                                fontSize: 12,
                                fontFamily: 'var(--font-mono)',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                              className="search-result-item"
                            >
                              <span
                                style={{
                                  color: 'var(--accent)',
                                  fontSize: 11,
                                  minWidth: 24,
                                  textAlign: 'right',
                                }}
                              >
                                {hit.line}:
                              </span>
                              <span
                                style={{
                                  color: 'var(--text)',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                }}
                              >
                                {highlightMatch(hit.preview, query)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
