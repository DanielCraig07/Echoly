// @ts-expect-error internal monaco private module
import { ActionViewItem } from 'monaco-editor/esm/vs/base/browser/ui/actionbar/actionViewItems.js';
// @ts-expect-error internal monaco private module
import { ContextView } from 'monaco-editor/esm/vs/base/browser/ui/contextview/contextview.js';
// @ts-expect-error internal monaco private module
import { Menu } from 'monaco-editor/esm/vs/base/browser/ui/menu/menu.js';
// @ts-expect-error internal monaco private module
import { QuickInputTree } from 'monaco-editor/esm/vs/platform/quickinput/browser/quickInputTree.js';

export const MONACO_ZH_TRANSLATIONS: Record<string, string> = {
  // AI
  'Inline AI Edit': '✦ 行内 AI 编辑',
  'Add to AI Chat': '✦ 添加到 AI 对话',

  // Navigation
  'Go to Definition': '转到定义',
  'Go to References': '转到引用',
  'Go to Symbol...': '转到符号...',
  'Go to Declaration': '转到声明',
  'Go to Type Definition': '转到类型定义',
  'Go to Implementations': '转到实现',
  'Find All References': '查找所有引用',

  // Peek
  'Peek': '快速查看',
  'Peek Definition': '查看定义',
  'Peek References': '查看引用',
  'Peek Declaration': '查看声明',
  'Peek Type Definition': '查看类型定义',
  'Peek Implementation': '查看实现',

  // Modification
  'Rename Symbol': '重命名符号',
  'Change All Occurrences': '更改所有匹配项',
  'Format Document': '格式化文档',
  'Format Selection': '格式化选中内容',
  'Refactor...': '重构...',
  'Source Action...': '源代码操作...',
  'Quick Fix...': '快速修复...',

  // Clipboard & Selection
  'Cut': '剪切',
  'Copy': '复制',
  'Paste': '粘贴',
  'Select All': '全选',
  'Undo': '撤销',
  'Redo': '重做',

  // Command Palette
  'Command Palette': '命令面板',

  // Git
  'Git: View File History': 'Git: View File History',

  // Terminal
  'Open in Integrated Terminal': '在集成终端中打开',
  '在集成终端中打开': '在集成终端中打开',
};

const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');

export const MONACO_KEYBINDINGS: Record<string, string> = {
  // AI
  'echoly.inlineAi': isMac ? '⌘K' : 'Ctrl+K',
  'echoly.addToChat': isMac ? '⌘L' : 'Ctrl+L',
  '✦ 行内 AI 编辑': isMac ? '⌘K' : 'Ctrl+K',
  '✦ 添加到 AI 对话': isMac ? '⌘L' : 'Ctrl+L',

  // Navigation
  'editor.action.revealDefinition': isMac ? '⌘F12' : 'F12',
  'Go to Definition': isMac ? '⌘F12' : 'F12',
  '转到定义': isMac ? '⌘F12' : 'F12',

  'editor.action.referenceSearch.trigger': isMac ? '⇧F12' : 'Shift+F12',
  'Go to References': isMac ? '⇧F12' : 'Shift+F12',
  '转到引用': isMac ? '⇧F12' : 'Shift+F12',

  'editor.action.quickOutline': isMac ? '⇧⌘O' : 'Ctrl+Shift+O',
  'Go to Symbol...': isMac ? '⇧⌘O' : 'Ctrl+Shift+O',
  '转到符号...': isMac ? '⇧⌘O' : 'Ctrl+Shift+O',

  'editor.action.peekDefinition': isMac ? '⌥F12' : 'Alt+F12',
  'Peek Definition': isMac ? '⌥F12' : 'Alt+F12',
  '查看定义': isMac ? '⌥F12' : 'Alt+F12',

  'editor.action.rename': 'F2',
  'Rename Symbol': 'F2',
  '重命名符号': 'F2',

  'editor.action.changeAll': isMac ? '⌘F2' : 'Ctrl+F2',
  'Change All Occurrences': isMac ? '⌘F2' : 'Ctrl+F2',
  '更改所有匹配项': isMac ? '⌘F2' : 'Ctrl+F2',

  'editor.action.formatDocument': isMac ? '⌥⇧F' : 'Shift+Alt+F',
  'Format Document': isMac ? '⌥⇧F' : 'Shift+Alt+F',
  '格式化文档': isMac ? '⌥⇧F' : 'Shift+Alt+F',

  'editor.action.clipboardCutAction': isMac ? '⌘X' : 'Ctrl+X',
  'Cut': isMac ? '⌘X' : 'Ctrl+X',
  '剪切': isMac ? '⌘X' : 'Ctrl+X',

  'editor.action.clipboardCopyAction': isMac ? '⌘C' : 'Ctrl+C',
  'Copy': isMac ? '⌘C' : 'Ctrl+C',
  '复制': isMac ? '⌘C' : 'Ctrl+C',

  'editor.action.clipboardPasteAction': isMac ? '⌘V' : 'Ctrl+V',
  'Paste': isMac ? '⌘V' : 'Ctrl+V',
  '粘贴': isMac ? '⌘V' : 'Ctrl+V',

  'editor.action.quickCommand': isMac ? '⇧⌘P' : 'F1',
  'Command Palette': isMac ? '⇧⌘P' : 'F1',
  '命令面板': isMac ? '⇧⌘P' : 'F1',
};

function translateText(text: string): string {
  const trimmed = text.trim();
  if (MONACO_ZH_TRANSLATIONS[trimmed]) {
    return MONACO_ZH_TRANSLATIONS[trimmed];
  }
  // Try case insensitive or partial match
  for (const [en, zh] of Object.entries(MONACO_ZH_TRANSLATIONS)) {
    if (trimmed.toLowerCase() === en.toLowerCase()) {
      return zh;
    }
  }
  return text;
}

function getKeybindingFor(idOrLabel: string): string | null {
  const trimmed = idOrLabel.trim();
  if (MONACO_KEYBINDINGS[trimmed]) return MONACO_KEYBINDINGS[trimmed];
  const zh = MONACO_ZH_TRANSLATIONS[trimmed];
  if (zh && MONACO_KEYBINDINGS[zh]) return MONACO_KEYBINDINGS[zh];
  return null;
}

/**
 * 应用图 3 标签页风格的快捷键胶囊徽章样式
 */
export function applyBadgeStyle(kbEl: HTMLElement, isHovered = false) {
  kbEl.classList.add('shortcut-badge');
  kbEl.style.display = 'inline-flex';
  kbEl.style.alignItems = 'center';
  kbEl.style.justifyContent = 'center';
  kbEl.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro', 'PingFang SC', 'Segoe UI', sans-serif";
  kbEl.style.fontSize = '11.5px';
  kbEl.style.fontWeight = '500';
  kbEl.style.letterSpacing = '1.5px';
  kbEl.style.padding = '1.5px 6px';
  kbEl.style.borderRadius = '4px';
  kbEl.style.lineHeight = '1.35';
  kbEl.style.boxShadow = '0 1px 2px rgba(0, 0, 0, 0.2)';
  kbEl.style.transition = 'all 0.12s ease';
  kbEl.style.whiteSpace = 'nowrap';
  kbEl.style.marginLeft = 'auto';
  kbEl.style.flex = '0 0 auto';
  kbEl.style.textAlign = 'center';
  kbEl.style.height = 'auto';
  kbEl.style.maxHeight = 'none';
  kbEl.style.opacity = '1';

  if (isHovered) {
    kbEl.style.color = '#ffffff';
    kbEl.style.background = 'rgba(255, 255, 255, 0.18)';
    kbEl.style.borderColor = 'rgba(255, 255, 255, 0.25)';
    kbEl.style.border = '1px solid rgba(255, 255, 255, 0.25)';
  } else {
    kbEl.style.color = 'rgba(255, 255, 255, 0.65)';
    kbEl.style.background = 'rgba(255, 255, 255, 0.06)';
    kbEl.style.borderColor = 'rgba(255, 255, 255, 0.1)';
    kbEl.style.border = '1px solid rgba(255, 255, 255, 0.1)';
  }
}

/**
 * Monaco 右键菜单绝对左对齐与对齐图 2（.ctx-item）现代化纯净样式的核心 CSS 规则
 */
export const MONACO_MENU_FIX_CSS = `
  /* 强制外层容器撑满且对齐文件右键菜单面板卡片样式（唯一边框与外阴影），加宽整体宽度 */
  .context-view.monaco-menu-container,
  .monaco-menu-container {
    text-align: left !important;
    width: auto !important;
    min-width: 270px !important;
    z-index: 100000 !important;
    background: #141414 !important;
    background-color: #141414 !important;
    border: 1px solid rgba(255, 255, 255, 0.1) !important;
    border-radius: 8px !important;
    padding: 4px !important;
    box-shadow: 0 18px 42px -4px rgba(0, 0, 0, 0.8), 0 2px 8px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06) !important;
    overflow: visible !important;
    box-sizing: border-box !important;
  }

  [data-theme='light'] .context-view.monaco-menu-container,
  [data-theme='light'] .monaco-menu-container {
    background: #ffffff !important;
    background-color: #ffffff !important;
    border-color: rgba(0, 0, 0, 0.12) !important;
    box-shadow: 0 14px 36px rgba(0, 0, 0, 0.16) !important;
    color: #1f2937 !important;
  }

  /* 子菜单弹出层：确保 fixed 定位能相对于视口自由伸展，不被父菜单裁剪 */
  .monaco-submenu,
  div.monaco-submenu,
  .monaco-submenu.monaco-menu-container {
    position: fixed !important;
    z-index: 100001 !important;
    overflow: visible !important;
    min-width: 190px !important;
    width: auto !important;
    background: #141414 !important;
    background-color: #141414 !important;
    border: 1px solid rgba(255, 255, 255, 0.1) !important;
    border-radius: 8px !important;
    padding: 4px !important;
    box-shadow: 0 18px 42px -4px rgba(0, 0, 0, 0.8), 0 2px 8px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06) !important;
    box-sizing: border-box !important;
  }

  /* 当 Monaco 菜单激活时，确保中间列层级高于右侧 AI 面板，绝不被遮挡 */
  .middle-column:has(.context-view:not([style*="display: none"])),
  .middle-column:has(.monaco-menu-container:not([style*="display: none"])),
  .middle-column:has(.monaco-submenu),
  body.monaco-context-menu-active .middle-column {
    z-index: 100 !important;
  }

  /* 彻底消除子菜单销毁后残留的空外框伪影 */
  .monaco-submenu:empty,
  div.monaco-submenu:empty,
  .monaco-submenu.monaco-menu-container:empty {
    display: none !important;
    border: none !important;
    outline: none !important;
    box-shadow: none !important;
    padding: 0 !important;
    margin: 0 !important;
    width: 0 !important;
    height: 0 !important;
    min-width: 0 !important;
    min-height: 0 !important;
    opacity: 0 !important;
    visibility: hidden !important;
    pointer-events: none !important;
  }

  /* 彻底消灭 Monaco 菜单常驻的右侧垂直滚动条滑块（红框中多出来的一截） */
  .monaco-menu-container .monaco-scrollable-element > .scrollbar,
  .monaco-menu-container .monaco-scrollable-element > .scrollbar.vertical,
  .monaco-menu-container .scrollbar,
  .monaco-menu-container .scrollbar.vertical,
  .monaco-menu .scrollbar,
  .monaco-menu .scrollbar.vertical,
  .context-view .scrollbar,
  .context-view .scrollbar.vertical {
    display: none !important;
    opacity: 0 !important;
    visibility: hidden !important;
    pointer-events: none !important;
    width: 0 !important;
    height: 0 !important;
  }

  .monaco-menu-container .monaco-scrollable-element > .scrollbar > .slider,
  .monaco-menu-container .scrollbar .slider,
  .context-view .scrollbar .slider {
    display: none !important;
    opacity: 0 !important;
    visibility: hidden !important;
    pointer-events: none !important;
    width: 0 !important;
    height: 0 !important;
  }

  /* 彻底清除 scrollElement 与 monaco-menu 的二次边框、outline、阴影、背景及重复 padding */
  .monaco-menu-container .monaco-scrollable-element,
  .context-view .monaco-scrollable-element,
  .monaco-scrollable-element {
    outline: none !important;
    border: none !important;
    box-shadow: none !important;
    background: transparent !important;
    border-radius: 0 !important;
    overflow: visible !important;
  }

  .monaco-menu,
  .monaco-menu-container .monaco-menu,
  .context-view .monaco-menu {
    outline: none !important;
    border: none !important;
    box-shadow: none !important;
    background: transparent !important;
    border-radius: 0 !important;
    padding: 0 !important;
    margin: 0 !important;
    overflow: visible !important;
    box-sizing: border-box !important;
    width: 100% !important;
    max-width: 100% !important;
  }

  .monaco-menu .monaco-action-bar,
  .monaco-menu .monaco-action-bar.vertical {
    text-align: left !important;
    width: 100% !important;
    max-width: 100% !important;
    margin: 0 !important;
    padding: 0 !important;
    border: none !important;
    background: transparent !important;
    overflow: visible !important;
    box-sizing: border-box !important;
  }

  /* 核心修复：彻底消灭交叉轴 align-items: center 导致的整列居中收缩 */
  .monaco-action-bar .actions-container,
  .monaco-menu .actions-container,
  .monaco-menu .monaco-action-bar.vertical .actions-container,
  .context-view .monaco-menu .actions-container {
    display: flex !important;
    flex-direction: column !important;
    align-items: stretch !important;
    justify-content: flex-start !important;
    width: 100% !important;
    max-width: 100% !important;
    margin: 0 !important;
    padding: 0 !important;
    gap: 2px !important;
    box-sizing: border-box !important;
    text-align: left !important;
    list-style: none !important;
    overflow: visible !important;
  }

  /* 菜单项外层 li：拉满整行，内部绝对靠左 */
  .monaco-action-bar .action-item,
  .monaco-menu .action-item,
  .monaco-menu .monaco-action-bar.vertical .action-item,
  .context-view .monaco-menu .action-item {
    display: flex !important;
    width: 100% !important;
    max-width: 100% !important;
    margin: 0 !important;
    padding: 0 !important;
    box-sizing: border-box !important;
    text-align: left !important;
    background: transparent !important;
    border: none !important;
    outline: none !important;
    list-style: none !important;
    overflow: visible !important;
    position: relative !important;
  }

  /* 菜单项交互链接 a：完全对齐文件右键菜单规范（横跨整行，space-between，圆角 6px） */
  .monaco-menu .action-menu-item,
  .monaco-menu .monaco-action-bar.vertical .action-menu-item {
    display: flex !important;
    flex-direction: row !important;
    align-items: center !important;
    justify-content: space-between !important;
    width: 100% !important;
    min-width: 100% !important;
    max-width: 100% !important;
    margin: 0 !important;
    padding: 5px 8px !important;
    min-height: 26px !important;
    height: 26px !important;
    box-sizing: border-box !important;
    border-radius: 6px !important;
    font-size: 12.5px !important;
    font-family: inherit !important;
    color: rgba(255, 255, 255, 0.9) !important;
    transition: background 0.12s ease, color 0.12s ease !important;
    cursor: pointer !important;
    text-decoration: none !important;
    background: transparent !important;
    outline: none !important;
    overflow: hidden !important;
  }

  /* 菜单文字：绝对靠左，清零所有内边距与外边距 */
  .monaco-menu .action-label,
  .monaco-menu .action-label:not(.separator),
  .monaco-menu .monaco-action-bar.vertical .action-label,
  .monaco-menu .monaco-action-bar.vertical .action-label:not(.separator),
  .monaco-menu .monaco-action-bar.vertical .action-item .action-label:not(.separator),
  .context-view .monaco-menu .action-label:not(.separator) {
    display: inline-flex !important;
    align-items: center !important;
    justify-content: flex-start !important;
    text-align: left !important;
    padding: 0 !important;
    padding-left: 0 !important;
    padding-right: 0 !important;
    margin: 0 !important;
    margin-left: 0 !important;
    flex: 0 1 auto !important;
    width: auto !important;
    max-width: none !important;
    font-size: 12.5px !important;
    line-height: 1.2 !important;
    color: inherit !important;
    text-decoration: none !important;
  }

  /* 清除未勾选项 menu-item-check 的幽灵占位 */
  .monaco-menu .monaco-action-bar.vertical .menu-item-check:not(.checked),
  .monaco-menu .menu-item-check:not(.checked) {
    display: none !important;
    width: 0 !important;
    height: 0 !important;
    padding: 0 !important;
    margin: 0 !important;
  }

  /* 快捷键胶囊徽章：完全对齐图 2 的 .shortcut-badge 规范，弹性靠最右侧对齐 */
  .monaco-menu .keybinding,
  .monaco-menu .action-item .keybinding,
  .monaco-menu .action-menu-item .keybinding,
  .context-view .monaco-menu .keybinding,
  .keybinding.shortcut-badge {
    margin-left: auto !important;
    flex: 0 0 auto !important;
    flex-shrink: 0 !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro', 'PingFang SC', 'Segoe UI', sans-serif !important;
    font-size: 11.5px !important;
    font-weight: 500 !important;
    letter-spacing: 1.5px !important;
    padding: 1.5px 6px !important;
    border-radius: 4px !important;
    line-height: 1.35 !important;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2) !important;
    white-space: nowrap !important;
    text-align: center !important;
    height: auto !important;
    max-height: none !important;
    color: rgba(255, 255, 255, 0.65) !important;
    background: rgba(255, 255, 255, 0.06) !important;
    border: 1px solid rgba(255, 255, 255, 0.1) !important;
    transition: all 0.12s ease !important;
  }

  /* 子菜单箭头靠右 */
  .monaco-menu .submenu-indicator,
  .monaco-menu .monaco-action-bar.vertical .submenu-indicator {
    margin-left: auto !important;
    flex: 0 0 auto !important;
    flex-shrink: 0 !important;
    display: inline-flex !important;
    align-items: center !important;
  }

  /* 分割线紧凑优雅 */
  .monaco-menu .action-item.separator,
  .monaco-menu .action-item:has(.separator),
  .monaco-menu .separator {
    display: block !important;
    min-height: 0 !important;
    height: 1px !important;
    padding: 0 !important;
    margin: 4px 6px !important;
    background: rgba(255, 255, 255, 0.08) !important;
    border: none !important;
    cursor: default !important;
    box-sizing: border-box !important;
  }

  /* 悬停与聚焦：整行背景色严格与文件右键（.ctx-item:hover）一致，采用直接子代选择器 > 防止向下污染子菜单 */
  .monaco-menu .action-item.focused > .action-menu-item,
  .monaco-menu .action-item:hover > .action-menu-item,
  .monaco-menu .action-menu-item.focused,
  .monaco-menu .action-menu-item:hover,
  .monaco-menu .action-menu-item:focus,
  .context-view .monaco-menu .action-item.focused > .action-menu-item,
  .context-view .monaco-menu .action-item:hover > .action-menu-item,
  .context-view .monaco-menu .action-menu-item.focused,
  .context-view .monaco-menu .action-menu-item:hover,
  .context-view .monaco-menu .action-menu-item:focus {
    background: var(--accent, #007acc) !important;
    background-color: var(--accent, #007acc) !important;
    color: #ffffff !important;
    width: 100% !important;
  }

  .monaco-menu .action-item.focused > .action-menu-item .action-label,
  .monaco-menu .action-item:hover > .action-menu-item .action-label,
  .monaco-menu .action-menu-item.focused .action-label,
  .monaco-menu .action-menu-item:hover .action-label,
  .context-view .monaco-menu .action-item.focused > .action-menu-item .action-label,
  .context-view .monaco-menu .action-item:hover > .action-menu-item .action-label {
    color: #ffffff !important;
  }

  .monaco-menu .action-item:active > .action-menu-item,
  .monaco-menu .action-menu-item:active,
  .context-view .monaco-menu .action-item:active > .action-menu-item,
  .context-view .monaco-menu .action-item:active {
    background: #005a9e !important;
    background-color: #005a9e !important;
    color: #ffffff !important;
  }

  .monaco-menu .action-item.focused > .action-menu-item .keybinding,
  .monaco-menu .action-item:hover > .action-menu-item .keybinding,
  .monaco-menu .action-menu-item.focused .keybinding,
  .monaco-menu .action-menu-item:hover .keybinding,
  .context-view .action-item.focused > .action-menu-item .keybinding,
  .context-view .action-item:hover > .action-menu-item .keybinding,
  .context-view .action-menu-item.focused .keybinding,
  .context-view .action-menu-item:hover .keybinding {
    color: #ffffff !important;
    background: rgba(255, 255, 255, 0.18) !important;
    border-color: rgba(255, 255, 255, 0.25) !important;
  }

  .monaco-menu .action-item.focused > .action-menu-item .submenu-indicator,
  .monaco-menu .action-item:hover > .action-menu-item .submenu-indicator,
  .context-view .action-item.focused > .action-menu-item .submenu-indicator,
  .context-view .action-item:hover > .action-menu-item .submenu-indicator {
    color: #ffffff !important;
  }

  [data-theme='light'] .monaco-menu .action-item:not(.separator).focused > .action-menu-item,
  [data-theme='light'] .monaco-menu .action-item:not(.separator):hover > .action-menu-item,
  [data-theme='light'] .monaco-menu .action-item:not(.separator):focus > .action-menu-item {
    background: var(--accent, #007acc) !important;
    background-color: var(--accent, #007acc) !important;
    color: #ffffff !important;
  }
`;

/**
 * 确保全局常驻最高优先级的菜单修复样式表
 */
export function ensureGlobalMenuFixStyleSheet() {
  if (typeof document === 'undefined') return;
  let styleEl = document.getElementById('echoly-monaco-menu-fix') as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'echoly-monaco-menu-fix';
    styleEl.textContent = MONACO_MENU_FIX_CSS;
    document.head.appendChild(styleEl);
  } else if (styleEl.textContent !== MONACO_MENU_FIX_CSS) {
    styleEl.textContent = MONACO_MENU_FIX_CSS;
  }
  // 保持处于 head 最末尾以确保覆盖 Monaco 动态注入的 CSS
  if (document.head.lastElementChild !== styleEl) {
    document.head.appendChild(styleEl);
  }
}

/**
 * 格式化菜单项布局与样式（完全对齐图 2：整行 space-between，横跨高亮）
 */
export function applyActionItemStyle(itemEl: HTMLElement) {
  let itemLi: HTMLElement;
  let itemA: HTMLElement;

  if (itemEl.classList.contains('action-menu-item')) {
    itemA = itemEl;
    itemLi = (itemEl.parentElement as HTMLElement) || itemEl;
  } else {
    itemLi = itemEl;
    itemA = itemEl.querySelector<HTMLElement>('.action-menu-item') || itemEl;
  }

  // 1. 父级容器 ul.actions-container 保持拉伸
  const parent = itemLi.parentElement;
  if (parent) {
    parent.style.setProperty('display', 'flex', 'important');
    parent.style.setProperty('flex-direction', 'column', 'important');
    parent.style.setProperty('align-items', 'stretch', 'important');
    parent.style.setProperty('justify-content', 'flex-start', 'important');
    parent.style.setProperty('width', '100%', 'important');
    parent.style.setProperty('box-sizing', 'border-box', 'important');
    parent.style.setProperty('text-align', 'left', 'important');

    const grandParent = parent.parentElement;
    if (grandParent) {
      grandParent.style.setProperty('text-align', 'left', 'important');
      grandParent.style.setProperty('width', '100%', 'important');
    }
  }

  // 2. 外层 li.action-item
  itemLi.style.setProperty('display', 'flex', 'important');
  itemLi.style.setProperty('width', '100%', 'important');
  itemLi.style.setProperty('box-sizing', 'border-box', 'important');
  itemLi.style.setProperty('padding', '0px', 'important');
  itemLi.style.setProperty('margin', '0px', 'important');
  itemLi.style.setProperty('background', 'transparent', 'important');
  itemLi.style.setProperty('border', 'none', 'important');

  // 3. 内层 a.action-menu-item：对齐图 2 的 .ctx-item
  itemA.style.setProperty('display', 'flex', 'important');
  itemA.style.setProperty('flex-direction', 'row', 'important');
  itemA.style.setProperty('align-items', 'center', 'important');
  itemA.style.setProperty('justify-content', 'space-between', 'important');
  itemA.style.setProperty('width', '100%', 'important');
  itemA.style.setProperty('min-width', '100%', 'important');
  itemA.style.setProperty('max-width', '100%', 'important');
  itemA.style.setProperty('box-sizing', 'border-box', 'important');
  itemA.style.setProperty('padding', '5px 8px', 'important');
  itemA.style.setProperty('margin', '0px', 'important');
  itemA.style.setProperty('border-radius', '6px', 'important');
  itemA.style.setProperty('text-align', 'left', 'important');
  itemA.style.setProperty('cursor', 'pointer', 'important');
}

/**
 * 深度格式化单个 ActionItem，文本绝对严格左对齐，快捷键靠最右，对齐图 2 规范
 */
export function formatMenuItem(itemEl: HTMLElement) {
  if (!itemEl) return;

  // 1. 若为分割线，严格重置为 1px 高度
  if (itemEl.classList.contains('separator') || itemEl.querySelector('.separator')) {
    itemEl.style.setProperty('display', 'block', 'important');
    itemEl.style.setProperty('min-height', '0px', 'important');
    itemEl.style.setProperty('height', '1px', 'important');
    itemEl.style.setProperty('padding', '0px', 'important');
    itemEl.style.setProperty('margin', '4px 6px', 'important');
    itemEl.style.setProperty('background', 'rgba(255, 255, 255, 0.08)', 'important');
    itemEl.style.setProperty('border', 'none', 'important');
    itemEl.style.setProperty('box-shadow', 'none', 'important');
    itemEl.style.setProperty('cursor', 'default', 'important');
    itemEl.style.setProperty('overflow', 'hidden', 'important');
    return;
  }

  let itemLi: HTMLElement;
  let itemA: HTMLElement;
  if (itemEl.classList.contains('action-menu-item')) {
    itemA = itemEl;
    itemLi = (itemEl.parentElement as HTMLElement) || itemEl;
  } else {
    itemLi = itemEl;
    itemA = itemEl.querySelector<HTMLElement>('.action-menu-item') || itemEl;
  }

  // 2. 清除未勾选项 menu-item-check 的幽灵占位
  const checkEl = itemLi.querySelector<HTMLElement>('.menu-item-check');
  if (checkEl && !itemLi.classList.contains('checked') && !checkEl.classList.contains('checked')) {
    checkEl.style.setProperty('display', 'none', 'important');
    checkEl.style.setProperty('width', '0px', 'important');
    checkEl.style.setProperty('margin', '0px', 'important');
    checkEl.style.setProperty('padding', '0px', 'important');
  }

  // 3. 应用图 2 尺寸与 flex 布局
  applyActionItemStyle(itemLi);

  // 4. 文本汉化与绝对左对齐
  const labelEl = itemLi.querySelector<HTMLElement>('.action-label');
  if (labelEl) {
    labelEl.style.setProperty('display', 'inline-flex', 'important');
    labelEl.style.setProperty('align-items', 'center', 'important');
    labelEl.style.setProperty('justify-content', 'flex-start', 'important');
    labelEl.style.setProperty('text-align', 'left', 'important');
    labelEl.style.setProperty('padding', '0px', 'important');
    labelEl.style.setProperty('margin', '0px', 'important');
    labelEl.style.setProperty('flex', '0 1 auto', 'important');
    labelEl.style.setProperty('width', 'auto', 'important');
    labelEl.style.setProperty('max-width', 'none', 'important');
    labelEl.style.setProperty('font-size', '12.5px', 'important');
    labelEl.style.setProperty('line-height', '1.2', 'important');
    labelEl.style.setProperty('text-decoration', 'none', 'important');

    const currentText = labelEl.textContent?.trim() || '';
    const translated = translateText(currentText);
    if (translated && translated !== currentText) {
      labelEl.textContent = translated;
    }

    if (currentText.includes('AI') || (translated && translated.includes('AI')) || currentText.includes('✦')) {
      itemLi.classList.add('monaco-ai-menu-item');
    }
  }

  // 5. 子菜单指示箭头靠最右对齐
  const submenuArrow = itemLi.querySelector<HTMLElement>('.submenu-indicator');
  if (submenuArrow) {
    submenuArrow.style.setProperty('margin-left', 'auto', 'important');
    submenuArrow.style.setProperty('flex', '0 0 auto', 'important');
    submenuArrow.style.setProperty('flex-shrink', '0', 'important');
    submenuArrow.style.setProperty('display', 'inline-flex', 'important');
    submenuArrow.style.setProperty('align-items', 'center', 'important');
  }

  // 6. 快捷键徽章单例保证与挂载（统一作为 itemA 子节点，弹性靠最右对齐）
  const actionText = labelEl?.textContent?.trim() || '';
  const kb = getKeybindingFor(actionText);

  const kbList = Array.from(itemLi.querySelectorAll<HTMLElement>('.keybinding'));
  if (kbList.length > 1) {
    for (let i = 1; i < kbList.length; i++) {
      kbList[i].remove();
    }
  }

  let kbEl = kbList[0] || null;
  if (!kbEl && kb) {
    kbEl = document.createElement('span');
    kbEl.className = 'keybinding shortcut-badge';
    kbEl.textContent = kb;
    itemA.appendChild(kbEl);
  } else if (kbEl && !kbEl.textContent?.trim() && kb) {
    kbEl.textContent = kb;
  }

  if (kbEl) {
    // 确保快捷键处于 itemA 内部
    if (kbEl.parentElement !== itemA) {
      itemA.appendChild(kbEl);
    }
    // 若同时存在子菜单箭头，让子菜单箭头处于最右，快捷键在箭头左侧
    if (submenuArrow && itemA.contains(submenuArrow)) {
      itemA.insertBefore(kbEl, submenuArrow);
      kbEl.style.setProperty('margin-right', '6px', 'important');
    }
    applyBadgeStyle(kbEl);
  }
}

/**
 * 拦截并汉化 Monaco Editor 右键菜单项与快捷键提示
 */
export function setupMonacoChineseLocalization() {
  // 确保全局常驻最高优先级样式表
  ensureGlobalMenuFixStyleSheet();

  // 1. Monkey-patch Menu.prototype.initializeOrUpdateStyleSheet
  try {
    const menuProto = Menu.prototype as any;
    const origInitializeOrUpdateStyleSheet = menuProto.initializeOrUpdateStyleSheet;
    menuProto.initializeOrUpdateStyleSheet = function (container: HTMLElement, style: any) {
      origInitializeOrUpdateStyleSheet.call(this, container, style);
      try {
        if (this.styleSheet && typeof this.styleSheet.textContent === 'string') {
          if (!this.styleSheet.textContent.includes('echoly-monaco-menu-fix')) {
            this.styleSheet.textContent += `\n/* echoly-monaco-menu-fix */\n${MONACO_MENU_FIX_CSS}\n`;
          }
        }
      } catch (err) {
        console.warn('Failed to append menu fix CSS to styleSheet:', err);
      }
    };

    const origStyleScrollElement = menuProto.styleScrollElement;
    menuProto.styleScrollElement = function (scrollElement: HTMLElement, style: any) {
      if (origStyleScrollElement) {
        origStyleScrollElement.call(this, scrollElement, style);
      }
      try {
        if (scrollElement) {
          scrollElement.style.setProperty('outline', 'none', 'important');
          scrollElement.style.setProperty('border', 'none', 'important');
          scrollElement.style.setProperty('box-shadow', 'none', 'important');
          scrollElement.style.setProperty('background', 'transparent', 'important');
          scrollElement.style.setProperty('overflow', 'visible', 'important');
        }
        if (this.menuElement) {
          this.menuElement.style.setProperty('outline', 'none', 'important');
          this.menuElement.style.setProperty('border', 'none', 'important');
          this.menuElement.style.setProperty('box-shadow', 'none', 'important');
          this.menuElement.style.setProperty('background', 'transparent', 'important');
          this.menuElement.style.setProperty('padding', '0px', 'important');
          this.menuElement.style.setProperty('margin', '0px', 'important');
          this.menuElement.style.setProperty('overflow', 'visible', 'important');
          this.menuElement.scrollLeft = 0;
        }
      } catch (e) {}
    };
  } catch (e) {
    console.warn('Failed to patch Menu.prototype.initializeOrUpdateStyleSheet:', e);
  }

  // 2. Monkey-patch ActionViewItem 原型
  try {
    const proto = ActionViewItem.prototype as any;
    const origRender = proto.render;
    proto.render = function (container: HTMLElement) {
      origRender.call(this, container);
      try {
        const itemEl = this.element || container;
        if (itemEl) {
          formatMenuItem(itemEl);
        }
      } catch (err) {
        console.warn('Monaco ActionViewItem localization error:', err);
      }
    };

    const origUpdateLabel = proto.updateLabel;
    proto.updateLabel = function () {
      origUpdateLabel.call(this);
      try {
        const itemEl = this.element;
        if (itemEl) {
          formatMenuItem(itemEl);
        }
      } catch (err) {
        console.warn('Monaco ActionViewItem updateLabel error:', err);
      }
    };
  } catch (e) {
    console.warn('Failed to patch ActionViewItem:', e);
  }

  // 3. Monkey-patch Menu.prototype.doGetActionViewItem 与 Menu.prototype.updateFocus
  try {
    const menuProto = Menu.prototype as any;

    const origUpdateFocus = menuProto.updateFocus;
    menuProto.updateFocus = function (fromRight: any) {
      origUpdateFocus.call(this, fromRight);
      try {
        const pd = (this as any).__parentData;
        if (pd && pd.submenu && typeof this.focusedItem === 'number') {
          const focusedViewItem = this.viewItems ? this.viewItems[this.focusedItem] : null;
          // 若鼠标当前移动聚焦到的菜单项不是子菜单所有者，立刻清理收起子菜单
          if (focusedViewItem && (focusedViewItem as any).mysubmenu !== pd.submenu) {
            if (this.viewItems) {
              for (const vi of this.viewItems) {
                if (vi && (vi as any).mysubmenu === pd.submenu && typeof (vi as any).cleanupExistingSubmenu === 'function') {
                  (vi as any).cleanupExistingSubmenu(true);
                  break;
                }
              }
            }
          }
        }
      } catch (err) {}
    };

    const origCalculateSubmenu = menuProto.calculateSubmenuMenuLayout;
    if (origCalculateSubmenu) {
      menuProto.calculateSubmenuMenuLayout = function (
        windowDimensions: any,
        submenu: any,
        entry: any,
        expandDirection: any
      ) {
        let effectiveWidth = windowDimensions.width;
        try {
          const editorEl =
            this.menuElement?.closest?.('.monaco-editor') ||
            document.querySelector('.middle-column');
          if (editorEl) {
            const rect = editorEl.getBoundingClientRect();
            if (rect.right > 0 && rect.right < effectiveWidth) {
              effectiveWidth = rect.right;
            }
          }
        } catch (e) {}

        const customWindowDimensions = {
          ...windowDimensions,
          width: effectiveWidth,
        };
        return origCalculateSubmenu.call(this, customWindowDimensions, submenu, entry, expandDirection);
      };
    }

    const origDoGetActionViewItem = menuProto.doGetActionViewItem;
    menuProto.doGetActionViewItem = function (action: any, options: any, parentData: any) {
      if (parentData) {
        (this as any).__parentData = parentData;
      }

      if (this.menuElement && !(this.menuElement as any).__noHorizontalScroll) {
        (this.menuElement as any).__noHorizontalScroll = true;
        this.menuElement.style.setProperty('overflow', 'visible', 'important');
        this.menuElement.addEventListener('scroll', () => {
          if (this.menuElement.scrollLeft !== 0) {
            this.menuElement.scrollLeft = 0;
          }
        });
      }
      if (this.scrollableElement && !(this.scrollableElement as any).__noHorizontalScroll) {
        (this.scrollableElement as any).__noHorizontalScroll = true;
        const origScan = this.scrollableElement.scanDomNode;
        if (origScan) {
          this.scrollableElement.scanDomNode = function () {
            origScan.call(this);
            if (this._scrollable) {
              const d = this._scrollable.getScrollDimensions();
              this._scrollable.setScrollDimensions({
                width: Math.max(d.width, d.scrollWidth),
                scrollWidth: Math.max(d.width, d.scrollWidth)
              });
              this._scrollable.setScrollPositionNow({ scrollLeft: 0 });
            }
          };
        }
      }

      if (action) {
        if (action.label) {
          const zh = translateText(action.label);
          if (zh !== action.label) {
            action.label = zh;
          }
        }
        if (Array.isArray(action.actions)) {
          for (const sub of action.actions) {
            if (sub && sub.label) {
              const zhSub = translateText(sub.label);
              if (zhSub !== sub.label) {
                sub.label = zhSub;
              }
            }
          }
        }
      }
      const item = origDoGetActionViewItem.call(this, action, options, parentData);
      if (item) {
        // 若为子菜单项（如“快速查看”），接管生命周期监听，确保鼠标移离时自动收起消失并彻底销毁 DOM 节点
        if (typeof (item as any).cleanupExistingSubmenu === 'function') {
          const subItem = item as any;
          const origCleanup = subItem.cleanupExistingSubmenu;
          subItem.cleanupExistingSubmenu = function (force: boolean) {
            const containerToClean = this.submenuContainer;
            origCleanup.call(this, force);
            try {
              if (containerToClean && containerToClean.parentNode) {
                containerToClean.remove();
              }
              if (this.element) {
                const leftovers = this.element.querySelectorAll('.monaco-submenu');
                leftovers.forEach((el: Element) => el.remove());
              }
            } catch (err) {}
          };

          const origCreateSubmenu = subItem.createSubmenu;
          subItem.createSubmenu = function (selectFirstItem = true) {
            origCreateSubmenu.call(this, selectFirstItem);
            try {
              if (this.submenuContainer && !this.submenuContainer.__hasSubmenuMouseListeners) {
                this.submenuContainer.__hasSubmenuMouseListeners = true;
                this.submenuContainer.addEventListener('mouseenter', () => {
                  if (subItem.__hideTimer) {
                    clearTimeout(subItem.__hideTimer);
                    subItem.__hideTimer = null;
                  }
                });
                this.submenuContainer.addEventListener('mouseleave', (e: MouseEvent) => {
                  const to = e.relatedTarget as Node | null;
                  if (to && ((this.element && this.element.contains(to)) || (this.submenuContainer && this.submenuContainer.contains(to)))) {
                    return;
                  }
                  if (subItem.__hideTimer) clearTimeout(subItem.__hideTimer);
                  subItem.__hideTimer = setTimeout(() => {
                    if (this.parentData && this.parentData.submenu === this.mysubmenu) {
                      this.cleanupExistingSubmenu(true);
                    }
                  }, 220);
                });
              }

              // 校准子菜单水平位置：若子菜单超出编辑器右边界，向左展开
              if (this.submenuContainer) {
                const subRect = this.submenuContainer.getBoundingClientRect();
                const parentRect = this.element?.getBoundingClientRect();
                const editorEl = this.element?.closest?.('.monaco-editor') || document.querySelector('.middle-column');
                const editorRect = editorEl?.getBoundingClientRect();
                const maxRight = (editorRect && editorRect.right > 0 && editorRect.right < (typeof window !== 'undefined' ? window.innerWidth : 1920))
                  ? editorRect.right
                  : (typeof window !== 'undefined' ? window.innerWidth : 1920);
                if (subRect.right > maxRight - 4 && parentRect) {
                  const targetLeft = parentRect.left - subRect.width;
                  const deltaX = targetLeft - subRect.left;
                  const curLeft = parseFloat(this.submenuContainer.style.left) || 0;
                  this.submenuContainer.style.left = `${curLeft + deltaX}px`;
                }
              }
            } catch (err) {}
          };
        }

        const origItemRender = item.render;
        item.render = function (container: HTMLElement) {
          origItemRender.call(this, container);
          try {
            const el = this.element || container;
            if (el) {
              formatMenuItem(el);
              if (typeof (this as any).cleanupExistingSubmenu === 'function' && !el.__hasSubmenuHoverHandlers) {
                el.__hasSubmenuHoverHandlers = true;
                const subItem = this as any;
                el.addEventListener('mouseenter', () => {
                  if (subItem.__hideTimer) {
                    clearTimeout(subItem.__hideTimer);
                    subItem.__hideTimer = null;
                  }
                });
                el.addEventListener('mouseleave', (e: MouseEvent) => {
                  const to = e.relatedTarget as Node | null;
                  if (to && ((subItem.submenuContainer && subItem.submenuContainer.contains(to)) || el.contains(to))) {
                    return;
                  }
                  if (subItem.__hideTimer) clearTimeout(subItem.__hideTimer);
                  subItem.__hideTimer = setTimeout(() => {
                    if (subItem.parentData && subItem.parentData.submenu === subItem.mysubmenu) {
                      subItem.cleanupExistingSubmenu(true);
                    }
                  }, 220);
                });
              }
            }
          } catch (err) {
            console.warn('Monaco Menu Item render error:', err);
          }
        };
      }
      return item;
    };
  } catch (e) {
    console.warn('Failed to patch Menu:', e);
  }

  // 4. Monkey-patch ContextView 原型：智能边缘碰撞检测与翻转，绝对防止菜单被右侧 AI 对话面板遮挡
  try {
    const cvProto = ContextView.prototype as any;
    const origShow = cvProto.show;
    cvProto.show = function (delegate: any) {
      if (typeof document !== 'undefined') {
        document.body.classList.add('monaco-context-menu-active');
      }
      return origShow.call(this, delegate);
    };

    const origHide = cvProto.hide;
    cvProto.hide = function (data: any) {
      if (typeof document !== 'undefined') {
        document.body.classList.remove('monaco-context-menu-active');
      }
      return origHide.call(this, data);
    };

    const origDoLayout = cvProto.doLayout;
    cvProto.doLayout = function () {
      origDoLayout.call(this);
      if (!this.isVisible() || !this.view) {
        return;
      }
      try {
        const menuRect = this.view.getBoundingClientRect();
        const menuWidth = menuRect.width || Math.max(270, this.view.offsetWidth || 0);
        const menuHeight = menuRect.height || this.view.offsetHeight || 0;

        // 查找包含此 ContextView 的编辑器或中间列边界
        const container = this.container || this.view.parentElement;
        const editorDom =
          container?.closest?.('.monaco-editor') ||
          container?.closest?.('.middle-column') ||
          document.querySelector('.middle-column') ||
          container;
        const editorRect = editorDom?.getBoundingClientRect?.();

        const windowWidth = typeof window !== 'undefined' ? window.innerWidth : 1920;
        const windowHeight = typeof window !== 'undefined' ? window.innerHeight : 1080;

        // 右边界以编辑器可视右边界为主（若存在且小于窗口宽度，如右侧有 AI 对话面板），避免溢出被 AI 面板截断
        const boundaryRight =
          editorRect && editorRect.right > 0 && editorRect.right < windowWidth
            ? editorRect.right
            : windowWidth;
        const boundaryLeft = editorRect && editorRect.left >= 0 ? editorRect.left : 0;

        // 获取鼠标右键触发时的绝对锚点坐标
        let anchorX = menuRect.left;
        let anchorY = menuRect.top;
        if (this.delegate && typeof this.delegate.getAnchor === 'function') {
          const a = this.delegate.getAnchor();
          if (a) {
            if (typeof a.x === 'number') anchorX = a.x;
            else if (typeof a.posx === 'number') anchorX = a.posx;
            else if (a instanceof HTMLElement) {
              const r = a.getBoundingClientRect();
              anchorX = r.left;
              anchorY = r.top;
            }
            if (typeof a.y === 'number') anchorY = a.y;
            else if (typeof a.posy === 'number') anchorY = a.posy;
          }
        }

        // 1. 水平位置校准：若菜单右边缘超越了编辑器右侧分界线（避免被右侧 AI 区域覆盖）
        if (menuRect.right > boundaryRight - 4) {
          let targetLeft: number;
          const flippedLeft = anchorX - menuWidth;
          if (flippedLeft >= boundaryLeft) {
            // 翻转至光标左侧
            targetLeft = flippedLeft;
          } else {
            // 若左侧空间也不足，紧贴右边界往左排
            targetLeft = Math.max(boundaryLeft + 4, boundaryRight - menuWidth - 4);
          }
          const deltaX = targetLeft - menuRect.left;
          const currentStyleLeft = parseFloat(this.view.style.left) || 0;
          this.view.style.left = `${currentStyleLeft + deltaX}px`;
        }

        // 2. 垂直位置校准：若编辑器下方有终端面板且菜单底部溢出到底部面板
        const boundaryBottom =
          editorRect && editorRect.bottom > 0 && editorRect.bottom < windowHeight
            ? editorRect.bottom
            : windowHeight;
        const currentMenuRectAfter = this.view.getBoundingClientRect();
        if (currentMenuRectAfter.bottom > boundaryBottom - 4) {
          const flippedTop = anchorY - menuHeight;
          const boundaryTop = editorRect && editorRect.top >= 0 ? editorRect.top : 0;
          let targetTop: number;
          if (flippedTop >= boundaryTop) {
            targetTop = flippedTop;
          } else {
            targetTop = Math.max(boundaryTop + 4, boundaryBottom - menuHeight - 4);
          }
          const deltaY = targetTop - currentMenuRectAfter.top;
          const currentStyleTop = parseFloat(this.view.style.top) || 0;
          this.view.style.top = `${currentStyleTop + deltaY}px`;
        }
      } catch (err) {
        console.warn('ContextView doLayout boundary adjustment error:', err);
      }
    };
  } catch (e) {
    console.warn('Failed to patch ContextView:', e);
  }

  // 5. 全局拦截 Element.prototype.attachShadow：给任意 Monaco Shadow DOM 注入穿透样式
  if (typeof Element !== 'undefined' && Element.prototype.attachShadow) {
    try {
      const origAttachShadow = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init: ShadowRootInit) {
        const root = origAttachShadow.call(this, init);
        try {
          const style = document.createElement('style');
          style.textContent = MONACO_MENU_FIX_CSS;
          root.appendChild(style);
        } catch (e) {}
        return root;
      };
    } catch (e) {
      console.warn('Failed to patch attachShadow:', e);
    }
  }

  // 5. 全局捕获阶段事件监听：右键菜单打开时全量多轮扫描格式化并置顶全局样式表，同时彻底杜绝横向滚动
  if (typeof window !== 'undefined') {
    const scanAllMenus = () => {
      ensureGlobalMenuFixStyleSheet();
      const scanRoot = (root: Document | ShadowRoot | Element) => {
        try {
          // 彻底隐藏任何常驻滚动条与滑块
          const scrollbars = root.querySelectorAll<HTMLElement>('.scrollbar, .scrollbar.vertical, .slider');
          scrollbars.forEach((sb) => {
            sb.style.setProperty('display', 'none', 'important');
            sb.style.setProperty('opacity', '0', 'important');
            sb.style.setProperty('visibility', 'hidden', 'important');
            sb.style.setProperty('width', '0px', 'important');
            sb.style.setProperty('height', '0px', 'important');
          });

          // 清除内部 scrollable 的边框与多余滚动
          const scrollables = root.querySelectorAll<HTMLElement>('.monaco-scrollable-element');
          scrollables.forEach((el) => {
            el.style.setProperty('outline', 'none', 'important');
            el.style.setProperty('border', 'none', 'important');
            el.style.setProperty('box-shadow', 'none', 'important');
            el.style.setProperty('background', 'transparent', 'important');
            el.style.setProperty('overflow', 'visible', 'important');
          });

          // 清除 monaco-menu 的二次边框与内边距，允许子菜单正常弹出
          const menus = root.querySelectorAll<HTMLElement>('.monaco-menu');
          menus.forEach((el) => {
            el.style.setProperty('outline', 'none', 'important');
            el.style.setProperty('border', 'none', 'important');
            el.style.setProperty('box-shadow', 'none', 'important');
            el.style.setProperty('background', 'transparent', 'important');
            el.style.setProperty('padding', '0px', 'important');
            el.style.setProperty('margin', '0px', 'important');
            el.style.setProperty('overflow', 'visible', 'important');
            if (el.scrollLeft !== 0) {
              el.scrollLeft = 0;
            }
          });

          const containers = root.querySelectorAll<HTMLElement>('.actions-container, .monaco-action-bar.vertical');
          containers.forEach((c) => {
            c.style.setProperty('display', 'flex', 'important');
            c.style.setProperty('flex-direction', 'column', 'important');
            c.style.setProperty('align-items', 'stretch', 'important');
            c.style.setProperty('justify-content', 'flex-start', 'important');
            c.style.setProperty('width', '100%', 'important');
            c.style.setProperty('text-align', 'left', 'important');
            c.style.setProperty('overflow', 'visible', 'important');
          });

          // 仅对 .action-item 进行格式化，避免把内层 .action-menu-item 重复调用导致样式破坏
          const items = root.querySelectorAll<HTMLElement>('.action-item');
          items.forEach(formatMenuItem);

          const shadowHosts = root.querySelectorAll('*');
          shadowHosts.forEach((host) => {
            if (host.shadowRoot) {
              scanRoot(host.shadowRoot);
            }
          });
        } catch (e) {}
      };
      scanRoot(document);
    };

    // 拦截触控板或滚轮引起的右键菜单横向左右滑动
    window.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        const target = e.target as HTMLElement | null;
        if (target && target.closest('.monaco-menu-container, .monaco-menu, .context-view')) {
          if (Math.abs(e.deltaX) > 0) {
            e.preventDefault();
            e.stopPropagation();
          }
        }
      },
      { capture: true, passive: false }
    );

    window.addEventListener(
      'contextmenu',
      () => {
        ensureGlobalMenuFixStyleSheet();
        setTimeout(scanAllMenus, 0);
        setTimeout(scanAllMenus, 25);
        setTimeout(scanAllMenus, 75);
        setTimeout(scanAllMenus, 150);
      },
      true
    );
  }

  // 5. 增强 QuickInputTree：鼠标真实移动时同步焦点，键盘滚动时严格防止静止鼠标指针劫持焦点
  try {
    let lastMouseClientX = -1;
    let lastMouseClientY = -1;
    let lastKeyboardTime = 0;

    if (typeof window !== 'undefined') {
      window.addEventListener(
        'keydown',
        (e) => {
          if (
            e.key === 'ArrowUp' ||
            e.key === 'ArrowDown' ||
            e.key === 'PageUp' ||
            e.key === 'PageDown' ||
            e.key === 'Home' ||
            e.key === 'End'
          ) {
            lastKeyboardTime = Date.now();
          }
        },
        true
      );
    }

    const treeProto = QuickInputTree.prototype as any;
    const origRegisterHover = treeProto._registerHoverListeners;
    if (origRegisterHover) {
      treeProto._registerHoverListeners = function () {
        origRegisterHover.call(this);
        if (this._tree) {
          this._register(
            this._tree.onMouseOver((e: any) => {
              if (Date.now() - lastKeyboardTime < 350) {
                return;
              }
              const mouseEvent = e.browserEvent;
              if (mouseEvent && typeof mouseEvent.clientX === 'number') {
                if (mouseEvent.clientX === lastMouseClientX && mouseEvent.clientY === lastMouseClientY) {
                  return;
                }
                lastMouseClientX = mouseEvent.clientX;
                lastMouseClientY = mouseEvent.clientY;
              }

              if (e.element && e.element.item) {
                const currentFocus = this._tree.getFocus();
                if (!currentFocus || currentFocus[0] !== e.element) {
                  this._tree.setFocus([e.element]);
                }
              }
            })
          );
        }
      };
    }
  } catch (e) {
    console.warn('Failed to patch QuickInputTree hover focus:', e);
  }

  // 6. DOM MutationObserver 深度监听
  if (typeof document !== 'undefined') {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const added of Array.from(m.addedNodes)) {
          if (added instanceof HTMLElement) {
            const items = added.querySelectorAll<HTMLElement>('.action-item, .action-menu-item');
            if (items.length) {
              items.forEach(formatMenuItem);
            } else if (added.classList.contains('action-item') || added.classList.contains('action-menu-item')) {
              formatMenuItem(added);
            }
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }
}

