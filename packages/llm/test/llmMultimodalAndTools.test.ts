import { describe, expect, it } from 'vitest';
import { AnthropicClient } from '../src/anthropic';
import { formatOpenAIMessages } from '../src/index';
import type { ChatMessage } from '@deepseek-ide/shared';

describe('Anthropic Streaming Tool Call Accumulation & Multimodal', () => {
  it('correctly accumulates streaming input_json_delta chunks into tool arguments', async () => {
    const sseChunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"usage":{"input_tokens":25,"output_tokens":1}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"glob_files","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"pattern\\": "}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"src/**/*.ts\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];

    const mockFetch = async () => {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of sseChunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };

    const client = new AnthropicClient({
      apiKey: 'test-key',
      fetchImpl: mockFetch as any,
    });

    const streamGen = client.chatStream({
      messages: [{ role: 'user', content: 'find all ts files' }],
    });

    let finalResult: any;
    while (true) {
      const nextStep = await streamGen.next();
      if (nextStep.done) {
        finalResult = nextStep.value;
        break;
      }
    }

    expect(finalResult).toBeDefined();
    const message = finalResult.message;
    expect(message.tool_calls).toBeDefined();
    expect(message.tool_calls?.length).toBe(1);

    const tc = message.tool_calls![0];
    expect(tc.function.name).toBe('glob_files');
    expect(tc.function.arguments).toBe('{"pattern": "src/**/*.ts"}');

    const parsed = JSON.parse(tc.function.arguments);
    expect(parsed.pattern).toBe('src/**/*.ts');
  });

  it('formats OpenAI messages with images and documents for multimodal gateways', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: 'Please examine this diagram and report',
        images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo...', mediaType: 'image/png' }],
        documents: [{ dataUrl: 'data:application/pdf;base64,JVBERi0xLj...', mediaType: 'application/pdf', name: 'report.pdf' }],
      },
    ];

    const formatted = formatOpenAIMessages(messages);
    expect(formatted.length).toBe(1);
    expect(Array.isArray(formatted[0].content)).toBe(true);

    const parts = formatted[0].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts[0]).toEqual({ type: 'text', text: 'Please examine this diagram and report' });
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo...' } });
    expect(parts[2]).toEqual({ type: 'image_url', image_url: { url: 'data:application/pdf;base64,JVBERi0xLj...' } });
  });

  it('converts Anthropic messages with native image and document blocks', async () => {
    let capturedBody: any;
    const mockFetch = async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Received image and PDF' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const client = new AnthropicClient({
      apiKey: 'test-key',
      fetchImpl: mockFetch as any,
    });

    await client.chat({
      messages: [
        {
          role: 'user',
          content: 'Analyze',
          images: [{ dataUrl: 'data:image/png;base64,AAABBB', mediaType: 'image/png' }],
          documents: [{ dataUrl: 'data:application/pdf;base64,CCCDDD', mediaType: 'application/pdf', name: 'test.pdf' }],
        },
      ],
    });

    expect(capturedBody).toBeDefined();
    const userContent = capturedBody.messages[0].content;
    expect(userContent).toContainEqual({ type: 'text', text: 'Analyze' });
    expect(userContent).toContainEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAABBB' },
    });
    expect(userContent).toContainEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'CCCDDD' },
    });
  });
});
