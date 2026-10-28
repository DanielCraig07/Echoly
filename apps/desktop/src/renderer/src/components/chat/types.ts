import type {
  AgentMode,
  AgentRunStatus,
  BrowserElementRef,
  BrowserPageRef,
  ChatAttachment,
  ChatMessageMetrics,
  ChatSessionMessage,
  ConfirmRequest,
  PlanProposal,
} from '@deepseek-ide/shared';

export interface MentionItem {
  id: string;
  type: 'special' | 'file' | 'command';
  title: string;
  desc: string;
  path?: string;
  insertText: string;
  /** 命令项专用：展开后的正文。选中时替换掉 `/name` 而不是插入名字。 */
  commandBody?: string;
  /** 命令项的来源标记（工作区 / 用户）。 */
  badge?: string;
}

export interface SessionTab {
  id: string;
  title: string;
  customTitle?: boolean;
  messages: ChatSessionMessage[];
  attachments?: ChatAttachment[];
  mode: AgentMode;
  modelId?: string;
  input: string;
  status: AgentRunStatus;
  runId: string | null;
  streaming: string;
  streamingMsgId?: string;
  thinkingStreaming?: string;
  confirm: ConfirmRequest | null;
  plan: PlanProposal | null;
  pendingPlanContext: PlanProposal | null;
  stepInfo: { step: number; maxSteps: number } | null;
  awaitingContinue: boolean;
  continueInfo: { completedSteps: number; chunkSize: number } | null;
  contextUsage: { usedTokens: number; windowTokens: number; source: 'api' | 'estimate' } | null;
  updatedAt: number;
}

