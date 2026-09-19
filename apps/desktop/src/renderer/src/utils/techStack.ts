export interface TechStyle {
  label: string;
  color: string;
  bg: string;
}

export const TECH_STYLES: Record<string, TechStyle> = {
  Java: { label: 'Java', color: '#fb923c', bg: 'rgba(251, 146, 60, 0.15)' },
  Node: { label: 'Node', color: '#4ade80', bg: 'rgba(74, 222, 128, 0.15)' },
  Python: { label: 'Python', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)' },
  'C++': { label: 'C++', color: '#818cf8', bg: 'rgba(129, 140, 248, 0.15)' },
  Go: { label: 'Go', color: '#2dd4bf', bg: 'rgba(45, 212, 191, 0.15)' },
  Rust: { label: 'Rust', color: '#f87171', bg: 'rgba(248, 113, 113, 0.15)' },
  Git: { label: 'Git', color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.12)' },
};

/**
 * 获取技术栈标签样式
 */
export function getTechStyle(label?: string): TechStyle {
  if (!label) return TECH_STYLES.Git;
  return TECH_STYLES[label] || { label, color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.12)' };
}

/**
 * 启发式关键词检测（使用独立单词边界，杜绝任意子串如 'ts'/'js' 误报）
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

  return 'Git';
}

/**
 * 统一获取技术栈徽章样式（优先显式技术栈，其次启发式推断）
 */
export function detectTechBadge(
  name: string,
  path: string,
  explicitTech?: string,
): TechStyle {
  if (explicitTech) {
    return getTechStyle(explicitTech);
  }
  const tech = heuristicDetectTech(name, path);
  return getTechStyle(tech);
}
