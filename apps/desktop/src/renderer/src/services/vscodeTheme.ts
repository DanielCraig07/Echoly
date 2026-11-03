/**
 * 把本应用的主题 token 翻译成扩展界面认识的 `--vscode-*` 变量。
 *
 * 为什么需要：扩展的 webview 界面（Claude Code 的侧栏、Office Viewer 的预览…）里
 * 几乎每一处颜色都写成 `var(--vscode-editor-background)` 这种形式 —— 在 VS Code 里
 * 这些变量由 webview 宿主注入。我们不注入的话它们全是未定义，于是：
 * 背景变成 `background: var(--vscode-editor-background)` 解析失败后的默认值
 * （界面上看就是一块和主题对不上、明显偏亮的灰），文字、按钮、滚动条同理。
 *
 * 变量清单不是照抄 VS Code 文档，而是**按真实扩展用到的那批**取的：
 * 实测 Claude Code 的 `webview/index.css` 引用了 258 个不同的 `--vscode-*`，
 * 这里覆盖其中出现频次最高、且我们能从自有 token 合理映射过来的那些。
 * 没覆盖到的仍然会退化成未定义 —— 宁可少给，也不要给一个和主题无关的假色。
 *
 * 这个文件只做「token → 变量」的纯映射；读取 DOM 上的实际值在 readAppTokens 里，
 * 两者分开是为了让映射本身可单测（不需要 DOM）。
 */

/** 需要从 `:root` 上读的 token。刻意避开 `--fg: var(--text)` 这类**别名** —— */
/** getComputedStyle 拿到的是 `var(--text)` 这个字面量，不是解析后的颜色。 */
export const APP_THEME_TOKENS = [
  '--bg',
  '--bg-panel',
  '--bg-elevated',
  '--bg-editor',
  '--bg-field',
  '--bg-hover',
  '--bg-hover-strong',
  '--bg-code',
  '--bg-modal',
  '--text',
  '--text-bright',
  '--muted',
  '--accent',
  '--accent-2',
  '--accent-light',
  '--accent-soft',
  '--border',
  '--border-strong',
  '--danger',
  '--ok',
  '--warn',
  '--tool-name',
  '--font-ui',
  '--font-mono',
  '--ui-font-size',
] as const;

/** 没读到（token 改名 / 亮色主题里没定义）时用的兜底，保证变量不会是空串。 */
const FALLBACK: Record<string, string> = {
  '--bg': '#141414',
  '--bg-panel': '#141414',
  '--bg-elevated': '#1e1e1e',
  '--bg-editor': '#1e1e1e',
  '--bg-field': '#1e1e1e',
  '--bg-hover': 'rgba(255, 255, 255, 0.05)',
  '--bg-hover-strong': 'rgba(255, 255, 255, 0.09)',
  '--bg-code': '#141414',
  '--bg-modal': '#141414',
  '--text': '#cccccc',
  '--text-bright': '#ffffff',
  '--muted': '#858585',
  '--accent': '#007acc',
  '--accent-2': '#005999',
  '--accent-light': '#3794ff',
  '--accent-soft': 'rgba(0, 122, 204, 0.16)',
  '--border': 'rgba(255, 255, 255, 0.08)',
  '--border-strong': 'rgba(255, 255, 255, 0.14)',
  '--danger': '#f14c4c',
  '--ok': '#89d185',
  '--warn': '#cca700',
  '--tool-name': '#dcdcaa',
  '--font-ui':
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  '--font-mono': "'Cascadia Code', 'JetBrains Mono', Consolas, Menlo, Monaco, monospace",
  '--ui-font-size': '13px',
};

/** 从当前文档根上读一组 token。读不到就用兜底值。 */
export function readAppTokens(root?: HTMLElement | null): Record<string, string> {
  const node = root ?? (typeof document !== 'undefined' ? document.documentElement : null);
  const styles = node ? getComputedStyle(node) : null;
  const out: Record<string, string> = {};
  for (const name of APP_THEME_TOKENS) {
    const value = styles?.getPropertyValue(name)?.trim();
    out[name] = value || FALLBACK[name] || '';
  }
  return out;
}

/**
 * token → `--vscode-*`。
 *
 * 取值策略：能一一对应的直接对应（`--bg-editor` → `--vscode-editor-background`）；
 * 没有对应物的（滚动条滑块、diff 底色、终端 ANSI 色）用半透明黑/白或固定的
 * ANSI 调色板 —— 这些在 VS Code 里本来也是主题自己定的常数，和主色无关。
 */
export function buildVscodeThemeVars(tokens: Record<string, string>): Record<string, string> {
  const t = (name: string) => tokens[name] || FALLBACK[name] || '';

  return {
    // 字体。扩展界面的字号由 `--vscode-font-size` / `--vscode-chat-font-*` 决定，
    // 不注入的话它会退回浏览器默认的 16px —— Claude Code 的侧栏就是这么变大的。
    'font-family': t('--font-ui'),
    'font-size': t('--ui-font-size'),
    'font-weight': '400',
    'editor-font-family': t('--font-mono'),
    'editor-font-size': t('--ui-font-size'),
    'editor-font-weight': '400',
    'chat-font-family': t('--font-ui'),
    'chat-font-size': t('--ui-font-size'),
    'markdown-font-family': t('--font-ui'),
    'markdown-font-size': t('--ui-font-size'),
    'terminal-ansi-font-family': t('--font-mono'),
    'terminal-ansi-font-size': t('--ui-font-size'),

    // 编辑器 / 前景
    'editor-background': t('--bg-editor'),
    'editor-foreground': t('--text'),
    foreground: t('--text'),
    descriptionForeground: t('--muted'),
    disabledForeground: t('--muted'),
    'icon-foreground': t('--text'),
    'editorLineNumber-foreground': t('--muted'),
    'editorCodeLens-foreground': t('--muted'),
    'editorWhitespace-foreground': t('--muted'),
    'editorGhostText-foreground': t('--muted'),
    'editorGhostText-background': 'transparent',
    'editor-selectionBackground': t('--accent-soft'),
    'editor-inactiveSelectionBackground': t('--accent-soft'),
    'editorLink-activeForeground': t('--accent-light'),
    'editorLightBulb-foreground': t('--warn'),

    // 侧栏 / 面板 / 浮层
    'sideBar-background': t('--bg-panel'),
    'sideBar-foreground': t('--text'),
    'sideBarSectionHeader-background': t('--bg-elevated'),
    'panel-background': t('--bg-panel'),
    'panel-border': t('--border'),
    background: t('--bg-panel'),
    'editorWidget-background': t('--bg-elevated'),
    'editorWidget-foreground': t('--text'),
    'editorWidget-border': t('--border-strong'),
    'editorHoverWidget-background': t('--bg-elevated'),
    'editorHoverWidget-foreground': t('--text'),
    'editorHoverWidget-border': t('--border-strong'),
    'editorHoverWidget-statusBarBackground': t('--bg-elevated'),
    'widget-border': t('--border-strong'),
    'widget-shadow': 'rgba(0, 0, 0, 0.36)',
    'menu-background': t('--bg-field'),
    'menu-foreground': t('--text'),
    'menu-border': t('--border-strong'),
    'menu-selectionBackground': t('--accent'),
    'menu-selectionForeground': '#ffffff',
    'dropdown-background': t('--bg-field'),
    'dropdown-border': t('--border'),

    // 按钮 / 输入
    'button-background': t('--accent'),
    'button-foreground': '#ffffff',
    'button-hoverBackground': t('--accent-2'),
    'button-border': 'transparent',
    'button-secondaryBackground': t('--bg-elevated'),
    'button-secondaryHoverBackground': t('--bg-hover-strong'),
    'button-secondaryForeground': t('--text'),
    'input-background': t('--bg-field'),
    'input-foreground': t('--text'),
    'input-border': t('--border'),
    'input-placeholderForeground': t('--muted'),
    'inputOption-activeBorder': t('--accent'),
    'checkbox-background': t('--bg-field'),
    'checkbox-border': t('--border-strong'),
    'checkbox-foreground': t('--accent-light'),

    // 列表 / 焦点 / 徽标
    'list-hoverBackground': t('--bg-hover'),
    'list-activeSelectionBackground': t('--accent-soft'),
    'list-activeSelectionForeground': t('--text-bright'),
    'list-inactiveSelectionBackground': t('--bg-hover'),
    'list-focusOutline': t('--accent'),
    focusBorder: t('--accent'),
    'badge-background': t('--accent'),
    'badge-foreground': '#ffffff',
    'toolbar-hoverBackground': t('--bg-hover-strong'),
    'toolbar-activeBackground': t('--bg-hover-strong'),
    'sash-hoverBorder': t('--accent'),
    'sash-size': '4px',
    'sash-hover-size': '4px',
    contrastBorder: 'transparent',

    // 链接 / 代码 / 提示
    'textLink-foreground': t('--accent-light'),
    'textLink-activeForeground': t('--accent'),
    'textCodeBlock-background': t('--bg-code'),
    'textPreformat-foreground': t('--text'),
    'textPreformat-background': t('--bg-code'),
    'textBlockQuote-background': t('--bg-elevated'),
    'textBlockQuote-border': t('--border-strong'),
    errorForeground: t('--danger'),
    'editorError-foreground': t('--danger'),
    'editorWarning-foreground': t('--warn'),
    'editorInfo-foreground': t('--accent-light'),

    // diff
    'diffEditor-insertedTextBackground': 'rgba(74, 222, 128, 0.13)',
    'diffEditor-removedTextBackground': 'rgba(248, 81, 73, 0.13)',
    'diffEditor-move-border': t('--border-strong'),
    'diffEditor-moveActive-border': t('--accent'),
    'diffEditor-diagonalFill': t('--bg-hover'),

    // 滚动条 / 键位标签
    'scrollbar-shadow': 'rgba(0, 0, 0, 0.2)',
    'scrollbarSlider-background': 'rgba(121, 121, 121, 0.4)',
    'scrollbarSlider-hoverBackground': 'rgba(100, 100, 100, 0.7)',
    'scrollbarSlider-activeBackground': 'rgba(191, 191, 191, 0.4)',
    'keybindingLabel-background': t('--bg-elevated'),
    'keybindingLabel-foreground': t('--text'),
    'keybindingLabel-border': t('--border'),
    'keybindingLabel-bottomBorder': t('--border-strong'),

    // Git 装饰
    'gitDecoration-addedResourceForeground': t('--ok'),
    'gitDecoration-modifiedResourceForeground': t('--warn'),
    'gitDecoration-deletedResourceForeground': t('--danger'),
    'gitDecoration-untrackedResourceForeground': t('--ok'),
    'gitDecoration-ignoredResourceForeground': t('--muted'),

    // 图表 / 终端 ANSI（主题无关的固定调色板，VS Code 里也是常量）
    'charts-blue': '#3794ff',
    'charts-orange': '#d18616',
    'charts-green': '#89d185',
    'charts-red': '#f14c4c',
    'charts-purple': '#b180d7',
    'charts-yellow': '#cca700',
    'terminal-ansiBlack': '#000000',
    'terminal-ansiRed': '#cd3131',
    'terminal-ansiGreen': '#0dbc79',
    'terminal-ansiYellow': '#e5e510',
    'terminal-ansiBlue': '#2472c8',
    'terminal-ansiMagenta': '#bc3fbc',
    'terminal-ansiCyan': '#11a8cd',
    'terminal-ansiWhite': '#e5e5e5',
  };
}
