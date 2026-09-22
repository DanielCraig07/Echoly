import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import React, { useState, useEffect, useRef, useMemo } from 'react';
import mermaid from 'mermaid';
import {
  parseAiContentCodeRefs,
  parseAnyCodeRef,
  isCodeFile,
  CodeRefPill,
  ParsedCodeRef,
} from './chat/CodeRefPill';
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

function CodeBlock({
  language,
  code,
  fileRef,
  onOpenFile,
}: {
  language: string;
  code: string;
  fileRef?: ParsedCodeRef | null;
  onOpenFile?: (path: string, line?: number, endLine?: number) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [ranInTerm, setRanInTerm] = useState(false);
  const [inserted, setInserted] = useState(false);
  const [applied, setApplied] = useState(false);

  const cleanLang = (language || '').toLowerCase().trim();
  const isShellCommand = useMemo(() => {
    return ['bash', 'sh', 'shell', 'zsh', 'terminal', 'powershell', 'cmd', 'ps1'].includes(cleanLang);
  }, [cleanLang]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleRunInTerminal = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('echoly:runInTerminal', { detail: { command: code } }));
    setRanInTerm(true);
    setTimeout(() => setRanInTerm(false), 1800);
  };

  const handleInsertToEditor = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('echoly:insertCodeToEditor', { detail: { code } }));
    setInserted(true);
    setTimeout(() => setInserted(false), 1800);
  };

  const handleApplyToFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.dispatchEvent(
      new CustomEvent('echoly:applyCodeToFile', {
        detail: { code, path: fileRef?.path },
      })
    );
    setApplied(true);
    setTimeout(() => setApplied(false), 1800);
  };

  const highlightedHtml = useMemo(() => {
    return highlightCode(code, language);
  }, [code, language]);

  const hasActive = copied || ranInTerm || inserted || applied;

  return (
    <div className="md-code-block">
      <div className="md-code-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden' }}>
          <span className="md-code-lang">{language || 'text'}</span>
          {fileRef && <CodeRefPill codeRef={fileRef} onOpenFile={onOpenFile} />}
        </div>
        <div className={`md-code-actions ${hasActive ? 'has-active' : ''}`}>
          {isShellCommand && (
            <button
              type="button"
              className={`md-code-action-btn ${ranInTerm ? 'active' : ''}`}
              onClick={handleRunInTerminal}
              title={ranInTerm ? '已发送至终端执行' : '在集成终端中运行此命令'}
            >
              {ranInTerm ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>已运行</span>
                </>
              ) : (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4 17 10 11 4 5" />
                    <line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                  <span>运行</span>
                </>
              )}
            </button>
          )}

          {!isShellCommand && (
            <button
              type="button"
              className={`md-code-action-btn ${inserted ? 'active' : ''}`}
              onClick={handleInsertToEditor}
              title={inserted ? '已插入到当前光标处' : '插入到当前编辑器光标处'}
            >
              {inserted ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>已插入</span>
                </>
              ) : (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  <span>插入</span>
                </>
              )}
            </button>
          )}

          {fileRef && (
            <button
              type="button"
              className={`md-code-action-btn ${applied ? 'active' : ''}`}
              onClick={handleApplyToFile}
              title={applied ? '已完整应用到文件' : `应用并更新到 ${fileRef.path}`}
            >
              {applied ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>已应用</span>
                </>
              ) : (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="12" y1="18" x2="12" y2="12" />
                    <line x1="9" y1="15" x2="15" y2="15" />
                  </svg>
                  <span>应用</span>
                </>
              )}
            </button>
          )}

          <button
            type="button"
            className={`md-code-copy-btn ${copied ? 'copied' : ''}`}
            onClick={handleCopy}
            title={copied ? '已复制代码' : '复制代码'}
          >
            {copied ? (
              <>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>已复制</span>
              </>
            ) : (
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
        </div>
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
  const segments = parseAiContentCodeRefs(text);
  // 如果没有任何引用，返回 null 让调用方走默认渲染
  if (!segments.some((s) => s.type === 'ref')) return [];
  return segments.map((seg, i) => {
    if (seg.type === 'ref' && seg.ref) {
      return <CodeRefPill key={i} codeRef={seg.ref} onOpenFile={onOpenFile} />;
    }
    return <React.Fragment key={i}>{seg.value}</React.Fragment>;
  });
}

export function createMarkdownComponents(
  onOpenFile?: (path: string, line?: number, endLine?: number) => void,
) {
  const processTextChildren = (children: any) => {
    return React.Children.map(children, (child) => {
      if (typeof child !== 'string') return child;
      const pills = renderSegmentsWithPills(child, onOpenFile);
      return pills.length > 0 ? pills : child;
    });
  };

  return {
    pre({ children }: any) {
      const codeElement = React.isValidElement(children)
        ? children
        : Array.isArray(children) && React.isValidElement(children[0])
          ? children[0]
          : null;

      if (codeElement) {
        const codeProps = codeElement.props as any;
        const className = codeProps?.className || '';
        const match = /language-(\S+)/.exec(className);
        const rawMeta = match ? match[1] : '';
        let lang = rawMeta;
        let headerFileRef: ParsedCodeRef | null = null;
        if (rawMeta.includes(':')) {
          const colonIdx = rawMeta.indexOf(':');
          lang = rawMeta.slice(0, colonIdx);
          const rest = rawMeta.slice(colonIdx + 1);
          headerFileRef = parseAnyCodeRef(rest);
        }

        const rawCode =
          typeof codeProps?.children === 'string'
            ? codeProps.children
            : Array.isArray(codeProps?.children)
              ? codeProps.children.join('')
              : String(codeProps?.children || '');

        if (lang.toLowerCase() === 'mermaid') {
          return <MermaidBlock chart={rawCode.trim()} />;
        }

        if (['math', 'katex', 'latex'].includes(lang.toLowerCase())) {
          return <KatexBlock math={rawCode.trim()} />;
        }

        // 若语言头中未携带路径，检测第一行注释是否为 // File: path:line
        if (!headerFileRef) {
          const firstLine = rawCode.split('\n')[0]?.trim() || '';
          const commentMatch = /^(?:\/\/|#|--|\/\*)\s*(?:File|Path)?\s*[:：]?\s*([^\s*]+)(?:\*\/)?$/i.exec(firstLine);
          if (commentMatch) {
            const candidate = commentMatch[1];
            const parsed = parseAnyCodeRef(candidate);
            if (parsed && isCodeFile(parsed.fileName)) {
              headerFileRef = parsed;
            }
          }
        }

        return (
          <CodeBlock
            language={lang}
            code={rawCode.replace(/\n$/, '')}
            fileRef={headerFileRef}
            onOpenFile={onOpenFile}
          />
        );
      }

      return <pre className="md-code-pre">{children}</pre>;
    },
    code({ node, className, children, ...props }: any) {
      const isInline = !className?.includes('language-');
      if (isInline) {
        const text = typeof children === 'string' ? children : extractNodeText(children);
        if (typeof text === 'string' && !text.includes('\n')) {
          const ref = parseAnyCodeRef(text);
          if (ref && isCodeFile(ref.fileName)) {
            return <CodeRefPill codeRef={ref} onOpenFile={onOpenFile} />;
          }
        }
      }
      return (
        <code className={`md-inline-code ${className || ''}`} {...props}>
          {children}
        </code>
      );
    },
    a({ href, children, ...props }: any) {
      const hrefRef = href ? parseAnyCodeRef(href) : null;
      const text = extractNodeText(children);
      const textRef = text ? parseAnyCodeRef(text) : null;

      const targetRef = hrefRef || textRef;
      if (targetRef && isCodeFile(targetRef.fileName)) {
        if (hrefRef && textRef) {
          if (textRef.startLine !== undefined && hrefRef.startLine === undefined) {
            targetRef.startLine = textRef.startLine;
            targetRef.endLine = textRef.endLine;
            targetRef.lineLabel = textRef.lineLabel;
          }
        }
        return <CodeRefPill codeRef={targetRef} onOpenFile={onOpenFile} />;
      }

      const isExternal = href?.startsWith('http://') || href?.startsWith('https://');
      return (
        <a
          href={href}
          target={isExternal ? '_blank' : undefined}
          rel={isExternal ? 'noopener noreferrer' : undefined}
          onClick={(e) => {
            if (href?.startsWith('file://')) {
              e.preventDefault();
              const ref = parseAnyCodeRef(href);
              if (ref) {
                if (onOpenFile) {
                  onOpenFile(ref.path, ref.startLine, ref.endLine);
                } else {
                  window.dispatchEvent(
                    new CustomEvent('echoly:openFile', {
                      detail: { path: ref.path, line: ref.startLine, endLine: ref.endLine },
                    }),
                  );
                }
              }
            }
          }}
          {...props}
        >
          {children}
        </a>
      );
    },
    p({ children }: any) {
      return <p>{processTextChildren(children)}</p>;
    },
    li({ children }: any) {
      return <li>{processTextChildren(children)}</li>;
    },
    blockquote({ children }: any) {
      return <blockquote>{processTextChildren(children)}</blockquote>;
    },
    td({ children }: any) {
      return <td>{processTextChildren(children)}</td>;
    },
    th({ children }: any) {
      return <th>{processTextChildren(children)}</th>;
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
      return <h1 id={id} data-heading-line={node?.position?.start?.line} {...props}>{processTextChildren(children)}</h1>;
    },
    h2({ node, children, ...props }: any) {
      const text = extractNodeText(children);
      const id = slugifyHeading(text);
      return <h2 id={id} data-heading-line={node?.position?.start?.line} {...props}>{processTextChildren(children)}</h2>;
    },
    h3({ node, children, ...props }: any) {
      const text = extractNodeText(children);
      const id = slugifyHeading(text);
      return <h3 id={id} data-heading-line={node?.position?.start?.line} {...props}>{processTextChildren(children)}</h3>;
    },
    h4({ node, children, ...props }: any) {
      const text = extractNodeText(children);
      const id = slugifyHeading(text);
      return <h4 id={id} data-heading-line={node?.position?.start?.line} {...props}>{processTextChildren(children)}</h4>;
    },
    h5({ node, children, ...props }: any) {
      const text = extractNodeText(children);
      const id = slugifyHeading(text);
      return <h5 id={id} data-heading-line={node?.position?.start?.line} {...props}>{processTextChildren(children)}</h5>;
    },
    h6({ node, children, ...props }: any) {
      const text = extractNodeText(children);
      const id = slugifyHeading(text);
      return <h6 id={id} data-heading-line={node?.position?.start?.line} {...props}>{processTextChildren(children)}</h6>;
    },
    strong({ node, children, ...props }: any) {
      return (
        <strong style={{ fontWeight: 700 }} {...props}>
          {processTextChildren(children)}
        </strong>
      );
    },
    b({ node, children, ...props }: any) {
      return (
        <b style={{ fontWeight: 700 }} {...props}>
          {processTextChildren(children)}
        </b>
      );
    },
    em({ node, children, ...props }: any) {
      return (
        <em {...props}>
          {processTextChildren(children)}
        </em>
      );
    },
  };
}

export const markdownComponents = createMarkdownComponents();

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
    () => createMarkdownComponents(onOpenFile),
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
