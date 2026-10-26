import type { Translate } from '../i18n';

export interface TechStyle {
  label: string;
  color: string;
  bg: string;
}

/**
 * 样式表按**内部标识**索引，`通用` / `目录` / `Git` 这几个是标识而不是文案：
 * 它们会被写进 `recent-workspaces` 的 `techStack` 字段落盘，也会在 App.tsx 里
 * 用 `tech === '通用'` 反复比较。翻成英文会同时改掉落盘数据和比较结果，
 * 所以标识保持不动，只有**渲染出来的 label** 走字典（见 detectTechBadge）。
 */
export const TECH_STYLES: Record<string, TechStyle> = {
  Java: { label: 'Java', color: '#fb923c', bg: 'rgba(251, 146, 60, 0.15)' },
  Node: { label: 'Node', color: '#4ade80', bg: 'rgba(74, 222, 128, 0.15)' },
  Python: { label: 'Python', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)' },
  'C++': { label: 'C++', color: '#818cf8', bg: 'rgba(129, 140, 248, 0.15)' },
  Go: { label: 'Go', color: '#2dd4bf', bg: 'rgba(45, 212, 191, 0.15)' },
  Rust: { label: 'Rust', color: '#f87171', bg: 'rgba(248, 113, 113, 0.15)' },
  通用: { label: '通用', color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.12)' },
  目录: { label: '目录', color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.12)' },
  Git: { label: '通用', color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.12)' },
};

/**
 * 获取技术栈标签样式（空值或遗留 Git 统一映射为通用）
 */
export function getTechStyle(label?: string): TechStyle {
  if (!label || label === 'Git') return TECH_STYLES.通用;
  return TECH_STYLES[label] || { label, color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.12)' };
}

/**
 * 启发式关键词检测（使用独立单词边界，杜绝任意子串误报，未匹配时归类为通用目录）
 */
export function heuristicDetectTech(name: string, path: string): string {
  const lower = `${name} ${path}`.toLowerCase();

  // 1. Java / Maven / Spring
  if (/\b(maven|java|spring|boot|jdk|tomcat)\b/i.test(lower) || lower.endsWith('.java')) {
    return 'Java';
  }

  // 2. Python / AI / CV
  if (
    /\b(python|django|flask|torch|pytorch|vision|yolo|opencv|cuda|cv|crawler|ai|fastapi)\b/i.test(
      lower,
    ) ||
    lower.endsWith('.py')
  ) {
    return 'Python';
  }

  // 3. C / C++
  if (
    /\b(cpp|c\+\+|cmake|clang|qt)\b/i.test(lower) ||
    lower.endsWith('.cpp') ||
    lower.endsWith('.cc') ||
    lower.endsWith('.h')
  ) {
    return 'C++';
  }

  // 4. Go
  if (/\b(golang|go)\b/i.test(lower) || lower.endsWith('.go')) {
    return 'Go';
  }

  // 5. Rust
  if (/\b(rust|cargo)\b/i.test(lower) || lower.endsWith('.rs')) {
    return 'Rust';
  }

  // 6. Node / Web
  if (
    /\b(node|nodejs|react|vue|angular|vite|nextjs|nuxt|electron|miniprogram|wechat|uniapp)\b/i.test(
      lower,
    ) ||
    lower.endsWith('.ts') ||
    lower.endsWith('.js')
  ) {
    return 'Node';
  }

  return '通用';
}

/**
 * 只有「不是某个具体语言」的两个标识需要翻：其余（Java / Node / Python / C++ / Go / Rust）
 * 在两种语言下写法相同，走字典只会多出一批同值的条目，还容易被误当成漏翻。
 */
const TECH_LABEL_KEY: Record<string, string> = {
  通用: 'tech.generic',
  目录: 'tech.directory',
};

/**
 * 统一获取技术栈徽章样式（优先显式技术栈，其次启发式推断）。
 *
 * `t` 必填：`label` 会直接渲染到最近工作区的徽章上（WelcomeView / OpenWorkspaceModal），
 * 且会作为 `welcome.techTooltip` 的插值。做成可选带兜底，英文环境下就会静默显示「通用」。
 */
export function detectTechBadge(
  name: string,
  path: string,
  t: Translate,
  explicitTech?: string,
): TechStyle {
  const style =
    explicitTech && explicitTech !== 'Git'
      ? getTechStyle(explicitTech)
      : getTechStyle(heuristicDetectTech(name, path));
  const key = TECH_LABEL_KEY[style.label];
  return key ? { ...style, label: t(key) } : style;
}
