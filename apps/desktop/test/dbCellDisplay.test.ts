import { describe, expect, it } from 'vitest';
import { formatCellValue, formatDateValue } from '../src/renderer/src/services/dbCellDisplay';

describe('formatDateValue · 本地时间格式化', () => {
  it('按本地时间输出 YYYY-MM-DD HH:mm:ss（不带 JSON 引号）', () => {
    // 用本地时间构造函数，避免测试结果随运行机器的时区漂移
    const d = new Date(2024, 0, 2, 3, 4, 5);
    expect(formatDateValue(d)).toBe('2024-01-02 03:04:05');
  });

  it('毫秒为零时不显示小数秒，非零时补齐三位', () => {
    expect(formatDateValue(new Date(2024, 5, 1, 0, 0, 0, 0))).toBe('2024-06-01 00:00:00');
    expect(formatDateValue(new Date(2024, 5, 1, 0, 0, 0, 7))).toBe('2024-06-01 00:00:00.007');
  });

  it('月 / 日 / 时 / 分 / 秒都补零到两位', () => {
    expect(formatDateValue(new Date(2024, 8, 9, 1, 2, 3))).toBe('2024-09-09 01:02:03');
  });

  it('非法日期给出可读文案而不是 Invalid Date 的 undefined 拼串', () => {
    expect(formatDateValue(new Date('nonsense'))).toBe('Invalid Date');
  });
});

describe('formatCellValue · 单元格显示', () => {
  it('null / undefined 都返回空串（显示成 NULL 还是留白交给调用方）', () => {
    expect(formatCellValue(null)).toBe('');
    expect(formatCellValue(undefined)).toBe('');
  });

  it('Date 走本地时间格式化：不再输出带引号的 UTC ISO 串', () => {
    const out = formatCellValue(new Date(2024, 0, 2, 3, 4, 5));
    expect(out).toBe('2024-01-02 03:04:05');
    expect(out.startsWith('"')).toBe(false);
    expect(out.includes('T')).toBe(false);
    expect(out.includes('Z')).toBe(false);
  });

  it('字符串原样返回，不加引号', () => {
    expect(formatCellValue('2024-01-02 03:04:05')).toBe('2024-01-02 03:04:05');
  });

  it('数字 / 布尔转字符串，0 与 false 不被当成空', () => {
    expect(formatCellValue(0)).toBe('0');
    expect(formatCellValue(12.5)).toBe('12.5');
    expect(formatCellValue(false)).toBe('false');
  });

  it('普通对象走 JSON', () => {
    expect(formatCellValue({ a: 1 })).toBe('{"a":1}');
    expect(formatCellValue([1, 2])).toBe('[1,2]');
  });

  it('二进制列给出长度而不是一堆乱码', () => {
    expect(formatCellValue(new Uint8Array([1, 2, 3]))).toBe('<binary 3 bytes>');
  });

  it('循环引用不会让渲染崩掉', () => {
    const cyclic: any = { a: 1 };
    cyclic.self = cyclic;
    expect(typeof formatCellValue(cyclic)).toBe('string');
    expect(formatCellValue(cyclic).length).toBeGreaterThan(0);
  });
});
