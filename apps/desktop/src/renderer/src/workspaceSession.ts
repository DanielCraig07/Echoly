export interface CursorPos {
  line: number;
  col?: number;
  scrollTop?: number;
  scrollLeft?: number;
}

/**
 * 虚拟标签（目前是 SQL 控制台）的重开信息。
 *
 * 与磁盘文件分开存：`paths` 里的每一项都能直接 `readFile` 还原，而虚拟标签要先知道
 * 它是什么类型、连的是哪个连接 / 哪个库，再去读它自己的脚本文件。
 */
export interface VirtualTabState {
  /** 标签路径，形如 `db://console/<连接 id>/<脚本文件名>` */
  path: string;
  language: string;
  title?: string;
  /** 脚本在工作区内的相对路径；缺失表示这个标签没有落盘的脚本（不该发生，兜底跳过） */
  scriptPath?: string;
  scriptTarget?: { connectionId: string; schemaName?: string };
}

export interface WorkspaceOpenFilesState {
  paths: string[];
  activePath: string | null;
  cursorPositions?: Record<string, CursorPos>;
  activeLine?: number;
  activeCol?: number;
  activeScrollTop?: number;
  activeScrollLeft?: number;
  /** 上次打开时开着的 SQL 控制台（还原顺序排在普通文件之后） */
  virtualTabs?: VirtualTabState[];
  updatedAt: number;
}

const STORAGE_KEY = 'echoly_workspace_open_files';
const MAX_WORKSPACES = 40;

function normalizeRoot(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '') || root;
}

function readAll(): Record<string, WorkspaceOpenFilesState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, WorkspaceOpenFilesState>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, WorkspaceOpenFilesState>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // quota / private mode — ignore
  }
}

export function loadWorkspaceOpenFiles(root: string): WorkspaceOpenFilesState | null {
  const key = normalizeRoot(root);
  const state = readAll()[key];
  if (!state || !Array.isArray(state.paths)) return null;
  return state;
}

export function saveWorkspaceOpenFiles(
  root: string,
  paths: string[],
  activePath: string | null,
  cursorPositions?: Record<string, CursorPos>,
  activeLine?: number,
  activeCol?: number,
  activeScrollTop?: number,
  activeScrollLeft?: number,
  virtualTabs?: VirtualTabState[],
): void {
  const key = normalizeRoot(root);
  const map = readAll();
  map[key] = {
    paths: [...paths],
    activePath,
    cursorPositions: cursorPositions ? { ...cursorPositions } : undefined,
    activeLine: activeLine != null && activeLine > 0 ? activeLine : undefined,
    activeCol: activeCol != null && activeCol > 0 ? activeCol : undefined,
    activeScrollTop: activeScrollTop != null && activeScrollTop >= 0 ? activeScrollTop : undefined,
    activeScrollLeft: activeScrollLeft != null && activeScrollLeft >= 0 ? activeScrollLeft : undefined,
    virtualTabs: virtualTabs && virtualTabs.length > 0 ? virtualTabs.map((v) => ({ ...v })) : undefined,
    updatedAt: Date.now(),
  };

  // Cap stored workspaces by recency
  const entries = Object.entries(map).sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0));
  const trimmed = Object.fromEntries(entries.slice(0, MAX_WORKSPACES));
  writeAll(trimmed);
}

export function clearWorkspaceOpenFiles(root: string): void {
  const key = normalizeRoot(root);
  const map = readAll();
  if (!(key in map)) return;
  delete map[key];
  writeAll(map);
}
