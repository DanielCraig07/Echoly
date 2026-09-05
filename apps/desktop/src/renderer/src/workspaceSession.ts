/** Persist / restore which editor tabs were open for each workspace. */

export interface WorkspaceOpenFilesState {
  paths: string[];
  activePath: string | null;
  updatedAt: number;
}

const STORAGE_KEY = 'tsingtec_workspace_open_files';
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
): void {
  const key = normalizeRoot(root);
  const map = readAll();
  map[key] = {
    paths: [...paths],
    activePath,
    updatedAt: Date.now(),
  };

  // Cap stored workspaces by recency
  const entries = Object.entries(map).sort(
    (a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0),
  );
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
