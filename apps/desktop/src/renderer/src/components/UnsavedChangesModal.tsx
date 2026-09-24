import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OpenTab } from '@deepseek-ide/shared';
import { isUntitledPath, untitledTabLabel } from '../utils';
import { useModalResize, ModalResizeHandle, createSafeOverlayHandlers } from '../hooks/useModalResize';

export interface UnsavedChangesModalProps {
  open: boolean;
  tab: OpenTab | null;
  onSave: () => void | Promise<void>;
  onDontSave: () => void;
  onCancel: () => void;
}

export function UnsavedChangesModal({
  open,
  tab,
  onSave,
  onDontSave,
  onCancel,
}: UnsavedChangesModalProps) {
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_unsaved_changes_modal_size',
    defaultWidth: 460,
    defaultHeight: 230,
    minWidth: 380,
    minHeight: 190,
  });

  const [saving, setSaving] = useState(false);
  const saveBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      setSaving(false);
      // 弹窗打开时默认聚焦到“保存”按钮，方便直接按 Enter 保存并退出
      const timer = setTimeout(() => {
        saveBtnRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [open, tab]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key === 'Enter' && !saving) {
        // 如果焦点在其他按钮上，让按钮自身的点击事件处理；否则默认触发保存
        const activeEl = document.activeElement;
        if (activeEl?.tagName === 'BUTTON' && activeEl !== saveBtnRef.current) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        void handleSave();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open, saving, onCancel]);

  if (!open || !tab || typeof document === 'undefined') return null;

  const isUntitled = isUntitledPath(tab.path);
  const fileName = isUntitled
    ? `未命名 ${untitledTabLabel(tab.path)}`
    : tab.path.split(/[/\\]/).filter(Boolean).pop() || tab.path;
  const filePath = isUntitled ? '未保存的新建文件' : tab.path;

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave();
    } finally {
      setSaving(false);
    }
  };

  const safeOverlay = createSafeOverlayHandlers(saving ? undefined : onCancel);

  return createPortal(
    <div className="settings-overlay unsaved-changes-modal-overlay" {...safeOverlay}>
      <div
        className="settings-modal unsaved-changes-dialog"
        style={{
          width: modalSize.width,
          height: modalSize.height,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '20px 22px 18px',
          boxSizing: 'border-box',
          borderRadius: 12,
          boxShadow: '0 24px 64px -8px rgba(0, 0, 0, 0.8), 0 4px 16px rgba(0, 0, 0, 0.4)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
          {/* Header & Icon */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, minWidth: 0 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: 'rgba(245, 158, 11, 0.14)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  marginTop: 2,
                }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>

              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: 'var(--text, #ffffff)',
                    lineHeight: '22px',
                    wordBreak: 'break-word',
                  }}
                >
                  是否保存对 “{fileName}” 的更改？
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--text-secondary, #999999)',
                    marginTop: 4,
                    lineHeight: '18px',
                  }}
                >
                  如果不保存，您在此文件中所做的更改将会丢失。
                </div>
              </div>
            </div>

            <button
              type="button"
              className="panel-action-btn"
              title="取消关闭 (Esc)"
              onClick={onCancel}
              disabled={saving}
              style={{ flexShrink: 0 }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Path Preview Tag */}
          <div
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              background: 'rgba(0, 0, 0, 0.25)',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11.5,
              color: 'var(--text-secondary, #888888)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={filePath}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
              <polyline points="13 2 13 9 20 9" />
            </svg>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', direction: 'rtl', textAlign: 'left' }}>
              {filePath}
            </span>
          </div>
        </div>

        {/* Action Buttons */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 8,
            paddingTop: 12,
            borderTop: '1px solid var(--border)',
            marginTop: 10,
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            style={{
              padding: '6px 14px',
              fontSize: 12.5,
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'var(--bg-secondary, rgba(255, 255, 255, 0.06))',
              color: 'var(--text, #ffffff)',
              cursor: saving ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s ease',
            }}
            title="取消关闭，继续编辑 (Esc)"
          >
            取消
          </button>

          <button
            type="button"
            onClick={onDontSave}
            disabled={saving}
            style={{
              padding: '6px 14px',
              fontSize: 12.5,
              borderRadius: 6,
              border: '1px solid rgba(239, 68, 68, 0.35)',
              background: 'rgba(239, 68, 68, 0.12)',
              color: '#ef4444',
              cursor: saving ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s ease',
            }}
            title="不保存，直接关闭并放弃修改"
          >
            不保存
          </button>

          <button
            ref={saveBtnRef}
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            style={{
              padding: '6px 18px',
              fontSize: 12.5,
              fontWeight: 500,
              borderRadius: 6,
              border: 'none',
              background: '#0ea5e9',
              color: '#ffffff',
              cursor: saving ? 'not-allowed' : 'pointer',
              boxShadow: '0 2px 8px rgba(14, 165, 233, 0.3)',
              transition: 'all 0.15s ease',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
            title="保存文件修改并关闭 (Enter)"
          >
            {saving ? (
              <>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  style={{ animation: 'spin 1s linear infinite' }}
                >
                  <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="12" />
                </svg>
                <span>保存中...</span>
              </>
            ) : (
              '保存'
            )}
          </button>
        </div>

        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>,
    document.body,
  );
}
