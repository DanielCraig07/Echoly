import React, { useEffect, useState } from 'react';
import { useModalResize, ModalResizeHandle, createSafeOverlayHandlers } from '../hooks/useModalResize';
import { MarkdownMessage } from './MarkdownMessage';
import { isTypingConfirmed, type DbConfirmTone } from '../services/dbConfirmContent';

/** 文本输入模式：在弹窗里顺带收集一个字符串（新建库名、重命名、筛选值…） */
export interface DbConfirmInput {
  /** 输入框上方的说明 */
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  /** 返回中文错误信息则禁止确认；返回 null 表示合法 */
  validate?: (value: string) => string | null;
}

/** 正文里一行「标签 → 值」（正在删的是哪个文件 / 哪个会话 / 哪条配置） */
export interface DbConfirmDetail {
  label: string;
  value: string;
}

export interface DbConfirmModalProps {
  isOpen: boolean;
  /** 弹窗标题（写清楚这是哪个库 / 表上的操作） */
  title: string;
  /** Markdown 正文；SQL 以 ```sql 代码块给出，每条都自带复制按钮 */
  content: string;
  /**
   * 待删除对象的身份信息，渲染成正文下方的键值行。
   *
   * 删除确认里最容易出的事故是「删错了对象」—— 用户对着一排长得差不多的条目点了垃圾桶，
   * 弹窗只写一句「确认删除？」等于没提示。把名字与路径原样列出来，他才有机会发现自己点错了。
   */
  details?: DbConfirmDetail[];
  tone?: DbConfirmTone;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 给出名称时要求用户原样输入才能确认（删除库 / 表这类不可恢复的操作） */
  requireTyping?: string;
  input?: DbConfirmInput;
  /** 确认时回传输入框里的值（没有 input 时是空串） */
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

/**
 * 数据库写操作的确认弹窗。
 *
 * 取代 `window.confirm` —— 系统弹窗在 Electron 里既不是应用主题色，也把 SQL 当成
 * 一整段纯文本塞进去：用户只能对着它干瞪眼，想核对或单拿一条去控制台执行都做不到。
 * 这里用 Markdown 渲染，语句各自成块、各自可复制。
 *
 * 三种用法合一（纯确认 / 收集一个字符串 / 手输名称确认）是刻意的：这三种在数据库面板里
 * 密集出现，如果各写一个组件，主题与布局就会各自漂移。
 */
export function DbConfirmModal({
  isOpen,
  title,
  content,
  details,
  tone = 'normal',
  confirmLabel = '确认执行',
  cancelLabel = '取消',
  requireTyping,
  input,
  onConfirm,
  onCancel,
}: DbConfirmModalProps) {
  const [typed, setTyped] = useState('');

  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly:db_confirm_modal_size',
    defaultWidth: 640,
    defaultHeight: 480,
    minWidth: 460,
    minHeight: 260,
  });
  const overlayHandlers = createSafeOverlayHandlers(onCancel);

  // 每次打开都重置输入：上一条语句的名称绝不能替用户凑出「确认」
  useEffect(() => {
    if (isOpen) setTyped(input?.defaultValue ?? '');
    // defaultValue 只在「打开」这一刻有意义；后续外部改动不该覆盖用户正在敲的内容
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const inputError = input?.validate ? input.validate(typed) : null;
  const typingOk = requireTyping === undefined || isTypingConfirmed(requireTyping, typed);
  const canConfirm = typingOk && !inputError && (!input || typed.trim().length > 0);
  const danger = tone === 'danger';

  const submit = () => {
    if (!canConfirm) return;
    onConfirm(typed);
  };

  return (
    <div
      className="modal-overlay"
      {...overlayHandlers}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.65)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 12000,
      }}
    >
      <div
        className="modal-container db-confirm-modal"
        style={{
          width: modalSize.width,
          height: modalSize.height,
          position: 'relative',
          background: 'var(--bg-panel, #1e1e1e)',
          border: `1px solid ${danger ? 'rgba(239, 68, 68, 0.45)' : 'var(--border)'}`,
          borderRadius: 10,
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.5)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏：对齐 Maven 二级栏规范 */}
        <div
          style={{
            height: 30,
            padding: '0 10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid var(--border)',
            background: 'rgba(255, 255, 255, 0.02)',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: danger ? '#f87171' : 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </span>
          <button
            type="button"
            className="panel-action-btn"
            onClick={onCancel}
            title="关闭 (Esc)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* 正文：Markdown（每条 SQL 一个代码块，各自可复制） */}
        <div className="db-confirm-body">
          <MarkdownMessage content={content} />
          {details && details.length > 0 && (
            <div className="confirm-details">
              {details.map((d) => (
                <div className="confirm-detail-row" key={`${d.label}:${d.value}`}>
                  <span className="confirm-detail-label">{d.label}</span>
                  <span className="confirm-detail-value" title={d.value}>
                    {d.value}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 输入区：普通输入 或 手输名称确认 */}
        {(input || requireTyping !== undefined) && (
          <div className="db-confirm-typing">
            <div className="db-confirm-typing-hint">
              {input?.label ??
                `此操作不可恢复。请原样输入 ${requireTyping} 以确认：`}
            </div>
            <input
              type="text"
              className="db-confirm-typing-input"
              value={typed}
              autoFocus
              spellCheck={false}
              placeholder={input?.placeholder ?? requireTyping ?? ''}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            {inputError && <div className="db-confirm-typing-error">{inputError}</div>}
          </div>
        )}

        {/* 操作区 */}
        <div
          style={{
            padding: '10px 14px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 8,
            flexShrink: 0,
            background: 'rgba(255, 255, 255, 0.015)',
          }}
        >
          <button type="button" className="panel-action-btn db-confirm-btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`panel-action-btn db-confirm-btn primary${danger ? ' danger' : ''}`}
            onClick={submit}
            disabled={!canConfirm}
            title={!canConfirm ? '请先完成上方输入' : confirmLabel}
          >
            {confirmLabel}
          </button>
        </div>

        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>
  );
}
