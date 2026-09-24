import { describe, it, expect } from 'vitest';
import type { OpenTab } from '@deepseek-ide/shared';
import { isUntitledPath, untitledTabLabel } from '../src/renderer/src/utils';

describe('Unsaved Changes & Close Confirmation Logic', () => {
  const sampleTabs: OpenTab[] = [
    { path: 'src/main.ts', content: 'console.log("hello");', language: 'typescript', dirty: false },
    { path: 'src/app.tsx', content: 'export const App = () => <div>Dirty</div>;', language: 'typescriptreact', dirty: true },
    { path: 'untitled:Untitled-1', content: '', language: 'plaintext', dirty: true }, // empty untitled
    { path: 'untitled:Untitled-2', content: 'some notes', language: 'plaintext', dirty: true }, // dirty untitled with content
    { path: 'README.md', content: '# Readme', language: 'markdown', dirty: false },
  ];

  it('determines whether a tab requires unsaved confirmation upon close', () => {
    const shouldPromptUnsaved = (tab: OpenTab) => {
      return (
        tab.dirty &&
        tab.language !== 'image' &&
        !tab.previewUrl &&
        !(isUntitledPath(tab.path) && !tab.content)
      );
    };

    // Clean file -> no prompt
    expect(shouldPromptUnsaved(sampleTabs[0])).toBe(false);
    // Modified workspace file -> prompt
    expect(shouldPromptUnsaved(sampleTabs[1])).toBe(true);
    // Brand new empty untitled -> no prompt (clean close)
    expect(shouldPromptUnsaved(sampleTabs[2])).toBe(false);
    // Untitled with user typed content -> prompt
    expect(shouldPromptUnsaved(sampleTabs[3])).toBe(true);
    // Clean readme -> no prompt
    expect(shouldPromptUnsaved(sampleTabs[4])).toBe(false);
  });

  it('formats display file name and path correctly for modal header', () => {
    const formatModalInfo = (tab: OpenTab) => {
      const isUntitled = isUntitledPath(tab.path);
      const fileName = isUntitled
        ? `未命名 ${untitledTabLabel(tab.path)}`
        : tab.path.split(/[/\\]/).filter(Boolean).pop() || tab.path;
      const filePath = isUntitled ? '未保存的新建文件' : tab.path;
      return { fileName, filePath };
    };

    expect(formatModalInfo(sampleTabs[1])).toEqual({
      fileName: 'app.tsx',
      filePath: 'src/app.tsx',
    });

    expect(formatModalInfo(sampleTabs[3])).toEqual({
      fileName: '未命名 Untitled-2',
      filePath: '未保存的新建文件',
    });
  });

  it('correctly partitions dirty and non-dirty files for batch close (close others, close all)', () => {
    const shouldPromptUnsaved = (tab: OpenTab) => {
      return (
        tab.dirty &&
        tab.language !== 'image' &&
        !tab.previewUrl &&
        !(isUntitledPath(tab.path) && !tab.content)
      );
    };

    // Simulate "Close Others" keeping sampleTabs[0]
    const others = sampleTabs.filter((t) => t.path !== sampleTabs[0].path);
    const nonDirtyToClose = others.filter((t) => !shouldPromptUnsaved(t));
    const dirtyToQueue = others.filter((t) => shouldPromptUnsaved(t));

    expect(nonDirtyToClose.map((t) => t.path)).toEqual([
      'untitled:Untitled-1',
      'README.md',
    ]);
    expect(dirtyToQueue.map((t) => t.path)).toEqual([
      'src/app.tsx',
      'untitled:Untitled-2',
    ]);
  });
});
