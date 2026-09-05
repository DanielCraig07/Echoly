/**
 * Claude Chat Panel
 * 使用类似 ChatPanel 的布局，但底层使用 Claude API
 */

import { useState, useRef, useEffect } from 'react';

interface ClaudeChatPanelProps {
  viewId?: string;
  workspace?: string | null;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface AgentEvent {
  type: string;
  content?: string;
  [key: string]: any;
}

export function ClaudeChatPanel({
  viewId = 'claudeVSCodeSidebar',
  workspace,
}: ClaudeChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string>('claude-session-' + Date.now());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const currentAssistantMessageRef = useRef<string>('');

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 监听 Agent 事件
  useEffect(() => {
    console.log('[ClaudeChatPanel] Setting up agent event listener');

    const cleanup = window.ide.onAgentEvent((event: AgentEvent) => {
      console.log('[ClaudeChatPanel] Agent event received:', event.type, event);

      if (event.type === 'text') {
        // 流式文本输出
        currentAssistantMessageRef.current += event.content || '';

        // 更新最后一条助手消息
        setMessages((prev) => {
          const lastMsg = prev[prev.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            return [
              ...prev.slice(0, -1),
              { ...lastMsg, content: currentAssistantMessageRef.current },
            ];
          } else {
            return [
              ...prev,
              {
                id: Date.now().toString(),
                role: 'assistant',
                content: currentAssistantMessageRef.current,
                timestamp: Date.now(),
              },
            ];
          }
        });
      } else if (event.type === 'done') {
        console.log('[ClaudeChatPanel] Agent done');
        setLoading(false);
      } else if (event.type === 'error') {
        console.error('[ClaudeChatPanel] Agent error:', event);
        setLoading(false);
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            role: 'assistant',
            content: `错误: ${event.error || '未知错误'}`,
            timestamp: Date.now(),
          },
        ]);
      }
    });

    return cleanup;
  }, []);

  const handleSend = async () => {
    if (!input.trim() || loading) return;

    console.log('[ClaudeChatPanel] handleSend called, input:', input);

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      timestamp: Date.now(),
    };

    const userInput = input;
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setLoading(true);
    currentAssistantMessageRef.current = '';

    try {
      console.log('[ClaudeChatPanel] Starting agent...');

      // 启动 Agent，返回 runId
      const result = await window.ide.startAgent({
        prompt: userInput,
        sessionId,
        mode: 'agent',
        openFiles: [],
      });

      console.log('[ClaudeChatPanel] Agent started, runId:', result.runId);

      // 等待一小段时间，让事件监听器有时间接收初始事件
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (err: any) {
      console.error('[ClaudeChatPanel] Error:', err);
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: 'assistant',
          content: `错误: ${err.message || '发送消息失败'}`,
          timestamp: Date.now(),
        },
      ]);
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="claude-chat-panel">
      {/* 消息列表 */}
      <div className="claude-chat-messages">
        {messages.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon">💬</div>
            <div className="empty-text">开始与 Claude 对话</div>
            <div className="empty-hint">输入消息开始对话，Claude 将帮助你完成编程任务</div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`message message-${msg.role}`}>
            <div className="message-avatar">{msg.role === 'user' ? '👤' : '🤖'}</div>
            <div className="message-content">
              <div className="message-text">{msg.content}</div>
              <div className="message-time">{new Date(msg.timestamp).toLocaleTimeString()}</div>
            </div>
          </div>
        ))}

        {loading && (
          <div className="message message-assistant">
            <div className="message-avatar">🤖</div>
            <div className="message-content">
              <div className="loading-indicator">
                <span className="dot"></span>
                <span className="dot"></span>
                <span className="dot"></span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 输入框 */}
      <div className="claude-chat-input-container">
        <textarea
          className="claude-chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息... (Enter 发送，Shift+Enter 换行)"
          rows={3}
          disabled={loading}
        />
        <button
          className="claude-chat-send-btn"
          onClick={handleSend}
          disabled={!input.trim() || loading}
        >
          发送
        </button>
      </div>
    </div>
  );
}
