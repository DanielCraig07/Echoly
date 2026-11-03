import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PINNED_PANELS,
  availablePanels,
  normalizePinned,
  togglePinned,
} from '../src/renderer/src/services/leftPanels';

describe('availablePanels', () => {
  it('Maven 只在 Maven 项目里出现，数据库始终有', () => {
    expect(availablePanels(false).map((d) => d.id)).toEqual([
      'explorer',
      'search',
      'git',
      'extensions',
      'database',
    ]);
    expect(availablePanels(true).map((d) => d.id)).toContain('maven');
  });

  it('被有意停用的面板不进菜单', () => {
    // agent-tasks 在 App.tsx 里有守卫把它弹回 explorer，列出来就是点不动的入口
    expect(availablePanels(true).map((d) => d.id)).not.toContain('agent-tasks');
  });

  it('菜单里印出来的快捷键必须是我们真的处理了的那些', () => {
    const withShortcut = availablePanels(true).filter((d) => d.shortcut);
    expect(withShortcut.map((d) => d.id).sort()).toEqual([
      'explorer',
      'extensions',
      'git',
      'search',
    ]);
  });
});

describe('normalizePinned', () => {
  it('存档不是数组时退回默认值', () => {
    for (const bad of [undefined, null, 'explorer', 42, {}]) {
      expect(normalizePinned(bad, false)).toEqual(DEFAULT_PINNED_PANELS);
    }
  });

  it('丢掉未知 id、重复项与当前项目用不到的面板', () => {
    // 存档可能来自另一台机器 / 另一个项目：未知 id 渲染出来是个点不动的图标
    expect(normalizePinned(['explorer', 'explorer', 'nope', 'agent-tasks'], false)).toEqual([
      'explorer',
    ]);
    // Maven 在非 Maven 项目里不可用，固定了也不该渲染
    expect(normalizePinned(['maven'], false)).toEqual([]);
    expect(normalizePinned(['maven'], true)).toEqual(['maven']);
  });

  it('空数组是合法的（用户把图标全取消了固定）', () => {
    // 退回默认值会让「取消固定」看起来没生效
    expect(normalizePinned([], false)).toEqual([]);
  });
});

describe('togglePinned', () => {
  it('来回切一次回到原状', () => {
    const once = togglePinned(DEFAULT_PINNED_PANELS, 'database', false);
    expect(once).toContain('database');
    expect(togglePinned(once, 'database', false)).toEqual(DEFAULT_PINNED_PANELS);
  });

  it('允许取消到空 —— 活动栏上还有 chevron，不是死路', () => {
    let pinned = [...DEFAULT_PINNED_PANELS];
    for (const id of DEFAULT_PINNED_PANELS) pinned = togglePinned(pinned, id, false);
    expect(pinned).toEqual([]);
  });
});
