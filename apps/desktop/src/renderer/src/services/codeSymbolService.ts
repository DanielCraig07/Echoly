export interface CodeSymbol {
  name: string;
  kind: 'class' | 'interface' | 'function' | 'method' | 'variable' | 'type';
  line: number;
}

/**
 * 从源代码中快速、轻量地提取关键符号（类、接口、函数、类型等）
 * 支持 TypeScript/JavaScript、Python、Java、Go、C/C++、Rust 等
 */
export function extractCodeSymbols(content: string, language: string): CodeSymbol[] {
  if (!content || typeof content !== 'string') return [];
  const lines = content.split('\n');
  const symbols: CodeSymbol[] = [];
  const lang = (language || '').toLowerCase();

  const isJsTs = /^(typescript|javascript|javascriptreact|typescriptreact|tsx|jsx|ts|js)$/.test(lang);
  const isPython = /^(python|py)$/.test(lang);
  const isJava = /^(java)$/.test(lang);
  const isGo = /^(go)$/.test(lang);
  const isCpp = /^(cpp|c|csharp|rust)$/.test(lang);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
      continue;
    }

    const lineNum = i + 1;

    // TypeScript / JavaScript
    if (isJsTs) {
      // class
      let m = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/);
      if (m) {
        symbols.push({ name: m[1], kind: 'class', line: lineNum });
        continue;
      }
      // interface
      m = trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/);
      if (m) {
        symbols.push({ name: m[1], kind: 'interface', line: lineNum });
        continue;
      }
      // type
      m = trimmed.match(/^(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/);
      if (m) {
        symbols.push({ name: m[1], kind: 'type', line: lineNum });
        continue;
      }
      // function
      m = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*([A-Za-z0-9_$]+)?\s*\(/);
      if (m && m[1]) {
        symbols.push({ name: m[1], kind: 'function', line: lineNum });
        continue;
      }
      // const/let fn = ... =>
      m = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:useCallback\()?(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/);
      if (m) {
        symbols.push({ name: m[1], kind: 'function', line: lineNum });
        continue;
      }
    }

    // Python
    if (isPython) {
      let m = trimmed.match(/^class\s+([A-Za-z0-9_]+)/);
      if (m) {
        symbols.push({ name: m[1], kind: 'class', line: lineNum });
        continue;
      }
      m = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/);
      if (m) {
        symbols.push({ name: m[1], kind: 'function', line: lineNum });
        continue;
      }
    }

    // Java
    if (isJava) {
      let m = trimmed.match(/^(?:public|protected|private)?\s*(?:static\s+)?(?:abstract\s+)?(?:final\s+)?(?:class|interface|enum)\s+([A-Za-z0-9_]+)/);
      if (m) {
        symbols.push({ name: m[1], kind: 'class', line: lineNum });
        continue;
      }
      m = trimmed.match(/^(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:[\w<>[\],]+)\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/);
      if (m && m[1] !== 'if' && m[1] !== 'for' && m[1] !== 'while' && m[1] !== 'switch') {
        symbols.push({ name: m[1], kind: 'method', line: lineNum });
        continue;
      }
    }

    // Go
    if (isGo) {
      let m = trimmed.match(/^type\s+([A-Za-z0-9_]+)\s+(?:struct|interface)/);
      if (m) {
        symbols.push({ name: m[1], kind: 'class', line: lineNum });
        continue;
      }
      m = trimmed.match(/^func\s+(?:\([^)]+\)\s+)?([A-Za-z0-9_]+)\s*\(/);
      if (m) {
        symbols.push({ name: m[1], kind: 'function', line: lineNum });
        continue;
      }
    }

    // C / C++ / Rust
    if (isCpp) {
      let m = trimmed.match(/^(?:struct|class|enum)\s+([A-Za-z0-9_]+)/);
      if (m) {
        symbols.push({ name: m[1], kind: 'class', line: lineNum });
        continue;
      }
      // fn for rust
      m = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*\(/);
      if (m) {
        symbols.push({ name: m[1], kind: 'function', line: lineNum });
        continue;
      }
    }
  }

  return symbols;
}

/**
 * 根据当前行号找到当前所处的符号
 */
export function findCurrentSymbol(symbols: CodeSymbol[], currentLine: number): CodeSymbol | null {
  if (!symbols || symbols.length === 0 || currentLine < 1) return null;
  let candidate: CodeSymbol | null = null;
  for (const s of symbols) {
    if (s.line <= currentLine) {
      candidate = s;
    } else {
      break;
    }
  }
  return candidate;
}
