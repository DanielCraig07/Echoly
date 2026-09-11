import { useEffect, useRef, useState } from 'react';
import type { GitCommitEntry, GitStatusResult } from '@deepseek-ide/shared';

interface Props {
  branch?: string;
  gitStatus?: GitStatusResult | null;
  activePath?: string | null;
  cursorPos?: { line: number; col: number } | null;
  docStats?: { lineCount: number; charCount: number } | null;
  language?: string;
  latestCommit?: GitCommitEntry | null;
  onOpenBranchSwitcher?: () => void;
  onSelectLanguage?: (lang: string) => void;
  onOpenAbout?: () => void;
}

const COMMON_LANGUAGES = [
  { id: 'typescript', label: 'TypeScript' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'python', label: 'Python' },
  { id: 'json', label: 'JSON' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'rust', label: 'Rust' },
  { id: 'go', label: 'Go' },
  { id: 'cpp', label: 'C++' },
  { id: 'c', label: 'C' },
  { id: 'csharp', label: 'C#' },
  { id: 'java', label: 'Java' },
  { id: 'sql', label: 'SQL' },
  { id: 'yaml', label: 'YAML' },
  { id: 'shell', label: 'Shell Script' },
  { id: 'plaintext', label: 'Plain Text' },
];

export function StatusBar({
  branch = 'master',
  gitStatus,
  activePath,
  cursorPos = { line: 41, col: 3 },
  docStats = { lineCount: 70, charCount: 1510 },
  language = 'TypeScript JSX',
  latestCommit,
  onOpenBranchSwitcher,
  onSelectLanguage,
  onOpenAbout,
}: Props) {
  const hasChanges = Boolean(gitStatus?.entries?.length);
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [langSearch, setLangSearch] = useState('');
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowLangPicker(false);
      }
    };
    if (showLangPicker) {
      document.addEventListener('mousedown', onDocClick);
    }
    return () => {
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [showLangPicker]);

  const filteredLanguages = COMMON_LANGUAGES.filter(
    (l) =>
      l.label.toLowerCase().includes(langSearch.toLowerCase()) ||
      l.id.toLowerCase().includes(langSearch.toLowerCase()),
  );

  return (
    <div className="ide-status-bar">
      <div className="status-bar-left">
        <span className="status-item status-remote" title="Remote/Server Connected">
          &gt;&lt;
        </span>
        {gitStatus?.isRepo !== false && Boolean(branch) && (
          <button
            type="button"
            className="status-item status-branch-btn"
            style={{
              background: 'none',
              border: 'none',
              color: 'inherit',
              font: 'inherit',
              cursor: 'pointer',
              padding: 0,
            }}
            title="点击切换 Git 分支 / Tag 标签"
            onClick={onOpenBranchSwitcher}
          >
            <span style={{ fontSize: 11, marginRight: 4 }}>⪽</span> {branch}
            {hasChanges ? '*' : ''}
          </button>
        )}
        <span className="status-item" title="Sync Status">
          ☁
        </span>
        <span className="status-item status-errors" title="Errors and Warnings">
          ⓧ 0 ⚠ 1
        </span>
      </div>

      <div className="status-bar-right">
        {latestCommit && (
          <span className="status-item" title={`Last Commit: ${latestCommit.message}`}>
            ⪽ {latestCommit.author} ({latestCommit.relativeDate || latestCommit.date})
          </span>
        )}

        <span className="status-item">
          行 {cursorPos?.line ?? 1}, 列 {cursorPos?.col ?? 1}
        </span>
        <span className="status-item">空格: 2</span>
        <span className="status-item">UTF-8</span>
        <span className="status-item">LF</span>

        {/* Interactive Language Mode Picker */}
        <div style={{ position: 'relative', display: 'inline-flex' }} ref={pickerRef}>
          <button
            type="button"
            className="status-item status-lang-btn"
            style={{
              background: 'none',
              border: 'none',
              color: 'inherit',
              font: 'inherit',
              cursor: 'pointer',
              padding: '0 4px',
            }}
            onClick={() => {
              setShowLangPicker((v) => !v);
              setLangSearch('');
            }}
            title="点击切换语言模式"
          >
            {'{ }'} {language || 'TypeScript'}
          </button>

          {showLangPicker && (
            <div className="status-lang-picker-popup">
              <div className="status-lang-picker-header">
                <input
                  type="text"
                  autoFocus
                  placeholder="搜索语言..."
                  value={langSearch}
                  onChange={(e) => setLangSearch(e.target.value)}
                  className="status-lang-picker-input"
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
              <div className="status-lang-picker-list">
                {filteredLanguages.map((item) => (
                  <div
                    key={item.id}
                    className={`status-lang-picker-item${(language?.toLowerCase() || '').includes(item.id) ? ' active' : ''}`}
                    onClick={() => {
                      onSelectLanguage?.(item.id);
                      setShowLangPicker(false);
                    }}
                  >
                    <span>{item.label}</span>
                    <span className="status-lang-picker-id">{item.id}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <span className="status-item">
          行 {docStats?.lineCount ?? 0} 字数 {docStats?.charCount ?? 0}
        </span>

        {/* 轻量开发者徽标 (点击直达关于作者) */}
        <button
          type="button"
          className="status-item status-dev-badge"
          onClick={onOpenAbout}
          title="Echoly by Daniel (v0.0.10) · 点击查看关于作者"
        >
          <span className="status-dev-icon">⚡</span>
          <span className="status-dev-name">Daniel</span>
        </button>
      </div>
    </div>
  );
}
