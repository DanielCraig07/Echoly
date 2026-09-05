import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  AgentMode,
  AppSettings,
  ChatAttachment,
  ChatMessage,
  ModelProfile,
  PendingDiff,
  PlanContext,
  PlanProposal,
  PlanTodo,
  ProviderConfig,
} from '@deepseek-ide/shared';
import { syncPermissionBooleans } from '@deepseek-ide/shared';
import { UnifiedLlmClient, estimateTokensFromMessages } from '@deepseek-ide/llm';
import {
  executeTool,
  toolsForMode,
  type ToolContext,
  type WorkspaceBackend,
  LocalFsBackend,
} from '@deepseek-ide/tools';

export interface AgentRunOptions {
  prompt: string;
  workspaceRoot: string;
  settings: AppSettings;
  mode?: AgentMode;
  modelProfile?: ModelProfile;
  planContext?: PlanContext;
  skillsText?: string;
  backend?: WorkspaceBackend;
  openFiles?: Array<{ path: string; content: string }>;
  selection?: string;
  history?: ChatMessage[];
  attachments?: ChatAttachment[];
  applyImmediately?: boolean;
  /** 运行中实时读取权限，未提供则回退到 settings.permissionMode */
  getPermissionMode?: () => AppSettings['permissionMode'];
  onEvent: (event: AgentEvent) => void;
  requestConfirm: ToolContext['requestConfirm'];
  /** Resolves true to continue another maxAgentSteps chunk; false to stop. */
  requestContinue?: () => Promise<boolean>;
  signal?: AbortSignal;
}

const MAX_OPEN_FILE_CHARS = 12_000;
const MAX_LINES_PER_FILE = 200;

function sliceFileContent(content: string, budget: number): { text: string; truncated: boolean } {
  const lines = content.split('\n');
  const limited = lines.slice(0, MAX_LINES_PER_FILE).join('\n');
  if (limited.length <= budget) {
    return {
      text: limited,
      truncated: lines.length > MAX_LINES_PER_FILE || limited.length < content.length,
    };
  }
  return { text: limited.slice(0, budget), truncated: true };
}

function formatOpenFilesBlock(openFiles?: AgentRunOptions['openFiles']): string {
  if (!openFiles?.length) return 'Open files:\n(none)';

  const paths = openFiles
    .slice(0, 5)
    .map((f) => `- ${f.path} (${f.content.length} chars)`)
    .join('\n');

  let budget = MAX_OPEN_FILE_CHARS;
  const bodies: string[] = [];
  for (const f of openFiles.slice(0, 3)) {
    if (budget <= 0) break;
    const { text, truncated } = sliceFileContent(f.content, budget);
    budget -= text.length;
    bodies.push(
      `### ${f.path}${truncated ? ' (truncated)' : ''}\n\`\`\`\n${text}\n\`\`\``,
    );
  }

  return `Open files (paths):\n${paths}\n\nOpen file contents (active first; truncated):\n${bodies.join('\n\n') || '(none)'}`;
}

function buildSystemPrompt(options: {
  workspaceRoot: string;
  mode: AgentMode;
  openFiles?: AgentRunOptions['openFiles'];
  selection?: string;
  skillsText?: string;
  planContext?: PlanContext;
  backendKind?: string;
}): string {
  const { workspaceRoot, mode, openFiles, selection, skillsText, planContext, backendKind } =
    options;
  const selectionBlock = selection
    ? `\nCurrent selection:\n\`\`\`\n${selection.slice(0, 4000)}\n\`\`\`\n`
    : '';

  const sharedRules = `## Behavior
- Reply in the same language the user uses (default Chinese if unclear).
- Explore before editing: prefer search_code / glob_files / read_file / list_dir, then apply_patch or write_file.
- Keep tool arguments valid JSON. On tool failure, read the error and retry or change strategy.
- For destructive or ambiguous actions, use ask_user (or wait for confirmation flows).
- Be concise in final answers; cite paths when referring to code. During long work, give short progress notes.
- Do not invent file contents you have not read.`;

  const modeBlock =
    mode === 'ask'
      ? `You are in ASK mode — a read-only coding assistant in an IDE connected to an intranet Deepseek model.
Answer questions about the codebase. Use readonly tools only. Do NOT modify files or run write/mutating commands.
${sharedRules}`
      : mode === 'plan'
        ? `You are in PLAN mode — explore the codebase with readonly tools, then produce an actionable implementation plan.
Do NOT modify files or run mutating commands.
${sharedRules}
At the end of your final message you MUST include a fenced plan block exactly like:
\`\`\`plan
{"title":"...","summary":"...","todos":[{"id":"t1","content":"...","status":"pending"}]}
\`\`\`
Todos should be concrete, ordered steps.`
        : `You are a coding agent inside an IDE connected to an intranet Deepseek model.
You can explore and modify the workspace with tools.
Use apply_patch for surgical edits; write_file for new files or full rewrites.
${sharedRules}`;

  const planExecBlock =
    mode === 'agent' && planContext
      ? `\nYou are executing an approved plan. Follow todos in order; mark progress in your reasoning.
Plan title: ${planContext.title}
Summary: ${planContext.summary}
Todos:
${planContext.todos.map((t) => `- [${t.status}] ${t.id}: ${t.content}`).join('\n')}
`
      : '';

  const skillsBlock = skillsText ? `\n## Skills\n${skillsText}\n` : '';

  return `${modeBlock}
Workspace root: ${workspaceRoot} (${backendKind ?? 'local'})
${formatOpenFilesBlock(openFiles)}
${selectionBlock}${planExecBlock}${skillsBlock}`;
}

/**
 * Fallback: when the model does not support native tool_calls, parse
 * ```json tool blocks of shape {"name":"...","arguments":{...}}
 */
export function parseXmlToolCalls(content: string): Array<{ id: string; name: string; args: string }> {
  const results: Array<{ id: string; name: string; args: string }> = [];
  const re = /```json\s*tool\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    try {
      const obj = JSON.parse(m[1]) as { name: string; arguments?: unknown; args?: unknown };
      const args = obj.arguments ?? obj.args ?? {};
      results.push({
        id: `xml_${randomUUID()}`,
        name: obj.name,
        args: typeof args === 'string' ? args : JSON.stringify(args),
      });
    } catch {
      // ignore
    }
  }
  return results;
}

export function parsePlanProposal(content: string): PlanProposal | null {
  const re = /```plan\s*([\s\S]*?)```/i;
  const m = re.exec(content);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]) as {
      title?: string;
      summary?: string;
      todos?: Array<{ id?: string; content?: string; status?: string }>;
    };
    const todos: PlanTodo[] = (obj.todos ?? []).map((t, i) => ({
      id: t.id || `t${i + 1}`,
      content: t.content || '',
      status:
        t.status === 'completed' ||
        t.status === 'in_progress' ||
        t.status === 'cancelled' ||
        t.status === 'pending'
          ? t.status
          : 'pending',
    }));
    return {
      title: obj.title || 'Implementation plan',
      summary: obj.summary || content.replace(re, '').trim().slice(0, 2000),
      todos,
    };
  } catch {
    return null;
  }
}

export async function runAgent(options: AgentRunOptions): Promise<{ finalText: string; diffs: PendingDiff[] }> {
  const {
    prompt,
    workspaceRoot,
    settings,
    mode = 'agent',
    planContext,
    skillsText,
    openFiles,
    selection,
    history = [],
    attachments,
    onEvent,
    requestConfirm,
    requestContinue,
    signal,
  } = options;

  const backend = options.backend ?? new LocalFsBackend(workspaceRoot);
  
  // Get current model/provider config
  let providerConfig: ProviderConfig;
  if (options.modelProfile) {
    providerConfig = {
      provider: options.modelProfile.provider,
      baseUrl: options.modelProfile.baseUrl,
      apiKey: options.modelProfile.apiKey,
      model: options.modelProfile.model,
      enableThinking: options.modelProfile.enableThinking,
      thinkingTokens: options.modelProfile.thinkingTokens,
    };
  } else {
    const activeModel = settings.models?.find((m) => m.id === settings.activeModelId);
    if (activeModel) {
      providerConfig = {
        provider: activeModel.provider,
        baseUrl: activeModel.baseUrl,
        apiKey: activeModel.apiKey,
        model: activeModel.model,
        enableThinking: activeModel.enableThinking,
        thinkingTokens: activeModel.thinkingTokens,
      };
    } else {
      const currentProvider = settings.currentProvider || 'deepseek';
      providerConfig = settings.providers?.[currentProvider] || {
        provider: currentProvider,
        baseUrl: settings.baseUrl || 'http://192.168.10.241:8002',
        apiKey: settings.apiKey || '',
        model: settings.model || 'deepseek-v4-flash',
      };
    }
  }
  
  const client = new UnifiedLlmClient(providerConfig);

  const getPermissionMode = (): AppSettings['permissionMode'] =>
    options.getPermissionMode?.() ?? settings.permissionMode ?? 'ask';
  const initialPermissionMode = getPermissionMode();
  const permissionBooleans = syncPermissionBooleans(initialPermissionMode);
  const windowTokens = settings.contextWindowTokens || 128000;

  const diffs: PendingDiff[] = [];
  const enqueueDiff: ToolContext['enqueueDiff'] = (diff) => {
    const pending: PendingDiff = {
      id: diff.id ?? randomUUID(),
      path: diff.path,
      original: diff.original,
      modified: diff.modified,
      description: diff.description,
    };
    diffs.push(pending);
    onEvent({ type: 'pending_diff', diff: pending });
    return pending;
  };

  const toolCtx: ToolContext = {
    workspaceRoot,
    backend,
    permissionMode: initialPermissionMode,
    getPermissionMode,
    autoApproveReadonlyTerminal: permissionBooleans.autoApproveReadonlyTerminal,
    requireConfirmForWrites: permissionBooleans.requireConfirmForWrites,
    requestConfirm: async (req) => {
      const mode = getPermissionMode();
      if (mode === 'allow_all_extreme') return true;
      // 允许所有：写/终端/删除自动放行；ask_user(other) 仍询问
      if (mode === 'allow_all' && req.kind !== 'other') return true;
      onEvent({ type: 'status', status: 'awaiting_confirm' });
      const ok = await requestConfirm(req);
      onEvent({ type: 'status', status: 'tool_running' });
      return ok;
    },
    enqueueDiff,
    applyImmediately: options.applyImmediately ?? false,
    getApplyImmediately: () => {
      if (options.applyImmediately) return true;
      const mode = getPermissionMode();
      return mode === 'allow_all' || mode === 'allow_all_extreme';
    },
  };

  const tools = toolsForMode(mode);

  let userPrompt = prompt;
  const images: Array<{ dataUrl: string; mediaType: string }> = [];

  if (attachments && attachments.length > 0) {
    const fileBlocks: string[] = [];
    for (const att of attachments) {
      if (att.type === 'file' && att.content) {
        fileBlocks.push(`\n\n--- 附件文件: ${att.name} ---\n\`\`\`\n${att.content}\n\`\`\``);
      } else if (att.type === 'image') {
        fileBlocks.push(`\n\n--- 附件图片: ${att.name} ---`);
        if (att.dataUrl) {
          const match = att.dataUrl.match(/^data:([^;]+);base64,/);
          const mediaType = match ? match[1] : (att.mimeType || 'image/png');
          images.push({ dataUrl: att.dataUrl, mediaType });
        }
      }
    }
    if (fileBlocks.length > 0) {
      userPrompt = `${prompt}${fileBlocks.join('')}`;
    }
  }

  const userMessage: ChatMessage = {
    role: 'user',
    content: userPrompt,
    images: images.length > 0 ? images : undefined,
  };

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        workspaceRoot,
        mode,
        openFiles,
        selection,
        skillsText,
        planContext,
        backendKind: backend.kind,
      }),
    },
    ...history,
    userMessage,
  ];

  let finalText = '';
  const chunkSize = settings.maxAgentSteps ?? 50;
  let step = 0;
  let limit = chunkSize;

  const emitContextUsage = (usedTokens: number, source: 'api' | 'estimate') => {
    onEvent({
      type: 'context_usage',
      usedTokens,
      windowTokens,
      source,
    });
  };

  try {
    while (true) {
      while (step < limit) {
        if (signal?.aborted) {
          onEvent({ type: 'status', status: 'cancelled' });
          throw new Error('cancelled');
        }

        onEvent({ type: 'step_progress', step: step + 1, maxSteps: limit });
        onEvent({ type: 'status', status: 'thinking' });
        emitContextUsage(estimateTokensFromMessages(messages), 'estimate');

        let assistant: ChatMessage;
        try {
          const result = await client.chatStreamCollect(
            {
              messages,
              tools,
              signal,
            },
            (token) => onEvent({ type: 'token', text: token }),
          );
          assistant = result.message;
          if (result.usage?.totalTokens != null) {
            emitContextUsage(result.usage.totalTokens, 'api');
          } else if (result.usage?.promptTokens != null) {
            emitContextUsage(
              result.usage.promptTokens + (result.usage.completionTokens ?? 0),
              'api',
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (
            signal?.aborted ||
            (err instanceof Error && err.name === 'AbortError') ||
            /aborted|abort|cancelled/i.test(msg)
          ) {
            throw new Error('cancelled');
          }
          if (/tools|tool_choice|400/.test(msg)) {
            const result = await client.chatStreamCollect(
              { messages, signal },
              (token) => onEvent({ type: 'token', text: token }),
            );
            assistant = result.message;
            if (result.usage?.totalTokens != null) {
              emitContextUsage(result.usage.totalTokens, 'api');
            }
          } else {
            throw err;
          }
        }

        messages.push(assistant);
        step += 1;

        let toolCalls =
          assistant.tool_calls?.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            args: tc.function.arguments,
          })) ?? [];

        if (!toolCalls.length && assistant.content) {
          toolCalls = parseXmlToolCalls(assistant.content);
        }

        if (!toolCalls.length) {
          // Normalize once so the intermediate `assistant_message` bubble and the
          // `done` event carry identical text — otherwise the renderer can't match
          // them up and ends up rendering the final answer twice.
          finalText = (assistant.content ?? '')
            .split('\n')
            .filter((line) => !/^-{3,}\s*$/.test(line.trim()))
            .join('\n')
            .trim();
          onEvent({ type: 'assistant_message', content: finalText });
          if (mode === 'plan') {
            const plan =
              parsePlanProposal(finalText) ??
              ({
                title: 'Implementation plan',
                summary: finalText.slice(0, 4000),
                todos: [],
              } satisfies PlanProposal);
            onEvent({ type: 'plan_proposal', plan });
          }
          onEvent({ type: 'status', status: 'done' });
          onEvent({ type: 'done', finalText });
          return { finalText, diffs };
        }

        // Persist intermediate reasoning before tools so UI does not lose streaming text.
        // Strip bare --- separator lines which the model uses in reasoning but render as <hr> in Markdown.
        if (assistant.content?.trim()) {
          const displayContent = assistant.content
            .split('\n')
            .filter((line) => !/^-{3,}\s*$/.test(line.trim()))
            .join('\n')
            .trim();
          if (displayContent) {
            onEvent({ type: 'assistant_message', content: displayContent });
          }
        }

        for (const call of toolCalls) {
          if (signal?.aborted) throw new Error('cancelled');
          if (mode !== 'agent') {
            const allowed = new Set(tools.map((t) => t.function.name));
            if (!allowed.has(call.name)) {
              onEvent({
                type: 'tool_result',
                id: call.id,
                name: call.name,
                result: `Tool ${call.name} is not available in ${mode} mode`,
                isError: true,
              });
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: `Tool ${call.name} is not available in ${mode} mode`,
              });
              continue;
            }
          }
          let parsedArgs: unknown = call.args;
          try {
            parsedArgs = JSON.parse(call.args || '{}');
          } catch {
            parsedArgs = call.args;
          }
          onEvent({ type: 'status', status: 'tool_running' });
          onEvent({ type: 'tool_start', id: call.id, name: call.name, args: parsedArgs });
          const result = await executeTool(call.name, call.args, {
            ...toolCtx,
            onTerminalOutput: (chunk) => {
              onEvent({ type: 'tool_output', id: call.id, chunk });
            },
          });
          // Limit tool result length to prevent context overflow
          const MAX_TOOL_RESULT_LENGTH = 8000;
          let toolResultContent = result.content;
          if (toolResultContent.length > MAX_TOOL_RESULT_LENGTH) {
            toolResultContent = toolResultContent.slice(0, MAX_TOOL_RESULT_LENGTH) + `\n\n[输出已截断，原长度: ${toolResultContent.length} 字符]`;
          }
          
          onEvent({
            type: 'tool_result',
            id: call.id,
            name: call.name,
            result: toolResultContent,
            isError: result.isError,
          });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: toolResultContent,
          });
        }
      }

      onEvent({
        type: 'max_steps_reached',
        completedSteps: step,
        chunkSize,
      });
      onEvent({ type: 'status', status: 'awaiting_continue' });

      const shouldContinue = requestContinue ? await requestContinue() : false;
      if (!shouldContinue || signal?.aborted) {
        finalText = 'Reached max agent steps without a final answer.';
        onEvent({ type: 'error', message: finalText });
        onEvent({ type: 'status', status: 'error' });
        return { finalText, diffs };
      }

      limit += chunkSize;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const aborted =
      signal?.aborted ||
      (err instanceof Error && err.name === 'AbortError') ||
      message === 'cancelled' ||
      /aborted|abort/i.test(message);
    if (aborted) {
      onEvent({ type: 'status', status: 'cancelled' });
      onEvent({ type: 'done', finalText: '(cancelled)' });
      return { finalText: '(cancelled)', diffs };
    }
    onEvent({ type: 'error', message });
    onEvent({ type: 'status', status: 'error' });
    throw err;
  }
}
