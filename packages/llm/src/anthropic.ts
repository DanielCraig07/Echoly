import type {
  ChatMessage,
  StreamChunk,
  TokenUsage,
  ToolDefinition,
  ThinkingBlock,
} from '@deepseek-ide/shared';

export interface AnthropicClientOptions {
  baseUrl?: string;
  apiKey: string;
  model?: string;
  temperature?: number;
  enableThinking?: boolean;
  thinkingTokens?: number;
  fetchImpl?: typeof fetch;
}

export interface AnthropicChatParams {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  model?: string;
  signal?: AbortSignal;
}

export interface AnthropicChatResult {
  message: ChatMessage;
  usage?: TokenUsage;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string }
    | {
        type: 'tool_use';
        id: string;
        name: string;
        input: Record<string, unknown>;
      }
    | { type: 'tool_result'; tool_use_id: string; content: string }
  >;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

function convertToAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const content: AnthropicMessage['content'] = [];
      
      // Handle text content
      if (m.content) {
        content.push({ type: 'text', text: m.content });
      }

      // Handle image attachments
      if (m.images?.length) {
        for (const img of m.images) {
          const rawBase64 = img.dataUrl.includes('base64,')
            ? img.dataUrl.split('base64,')[1]
            : img.dataUrl;
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: (img.mediaType || 'image/png') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: rawBase64,
            },
          } as any);
        }
      }
      
      // Handle thinking blocks
      if (m.thinking?.length) {
        content.push(...m.thinking);
      }
      
      // Handle tool calls (from assistant)
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || '{}'),
          });
        }
      }
      
      // Handle tool results (from tool role)
      if (m.role === 'tool' && m.tool_call_id && m.content) {
        content.push({
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: m.content,
        });
      }
      
      return {
        role: m.role === 'user' ? 'user' : 'assistant',
        content,
      };
    });
}

function convertToAnthropicTools(tools?: ToolDefinition[]): AnthropicTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

function convertFromAnthropicMessage(response: any): ChatMessage {
  const message: ChatMessage = {
    role: 'assistant',
    content: '',
  };
  
  const thinking: ThinkingBlock[] = [];
  const textParts: string[] = [];
  const toolCalls: NonNullable<ChatMessage['tool_calls']> = [];
  
  for (const block of response.content || []) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'thinking') {
      thinking.push({ type: 'thinking', thinking: block.thinking });
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }
  
  message.content = textParts.join('\n') || null;
  if (thinking.length) message.thinking = thinking;
  if (toolCalls.length) message.tool_calls = toolCalls;
  
  return message;
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
}

function extractSystemPrompt(messages: ChatMessage[]): string {
  const systemMsg = messages.find((m) => m.role === 'system');
  return systemMsg?.content || '';
}

export class AnthropicClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly temperature: number;
  readonly enableThinking: boolean;
  readonly thinkingTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicClientOptions) {
    this.baseUrl = (options.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model || 'claude-sonnet-4-20250514';
    this.temperature = options.temperature ?? 0.2;
    this.enableThinking = options.enableThinking ?? true;
    this.thinkingTokens = options.thinkingTokens ?? 10000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chat(params: AnthropicChatParams): Promise<ChatMessage> {
    const system = extractSystemPrompt(params.messages);
    const messages = convertToAnthropicMessages(params.messages);
    const tools = convertToAnthropicTools(params.tools);

    const body: any = {
      model: params.model || this.model,
      messages,
      max_tokens: 8192,
      temperature: params.temperature ?? this.temperature,
    };

    if (system) body.system = system;
    if (tools) body.tools = tools;
    
    // Enable Extended Thinking
    if (this.enableThinking) {
      body.thinking = {
        type: 'enabled',
        budget_tokens: this.thinkingTokens,
      };
    }

    const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: buildHeaders(this.apiKey),
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    return convertFromAnthropicMessage(data);
  }

  async *chatStream(params: AnthropicChatParams): AsyncGenerator<any, AnthropicChatResult, void> {
    const system = extractSystemPrompt(params.messages);
    const messages = convertToAnthropicMessages(params.messages);
    const tools = convertToAnthropicTools(params.tools);

    const body: any = {
      model: params.model || this.model,
      messages,
      max_tokens: 8192,
      temperature: params.temperature ?? this.temperature,
      stream: true,
    };

    if (system) body.system = system;
    if (tools) body.tools = tools;
    
    if (this.enableThinking) {
      body.thinking = {
        type: 'enabled',
        budget_tokens: this.thinkingTokens,
      };
    }

    const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: buildHeaders(this.apiKey),
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic stream failed (${res.status}): ${text}`);
    }

    if (!res.body) {
      throw new Error('Anthropic stream has no body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    const thinking: ThinkingBlock[] = [];
    const textParts: string[] = [];
    const toolCalls: NonNullable<ChatMessage['tool_calls']> = [];
    let usage: TokenUsage | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        
        const payload = line.slice(5).trim();
        if (!payload) continue;

        let event: any;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }

        yield event; // Forward raw event for UI

        if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta.type === 'text_delta') {
            textParts.push(delta.text);
          } else if (delta.type === 'thinking_delta') {
            const lastThinking = thinking[thinking.length - 1];
            if (lastThinking) {
              lastThinking.thinking += delta.thinking;
            }
          } else if (delta.type === 'input_json_delta') {
            // Tool input streaming - accumulate
          }
        } else if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block.type === 'thinking') {
            thinking.push({ type: 'thinking', thinking: '' });
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: '' },
            });
          }
        } else if (event.type === 'message_delta' && event.usage) {
          usage = {
            promptTokens: event.usage.input_tokens,
            completionTokens: event.usage.output_tokens,
            totalTokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0),
          };
        }
      }
    }

    const message: ChatMessage = {
      role: 'assistant',
      content: textParts.join('') || null,
    };
    if (thinking.length) message.thinking = thinking;
    if (toolCalls.length) message.tool_calls = toolCalls;

    return { message, usage };
  }

  async chatStreamCollect(
    params: AnthropicChatParams,
    onToken?: (text: string) => void,
    onThinking?: (thinking: string) => void,
  ): Promise<AnthropicChatResult> {
    const gen = this.chatStream(params);
    let final: AnthropicChatResult | null = null;
    
    while (true) {
      const next = await gen.next();
      if (next.done) {
        final = next.value;
        break;
      }
      
      const event = next.value;
      if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          onToken?.(delta.text);
        } else if (delta.type === 'thinking_delta') {
          onThinking?.(delta.thinking);
        }
      }
    }
    
    if (!final) {
      throw new Error('stream ended without message');
    }
    return final;
  }
}
