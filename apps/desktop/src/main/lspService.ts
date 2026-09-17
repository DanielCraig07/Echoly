import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import EventEmitter from 'node:events';
import * as rpc from 'vscode-jsonrpc/node';
import type { LspLocation, LspCompletionItem, LspDiagnosticsEvent } from '@deepseek-ide/shared';
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

interface ServerInstance {
  process: ChildProcess | null;
  connection: rpc.MessageConnection | null;
  isInitialized: boolean;
  isInitializing: boolean;
  openDocuments: Map<string, { version: number; languageId: string }>;
  workspaceRoot: string | null;
}

export class LspService extends EventEmitter {
  private pyright: ServerInstance = this.createEmptyServerInstance();
  private clangd: ServerInstance = this.createEmptyServerInstance();
  private gopls: ServerInstance = this.createEmptyServerInstance();

  constructor(private readonly resolveWorkspace: () => WorkspaceService) {
    super();
  }

  private createEmptyServerInstance(): ServerInstance {
    return {
      process: null,
      connection: null,
      isInitialized: false,
      isInitializing: false,
      openDocuments: new Map(),
      workspaceRoot: null,
    };
  }

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
   * Determines if a file path belongs to C/C++.
   */
  private isCppFile(filePath: string, languageId?: string): boolean {
    if (languageId === 'cpp' || languageId === 'c') return true;
    return /\.(cpp|cc|cxx|c|h|hpp|hh|hxx)$/i.test(filePath);
  }

  /**
   * Determines if a file path belongs to Python.
   */
  private isPythonFile(filePath: string, languageId?: string): boolean {
    if (languageId === 'python') return true;
    return /\.(py|pyi)$/i.test(filePath);
  }

  /**
   * Determines if a file path belongs to Go.
   */
  private isGoFile(filePath: string, languageId?: string): boolean {
    if (languageId === 'go') return true;
    return /\.go$/i.test(filePath);
  }

  /**
   * Finds the path to the gopls executable on the system.
   */
  private findGoplsExecutable(): string | null {
    const isWin = process.platform === 'win32';
    const binaryName = isWin ? 'gopls.exe' : 'gopls';

    const homeDir = process.env.HOME || '';
    const goPath = process.env.GOPATH || path.join(homeDir, 'go');

    const candidates = [
      '/opt/homebrew/bin/gopls',
      '/usr/local/bin/gopls',
      '/usr/bin/gopls',
      path.join(goPath, 'bin', binaryName),
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return c;
      }
    }

    const envPath = process.env.PATH || '';
    const dirs = envPath.split(path.delimiter);
    for (const dir of dirs) {
      const full = path.join(dir, binaryName);
      if (fs.existsSync(full)) {
        return full;
      }
    }

    return null;
  }

  /**
   * Finds the path to the clangd executable on the system.
   */
  private findClangdExecutable(): string | null {
    const isWin = process.platform === 'win32';
    const binaryName = isWin ? 'clangd.exe' : 'clangd';

    const candidates = [
      '/usr/bin/clangd',
      '/opt/homebrew/bin/clangd',
      '/usr/local/bin/clangd',
      '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clangd',
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return c;
      }
    }

    // Check system PATH
    const envPath = process.env.PATH || '';
    const dirs = envPath.split(path.delimiter);
    for (const dir of dirs) {
      const full = path.join(dir, binaryName);
      if (fs.existsSync(full)) {
        return full;
      }
    }

    return null;
  }

  /**
   * Ensures the Clangd LSP server is running and initialized for C/C++.
   */
  private async ensureClangd(): Promise<rpc.MessageConnection | null> {
    const root = this.getRoot();

    if (this.clangd.isInitialized && this.clangd.workspaceRoot !== root) {
      this.disposeServer(this.clangd);
    }

    if (this.clangd.connection && this.clangd.isInitialized) {
      return this.clangd.connection;
    }

    if (this.clangd.isInitializing) {
      let retries = 25;
      while (this.clangd.isInitializing && retries-- > 0) {
        await new Promise((r) => setTimeout(r, 150));
      }
      return this.clangd.connection;
    }

    this.clangd.isInitializing = true;

    try {
      const clangdBin = this.findClangdExecutable();
      if (!clangdBin) {
        console.warn('[LspService] clangd binary not found on system.');
        this.clangd.isInitializing = false;
        return null;
      }

      const workspaceRoot = root || process.cwd();
      const clangdArgs = [
        '--background-index',
        '--clang-tidy',
        '--completion-style=detailed',
        '--header-insertion=iwyu',
      ];

      // Auto-detect CMake compilation database
      if (fs.existsSync(path.join(workspaceRoot, 'build', 'compile_commands.json'))) {
        clangdArgs.push('--compile-commands-dir=build');
      } else if (fs.existsSync(path.join(workspaceRoot, 'compile_commands.json'))) {
        clangdArgs.push('--compile-commands-dir=.');
      }

      const child = spawn(clangdBin, clangdArgs, {
        cwd: workspaceRoot,
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      });

      this.clangd.process = child;

      const connection = rpc.createMessageConnection(
        new rpc.StreamMessageReader(child.stdout!),
        new rpc.StreamMessageWriter(child.stdin!),
      );

      connection.listen();

      const rootUri = pathToFileURL(workspaceRoot).toString();
      await connection.sendRequest('initialize', {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: {
            definition: { dynamicRegistration: true, linkSupport: true },
            references: { dynamicRegistration: true },
            hover: { dynamicRegistration: true, contentFormat: ['markdown', 'plaintext'] },
            completion: {
              dynamicRegistration: true,
              completionItem: {
                snippetSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
              },
            },
            publishDiagnostics: {
              relatedInformation: true,
            },
          },
        },
        workspaceFolders: [{ uri: rootUri, name: path.basename(workspaceRoot) }],
      });

      connection.onNotification('textDocument/publishDiagnostics', (params: any) => {
        let filePath = params.uri;
        try {
          filePath = fileURLToPath(params.uri);
        } catch {
          filePath = params.uri.replace(/^file:\/\//, '');
        }
        this.emit('diagnostics', {
          uri: params.uri,
          path: filePath,
          diagnostics: params.diagnostics || [],
        } as LspDiagnosticsEvent);
      });

      connection.sendNotification('initialized', {});

      this.clangd.connection = connection;
      this.clangd.isInitialized = true;
      this.clangd.workspaceRoot = root;
      this.clangd.openDocuments.clear();

      child.on('exit', (code) => {
        console.log('[LspService] Clangd server exited with code', code);
        this.disposeServer(this.clangd);
      });

      return connection;
    } catch (err) {
      console.error('[LspService] Failed to start Clangd server:', err);
      return null;
    } finally {
      this.clangd.isInitializing = false;
    }
  }

  /**
   * Ensures the Pyright LSP server is running and initialized for Python.
   */
  private async ensurePyright(): Promise<rpc.MessageConnection | null> {
    const root = this.getRoot();

    if (this.pyright.isInitialized && this.pyright.workspaceRoot !== root) {
      this.disposeServer(this.pyright);
    }

    if (this.pyright.connection && this.pyright.isInitialized) {
      return this.pyright.connection;
    }

    if (this.pyright.isInitializing) {
      let retries = 20;
      while (this.pyright.isInitializing && retries-- > 0) {
        await new Promise((r) => setTimeout(r, 150));
      }
      return this.pyright.connection;
    }

    this.pyright.isInitializing = true;

    try {
      let pyrightPath: string;
      try {
        pyrightPath = require.resolve('pyright/dist/pyright-langserver.js');
      } catch {
        console.warn('[LspService] pyright package not found.');
        this.pyright.isInitializing = false;
        return null;
      }

      const child = spawn(process.execPath, [pyrightPath, '--stdio'], {
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      });

      this.pyright.process = child;

      const connection = rpc.createMessageConnection(
        new rpc.StreamMessageReader(child.stdout!),
        new rpc.StreamMessageWriter(child.stdin!),
      );

      connection.listen();

      const workspaceRoot = root || process.cwd();
      const rootUri = pathToFileURL(workspaceRoot).toString();

      const venvDirs = ['.venv', 'venv', 'env'];
      let pythonInterpreter: string | undefined;
      for (const v of venvDirs) {
        const p = path.join(workspaceRoot, v, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
        if (fs.existsSync(p)) {
          pythonInterpreter = p;
          break;
        }
      }

      await connection.sendRequest('initialize', {
        processId: process.pid,
        rootUri,
        initializationOptions: pythonInterpreter ? { python: { pythonPath: pythonInterpreter } } : undefined,
        capabilities: {
          textDocument: {
            definition: { dynamicRegistration: true, linkSupport: true },
            references: { dynamicRegistration: true },
            hover: { dynamicRegistration: true, contentFormat: ['markdown', 'plaintext'] },
            completion: {
              dynamicRegistration: true,
              completionItem: {
                snippetSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
              },
            },
            publishDiagnostics: {
              relatedInformation: true,
            },
          },
        },
        workspaceFolders: [{ uri: rootUri, name: path.basename(workspaceRoot) }],
      });

      connection.onNotification('textDocument/publishDiagnostics', (params: any) => {
        let filePath = params.uri;
        try {
          filePath = fileURLToPath(params.uri);
        } catch {
          filePath = params.uri.replace(/^file:\/\//, '');
        }
        this.emit('diagnostics', {
          uri: params.uri,
          path: filePath,
          diagnostics: params.diagnostics || [],
        } as LspDiagnosticsEvent);
      });

      connection.sendNotification('initialized', {});

      this.pyright.connection = connection;
      this.pyright.isInitialized = true;
      this.pyright.workspaceRoot = root;
      this.pyright.openDocuments.clear();

      child.on('exit', (code) => {
        console.log('[LspService] Pyright server exited with code', code);
        this.disposeServer(this.pyright);
      });

      return connection;
    } catch (err) {
      console.error('[LspService] Failed to start Pyright server:', err);
      return null;
    } finally {
      this.pyright.isInitializing = false;
    }
  }

  /**
   * Ensures the Gopls LSP server is running and initialized for Go.
   */
  private async ensureGopls(): Promise<rpc.MessageConnection | null> {
    const root = this.getRoot();

    if (this.gopls.isInitialized && this.gopls.workspaceRoot !== root) {
      this.disposeServer(this.gopls);
    }

    if (this.gopls.connection && this.gopls.isInitialized) {
      return this.gopls.connection;
    }

    if (this.gopls.isInitializing) {
      let retries = 20;
      while (this.gopls.isInitializing && retries-- > 0) {
        await new Promise((r) => setTimeout(r, 150));
      }
      return this.gopls.connection;
    }

    this.gopls.isInitializing = true;

    try {
      const goplsBin = this.findGoplsExecutable();
      if (!goplsBin) {
        this.gopls.isInitializing = false;
        return null;
      }

      const workspaceRoot = root || process.cwd();
      const child = spawn(goplsBin, [], {
        cwd: workspaceRoot,
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      });

      this.gopls.process = child;

      const connection = rpc.createMessageConnection(
        new rpc.StreamMessageReader(child.stdout!),
        new rpc.StreamMessageWriter(child.stdin!),
      );

      connection.listen();

      const rootUri = pathToFileURL(workspaceRoot).toString();

      await connection.sendRequest('initialize', {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: {
            definition: { dynamicRegistration: true, linkSupport: true },
            references: { dynamicRegistration: true },
            hover: { dynamicRegistration: true, contentFormat: ['markdown', 'plaintext'] },
            completion: {
              dynamicRegistration: true,
              completionItem: {
                snippetSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
              },
            },
            publishDiagnostics: {
              relatedInformation: true,
            },
          },
        },
        workspaceFolders: [{ uri: rootUri, name: path.basename(workspaceRoot) }],
      });

      connection.onNotification('textDocument/publishDiagnostics', (params: any) => {
        let filePath = params.uri;
        try {
          filePath = fileURLToPath(params.uri);
        } catch {
          filePath = params.uri.replace(/^file:\/\//, '');
        }
        this.emit('diagnostics', {
          uri: params.uri,
          path: filePath,
          diagnostics: params.diagnostics || [],
        } as LspDiagnosticsEvent);
      });

      connection.sendNotification('initialized', {});

      this.gopls.connection = connection;
      this.gopls.isInitialized = true;
      this.gopls.workspaceRoot = root;
      this.gopls.openDocuments.clear();

      child.on('exit', (code) => {
        console.log('[LspService] Gopls server exited with code', code);
        this.disposeServer(this.gopls);
      });

      return connection;
    } catch (err) {
      console.error('[LspService] Failed to start Gopls server:', err);
      return null;
    } finally {
      this.gopls.isInitializing = false;
    }
  }

  /**
   * Resolves the corresponding LSP connection and state for a target file.
   */
  private async getServerForFile(
    filePath: string,
    languageId?: string,
  ): Promise<{ conn: rpc.MessageConnection; instance: ServerInstance; lang: string } | null> {
    if (this.isCppFile(filePath, languageId)) {
      const conn = await this.ensureClangd();
      if (!conn) return null;
      const lang = languageId || (filePath.endsWith('.c') ? 'c' : 'cpp');
      return { conn, instance: this.clangd, lang };
    }
    if (this.isPythonFile(filePath, languageId)) {
      const conn = await this.ensurePyright();
      if (!conn) return null;
      return { conn, instance: this.pyright, lang: languageId || 'python' };
    }
    if (this.isGoFile(filePath, languageId)) {
      const conn = await this.ensureGopls();
      if (!conn) return null;
      return { conn, instance: this.gopls, lang: languageId || 'go' };
    }
    return null;
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
   * Sync document content with the corresponding LSP server.
   */
  async notifyDocument(filePath: string, content: string, languageId?: string): Promise<void> {
    const srv = await this.getServerForFile(filePath, languageId);
    if (!srv) return;

    const { conn, instance, lang } = srv;
    const { uri } = this.resolveFilePathAndUri(filePath);
    const existing = instance.openDocuments.get(uri);

    if (!existing) {
      instance.openDocuments.set(uri, { version: 1, languageId: lang });
      conn.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: lang,
          version: 1,
          text: content,
        },
      });
    } else {
      const nextVersion = existing.version + 1;
      instance.openDocuments.set(uri, { version: nextVersion, languageId: lang });
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
    const srv = await this.getServerForFile(filePath);
    if (!srv) return [];

    const { conn, instance, lang } = srv;
    const { absPath, uri } = this.resolveFilePathAndUri(filePath);

    // If document is not yet synced, read and sync it
    if (!instance.openDocuments.has(uri) && fs.existsSync(absPath)) {
      try {
        const text = fs.readFileSync(absPath, 'utf8');
        await this.notifyDocument(filePath, text, lang);
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
   * Request completion items at a given 1-based line & column.
   */
  async getCompletion(
    filePath: string,
    line: number,
    column: number,
  ): Promise<LspCompletionItem[]> {
    const srv = await this.getServerForFile(filePath);
    if (!srv) return [];

    const { conn, instance, lang } = srv;
    const { absPath, uri } = this.resolveFilePathAndUri(filePath);

    if (!instance.openDocuments.has(uri) && fs.existsSync(absPath)) {
      try {
        const text = fs.readFileSync(absPath, 'utf8');
        await this.notifyDocument(filePath, text, lang);
      } catch (err) {
        console.warn('[LspService] Could not read file for completion sync:', err);
      }
    }

    try {
      const rawRes = await conn.sendRequest<any>('textDocument/completion', {
        textDocument: { uri },
        position: {
          line: Math.max(0, line - 1),
          character: Math.max(0, column - 1),
        },
      });

      if (!rawRes) return [];
      const items: any[] = Array.isArray(rawRes) ? rawRes : (rawRes.items || []);

      return items.slice(0, 50).map((it) => ({
        label: typeof it.label === 'string' ? it.label : it.label?.label || '',
        kind: it.kind,
        detail: it.detail,
        documentation:
          typeof it.documentation === 'string'
            ? it.documentation
            : it.documentation?.value,
        insertText:
          it.insertText ||
          (typeof it.label === 'string' ? it.label : it.label?.label || ''),
        sortText: it.sortText,
      }));
    } catch (err) {
      console.warn('[LspService] textDocument/completion error:', err);
      return [];
    }
  }

  /**
   * C/C++: Switch between source file and header file (.cpp <-> .h) via Clangd.
   */
  async switchSourceHeader(filePath: string): Promise<string | null> {
    const conn = await this.ensureClangd();
    if (!conn) {
      // Fallback: heuristic path search if clangd is not running
      const ext = path.extname(filePath).toLowerCase();
      const dir = path.dirname(filePath);
      const base = path.basename(filePath, ext);

      const headerExts = ['.h', '.hpp', '.hh', '.hxx'];
      const sourceExts = ['.cpp', '.cc', '.cxx', '.c'];
      const targetExts = headerExts.includes(ext) ? sourceExts : headerExts;

      for (const tExt of targetExts) {
        const candidate = path.join(dir, `${base}${tExt}`);
        if (fs.existsSync(candidate)) return candidate;
        // Also check ../include or ../src sibling dirs
        const includeCandidate = path.resolve(dir, '..', 'include', `${base}${tExt}`);
        if (fs.existsSync(includeCandidate)) return includeCandidate;
        const srcCandidate = path.resolve(dir, '..', 'src', `${base}${tExt}`);
        if (fs.existsSync(srcCandidate)) return srcCandidate;
      }
      return null;
    }

    const { absPath, uri } = this.resolveFilePathAndUri(filePath);

    if (!this.clangd.openDocuments.has(uri) && fs.existsSync(absPath)) {
      try {
        const text = fs.readFileSync(absPath, 'utf8');
        await this.notifyDocument(filePath, text, 'cpp');
      } catch {
        /* ignore */
      }
    }

    try {
      const targetUri = await conn.sendRequest<string | null>('textDocument/switchSourceHeader', {
        uri,
      });

      if (targetUri && typeof targetUri === 'string' && targetUri.length > 0) {
        try {
          return fileURLToPath(targetUri);
        } catch {
          return targetUri.replace(/^file:\/\//, '');
        }
      }
    } catch (err) {
      console.warn('[LspService] textDocument/switchSourceHeader failed:', err);
    }

    return null;
  }

  private disposeServer(instance: ServerInstance): void {
    if (instance.connection) {
      try {
        instance.connection.dispose();
      } catch {
        /* ignore */
      }
      instance.connection = null;
    }

    if (instance.process) {
      try {
        instance.process.kill('SIGTERM');
        const proc = instance.process;
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 1000);
      } catch {
        /* ignore */
      }
      instance.process = null;
    }

    instance.isInitialized = false;
    instance.isInitializing = false;
    instance.openDocuments.clear();
    instance.workspaceRoot = null;
  }

  /**
   * Stop and cleanup all LSP child processes.
   */
  dispose(): void {
    this.disposeServer(this.pyright);
    this.disposeServer(this.clangd);
    this.disposeServer(this.gopls);
  }
}
