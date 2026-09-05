import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useState, useEffect, useRef } from 'react';
import mermaid from 'mermaid';

/** Split content into think blocks and main text. */
function parseThinkBlocks(text: string): { thinkContent: string; mainContent: string } {
  // Extract complete <think>...</think> blocks
  const thinkParts: string[] = [];
  const mainContent = text.replace(/<think>([\s\S]*?)<\/think>/g, (_, inner: string) => {
    thinkParts.push(inner.trim());
    return '';
  });

  // If streaming and we have an unclosed <think>, strip everything after it from main
  // and capture the partial think content
  const unclosed = mainContent.match(/<think>([\s\S]*)$/);
  if (unclosed) {
    return {
      thinkContent: (thinkParts.join('\n\n') + '\n\n' + unclosed[1].trim()).trim(),
      mainContent: mainContent.replace(/<think>[\s\S]*$/, '').trim(),
    };
  }

  return {
    thinkContent: thinkParts.join('\n\n').trim(),
    mainContent: mainContent.trim(),
  };
}

/** Close unclosed fences so streaming markdown still renders. */
function stabilizeMarkdown(text: string): string {
  let out = text;

  // Fix unclosed code fences
  const fences = out.match(/```/g);
  if (fences && fences.length % 2 === 1) {
    out = `${out}\n\`\`\``;
  }

  // Remove a trailing incomplete table separator line (e.g. "|---|---" at end of stream)
  out = out.replace(/\n\|[-| :]+\s*$/, '');

  return out;
}

let mermaidInitialized = false;
function initMermaid() {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'default' : 'dark',
    securityLevel: 'loose',
    fontFamily: 'inherit',
  });
  mermaidInitialized = true;
}

let mermaidCounter = 0;

function MermaidBlock({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartIdRef = useRef(`mermaid-${Date.now()}-${++mermaidCounter}`);

  useEffect(() => {
    let cancelled = false;
    const render = async () => {
      try {
        initMermaid();
        const cleanChart = chart.trim();
        if (!cleanChart) return;
        const res = await mermaid.render(chartIdRef.current, cleanChart);
        if (!cancelled) {
          setSvg(res.svg);
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Mermaid 渲染失败');
        }
      }
    };
    render();
    return () => {
      cancelled = true;
    };
  }, [chart]);

  if (error) {
    return (
      <div
        className="mermaid-error-container"
        style={{
          padding: '8px 12px',
          background: 'rgba(244, 67, 54, 0.1)',
          border: '1px solid rgba(244, 67, 54, 0.3)',
          borderRadius: 6,
          margin: '8px 0',
        }}
      >
        <div style={{ color: '#f44336', fontSize: 12, marginBottom: 4, fontWeight: 600 }}>
          Mermaid 图表解析错误
        </div>
        <pre style={{ margin: 0, fontSize: 11, color: 'var(--muted)' }}>
          <code>{chart}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div style={{ padding: '8px 0', color: 'var(--muted)', fontSize: 12 }}>
        正在渲染 Mermaid 图表...
      </div>
    );
  }

  return (
    <div
      className="mermaid-wrapper"
      ref={containerRef}
      style={{
        display: 'flex',
        justifyContent: 'center',
        margin: '12px 0',
        padding: '12px',
        background: 'var(--bg-elevated, rgba(255,255,255,0.03))',
        borderRadius: '8px',
        border: '1px solid var(--border)',
        overflowX: 'auto',
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

const markdownComponents = {
  code({ node, inline, className, children, ...props }: any) {
    const match = /language-(\w+)/.exec(className || '');
    const lang = match ? match[1].toLowerCase() : '';
    if (!inline && lang === 'mermaid') {
      return <MermaidBlock chart={String(children).replace(/\n$/, '')} />;
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  strong({ node, children, ...props }: any) {
    return (
      <strong style={{ fontWeight: 700 }} {...props}>
        {children}
      </strong>
    );
  },
  b({ node, children, ...props }: any) {
    return (
      <b style={{ fontWeight: 700 }} {...props}>
        {children}
      </b>
    );
  },
};

export function MarkdownMessage({ content, streaming }: { content: string; streaming?: boolean }) {
  const [thinkExpanded, setThinkExpanded] = useState(false);

  const { thinkContent, mainContent } = parseThinkBlocks(content);
  const source = streaming ? stabilizeMarkdown(mainContent) : mainContent;

  return (
    <div className={`md-body${streaming ? ' streaming' : ''}`}>
      {thinkContent && (
        <div className={`think-block${thinkExpanded ? ' expanded' : ''}`}>
          <button
            className="think-toggle"
            onClick={() => setThinkExpanded((v) => !v)}
            type="button"
          >
            <span className="think-icon reasoning-step-dot">●</span>
            <span>{streaming && !content.includes('</think>') ? '思考中…' : '思考过程'}</span>
            <span className="think-chevron">{thinkExpanded ? '▲' : '▼'}</span>
          </button>
          {thinkExpanded && (
            <div className="think-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {thinkContent}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
      {source && (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {source}
        </ReactMarkdown>
      )}
    </div>
  );
}
