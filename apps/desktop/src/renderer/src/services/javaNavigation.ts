import * as monaco from 'monaco-editor';

/**
 * Java Language Keywords.
 * Keywords should never be underlined or navigated to as definition targets.
 */
export const JAVA_KEYWORDS = new Set([
  'abstract',
  'assert',
  'boolean',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'class',
  'const',
  'continue',
  'default',
  'do',
  'double',
  'else',
  'enum',
  'extends',
  'final',
  'finally',
  'float',
  'for',
  'goto',
  'if',
  'implements',
  'import',
  'instanceof',
  'int',
  'interface',
  'long',
  'native',
  'new',
  'package',
  'private',
  'protected',
  'public',
  'record',
  'return',
  'short',
  'static',
  'strictfp',
  'super',
  'switch',
  'synchronized',
  'this',
  'throw',
  'throws',
  'transient',
  'try',
  'void',
  'volatile',
  'while',
  'yield',
  'sealed',
  'non-sealed',
  'permits',
  'var',
  'true',
  'false',
  'null',
]);

export interface JavaParsedFile {
  packageName: string;
  /** Simple class name -> fully qualified package name (e.g. "UserMapper" -> "com.tsingtec.dao.UserMapper") */
  imports: Map<string, string>;
  /** Package paths with wildcard import (e.g. "com.tsingtec.entity") */
  wildcardImports: string[];
  /** Static imported method -> full class path (e.g. "hasText" -> "org.springframework.util.StringUtils") */
  staticImports: Map<string, string>;
  /** Field / variable name -> declared type (e.g. "userMapper" -> "UserMapper") */
  fields: Map<string, string>;
  /** Local method declarations in file (methodName -> line number) */
  methods: Map<string, number>;
  /** Class / interface / record / enum declarations (name -> line number) */
  types: Map<string, number>;
}

/**
 * Parses a Java source file to extract package, imports, field types, and method definitions.
 */
export function parseJavaStructure(code: string): JavaParsedFile {
  const lines = code.split('\n');
  let packageName = '';
  const imports = new Map<string, string>();
  const wildcardImports: string[] = [];
  const staticImports = new Map<string, string>();
  const fields = new Map<string, string>();
  const methods = new Map<string, number>();
  const types = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    const lineNum = i + 1;

    // 1. Package statement: package com.tsingtec.datacenter.service;
    const pkgMatch = line.match(/^package\s+([a-zA-Z0-9_.]+)\s*;/);
    if (pkgMatch) {
      packageName = pkgMatch[1];
      continue;
    }

    // 2. Import statement: import com.tsingtec.entity.User; or import static ...
    if (line.startsWith('import ')) {
      const isStatic = /^import\s+static\s+/.test(line);
      const impMatch = line.match(/^import\s+(?:static\s+)?([a-zA-Z0-9_.]+)(?:\.\*)?\s*;/);
      if (impMatch) {
        const full = impMatch[1];
        if (line.includes('.*')) {
          wildcardImports.push(full);
        } else {
          const parts = full.split('.');
          const simple = parts.pop();
          if (simple) {
            if (isStatic) {
              staticImports.set(simple, parts.join('.'));
            } else {
              imports.set(simple, full);
            }
          }
        }
      }
      continue;
    }

    // 3. Class / Interface / Enum / Record declaration
    const typeMatch = line.match(/\b(class|interface|enum|record)\s+([A-Za-z0-9_]+)\b/);
    if (typeMatch) {
      types.set(typeMatch[2], lineNum);
    }

    // 4. Field declaration: e.g. @Autowired private UserMapper userMapper;
    // or private final UserService userService;
    const fieldMatch = line.match(
      /^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|protected|private|static|final|volatile|transient)\s+)+([A-Z][a-zA-Z0-9_<>]*)\s+([a-z][a-zA-Z0-9_]*)\s*[=;]/
    );
    if (fieldMatch) {
      const type = fieldMatch[1].replace(/<.*>/, '').trim();
      const name = fieldMatch[2].trim();
      fields.set(name, type);
    }

    // Local variable declarations: Type varName = or Type varName;
    const varMatch = line.match(/\b([A-Z][a-zA-Z0-9_<>]*)\s+([a-z][a-zA-Z0-9_]*)\s*[=;]/);
    if (varMatch && !fields.has(varMatch[2])) {
      const type = varMatch[1].replace(/<.*>/, '').trim();
      fields.set(varMatch[2], type);
    }

    // Method parameter declarations: (Type varName, ...)
    const paramRegex = /\b([A-Z][a-zA-Z0-9_<>]*)\s+([a-z][a-zA-Z0-9_]*)\b/g;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = paramRegex.exec(line)) !== null) {
      if (!fields.has(pMatch[2]) && !types.has(pMatch[2]) && !JAVA_KEYWORDS.has(pMatch[2])) {
        fields.set(pMatch[2], pMatch[1].replace(/<.*>/, '').trim());
      }
    }

    // 5. Method declaration (handles both interface methods with ; and class methods with {)
    const methodMatch = line.match(
      /(?:public|protected|private|static|final|abstract|default|synchronized|\s)*\s+([A-Za-z0-9_<>]+)\s+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*(?:throws\s+[^{;]+)?[\{;]/
    );
    if (methodMatch) {
      const methodName = methodMatch[2];
      if (!JAVA_KEYWORDS.has(methodName) && !types.has(methodName)) {
        methods.set(methodName, lineNum);
      }
    }
  }

  return {
    packageName,
    imports,
    wildcardImports,
    staticImports,
    fields,
    methods,
    types,
  };
}

/**
 * Extracts the receiver object or class in a method call expression before cursor position.
 * E.g. in `userService.findById(id)` -> returns `"userService"`
 * In `this.userService.findById(id)` -> returns `"userService"`
 * In `StringUtils.hasText(s)` -> returns `"StringUtils"`
 */
export function findJavaReceiver(lineContent: string, col: number, symbol: string): string | null {
  const before = lineContent.slice(0, col - 1).trim();
  const match = before.match(/([a-zA-Z0-9_]+)\s*\.\s*$/);
  if (!match) return null;
  const rawReceiver = match[1];
  if (rawReceiver === 'this') {
    // Check if it's this.foo.method
    const doubleMatch = before.match(/this\s*\.\s*([a-zA-Z0-9_]+)\s*\.\s*$/);
    if (doubleMatch) return doubleMatch[1];
    return 'this';
  }
  return rawReceiver;
}

/**
 * Resolves potential candidate Java file paths (relative to workspace or package path)
 * for a given symbol and optional receiver.
 */
export function resolveJavaCandidatePaths(
  parsed: JavaParsedFile,
  symbol: string,
  receiver: string | null
): { targetClass: string | null; candidatePaths: string[]; methodName: string | null } {
  let targetClass: string | null = null;
  let methodName: string | null = null;

  if (receiver) {
    methodName = symbol;
    if (receiver === 'this') {
      // Method is in current class
      return { targetClass: null, candidatePaths: [], methodName: symbol };
    }
    if (/^[A-Z]/.test(receiver)) {
      // Receiver is a class name (static method call, e.g. StringUtils.hasText)
      targetClass = receiver;
    } else {
      // Receiver is a variable name, look up its type in fields
      targetClass = parsed.fields.get(receiver) || null;
      // Fallback: Java convention of receiver name to PascalCase (e.g. userService -> UserService)
      if (!targetClass && receiver.length > 1) {
        targetClass = receiver.charAt(0).toUpperCase() + receiver.slice(1);
      }
    }
  } else {
    // No receiver: symbol could be a Class name or a method
    if (/^[A-Z]/.test(symbol)) {
      targetClass = symbol;
    } else {
      // Method in current class or statically imported
      if (parsed.staticImports.has(symbol)) {
        const fullClass = parsed.staticImports.get(symbol)!;
        targetClass = fullClass.split('.').pop() || null;
        methodName = symbol;
      }
    }
  }

  if (!targetClass) {
    return { targetClass: null, candidatePaths: [], methodName };
  }

  const candidatePaths: string[] = [];

  // 1. Check explicit imports: import com.tsingtec.service.UserService;
  const explicitImport = parsed.imports.get(targetClass);
  if (explicitImport) {
    const relPath = explicitImport.replace(/\./g, '/') + '.java';
    candidatePaths.push(relPath);
    // Also implementation candidate
    candidatePaths.push(explicitImport.replace(/\./g, '/') + 'Impl.java');
  }

  // 2. Check same package: package com.tsingtec.service; -> com/tsingtec/service/UserService.java
  if (parsed.packageName) {
    const pkgPath = parsed.packageName.replace(/\./g, '/');
    candidatePaths.push(`${pkgPath}/${targetClass}.java`);
    candidatePaths.push(`${pkgPath}/${targetClass}Impl.java`);
  }

  // 3. Check wildcard imports
  for (const wc of parsed.wildcardImports) {
    const wcPath = wc.replace(/\./g, '/');
    candidatePaths.push(`${wcPath}/${targetClass}.java`);
    candidatePaths.push(`${wcPath}/${targetClass}Impl.java`);
  }

  // 4. General class file names
  candidatePaths.push(`${targetClass}.java`);
  candidatePaths.push(`${targetClass}Impl.java`);

  return { targetClass, candidatePaths, methodName };
}

/**
 * Searches definition locations for a Java symbol using intelligent AST parsing,
 * package / import candidate resolution, and tailored ripgrep fallback.
 */
export async function findJavaDefinitionLocations(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
  opts?: { getWorkspaceRoot?: () => string | null | undefined }
): Promise<monaco.languages.Location[]> {
  const word = model.getWordAtPosition(position);
  if (!word || !word.word) return [];
  const symbol = word.word.trim();
  if (JAVA_KEYWORDS.has(symbol) || symbol.length < 2 || /^\d+$/.test(symbol)) {
    return [];
  }

  const currentUri = model.uri;
  const root = opts?.getWorkspaceRoot?.();
  const lineContent = model.getLineContent(position.lineNumber);
  const currentCode = model.getValue();
  const parsed = parseJavaStructure(currentCode);

  // ── Step 1: Check if symbol is declared LOCALLY in current Java file ─────────
  // A. Local type (Class, Interface, Enum, Record)
  if (parsed.types.has(symbol)) {
    const line = parsed.types.get(symbol)!;
    if (line !== position.lineNumber) {
      const idx = model.getLineContent(line).indexOf(symbol);
      return [
        {
          uri: currentUri,
          range: new monaco.Range(line, idx >= 0 ? idx + 1 : 1, line, (idx >= 0 ? idx + 1 : 1) + symbol.length),
        },
      ];
    }
  }

  // B. Local method in current file (if no receiver or receiver is this)
  const receiver = findJavaReceiver(lineContent, position.column, symbol);
  if (!receiver || receiver === 'this') {
    if (parsed.methods.has(symbol)) {
      const line = parsed.methods.get(symbol)!;
      if (line !== position.lineNumber) {
        const idx = model.getLineContent(line).indexOf(symbol);
        return [
          {
            uri: currentUri,
            range: new monaco.Range(line, idx >= 0 ? idx + 1 : 1, line, (idx >= 0 ? idx + 1 : 1) + symbol.length),
          },
        ];
      }
    }
  }

  // C. Local field / variable
  if (parsed.fields.has(symbol)) {
    const sEsc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fieldReg = new RegExp(`\\b${sEsc}\\b\\s*[=;]`);
    const lineCount = model.getLineCount();
    for (let i = 1; i <= lineCount; i++) {
      if (i !== position.lineNumber && fieldReg.test(model.getLineContent(i))) {
        const idx = model.getLineContent(i).indexOf(symbol);
        return [
          {
            uri: currentUri,
            range: new monaco.Range(i, idx >= 0 ? idx + 1 : 1, i, (idx >= 0 ? idx + 1 : 1) + symbol.length),
          },
        ];
      }
    }
  }

  // ── Step 2: Resolve candidate paths via Imports and Package ─────────────────
  const { targetClass, candidatePaths, methodName } = resolveJavaCandidatePaths(parsed, symbol, receiver);
  const candidateLocations: monaco.languages.Location[] = [];

  if (candidatePaths.length > 0 && window.ide?.readFile) {
    for (const cand of candidatePaths) {
      try {
        let content: string | null = null;
        let matchedPath = cand;

        // 2.1 First check if file is already open in Monaco editor models
        const fileName = cand.split('/').pop() || cand;
        const openModels = monaco.editor.getModels();
        for (const om of openModels) {
          const p = om.uri.fsPath || om.uri.path || '';
          if (p.endsWith('/' + fileName) || (cand.includes('/') && p.endsWith(cand))) {
            matchedPath = p;
            content = om.getValue();
            break;
          }
        }

        // 2.2 Try candidate path directly if not found in open models
        if (!content) {
          try {
            content = await window.ide.readFile(cand);
          } catch {
            // 2.3 Use searchFiles across workspace for rapid file resolution
            if (window.ide.searchFiles) {
              const fileHits = await window.ide.searchFiles(fileName, 10);
              for (const h of fileHits) {
                if (h.path.endsWith('/' + fileName) || (cand.includes('/') && h.path.endsWith(cand))) {
                  try {
                    content = await window.ide.readFile(h.path);
                    matchedPath = h.path;
                    break;
                  } catch {
                    // try next
                  }
                }
              }
            }
            // 2.4 Fallback: searchCode for class definition
            if (!content && window.ide.searchCode) {
              const codeHits = await window.ide.searchCode({
                query: `\\b(class|interface|enum|record)\\s+${targetClass || symbol}\\b`,
                caseInsensitive: false,
                max: 5,
              });
              for (const h of codeHits) {
                if (h.path.endsWith(fileName) || (cand.includes('/') && h.path.endsWith(cand))) {
                  try {
                    matchedPath = h.path;
                    content = await window.ide.readFile(h.path);
                    break;
                  } catch {
                    // try next
                  }
                }
              }
            }
          }
        }

        if (content) {
          const candLines = content.split('\n');
          let foundLine = 1;
          let foundCol = 1;
          const searchWord = methodName || targetClass || symbol;
          const sEsc = searchWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

          // Match class, interface, method, or constructor in candidate file
          const targetRegex = methodName
            ? new RegExp(`(?:public|protected|private|static|final|abstract|default|synchronized|\\s)*\\s+([A-Za-z0-9_<>]+)\\s+${sEsc}\\s*\\(`, 'i')
            : new RegExp(`\\b(class|interface|enum|record)\\s+${sEsc}\\b`, 'i');

          for (let li = 0; li < candLines.length; li++) {
            if (targetRegex.test(candLines[li])) {
              foundLine = li + 1;
              const idx = candLines[li].indexOf(searchWord);
              foundCol = idx >= 0 ? idx + 1 : 1;
              break;
            }
          }

          const fullPath = root && !matchedPath.startsWith('/') && !/^[a-zA-Z]:/.test(matchedPath)
            ? `${root.replace(/[/\\]+$/, '')}/${matchedPath}`
            : matchedPath;
          const targetUri = monaco.Uri.file(fullPath);

          if (!monaco.editor.getModel(targetUri)) {
            monaco.editor.createModel(content, undefined, targetUri);
          }

          // Avoid duplicate locations
          const isDup = candidateLocations.some(
            (loc) => loc.uri.toString() === targetUri.toString() && loc.range.startLineNumber === foundLine
          );
          if (!isDup) {
            candidateLocations.push({
              uri: targetUri,
              range: new monaco.Range(foundLine, foundCol, foundLine, foundCol + searchWord.length),
            });
          }
        }
      } catch {
        // Try next candidate
      }
    }

    if (candidateLocations.length > 0) {
      return candidateLocations;
    }
  }

  // ── Step 3: Workspace Ripgrep Search (Comprehensive Java Regex) ────────────
  if (window.ide?.searchCode) {
    const sEsc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Comprehensive Java definition regex:
    // 1. Type declaration: class, interface, enum, record
    // 2. Method declaration (including interface methods ending with ; and class methods with {)
    // 3. Constructor: public MyClass(
    // 4. Field declaration: private UserService userService;
    const javaQuery = [
      `\\b(class|interface|enum|record)\\s+${sEsc}\\b`,
      `\\b(public|protected|private|static|final|abstract|default)\\s+.*?\\b${sEsc}\\s*\\(`,
      `\\b${sEsc}\\s*\\([^;{]*\\)\\s*(\\{|throws|;)`,
      `\\b(public|protected|private|static|final|volatile|transient)\\s+.*?\\b${sEsc}\\s*[=;]`,
    ].join('|');

    try {
      const hits = await window.ide.searchCode({
        query: javaQuery,
        caseInsensitive: false,
        max: 60,
      });

      const locations: monaco.languages.Location[] = [];
      for (const h of hits) {
        // Skip current line
        if (h.path === model.uri.fsPath && h.line === position.lineNumber) continue;

        const fullPath = root && !h.path.startsWith('/') && !/^[a-zA-Z]:/.test(h.path)
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

      if (locations.length > 0) {
        return locations;
      }
    } catch {
      // fallback to empty
    }
  }

  return [];
}

