import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { DiffEditor } from '@monaco-editor/react';
import type { GitBranchInfo, GitDiffResult } from '@deepseek-ide/shared';
import {
  useModalResize,
  ModalResizeHandle,
  createSafeOverlayHandlers,
} from '../hooks/useModalResize';
import { useI18n } from '../i18n';

interface Props {
  open: boolean;
  currentBranch?: string | null;
  onClose: () => void;
}

interface ChangedFile {
  status: string;
  path: string;
}

export function BranchDiffModal({ open, currentBranch, onClose }: Props) {
  const { t } = useI18n();
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_branch_diff_modal_size',
    defaultWidth: 840,
    defaultHeight: 580,
    minWidth: 640,
    minHeight: 420,
  });

  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [baseBranch, setBaseBranch] = useState<string>('main');
  const [targetBranch, setTargetBranch] = useState<string>(currentBranch || 'HEAD');
  const [loading, setLoading] = useState<boolean>(false);
  const [ahead, setAhead] = useState<number>(0);
  const [behind, setBehind] = useState<number>(0);
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffData, setDiffData] = useState<GitDiffResult | null>(null);
  const [loadingDiff, setLoadingDiff] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // 初始化加载所有分支
  useEffect(() => {
    if (!open) return;
    void window.ide.gitBranches().then((res) => {
      if (res.ok && res.branches) {
        setBranches(res.branches);
        const cur = res.branches.find((b) => b.current);
        const curName = cur?.name || currentBranch || 'HEAD';
        setTargetBranch(curName);

        // 默认基准分支挑 main 或 master 或 develop
        const hasMain = res.branches.some((b) => b.name === 'main');
        const hasMaster = res.branches.some((b) => b.name === 'master');
        const defaultBase = hasMain
          ? 'main'
          : hasMaster
            ? 'master'
            : res.branches[0]?.name || 'main';
        setBaseBranch(
          defaultBase === curName
            ? res.branches.find((b) => b.name !== curName)?.name || 'main'
            : defaultBase,
        );
      }
    });
  }, [open, currentBranch]);

  // 分支变化时加载差异
  useEffect(() => {
    if (!open || !baseBranch || !targetBranch || baseBranch === targetBranch) {
      setFiles([]);
      setAhead(0);
      setBehind(0);
      setSelectedFile(null);
      setDiffData(null);
      return;
    }

    setLoading(true);
    setError(null);
    setSelectedFile(null);
    setDiffData(null);

    void window.ide.gitCompareBranches(baseBranch, targetBranch).then((res) => {
      setLoading(false);
      if (res.ok) {
        setAhead(res.ahead);
        setBehind(res.behind);
        setFiles(res.files);
        if (res.files.length > 0) {
          setSelectedFile(res.files[0].path);
        }
      } else {
        setError(res.detail || t('git.compareBranchesFailed'));
      }
    });
  }, [open, baseBranch, targetBranch]);

  // 选中文件时加载具体 Diff
  useEffect(() => {
    if (!selectedFile || !baseBranch || !targetBranch) {
      setDiffData(null);
      return;
    }
    setLoadingDiff(true);
    void window.ide.gitDiffBetweenRefs(baseBranch, targetBranch, selectedFile).then((res) => {
      setLoadingDiff(false);
      if (res.ok) {
        setDiffData(res);
      } else {
        setDiffData(null);
      }
    });
  }, [selectedFile, baseBranch, targetBranch]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  const safeOverlay = createSafeOverlayHandlers(onClose);

  const swapBranches = () => {
    const tmp = baseBranch;
    setBaseBranch(targetBranch);
    setTargetBranch(tmp);
  };

  return createPortal(
    <div
      className="settings-overlay"
      {...safeOverlay}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.65)',
        backdropFilter: 'blur(4px)',
        zIndex: 9999,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <div
        className="branch-diff-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: modalSize.width,
          height: modalSize.height,
          maxWidth: '96vw',
          maxHeight: '94vh',
          position: 'relative',
          background: 'var(--bg-modal, #141414)',
          border: '1px solid var(--border, rgba(255, 255, 255, 0.12))',
          borderRadius: 10,
          boxShadow: '0 24px 64px -8px rgba(0, 0, 0, 0.8)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Top Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))',
            background: 'rgba(255, 255, 255, 0.02)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#38bdf8"
              strokeWidth="2"
            >
              <circle cx="18" cy="18" r="3" />
              <circle cx="6" cy="6" r="3" />
              <path d="M13 6h3a2 2 0 0 1 2 2v7" />
              <line x1="6" y1="9" x2="6" y2="21" />
            </svg>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>
              {t('git.branchDiffTitle')}
            </span>
          </div>

          <button
            type="button"
            className="panel-action-btn"
            onClick={onClose}
            title={t('git.closeEsc')}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Branch Select Bar */}
        <div
          style={{
            padding: '10px 14px',
            borderBottom: '1px solid var(--border, rgba(255,255,255,0.06))',
            background: 'rgba(0, 0, 0, 0.25)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--muted, #888)' }}>
              {t('git.baseBranchLabel')}
            </span>
            <select
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              style={{
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                color: '#fff',
                padding: '3px 8px',
                borderRadius: 4,
                fontSize: 12,
                outline: 'none',
              }}
            >
              {branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name} {b.remote ? t('git.remoteSuffix') : ''}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            className="panel-action-btn"
            onClick={swapBranches}
            title={t('git.swapBranchesTip')}
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

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--muted, #888)' }}>
              {t('git.targetBranchLabel')}
            </span>
            <select
              value={targetBranch}
              onChange={(e) => setTargetBranch(e.target.value)}
              style={{
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                color: '#38bdf8',
                padding: '3px 8px',
                borderRadius: 4,
                fontSize: 12,
                outline: 'none',
                fontWeight: 500,
              }}
            >
              {branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name} {b.remote ? t('git.remoteSuffix') : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Ahead & Behind Badges */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 12,
                background: 'rgba(16, 185, 129, 0.15)',
                color: '#34d399',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                fontWeight: 600,
              }}
              title={t('git.aheadTip')}
            >
              {t('git.ahead', { n: ahead })}
            </span>
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 12,
                background: 'rgba(239, 68, 68, 0.15)',
                color: '#f87171',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                fontWeight: 600,
              }}
              title={t('git.behindTip')}
            >
              {t('git.behind', { n: behind })}
            </span>
            <span style={{ fontSize: 11, color: 'var(--muted, #888)' }}>
              {t('git.changedFilesLabel', { n: files.length })}
            </span>
          </div>
        </div>

        {error && (
          <div
            style={{
              padding: '8px 14px',
              background: 'rgba(239, 68, 68, 0.12)',
              color: '#f87171',
              fontSize: 12,
              borderBottom: '1px solid rgba(239, 68, 68, 0.25)',
            }}
          >
            {error}
          </div>
        )}

        {/* Content Area */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* Left File List */}
          <div
            style={{
              width: 260,
              minWidth: 200,
              borderRight: '1px solid var(--border, rgba(255,255,255,0.08))',
              background: 'rgba(0, 0, 0, 0.15)',
              display: 'flex',
              flexDirection: 'column',
              overflowY: 'auto',
            }}
          >
            <div
              style={{
                padding: '6px 10px',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--muted, #888)',
                borderBottom: '1px solid rgba(255,255,255,0.04)',
              }}
            >
              {t('git.changedFilesCount', { n: files.length })}
            </div>
            {loading && (
              <div
                style={{
                  padding: 20,
                  textAlign: 'center',
                  fontSize: 11,
                  color: 'var(--muted, #888)',
                }}
              >
                {t('git.calculatingDiff')}
              </div>
            )}
            {!loading && files.length === 0 && (
              <div
                style={{
                  padding: 24,
                  textAlign: 'center',
                  fontSize: 12,
                  color: 'var(--muted, #888)',
                }}
              >
                {t('git.noBranchChanges')}
              </div>
            )}
            {!loading &&
              files.map((f) => {
                const isSelected = f.path === selectedFile;
                return (
                  <div
                    key={f.path}
                    onClick={() => setSelectedFile(f.path)}
                    style={{
                      padding: '6px 10px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 11.5,
                      cursor: 'pointer',
                      background: isSelected ? 'rgba(56, 189, 248, 0.15)' : 'transparent',
                      color: isSelected ? '#fff' : 'var(--text, #ddd)',
                      borderLeft: isSelected ? '2px solid #38bdf8' : '2px solid transparent',
                    }}
                    title={f.path}
                  >
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '0 4px',
                        borderRadius: 3,
                        color:
                          f.status === 'A' ? '#34d399' : f.status === 'D' ? '#f87171' : '#f59e0b',
                        background: 'rgba(255, 255, 255, 0.08)',
                      }}
                    >
                      {f.status}
                    </span>
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                      }}
                    >
                      {f.path}
                    </span>
                  </div>
                );
              })}
          </div>

          {/* Right Monaco Diff View */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {selectedFile && (
              <div
                style={{
                  padding: '6px 12px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderBottom: '1px solid var(--border, rgba(255,255,255,0.06))',
                  fontSize: 11,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <span style={{ color: 'var(--muted, #888)' }}>
                  {t('git.compareFileLabel')}{' '}
                  <span style={{ color: '#fff', fontFamily: 'monospace' }}>{selectedFile}</span>
                </span>
                <span style={{ color: 'var(--muted, #888)' }}>
                  {t('git.leftLabel')} <span style={{ color: '#aaa' }}>{baseBranch}</span> |{' '}
                  {t('git.rightLabel')} <span style={{ color: '#38bdf8' }}>{targetBranch}</span>
                </span>
              </div>
            )}

            <div style={{ flex: 1, position: 'relative' }}>
              {loadingDiff && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(0,0,0,0.3)',
                    color: 'var(--muted, #888)',
                    fontSize: 12,
                    zIndex: 2,
                  }}
                >
                  {t('git.loadingDiff')}
                </div>
              )}
              {diffData ? (
                <DiffEditor
                  original={diffData.original}
                  modified={diffData.modified}
                  language={
                    selectedFile?.endsWith('.ts') || selectedFile?.endsWith('.tsx')
                      ? 'typescript'
                      : selectedFile?.endsWith('.js')
                        ? 'javascript'
                        : selectedFile?.endsWith('.json')
                          ? 'json'
                          : selectedFile?.endsWith('.css')
                            ? 'css'
                            : selectedFile?.endsWith('.html')
                              ? 'html'
                              : 'plaintext'
                  }
                  theme="vs-dark"
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: 12,
                    renderSideBySide: true,
                  }}
                />
              ) : (
                <div
                  style={{
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--muted, #888)',
                    fontSize: 12,
                  }}
                >
                  {t('git.selectFileHint')}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Resize Handle */}
        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>,
    document.body,
  );
}
