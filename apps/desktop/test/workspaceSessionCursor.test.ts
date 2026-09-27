import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveWorkspaceOpenFiles,
  loadWorkspaceOpenFiles,
  clearWorkspaceOpenFiles,
} from '../src/renderer/src/workspaceSession';

describe('Workspace Session Open Files & Cursor Persistence', () => {
  beforeEach(() => {
    let store: Record<string, string> = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
      clear: () => {
        store = {};
      },
    };
  });

  it('persists and restores open files with exact cursor line and column numbers', () => {
    const root = '/Users/test/my-project';
    const paths = [
      '/Users/test/my-project/src/index.ts',
      '/Users/test/my-project/src/utils.ts',
    ];
    const activePath = '/Users/test/my-project/src/index.ts';
    const cursorPositions = {
      '/Users/test/my-project/src/index.ts': { line: 42, col: 10, scrollTop: 650, scrollLeft: 0 },
      '/Users/test/my-project/src/utils.ts': { line: 128, col: 5, scrollTop: 1820, scrollLeft: 20 },
    };

    saveWorkspaceOpenFiles(root, paths, activePath, cursorPositions, 42, 10, 650, 0);

    const restored = loadWorkspaceOpenFiles(root);
    expect(restored).not.toBeNull();
    expect(restored?.paths).toEqual(paths);
    expect(restored?.activePath).toBe(activePath);
    expect(restored?.activeLine).toBe(42);
    expect(restored?.activeCol).toBe(10);
    expect(restored?.activeScrollTop).toBe(650);
    expect(restored?.activeScrollLeft).toBe(0);
    expect(restored?.cursorPositions?.[activePath]).toEqual({ line: 42, col: 10, scrollTop: 650, scrollLeft: 0 });
    expect(restored?.cursorPositions?.['/Users/test/my-project/src/utils.ts']).toEqual({ line: 128, col: 5, scrollTop: 1820, scrollLeft: 20 });
  });

  it('clears saved session correctly', () => {
    const root = '/Users/test/sample-repo';
    saveWorkspaceOpenFiles(root, ['/file.ts'], '/file.ts', { '/file.ts': { line: 10 } }, 10, 1);
    expect(loadWorkspaceOpenFiles(root)).not.toBeNull();

    clearWorkspaceOpenFiles(root);
    expect(loadWorkspaceOpenFiles(root)).toBeNull();
  });
});
