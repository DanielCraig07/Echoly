import { describe, expect, it } from 'vitest';
import { stripRawHtml } from '../src/renderer/src/services/extensionReadme';

/**
 * README 预处理。这里的两类错误都要防：
 * 标签没删干净（正文里露出一行 `<img ...>`），以及**删过头**
 * （把示例代码里的 HTML 一起删了，等于篡改文档）。
 */

describe('stripRawHtml', () => {
  it('删掉整行的原始 HTML，并收掉留下的空行', () => {
    const input = [
      'Overview',
      '',
      'The extension helps you manage environments.',
      '',
      '<img src="https://raw.githubusercontent.com/ms/vscode-python-environments/main/images/x.gif" width=734 height=413>',
      '',
      '## Features',
    ].join('\n');
    const out = stripRawHtml(input);
    expect(out).not.toContain('<img');
    expect(out).not.toContain('raw.githubusercontent');
    // 整行被丢掉了，而不是留下一片空行
    expect(out).not.toContain('\n\n\n');
    expect(out).toContain('## Features');
  });

  it('行内标签只删标签本身，文字保留', () => {
    expect(stripRawHtml('这是一个 <b>重点</b> 说明')).toBe('这是一个 重点 说明');
    expect(stripRawHtml('换行<br>继续')).toBe('换行继续');
  });

  it('代码块里的 HTML 一行都不动', () => {
    const input = ['```html', '<img src="keep-me.png">', '</div>', '```'].join('\n');
    expect(stripRawHtml(input)).toBe(input);
  });

  it('代码块外的标签删掉后，围栏状态不受影响', () => {
    const input = [
      '<div align="center">',
      'text',
      '</div>',
      '',
      '```js',
      'const a = 1;',
      '```',
    ].join('\n');
    const out = stripRawHtml(input);
    expect(out).toContain('```js');
    expect(out).toContain('const a = 1;');
    expect(out).toContain('text');
    expect(out).not.toContain('<div');
  });

  it('HTML 注释整段删掉', () => {
    expect(stripRawHtml('前<!-- 说明 -->后')).toBe('前后');
  });

  it('正文里的数学写法不会被当成标签吃掉', () => {
    // 白名单的用意就在这条：`a<b` 后面那个 b 不在标签名表里
    expect(stripRawHtml('判断 a<b 且 c>d 的关系')).toBe('判断 a<b 且 c>d 的关系');
  });

  it('markdown 本身（表格 / 链接 / 强调）原样保留', () => {
    const input = [
      '| Id | Name |',
      '| -- | ---- |',
      '| a  | b    |',
      '',
      '[链接](https://x.com) **粗**',
    ].join('\n');
    expect(stripRawHtml(input)).toBe(input);
  });

  it('空输入不炸', () => {
    expect(stripRawHtml('')).toBe('');
  });
});
