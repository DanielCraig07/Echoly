/**
 * 自定义编辑器（`contributes.customEditors`）—— 把文件交给扩展的界面去渲染。
 *
 * 为什么单独一个文件：这里全是**纯逻辑**（选哪个 viewType、glob 怎么匹配、
 * 优先级怎么排），和 electron / 扩展宿主都没关系，可以单测；真正去建
 * `WebviewPanel`、写文件那些副作用留在 extensionManager 里。
 *
 * 一个真实背景：Office Viewer（`cweijan.vscode-office`）声明了 7 个 customEditor，
 * 其中 `cweijan.markdownViewer` 对 `file:/**\/*.md` 是 **default 优先级** ——
 * 在 VS Code 里打开 .md 默认就是它的所见即所得编辑器。我们之前只是「收下注册、
 * 什么都不做」，所以用户装了它、打开 md 却还是内置编辑器，看起来就是「没生效」。
 */

/** manifest 里的一条 `contributes.customEditors`。 */
export interface CustomEditorContribution {
  viewType: string;
  displayName?: string;
  /** `default` = 打开匹配文件时就用它；`option` = 只在用户显式选「打开方式」时用 */
  priority?: string;
  patterns: string[];
}

/** 参与匹配的一条：contribution + 谁提供的 + 有没有真的注册 provider。 */
export interface CustomEditorCandidate extends CustomEditorContribution {
  extensionId: string;
  /** 扩展此刻有没有把 provider 注册上来。没注册的不能选（选了就是一片空白）。 */
  hasProvider: boolean;
}

/**
 * 把 `filenamePattern` 变成正则。
 *
 * 只需要支持扩展实际用到的那几种写法，别去实现完整的 glob（实现不全反而危险）：
 * - `*.md`、`*.xlsx` —— 纯扩展名，匹配任意目录下的同名后缀；
 * - `file:/**\/*.docx` —— 带 scheme 的 glob，`**` 匹配任意层目录；
 * - `**\/*.tar.gz` —— 多段后缀。
 *
 * 不认识的写法（`*.{a,b}`、`[abc]` 之类）返回 null，调用方跳过 —— 宁可少匹配一个，
 * 也不要用一个半吊子正则去抢文件。
 */
export function compileFilenamePattern(pattern: string): RegExp | null {
  if (typeof pattern !== 'string' || pattern.length === 0) return null;
  if (/[[\]{}!+@]/.test(pattern)) return null;

  // 去掉 scheme 前缀（file: / vscode-remote: …）—— 我们只有本地文件
  let body = pattern.replace(/^[a-zA-Z0-9+.-]+:\/?/, '');
  if (body.startsWith('/')) body = body.replace(/^\/+/, '');

  const escaped = body
    .split('/')
    .map((segment) => {
      if (segment === '**') return '__DOUBLESTAR__';
      return segment
        .replace(/[.+^$()|\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]');
    })
    .join('/');

  // `**/` 允许零层目录：`**\/*.md` 要能匹配根目录下的 a.md
  const withStars = escaped
    .replace(/__DOUBLESTAR__\//g, '(?:.*/)?')
    .replace(/__DOUBLESTAR__/g, '.*');
  try {
    return new RegExp(`^${withStars}$`, 'i');
  } catch {
    return null;
  }
}

/** 文件路径（posix 风格）能不能被这条 contribution 认领。 */
export function matchesContribution(
  contribution: CustomEditorContribution,
  relativePath: string,
): boolean {
  const target = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  for (const pattern of contribution.patterns) {
    const compiled = compileFilenamePattern(pattern);
    if (!compiled) continue;
    if (compiled.test(target)) return true;
    // `*.md` 编出来是 `[^/]*\.md`（不含目录），也要能匹配 `docs/a.md`
    if (!pattern.includes('/')) {
      const bare = target.split('/').pop() ?? target;
      if (compiled.test(bare)) return true;
    }
  }
  return false;
}

/**
 * 选出接管这个文件的那条 contribution。
 *
 * 规则（对齐 VS Code 的直觉）：
 * 1. `priority: 'default'` 的优先于 `'option'` —— 后者只在用户显式选择时才该生效；
 * 2. 同样优先级下，**注册了 provider 的**优先 —— 否则会选出一个打不开的；
 * 3. 还分不出胜负就取第一条（manifest 顺序即用户的安装/声明顺序）。
 *
 * 返回 null 表示「这个文件交给内置编辑器」。
 */
export function pickCustomEditor(
  candidates: CustomEditorCandidate[],
  relativePath: string,
): CustomEditorCandidate | null {
  const matched = candidates.filter((candidate) => matchesContribution(candidate, relativePath));
  if (matched.length === 0) return null;
  const rank = (c: CustomEditorCandidate) => {
    const priority = c.priority === 'option' ? 1 : 0;
    return priority * 2 + (c.hasProvider ? 0 : 1);
  };
  return [...matched].sort((a, b) => rank(a) - rank(b))[0];
}

/** 该 contribution 是不是「默认接管」型（`option` 型不主动抢文件）。 */
export function isDefaultPriority(contribution: CustomEditorContribution): boolean {
  return contribution.priority !== 'option';
}
