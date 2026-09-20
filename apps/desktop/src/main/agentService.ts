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
} from '@deepseek-ide/shared';
import { runAgent } from '@deepseek-ide/agent';
import { probeLlm } from '@deepseek-ide/llm';
import { discoverSkills, formatSkillsForPrompt, selectSkillsForPrompt } from '@deepseek-ide/skills';
import type { SettingsStore } from './settings';
import { appendRunTrace, type WindowGetter } from './diffStore';
import type { WindowRegistry } from './windowRegistry';
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

export class AgentService {
  private runs = new Map<string, AbortController>();
  private confirms = new Map<string, PendingConfirm>();
  private continues = new Map<string, PendingContinue>();
  /** runId → originating webContents.id so events go to the correct window */
  private runSenders = new Map<string, number>();
  private rulesService = new RulesService();

  constructor(
    private readonly deps: {
      settings: SettingsStore;
      registry: WindowRegistry;
      getWindow: WindowGetter;
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

  private emit(runId: string, event: AgentEvent): void {
    appendRunTrace(app.getPath('userData'), runId, JSON.stringify(event));
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
          model: s.model || 'deepseek-v4-flash',
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
      model: model || 'deepseek-v4-flash',
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
        const rulesText = rulesRes.content || undefined;

        const effectiveModelId = payload.modelId || settings.activeModelId;
        const selectedModel = settings.models?.find((m) => m.id === effectiveModelId);

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
          signal: controller.signal,
          requestConfirm,
          requestContinue,
          onEvent: (event) => {
            if (event.type === 'pending_diff') {
              diffs.add(event.diff);
            }
            this.emit(runId, event);
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const aborted =
          controller.signal.aborted ||
          (err instanceof Error && err.name === 'AbortError') ||
          /abort|cancelled/i.test(message);
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
        this.runSenders.delete(runId);
        try {
          workspace.notifyFsChange('agent');
        } catch {}
      }
    })();

    return { runId };
  }
}
