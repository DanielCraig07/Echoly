import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { parseContentWithCodeRefs, FileLanguageIcon, type ParsedCodeRef } from './CodeRefPill';

/**
 * 将完整 input 字符串拆分为「引用列表」和「纯文本」两部分。
 * 引用 token 形如 @file:Lxx-Lxx / @[file:Lxx-Lxx]，从字符串头部连续提取。
 *
 * 为何从头部提取：insertPath 始终追加到末尾；用户发送前 refs 在前，正文在后。
 * 这样 textarea 只呈现纯文本，Pills 显示在上方独立行，无需对齐。
 */
export function splitInputValue(raw: string): { refs: Array<{ raw: string; ref: ParsedCodeRef }>; plainText: string } {
  const segments = parseContentWithCodeRefs(raw);
  const refs: Array<{ raw: string; ref: ParsedCodeRef }> = [];
  const textParts: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type === 'ref' && seg.ref) {
      refs.push({ raw: seg.value, ref: seg.ref });
    } else {
      // 如果此文本片段仅由空白组成，且后面紧跟着另一个引用，说明只是引用之间的分隔符，不应计入 plainText
      const isWhitespace = !seg.value.trim();
      const hasSubsequentRef = segments.slice(i + 1).some((s) => s.type === 'ref');
      if (isWhitespace && hasSubsequentRef) {
        continue;
      }
      textParts.push(seg.value);
    }
  }

  let plainText = textParts.join('');
  if (refs.length > 0) {
    if (!plainText.trim()) {
      plainText = '';
    } else {
      // 去除与 refs 相邻的前导空白
      plainText = plainText.replace(/^\s+/, '');
    }
  }
  return { refs, plainText };
}

/** 从 refs 和 plainText 重新组合为完整 input 字符串 */
export function buildValue(refs: Array<{ raw: string; ref: ParsedCodeRef }>, plainText: string): string {
  const refPart = refs.map((r) => r.raw).join(' ');
  if (!refPart) return plainText;
  if (!plainText) return refPart + ' ';
  return refPart + ' ' + plainText;
}

// ─── 单个引用胶囊（带 ×  删除按钮） ───────────────────────────────────────

function RefPillChip({
  codeRef,
  onRemove,
  onOpenFile,
}: {
  codeRef: ParsedCodeRef;
  onRemove: () => void;
  onOpenFile?: (path: string, line?: number, endLine?: number) => void;
}) {
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onOpenFile) {
      onOpenFile(codeRef.path, codeRef.startLine, codeRef.endLine);
    } else {
      window.dispatchEvent(
        new CustomEvent('echoly:openFile', {
          detail: { path: codeRef.path, line: codeRef.startLine, endLine: codeRef.endLine },
        }),
      );
    }
  };

  return (
    <span className="chat-ref-chip" onClick={handleClick} title={`点击打开：${codeRef.path}${codeRef.lineLabel || ''}`}>
      <span className="chat-ref-chip-icon">
        <FileLanguageIcon fileName={codeRef.fileName} />
      </span>
      <span className="chat-ref-chip-name">{codeRef.fileName}</span>
      {codeRef.lineLabel && (
        <span className="chat-ref-chip-line">{codeRef.lineLabel}</span>
      )}
      <button
        type="button"
        className="chat-ref-chip-remove"
        title="移除引用"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRemove();
        }}
      >
        ×
      </button>
    </span>
  );
}

// ─── 主组件 ──────────────────────────────────────────────────────────────────

export interface InputCodeRefOverlayHandle {
  focus: () => void;
  setSelectionRange: (start: number, end: number) => void;
  /** 判断节点是否位于输入区（含引用胶囊行）内，用于点击外部关闭 @ 弹窗 */
  contains: (node: Node) => boolean;
  readonly value: string;
}

interface InputCodeRefOverlayProps {
  value: string;
  onChange: (val: string) => void;
  onOpenFile?: (path: string, line?: number, endLine?: number) => void;
  style?: React.CSSProperties;
  className?: string;
  placeholder?: string;
  onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
  onCompositionStart?: React.CompositionEventHandler<HTMLTextAreaElement>;
  onCompositionEnd?: React.CompositionEventHandler<HTMLTextAreaElement>;
  onPaste?: React.ClipboardEventHandler<HTMLTextAreaElement>;
}

export const InputCodeRefOverlay = forwardRef<InputCodeRefOverlayHandle, InputCodeRefOverlayProps>(
  (
    {
      value,
      onChange,
      onOpenFile,
      style,
      className,
      placeholder,
      onKeyDown,
      onCompositionStart,
      onCompositionEnd,
      onPaste,
    },
    ref,
  ) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // 拆分外部 value 为 refs + plainText
    const { refs, plainText } = splitInputValue(value);

    // ── 暴露 handle ───────────────────────────────────────────────────────────
    useImperativeHandle(ref, () => ({
      focus() {
        textareaRef.current?.focus();
      },
      setSelectionRange(start: number, end: number) {
        // start/end 相对于完整 value；映射到 plainText 坐标
        const refLen = refs.length > 0 ? refs.map((r) => r.raw).join(' ').length + 1 : 0;
        const mappedStart = Math.max(0, start - refLen);
        const mappedEnd = Math.max(0, end - refLen);
        textareaRef.current?.setSelectionRange(
          Math.min(mappedStart, plainText.length),
          Math.min(mappedEnd, plainText.length),
        );
      },
      contains(node: Node) {
        return containerRef.current?.contains(node) ?? false;
      },
      get value() {
        return value;
      },
    }));

    // ── 移除某个引用 ──────────────────────────────────────────────────────────
    const handleRemoveRef = useCallback(
      (idx: number) => {
        const nextRefs = refs.filter((_, i) => i !== idx);
        onChange(buildValue(nextRefs, plainText));
        textareaRef.current?.focus();
      },
      [refs, plainText, onChange],
    );

    // ── textarea onChange：更新 plainText，保留 refs ─────────────────────────
    const handleTextareaChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newPlain = e.target.value;
        onChange(buildValue(refs, newPlain));
      },
      [refs, onChange],
    );

    // ── 拦截 onChange 中的 @ mention 检测，透传给父级 onKeyDown ────────────────
    // mention 检测现在基于 plainText，在父级 onChange 中处理（父级会看到完整 value）

    const hasRefs = refs.length > 0;

    return (
      <div className="chat-input-ref-overlay-container" ref={containerRef}>
        {/* Pills 行（仅在有引用时渲染） */}
        {hasRefs && (
          <div className="chat-ref-chips-row">
            {refs.map((item, idx) => (
              <RefPillChip
                key={`${item.raw}-${idx}`}
                codeRef={item.ref}
                onRemove={() => handleRemoveRef(idx)}
                onOpenFile={onOpenFile}
              />
            ))}
          </div>
        )}

        {/* 真实 textarea：只显示纯文本，光标完全正常 */}
        <textarea
          ref={textareaRef}
          className={className}
          value={plainText}
          style={style}
          placeholder={placeholder}
          onChange={handleTextareaChange}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !plainText && refs.length > 0) {
              e.preventDefault();
              handleRemoveRef(refs.length - 1);
              return;
            }
            onKeyDown?.(e);
          }}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          onPaste={onPaste}
        />
      </div>
    );
  },
);

InputCodeRefOverlay.displayName = 'InputCodeRefOverlay';
