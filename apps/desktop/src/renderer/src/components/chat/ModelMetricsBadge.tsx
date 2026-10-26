import React, { useState, useRef, useLayoutEffect, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ChatMessageMetrics } from '@deepseek-ide/shared';
import { useI18n, type Translate } from '../../i18n';

export interface ModelMetricsBadgeProps {
  metrics: ChatMessageMetrics;
}

/**
 * 结束原因的展示文案。`reason` 本身是 OpenAI 协议里的枚举值（stop/tool_calls/…），
 * 不能翻也不能改；只有包在它外面的那句解释才进字典。
 */
function formatFinishReason(t: Translate, reason?: string): string {
  switch (reason) {
    case 'stop':
      return t('chat.finishStop');
    case 'tool_calls':
      return t('chat.finishToolCalls');
    case 'length':
      return t('chat.finishLength');
    case 'content_filter':
      return t('chat.finishContentFilter');
    default:
      // 未知/缺失原因原样显示：后端加了新枚举值时，露出原始值好过编一句错话
      return reason || t('chat.finishStop');
  }
}

export const ModelMetricsBadge: React.FC<ModelMetricsBadgeProps> = ({ metrics }) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const badgeRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // Calculate popover coordinates when opening
  useLayoutEffect(() => {
    if (!isOpen || !badgeRef.current) return;

    const badgeRect = badgeRef.current.getBoundingClientRect();
    const margin = 12;
    const viewWidth = window.innerWidth;
    const viewHeight = window.innerHeight;

    const popoverWidth = 360;
    const popoverHeight = 380; // Estimated height

    let left = badgeRect.left;
    if (left + popoverWidth > viewWidth - margin) {
      left = Math.max(margin, viewWidth - popoverWidth - margin);
    }
    if (left < margin) {
      left = margin;
    }

    // Default pop up ABOVE the footer badge
    let top = badgeRect.top - popoverHeight - 8;
    if (top < margin) {
      // If not enough room above, pop down
      top = badgeRect.bottom + 8;
      if (top + popoverHeight > viewHeight - margin) {
        top = Math.max(margin, viewHeight - popoverHeight - margin);
      }
    }

    setCoords({ top, left });
  }, [isOpen]);

  // Close on Escape or click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        badgeRef.current &&
        !badgeRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [isOpen]);

  const handleCopyJson = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(JSON.stringify(metrics, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const durationMs = metrics.durationMs ?? 0;
  const tpsVal = metrics.tokensPerSecond ?? 0;
  const durationSec = (durationMs / 1000).toFixed(1);
  const tps = tpsVal > 0 ? tpsVal.toFixed(1) : '0';
  const totalTokens = metrics.totalTokens ?? ((metrics.promptTokens || 0) + (metrics.completionTokens || 0));
  const promptTokens = metrics.promptTokens || 0;
  const completionTokens = metrics.completionTokens || 0;

  // Calculate ratio for progress bar
  const totalForBar = Math.max(1, promptTokens + completionTokens);
  const promptPct = Math.round((promptTokens / totalForBar) * 100);
  const completionPct = 100 - promptPct;

  const modelShortName = metrics.model ? metrics.model.split('/').pop() : 'AI Model';

  const popoverContent = isOpen && (
    <div
      ref={popoverRef}
      className="model-metrics-popover"
      style={{
        position: 'fixed',
        top: coords.top,
        left: coords.left,
        zIndex: 9999,
      }}
    >
      <div className="model-metrics-header">
        <div className="model-metrics-title-wrap">
          <svg
            className="model-metrics-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
          <span className="model-metrics-title">{t('chat.metricsTitle')}</span>
        </div>
        <div className="model-metrics-header-right">
          <span className="model-metrics-model-badge" title={metrics.model || ''}>
            {modelShortName}
          </span>
          <button
            type="button"
            className="model-metrics-close-btn"
            title={t('editor.closeEsc')}
            onClick={() => setIsOpen(false)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      <div className="model-metrics-grid">
        <div className="model-metrics-card">
          <div className="model-metrics-card-label">{t('chat.tpsLabel')}</div>
          <div className="model-metrics-card-value highlight-speed">
            {tps} <span className="unit">t/s</span>
          </div>
          <div className="model-metrics-card-sub">
            {tpsVal >= 40 ? t('chat.tpsFast') : tpsVal >= 20 ? t('chat.tpsSmooth') : t('chat.tpsSteady')}
          </div>
        </div>

        <div className="model-metrics-card">
          <div className="model-metrics-card-label">{t('chat.ttftLabel')}</div>
          <div className="model-metrics-card-value">
            {metrics.ttftMs != null ? metrics.ttftMs : '--'} <span className="unit">ms</span>
          </div>
          <div className="model-metrics-card-sub">
            {metrics.ttftMs != null
              ? metrics.ttftMs < 600
                ? t('chat.ttftFast')
                : t('chat.ttftOverhead')
              : t('chat.ttftDefault')}
          </div>
        </div>

        <div className="model-metrics-card">
          <div className="model-metrics-card-label">{t('chat.totalDuration')}</div>
          <div className="model-metrics-card-value">
            {(durationMs / 1000).toFixed(2)} <span className="unit">s</span>
          </div>
          <div className="model-metrics-card-sub">
            {tpsVal > 0 ? `${(1000 / tpsVal).toFixed(1)} ms/t` : t('chat.totalRuntime')}
          </div>
        </div>

        <div className="model-metrics-card">
          <div className="model-metrics-card-label">{t('chat.totalTokens')}</div>
          <div className="model-metrics-card-value">
            {totalTokens.toLocaleString()} <span className="unit">tks</span>
          </div>
          <div className="model-metrics-card-sub">
            ↑{promptTokens.toLocaleString()} · ↓{completionTokens.toLocaleString()}
          </div>
        </div>
      </div>

      {totalForBar > 0 && (
        <div className="model-metrics-ratio-section">
          <div className="model-metrics-ratio-bar">
            <div
              className="model-metrics-bar-prompt"
              style={{ width: `${promptPct}%` }}
              title={`Prompt Token: ${promptTokens} (${promptPct}%)`}
            />
            <div
              className="model-metrics-bar-completion"
              style={{ width: `${completionPct}%` }}
              title={`Completion Token: ${completionTokens} (${completionPct}%)`}
            />
          </div>
          <div className="model-metrics-ratio-legend">
            <span className="legend-item prompt">
              <span className="legend-dot prompt-dot" /> {t('chat.legendPrompt', { pct: promptPct })}
            </span>
            <span className="legend-item completion">
              <span className="legend-dot completion-dot" />{' '}
              {t('chat.legendCompletion', { pct: completionPct })}
            </span>
          </div>
        </div>
      )}

      <div className="model-metrics-details-list">
        <div className="model-metrics-row">
          <span className="row-key">{t('chat.finishReason')}</span>
          <span className="row-val">{formatFinishReason(t, metrics.finishReason)}</span>
        </div>
        {metrics.toolCallsCount !== undefined && metrics.toolCallsCount > 0 && (
          <div className="model-metrics-row">
            <span className="row-key">{t('chat.toolInteraction')}</span>
            <span className="row-val">{t('chat.toolRounds', { n: metrics.toolCallsCount })}</span>
          </div>
        )}
        {metrics.model && (
          <div className="model-metrics-row">
            <span className="row-key">{t('chat.fullModel')}</span>
            <span className="row-val code-val" title={metrics.model}>
              {metrics.model}
            </span>
          </div>
        )}
      </div>

      <div className="model-metrics-footer">
        <button
          type="button"
          className="model-metrics-copy-btn"
          onClick={handleCopyJson}
          title={t('chat.copyMetricsJson')}
        >
          {copied ? (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>{t('chat.copiedJson')}</span>
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <span>{t('chat.copyMetrics')}</span>
            </>
          )}
        </button>
      </div>
    </div>
  );

  return (
    <>
      <button
        ref={badgeRef}
        type="button"
        className={`msg-metrics-badge ${isOpen ? 'active' : ''}`}
        title={t('chat.metricsOpenTip')}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span className="metrics-pill-icon">⚡</span>
        <span className="metrics-pill-tps">{tps} t/s</span>
        <span className="metrics-pill-sep">·</span>
        <span className="metrics-pill-time">{durationSec}s</span>
        {totalTokens > 0 && (
          <>
            <span className="metrics-pill-sep">·</span>
            <span className="metrics-pill-tokens">
              {totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens}
            </span>
          </>
        )}
        <svg
          className={`metrics-pill-chevron ${isOpen ? 'rotate' : ''}`}
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {isOpen && createPortal(popoverContent, document.body)}
    </>
  );
};
