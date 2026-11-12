import { describe, expect, it } from 'vitest';
import {
  buildAiPanelEntries,
  type InstalledForEntries,
} from '../src/renderer/src/services/aiPanelEntries';

/**
 * 标题栏那几个 AI 面板入口。
 *
 * 用户踩过的坑：入口是从「固定列表」推出来的，于是**装完扩展还得先去扩展面板点一次
 * 「打开」**，右上角才会冒出图标 —— 两件事看起来毫无关系。所以这里钉住「装了就有」。
 */
describe('buildAiPanelEntries', () => {
  const claude: InstalledForEntries = {
    id: 'Anthropic.claude-code',
    displayName: 'Claude Code',
    active: true,
    views: [
      { id: 'claudeVSCodeSidebar', name: 'Claude Code', icon: 'data:image/svg+xml;base64,AAA' },
      {
        id: 'claudeVSCodeSidebarSecondary',
        name: 'Claude Code',
        icon: 'data:image/svg+xml;base64,AAA',
      },
      { id: 'claudeVSCodeSessionsList', name: 'claudeVSCodeSessionsList' },
    ],
  };
  const codex: InstalledForEntries = {
    id: 'openai.chatgpt',
    displayName: 'Codex',
    active: true,
    views: [{ id: 'chatgpt.sidebarView', name: 'Codex', icon: 'data:image/svg+xml;base64,BBB' }],
  };

  it('一个扩展一个入口 —— 不该因为 Claude 有三个视图就冒出三个图标', () => {
    const entries = buildAiPanelEntries([claude, codex], ['claudeVSCodeSidebar'], new Set());
    expect(entries.map((e) => e.viewId)).toEqual(['claudeVSCodeSidebar', 'chatgpt.sidebarView']);
  });

  it('没固定过的扩展也有入口（装了就出现，不必先去点一次「打开」）', () => {
    const entries = buildAiPanelEntries([codex], [], new Set());
    expect(entries).toHaveLength(1);
    expect(entries[0].viewId).toBe('chatgpt.sidebarView');
    expect(entries[0].title).toBe('Codex');
    expect(entries[0].icon).toContain('base64');
  });

  it('一个扩展多个视图时优先取已经固定的那个', () => {
    const entries = buildAiPanelEntries([claude], ['claudeVSCodeSessionsList'], new Set());
    expect(entries[0].viewId).toBe('claudeVSCodeSessionsList');
    // 没固定就退回它注册的第一个（manifest/注册顺序，稳定）
    const fallback = buildAiPanelEntries([claude], [], new Set());
    expect(fallback[0].viewId).toBe('claudeVSCodeSidebar');
  });

  it('没贡献视图的扩展不占位置（点了也是空的）', () => {
    const entries = buildAiPanelEntries(
      [{ id: 'cweijan.vscode-office', displayName: 'Office Viewer', active: true, views: [] }],
      [],
      new Set(),
    );
    expect(entries).toEqual([]);
  });

  it('可用性看 active，也认已加载列表（大小写不敏感）', () => {
    const inactive: InstalledForEntries = { ...codex, active: false };
    expect(buildAiPanelEntries([inactive], [], new Set(['openai.chatgpt']))[0].available).toBe(
      true,
    );
    expect(buildAiPanelEntries([inactive], [], new Set())[0].available).toBe(false);
  });

  it('视图没有名字时退回扩展名（标题栏至少有个 tooltip）', () => {
    const entries = buildAiPanelEntries(
      [{ id: 'x.y', displayName: 'X Y', active: true, views: [{ id: 'x.yPane' }] }],
      [],
      new Set(),
    );
    expect(entries[0].title).toBe('X Y');
  });

  it('被禁用的扩展不显示（安装但禁用 = 标题栏自动隐藏入口）', () => {
    const disabledCodex: InstalledForEntries = { ...codex, enabled: false };
    const entries = buildAiPanelEntries([claude, disabledCodex], [], new Set());
    expect(entries.map((e) => e.extensionId)).toEqual(['Anthropic.claude-code']);
  });
});
