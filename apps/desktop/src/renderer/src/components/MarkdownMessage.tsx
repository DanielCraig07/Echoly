import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import React, { useState, useEffect, useRef, useMemo } from 'react';
import mermaid from 'mermaid';
import { parseContentWithCodeRefs, CodeRefPill } from './chat/CodeRefPill';
import Prism from 'prismjs';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-diff';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-graphql';
import 'prismjs/components/prism-ini';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-json5';
import 'prismjs/components/prism-kotlin';
import 'prismjs/components/prism-lua';
import 'prismjs/components/prism-makefile';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-markup-templating';
import 'prismjs/components/prism-php';
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-protobuf';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-scss';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-swift';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-yaml';

import katex from 'katex';
import 'katex/dist/katex.min.css';

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

/** Preprocess block math ($$...$$) into ```math code blocks */
function preprocessMath(text: string): string {
  return text.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
    return `\n\`\`\`math\n${math.trim()}\n\`\`\`\n`;
  });
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

function KatexBlock({ math }: { math: string }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(math.trim(), {
        displayMode: true,
        throwOnError: false,
      });
    } catch (err: any) {
      return `<span style="color:#ef4444">${err?.message || 'Formula error'}</span>`;
    }
  }, [math]);

  return <div className="md-katex-block" dangerouslySetInnerHTML={{ __html: html }} />;
}

function highlightCode(code: string, language: string): string {
  const lang = (language || '').toLowerCase().trim();
  const aliasMap: Record<string, string> = {
    js: 'javascript',
    ts: 'typescript',
    py: 'python',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    dockerfile: 'docker',
    docker: 'docker',
    golang: 'go',
    rs: 'rust',
    cs: 'csharp',
    'c++': 'cpp',
    'c#': 'csharp',
    rb: 'ruby',
    kt: 'kotlin',
    ps1: 'powershell',
    proto: 'protobuf',
    env: 'ini',
    make: 'makefile',
    dockerignore: 'ini',
    gitignore: 'ini',
  };
  const targetLang = aliasMap[lang] || lang;
  const grammar = Prism.languages[targetLang];
  if (grammar) {
    try {
      return Prism.highlight(code, grammar, targetLang);
    } catch {
      // fallback to escaped code
    }
  }
  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const highlightedHtml = useMemo(() => {
    return highlightCode(code, language);
  }, [code, language]);

  return (
    <div className="md-code-block">
      <div className="md-code-header">
        <span className="md-code-lang">{language || 'text'}</span>
        <button
          type="button"
          className="md-code-copy-btn"
          onClick={handleCopy}
          title="复制代码"
        >
          {copied ? '✓ 已复制' : '📋 复制'}
        </button>
      </div>
      <pre className="md-code-pre">
        <code
          className={`language-${language || 'none'}`}
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      </pre>
    </div>
  );
}

export interface MarkdownHeadingItem {
  id: string;
  level: number;
  text: string;
  line: number;
}

export function extractNodeText(node: any): string {
  if (!node) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractNodeText).join('');
  if (node.props?.children) return extractNodeText(node.props.children);
  return '';
}

export function slugifyHeading(text: string): string {
  const clean = text.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-').replace(/^-+|-+$/g, '');
  return `heading-${clean || 'section'}`;
}

export function extractMarkdownHeadings(content: string): MarkdownHeadingItem[] {
  if (!content) return [];
  const lines = content.split('\n');
  const headings: MarkdownHeadingItem[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const level = match[1].length;
      const cleanText = match[2]
        .replace(/[*_`~]/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .trim();
      if (cleanText) {
        const id = slugifyHeading(cleanText);
        headings.push({
          id,
          level,
          text: cleanText,
          line: i + 1,
        });
      }
    }
  }
  return headings;
}

/**
 * 将文本节点中的代码引用渲染为胶囊 Pill，普通文字原样输出。
 * 用于 AI 回复中自动识别文件路径引用（双向胶囊化）。
 */
function renderSegmentsWithPills(
  text: string,
  onOpenFile?: (path: string, line?: number, endLine?: number) => void,
): React.ReactNode[] {
  const segments = parseContentWithCodeRefs(text);
  // 如果没有任何引用，返回 null 让调用方走默认渲染
  if (!segments.some((s) => s.type === 'ref')) return [];
  return segments.map((seg, i) => {
    if (seg.type === 'ref' && seg.ref) {
      return <CodeRefPill key={i} codeRef={seg.ref} onOpenFile={onOpenFile} />;
    }
    return <React.Fragment key={i}>{seg.value}</React.Fragment>;
  });
}

const markdownComponents = {
  pre({ children }: any) {
    const codeElement = React.isValidElement(children)
      ? children
      : Array.isArray(children) && React.isValidElement(children[0])
        ? children[0]
        : null;

    if (codeElement) {
      const codeProps = codeElement.props as any;
      const className = codeProps?.className || '';
      const match = /language-(\w+)/.exec(className);
      const lang = match ? match[1].toLowerCase() : '';
      const rawCode =
        typeof codeProps?.children === 'string'
          ? codeProps.children
          : Array.isArray(codeProps?.children)
            ? codeProps.children.join('')
            : String(codeProps?.children || '');

      if (lang === 'mermaid') {
        return <MermaidBlock chart={rawCode.trim()} />;
      }

      if (['math', 'katex', 'latex'].includes(lang)) {
        return <KatexBlock math={rawCode.trim()} />;
      }

      return <CodeBlock language={lang} code={rawCode.replace(/\n$/, '')} />;
    }

    return <pre className="md-code-pre">{children}</pre>;
  },
  code({ node, className, children, ...props }: any) {
    return (
      <code className={`md-inline-code ${className || ''}`} {...props}>
        {children}
      </code>
    );
  },
  p({ children }: any) {
    // 将 p 内的文字节点自动解析为代码引用胶囊
    const processed = React.Children.map(children, (child) => {
      if (typeof child !== 'string') return child;
      const pills = renderSegmentsWithPills(child);
      return pills.length > 0 ? pills : child;
    });
    return <p>{processed}</p>;
  },
  li({ children }: any) {
    // li 内的文字节点同样解析
    const processed = React.Children.map(children, (child) => {
      if (typeof child !== 'string') return child;
      const pills = renderSegmentsWithPills(child);
      return pills.length > 0 ? pills : child;
    });
    return <li>{processed}</li>;
  },
  table({ children }: any) {
    return (
      <div className="md-table-wrapper">
        <table className="md-table">{children}</table>
      </div>
    );
  },
  h1({ node, children, ...props }: any) {
    const text = extractNodeText(children);
    const id = slugifyHeading(text);
    return <h1 id={id} data-heading-line={node?.position?.start?.line} {...props}>{children}</h1>;
  },
  h2({ node, children, ...props }: any) {
    const text = extractNodeText(children);
    const id = slugifyHeading(text);
    return <h2 id={id} data-heading-line={node?.position?.start?.line} {...props}>{children}</h2>;
  },
  h3({ node, children, ...props }: any) {
    const text = extractNodeText(children);
    const id = slugifyHeading(text);
    return <h3 id={id} data-heading-line={node?.position?.start?.line} {...props}>{children}</h3>;
  },
  h4({ node, children, ...props }: any) {
    const text = extractNodeText(children);
    const id = slugifyHeading(text);
    return <h4 id={id} data-heading-line={node?.position?.start?.line} {...props}>{children}</h4>;
  },
  h5({ node, children, ...props }: any) {
    const text = extractNodeText(children);
    const id = slugifyHeading(text);
    return <h5 id={id} data-heading-line={node?.position?.start?.line} {...props}>{children}</h5>;
  },
  h6({ node, children, ...props }: any) {
    const text = extractNodeText(children);
    const id = slugifyHeading(text);
    return <h6 id={id} data-heading-line={node?.position?.start?.line} {...props}>{children}</h6>;
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

export function MarkdownMessage({
  content,
  streaming,
  onOpenFile,
}: {
  content: string;
  streaming?: boolean;
  onOpenFile?: (path: string, line?: number, endLine?: number) => void;
}) {
  const [thinkExpanded, setThinkExpanded] = useState(false);

  const { thinkContent, mainContent } = parseThinkBlocks(content);
  const mathProcessed = preprocessMath(mainContent);
  const source = streaming ? stabilizeMarkdown(mathProcessed) : mathProcessed;

  // 动态构建带 onOpenFile 上下文的 components
  const components = useMemo(
    () => ({
      ...markdownComponents,
      p({ children }: any) {
        const processed = React.Children.map(children, (child) => {
          if (typeof child !== 'string') return child;
          const pills = renderSegmentsWithPills(child, onOpenFile);
          return pills.length > 0 ? pills : child;
        });
        return <p>{processed}</p>;
      },
      li({ children }: any) {
        const processed = React.Children.map(children, (child) => {
          if (typeof child !== 'string') return child;
          const pills = renderSegmentsWithPills(child, onOpenFile);
          return pills.length > 0 ? pills : child;
        });
        return <li>{processed}</li>;
      },
    }),
    [onOpenFile],
  );

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
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                {preprocessMath(thinkContent)}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
      {source && (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {source}
        </ReactMarkdown>
      )}
    </div>
  );
}
