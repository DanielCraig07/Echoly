import { describe, expect, it } from 'vitest';
import { APP_THEME_TOKENS, buildVscodeThemeVars } from '../src/renderer/src/services/vscodeTheme';

/**
 * 扩展界面的主题变量映射。
 *
 * 为什么值得钉：扩展界面的每一处颜色都写成 `var(--vscode-…)`，这些变量在 VS Code 里
 * 由宿主注入。少一个不会报错、不会崩，只是那一块**没上色** —— 界面上看起来就是
 * 「和主题对不上的一块灰」。所以这里断言的是「关键的那几个必须在，且不是空串」。
 */
describe('--vscode-* 主题变量', () => {
  const tokens = {
    '--bg-panel': '#141414',
    '--bg-editor': '#1e1e1e',
    '--text': '#cccccc',
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
    '--font-ui': 'system-ui, sans-serif',
    '--font-mono': 'Menlo, monospace',
    '--ui-font-size': '13px',
  };

  it('把自有 token 映射成扩展认识的名字，且带上真实值', () => {
    const vars = buildVscodeThemeVars(tokens);
    expect(vars['editor-background']).toBe('#1e1e1e');
    expect(vars['editor-foreground']).toBe('#cccccc');
    expect(vars['sideBar-background']).toBe('#141414');
    expect(vars['button-background']).toBe('#007acc');
    expect(vars['focusBorder']).toBe('#007acc');
    expect(vars['errorForeground']).toBe('#f14c4c');
  });

  it('字体也要给：不给的话扩展界面会退回浏览器默认的 16px', () => {
    const vars = buildVscodeThemeVars(tokens);
    expect(vars['font-family']).toBe('system-ui, sans-serif');
    expect(vars['font-size']).toBe('13px');
    expect(vars['editor-font-family']).toBe('Menlo, monospace');
    expect(vars['chat-font-size']).toBe('13px');
  });

  it('一个值都不许是空串（空值会让 var() 整条声明作废，比没定义还难查）', () => {
    const vars = buildVscodeThemeVars(tokens);
    for (const [name, value] of Object.entries(vars)) {
      expect(value, `${name} 是空串`).not.toBe('');
    }
  });

  it('token 缺失时用兜底值，而不是留空', () => {
    // 模拟「token 改名了 / 亮色主题里没定义」
    const vars = buildVscodeThemeVars({});
    expect(vars['editor-background']).toBeTruthy();
    expect(vars['foreground']).toBeTruthy();
    expect(vars['button-background']).toBeTruthy();
  });

  it('读取清单里的 token 与映射用到的名字是有交集的（防止两边各自改名）', () => {
    const vars = buildVscodeThemeVars(tokens);
    // 清单本身要覆盖映射真正依赖的那几个：少一个就会静默退回兜底暗色，
    // 亮色主题下表现为「扩展界面还是暗的」
    for (const name of ['--bg-editor', '--text', '--accent', '--font-ui', '--ui-font-size']) {
      expect(APP_THEME_TOKENS as readonly string[]).toContain(name);
      void vars;
    }
  });
});
