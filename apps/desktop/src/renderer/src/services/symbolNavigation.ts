import * as monaco from 'monaco-editor';
import { findJavaDefinitionLocations, JAVA_KEYWORDS } from './javaNavigation';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface NavigationEntry {
  /** Relative or absolute file path */
  path: string;
  line: number;
  column: number;
}

export interface PeekResult {
  /** Display label, e.g. "src/foo.ts:42" */
  label: string;
  /** Preview text from that line */
  preview: string;
  path: string;
  line: number;
  column: number;
}

export interface SymbolNavigationOptions {
  getWorkspaceRoot?: () => string | null | undefined;
  onOpenFile: (path: string, line?: number, column?: number) => void;
  /** Called when there are multiple definition results; host should show pick UI */
  onShowPeekResults?: (results: PeekResult[], symbol: string) => void;
  /** Returns the current open file path (relative) so we can push it to history */
  getCurrentPath?: () => string | null | undefined;
  /** Returns the current cursor position so we can push it to history */
  getCurrentPosition?: () => { line: number; column: number } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation History Stack (for jump-back: Alt+←  /  Ctrl+-)
// ─────────────────────────────────────────────────────────────────────────────

const MAX_HISTORY = 100;

class NavigationStack {
  private stack: NavigationEntry[] = [];

  push(entry: NavigationEntry) {
    if (!entry.path || !entry.line) return;
    const last = this.stack[this.stack.length - 1];
    // Avoid duplicate or consecutive near-identical entries (same file, <= 2 lines)
    if (
      last &&
      (last.path === entry.path ||
        last.path.endsWith('/' + entry.path) ||
        entry.path.endsWith('/' + last.path)) &&
      Math.abs(last.line - entry.line) <= 2
    ) {
      return;
    }
    this.stack.push(entry);
    if (this.stack.length > MAX_HISTORY) {
      this.stack.shift();
    }
  }

  pop(): NavigationEntry | null {
    return this.stack.pop() ?? null;
  }

  get size() {
    return this.stack.length;
  }

  clear() {
    this.stack = [];
  }
}

export const navigationStack = new NavigationStack();

// ─────────────────────────────────────────────────────────────────────────────
// Supported Languages
// ─────────────────────────────────────────────────────────────────────────────

export const SUPPORTED_LANGUAGES = [
  'typescript',
  'javascript',
  'javascriptreact',
  'typescriptreact',
  'python',
  'go',
  'rust',
  'c',
  'cpp',
  'java',
  'csharp',
  'php',
  'ruby',
  'shell',
  'bash',
  'lua',
  'swift',
  'kotlin',
  'sql',
  'html',
  'css',
  'less',
  'scss',
  'json',
  'yaml',
  'xml',
  'dockerfile',
  'ini',
  'markdown',
];

/**
 * Common language keywords across supported languages.
 * Keywords should never be underlined or navigated to as definition targets.
 */
export const COMMON_KEYWORDS = new Set([
  // JavaScript / TypeScript
  'abstract', 'any', 'as', 'asserts', 'async', 'await', 'boolean', 'break', 'case', 'catch',
  'class', 'const', 'constructor', 'continue', 'debugger', 'declare', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function',
  'get', 'if', 'implements', 'import', 'in', 'infer', 'instanceof', 'interface', 'is', 'keyof',
  'let', 'module', 'namespace', 'never', 'new', 'null', 'number', 'object', 'of', 'package',
  'private', 'protected', 'public', 'readonly', 'require', 'return', 'set', 'static', 'string',
  'super', 'switch', 'symbol', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined',
  'unique', 'unknown', 'var', 'void', 'while', 'with', 'yield',
  // Python
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while',
  'with', 'yield', 'self', 'cls',
  // Go
  'func', 'nil', 'select', 'chan', 'defer', 'go', 'fallthrough', 'range',
  // Rust
  'fn', 'pub', 'struct', 'impl', 'trait', 'mut', 'ref', 'unsafe', 'where', 'loop', 'mod',
  // Java
  ...JAVA_KEYWORDS,
]);

/**
 * Universal Monaco Language Selector with hasAccessToAllModels: true
 * Guarantees Monaco evaluates score > 0 for UI-thread and unsynchronized models.
 */
export const UNIVERSAL_LANGUAGE_SELECTOR: monaco.languages.LanguageSelector = [
  { language: '*', hasAccessToAllModels: true },
  ...SUPPORTED_LANGUAGES.map((lang) => ({ language: lang, hasAccessToAllModels: true })),
];

// ─────────────────────────────────────────────────────────────────────────────
// Comment / String Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks if the given position in a Monaco text model is inside a comment or string literal.
 * Returns true → do NOT show link / jump for this position.
 */
export function isPositionInCommentOrString(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition
): boolean {
  const lineContent = model.getLineContent(position.lineNumber);
  const trimmed = lineContent.trimStart();

  // 1. Whole-line comment markers (any language)
  if (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||     // inside /* … */ block
    trimmed.startsWith('#') ||     // Python / Shell / YAML / TOML
    trimmed.startsWith('--') ||    // SQL / Lua
    trimmed.startsWith('<!--') ||  // HTML / XML
    trimmed.startsWith(';;') ||    // Lisp
    trimmed.startsWith('%')        // LaTeX / Erlang
  ) {
    return true;
  }

  const col = position.column - 1; // 0-based index of the character at cursor

  // 2. Walk character-by-character up to cursor position to detect:
  //    - Whether we're inside a single-quoted, double-quoted, or backtick string
  //    - Whether a `//` comment started before the cursor (outside any string)
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;

  for (let i = 0; i < col; i++) {
    const ch = lineContent[i];
    const prev = i > 0 ? lineContent[i - 1] : '';

    if (prev === '\\') {
      // escaped character – skip toggling
      continue;
    }

    if (ch === "'" && !inDouble && !inBacktick) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && !inBacktick) {
      inDouble = !inDouble;
    } else if (ch === '`' && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
    } else if (
      ch === '/' &&
      lineContent[i + 1] === '/' &&
      !inSingle && !inDouble && !inBacktick
    ) {
      // Inline // comment started before cursor – cursor is in comment
      return true;
    } else if (
      ch === '/' &&
      lineContent[i + 1] === '*' &&
      !inSingle && !inDouble && !inBacktick
    ) {
      // /* block comment opened before cursor – cursor is in comment
      return true;
    } else if (
      ch === '#' &&
      !inSingle && !inDouble && !inBacktick
    ) {
      // Python / Shell inline comment
      return true;
    }
  }

  if (inSingle || inDouble || inBacktick) return true;

  // 3. Multi-line block comments: look back up to 50 lines for unclosed /*
  let depth = 0;
  for (let l = position.lineNumber - 1; l >= Math.max(1, position.lineNumber - 50); l--) {
    const prevLine = model.getLineContent(l);
    // Count /* and */ from end of line backwards
    let j = prevLine.length - 1;
    while (j >= 0) {
      if (prevLine[j] === '/' && j > 0 && prevLine[j - 1] === '*') {
        depth--; // closing */
        j -= 2;
      } else if (prevLine[j] === '*' && j > 0 && prevLine[j - 1] === '/') {
        depth++; // opening /*
        j -= 2;
      } else {
        j--;
      }
    }
    if (depth > 0) return true; // inside unclosed block comment
    if (depth < 0) break;        // comment was closed before this line
  }

  // 4. Python multi-line triple-quote docstrings (""" or ''')
  const lang = model.getLanguageId();
  if (lang === 'python') {
    let tripleDouble = 0;
    let tripleSingle = 0;
    for (let l = 1; l < position.lineNumber; l++) {
      const prev = model.getLineContent(l);
      const dm = prev.match(/"""/g);
      if (dm) tripleDouble += dm.length;
      const sm = prev.match(/'''/g);
      if (sm) tripleSingle += sm.length;
    }
    const beforeCursor = lineContent.slice(0, col);
    const curDm = beforeCursor.match(/"""/g);
    if (curDm) tripleDouble += curDm.length;
    const curSm = beforeCursor.match(/'''/g);
    if (curSm) tripleSingle += curSm.length;

    if (tripleDouble % 2 === 1 || tripleSingle % 2 === 1) {
      return true; // inside multi-line docstring
    }
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Definition Pattern Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Multi-language regex patterns to match definition lines for a given identifier.
 */
export function buildDefinitionQuery(languageId: string, symbol: string): string {
  const s = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  switch (languageId) {
    case 'typescript':
    case 'javascript':
    case 'typescriptreact':
    case 'javascriptreact': {
      // We deliberately return a TIGHT, anchored pattern so ripgrep doesn't
      // match call-sites or random usages.  Each branch is anchored to the
      // start of a (possibly indented) line and requires the keyword to come
      // IMMEDIATELY before the symbol name.
      const mods = '(export\\s+)?(default\\s+)?';
      const accessMods = '(public|private|protected|static|readonly|abstract|override|async|declare)'
        + '(\\s+(public|private|protected|static|readonly|abstract|override|async|declare))*\\s+';
      return [
        // function / async function / generator
        `^[ \\t]*${mods}(async\\s+)?function\\s*\\*?\\s+${s}\\b`,
        // class / abstract class
        `^[ \\t]*${mods}(abstract\\s+)?class\\s+${s}\\b`,
        // interface
        `^[ \\t]*${mods}interface\\s+${s}\\b`,
        // type alias
        `^[ \\t]*${mods}type\\s+${s}\\s*[=<]`,
        // enum
        `^[ \\t]*${mods}(const\\s+)?enum\\s+${s}\\b`,
        // const / let / var – symbol DIRECTLY after keyword (no destructuring noise)
        `^[ \\t]*(export\\s+)?(const|let|var)\\s+${s}\\s*[:=,;\\[]`,
        // const / let / var with destructuring: { ..., symbol, ... }
        `^[ \\t]*(export\\s+)?(const|let|var)\\s+\\{[^}]*\\b${s}\\b[^}]*\\}`,
        // class method / property with access modifiers
        `^[ \\t]+${accessMods}${s}\\s*[(:=]`,
        // shorthand method in class/object without modifiers
        `^[ \\t]+${s}\\s*\\([^)]*\\)\\s*(:\\s*\\S+\\s*)?\\{`,
        // import (for resolving cross-file origins)
        `import\\s+.*?\\b${s}\\b.*?\\bfrom\\b`,
      ].join('|');
    }

    case 'python':
      return `(^[ \\t]*(async[ \\t]+)?(def|class)[ \\t]+${s}([^a-zA-Z0-9_]|$))|(^[ \\t]*${s}[ \\t]*=)|(from[ \\t]+[.\\w]+[ \\t]+import[ \\t]+[^#\\n]*\\b${s}\\b)`;

    case 'go':
      return `^[ \\t]*(func\\s+(\\([^)]*\\)\\s+)?|type\\s+|var\\s+|const\\s+)${s}\\b`;

    case 'rust':
      return `^[ \\t]*(pub(\\([^)]*\\))?\\s+)?(async\\s+)?(fn|struct|enum|trait|type|const|static)\\s+${s}\\b`;

    case 'c':
    case 'cpp':
      return `\\b(class|struct|enum|union|typedef)\\s+${s}\\b|^[ \\t]*([\\w:*&<>]+[ \\t]+)+${s}\\s*\\(`;

    case 'java':
      return [
        `\\b(class|interface|enum|record)\\s+${s}\\b`,
        `\\b(public|protected|private|static|final|abstract|default)\\s+.*\\b${s}\\s*\\(`,
        `\\b${s}\\s*\\([^;{]*\\)\\s*(\\{|throws|;)`,
        `\\b(public|protected|private|static|final|volatile|transient)\\s+.*\\b${s}\\s*[=;]`,
        `import\\s+(static\\s+)?[a-zA-Z0-9_.]*\\b${s}\\b`,
      ].join('|');

    case 'csharp':
      return `\\b(class|interface|enum|record|struct)\\s+${s}\\b|\\b${s}\\s*\\([^;]*\\)\\s*\\{`;

    case 'php':
      return `^[ \\t]*(abstract\\s+|final\\s+)?(function|class|interface|trait)\\s+${s}\\b`;

    case 'ruby':
      return `^[ \\t]*(def|class|module)\\s+${s}\\b`;

    case 'shell':
    case 'bash':
      return `^[ \\t]*(function\\s+)?${s}\\s*\\(\\)|^([A-Z_a-z][A-Z_a-z0-9]*_)?${s}=`;

    case 'lua':
      return `^[ \\t]*(local\\s+)?function\\s+([\\w_]+[:.])?${s}\\b`;

    case 'swift':
      return `^[ \\t]*(public\\s+|private\\s+|internal\\s+|open\\s+)?(func|class|struct|enum|protocol|typealias)\\s+${s}\\b`;

    case 'kotlin':
      return `^[ \\t]*(suspend\\s+)?(fun|class|interface|object|typealias)\\s+${s}\\b`;

    default:
      return `\\b(def|fn|func|function|class|interface|type|struct|enum|var|val|const)\\s+${s}\\b`;
  }
}

/**
 * Detects if a line in a Python file is an import statement that brings `symbol` into scope.
 * Returns the module path (e.g. "app.runtime.secondary.capacity") or null.
 */
export function parsePythonImport(lineContent: string, symbol: string): { modulePath: string } | null {
  // from x.y.z import a, b, symbol as s
  const fromMatch = lineContent.match(/^\s*from\s+([.\w]+)\s+import\b/);
  if (fromMatch && new RegExp(`\\b${symbol}\\b`).test(lineContent)) {
    return { modulePath: fromMatch[1] };
  }
  // import x.y.z as symbol
  const importAsMatch = lineContent.match(new RegExp(`^\\s*import\\s+([.\\w]+)\\s+as\\s+${symbol}\\b`));
  if (importAsMatch) {
    return { modulePath: importAsMatch[1] };
  }
  // import symbol
  const importMatch = lineContent.match(new RegExp(`^\\s*import\\s+.*\\b${symbol}\\b`));
  if (importMatch) {
    return { modulePath: symbol };
  }
  return null;
}

/**
 * Resolves a Python module import (e.g. "app.runtime.secondary.capacity") into candidate
 * relative file paths in the workspace.
 */
export function resolvePythonModuleToPaths(currentFilePath: string, modulePath: string): string[] {
  const candidates: string[] = [];
  const normCurrent = currentFilePath.replace(/\\/g, '/');

  if (modulePath.startsWith('.')) {
    // Relative import: .foo or ..foo
    const currentDir = normCurrent.split('/').slice(0, -1).join('/');
    let dotCount = 0;
    while (modulePath[dotCount] === '.') {
      dotCount++;
    }
    const remainder = modulePath.slice(dotCount).replace(/\./g, '/');
    const baseParts = currentDir.split('/').filter(Boolean);
    const popCount = dotCount - 1;
    for (let i = 0; i < popCount && baseParts.length > 0; i++) {
      baseParts.pop();
    }
    const basePath = baseParts.join('/');
    const fullRelative = remainder ? (basePath ? `${basePath}/${remainder}` : remainder) : basePath;
    if (fullRelative) {
      candidates.push(`${fullRelative}.py`);
      candidates.push(`${fullRelative}/__init__.py`);
    }
  } else {
    // Absolute import from workspace root (e.g. app.runtime.secondary.capacity)
    const asPath = modulePath.replace(/\./g, '/');
    candidates.push(`${asPath}.py`);
    candidates.push(`${asPath}/__init__.py`);
  }

  return candidates;
}

/**
 * Fast synchronous pre-check: determines if a symbol has an identifiable definition
 * in the current file (or imports) so that the hover link only activates for real symbols.
 */
export function hasLocalDefinitionOrImport(
  model: monaco.editor.ITextModel,
  symbol: string
): boolean {
  if (COMMON_KEYWORDS.has(symbol.toLowerCase()) || symbol.length < 2 || /^\d+$/.test(symbol)) {
    return false;
  }

  const lang = model.getLanguageId();
  const lineCount = model.getLineCount();

  if (lang === 'python') {
    const s = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const defRegex = new RegExp(`^[ \\t]*(async[ \\t]+)?(def|class)[ \\t]+${s}([^a-zA-Z0-9_]|$)`, 'i');
    const assignRegex = new RegExp(`^[ \\t]*${s}[ \\t]*=`, 'i');

    for (let i = 1; i <= lineCount; i++) {
      const line = model.getLineContent(i);
      if (parsePythonImport(line, symbol)) {
        return true;
      }
      if (defRegex.test(line) || assignRegex.test(line)) {
        return true;
      }
    }
    return false;
  }

  if (lang === 'java') {
    if (JAVA_KEYWORDS.has(symbol)) return false;
    const s = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const javaCheckRegex = new RegExp(
      `(\\b(class|interface|enum|record)\\s+${s}\\b)|` +
      `(\\b${s}\\s*\\([^;{]*\\)\\s*(\\{|throws|;))|` +
      `(\\b(public|protected|private|static|final|volatile|transient)\\s+.*\\b${s}\\s*[=;])|` +
      `(\\b([A-Z][a-zA-Z0-9_<>]*)\\s+${s}\\s*[=;,)])|` +
      `(import\\s+(static\\s+)?[a-zA-Z0-9_.]*\\b${s}\\b)`,
      'i'
    );
    for (let i = 1; i <= lineCount; i++) {
      const line = model.getLineContent(i);
      if (javaCheckRegex.test(line)) {
        return true;
      }
    }
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol);
  }

  const query = buildDefinitionQuery(lang, symbol);
  const regex = new RegExp(query, 'i');

  for (let i = 1; i <= lineCount; i++) {
    const line = model.getLineContent(i);
    if (regex.test(line)) {
      return true;
    }
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Import Path Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves a relative import path from a source file path.
 */
export function resolveRelativeImport(currentFilePath: string, moduleSpecifier: string): string | null {
  if (!moduleSpecifier.startsWith('.')) return null;

  const normCurrent = currentFilePath.replace(/\\/g, '/');
  const parts = normCurrent.split('/');
  parts.pop(); // remove filename

  const modParts = moduleSpecifier.split('/');
  for (const p of modParts) {
    if (p === '.') continue;
    if (p === '..') {
      parts.pop();
    } else {
      parts.push(p);
    }
  }

  return parts.join('/');
}

// ─────────────────────────────────────────────────────────────────────────────
// Jump Highlight
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Temporarily highlights the destination line (or an entire range) after a jump
 * with a pulse animation. 传入 endLine 时整段区间一起高亮，用于代码引用 Pill 跳转。
 */
export function highlightJumpLocation(
  editor: monaco.editor.IStandaloneCodeEditor,
  line: number,
  endLine?: number,
) {
  try {
    const model = editor.getModel();
    if (!model) return;
    const lineCount = model.getLineCount();
    if (typeof line !== 'number' || isNaN(line) || line < 1 || line > lineCount) {
      return;
    }
    const end =
      typeof endLine === 'number' && !isNaN(endLine) && endLine > line
        ? Math.min(endLine, lineCount)
        : line;
    const decs = editor.createDecorationsCollection([
      {
        range: new monaco.Range(line, 1, end, model.getLineMaxColumn(end)),
        options: {
          isWholeLine: true,
          className: 'symbol-jump-highlight',
        },
      },
    ]);
    setTimeout(() => {
      try {
        decs.clear();
      } catch {
        // editor might be disposed
      }
    }, 1600);
  } catch {
    // 防御性保护，避免任何 Monaco 内部计算导致的渲染崩溃
  }
}

const preloadingUris = new Set<string>();

/**
 * Preloads Monaco models for locations so Monaco's Peek Widget can render
 * code previews with syntax highlighting on the left instead of a blank/black editor.
 */
export async function preloadModelsForLocations(
  locations: monaco.languages.Location[],
  root?: string | null
): Promise<void> {
  if (!window.ide?.readFile || locations.length === 0) return;

  const uniqueUris = new Map<string, monaco.Uri>();
  for (const loc of locations) {
    const key = loc.uri.toString();
    if (!monaco.editor.getModel(loc.uri) && !preloadingUris.has(key)) {
      uniqueUris.set(key, loc.uri);
    }
  }

  if (uniqueUris.size === 0) return;

  await Promise.all(
    Array.from(uniqueUris.entries()).map(async ([key, uri]) => {
      preloadingUris.add(key);
      try {
        let p = uri.fsPath || uri.path || '';
        if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
        if (root) {
          const normRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
          const normP = p.replace(/\\/g, '/');
          if (normP.startsWith(normRoot)) {
            p = normP.slice(normRoot.length).replace(/^\/+/, '');
          }
        }
        const content = await window.ide.readFile(p);
        if (!monaco.editor.getModel(uri)) {
          monaco.editor.createModel(content, undefined, uri);
        }
      } catch {
        // ignore preload failure
      } finally {
        preloadingUris.delete(key);
      }
    })
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Definition Location Finder (Ripgrep-backed)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Searches definition locations for the symbol under position using local scan,
 * import resolution, and global ripgrep.
 */
export async function findDefinitionLocations(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
  opts?: { getWorkspaceRoot?: () => string | null | undefined }
): Promise<monaco.languages.Location[]> {
  // Reject if position is in comment or string
  if (isPositionInCommentOrString(model, position)) {
    return [];
  }

  const word = model.getWordAtPosition(position);
  if (!word || !word.word) return [];
  const symbol = word.word.trim();
  if (COMMON_KEYWORDS.has(symbol.toLowerCase()) || symbol.length < 2 || /^\d+$/.test(symbol)) {
    return [];
  }

  const lang = model.getLanguageId();
  const currentUri = model.uri;
  const root = opts?.getWorkspaceRoot?.();

  // ── Tier 1: LSP Language Server (Python via Pyright, C/C++ via Clangd, Go via Gopls) ────
  const isLspLang =
    lang === 'python' ||
    lang === 'cpp' ||
    lang === 'c' ||
    lang === 'go' ||
    /\.go$/i.test(currentUri.fsPath || currentUri.path || '') ||
    /\.(cpp|cc|cxx|c|h|hpp|hh|hxx)$/i.test(currentUri.fsPath || currentUri.path || '');

  if (isLspLang && window.ide?.lspGetDefinition) {
    try {
      const currentPath = currentUri.fsPath || currentUri.path || '';
      const lspLangId =
        lang === 'python'
          ? 'python'
          : lang === 'go' || currentPath.endsWith('.go')
          ? 'go'
          : (lang === 'c' || currentPath.endsWith('.c') ? 'c' : 'cpp');
      if (window.ide.lspNotifyDocument) {
        void window.ide.lspNotifyDocument(currentPath, model.getValue(), lspLangId);
      }
      const lspHits = await window.ide.lspGetDefinition(
        currentPath,
        position.lineNumber,
        position.column
      );

      if (Array.isArray(lspHits) && lspHits.length > 0) {
        const locations: monaco.languages.Location[] = [];

        for (const h of lspHits) {
          let fullPath = h.path;
          if (root && !fullPath.startsWith('/') && !/^[a-zA-Z]:/.test(fullPath)) {
            fullPath = `${root.replace(/[/\\]+$/, '')}/${fullPath}`;
          }

          locations.push({
            uri: monaco.Uri.file(fullPath),
            range: new monaco.Range(
              h.line,
              h.column,
              h.endLine ?? h.line,
              h.endColumn ?? (h.column + symbol.length)
            ),
          });
        }

        if (locations.length > 0) {
          await preloadModelsForLocations([locations[0]], root);
          if (locations.length > 1) {
            void preloadModelsForLocations(locations.slice(1), root);
          }
          return locations;
        }
      }
    } catch (err) {
      console.warn('[symbolNavigation] Pyright LSP definition lookup error:', err);
      // fallback to import resolution and ripgrep below
    }
  }

  // ── Tier 1.5: Java Navigation Engine ──────────────────────────────────────
  if (lang === 'java') {
    try {
      const javaLocs = await findJavaDefinitionLocations(model, position, opts);
      if (javaLocs && javaLocs.length > 0) {
        await preloadModelsForLocations([javaLocs[0]], root);
        if (javaLocs.length > 1) {
          void preloadModelsForLocations(javaLocs.slice(1), root);
        }
        return javaLocs;
      }
    } catch (err) {
      console.warn('[symbolNavigation] Java navigation error:', err);
    }
  }

  const queryPattern = buildDefinitionQuery(lang, symbol);
  const regex = new RegExp(queryPattern, 'i');

  const lineCount = model.getLineCount();
  const localDefHits: monaco.languages.Location[] = [];
  const localImportHits: { line: number; col: number; modulePath: string }[] = [];

  // 1. Scan current document lines
  for (let i = 1; i <= lineCount; i++) {
    const lineContent = model.getLineContent(i);

    // Python-specific import detection (from x.y import z or import x)
    if (lang === 'python') {
      const pyImp = parsePythonImport(lineContent, symbol);
      if (pyImp) {
        const colIndex = lineContent.indexOf(symbol);
        localImportHits.push({
          line: i,
          col: colIndex >= 0 ? colIndex + 1 : 1,
          modulePath: pyImp.modulePath,
        });
        continue;
      }
    }

    if (regex.test(lineContent)) {
      const colIndex = lineContent.indexOf(symbol);
      const startCol = colIndex >= 0 ? colIndex + 1 : 1;

      // Detect if this line is an import statement
      const isImportLine = /^\s*import\b/.test(lineContent) && lineContent.includes('from');
      if (isImportLine) {
        const match = lineContent.match(/from\s+['"]([^'"]+)['"]/);
        if (match) {
          localImportHits.push({ line: i, col: startCol, modulePath: match[1] });
        }
      } else {
        // Actual local definition – skip the exact cursor line (user IS the definition)
        if (i !== position.lineNumber) {
          localDefHits.push({
            uri: currentUri,
            range: new monaco.Range(i, startCol, i, startCol + symbol.length),
          });
        }
      }
    }
  }

  // If local definition exists in the same file, return immediately
  if (localDefHits.length > 0) {
    return localDefHits;
  }

  // 2. Resolve import target file if symbol was imported
  let resolvedRelativeTarget: string | null = null;
  const currentPath = currentUri.fsPath || currentUri.path || '';

  if (localImportHits.length > 0) {
    if (lang === 'python' && window.ide?.readFile) {
      const candidates = resolvePythonModuleToPaths(currentPath, localImportHits[0].modulePath);
      for (const cand of candidates) {
        try {
          const content = await window.ide.readFile(cand);
          if (content) {
            const candLines = content.split('\n');
            const sEsc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const defReg = new RegExp(`^[ \\t]*(async[ \\t]+)?(def|class)[ \\t]+${sEsc}([^a-zA-Z0-9_]|$)`, 'i');
            const assignReg = new RegExp(`^[ \\t]*${sEsc}[ \\t]*=`, 'i');
            let foundLine = 1;
            let foundCol = 1;

            for (let li = 0; li < candLines.length; li++) {
              if (defReg.test(candLines[li]) || assignReg.test(candLines[li])) {
                foundLine = li + 1;
                const idx = candLines[li].indexOf(symbol);
                foundCol = idx >= 0 ? idx + 1 : 1;
                break;
              }
            }

            const fullCandPath = root && !cand.startsWith('/') ? `${root.replace(/[/\\]+$/, '')}/${cand}` : cand;
            const candUri = monaco.Uri.file(fullCandPath);

            if (!monaco.editor.getModel(candUri)) {
              monaco.editor.createModel(content, undefined, candUri);
            }

            return [
              {
                uri: candUri,
                range: new monaco.Range(foundLine, foundCol, foundLine, foundCol + symbol.length),
              },
            ];
          }
        } catch {
          // Candidate file not found; try next candidate
        }
      }
    } else {
      const rel = resolveRelativeImport(currentPath, localImportHits[0].modulePath);
      if (rel) {
        resolvedRelativeTarget = rel;
      }
    }
  }

  // 3. Global Workspace Search via ripgrep
  if (!window.ide?.searchCode) {
    if (localImportHits.length > 0) {
      return [
        {
          uri: currentUri,
          range: new monaco.Range(
            localImportHits[0].line,
            localImportHits[0].col,
            localImportHits[0].line,
            localImportHits[0].col + symbol.length
          ),
        },
      ];
    }
    return [];
  }

  try {
    const hits = await window.ide.searchCode({
      query: queryPattern,
      caseInsensitive: false,
      max: 30,
    });

    const root = opts?.getWorkspaceRoot?.();
    const remoteDefHits: monaco.languages.Location[] = [];
    const remoteImportHits: monaco.languages.Location[] = [];

    for (const h of hits) {
      // Build the full filesystem path for this hit
      const fullPath =
        root && !h.path.startsWith('/') && !/^[a-zA-Z]:/.test(h.path)
          ? `${root.replace(/[/\\]+$/, '')}/${h.path}`
          : h.path;

      // Guard: if the path is absolute and does NOT start with the workspace root,
      // skip it to avoid "path escapes workspace" errors on SSH/remote backends.
      if (root && fullPath.startsWith('/') && !fullPath.startsWith(root.replace(/[/\\]+$/, ''))) {
        continue;
      }

      const hitUri = monaco.Uri.file(fullPath);

      // Skip if it's the identical cursor line
      if (hitUri.toString() === currentUri.toString() && h.line === position.lineNumber) {
        continue;
      }

      const colIndex = h.preview.indexOf(symbol);
      const startCol = colIndex >= 0 ? colIndex + 1 : 1;
      const location = {
        uri: hitUri,
        range: new monaco.Range(h.line, startCol, h.line, startCol + symbol.length),
      };

      if (/^\s*import\b/.test(h.preview) && h.preview.includes('from')) {
        remoteImportHits.push(location);
      } else {
        remoteDefHits.push(location);
      }
    }

    // Prioritize resolved relative target file if matched
    if (resolvedRelativeTarget) {
      const normResolved = resolvedRelativeTarget.replace(/\\/g, '/');
      remoteDefHits.sort((a, b) => {
        const aPath = (a.uri.fsPath || a.uri.path || '').replace(/\\/g, '/');
        const bPath = (b.uri.fsPath || b.uri.path || '').replace(/\\/g, '/');
        const aMatch = aPath.includes(normResolved);
        const bMatch = bPath.includes(normResolved);
        if (aMatch && !bMatch) return -1;
        if (!aMatch && bMatch) return 1;
        return 0;
      });
    }

    // Combine and deduplicate
    const combined = [...localDefHits, ...remoteDefHits];
    if (combined.length > 0) {
      const seen = new Set<string>();
      const deduped: monaco.languages.Location[] = [];
      for (const loc of combined) {
        const key = `${loc.uri.toString()}:${loc.range.startLineNumber}`;
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(loc);
        }
      }
      if (deduped.length > 0) {
        await preloadModelsForLocations([deduped[0]], root);
        if (deduped.length > 1) {
          void preloadModelsForLocations(deduped.slice(1), root);
        }
      }
      return deduped;
    }

    // Fallback: if no remote definition found, jump to the import line in current file
    if (localImportHits.length > 0) {
      return [
        {
          uri: currentUri,
          range: new monaco.Range(
            localImportHits[0].line,
            localImportHits[0].col,
            localImportHits[0].line,
            localImportHits[0].col + symbol.length
          ),
        },
      ];
    }

    if (remoteImportHits.length > 0) {
      await preloadModelsForLocations([remoteImportHits[0]], root);
      if (remoteImportHits.length > 1) {
        void preloadModelsForLocations(remoteImportHits.slice(1), root);
      }
      return remoteImportHits;
    }
    return localDefHits;
  } catch {
    return localDefHits;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// References Finder (Ripgrep-backed, for Shift+F12)
// ─────────────────────────────────────────────────────────────────────────────

export async function findReferenceLocations(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
  opts?: { getWorkspaceRoot?: () => string | null | undefined }
): Promise<monaco.languages.Location[]> {
  const word = model.getWordAtPosition(position);
  if (!word || !word.word) return [];
  const symbol = word.word.trim();
  if (COMMON_KEYWORDS.has(symbol.toLowerCase()) || symbol.length < 2 || /^\d+$/.test(symbol)) {
    return [];
  }

  if (!window.ide?.searchCode) return [];

  try {
    const s = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hits = await window.ide.searchCode({
      query: `\\b${s}\\b`,
      caseInsensitive: false,
      max: 80,
    });

    const root = opts?.getWorkspaceRoot?.();
    const locations: monaco.languages.Location[] = [];

    for (const h of hits) {
      const fullPath =
        root && !h.path.startsWith('/') && !/^[a-zA-Z]:/.test(h.path)
          ? `${root.replace(/[/\\]+$/, '')}/${h.path}`
          : h.path;
      const hitUri = monaco.Uri.file(fullPath);
      const colIndex = h.preview.indexOf(symbol);
      const startCol = colIndex >= 0 ? colIndex + 1 : 1;
      locations.push({
        uri: hitUri,
        range: new monaco.Range(h.line, startCol, h.line, startCol + symbol.length),
      });
    }

    // Preload only the primary (first) reference immediately so Monaco's Peek Widget
    // pops up instantaneously without network lag.
    // Preload remaining files in the background without blocking the UI popup.
    if (locations.length > 0) {
      await preloadModelsForLocations([locations[0]], root);
      if (locations.length > 1) {
        void preloadModelsForLocations(locations.slice(1), root);
      }
    }

    return locations;
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Jump to Definition (Our custom engine, NO Monaco built-in actions)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts a Location[] to PeekResult[] for display in the custom peek panel.
 */
function locationsToPeekResults(
  locations: monaco.languages.Location[],
  symbol: string,
  root?: string | null
): PeekResult[] {
  return locations.map((loc) => {
    let filePath = loc.uri.fsPath || loc.uri.path || '';
    // Strip workspace root prefix for display
    if (root && filePath.startsWith(root)) {
      filePath = filePath.slice(root.length).replace(/^[/\\]+/, '');
    }
    // Strip leading /C:/ on Windows
    if (/^\/[a-zA-Z]:/.test(filePath)) filePath = filePath.slice(1);
    const line = loc.range.startLineNumber;
    const col = loc.range.startColumn;
    return {
      label: `${filePath}:${line}`,
      preview: symbol,
      path: filePath,
      line,
      column: col,
    };
  });
}

/**
 * Normalizes a target path for use with onOpenFile:
 * - Strips workspace root prefix
 * - Handles Windows /C:/ quirk
 */
export function normalizePath(targetPath: string, root?: string | null): string {
  let p = targetPath.replace(/\\/g, '/');
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  if (root) {
    const normRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (p.startsWith(normRoot)) {
      p = p.slice(normRoot.length).replace(/^\/+/, '');
    }
  }
  return p;
}

/**
 * Language IDs handled by Monaco's built-in TypeScript language service.
 * For these we delegate to editor.action.revealDefinition as the primary mechanism.
 */
const TS_LANGS = new Set(['typescript', 'javascript', 'typescriptreact', 'javascriptreact']);

/**
 * Jumps to definition for the symbol at position.
 *
 * Strategy:
 * ━━ TypeScript / JavaScript ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Delegates to Monaco's built-in `editor.action.revealDefinition`.
 * This calls ALL registered providers simultaneously:
 *   1. Monaco's TypeScript language service (semantic, understands all open models)
 *   2. Our ripgrep definition provider (registered in setupSymbolNavigation)
 * Monaco merges results, jumps directly for 1 result, shows Peek View for many.
 * Cross-file navigation is intercepted by our registerEditorOpener.
 *
 * ━━ Other languages ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Custom ripgrep path with simple custom Peek Panel for multiple results.
 *
 * Always pushes current position to navigation history BEFORE jumping.
 */
export async function jumpToDefinition(
  editor: monaco.editor.IStandaloneCodeEditor,
  position: monaco.IPosition,
  opts: SymbolNavigationOptions
): Promise<boolean> {
  const model = editor.getModel();
  if (!model) return false;

  // Reject if inside comment or string
  if (isPositionInCommentOrString(model, position)) return false;

  const word = model.getWordAtPosition(position);
  if (!word || !word.word) return false;
  const symbol = word.word.trim();
  if (COMMON_KEYWORDS.has(symbol.toLowerCase()) || symbol.length < 2 || /^\d+$/.test(symbol)) {
    return false;
  }

  // Position cursor on the clicked symbol and focus editor
  editor.setPosition(position);
  editor.focus();

  // Push current position to history BEFORE jumping (regardless of mechanism)
  const currentPathForHistory = opts.getCurrentPath?.();
  const currentPosForHistory = opts.getCurrentPosition?.();
  if (currentPathForHistory) {
    navigationStack.push({
      path: currentPathForHistory,
      line: currentPosForHistory?.line ?? position.lineNumber,
      column: currentPosForHistory?.column ?? position.column,
    });
  }

  const lang = model.getLanguageId();

  // ── TypeScript / JavaScript: use Monaco's built-in action ──────────────────
  // Monaco invokes ALL definition providers (TS language service + our ripgrep
  // provider registered below) and merges the results automatically.
  // gotoLocation.multiple:'peek' in editor options shows Monaco's built-in Peek
  // View for multiple results. registerEditorOpener handles cross-file jumps.
  if (TS_LANGS.has(lang)) {
    const action = editor.getAction('editor.action.revealDefinition');
    if (action) {
      void action.run();
      return true;
    }
  }

  // ── Non-TS/JS: custom ripgrep approach ─────────────────────────────────────
  const locations = await findDefinitionLocations(model, position, opts);
  const root = opts.getWorkspaceRoot?.();

  // Filter out the current line (user is ON the definition itself)
  const valid = locations.filter(
    (loc) =>
      !(
        loc.uri.toString() === model.uri.toString() &&
        loc.range.startLineNumber === position.lineNumber
      )
  );

  // 1. 用户点击定义行本身时，意图为查看该符号在项目中的引用：
  // 触发 Monaco 原生 referenceSearch，在当前行展开行内 Peek Widget（References (N)），
  // 确保在编辑区清晰展示，杜绝底部弹窗与编辑区空白无显示问题。
  if (valid.length === 0 && locations.length > 0) {
    const refAction = editor.getAction('editor.action.referenceSearch.trigger');
    if (refAction) {
      void refAction.run();
      return true;
    }
    return false;
  }

  // 2. 多个定义目标：触发 Monaco 原生 revealDefinition，配合 gotoLocation.multipleDefinitions: 'peek'
  // 自动在当前代码行展开原生 Peek Widget
  if (valid.length > 1) {
    const defAction = editor.getAction('editor.action.revealDefinition');
    if (defAction) {
      void defAction.run();
      return true;
    }
  }

  // 3. 唯一定义目标：直接平滑跳转
  if (valid.length === 1) {
    const target = valid[0];
    const targetLine = target.range.startLineNumber;
    const targetCol = target.range.startColumn;

    // 同文件跳转
    if (target.uri.toString() === model.uri.toString()) {
      editor.revealLineInCenter(targetLine);
      editor.setPosition({ lineNumber: targetLine, column: targetCol });
      editor.focus();
      highlightJumpLocation(editor, targetLine);
      return true;
    }

    // 跨文件跳转
    const targetPath = normalizePath(target.uri.fsPath || target.uri.path || '', root);
    opts.onOpenFile(targetPath, targetLine, targetCol);
    return true;
  }

  // 4. Fallback：Monaco 内置语言服务（如 TypeScript/JavaScript）可能有 ripgrep 无法直接解析的符号
  const defAction = editor.getAction('editor.action.revealDefinition');
  if (defAction) {
    void defAction.run();
    return true;
  }

  return false;
}


/**
 * Navigate back: pops the last navigation entry and opens it.
 * If target is within the same open editor, moves cursor & reveals immediately.
 */
export function navigateBack(
  opts: SymbolNavigationOptions,
  editor?: monaco.editor.IStandaloneCodeEditor | null
): boolean {
  let entry = navigationStack.pop();
  if (!entry) {
    console.log('[navigateBack] navigationStack is empty');
    return false;
  }

  const currentPath = opts.getCurrentPath?.();
  const currentPos = opts.getCurrentPosition?.();
  const normCurrent = currentPath?.replace(/\\/g, '/').replace(/^\/+/, '');

  // If top entry happens to be identical or adjacent to current position, pop until we find a distinct position
  while (
    entry &&
    normCurrent &&
    currentPos &&
    (normCurrent === entry.path ||
      normCurrent.endsWith('/' + entry.path) ||
      entry.path.endsWith('/' + normCurrent)) &&
    Math.abs(currentPos.line - entry.line) <= 2
  ) {
    entry = navigationStack.pop();
  }

  if (!entry) {
    console.log('[navigateBack] navigationStack is empty after filtering');
    return false;
  }

  const normTarget = entry.path.replace(/\\/g, '/').replace(/^\/+/, '');

  // Same-file jump back: directly move editor cursor & reveal for 100% instant navigation
  if (
    editor &&
    normCurrent &&
    (normCurrent === normTarget ||
      normTarget.endsWith('/' + normCurrent) ||
      normCurrent.endsWith('/' + normTarget))
  ) {
    editor.revealLineInCenter(entry.line);
    editor.setPosition({ lineNumber: entry.line, column: entry.column });
    editor.focus();
    highlightJumpLocation(editor, entry.line);
    return true;
  }

  opts.onOpenFile(entry.path, entry.line, entry.column);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cmd+Click Gesture Setup
// ─────────────────────────────────────────────────────────────────────────────

const pyDefinitionCache = new Map<string, boolean>();

/**
 * Sets up VS Code-like Cmd+Hover underline link and direct Cmd+Click jump gesture.
 * Excludes comments, string literals, and language keywords from linking.
 */
export function setupCmdClickGesture(
  editor: monaco.editor.IStandaloneCodeEditor,
  opts: SymbolNavigationOptions
): { dispose: () => void } {
  const linkDecorations = editor.createDecorationsCollection();
  let currentHoveredWord: string | null = null;

  const clearHoverLink = () => {
    if (currentHoveredWord !== null) {
      currentHoveredWord = null;
      linkDecorations.clear();
    }
  };

  const updateHoverLink = (pos: monaco.IPosition | null, isCmdPressed: boolean) => {
    if (!isCmdPressed || !pos) {
      clearHoverLink();
      return;
    }

    const model = editor.getModel();
    if (!model) {
      clearHoverLink();
      return;
    }

    // Strictly ignore comments and string literals
    if (isPositionInCommentOrString(model, pos)) {
      clearHoverLink();
      return;
    }

    const word = model.getWordAtPosition(pos);
    if (!word || !word.word || word.word.length < 2 || /^\d+$/.test(word.word)) {
      clearHoverLink();
      return;
    }

    const symbol = word.word.trim();

    // Strictly ignore language keywords
    if (COMMON_KEYWORDS.has(symbol.toLowerCase())) {
      clearHoverLink();
      return;
    }

    const wordKey = `${model.uri.toString()}:${pos.lineNumber}:${word.startColumn}:${word.endColumn}`;
    if (currentHoveredWord === wordKey) {
      return; // already showing this word's link
    }

    const applyLink = () => {
      currentHoveredWord = wordKey;
      linkDecorations.set([
        {
          range: new monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, word.endColumn),
          options: {
            inlineClassName: 'cmd-click-hover-link',
            hoverMessage: { value: '按住 ⌘ 点击跳转到定义 (Go to Definition)' },
          },
        },
      ]);
    };

    const lang = model.getLanguageId();
    if (lang === 'python') {
      const cached = pyDefinitionCache.get(wordKey);
      if (cached === false) {
        clearHoverLink();
        return;
      }
      if (cached === true) {
        applyLink();
        return;
      }

      // Query Pyright LSP asynchronously
      const currentPath = model.uri.fsPath || model.uri.path || '';
      if (window.ide?.lspGetDefinition) {
        const pendingKey = wordKey;
        window.ide
          .lspGetDefinition(currentPath, pos.lineNumber, pos.column)
          .then((hits) => {
            const hasDefinition = Array.isArray(hits) && hits.length > 0;
            pyDefinitionCache.set(pendingKey, hasDefinition);
            // Limit cache size
            if (pyDefinitionCache.size > 1000) {
              const first = pyDefinitionCache.keys().next().value;
              if (first) pyDefinitionCache.delete(first);
            }
            if (currentHoveredWord === null || currentHoveredWord === pendingKey) {
              if (hasDefinition) {
                applyLink();
              } else {
                clearHoverLink();
              }
            }
          })
          .catch(() => {
            pyDefinitionCache.set(pendingKey, false);
          });
        return;
      }
    }

    // Non-Python fallback: only underline if symbol has a local definition/import or is an identifier
    const hasDef = hasLocalDefinitionOrImport(model, symbol);
    if (!hasDef) {
      const isIdentifier = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(symbol);
      if (!isIdentifier) {
        clearHoverLink();
        return;
      }
    }

    applyLink();
  };

  // Mouse move: update link underline when Cmd is held
  const mouseMoveSub = editor.onMouseMove((e) => {
    const isCmdOrCtrl = !!(e.event.metaKey || e.event.ctrlKey);
    const pos = e.target.position;
    updateHoverLink(pos, isCmdOrCtrl);
  });

  // Key down: show link on the word currently under cursor
  const keyDownSub = editor.onKeyDown((e) => {
    if (e.keyCode === 57 /* Meta */ || e.keyCode === 5 /* Ctrl */) {
      const pos = editor.getPosition();
      updateHoverLink(pos, true);
    }
  });

  // Key up: hide link
  const keyUpSub = editor.onKeyUp((e) => {
    if (e.keyCode === 57 /* Meta */ || e.keyCode === 5 /* Ctrl */) {
      clearHoverLink();
    }
  });

  // Mouse down: Cmd+Click → jump
  const mouseDownSub = editor.onMouseDown((e) => {
    const isCmdOrCtrl = !!(e.event.metaKey || e.event.ctrlKey);
    if (isCmdOrCtrl && e.target.position) {
      const pos = e.target.position;
      const model = editor.getModel();
      if (!model) return;

      if (isPositionInCommentOrString(model, pos)) return;

      const word = model.getWordAtPosition(pos);
      if (!word || !word.word || word.word.length < 2 || /^\d+$/.test(word.word)) return;

      const symbol = word.word.trim();
      if (COMMON_KEYWORDS.has(symbol.toLowerCase())) return;

      e.event.preventDefault();
      e.event.stopPropagation();
      clearHoverLink();

      void jumpToDefinition(editor, pos, opts);
    }
  });

  const mouseLeaveSub = editor.onMouseLeave(() => {
    clearHoverLink();
  });

  return {
    dispose() {
      clearHoverLink();
      mouseMoveSub.dispose();
      keyDownSub.dispose();
      keyUpSub.dispose();
      mouseDownSub.dispose();
      mouseLeaveSub.dispose();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Global Symbol Navigation Setup (F12, Shift+F12, cross-tab opener)
// ─────────────────────────────────────────────────────────────────────────────

let activeNavigationController: { dispose: () => void } | null = null;

/**
 * Registers dual-tier symbol navigation:
 * 1. Editor Opener (Core Bridge) for cross-file Tab transitions
 * 2. Universal Heuristic Definition Provider (Tier 2 Engine via ripgrep)
 * 3. Universal Reference Provider (Shift+F12 via ripgrep)
 */
export function setupSymbolNavigation(opts: SymbolNavigationOptions): { dispose: () => void } {
  if (activeNavigationController) {
    activeNavigationController.dispose();
    activeNavigationController = null;
  }

  // 1. Core Bridge: Monaco Editor Opener
  const openerDisposable = monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      if (!resource) return false;

      const root = opts.getWorkspaceRoot?.();

      // Record origin position in navigation stack before jumping to target
      const sourceModel = source?.getModel();
      const sourcePos = source?.getPosition();
      if (sourceModel && sourcePos) {
        const sp = normalizePath(sourceModel.uri.fsPath || sourceModel.uri.path || '', root);
        navigationStack.push({
          path: sp,
          line: sourcePos.lineNumber,
          column: sourcePos.column,
        });
      } else {
        const curPath = opts.getCurrentPath?.();
        const curPos = opts.getCurrentPosition?.();
        if (curPath) {
          navigationStack.push({
            path: normalizePath(curPath, root),
            line: curPos?.line ?? 1,
            column: curPos?.column ?? 1,
          });
        }
      }

      const targetPath = normalizePath(resource.fsPath || resource.path || '', root);

      let line = 1;
      let col = 1;
      if (selectionOrPosition) {
        if ('lineNumber' in selectionOrPosition) {
          line = selectionOrPosition.lineNumber;
          col = selectionOrPosition.column;
        } else if ('startLineNumber' in selectionOrPosition) {
          line = selectionOrPosition.startLineNumber;
          col = selectionOrPosition.startColumn;
        }
      }

      opts.onOpenFile(targetPath, line, col);
      return true;
    },
  });

  // 2. Tier 2 Engine: Universal Definition Provider
  const defDisposable = monaco.languages.registerDefinitionProvider(UNIVERSAL_LANGUAGE_SELECTOR, {
    async provideDefinition(model, position, token) {
      if (token.isCancellationRequested) return null;
      const locations = await findDefinitionLocations(model, position, opts);
      if (token.isCancellationRequested) return null;
      return locations && locations.length > 0 ? locations : null;
    },
  });

  // 3. Universal Reference Provider (Shift+F12)
  const refDisposable = monaco.languages.registerReferenceProvider(UNIVERSAL_LANGUAGE_SELECTOR, {
    async provideReferences(model, position, _context, token) {
      if (token.isCancellationRequested) return null;
      const locations = await findReferenceLocations(model, position, opts);
      if (token.isCancellationRequested) return null;
      return locations && locations.length > 0 ? locations : null;
    },
  });

  // 4. Universal LSP Completion Provider
  const completionDisposable = monaco.languages.registerCompletionItemProvider(
    UNIVERSAL_LANGUAGE_SELECTOR,
    {
      triggerCharacters: ['.', '->', '::', '(', '/'],
      async provideCompletionItems(model, position, _context, token) {
        if (token.isCancellationRequested || !window.ide?.lspGetCompletion) {
          return { suggestions: [] };
        }

        const filePath = model.uri.fsPath || model.uri.path;
        if (!filePath) return { suggestions: [] };

        try {
          const items = await window.ide.lspGetCompletion(
            filePath,
            position.lineNumber,
            position.column,
          );
          if (token.isCancellationRequested || !items || items.length === 0) {
            return { suggestions: [] };
          }

          const word = model.getWordUntilPosition(position);
          const range: monaco.IRange = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };

          const suggestions: monaco.languages.CompletionItem[] = items.map((it) => {
            let kind = monaco.languages.CompletionItemKind.Property;
            if (it.kind) {
              kind = it.kind as unknown as monaco.languages.CompletionItemKind;
            }
            return {
              label: it.label,
              kind,
              detail: it.detail,
              documentation: it.documentation,
              insertText: it.insertText || it.label,
              sortText: it.sortText,
              range,
            };
          });

          return { suggestions };
        } catch {
          return { suggestions: [] };
        }
      },
    },
  );

  // 5. 监听 LSP 诊断事件并渲染 Monaco 语法错误/警告波浪线
  let diagUnlisten: (() => void) | null = null;
  if (window.ide?.onLspDiagnostics) {
    diagUnlisten = window.ide.onLspDiagnostics((event) => {
      if (!event || !event.path) return;
      const models = monaco.editor.getModels();
      const targetModel = models.find(
        (m) =>
          (m.uri.fsPath || m.uri.path) === event.path ||
          m.uri.toString() === event.uri,
      );
      if (!targetModel) return;

      const markers: monaco.editor.IMarkerData[] = (event.diagnostics || []).map((d) => {
        let severity = monaco.MarkerSeverity.Error;
        if (d.severity === 2) severity = monaco.MarkerSeverity.Warning;
        else if (d.severity === 3) severity = monaco.MarkerSeverity.Info;
        else if (d.severity === 4) severity = monaco.MarkerSeverity.Hint;

        return {
          severity,
          message: d.message,
          startLineNumber: (d.range?.start?.line ?? 0) + 1,
          startColumn: (d.range?.start?.character ?? 0) + 1,
          endLineNumber: (d.range?.end?.line ?? 0) + 1,
          endColumn: (d.range?.end?.character ?? 0) + 1,
          source: d.source || 'clangd',
        };
      });

      monaco.editor.setModelMarkers(targetModel, 'lsp', markers);
    });
  }

  const controller = {
    dispose() {
      openerDisposable.dispose();
      defDisposable.dispose();
      refDisposable.dispose();
      completionDisposable.dispose();
      diagUnlisten?.();
    },
  };

  activeNavigationController = controller;
  return controller;
}

/**
 * 切换当前 C/C++ 文件的头文件与源文件 (.cpp <-> .h)
 */
export async function switchSourceHeader(
  activePath: string,
  onOpenFile: (path: string) => void,
): Promise<boolean> {
  if (!activePath || !window.ide?.lspSwitchSourceHeader) return false;
  try {
    const counterpart = await window.ide.lspSwitchSourceHeader(activePath);
    if (counterpart) {
      onOpenFile(counterpart);
      return true;
    }
  } catch (err) {
    console.warn('[symbolNavigation] switchSourceHeader error:', err);
  }
  return false;
}

