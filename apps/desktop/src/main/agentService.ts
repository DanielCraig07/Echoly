import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, type WebContents } from 'electron';
import path from 'node:path';
import type {
  AgentEvent,
  AgentMode,
  ChatAttachment,
  ChatMessage,
  ConfirmRequest,
  PermissionMode,
  PlanContext,
  QueuedUserMessage,
} from '@deepseek-ide/shared';
import { DEFAULT_LLM_MODEL } from '@deepseek-ide/shared';
import type { SlashCommandInfo } from '@deepseek-ide/shared';
import { runAgent } from '@deepseek-ide/agent';
import { probeLlm } from '@deepseek-ide/llm';
import {
  discoverCommands,
  discoverSkills,
  formatSkillsForPrompt,
  selectSkillsForPrompt,
} from '@deepseek-ide/skills';
import type { SettingsStore } from './settings';
import { appendRunTrace, type WindowGetter } from './diffStore';
import type { WindowRegistry } from './windowRegistry';
import type { McpService } from './mcpService';
import { RulesService } from './rulesService';

interface PendingConfirm {
  resolve: (result: boolean | string) => void;
  kind: ConfirmRequest['kind'];
  runId: string;
}

function shouldAutoApproveConfirm(mode: PermissionMode, kind: ConfirmRequest['kind']): boolean {
  if (mode === 'allow_all_extreme') return true;
  if (mode === 'allow_all' && kind !== 'other') return true;
  return false;
}

interface PendingContinue {
  resolve: (ok: boolean) => void;
}

/**
 * 运行中追加的用户消息队列，按 runId 归集。
 *
 * `drain` 的语义是「取空并返回」，而不是「看一眼」：Agent 在步骤边界上调用它，
 * 若同一批被取走两次，同一条用户消息会在上下文里出现两遍，模型大概率会重复执行。
 */
export class MessageQueue {
  private queues = new Map<string, QueuedUserMessage[]>();

  push(runId: string, message: QueuedUserMessage): boolean {
    const list = this.queues.get(runId);
    if (!list) return false;
    list.push(message);
    return true;
  }

  drain(runId: string): QueuedUserMessage[] {
    const list = this.queues.get(runId);
    if (!list || list.length === 0) return [];
    // 取空但保留这个键：本轮还在跑，用户接下来仍然可以继续追加。
    // 删掉键会让 push 返回 false，界面上后面的消息就被误判成「该轮已结束」。
    this.queues.set(runId, []);
    return list;
  }

  open(runId: string): void {
    this.queues.set(runId, []);
  }

  /** 该轮结束时把没被取走的消息交还调用方，由它决定是转成新一轮还是退回输入框。 */
  close(runId: string): QueuedUserMessage[] {
    const list = this.queues.get(runId) ?? [];
    this.queues.delete(runId);
    return list;
  }
}

export class AgentService {
  private runs = new Map<string, AbortController>();
  private confirms = new Map<string, PendingConfirm>();
  private continues = new Map<string, PendingContinue>();
  /** runId → originating webContents.id so events go to the correct window */
  private runSenders = new Map<string, number>();
  private queuedMessages = new MessageQueue();
  private rulesService = new RulesService();

  constructor(
    private readonly deps: {
      settings: SettingsStore;
      registry: WindowRegistry;
      getWindow: WindowGetter;
      /** 进程级单例；未接入时 Agent 就是一台没有外部工具的本地 Agent。 */
      mcp?: McpService;
    },
  ) {}

  private windowForRun(runId: string): BrowserWindow | null {
    const wcId = this.runSenders.get(runId);
    if (wcId != null) {
      const owned = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && w.webContents.id === wcId,
      );
      if (owned) return owned;
    }
    return this.deps.getWindow();
  }

  /**
   * 把没等到步骤边界就被终结的追加消息报回界面。
   *
   * 必须在 `done`/`error` **之前**调用：渲染层收到这两个事件就会清掉 runId，
   * 之后再拿同一个 runId 发事件，多标签页下会找不到归属而被丢弃，
   * 用户看到的气泡就永远停在「排队中」。
   */
  private flushUndelivered(runId: string): void {
    const undelivered = this.queuedMessages.close(runId);
    if (undelivered.length === 0) return;
    this.emit(runId, {
      type: 'queued_message_undelivered',
      ids: undelivered.map((m) => m.id),
      reason: '本轮已结束，消息未送达',
    });
  }

  private emit(runId: string, event: AgentEvent): void {
    if (event.type !== 'token' && event.type !== 'thinking_token') {
      appendRunTrace(app.getPath('userData'), runId, JSON.stringify(event));
    }
    const win = this.windowForRun(runId);
    if (win && !win.isDestroyed()) {
      win.webContents.send('agent:event', { runId, ...event });
    }
  }

  private userSkillsDir(): string {
    return path.join(app.getPath('userData'), 'skills');
  }

  async listSkills() {
    const session =
      this.deps.registry.tryCurrent() ?? this.deps.registry.resolve(this.deps.getWindow);
    const workspaceRoot =
      session.workspace.getKind() === 'local' ? session.workspace.getRoot() : null;
    const skills = await discoverSkills({
      workspaceRoot,
      userSkillsDir: this.userSkillsDir(),
    });
    return skills.map(({ name, description, source, path: p }) => ({
      name,
      description,
      source,
      path: p,
    }));
  }

  openUserSkillsDir(): string {
    const dir = this.userSkillsDir();
    return dir;
  }

  /**
   * 列出可用的 slash 命令。
   *
   * 每次都重新扫盘而不是缓存：这些是纯文本文件，读一遍的成本远低于「用户新建了命令
   * 却要重启应用才能看到」的困惑。命令面板本来就是「我记得刚写过这个」的场景。
   */
  async listCommands(): Promise<SlashCommandInfo[]> {
    const session =
      this.deps.registry.tryCurrent() ?? this.deps.registry.resolve(this.deps.getWindow);
    const root = session.workspace.getKind() === 'local' ? session.workspace.getRoot() : null;
    return await discoverCommands({
      workspaceRoot: root,
      userCommandsDir: path.join(app.getPath('userData'), 'commands'),
      toDisplayPath: (abs) => (root ? path.relative(root, abs).replace(/\\/g, '/') : abs),
    });
  }

  async probe(options?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    provider?: string;
  }): Promise<{ ok: boolean; detail: string; models?: string[] }> {
    const s = this.deps.settings.get();
    let baseUrl = options?.baseUrl;
    let apiKey = options?.apiKey;
    let model = options?.model;
    let provider = options?.provider;

    if (!baseUrl) {
      const activeModel = s.models?.find((m) => m.id === s.activeModelId);
      if (activeModel) {
        baseUrl = activeModel.baseUrl;
        apiKey = activeModel.apiKey;
        model = activeModel.model;
        provider = activeModel.provider;
      } else {
        const currentProvider = s.currentProvider || 'deepseek';
        const providerConfig = s.providers?.[currentProvider] || {
          provider: currentProvider,
          baseUrl: s.baseUrl || 'http://192.168.10.241:8002',
          apiKey: s.apiKey || '',
          model: s.model || DEFAULT_LLM_MODEL,
        };
        baseUrl = providerConfig.baseUrl;
        apiKey = providerConfig.apiKey;
        model = providerConfig.model;
        provider = providerConfig.provider;
      }
    }

    return probeLlm({
      baseUrl: baseUrl || 'http://192.168.10.241:8002',
      apiKey: apiKey || '',
      model: model || DEFAULT_LLM_MODEL,
      provider: provider || 'deepseek',
    });
  }

  respondConfirm(requestId: string, approved: boolean, answer?: string): void {
    const pending = this.confirms.get(requestId);
    if (!pending) return;
    this.confirms.delete(requestId);
    if (!approved) {
      pending.resolve(false);
      return;
    }
    const text = answer?.trim();
    pending.resolve(text ? text : true);
  }

  /** 设置变更后调用：对已挂起的确认按新权限自动放行 */
  onPermissionModeChanged(mode: PermissionMode): void {
    for (const [id, pending] of [...this.confirms.entries()]) {
      if (!shouldAutoApproveConfirm(mode, pending.kind)) continue;
      this.confirms.delete(id);
      pending.resolve(true);
      this.emit(pending.runId, {
        type: 'confirm_resolved',
        requestId: id,
        reason: 'auto_approved',
      });
      this.emit(pending.runId, { type: 'status', status: 'tool_running' });
    }
  }

  continueAgent(runId: string): void {
    const pending = this.continues.get(runId);
    if (!pending) return;
    this.continues.delete(runId);
    pending.resolve(true);
  }

  stopContinueAgent(runId: string): void {
    const pending = this.continues.get(runId);
    if (!pending) return;
    this.continues.delete(runId);
    pending.resolve(false);
  }

  /**
   * 向正在运行的一轮追加一条用户消息。
   *
   * 返回 false 表示这一轮已经不在了（刚结束、或 runId 根本不存在）——
   * 调用方据此改走「新起一轮」，而不是把用户刚敲的内容丢掉。
   */
  queueMessage(runId: string, message: QueuedUserMessage): boolean {
    if (!this.runs.has(runId)) return false;
    return this.queuedMessages.push(runId, message);
  }

  cancel(runId: string): void {
    // Unblock anything waiting on confirm / continue, then abort in-flight LLM I/O.
    this.stopContinueAgent(runId);
    for (const [id, pending] of [...this.confirms.entries()]) {
      if (pending.runId !== runId) continue;
      this.confirms.delete(id);
      pending.resolve(false);
      this.emit(runId, { type: 'confirm_resolved', requestId: id, reason: 'cancelled' });
    }
    this.runs.get(runId)?.abort();
  }

  async start(
    payload: {
      prompt: string;
      mode?: AgentMode;
      modelId?: string;
      planContext?: PlanContext;
      openFiles?: Array<{ path: string; content: string }>;
      selection?: string;
      cursor?: { path: string; line: number; column: number };
      history?: ChatMessage[];
      attachments?: ChatAttachment[];
    },
    sender?: WebContents,
  ): Promise<{ runId: string }> {
    const session = sender
      ? this.deps.registry.forWebContents(sender)
      : this.deps.registry.resolve(this.deps.getWindow);
    const workspace = session.workspace;
    const diffs = session.diffs;
    const workspaceRoot = workspace.requireRoot();
    const backend = workspace.requireBackend();
    const settings = this.deps.settings.get();
    const mode: AgentMode = payload.mode ?? 'agent';
    const runId = randomUUID();
    const controller = new AbortController();
    this.runs.set(runId, controller);
    // 先开队列再跑 Agent：runAgent 的第一个步骤边界就可能取队列，晚开一步会丢掉最早的几条。
    this.queuedMessages.open(runId);
    // 开启本轮的写前记录。必须在 runAgent 之前 —— 第一条写操作发生时就要有地方放记录。
    session.checkpoints.begin(runId);
    if (sender && !sender.isDestroyed()) {
      this.runSenders.set(runId, sender.id);
    }

    const requestConfirm = async (req: {
      title: string;
      detail: string;
      kind: ConfirmRequest['kind'];
      options?: string[];
      allowInput?: boolean;
    }): Promise<boolean | string> => {
      if (controller.signal.aborted) return false;
      const liveMode = this.deps.settings.get().permissionMode;
      if (shouldAutoApproveConfirm(liveMode, req.kind)) {
        return true;
      }
      const id = randomUUID();
      const confirm: ConfirmRequest = { id, ...req };
      this.emit(runId, { type: 'confirm_request', request: confirm });
      return await new Promise<boolean | string>((resolve) => {
        if (controller.signal.aborted) {
          resolve(false);
          return;
        }
        this.confirms.set(id, { resolve, kind: req.kind, runId });
      });
    };

    const requestContinue = async (): Promise<boolean> => {
      return await new Promise<boolean>((resolve) => {
        this.continues.set(runId, { resolve });
      });
    };

    void (async () => {
      try {
        const workspaceForSkills = workspace.getKind() === 'local' ? workspaceRoot : null;
        const allSkills = await discoverSkills({
          workspaceRoot: workspaceForSkills,
          userSkillsDir: this.userSkillsDir(),
        });
        const selected = selectSkillsForPrompt(allSkills, payload.prompt, 3);
        const skillsText = formatSkillsForPrompt(selected);

        const rulesRes = await this.rulesService.getRules(workspaceRoot);
        let rulesText = rulesRes.content || undefined;

        try {
          const memoryContent = await workspace.readProjectConfigFile('memory.json');
          if (memoryContent && memoryContent.trim()) {
            const memoryPrompt = `\n\n【项目长期记忆与架构约定 (.echoly/memory.json)】\n${memoryContent.trim()}`;
            rulesText = rulesText ? `${rulesText}\n${memoryPrompt}` : memoryPrompt;
          }
        } catch {
          // 忽略记忆文件读取失败
        }

        const effectiveModelId = payload.modelId || settings.activeModelId;
        const selectedModel = settings.models?.find((m) => m.id === effectiveModelId);

        // MCP 首次使用时才启动子进程：一次纯本地重构任务不该顺带拉起用户配的三个外部服务。
        // 启动失败（命令写错、包没装）不阻断本轮 —— 用户仍能用一个没有 MCP 工具的 Agent 干活，
        // 界面上「设置 → MCP」会显示红点与 stderr，比直接让整个任务失败可诊断得多。
        if (this.deps.mcp) {
          await this.deps.mcp.ensureLoaded().catch(() => undefined);
        }
        const mcpManager = this.deps.mcp?.manager();
        const mcpTools = mcpManager?.listTools() ?? [];
        const mcpOption =
          mcpManager && mcpTools.length > 0
            ? {
                definitions: mcpManager.toToolDefinitions(),
                readonlyNames: mcpManager.readonlyToolNames(),
                meta: mcpManager.toolMeta(),
                call: (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
                  this.deps.mcp!.call(name, args, signal),
              }
            : undefined;

        await runAgent({
          prompt: payload.prompt,
          workspaceRoot,
          backend,
          settings,
          mode,
          modelProfile: selectedModel,
          planContext: payload.planContext,
          skillsText,
          rulesText,
          openFiles: payload.openFiles,
          selection: payload.selection,
          cursor: payload.cursor,
          history: payload.history,
          attachments: payload.attachments,
          applyImmediately: true,
          getPermissionMode: () => this.deps.settings.get().permissionMode,
          // 编辑后自检：诊断来自「渲染层上报的 Monaco markers + 主进程 LSP 推送」的合并缓存。
          // 代码库检索走 searchCached 而不是 search：这个工具在工具循环里调用，
          // 在这里同步等一次冷启动全量索引会让模型看起来「卡住不动」。
          // 索引缺失时它返回空并在后台补建，模型会拿到明确的降级提示去用别的工具。
          getDiagnostics: async (relPath) => session.diagnostics.list(relPath),
          codebaseSearch: async (query, limit) => {
            const hits = await session.codebase.searchCached(query, limit ?? 20);
            return hits.map((h) => ({
              path: h.filePath,
              name: h.name,
              kind: h.kind,
              line: h.line,
              endLine: h.endLine,
              content: h.content,
            }));
          },
          signal: controller.signal,
          requestConfirm,
          requestContinue,
          onFileMutation: (mutation) => session.checkpoints.record(runId, mutation),
          mcp: mcpOption,
          drainQueuedMessages: () => this.queuedMessages.drain(runId),
          onQueuedMessagesConsumed: (ids) => {
            for (const id of ids) this.emit(runId, { type: 'queued_message_consumed', id });
          },
          onEvent: (event) => {
            if (event.type === 'pending_diff') {
              diffs.add(event.diff);
            }
            // `done` 一到，渲染层就会把 runId 清空，之后同 runId 的事件再也找不到归属 Tab。
            // 所以未送达回执必须赶在它前面发出去。
            if (event.type === 'done') this.flushUndelivered(runId);
            this.emit(runId, event);
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const aborted =
          controller.signal.aborted ||
          (err instanceof Error && err.name === 'AbortError') ||
          /abort|cancelled/i.test(message);
        // 同上：error / done 都会让渲染层清掉 runId，回执必须先走
        this.flushUndelivered(runId);
        if (aborted) {
          this.emit(runId, { type: 'status', status: 'cancelled' });
          this.emit(runId, { type: 'done', finalText: '(cancelled)' });
        } else {
          this.emit(runId, { type: 'error', message });
          this.emit(runId, { type: 'status', status: 'error' });
        }
      } finally {
        this.continues.delete(runId);
        this.runs.delete(runId);
        this.flushUndelivered(runId);
        this.runSenders.delete(runId);
        try {
          workspace.notifyFsChange('agent');
        } catch {}
      }
    })();

    return { runId };
  }
}
