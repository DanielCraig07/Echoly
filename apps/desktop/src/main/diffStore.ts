import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { PendingDiff } from '@deepseek-ide/shared';
import type { WorkspaceService } from './workspace';

export class DiffStore {
  private diffs = new Map<string, PendingDiff>();

  constructor(private readonly workspace: WorkspaceService) {}

  add(diff: PendingDiff): void {
    this.diffs.set(diff.id, diff);
  }

  get(id: string): PendingDiff | undefined {
    return this.diffs.get(id);
  }

  list(): PendingDiff[] {
    return [...this.diffs.values()];
  }

  async accept(id: string): Promise<void> {
    const diff = this.diffs.get(id);
    if (!diff) return;
    try {
      await this.workspace.writeFile(diff.path, diff.modified);
    } catch {}
    this.diffs.delete(id);
  }

  async reject(id: string): Promise<void> {
    const diff = this.diffs.get(id);
    if (diff) {
      try {
        await this.workspace.writeFile(diff.path, diff.original);
      } catch {}
      this.diffs.delete(id);
    }
  }

  async acceptAll(): Promise<void> {
    for (const id of [...this.diffs.keys()]) {
      await this.accept(id);
    }
  }

  async rejectAll(): Promise<void> {
    for (const id of [...this.diffs.keys()]) {
      await this.reject(id);
    }
  }
}

const ensuredTraceDirs = new Set<string>();
const traceBuffers = new Map<string, string[]>();
let flushTraceTimer: NodeJS.Timeout | null = null;

function flushTraceBuffers(userDataPath: string): void {
  flushTraceTimer = null;
  const dir = path.join(userDataPath, 'traces');
  if (!ensuredTraceDirs.has(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      ensuredTraceDirs.add(dir);
    } catch {}
  }
  for (const [runId, lines] of traceBuffers.entries()) {
    if (lines.length === 0) continue;
    const content = lines.join('');
    lines.length = 0;
    const targetFile = path.join(dir, `${runId}.log`);
    fs.appendFile(targetFile, content, 'utf8', () => {});
  }
}

export function appendRunTrace(userDataPath: string, runId: string, line: string): void {
  let list = traceBuffers.get(runId);
  if (!list) {
    list = [];
    traceBuffers.set(runId, list);
  }
  list.push(`${new Date().toISOString()} ${line}\n`);
  if (!flushTraceTimer) {
    flushTraceTimer = setTimeout(() => flushTraceBuffers(userDataPath), 200);
  }
}

export type WindowGetter = () => BrowserWindow | null;
