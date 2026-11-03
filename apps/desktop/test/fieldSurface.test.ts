import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * 输入框底色的对账：**不允许在 JSX 内联样式里给输入框写死颜色**。
 *
 * 为什么值得专门立一条：这不是「好不好看」的问题，是「能不能看见」的问题。
 * 一个输入框的底色如果和它所在容器一样，界面上只剩一圈边框 —— 用户看到的是
 * 「这里什么都没有」。而这个坑在本仓里踩了**四十次**，全是一个原因：
 * 容器换了（面板/弹窗/编辑器），输入框还在用上一档的色值或写死的 `#0d0d0d`。
 *
 * 规则（三种容器底对应三个 token，见 styles.css 里的说明）：
 *   --bg-elevated      面板（左侧栏 / 底部面板 / 右侧面板）上的输入框
 *   --bg-field         弹窗 / 下拉 / popover 上的输入框
 *   --bg-field-inset   编辑器表面上的浮层输入框
 *
 * 这条测试只扫**内联样式**（JSX 里 `<input style={{ background: '#xxx' }}>` 这种）。
 * 走 class 的输入框（`.git-modal-input` 之类）在 styles.css 里，得靠人看；
 * 扫描纯 CSS 判「容器是什么」需要真的渲染，那是另一件事。
 */

const COMPONENTS_ROOT = join(__dirname, '../src/renderer/src/components');

/** 这些 token 的语义是「某个容器自身的底色」，拿来做输入框底色必然和容器撞色。 */
const FORBIDDEN_TOKENS = [
  '--bg-input',
  '--bg-editor',
  '--bg-tertiary',
  '--bg-lighter',
  '--bg-panel',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** 取 `style={{ ... }}` 那一段（从字段标签往后找，遇到标签结束就停）。 */
function styleWindow(lines: string[], startIndex: number): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  for (let i = startIndex; i < Math.min(startIndex + 16, lines.length); i += 1) {
    const line = lines[i];
    if (i > startIndex && (line.includes('/>') || /<\/?(input|textarea|select)\b/.test(line)))
      break;
    out.push({ text: line, line: i + 1 });
  }
  return out;
}

/** 数一数扫到了多少「字段标签」与「字段上的 background 行」，防止这条守卫空转。 */
function scanStats(): { files: number; fields: number; backgrounds: number } {
  let fields = 0;
  let backgrounds = 0;
  const files = walk(COMPONENTS_ROOT);
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!/<(input|textarea|select)\b/.test(lines[i])) continue;
      fields += 1;
      for (const { text } of styleWindow(lines, i)) {
        if (text.trim().startsWith('background')) backgrounds += 1;
      }
    }
  }
  return { files: files.length, fields, backgrounds };
}

describe('输入框底色', () => {
  const files = walk(COMPONENTS_ROOT);

  it('守卫本身扫到了东西（否则它只是空转着通过）', () => {
    const stats = scanStats();
    expect(stats.files).toBeGreaterThan(50);
    expect(stats.fields).toBeGreaterThan(100);
    // 40 多处输入框都带内联底色 —— 这个下限掉了就说明正则/结构变了，守卫已经失效
    expect(stats.backgrounds).toBeGreaterThan(20);
  });

  it('内联样式里不给输入框写死颜色', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!/<(input|textarea|select)\b/.test(lines[i])) continue;
        for (const { text, line } of styleWindow(lines, i)) {
          if (!text.trim().startsWith('background')) continue;
          // 允许：token、transparent（底色由外层 wrapper 提供）
          if (/var\(--/.test(text)) continue;
          if (/'(transparent|none|inherit)'/.test(text)) continue;
          offenders.push(`${relative(COMPONENTS_ROOT, file)}:${line} ${text.trim()}`);
        }
      }
    }
    expect(
      offenders,
      '输入框底色的写死值会让它在浅色/深色主题下与容器撞色。改用 --bg-elevated（面板）/ --bg-field（弹窗）/ --bg-field-inset（编辑器表面）',
    ).toEqual([]);
  });

  it('内联样式里不给输入框用「容器自身的底色」token', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!/<(input|textarea|select)\b/.test(lines[i])) continue;
        for (const { text, line } of styleWindow(lines, i)) {
          if (!text.trim().startsWith('background')) continue;
          const hit = FORBIDDEN_TOKENS.find((token) => text.includes(`var(${token}`));
          if (hit) {
            offenders.push(
              `${relative(COMPONENTS_ROOT, file)}:${line} 用了 ${hit} —— 那是容器自己的底色`,
            );
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
