import { describe, it, expect, beforeEach } from 'vitest';
import { calculateModalResize, loadModalSize } from '../src/renderer/src/hooks/useModalResize';

describe('calculateModalResize', () => {
  it('correctly resizes bidirectionally (up, down, left, right) in centered mode', () => {
    // 初始 800x600，鼠标向右拖动 50px，向下拖动 30px
    // 居中模式下 factor=2，增加 100 宽，60 高
    const expanded = calculateModalResize({
      startX: 500,
      startY: 400,
      startW: 800,
      startH: 600,
      currentX: 550, // dx = +50
      currentY: 430, // dy = +30
      isCentered: true,
      minWidth: 400,
      minHeight: 300,
      maxWidth: 1200,
      maxHeight: 900,
    });
    expect(expanded.width).toBe(900);
    expect(expanded.height).toBe(660);

    // 鼠标向左拖动 40px，向上拖动 25px
    // 居中模式下减少 80 宽，50 高
    const contracted = calculateModalResize({
      startX: 500,
      startY: 400,
      startW: 800,
      startH: 600,
      currentX: 460, // dx = -40
      currentY: 375, // dy = -25
      isCentered: true,
      minWidth: 400,
      minHeight: 300,
      maxWidth: 1200,
      maxHeight: 900,
    });
    expect(contracted.width).toBe(720);
    expect(contracted.height).toBe(550);
  });

  it('clamps within minWidth/maxWidth and minHeight/maxHeight bounds', () => {
    const clampedMax = calculateModalResize({
      startX: 100,
      startY: 100,
      startW: 800,
      startH: 600,
      currentX: 1000,
      currentY: 1000,
      isCentered: true,
      minWidth: 400,
      minHeight: 300,
      maxWidth: 1000,
      maxHeight: 800,
    });
    expect(clampedMax.width).toBe(1000);
    expect(clampedMax.height).toBe(800);

    const clampedMin = calculateModalResize({
      startX: 500,
      startY: 500,
      startW: 800,
      startH: 600,
      currentX: 10,
      currentY: 10,
      isCentered: true,
      minWidth: 400,
      minHeight: 300,
      maxWidth: 1000,
      maxHeight: 800,
    });
    expect(clampedMin.width).toBe(400);
    expect(clampedMin.height).toBe(300);
  });

  it('handles non-centered mode with factor 1', () => {
    const res = calculateModalResize({
      startX: 100,
      startY: 100,
      startW: 500,
      startH: 400,
      currentX: 150, // dx = +50
      currentY: 120, // dy = +20
      isCentered: false,
    });
    expect(res.width).toBe(550);
    expect(res.height).toBe(420);
  });
});

describe('loadModalSize', () => {
  let store: Record<string, string> = {};

  beforeEach(() => {
    store = {};
    const mockStorage = {
      getItem: (k: string) => store[k] || null,
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
    (globalThis as any).window = { innerWidth: 1440, innerHeight: 900 };
    (globalThis as any).localStorage = mockStorage;
  });

  it('falls back to default size when storage is empty', () => {
    const size = loadModalSize('non_existent_key', 720, 540);
    expect(size.width).toBe(720);
    expect(size.height).toBe(540);
  });

  it('parses valid stored dimensions and clamps them', () => {
    (globalThis.localStorage as any).setItem('modal_test', JSON.stringify({ width: 9999, height: 10 }));
    const size = loadModalSize('modal_test', 720, 540, 400, 300, 1200, 900);
    expect(size.width).toBe(1200);
    expect(size.height).toBe(300);
  });
});
