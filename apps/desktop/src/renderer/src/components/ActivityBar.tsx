/**
 * 活动栏：顶部一排图标 + 末尾 chevron 打开的「更多面板」菜单。
 *
 * 形态参考稿：图标收在一个圆角容器里整组居中；chevron 点开是一个竖直菜单，
 * 每行是「图标 + 名字 + 快捷键 + 固定按钮」，当前所在的那一行高亮。
 *
 * 两条自我约束：
 * 1. **菜单里的每一行都能进。** 菜单只列当前上下文里真的可用的面板
 *    （Maven 不是 Maven 项目就不列），不拿灰掉的占位行凑数。
 * 2. **图标条与菜单共用一份定义**（services/leftPanels），不存在
 *    「菜单里有、图标条上没有」这种对不上的情况。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import {
  availablePanels,
  normalizePinned,
  togglePinned,
  type LeftPanelDef,
  type LeftPanelId,
} from '../services/leftPanels';

export interface ActivityBarProps {
  /** 当前显示的面板 */
  active: LeftPanelId;
  /** 固定在图标条上的面板（存的是用户的选择，渲染前会按上下文收敛） */
  pinned: LeftPanelId[];
  /** 当前工作区是不是 Maven 项目 —— 决定 Maven 面板出不出现 */
  isMavenProject: boolean;
  /** 切换面板。活动栏不关心侧栏是否折叠，那是调用方的事 */
  onSelect: (id: LeftPanelId) => void;
  onPinnedChange: (next: LeftPanelId[]) => void;
}

/** 面板图标。key 必须覆盖 LEFT_PANEL_DEFS 里所有 id（少一个图标条上就是空白）。 */
const PANEL_ICONS: Record<LeftPanelId, React.ReactNode> = {
  explorer: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  ),
  search: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  ),
  git: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <line x1="6" y1="9" x2="6" y2="21" />
    </svg>
  ),
  extensions: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* 拼图块。旧的那条路径在 18px 下渲染成一个认不出的四瓣花 ——
          「扩展」这个图标必须一眼就是拼图，否则用户只能靠位置记它。 */}
      <path d="M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 1 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.7 2.7 0 1 1 0 5.4H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.7 2.7 0 1 1 5.4 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 1 0 0-5z" />
    </svg>
  ),
  maven: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 19V5.5L12 13.5L20 5.5V19" />
    </svg>
  ),
  database: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  ),
  'agent-tasks': (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
};

export function ActivityBar({
  active,
  pinned,
  isMavenProject,
  onSelect,
  onPinnedChange,
}: ActivityBarProps) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const panels = useMemo(() => availablePanels(isMavenProject), [isMavenProject]);
  const pinnedPanels = useMemo(() => {
    const ids = normalizePinned(pinned, isMavenProject);
    // 按定义顺序渲染，而不是按用户固定的先后顺序：图标条上按 E/F/G/X 的固定次序，
    // 位置不会因为「先固定哪个」而变来变去。
    return panels.filter((def) => ids.includes(def.id));
  }, [panels, pinned, isMavenProject]);

  /** 当前面板没被固定在图标条上时，chevron 要高亮 —— 否则「我在哪」就没有提示了。 */
  const activeHiddenBehindMenu = !pinnedPanels.some((def) => def.id === active);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setMenuOpen(false);
      }
    };
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    // 用 mousedown 而不是 click：点击目标自己可能把菜单关掉，
    // click 阶段再来判「点在不在菜单里」时元素可能已经不在了。
    window.addEventListener('mousedown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onPointerDown, true);
    };
  }, [menuOpen]);

  const handleSelect = (id: LeftPanelId) => {
    onSelect(id);
    closeMenu();
  };

  const handleTogglePin = (id: LeftPanelId) => {
    onPinnedChange(togglePinned(pinned, id, isMavenProject));
  };

  const shortcutOf = (def: LeftPanelDef) =>
    def.shortcut
      ? navigator.platform.toLowerCase().includes('mac')
        ? def.shortcut.mac
        : def.shortcut.other
      : '';

  return (
    <div className="idea-sidebar-tabs" ref={rootRef}>
      <div className="activity-pill">
        {pinnedPanels.map((def) => (
          <button
            key={def.id}
            type="button"
            className={active === def.id ? 'active' : ''}
            onClick={() => handleSelect(def.id)}
            title={t(def.labelKey)}
          >
            {PANEL_ICONS[def.id]}
          </button>
        ))}

        <button
          type="button"
          className={`activity-more${menuOpen ? ' expanded' : ''}${
            !menuOpen && activeHiddenBehindMenu ? ' active' : ''
          }`}
          onClick={() => setMenuOpen((v) => !v)}
          title={t('app.railMorePanels')}
          aria-expanded={menuOpen}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>

      {menuOpen && (
        <div className="rail-menu" role="menu">
          {panels.map((def) => (
            <div key={def.id} className={`rail-menu-item${active === def.id ? ' active' : ''}`}>
              <button
                type="button"
                role="menuitem"
                className="rail-menu-main"
                onClick={() => handleSelect(def.id)}
              >
                <span className="rail-menu-icon">{PANEL_ICONS[def.id]}</span>
                <span className="rail-menu-label">{t(def.labelKey)}</span>
                {def.shortcut && <span className="rail-menu-shortcut">{shortcutOf(def)}</span>}
              </button>
              <button
                type="button"
                className={`rail-menu-pin${
                  pinnedPanels.some((p) => p.id === def.id) ? ' pinned' : ''
                }`}
                onClick={() => handleTogglePin(def.id)}
                title={
                  pinnedPanels.some((p) => p.id === def.id)
                    ? t('app.railUnpinPanel')
                    : t('app.railPinPanel')
                }
              >
                {/* 实心图钉。
                    两个尺寸上的取舍都是量出来的：24 格缩到 13px、16 格缩到 16px 时，
                    头的两条斜边会被抗锯齿糊掉，只剩一根竖线。16 格 + 18px 显示、
                    并且把头画宽，才在按钮里读得出是「图钉」而不是一个点。 */}
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M5.6 1.4h4.8a1 1 0 0 1 1 1v.7h-.7l-.6 3.5 2.4 2.1a.7.7 0 0 1-.45 1.25H8.7v4.2a.7.7 0 0 1-1.4 0V9.95H3.95a.7.7 0 0 1-.45-1.25l2.4-2.1-.6-3.5h-.7v-.7a1 1 0 0 1 1-1z" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
