import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface PanelSelectOption<T extends string> {
  value: T;
  /** 关闭态与菜单项共用的显示文本 */
  label: string;
}

export interface PanelSelectProps<T extends string> {
  value: T;
  options: ReadonlyArray<PanelSelectOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  title?: string;
  /** 关闭态按钮上的额外类名（例如让它在弹窗里占满一行） */
  className?: string;
  /**
   * 打开时把控制权交给调用方。
   *
   * 给「一个控件里要连着选两样东西」的场景用（SQL 控制台的连接 + 库）：
   * 选完连接得接着选库，让本控件自己关掉再重开，用户看到的是菜单闪一下。
   */
  onOpenChange?: (open: boolean) => void;
  /** 受控开关；不传则内部自管 */
  open?: boolean;
}

/**
 * 应用主题色的下拉选择控件，用来替代原生 `<select>`。
 *
 * 为什么不直接用原生控件：macOS 上 Chromium 的 `<select>` 弹出层走的是系统 NSMenu，
 * **不受 CSS `color-scheme` 影响** —— 暗色主题里会弹出一个浅灰的系统菜单，
 * 与本项目其余浮层的配色完全对不上（筛选运算符下拉就是这个症状）。
 *
 * 弹出层用 `position: fixed` + 实测视口坐标定位，而不是相对按钮绝对定位：
 * 表结构弹窗的列编辑器在 `overflow: auto` 容器里，绝对定位的下拉会被裁掉，
 * 越靠近容器底部的列越点不到选项。
 */
export function PanelSelect<T extends string>({
  value,
  options,
  onChange,
  disabled,
  title,
  className,
  onOpenChange,
  open: openProp,
}: PanelSelectProps<T>) {
  const [selfOpen, setSelfOpen] = useState<boolean>(false);
  const open = openProp ?? selfOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setSelfOpen(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );
  const [menuPos, setMenuPos] = useState<{ left: number; top: number; width: number } | null>(null);
  /** 包住按钮与菜单：判断「点到外面」时两者都算内部，否则点按钮关不掉（mousedown 先关、click 又开） */
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // 贴边翻转：先按按钮下方摆，放不下就翻到上方；右侧同理
  useLayoutEffect(() => {
    if (!open) return;
    const btn = btnRef.current;
    const menu = menuRef.current;
    if (!btn || !menu) return;
    const b = btn.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    let left = b.left;
    let top = b.bottom + 2;
    if (left + m.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - m.width - 8);
    if (top + m.height > window.innerHeight - 8) top = Math.max(8, b.top - m.height - 2);
    setMenuPos({ left, top, width: m.width });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  const pick = useCallback(
    (next: T) => {
      onChange(next);
      setOpen(false);
    },
    [onChange],
  );

  return (
    <span className={`panel-select${className ? ` ${className}` : ''}`} ref={wrapRef}>
      <button
        type="button"
        ref={btnRef}
        className="panel-select-btn"
        disabled={disabled}
        title={title}
        onClick={() => setOpen(!open)}
      >
        <span className="panel-select-label">{current?.label ?? String(value)}</span>
        <svg
          className="panel-select-arrow"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div
          ref={menuRef}
          className="panel-select-menu"
          style={{
            left: menuPos?.left ?? -9999,
            top: menuPos?.top ?? -9999,
            minWidth: menuPos?.width,
          }}
        >
          {options.map((opt) => {
            const selected = opt.value === value;
            return (
              <div
                key={opt.value}
                className={`panel-select-item${selected ? ' selected' : ''}`}
                onClick={() => pick(opt.value)}
              >
                <span className="panel-select-item-label">{opt.label}</span>
                {selected && <span className="panel-select-check">✓</span>}
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}
