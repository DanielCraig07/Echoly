import { describe, expect, it } from 'vitest';
import {
  formatDownloadCount,
  formatRating,
  friendlyExtensionName,
  iconInitial,
  publisherOf,
} from '../src/renderer/src/services/extensionDisplay';

describe('formatDownloadCount', () => {
  it('按量级选单位，并丢掉没信息量的小数位', () => {
    expect(formatDownloadCount(34000000)).toBe('34M');
    expect(formatDownloadCount(7200000)).toBe('7.2M');
    expect(formatDownloadCount(410000)).toBe('410K');
    expect(formatDownloadCount(1200)).toBe('1.2K');
    expect(formatDownloadCount(87)).toBe('87');
  });

  it('缺值时返回空串，让调用方整块不渲染', () => {
    // 返回 '0' 会在界面上显示成「0 次下载」，那是另一件事
    expect(formatDownloadCount(undefined)).toBe('');
    expect(formatDownloadCount(NaN)).toBe('');
    expect(formatDownloadCount(-5)).toBe('');
  });
});

describe('formatRating', () => {
  it('整数不带 .0，小数保留一位', () => {
    expect(formatRating(4)).toBe('4');
    expect(formatRating(4.5)).toBe('4.5');
  });

  it('没有评分返回空串（0 分不是「零分」，是「没人评」）', () => {
    expect(formatRating(0)).toBe('');
    expect(formatRating(undefined)).toBe('');
  });
});

describe('publisherOf', () => {
  it('取 id 的第一段', () => {
    expect(publisherOf('ms-python.python')).toBe('ms-python');
    expect(publisherOf('Anthropic.claude-code')).toBe('Anthropic');
  });

  it('没有分隔点时整体返回，不瞎猜', () => {
    expect(publisherOf('vim')).toBe('vim');
  });
});

describe('friendlyExtensionName', () => {
  it('把 id 的尾段变成可读标题', () => {
    expect(friendlyExtensionName('Anthropic.claude-code')).toBe('Claude Code');
    expect(friendlyExtensionName('ms-python.vscode-python-envs')).toBe('Vscode Python Envs');
    expect(friendlyExtensionName('redhat.java')).toBe('Java');
  });

  it('下划线与多段连字符同样处理', () => {
    expect(friendlyExtensionName('a.b_c-d')).toBe('B C D');
  });

  it('没有分隔点或尾段为空时退回 id 本身', () => {
    expect(friendlyExtensionName('vim')).toBe('Vim');
    expect(friendlyExtensionName('publisher.')).toBe('publisher.');
  });
});

describe('iconInitial', () => {
  it('取标题首字符，非字母也能用', () => {
    expect(iconInitial('Claude Code')).toBe('C');
    expect(iconInitial('  中文扩展')).toBe('中');
  });

  it('空标题给一个占位符而不是空白方块', () => {
    expect(iconInitial('   ')).toBe('?');
  });
});
