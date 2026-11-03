/**
 * README 正文的预处理。
 *
 * README 是**发布者写的、完全不受我们控制的内容**。VS Code 的 README 里大量使用原始 HTML
 * （`<img width=734 ...>`、`<br>`、`<details>`），而 ReactMarkdown 默认不渲染原始 HTML ——
 * 它把标签原样当文本输出，于是详情页上会出现一整行 `<img src="https://..." width=734>`。
 *
 * 打开 `rehype-raw` 让它们渲染当然最省事，但那等于把任意 HTML 注入渲染进程的 DOM：
 * README 来自任何发布者，而渲染进程里有 `window.ide` 这一整套 IPC 通道。
 * **宁可少一张图，也不给 README 一条注进 DOM 的路。**
 *
 * 所以这里做的是「删掉标签」，而不是渲染它们。代码块里的 HTML 要保住 ——
 * 示例代码本身可能就是 HTML 片段，动它等于篡改文档。
 */

/**
 * 认得出的 HTML 标签名。
 *
 * 用白名单而不是「`<` 后面跟字母就算标签」：后者会把正文里的 `x<y 且 z>w`
 * 这种正常文字当成标签吃掉。README 里出现的 HTML 就是这些常见标签，
 * 认不出来的宁可留着（显示成文本）也不要误删。
 */
const HTML_TAG_NAMES = new Set([
  'a',
  'abbr',
  'b',
  'big',
  'blockquote',
  'br',
  'caption',
  'center',
  'code',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'font',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'iframe',
  'img',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'picture',
  'pre',
  's',
  'small',
  'source',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
  'video',
]);

/**
 * `<img src="...">` / `</div>` / `<br/>`，且标签名在白名单里。
 *
 * 属性部分按 HTML 的真实形状要求（`名字=值`），不能写成 `\s[^>]*` ——
 * 那样 `a<b 且 c>d` 这种正文会被当成 `<b ...>` 吃掉（`b` 既是变量名也是标签名）。
 * 要求属性必须长得像属性，这类误伤就消失了。
 */
const TAG_PATTERN = new RegExp(
  `</?(${[...HTML_TAG_NAMES].join('|')})(\\s+[a-zA-Z_:][-a-zA-Z0-9_:]*(\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+))?)*\\s*/?>`,
  'gi',
);

/** HTML 注释。README 里偶尔有，注释内容不该出现在正文里。 */
const COMMENT_PATTERN = /<!--[\s\S]*?-->/g;

/** 是不是代码围栏的开合行（``` 或 ~~~，允许带语言标注）。 */
function isFence(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

/**
 * 去掉原始 HTML 标签。
 *
 * 按行处理并跟踪围栏：代码块里的内容一行都不动。
 * 「整行只剩标签」的行（例如单独一行的 `<img ...>`）会被整行丢掉 ——
 * 留下的空行会让正文中间凭空多出一段空白。
 */
export function stripRawHtml(markdown: string): string {
  if (!markdown) return '';
  const source = markdown.replace(COMMENT_PATTERN, '');
  const out: string[] = [];
  let inFence = false;

  for (const line of source.split('\n')) {
    if (isFence(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const stripped = line.replace(TAG_PATTERN, '').replace(/\s+$/, '');
    // 原本有内容、去掉标签后什么都不剩 → 说明这一行本来就是个标签，整行丢掉
    if (!stripped.trim() && line.trim()) continue;
    out.push(stripped);
  }

  // 丢掉标签后常留下连续空行，压成一个空行（markdown 里也就是一个段落间距）
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
