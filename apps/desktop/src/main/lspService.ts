import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import * as rpc from 'vscode-jsonrpc/node';
import type { LspLocation } from '@deepseek-ide/shared';
import type { WorkspaceService } from './workspace';

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface RawLspLocation {
  uri?: string;
  targetUri?: string;
  range?: LspRange;
  targetSelectionRange?: LspRange;
  targetRange?: LspRange;
}

export class LspService {
  private pyrightProcess: ChildProcess | null = null;
  private connection: rpc.MessageConnection | null = null;
  private isInitialized = false;
  private isInitializing = false;
  private currentWorkspaceRoot: string | null = null;
  private openDocuments = new Map<string, { version: number; languageId: string }>();

  constructor(private readonly resolveWorkspace: () => WorkspaceService) {}

  private get workspace(): WorkspaceService {
    return this.resolveWorkspace();
  }

  /**
   * Resolves the workspace root path.
   */
  private getRoot(): string | null {
    try {
      return this.workspace.getRoot();
    } catch {
      return null;
    }
  }

  /**
   * Ensures the Pyright LSP server is running and initialized for the current workspace.
   */
  private async ensurePyright(): Promise<rpc.MessageConnection | null> {
    const root = this.getRoot();

    // If workspace changed, restart LSP server
    if (this.isInitialized && this.currentWorkspaceRoot !== root) {
      this.dispose();
    }

    if (this.connection && this.isInitialized) {
      return this.connection;
    }

    if (this.isInitializing) {
      // Wait for existing initialization to complete
      let retries = 20;
      while (this.isInitializing && retries-- > 0) {
        await new Promise((r) => setTimeout(r, 150));
      }
      return this.connection;
    }

    this.isInitializing = true;

    try {
      let pyrightPath: string;
      try {
        pyrightPath = require.resolve('pyright/dist/pyright-langserver.js');
      } catch {
        console.warn('[LspService] pyright package not found.');
        this.isInitializing = false;
        return null;
      }

      const child = spawn(process.execPath, [pyrightPath, '--stdio'], {
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      });

      this.pyrightProcess = child;

      const connection = rpc.createMessageConnection(
        new rpc.StreamMessageReader(child.stdout!),
        new rpc.StreamMessageWriter(child.stdin!),
      );

      connection.listen();

      const workspaceRoot = root || process.cwd();
      this.currentWorkspaceRoot = root;
      const rootUri = pathToFileURL(workspaceRoot).toString();

      await connection.sendRequest('initialize', {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: {
            definition: { dynamicRegistration: true, linkSupport: true },
            references: { dynamicRegistration: true },
            hover: { dynamicRegistration: true, contentFormat: ['markdown', 'plaintext'] },
          },
        },
        workspaceFolders: [{ uri: rootUri, name: path.basename(workspaceRoot) }],
      });

      connection.sendNotification('initialized', {});

      this.connection = connection;
      this.isInitialized = true;
      this.openDocuments.clear();

      child.on('exit', (code) => {
        console.log('[LspService] Pyright server exited with code', code);
        this.isInitialized = false;
        this.connection = null;
        this.pyrightProcess = null;
        this.openDocuments.clear();
      });

      return connection;
    } catch (err) {
      console.error('[LspService] Failed to start Pyright server:', err);
      return null;
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Converts a relative or absolute file path into an absolute file path and URI.
   */
  private resolveFilePathAndUri(filePath: string): { absPath: string; uri: string } {
    let absPath = filePath;
    const root = this.getRoot();
    if (!path.isAbsolute(absPath) && root) {
      absPath = path.resolve(root, filePath);
    }
    const uri = pathToFileURL(absPath).toString();
    return { absPath, uri };
  }

  /**
   * Sync document content with the LSP server.
   */
  async notifyDocument(filePath: string, content: string, languageId = 'python'): Promise<void> {
    const conn = await this.ensurePyright();
    if (!conn) return;

    const { uri } = this.resolveFilePathAndUri(filePath);
    const existing = this.openDocuments.get(uri);

    if (!existing) {
      this.openDocuments.set(uri, { version: 1, languageId });
      conn.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId,
          version: 1,
          text: content,
        },
      });
    } else {
      const nextVersion = existing.version + 1;
      this.openDocuments.set(uri, { version: nextVersion, languageId });
      conn.sendNotification('textDocument/didChange', {
        textDocument: {
          uri,
          version: nextVersion,
        },
        contentChanges: [{ text: content }],
      });
    }
  }

  /**
   * Request definition for a symbol in a file at the given 1-based line & column.
   */
  async getDefinition(
    filePath: string,
    line: number,
    column: number,
  ): Promise<LspLocation[]> {
    const conn = await this.ensurePyright();
    if (!conn) return [];

    const { absPath, uri } = this.resolveFilePathAndUri(filePath);

    // If document is not yet synced, try to read from disk and sync it
    if (!this.openDocuments.has(uri) && fs.existsSync(absPath)) {
      try {
        const text = fs.readFileSync(absPath, 'utf8');
        await this.notifyDocument(filePath, text, 'python');
      } catch (err) {
        console.warn('[LspService] Could not read file for sync:', err);
      }
    }

    try {
      const rawRes = await conn.sendRequest<
        RawLspLocation | RawLspLocation[] | null
      >('textDocument/definition', {
        textDocument: { uri },
        position: {
          line: Math.max(0, line - 1),
          character: Math.max(0, column - 1),
        },
      });

      if (!rawRes) return [];

      const rawLocations: RawLspLocation[] = Array.isArray(rawRes) ? rawRes : [rawRes];
      const results: LspLocation[] = [];

      for (const loc of rawLocations) {
        const targetUriStr = loc.targetUri || loc.uri;
        const targetRange = loc.targetSelectionRange || loc.targetRange || loc.range;
        if (!targetUriStr || !targetRange) continue;

        let targetPath: string;
        try {
          targetPath = fileURLToPath(targetUriStr);
        } catch {
          targetPath = targetUriStr.replace(/^file:\/\//, '');
        }

        results.push({
          path: targetPath,
          line: targetRange.start.line + 1,
          column: targetRange.start.character + 1,
          endLine: targetRange.end.line + 1,
          endColumn: targetRange.end.character + 1,
        });
      }

      return results;
    } catch (err) {
      console.warn('[LspService] textDocument/definition error:', err);
      return [];
    }
  }

  /**
   * Stop and cleanup the LSP child process.
   */
  dispose(): void {
    if (this.connection) {
      try {
        this.connection.dispose();
      } catch {
        // ignore
      }
      this.connection = null;
    }

    if (this.pyrightProcess) {
      try {
        this.pyrightProcess.kill('SIGTERM');
        const proc = this.pyrightProcess;
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 1000);
      } catch {
        // ignore
      }
      this.pyrightProcess = null;
    }

    this.isInitialized = false;
    this.isInitializing = false;
    this.openDocuments.clear();
  }
}
