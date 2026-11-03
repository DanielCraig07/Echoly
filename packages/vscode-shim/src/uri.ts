/**
 * shim 里的 `vscode.Uri`。
 *
 * 以前它只是几个只有 `fsPath` / `scheme` / `toString` 的字面量对象。缺 `with()`
 * 的代价不是「少一个方法」，而是**整个界面渲染不出来**：
 *
 * Office Viewer 的 markdown 编辑器在 `resolveCustomTextEditor` 里先
 * `Vce(documentUri, handler)`，而 `Vce` 第一件事是
 * `uri.with({ query: '', fragment: '' }).toString()`。于是
 * `t.with is not a function` 一路把 `handleMarkdown` 打断在开头的几行 ——
 * 而 `handleMarkdown` 在调用处**没有 await**（扩展自己写的），异常不会冒到
 * `resolveCustomTextEditor`，只留下一条 unhandledRejection。界面上看不出任何报错，
 * 只有「扩展装了、点了没反应」。
 *
 * 所以这里补一个成型的 Uri：`scheme/authority/path/query/fragment/fsPath`、
 * `with()`、`toString()`、`toJSON()`，以及 `file/parse/joinPath/from` 四个静态构造。
 *
 * `toString()` 对 `file` 协议**返回磁盘路径本身**、不加 `file://` 前缀：这是本 shim
 * 一直以来的行为，Claude Code 等已经跑通的扩展就是按这个形状在用（拿它当 Map 的键、
 * 拼缓存 id）。真实 VS Code 返回的是 `file:///…`，把两者统一是另一件事，不该混在
 * 「让 Office Viewer 能开」这一轮里顺手改掉 —— 换了键就会换行为。
 */

export interface UriComponents {
  scheme?: string;
  authority?: string;
  path?: string;
  query?: string;
  fragment?: string;
}

export class ShimUri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;

  constructor(scheme = 'file', authority = '', path = '', query = '', fragment = '') {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
  }

  /** file 协议的磁盘路径。其它协议下官方返回的也是 path，这里保持一致。 */
  get fsPath(): string {
    return this.path;
  }

  /** 换掉其中几段，其它原样带过去 —— 官方语义就是「复制 + 局部覆盖」。 */
  with(change: UriComponents = {}): ShimUri {
    return new ShimUri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }

  toString(): string {
    // file 且没有 authority：只用路径（见文件头注释里的兼容性说明）
    if (this.scheme === 'file' && !this.authority) return this.path;
    let out = `${this.scheme}:`;
    if (this.authority) out += `//${this.authority}`;
    out += this.path;
    if (this.query) out += `?${this.query}`;
    if (this.fragment) out += `#${this.fragment}`;
    return out;
  }

  toJSON(): UriComponents {
    return {
      scheme: this.scheme,
      authority: this.authority,
      path: this.path,
      query: this.query,
      fragment: this.fragment,
    };
  }

  static file(fsPath: string): ShimUri {
    return new ShimUri('file', '', fsPath, '', '');
  }

  /**
   * 拆一个 URI 字符串。
   *
   * 认不出协议头（没有 `scheme:`）时按 file 处理 —— 扩展经常把裸路径丢进来，
   * 报错的位置离这里很远，不如照单全收。
   */
  static parse(value: string): ShimUri {
    const text = String(value ?? '');
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(text);
    if (!match) return new ShimUri('file', '', text, '', '');
    const scheme = match[1].toLowerCase();
    let rest = text.slice(match[0].length);
    let authority = '';
    if (rest.startsWith('//')) {
      rest = rest.slice(2);
      const cut = rest.search(/[/?#]/);
      if (cut === -1) {
        authority = rest;
        rest = '';
      } else {
        authority = rest.slice(0, cut);
        rest = rest.slice(cut);
      }
    }
    let fragment = '';
    const hashAt = rest.indexOf('#');
    if (hashAt >= 0) {
      fragment = rest.slice(hashAt + 1);
      rest = rest.slice(0, hashAt);
    }
    let query = '';
    const queryAt = rest.indexOf('?');
    if (queryAt >= 0) {
      query = rest.slice(queryAt + 1);
      rest = rest.slice(0, queryAt);
    }
    return new ShimUri(scheme, authority, rest, query, fragment);
  }

  /**
   * 接路径片段。
   *
   * 走 `path.join` 而不是字符串相加：扩展会写 `Uri.joinPath(uri, '..')` 求父目录
   * （Office Viewer 就是拿它当 `fileDir` 的），字符串相加会把 `..` 原样留下。
   * 片段里的 `..` 会被规范化掉，这是我们要的。
   */
  static joinPath(uri: ShimUri | string, ...paths: string[]): ShimUri {
    const base =
      uri instanceof ShimUri
        ? uri
        : ShimUri.parse(typeof uri === 'string' ? uri : ((uri as any)?.fsPath ?? ''));
    const joined = require('path').join(base.path || '', ...paths.map(String));
    return base.with({ path: joined });
  }

  static from(components: UriComponents): ShimUri {
    return new ShimUri(
      components.scheme ?? 'file',
      components.authority ?? '',
      components.path ?? '',
      components.query ?? '',
      components.fragment ?? '',
    );
  }
}
