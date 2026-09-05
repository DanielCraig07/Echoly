import type { SearchCodeHit, SearchCodeRequest, SearchFileHit } from '@deepseek-ide/shared';
import {
  collectFilePaths,
  filterAndScoreFiles,
  searchCodeRemote,
  searchViaBackend,
  searchWithRg,
} from '@deepseek-ide/tools';
import type { WorkspaceService } from './workspace';

interface PathCacheEntry {
  root: string;
  files: string[];
  timestamp: number;
}

export class SearchService {
  private pathCache: PathCacheEntry | null = null;
  private readonly CACHE_TTL_MS = 30_000; // 30 秒路径缓存

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

  async searchFiles(query: string, max = 50): Promise<SearchFileHit[]> {
    const q = query.trim();
    if (!q) return [];
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
