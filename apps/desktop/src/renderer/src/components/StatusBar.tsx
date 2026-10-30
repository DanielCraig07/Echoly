import { useEffect, useRef, useState } from 'react';
import { APP_VERSION, type GitCommitEntry, type GitStatusResult } from '@deepseek-ide/shared';
import { useI18n } from '../i18n';

interface Props {
  branch?: string;
  gitStatus?: GitStatusResult | null;
  activePath?: string | null;
  cursorPos?: { line: number; col: number } | null;
  docStats?: { lineCount: number; charCount: number } | null;
  language?: string;
  latestCommit?: GitCommitEntry | null;
  tabSize?: number;
  encoding?: string;
  eol?: 'LF' | 'CRLF';
  onOpenRemote?: () => void;
  onOpenBranchSwitcher?: () => void;
  onSyncGit?: () => Promise<void> | void;
  onToggleBottomPanel?: () => void;
  onGoToLine?: (line: number, col?: number) => void;
  onSelectLanguage?: (lang: string) => void;
  onSelectTabSize?: (size: number) => void;
  onSelectEncoding?: (encoding: string) => void;
  onToggleEol?: (eol: 'LF' | 'CRLF') => void;
  onOpenAbout?: () => void;
  onShowToast?: (
    title: string,
    detail?: string,
    type?: 'success' | 'error' | 'info' | 'warn',
  ) => void;
  isRemote?: boolean;
  remoteLabel?: string | null;
  isSshDisconnected?: boolean;
  onReconnectSsh?: () => void;
}

const COMMON_LANGUAGES = [
  { id: 'typescript', label: 'TypeScript' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'python', label: 'Python' },
  { id: 'sql', label: 'SQL' },
  { id: 'json', label: 'JSON' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'java', label: 'Java' },
  { id: 'rust', label: 'Rust' },
  { id: 'go', label: 'Go' },
  { id: 'cpp', label: 'C++' },
  { id: 'c', label: 'C' },
  { id: 'csharp', label: 'C#' },
  { id: 'yaml', label: 'YAML' },
  { id: 'shell', label: 'Shell Script' },
  { id: 'xml', label: 'XML' },
  { id: 'vue', label: 'Vue' },
  { id: 'plaintext', label: 'Plain Text' },
];

export function StatusBar({
  branch = 'master',
  gitStatus,
  activePath,
  cursorPos = { line: 1, col: 1 },
  docStats = { lineCount: 1, charCount: 0 },
  language = 'SQL',
  latestCommit,
  tabSize = 2,
  encoding = 'UTF-8',
  eol = 'LF',
  onOpenRemote,
  onOpenBranchSwitcher,
  onSyncGit,
  onToggleBottomPanel,
  onGoToLine,
  onSelectLanguage,
  onSelectTabSize,
  onSelectEncoding,
  onToggleEol,
  onOpenAbout,
  onShowToast,
  isRemote,
  remoteLabel,
  isSshDisconnected,
  onReconnectSsh,
}: Props) {
  const { t } = useI18n();
  const hasChanges = Boolean(gitStatus?.entries?.length);
  const [activePopover, setActivePopover] = useState<
    'lang' | 'goto' | 'indent' | 'encoding' | 'eol' | 'stats' | null
  >(null);
  const [langSearch, setLangSearch] = useState('');
  const [targetLineInput, setTargetLineInput] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [currentTabSize, setCurrentTabSize] = useState(tabSize);
  const [currentEncoding, setCurrentEncoding] = useState(encoding);
  const [currentEol, setCurrentEol] = useState<'LF' | 'CRLF'>(eol);
  const [copilotActive, setCopilotActive] = useState(false);
  const [copilotEnabled, setCopilotEnabled] = useState(true);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const gotoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleGhostState = (e: Event) => {
      const custom = e as CustomEvent<{ active: boolean }>;
      setCopilotActive(Boolean(custom.detail?.active));
    };
    window.addEventListener('echoly:ghostTextState', handleGhostState);
    return () => window.removeEventListener('echoly:ghostTextState', handleGhostState);
  }, []);

  const handleCheckUpdate = async () => {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const res = await window.ide?.checkUpdate?.();
      if (res?.hasUpdate && res?.version) {
        onShowToast?.(
          `${t('status.newVersion')}${res.version}`,
          t('status.newVersionHint'),
          'info',
        );
      } else {
        onShowToast?.(`${t('status.upToDate')}v${APP_VERSION})`, undefined, 'success');
      }
    } catch {
      onShowToast?.(`v${APP_VERSION}`, t('status.updateUnreachable'), 'info');
    } finally {
      setCheckingUpdate(false);
    }
  };

  // 同步外部传入的配置
  useEffect(() => {
    if (tabSize) setCurrentTabSize(tabSize);
  }, [tabSize]);

  useEffect(() => {
    if (encoding) setCurrentEncoding(encoding);
  }, [encoding]);

  useEffect(() => {
    if (eol) setCurrentEol(eol);
  }, [eol]);

  // 点击外部自动关闭任何弹层
  useEffect(() => {
    if (!activePopover) return;
    const onDocClick = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setActivePopover(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActivePopover(null);
    };
    document.addEventListener('mousedown', onDocClick);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [activePopover]);

  // 打开跳转行弹窗时自动聚焦输入框
  useEffect(() => {
    if (activePopover === 'goto') {
      setTargetLineInput(String(cursorPos?.line ?? 1));
      setTimeout(() => {
        gotoInputRef.current?.focus();
        gotoInputRef.current?.select();
      }, 50);
    }
  }, [activePopover, cursorPos?.line]);

  const filteredLanguages = COMMON_LANGUAGES.filter(
    (l) =>
      l.label.toLowerCase().includes(langSearch.toLowerCase()) ||
      l.id.toLowerCase().includes(langSearch.toLowerCase()),
  );

  const handleSyncClick = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      if (onSyncGit) {
        await onSyncGit();
      }
      onShowToast?.(t('status.syncOk'), undefined, 'info');
    } catch {
      onShowToast?.(t('status.syncFail'), undefined, 'error');
    } finally {
      setTimeout(() => setIsSyncing(false), 450);
    }
  };

  const handleGoToLineSubmit = () => {
    const parsed = parseInt(targetLineInput.trim(), 10);
    if (!isNaN(parsed) && parsed > 0) {
      const maxLine = Math.max(1, docStats?.lineCount ?? 1);
      const clamped = Math.min(parsed, maxLine);
      onGoToLine?.(clamped, 1);
      setActivePopover(null);
    }
  };

  return (
    <div className="ide-status-bar" ref={barRef}>
      {/* ── 左侧区域 ── */}
      <div className="status-bar-left">
        {/* 1. 远程/SSH连接徽标 */}
        {isSshDisconnected ? (
          <button
            type="button"
            className="status-item status-remote is-disconnected"
            style={{
              background: 'rgba(234, 179, 8, 0.25)',
              color: '#facc15',
              border: '1px solid rgba(234, 179, 8, 0.45)',
              fontWeight: 600,
              gap: 4,
            }}
            title="SSH 连接已中断，点击一键静默重连"
            onClick={onReconnectSsh || onOpenRemote}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            <span>SSH 已断开 · 点击重连</span>
          </button>
        ) : (
          <button
            type="button"
            className={`status-item status-remote${isRemote ? ' is-remote-active' : ''}`}
            title={remoteLabel ? `远程主机: ${remoteLabel}` : t('status.remote')}
            onClick={onOpenRemote}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="currentColor"
              style={{ display: 'inline-block' }}
            >
              <path d="M4.5 12.5l-4-4.5 4-4.5.75.67L1.83 8l3.42 3.83-.75.67zm7 0l4-4.5-4-4.5-.75.67L14.17 8l-3.42 3.83.75.67z" />
            </svg>
            {isRemote && <span style={{ marginLeft: 4, fontWeight: 600, fontSize: 11 }}>SSH</span>}
          </button>
        )}

        {/* 2. Git 分支切换按钮 */}
        {gitStatus?.isRepo !== false && Boolean(branch) && (
          <button
            type="button"
            className="status-item status-branch-btn"
            title={t(hasChanges ? 'status.branchLineDirty' : 'status.branchLine', { branch })}
            onClick={onOpenBranchSwitcher}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M11.75 2a1.75 1.75 0 100 3.5 1.75 1.75 0 000-3.5zM10.5 3.75a.75.75 0 111.5 0 .75.75 0 01-1.5 0zm-5 7a1.75 1.75 0 100 3.5 1.75 1.75 0 000-3.5zm-1.25.75a.75.75 0 111.5 0 .75.75 0 01-1.5 0zm5.75-5.25a2.75 2.75 0 01-2.75 2.75H6.25a.75.75 0 00-.75.75v1.282a2.75 2.75 0 11-1.5 0V6.468a2.75 2.75 0 111.5 0v.782h2.25a1.25 1.25 0 001.25-1.25V4.718a2.75 2.75 0 011-1.968zM4.75 3.5a.75.75 0 100 1.5.75.75 0 000-1.5z"
              />
            </svg>
            <span style={{ fontWeight: 500 }}>{branch}</span>
            {hasChanges && <span className="status-git-dirty-dot" title={t('status.dirty')} />}
            {Boolean(gitStatus?.ahead) && (
              <span
                className="status-sync-pill ahead"
                title={t('status.ahead', { n: gitStatus?.ahead ?? 0 })}
              >
                ↑{gitStatus?.ahead}
              </span>
            )}
            {Boolean(gitStatus?.behind) && (
              <span
                className="status-sync-pill behind"
                title={t('status.behind', { n: gitStatus?.behind ?? 0 })}
              >
                ↓{gitStatus?.behind}
              </span>
            )}
          </button>
        )}

        {/* 3. Git 仓库同步刷新按钮 */}
        <button
          type="button"
          className={`status-item status-sync-btn${isSyncing ? ' is-syncing' : ''}`}
          title={t('status.sync')}
          onClick={handleSyncClick}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="currentColor"
            style={{
              display: 'inline-block',
              verticalAlign: 'middle',
              transformOrigin: 'center center',
              animation: isSyncing ? 'spin 0.8s linear infinite' : undefined,
            }}
          >
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M13.836 2.477a.75.75 0 0 1 .75.75v3.182a.75.75 0 0 1-.75.75h-3.182a.75.75 0 0 1 0-1.5h1.37l-.84-.841a4.5 4.5 0 0 0-7.08.932.75.75 0 0 1-1.3-.75 6 6 0 0 1 9.44-1.242l.842.84V3.227a.75.75 0 0 1 .75-.75Zm-.911 7.5A.75.75 0 0 1 14 10.727a6 6 0 0 1-9.44 1.242l-.842-.84v1.644a.75.75 0 0 1-1.5 0V9.59a.75.75 0 0 1 .75-.75h3.182a.75.75 0 0 1 0 1.5H4.78l.841.841a4.5 4.5 0 0 0 7.08-.932.75.75 0 0 1 1.025-.273Z"
            />
          </svg>
        </button>

        {/* 4. 诊断错误与警告徽标（点击切换底部终端与控制台面板） */}
        <button
          type="button"
          className="status-item status-errors"
          title={t('status.problems')}
          onClick={onToggleBottomPanel}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="#f87171">
              <path
                fillRule="evenodd"
                d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm5.22-2.78a.75.75 0 00-1.06 1.06L6.94 8 4.16 10.78a.75.75 0 101.06 1.06L8 9.06l2.78 2.78a.75.75 0 101.06-1.06L9.06 8l2.78-2.78a.75.75 0 00-1.06-1.06L8 6.94 5.22 4.16z"
              />
            </svg>
            0
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 3 }}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="#fbbf24">
              <path
                fillRule="evenodd"
                d="M8.893 1.5c-.397-.72-1.39-.72-1.786 0L.13 13.974c-.382.693.109 1.526.893 1.526h13.954c.784 0 1.275-.833.893-1.526L8.893 1.5zM8 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 5zm0 8a1 1 0 100-2 1 1 0 000 2z"
              />
            </svg>
            0
          </span>
        </button>
      </div>

      {/* ── 右侧区域 ── */}
      <div className="status-bar-right">
        {/* 最新提交信息 */}
        {latestCommit && (
          <span
            className="status-item"
            title={`${t('status.lastCommit')} ${latestCommit.message} (${latestCommit.date})`}
          >
            {latestCommit.author} ({latestCommit.relativeDate || latestCommit.date})
          </span>
        )}

        {/* 1. 光标位置：行号与列号（点击弹出精准跳转弹框） */}
        <div className="status-popover-anchor">
          <button
            type="button"
            className={`status-item status-pos-btn${activePopover === 'goto' ? ' is-active' : ''}`}
            title={t('status.cursor')}
            onClick={() => setActivePopover((v) => (v === 'goto' ? null : 'goto'))}
          >
            {t('status.line')} {cursorPos?.line ?? 1}, {t('status.col')} {cursorPos?.col ?? 1}
          </button>
          {activePopover === 'goto' && (
            <div className="status-popover">
              <div className="status-popover-header">
                <span>{t('status.goto')}</span>
                <span className="status-popover-desc">
                  {t('status.gotoRange')}
                  {Math.max(1, docStats?.lineCount ?? 1)}
                </span>
              </div>
              <div className="status-goto-box">
                <input
                  ref={gotoInputRef}
                  type="number"
                  min={1}
                  max={Math.max(1, docStats?.lineCount ?? 1)}
                  value={targetLineInput}
                  onChange={(e) => setTargetLineInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleGoToLineSubmit();
                    if (e.key === 'Escape') setActivePopover(null);
                  }}
                  className="status-goto-input"
                  placeholder={t('status.gotoPh')}
                />
                <div className="status-goto-actions">
                  <button
                    type="button"
                    className="status-goto-cancel-btn"
                    onClick={() => setActivePopover(null)}
                  >
                    {t('common.cancel')}
                  </button>
                  <button type="button" className="status-goto-btn" onClick={handleGoToLineSubmit}>
                    {t('status.jump')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 2. 缩进与空格设置（点击弹出选项切换缩进宽度） */}
        <div className="status-popover-anchor">
          <button
            type="button"
            className={`status-item status-indent-btn${activePopover === 'indent' ? ' is-active' : ''}`}
            title={t('status.indent')}
            onClick={() => setActivePopover((v) => (v === 'indent' ? null : 'indent'))}
          >
            {t('status.indentLabel')} {currentTabSize}
          </button>
          {activePopover === 'indent' && (
            <div className="status-popover">
              <div className="status-popover-header">
                <span>{t('status.indent')}</span>
              </div>
              {[
                { size: 2, label: `2${t('status.spacesRecommended')}` },
                { size: 4, label: `4${t('status.spaces')}` },
                { size: 8, label: `8${t('status.spaces')}` },
              ].map((item) => (
                <div
                  key={item.size}
                  className={`status-popover-item${currentTabSize === item.size ? ' active' : ''}`}
                  onClick={() => {
                    setCurrentTabSize(item.size);
                    onSelectTabSize?.(item.size);
                    setActivePopover(null);
                    onShowToast?.(
                      `${t('status.indentChanged')} ${item.size}${t('status.spaces')}`,
                      undefined,
                      'info',
                    );
                  }}
                >
                  <span>{item.label}</span>
                  {currentTabSize === item.size && <span style={{ color: '#38bdf8' }}>✓</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 3. 文件编码格式（点击弹出切换编码） */}
        <div className="status-popover-anchor">
          <button
            type="button"
            className={`status-item status-encoding-btn${activePopover === 'encoding' ? ' is-active' : ''}`}
            title={t('status.encoding')}
            onClick={() => setActivePopover((v) => (v === 'encoding' ? null : 'encoding'))}
          >
            {currentEncoding}
          </button>
          {activePopover === 'encoding' && (
            <div className="status-popover">
              <div className="status-popover-header">
                <span>{t('status.encodingTitle')}</span>
              </div>
              {[
                { id: 'UTF-8', label: t('status.encodingUtf8') },
                { id: 'UTF-16 LE', label: 'UTF-16 LE' },
                { id: 'GBK', label: t('status.encodingGbk') },
                { id: 'ASCII', label: 'ASCII' },
              ].map((item) => (
                <div
                  key={item.id}
                  className={`status-popover-item${currentEncoding === item.id ? ' active' : ''}`}
                  onClick={() => {
                    setCurrentEncoding(item.id);
                    onSelectEncoding?.(item.id);
                    setActivePopover(null);
                    onShowToast?.(`${t('status.encodingChanged')} ${item.id}`, undefined, 'info');
                  }}
                >
                  <span>{item.label}</span>
                  {currentEncoding === item.id && <span style={{ color: '#38bdf8' }}>✓</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 4. 行尾换行符序列（点击直接切换 LF 与 CRLF，或弹出菜单） */}
        <div className="status-popover-anchor">
          <button
            type="button"
            className={`status-item status-eol-btn${activePopover === 'eol' ? ' is-active' : ''}`}
            title={t('status.eol')}
            onClick={() => {
              const nextEol = currentEol === 'LF' ? 'CRLF' : 'LF';
              setCurrentEol(nextEol);
              onToggleEol?.(nextEol);
              onShowToast?.(`${t('status.eolChanged')} ${nextEol}`, undefined, 'info');
            }}
          >
            {currentEol}
          </button>
        </div>

        {/* 5. 语言模式（点击弹出搜索式语言切换面板） */}
        <div className="status-popover-anchor">
          <button
            type="button"
            className={`status-item status-lang-btn${activePopover === 'lang' ? ' is-active' : ''}`}
            onClick={() => {
              setActivePopover((v) => (v === 'lang' ? null : 'lang'));
              setLangSearch('');
            }}
            title={t('status.language')}
          >
            {'{ }'} {language || 'SQL'}
          </button>

          {activePopover === 'lang' && (
            <div className="status-lang-picker-popup">
              <div className="status-lang-picker-header">
                <input
                  type="text"
                  autoFocus
                  placeholder={t('status.languagePh')}
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
                      setActivePopover(null);
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

        {/* 6. 文档行数与字数统计（点击弹出详细统计浮层） */}
        <div className="status-popover-anchor">
          <button
            type="button"
            className={`status-item status-stats-btn${activePopover === 'stats' ? ' is-active' : ''}`}
            title={t('status.stats')}
            onClick={() => setActivePopover((v) => (v === 'stats' ? null : 'stats'))}
          >
            {t('status.statsLines')} {docStats?.lineCount ?? 0} {t('status.statsChars')}{' '}
            {docStats?.charCount ?? 0}
          </button>
          {activePopover === 'stats' && (
            <div className="status-popover" style={{ minWidth: 220 }}>
              <div className="status-popover-header">
                <span>{t('status.statsTitle')}</span>
              </div>
              <div className="status-stats-grid">
                <span className="status-stats-label">{t('status.statsTotalLines')}</span>
                <span className="status-stats-val">
                  {docStats?.lineCount ?? 0}
                  {t('status.statsLine')}
                </span>
                <span className="status-stats-label">{t('status.statsTotalChars')}</span>
                <span className="status-stats-val">
                  {docStats?.charCount ?? 0}
                  {t('status.statsChar')}
                </span>
                <span className="status-stats-label">{t('status.statsCursor')}</span>
                <span className="status-stats-val">
                  {t('status.statsAtLine')}
                  {cursorPos?.line ?? 1}
                  {t('status.statsAtCol')}
                  {cursorPos?.col ?? 1}
                  {t('status.statsAtColEnd')}
                </span>
                <span className="status-stats-label">{t('status.statsPath')}</span>
                <span
                  className="status-stats-val"
                  style={{
                    fontSize: 10,
                    maxWidth: 130,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={activePath || t('status.untitled')}
                >
                  {activePath ? activePath.split('/').pop() : t('status.untitled')}
                </span>
              </div>
              <div style={{ padding: '4px 8px 6px', display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="status-goto-btn"
                  style={{ width: '100%' }}
                  onClick={() => setActivePopover('goto')}
                >
                  {t('status.gotoEllipsis')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 7. AI 行内代码幽灵补全指示 */}
        <button
          type="button"
          className={`status-item status-copilot-badge${copilotActive ? ' is-thinking' : ''}`}
          onClick={() => {
            const next = !copilotEnabled;
            setCopilotEnabled(next);
            onShowToast?.(next ? t('status.copilotOn') : t('status.copilotOff'), undefined, 'info');
          }}
          title={
            copilotEnabled
              ? copilotActive
                ? t('status.copilotGenerating')
                : t('status.copilotReady')
              : t('status.copilotPaused')
          }
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            opacity: copilotEnabled ? 1 : 0.6,
          }}
        >
          <span
            style={{
              color: copilotActive ? '#38bdf8' : copilotEnabled ? '#10b981' : 'var(--text-muted)',
            }}
          >
            ✨
          </span>
          <span>Copilot</span>
        </button>

        {/* 8. 版本检查更新快捷入口 */}
        <button
          type="button"
          className="status-item status-version-badge"
          onClick={() => void handleCheckUpdate()}
          title={`Echoly v${APP_VERSION}${t('status.versionClick')}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <span>v{APP_VERSION}</span>
        </button>

        {/* 9. 开发者个性徽标（点击直达关于作者与设置） */}
        <button
          type="button"
          className="status-item status-dev-badge"
          onClick={onOpenAbout}
          title={`Echoly by Daniel (v${APP_VERSION})${t('status.devClick')}`}
        >
          <span className="status-dev-icon">⚡</span>
          <span className="status-dev-name">Daniel</span>
        </button>
      </div>
    </div>
  );
}
