import { describe, it, expect, vi } from 'vitest';

describe('Editor Block Selection & Multi-cursor Move', () => {
  it('suppresses AI floating toolbar when block selection produces multiple selections', () => {
    let selectionCoords: { top: number; left: number } | null = { top: 100, left: 200 };

    const handleSelectionChange = (editor: {
      getSelection: () => { isEmpty: () => boolean } | null;
      getSelections: () => Array<{ isEmpty: () => boolean }> | null;
    }) => {
      const sel = editor.getSelection();
      const selections = editor.getSelections();

      // 多选区/块选择时，清空坐标，抑制 AI 悬浮工具条
      if (selections && selections.length > 1) {
        selectionCoords = null;
        return;
      }

      if (!sel || sel.isEmpty()) {
        selectionCoords = null;
        return;
      }

      selectionCoords = { top: 100, left: 200 };
    };

    // 1. 普通单区域文本选择：显示 AI 浮层
    handleSelectionChange({
      getSelection: () => ({ isEmpty: () => false }),
      getSelections: () => [{ isEmpty: () => false }],
    });
    expect(selectionCoords).toEqual({ top: 100, left: 200 });

    // 2. Shift + Option + 鼠标拖拽产生多行矩形块选区：清空坐标，彻底抑制 AI 浮层
    handleSelectionChange({
      getSelection: () => ({ isEmpty: () => false }),
      getSelections: () => Array(8).fill({ isEmpty: () => false }),
    });
    expect(selectionCoords).toBeNull();
  });

  it('proxies Option+Left Click into Shift+Option+Left Click to drive Monaco native _columnSelect', () => {
    let dispatchedEvent: any = null;
    const mockTarget = {
      dispatchEvent: vi.fn((evt) => {
        dispatchedEvent = evt;
      }),
    };

    const mockEditor = {
      getSelections: () => [
        { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
        { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
      ],
    };

    const handlePointerOrMouseDown = (e: {
      button: number;
      shiftKey: boolean;
      altKey?: boolean;
      metaKey?: boolean;
      type: string;
      preventDefault: () => void;
      stopPropagation: () => void;
      stopImmediatePropagation: () => void;
      target: any;
      __echolyShiftPatched?: boolean;
    }) => {
      if (e.__echolyShiftPatched) return false;
      if (e.button !== 0) return false;
      if (e.shiftKey) return false;
      const isOption = e.altKey || e.metaKey;
      if (!isOption) return false;

      const selections = mockEditor.getSelections();
      if (!selections || selections.length <= 1) return false;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const patched = {
        type: e.type,
        button: 0,
        altKey: true,
        shiftKey: true, // 核心：自动补齐 Shift 键
        __echolyShiftPatched: true,
      };
      e.target.dispatchEvent(patched);
      return true;
    };

    const incomingEvent = {
      type: 'mousedown',
      button: 0,
      shiftKey: false,
      altKey: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
      target: mockTarget,
    };

    const intercepted = handlePointerOrMouseDown(incomingEvent);
    expect(intercepted).toBe(true);
    expect(incomingEvent.stopImmediatePropagation).toHaveBeenCalled();
    expect(mockTarget.dispatchEvent).toHaveBeenCalled();
    expect(dispatchedEvent.shiftKey).toBe(true);
    expect(dispatchedEvent.altKey).toBe(true);
    expect(dispatchedEvent.__echolyShiftPatched).toBe(true);
  });
});
