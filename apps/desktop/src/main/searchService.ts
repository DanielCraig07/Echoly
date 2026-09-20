import type { SearchCodeHit, SearchCodeRequest, SearchFileHit } from '@deepseek-ide/shared';
import {
  collectFilePaths,
  filterAndScoreFiles,
  searchCodeRemote,
  searchViaBackend,
  searchWithRg,
  runLocalCommand,
} from '@deepseek-ide/tools';
import type { WorkspaceService } from './workspace';

interface PathCacheEntry {
  root: string;
  files: string[];
  timestamp: number;
}

export class SearchService {
  private pathCache: PathCacheEntry | null = null;
  private readonly CACHE_TTL_MS = 600_000; // 10 分钟路径缓存（由 invalidateCache 主动失效）

  constructor(private readonly resolveWorkspace: () => WorkspaceService) {}

  private get workspace(): WorkspaceService {
    return this.resolveWorkspace();
  }

  /**
   * 清空文件路径缓存（在文件增删改或工作区变更时调用）
   */
  invalidateCache(): void {
    this.pathCache = null;
  }

  /**
   * 极速解析文件名或相对路径至工作区中的实际文件路径（毫秒级响应，避免全盘递归阻塞）
   */
  async resolveFilePath(fileNameOrPath: string): Promise<string | null> {
    const backend = this.workspace.getBackend();
    if (!backend) return null;
    const target = fileNameOrPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!target) return null;

    // 1. 如果路径直接存在于当前工作区中，极速直接返回
    try {
      if (await backend.exists(target)) {
        return target;
      }
    } catch {}

    const fileName = target.split('/').pop() || target;

    // 2. 优先利用现有热缓存（0.1ms 内存直接匹配）
    if (this.pathCache && this.pathCache.root === backend.root) {
      const matched = this.pathCache.files.find(
        (f) =>
          f === target ||
          f.endsWith('/' + target) ||
          f.endsWith('/' + fileName) ||
          f === fileName,
      );
      if (matched) return matched;
    }

    // 3. 极速 targeted 查找（毫秒级定向探测，避免全盘递归阻塞）
    if (backend.kind === 'local' && backend.root) {
      // 3.1 尝试 git ls-files 定向匹配（~10ms）
      try {
        const out = await runLocalCommand('git', ['ls-files', `*${fileName}*`], backend.root, 1500);
        if (out && out.trim()) {
          const lines = out
            .split(/\r?\n/)
            .map((s) => s.trim().replace(/^\.\//, '').replace(/\\/g, '/'))
            .filter(Boolean);
          const hit = lines.find(
            (l) => l === target || l.endsWith('/' + target) || l.endsWith('/' + fileName) || l === fileName,
          );
          if (hit) return hit;
          if (lines[0]) return lines[0];
        }
      } catch {}

      // 3.2 尝试 Unix find 定向探测（~20ms）
      if (process.platform !== 'win32') {
        try {
          const findCmd = `find . -name "${fileName}" -not -path "*/.*" -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/build/*" -print | head -n 5`;
          const out = await runLocalCommand('sh', ['-c', findCmd], backend.root, 1500);
          if (out && out.trim()) {
            const lines = out
              .split(/\r?\n/)
              .map((s) => s.trim().replace(/^\.\//, '').replace(/\\/g, '/'))
              .filter(Boolean);
            const hit = lines.find(
              (l) => l === target || l.endsWith('/' + target) || l.endsWith('/' + fileName) || l === fileName,
            );
            if (hit) return hit;
            if (lines[0]) return lines[0];
          }
        } catch {}
      }
    } else if (backend.kind === 'ssh' && typeof backend.runCommand === 'function') {
      // 远程 SSH 定向快速查找
      try {
        const findCmd = `find . -name "${fileName}" -not -path "*/.*" -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/build/*" -print | head -n 5`;
        const res = await backend.runCommand(findCmd, 2000);
        if (res.code === 0 && res.stdout.trim()) {
          const lines = res.stdout
            .split(/\r?\n/)
            .map((s) => s.trim().replace(/^\.\//, '').replace(/\\/g, '/'))
            .filter(Boolean);
          const hit = lines.find(
            (l) => l === target || l.endsWith('/' + target) || l.endsWith('/' + fileName) || l === fileName,
          );
          if (hit) return hit;
          if (lines[0]) return lines[0];
        }
      } catch {}
    }

    // 4. 兜底：如果尚未命中，尝试走 searchFiles 并更新缓存
    const hits = await this.searchFiles(fileName, 5);
    const matched = hits.find(
      (h) =>
        h.path === target ||
        h.path.endsWith('/' + target) ||
        h.path.endsWith('/' + fileName) ||
        h.path === fileName,
    );
    return matched?.path || hits[0]?.path || null;
  }

  async searchFiles(query: string, max = 50): Promise<SearchFileHit[]> {
    const backend = this.workspace.getBackend();
    if (!backend) return [];

    let files: string[];
    const now = Date.now();
    if (
      this.pathCache &&
      this.pathCache.root === backend.root &&
      now - this.pathCache.timestamp < this.CACHE_TTL_MS
    ) {
      files = this.pathCache.files;
    } else {
      files = await collectFilePaths(backend);
      this.pathCache = {
        root: backend.root,
        files,
        timestamp: now,
      };
    }

    const q = query.trim();
    if (!q) return [];

    const hits = filterAndScoreFiles(files, q, max);
    return hits.map((h) => ({ path: h.path, score: h.score }));
  }

  async searchCode(req: SearchCodeRequest): Promise<SearchCodeHit[]> {
    const query = req.query.trim();
    if (!query) return [];
    const backend = this.workspace.getBackend();
    if (!backend) return [];
    const root = this.workspace.getRoot();
    const opts = {
      glob: req.glob,
      caseInsensitive: req.caseInsensitive ?? true,
      maxResults: req.max ?? 80,
    };

    if (backend.kind === 'local' && root) {
      try {
        return await searchWithRg(root, query, opts);
      } catch {
        // fall through to backend walk
      }
    } else if (backend.kind === 'ssh') {
      try {
        return await searchCodeRemote(backend, query, opts);
      } catch {
        return [];
      }
    }

    return await searchViaBackend(backend, query, opts);
  }
}
