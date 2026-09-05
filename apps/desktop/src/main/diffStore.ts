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
    if (!diff) throw new Error(`Unknown diff ${id}`);
    await this.workspace.writeFile(diff.path, diff.modified);
    this.diffs.delete(id);
  }

  reject(id: string): void {
    this.diffs.delete(id);
  }

  async acceptAll(): Promise<void> {
    for (const id of [...this.diffs.keys()]) {
      await this.accept(id);
    }
  }
}

export function appendRunTrace(userDataPath: string, runId: string, line: string): void {
  const dir = path.join(userDataPath, 'traces');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, `${runId}.log`),
    `${new Date().toISOString()} ${line}\n`,
    'utf8',
  );
}

export type WindowGetter = () => BrowserWindow | null;
