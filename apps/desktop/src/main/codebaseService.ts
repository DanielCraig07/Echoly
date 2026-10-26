import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceBackend, FileStat } from '@deepseek-ide/tools';
import type { WorkspaceService } from './workspace';
import { projectIndexDir } from './projectConfig';
import type { CodebaseSymbolHit, CodebaseIndexStatus } from '@deepseek-ide/shared';

/**
 * 代码库索引：把工作区拆成「符号块」，用真正的 BM25 做检索。
 *
 * 关于「语义」这个词的诚实说明：这里**没有**向量、没有 embedding。
 * 它是一个词法索引（符号名 + 注释 + 代码体），只是排序用了正牌的 BM25（含 IDF 与
 * 长度归一化），而不是手工拍的权重和。之所以不做 embedding：
 *
 *   1. 后端是否提供 embedding 接口**无法验证** —— 探测 `/v1/models` 返回 401，
 *      内网网关需要鉴权而模型清单拿不到，任何「先建向量再说」的实现都只能靠猜。
 *   2. 真做错的话，代价不是「搜不准」而是「静默地搜不准」：向量维度对不上时，
 *      多数客户端会退回全 0 向量，于是所有块相似度相同、排序退化成文件顺序。
 *
 * 所以这一版把能确定做好的部分做扎实：**落盘持久化 + 增量更新 + 真 BM25**。
 * 等 embedding 端点可验证时再叠加一层语义召回（先向量粗排、再 BM25 精排），
 * 那时这份索引正好是精排层，不会被浪费。
 */

export interface CodeChunk {
  filePath: string;
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'doc';
  line: number;
  endLine: number;
  content: string;
  doc?: string;
}

/** 落盘 / 内存中的索引块。字段设计以「省一次重算」为准，不追求对外可读。 */
interface IndexedChunk extends CodeChunk {
  /** 内容词频：BM25 的 tf 直接取自这里。 */
  tf: Record<string, number>;
  /** 内容词数（去重前），即 BM25 的 dl。 */
  length: number;
  /** 符号名 / 路径 / 注释的切词结果，用于字段加权。 */
  nameTokens: string[];
  pathTokens: string[];
  docTokens: string[];
}

interface PersistedFile {
  size: number;
  mtimeMs: number;
  chunks: IndexedChunk[];
}

interface PersistedIndex {
  version: number;
  /** 索引归属的工作区根。与当前根不符时整份丢弃 —— 目录哈希相同不代表内容相同。 */
  root: string;
  savedAt: number;
  files: Record<string, PersistedFile>;
}

/** 落盘格式版本。改动 IndexedChunk 的形状时必须一起改，否则旧缓存会被误当成新格式读进来。 */
const INDEX_FORMAT_VERSION = 2;

/** 单文件最多保留的符号块数：超出的部分只留文件概览块，避免一个巨型文件吃光索引体积。 */
const MAX_CHUNKS_PER_FILE = 400;

/** 索引文件的保存节流窗口。连续编辑会反复触发保存，合并成一次落盘。 */
const SAVE_DEBOUNCE_MS = 1500;

export interface IndexProgress {
  phase: 'scan' | 'read' | 'save' | 'done';
  scanned: number;
  total: number;
  /** 本轮复用了多少文件的旧索引（增量效果的直接体现）。 */
  reused: number;
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
  // 索引本身落在用户主目录而不是工作区，但用户完全可能把某个工作区根设成主目录
  '.echoly',
]);

const ALLOWED_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.java',
  '.kt',
  '.py',
  '.go',
  '.rs',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.sql',
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.html',
  '.css',
  '.scss',
]);

/** 文件大小上限：超过这个尺寸的源文件几乎都是生成物或数据文件，索引它们只会拖慢一切。 */
const MAX_FILE_SIZE = 500 * 1024;

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
  const cnMatches = text.match(/[一-龥]{2,}/g);
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

function countTokens(tokens: string[]): Record<string, number> {
  const tf: Record<string, number> = {};
  for (const t of tokens) tf[t] = (tf[t] ?? 0) + 1;
  return tf;
}

/** BM25 参数。k1 控制词频饱和速度，b 控制长度归一化强度，取值是业界通行的一组。 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

export class CodebaseService {
  private chunks: IndexedChunk[] = [];
  /** token → chunk 下标列表。df 即列表长度。 */
  private invertedIndex = new Map<string, number[]>();
  /** 每个文件的时间戳快照，增量更新的依据。 */
  private fileStats = new Map<string, FileStat>();
  private isIndexing = false;
  private indexPromise: Promise<CodebaseIndexStatus> | null = null;
  private lastIndexedTime = 0;
  private indexedFiles = 0;
  private lastReused = 0;
  private lastProgress: IndexProgress | null = null;
  private progressListener: ((p: IndexProgress) => void) | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  /** 已经尝试过读缓存的根，避免每次搜索都去 stat 一遍磁盘。 */
  private loadedRoot: string | null = null;

  /**
   * @param resolveWorkspace 当前窗口的工作区
   * @param resolveIndexDir  索引落盘目录的推导（默认 `~/.echoly/indexes/<哈希>`）。
   *   做成可注入是为了**测试**：否则跑一次用例就会往开发者的真实主目录里写文件，
   *   而「测试写进用户 home」这种事一旦发生，清理不及时就会留下垃圾。
   */
  constructor(
    private readonly resolveWorkspace: () => WorkspaceService,
    private readonly resolveIndexDir: (workspaceRoot: string) => string = projectIndexDir,
  ) {}

  private get workspace(): WorkspaceService {
    return this.resolveWorkspace();
  }

  private backend(): WorkspaceBackend | null {
    return this.workspace.getBackend();
  }

  setProgressListener(cb: ((p: IndexProgress) => void) | null): void {
    this.progressListener = cb;
  }

  private emitProgress(p: IndexProgress): void {
    this.lastProgress = p;
    try {
      this.progressListener?.(p);
    } catch {
      // 进度上报失败不该影响索引本身
    }
  }

  getStatus(): CodebaseIndexStatus {
    return {
      indexedFiles: this.indexedFiles,
      totalSymbols: this.chunks.length,
      lastIndexedTime: this.lastIndexedTime,
      isIndexing: this.isIndexing,
      progress: this.lastProgress ?? undefined,
    };
  }

  // ── 持久化 ────────────────────────────────────────────────────────────────

  /**
   * 缓存文件路径。
   *
   * 放在 `~/.echoly/indexes/<工作区哈希>/codebase.json`，与数据库连接那类**配置**分开：
   * 索引是纯派生数据，用户想清掉腾空间时可以整个目录删掉，不必先分辨哪些文件不能删。
   */
  private cacheFilePath(): string | null {
    const root = this.workspace.getRoot();
    if (!root) return null;
    return path.join(this.resolveIndexDir(root), 'codebase.json');
  }

  private async loadFromDisk(): Promise<void> {
    const root = this.workspace.getRoot();
    if (!root) return;
    // 根变了就把内存里的东西全丢掉：那些块属于上一个项目，
    // 路径是相对的，留着会让搜索结果指向不存在的文件。
    if (this.loadedRoot !== null && this.loadedRoot !== root) {
      this.reset();
    }
    this.loadedRoot = root;
    const file = this.cacheFilePath();
    if (!file) return;
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      return; // 没缓存是常态，不是错误
    }
    try {
      const parsed = JSON.parse(raw) as PersistedIndex;
      if (parsed.version !== INDEX_FORMAT_VERSION || parsed.root !== root) return;
      const chunks: IndexedChunk[] = [];
      const stats = new Map<string, FileStat>();
      for (const [rel, entry] of Object.entries(parsed.files ?? {})) {
        stats.set(rel, { size: entry.size, mtimeMs: entry.mtimeMs });
        for (const c of entry.chunks) chunks.push(c);
      }
      this.chunks = chunks;
      this.fileStats = stats;
      this.indexedFiles = stats.size;
      this.lastIndexedTime = parsed.savedAt || Date.now();
      this.rebuildInvertedIndex();
    } catch {
      // 缓存损坏（写一半断电、版本串了）时静默忽略：重建一次的代价远小于让功能不可用
    }
  }

  private async saveToDisk(): Promise<void> {
    const file = this.cacheFilePath();
    const root = this.workspace.getRoot();
    if (!file || !root) return;
    const files: Record<string, PersistedFile> = {};
    const byFile = new Map<string, IndexedChunk[]>();
    for (const c of this.chunks) {
      let list = byFile.get(c.filePath);
      if (!list) {
        list = [];
        byFile.set(c.filePath, list);
      }
      list.push(c);
    }
    for (const [rel, chunks] of byFile) {
      const st = this.fileStats.get(rel);
      if (!st) continue;
      files[rel] = { size: st.size, mtimeMs: st.mtimeMs, chunks };
    }
    const payload: PersistedIndex = {
      version: INDEX_FORMAT_VERSION,
      root,
      savedAt: this.lastIndexedTime || Date.now(),
      files,
    };
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      // 先写临时文件再改名：中途失败不会留下半份 JSON 把下次启动的索引读坏
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
      await fs.rename(tmp, file);
    } catch {
      // 落盘失败只意味着下次要重建，不该让本轮索引算作失败
    }
  }

  /** 节流保存：编辑时会被反复触发，攒够 SAVE_DEBOUNCE_MS 再写一次。 */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveToDisk();
    }, SAVE_DEBOUNCE_MS);
    // 后台定时器不该拖住进程退出
    this.saveTimer.unref?.();
  }

  private reset(): void {
    this.chunks = [];
    this.invertedIndex.clear();
    this.fileStats.clear();
    this.indexedFiles = 0;
    this.lastIndexedTime = 0;
    this.lastReused = 0;
  }

  /** 工作区根发生变化时调用：清空内存索引，下次搜索会重新加载对应项目的缓存。 */
  onWorkspaceChanged(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    void this.saveToDisk().finally(() => {
      this.reset();
      this.loadedRoot = null;
    });
  }

  // ── 建索引 ────────────────────────────────────────────────────────────────

  private rebuildInvertedIndex(): void {
    const index = new Map<string, number[]>();
    for (let i = 0; i < this.chunks.length; i++) {
      for (const token of Object.keys(this.chunks[i].tf)) {
        let arr = index.get(token);
        if (!arr) {
          arr = [];
          index.set(token, arr);
        }
        arr.push(i);
      }
    }
    this.invertedIndex = index;
  }

  /**
   * 全量扫描工作区并（重建）索引。
   *
   * `force` 为 false 时走增量：文件的 mtime + size 没变就整块复用旧索引，
   * 连文件内容都不读。这是「编辑一个文件后重跑索引」从数十秒降到几十毫秒的关键 ——
   * 没有它，每次保存都会让整个工作区重新解析一遍。
   */
  async buildIndex(options?: { force?: boolean }): Promise<CodebaseIndexStatus> {
    // 并发调用共享同一次构建：多个入口（搜索、Agent 工具、UI 按钮）会同时触发
    if (this.indexPromise) return this.indexPromise;
    const backend = this.backend();
    const root = this.workspace.getRoot();
    if (!backend || !root) return this.getStatus();

    this.indexPromise = this.runBuild(backend, root, options?.force ?? false).finally(() => {
      this.indexPromise = null;
    });
    return this.indexPromise;
  }

  private async runBuild(
    backend: WorkspaceBackend,
    root: string,
    force: boolean,
  ): Promise<CodebaseIndexStatus> {
    if (this.loadedRoot !== root) await this.loadFromDisk();

    this.isIndexing = true;
    const startedAt = Date.now();
    try {
      const filePaths = await this.collectFiles(backend);
      this.emitProgress({ phase: 'scan', scanned: 0, total: filePaths.length, reused: 0 });

      const nextChunks: IndexedChunk[] = [];
      const nextStats = new Map<string, FileStat>();
      let reused = 0;
      let processed = 0;

      for (const relPath of filePaths) {
        processed++;
        const stat = await this.statOf(backend, relPath);
        const prev = this.fileStats.get(relPath);
        const unchanged =
          !force && stat !== null && prev !== undefined && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs;

        if (unchanged) {
          // 复用：把上一轮属于这个文件的块原样搬过来（块的 filePath 字段指向的就是它）
          for (const c of this.chunks) {
            if (c.filePath === relPath) nextChunks.push(c);
          }
          nextStats.set(relPath, stat);
          reused++;
          if (processed % 50 === 0) {
            this.emitProgress({ phase: 'read', scanned: processed, total: filePaths.length, reused });
          }
          continue;
        }

        if (stat && stat.size > MAX_FILE_SIZE) {
          // 大文件直接跳过，也不记 stat —— 记了下次会以为「没变」而永远不索引它
          continue;
        }
        try {
          const content = await backend.readFile(relPath);
          const chunks = this.extractCodeChunks(relPath.replace(/\\/g, '/'), content);
          nextChunks.push(...chunks);
          if (stat) nextStats.set(relPath, stat);
        } catch {
          // 单个文件读失败不该让整批索引消失（权限、并发删除、远端超时都会走到这里）
        }
        if (processed % 50 === 0) {
          this.emitProgress({ phase: 'read', scanned: processed, total: filePaths.length, reused });
        }
      }

      this.chunks = nextChunks;
      this.fileStats = nextStats;
      this.indexedFiles = nextStats.size;
      this.lastReused = reused;
      this.lastIndexedTime = Date.now();
      this.rebuildInvertedIndex();

      this.emitProgress({ phase: 'save', scanned: processed, total: filePaths.length, reused });
      await this.saveToDisk();
      this.emitProgress({ phase: 'done', scanned: processed, total: filePaths.length, reused });

      console.log(
        `[CodebaseService] ${force ? 'Full' : 'Incremental'} index: ${this.indexedFiles} files, ` +
          `${this.chunks.length} chunks, ${reused} reused, ${Date.now() - startedAt}ms`,
      );
    } catch (err) {
      console.error('[CodebaseService] Indexing error:', err);
    } finally {
      this.isIndexing = false;
    }

    return this.getStatus();
  }

  /**
   * `stat` 的容错包装。
   *
   * 后端没实现 stat（或远端调用超时）时返回 null，调用方按「变了」处理：
   * 退化成全量重建是**慢**，而误判成「没变」是**错**（改了代码却搜到旧符号）。
   */
  private async statOf(backend: WorkspaceBackend, relPath: string): Promise<FileStat | null> {
    if (!backend.stat) return null;
    try {
      return await backend.stat(relPath);
    } catch {
      return null;
    }
  }

  /**
   * 遍历工作区收集可索引文件。
   *
   * 走 `WorkspaceBackend` 而不是 node:fs：这样 SSH 远端工作区也能建索引。
   * 之前直接用 fs 的版本在 SSH 下永远索引出 0 个文件，而界面上看不出任何异常 ——
   * 语义搜索只是「搜不到东西」，用户会以为是自己的关键词不对。
   */
  private async collectFiles(backend: WorkspaceBackend): Promise<string[]> {
    const files: string[] = [];
    const walk = async (relDir: string, depth: number): Promise<void> => {
      if (depth > 12) return;
      let entries;
      try {
        entries = await backend.listDir(relDir);
      } catch {
        return;
      }
      const dirs: string[] = [];
      for (const entry of entries) {
        if (entry.name === '.' || entry.name === '..') continue;
        // 点开头的目录/文件一律跳过：.git、.venv、隐藏配置都是噪声
        if (entry.name.startsWith('.')) continue;
        if (IGNORED_DIRS.has(entry.name)) continue;
        const child = relDir === '.' || relDir === '' ? entry.name : `${relDir}/${entry.name}`;
        if (entry.isDirectory) {
          dirs.push(child);
        } else if (ALLOWED_EXTS.has(path.extname(entry.name).toLowerCase())) {
          files.push(child);
        }
      }
      for (const d of dirs) await walk(d, depth + 1);
    };
    await walk('.', 0);
    return files;
  }

  /**
   * 从代码文件中抽取结构化符号块
   */
  private extractCodeChunks(filePath: string, content: string): IndexedChunk[] {
    const lines = content.split('\n');
    const chunks: IndexedChunk[] = [];
    const pathTokens = tokenizeText(filePath);

    const push = (chunk: Omit<IndexedChunk, 'tf' | 'length' | 'nameTokens' | 'pathTokens' | 'docTokens'>) => {
      const nameTokens = tokenizeText(chunk.name);
      const docTokens = tokenizeText(chunk.doc ?? '');
      const contentTokens = tokenizeText(chunk.content);
      chunks.push({
        ...chunk,
        nameTokens,
        pathTokens,
        docTokens,
        tf: countTokens(contentTokens),
        length: contentTokens.length,
      });
    };

    // 文件级概览 Chunk
    const fileHeaderLines = lines.slice(0, 15).join('\n');
    push({
      filePath,
      name: path.basename(filePath),
      kind: 'doc',
      line: 1,
      endLine: Math.min(lines.length, 15),
      content: fileHeaderLines,
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
      if (chunks.length >= MAX_CHUNKS_PER_FILE) break;
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

          push({
            filePath,
            name: symbolName,
            kind,
            line: startLine,
            endLine,
            content: snippet,
            doc: docSnippet.trim() || undefined,
          });
        }
      }
    }

    return chunks;
  }

  // ── 检索 ─────────────────────────────────────────────────────────────────

  /**
   * BM25 检索（含 IDF 与长度归一化）+ 字段加权。
   *
   * 为什么不用「命中一个词加固定分」：那种打分对**稀有词与常见词一视同仁**，
   * 于是搜索 `authenticateUser` 时，所有正文里出现过 `user` 的块都会排在
   * 真正定义它的那个块附近；df 越高的词越不该贡献分数，这正是 IDF 的作用。
   *
   * 字段加权保留（符号名 > 注释 > 路径），但要乘上 idf：一个只在某处出现的
   * 符号名，命中它就应该是强信号；而 `get` 这种到处都是的词，命中它说明不了什么。
   */
  async search(query: string, limit = 20): Promise<CodebaseSymbolHit[]> {
    if (!query.trim()) return [];
    await this.ensureIndexed();
    return this.runSearch(query, limit);
  }

  /**
   * 「只搜现有索引」版本：不等待冷启动建索引，但在后台把它跑起来。
   *
   * 给 Agent 的 `codebase_search` 工具用。理由是这个工具跑在**工具循环里**——
   * 在这里同步等一次全量索引（大项目几十秒），表现为模型「卡住不动」，
   * 而它其实什么都没做错；用户唯一能看到的是一段长时间的静默。
   * 返回空 + 明确的降级提示，比阻塞住整个循环好得多。
   */
  async searchCached(query: string, limit = 20): Promise<CodebaseSymbolHit[]> {
    if (!query.trim()) return [];
    if (this.chunks.length === 0) {
      const previousRoot = this.loadedRoot;
      await this.loadFromDisk().catch(() => undefined);
      // loadFromDisk 在根变化时会清空内存索引；那时的「空」是正常的过渡态，
      // 不该顺手再触发一次重建（切换工作区的瞬间会白扫一遍新工作区）。
      if (this.chunks.length === 0 && previousRoot === this.loadedRoot) {
        // 后台补建，下一次调用就能命中
        void this.buildIndex().catch(() => undefined);
        return [];
      }
    }
    if (this.chunks.length === 0) return [];
    return this.runSearch(query, limit);
  }

  private async ensureIndexed(): Promise<void> {
    if (this.chunks.length > 0) return;
    await this.loadFromDisk().catch(() => undefined);
    if (this.chunks.length === 0) await this.buildIndex();
  }

  private runSearch(query: string, limit: number): CodebaseSymbolHit[] {
    const queryTokens = Array.from(new Set(tokenizeText(query)));
    if (queryTokens.length === 0) return [];

    const total = this.chunks.length;
    let totalLength = 0;
    for (const c of this.chunks) totalLength += c.length;
    const avgdl = total > 0 ? totalLength / total : 1;

    const scores = new Map<number, number>();

    for (const qToken of queryTokens) {
      const postings = this.invertedIndex.get(qToken);
      if (!postings) continue;
      const df = postings.length;
      // BM25 的 idf（概率式，避免 df 接近 N 时出现负值）
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));

      for (const idx of postings) {
        const chunk = this.chunks[idx];
        const tf = chunk.tf[qToken] ?? 0;
        const dl = chunk.length || 1;
        const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / (avgdl || 1));
        let score = (idf * (tf * (BM25_K1 + 1))) / (denom || 1);

        // 字段加权。符号名精确等于查询词时给最强信号 —— 用户敲的往往就是它想找的那个名字
        if (chunk.name.toLowerCase() === qToken) score += idf * 6;
        else if (chunk.nameTokens.includes(qToken)) score += idf * 3;
        if (chunk.docTokens.includes(qToken)) score += idf * 2;
        if (chunk.pathTokens.includes(qToken)) score += idf * 1.5;

        scores.set(idx, (scores.get(idx) ?? 0) + score);
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
        score: Math.round(score * 100) / 100,
      };
    });
  }

  /** 释放资源：把待写的索引落盘并停掉定时器（窗口关闭 / 应用退出时调用）。 */
  async dispose(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.saveToDisk().catch(() => undefined);
  }
}
