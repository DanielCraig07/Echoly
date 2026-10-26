import { memo, useState } from 'react';
import type { ThinkingBlock as ThinkingBlockType } from '@deepseek-ide/shared';
import { useI18n } from '../i18n';

interface Props {
  thinking: ThinkingBlockType[];
}

/**
 * `memo` 在这里不是可选的优化：聊天面板在流式输出期间**每一步**都会 `setTabs`，
 * 未改动的消息靠引用相等跳过重建（消息列表更新走不可变替换，没变的那几条
 * 对象引用保持不变）。没有 memo 的话，一屏几十条历史消息的思考块会跟着
 * 每一次 token 增量全部重渲染。
 */
export const ThinkingBlock = memo(function ThinkingBlock({ thinking }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  if (!thinking?.length) return null;

  const totalText = thinking.map((t) => t.thinking).join('\n\n');
  const preview = totalText.substring(0, 150);
  const hasMore = totalText.length > 150;

  return (
    <div className="thinking-container">
      <div className="thinking-header" onClick={() => setExpanded(!expanded)}>
        <span className="thinking-icon">
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
            <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.04z" />
            <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.04z" />
          </svg>
        </span>
        <span className="thinking-title">{t('editor.thinkingTitle')}</span>
        <span className="thinking-badge">{t('editor.stepsCount', { n: thinking.length })}</span>
        {hasMore && (
          <button type="button" className="thinking-toggle">
            {expanded ? t('editor.collapseShort') : t('editor.expandDetails')}
          </button>
        )}
      </div>

      <div className={`thinking-content ${expanded ? 'expanded' : 'collapsed'}`}>
        {expanded ? (
          thinking.map((step, i) => (
            <div key={i} className="thinking-step">
              <div className="thinking-step-header">Step {i + 1}</div>
              <div className="thinking-step-content">{step.thinking}</div>
            </div>
          ))
        ) : (
          <div className="thinking-preview">
            {preview}
            {hasMore && '...'}
          </div>
        )}
      </div>
    </div>
  );
});
