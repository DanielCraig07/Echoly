import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GitCommitEntry, GitCommitStats } from '@deepseek-ide/shared';

export interface GitCommitPreviewCardProps {
  commit: GitCommitEntry;
  stats?: GitCommitStats;
  loadingStats?: boolean;
  targetRect: DOMRect | { top: number; bottom: number; left: number; right: number };
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onSelectCommit?: (hash: string) => void;
  onCopyHash?: (hash: string) => void;
}

/**
 * 格式化提交信息正文，自动将 http:// 与 https:// 链接识别为带下划线的高亮可点击链接
 */
function renderMessageWithLinks(text: string) {
  if (!text) return null;
  const urlRegex = /(https?:\/\/[^\s\u4e00-\u9fa5]+)/g;
  const parts = text.split(urlRegex);

  return parts.map((part, i) => {
    if (part.match(urlRegex)) {
      return (
        <span
          key={i}
          style={{
            color: 'var(--accent, #4c8dff)',
            textDecoration: 'underline',
            textUnderlineOffset: '2px',
            wordBreak: 'break-all',
            cursor: 'pointer',
          }}
          title={part}
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard.writeText(part);
          }}
        >
          {part}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export const GitCommitPreviewCard: React.FC<GitCommitPreviewCardProps> = ({
  commit,
  stats,
  loadingStats = false,
  targetRect,
  onMouseEnter,
  onMouseLeave,
  onSelectCommit,
  onCopyHash,
}) => {
  const [copied, setCopied] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number }>({
    top: targetRect.top,
    left: targetRect.right + 10,
  });

  // 动态测量并智能调整位置，确保在视口边缘不被遮挡
  useLayoutEffect(() => {
    const cardEl = cardRef.current;
    if (!cardEl) return;

    const cardRect = cardEl.getBoundingClientRect();
    const margin = 12;
    const viewWidth = window.innerWidth;
    const viewHeight = window.innerHeight;

    let left = targetRect.right + 10;
    // 如果向右弹出超出视口，尝试向左弹出
    if (left + cardRect.width > viewWidth - margin) {
      const leftCandidate = targetRect.left - cardRect.width - 10;
      if (leftCandidate >= margin) {
        left = leftCandidate;
      } else {
        left = Math.max(margin, viewWidth - cardRect.width - margin);
      }
    }

    let top = targetRect.top - 6;
    // 保证下方不超出视口
    if (top + cardRect.height > viewHeight - margin) {
      top = Math.max(margin, viewHeight - cardRect.height - margin);
    }
    if (top < margin) {
      top = margin;
    }

    setCoords({ top, left });
  }, [targetRect, stats, loadingStats, commit.message, commit.body]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const hashToCopy = commit.hash;
    void navigator.clipboard.writeText(hashToCopy);
    setCopied(true);
    onCopyHash?.(hashToCopy);
    setTimeout(() => setCopied(false), 2000);
  };

  const messageBody = (commit.body || commit.message || '').trim();
  const shortHash = commit.shortHash || commit.hash.slice(0, 7);

  // 显示的日期信息
  const relativeDate = commit.relativeDate || '不久前';
  const fullDate = commit.fullDate || commit.date || '';

  const cardContent = (
    <div
      ref={cardRef}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="git-commit-preview-card"
      style={{
        position: 'fixed',
        top: coords.top,
        left: coords.left,
        zIndex: 99999,
        background: 'var(--bg-modal, #1e1e1e)',
        backdropFilter: 'blur(10px)',
        border: '1px solid var(--border, rgba(255, 255, 255, 0.1))',
        borderRadius: 8,
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.45), 0 2px 8px rgba(0, 0, 0, 0.25)',
        padding: '12px 14px',
        color: 'var(--text, #cccccc)',
        fontSize: 12,
        fontFamily:
          'var(--font-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif)',
        maxWidth: 480,
        minWidth: 320,
        boxSizing: 'border-box',
        pointerEvents: 'auto',
        userSelect: 'text',
        animation: 'gitPreviewFadeIn 0.15s cubic-bezier(0.16, 1, 0.3, 1) forwards',
      }}
    >
      {/* 1. Header: 👤 作者, 🕒 相对时间 (完整时间) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 4,
          fontSize: 12,
          lineHeight: '18px',
          paddingBottom: 8,
        }}
      >
        {/* 用户图标 */}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            color: 'var(--muted, #888888)',
            marginRight: 2,
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </span>

        {/* 作者名 (系统主强调色) */}
        <span
          style={{
            color: 'var(--accent, #4c8dff)',
            fontWeight: 600,
            letterSpacing: '0.2px',
          }}
        >
          {commit.author}
        </span>
        <span style={{ color: 'var(--muted, #888888)' }}>,</span>

        {/* 时钟图标 */}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            color: 'var(--muted, #888888)',
            marginLeft: 2,
            marginRight: 2,
          }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </span>

        {/* 相对时间与完整时间 */}
        <span style={{ color: 'var(--text, #cccccc)' }}>{relativeDate}</span>
        {fullDate && (
          <span style={{ color: 'var(--muted, #888888)', fontSize: 11.5 }}>({fullDate})</span>
        )}
      </div>

      {/* 2. Commit Message Body: 完整的多行提交说明，支持链接识别 */}
      <div
        style={{
          margin: '2px 0 10px 0',
          fontSize: 12.5,
          lineHeight: '1.55',
          color: 'var(--text, #cccccc)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 220,
          overflowY: 'auto',
        }}
      >
        {renderMessageWithLinks(messageBody)}
      </div>

      {/* 3. 统计信息: 已更改 X 个文件, Y 行插入(+), Z 行删除(-) */}
      <div
        style={{
          margin: '8px 0 10px 0',
          fontSize: 12,
          lineHeight: '18px',
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 4,
        }}
      >
        {loadingStats ? (
          <span style={{ color: 'var(--muted, #888888)', fontSize: 11.5, opacity: 0.85 }}>
            正在加载文件变更统计...
          </span>
        ) : stats ? (
          <>
            <span style={{ color: 'var(--muted, #888888)' }}>
              已更改 {stats.filesChanged} 个文件
              {stats.insertions > 0 || stats.deletions > 0 ? ',' : ''}
            </span>
            {stats.insertions > 0 && (
              <span style={{ color: '#4caf50', fontWeight: 500 }}>
                {stats.insertions} 行插入(+)
              </span>
            )}
            {stats.insertions > 0 && stats.deletions > 0 && (
              <span style={{ color: 'var(--muted, #888888)' }}>,</span>
            )}
            {stats.deletions > 0 && (
              <span style={{ color: '#f44336', fontWeight: 500 }}>{stats.deletions} 行删除(-)</span>
            )}
            {stats.insertions === 0 && stats.deletions === 0 && stats.filesChanged === 0 && (
              <span style={{ color: 'var(--muted, #888888)' }}>无内容行增减</span>
            )}
          </>
        ) : (
          <span style={{ color: 'var(--muted, #888888)', fontSize: 11.5 }}>
            {commit.parents && commit.parents.length > 1 ? '合并分支提交' : '单次提交'}
          </span>
        )}
      </div>

      {/* 4. 底部栏: ☌ bf15e77 [📋] | 快捷操作 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          paddingTop: 8,
          borderTop: '1px solid var(--border, rgba(255, 255, 255, 0.08))',
        }}
      >
        {/* Commit / Branch 节点图标与短哈希 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            color: 'var(--accent, #4c8dff)',
          }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="currentColor"
            style={{ display: 'inline-block' }}
          >
            <path d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5h-3.32zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0z" />
          </svg>
          <span
            style={{
              fontFamily: 'var(--font-mono, monospace)',
              fontWeight: 500,
              letterSpacing: '0.3px',
            }}
          >
            {shortHash}
          </span>
        </div>

        {/* 复制提交哈希按钮 */}
        <button
          type="button"
          onClick={handleCopy}
          title={copied ? '已复制完整哈希' : '复制提交哈希'}
          className={`panel-action-btn ${copied ? 'active' : ''}`}
          style={{
            height: 20,
            padding: '2px 5px',
            gap: 3,
            fontSize: 11,
          }}
        >
          {copied ? (
            <>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>已复制</span>
            </>
          ) : (
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>

        {/* 竖线分隔符 */}
        <span style={{ color: 'var(--border, rgba(255, 255, 255, 0.15))' }}>|</span>

        {/* 展开/查看提交变更按钮 */}
        {onSelectCommit && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelectCommit(commit.hash);
            }}
            className="panel-text-btn"
            style={{
              height: 20,
              padding: '2px 6px',
              color: 'var(--muted, #888888)',
            }}
          >
            查看文件变更
          </button>
        )}
      </div>
    </div>
  );

  return createPortal(cardContent, document.body);
};
