import fs from 'node:fs';
import path from 'node:path';
import type { WorkspaceService } from './workspace';
import type { CodebaseSymbolHit, CodebaseIndexStatus } from '@deepseek-ide/shared';

export interface CodeChunk {
  filePath: string;
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'doc';
  line: number;
  endLine: number;
  content: string;
  doc?: string;
  tokens: Set<string>;
}

const IGNORED_DIRS = new Set([
  '.git',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.vite',
  '.idea',
  '.vscode',
  '.gemini',
]);

const ALLOWED_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.java',
  '.py',
  '.go',
  '.rs',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.sql',
  '.json',
  '.md',
  '.html',
  '.css',
]);

/** 停用词过滤 */
const STOP_WORDS = new Set([
  'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'in', 'of', 'for', 'to',
  'if', 'else', 'var', 'let', 'const', 'return', 'import', 'from', 'export', 'default',
  'public', 'private', 'protected', 'void', 'string', 'number', 'boolean', 'any',
  '的', '了', '和', '是', '就', '都', '而', '及', '与', '一个', '这', '那',
]);

/**
 * 分词工具：英文驼峰/下划线切词 + 中文切词
 */
function tokenizeText(text: string): string[] {
  if (!text) return [];
  const tokens: string[] = [];
  // 1. 将驼峰命名拆分，如 getUserAuthToken -> getUser Auth Token
  const splitCamel = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  // 2. 匹配英文字词与数字
  const enMatches = splitCamel.match(/[a-zA-Z0-9_]{2,}/g);
  if (enMatches) {
    for (const raw of enMatches) {
      const parts = raw.split('_');
      for (const p of parts) {
        const lower = p.toLowerCase();
        if (lower.length > 1 && !STOP_WORDS.has(lower)) {
          tokens.push(lower);
        }
      }
    }
  }

  // 3. 匹配中文字词 (2字滑动窗口)
  const cnMatches = text.match(/[\u4e00-\u9fa5]{2,}/g);
  if (cnMatches) {
    for (const word of cnMatches) {
      if (word.length <= 4) {
        tokens.push(word);
      } else {
        for (let i = 0; i < word.length - 1; i++) {
          tokens.push(word.slice(i, i + 2));
        }
      }
    }
  }

  return tokens;
}

export class CodebaseService {
  private chunks: CodeChunk[] = [];
  private invertedIndex = new Map<string, Set<number>>();
  private isIndexing = false;
  private lastIndexedTime = 0;
  private indexedFiles = 0;

  constructor(private readonly resolveWorkspace: () => WorkspaceService) {}

  private get workspace(): WorkspaceService {
    return this.resolveWorkspace();
  }

  getStatus(): CodebaseIndexStatus {
    return {
      indexedFiles: this.indexedFiles,
      totalSymbols: this.chunks.length,
      lastIndexedTime: this.lastIndexedTime,
      isIndexing: this.isIndexing,
    };
  }

  /**
   * 全量扫描工作区文件并构建 AST / 符号特征倒排索引
   */
  async buildIndex(): Promise<CodebaseIndexStatus> {
    const root = this.workspace.getRoot();
    if (!root || this.isIndexing) {
      return this.getStatus();
    }

    this.isIndexing = true;
    const startTime = Date.now();
    const newChunks: CodeChunk[] = [];
    const newIndex = new Map<string, Set<number>>();
    let fileCount = 0;

    try {
      const collectFiles = async (dir: string): Promise<string[]> => {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        const files: string[] = [];
        for (const entry of entries) {
          if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const subs = await collectFiles(full);
            files.push(...subs);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (ALLOWED_EXTS.has(ext)) {
              files.push(full);
            }
          }
        }
        return files;
      };

      const filePaths = await collectFiles(root);
      fileCount = filePaths.length;

      for (const absPath of filePaths) {
        const relPath = path.relative(root, absPath);
        try {
          const stat = await fs.promises.stat(absPath);
          if (stat.size > 500 * 1024) continue; // 跳过 > 500KB 的大文件

          const content = await fs.promises.readFile(absPath, 'utf-8');
          const fileChunks = this.extractCodeChunks(relPath, content);

          for (const chunk of fileChunks) {
            const chunkIdx = newChunks.length;
            newChunks.push(chunk);

            for (const token of chunk.tokens) {
              let set = newIndex.get(token);
              if (!set) {
                set = new Set();
                newIndex.set(token, set);
              }
              set.add(chunkIdx);
            }
          }
        } catch {
          // 容错单个文件读取异常
        }
      }

      this.chunks = newChunks;
      this.invertedIndex = newIndex;
      this.indexedFiles = fileCount;
      this.lastIndexedTime = Date.now();
      console.log(
        `[CodebaseService] Indexed ${fileCount} files, ${newChunks.length} symbol chunks in ${Date.now() - startTime}ms`,
      );
    } catch (err) {
      console.error('[CodebaseService] Indexing error:', err);
    } finally {
      this.isIndexing = false;
    }

    return this.getStatus();
  }

  /**
   * 从代码文件中抽取结构化符号块
   */
  private extractCodeChunks(filePath: string, content: string): CodeChunk[] {
    const lines = content.split('\n');
    const chunks: CodeChunk[] = [];

    // 文件级概览 Chunk
    const pathTokens = tokenizeText(filePath);
    const fileHeaderLines = lines.slice(0, 15).join('\n');
    chunks.push({
      filePath,
      name: path.basename(filePath),
      kind: 'doc',
      line: 1,
      endLine: Math.min(lines.length, 15),
      content: fileHeaderLines,
      tokens: new Set([...pathTokens, ...tokenizeText(fileHeaderLines)]),
    });

    // 正则提取函数、类、接口、类型、结构体
    const patterns: Array<{
      kind: CodeChunk['kind'];
      regex: RegExp;
    }> = [
      {
        kind: 'function',
        regex: /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/g,
      },
      {
        kind: 'function',
        regex: /(?:export\s+)?const\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^=>]+)?\s*=>/g,
      },
      {
        kind: 'function',
        regex: /(?:def|func|fn)\s+([a-zA-Z0-9_$]+)/g,
      },
      {
        kind: 'class',
        regex: /(?:export\s+)?(?:abstract\s+)?class\s+([a-zA-Z0-9_$]+)/g,
      },
      {
        kind: 'interface',
        regex: /(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)/g,
      },
      {
        kind: 'type',
        regex: /(?:export\s+)?type\s+([a-zA-Z0-9_$]+)\s*=/g,
      },
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { kind, regex } of patterns) {
        regex.lastIndex = 0;
        const match = regex.exec(line);
        if (match && match[1]) {
          const symbolName = match[1];
          const startLine = i + 1;
          const endLine = Math.min(lines.length, startLine + 30);
          const snippet = lines.slice(i, endLine).join('\n');

          // 抓取上方最近的注释 (最多看上面 5 行)
          let docSnippet = '';
          let lookBack = i - 1;
          while (lookBack >= 0 && i - lookBack <= 5) {
            const prev = lines[lookBack].trim();
            if (prev.startsWith('//') || prev.startsWith('*') || prev.startsWith('/*') || prev.startsWith('#')) {
              docSnippet = prev + '\n' + docSnippet;
              lookBack--;
            } else {
              break;
            }
          }

          const tokens = new Set([
            ...tokenizeText(symbolName),
            ...tokenizeText(filePath),
            ...tokenizeText(docSnippet),
            ...tokenizeText(snippet.slice(0, 500)),
          ]);

          chunks.push({
            filePath,
            name: symbolName,
            kind,
            line: startLine,
            endLine,
            content: snippet,
            doc: docSnippet.trim() || undefined,
            tokens,
          });
        }
      }
    }

    return chunks;
  }

  /**
   * 自然语言语义与符号搜索 (BM25 + 符号名加权)
   */
  search(query: string, limit = 20): CodebaseSymbolHit[] {
    if (!query.trim()) return [];
    if (this.chunks.length === 0 && !this.isIndexing) {
      void this.buildIndex();
    }

    const queryTokens = tokenizeText(query);
    if (queryTokens.length === 0) return [];

    const scores = new Map<number, number>();

    for (const qToken of queryTokens) {
      const matchingChunkIndices = this.invertedIndex.get(qToken);
      if (matchingChunkIndices) {
        for (const idx of matchingChunkIndices) {
          const chunk = this.chunks[idx];
          let score = scores.get(idx) || 0;

          // 基础匹配权重
          score += 1.0;

          // 符号名称直接命中加权 x3.0
          if (chunk.name.toLowerCase().includes(qToken)) {
            score += 3.0;
          }

          // 文档注释命中加权 x2.0
          if (chunk.doc && chunk.doc.toLowerCase().includes(qToken)) {
            score += 2.0;
          }

          // 文件路径匹配加权 x1.5
          if (chunk.filePath.toLowerCase().includes(qToken)) {
            score += 1.5;
          }

          scores.set(idx, score);
        }
      }
    }

    const sortedIndices = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

    return sortedIndices.map(([idx, score]) => {
      const chunk = this.chunks[idx];
      return {
        filePath: chunk.filePath,
        name: chunk.name,
        kind: chunk.kind,
        line: chunk.line,
        endLine: chunk.endLine,
        content: chunk.content,
        doc: chunk.doc,
        score: Math.round(score * 10) / 10,
      };
    });
  }
}
