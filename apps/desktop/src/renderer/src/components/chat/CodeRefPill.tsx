import React from 'react';

export interface ParsedCodeRef {
  raw: string;
  path: string;
  fileName: string;
  startLine?: number;
  endLine?: number;
  lineLabel?: string;
}

/**
 * 解析文本中的代码引用标记，支持如下形式：
 * 1. @[/path/to/File.tsx:L393-L403] 或 @[/path/to/File.tsx:L393]
 * 2. @/path/to/File.tsx:L393-L403 或 @File.tsx:L393-403
 * 3. @File.tsx#L393-403
 * 4. @File.tsx
 */
export function parseContentWithCodeRefs(
  text: string,
): Array<{ type: 'text' | 'ref'; value: string; ref?: ParsedCodeRef }> {
  if (!text) return [];

  // 正则匹配：
  // 模式1: @\[([^\]]+?)(?::L?(\d+)(?:\s*[-–—~]\s*L?(\d+))?)?\]
  // 模式2: @([^\s,;，。！？\(\)\[\]:#]+?\.[a-zA-Z0-9_]+)(?:[:#]L?(\d+)(?:\s*[-–—~]\s*L?(\d+))?)?
  const pattern =
    /(?:@\[([^\]]+?)(?::L?(\d+)(?:\s*[-–—~]\s*L?(\d+))?)?\])|(?:@([^\s,;，。！？\(\)\[\]:#]+?\.[a-zA-Z0-9_]+)(?:[:#]L?(\d+)(?:\s*[-–—~]\s*L?(\d+))?)?)/g;

  const result: Array<{ type: 'text' | 'ref'; value: string; ref?: ParsedCodeRef }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const end = pattern.lastIndex;

    if (start > lastIndex) {
      result.push({
        type: 'text',
        value: text.slice(lastIndex, start),
      });
    }

    const raw = match[0];
    let rawPath = '';
    let startLineStr: string | undefined;
    let endLineStr: string | undefined;

    if (match[1] !== undefined) {
      // 模式1: @[path:Lstart-Lend]
      rawPath = match[1].trim();
      startLineStr = match[2];
      endLineStr = match[3];
    } else {
      // 模式2: @path:Lstart-Lend
      rawPath = match[4].trim();
      startLineStr = match[5];
      endLineStr = match[6];
    }

    const fileName = rawPath.replace(/\\/g, '/').split('/').pop() || rawPath;
    const startLine = startLineStr ? parseInt(startLineStr, 10) : undefined;
    const endLine = endLineStr ? parseInt(endLineStr, 10) : undefined;

    let lineLabel: string | undefined;
    if (startLine !== undefined) {
      lineLabel = endLine !== undefined && endLine !== startLine
        ? `#L${startLine}-${endLine}`
        : `#L${startLine}`;
    }

    result.push({
      type: 'ref',
      value: raw,
      ref: {
        raw,
        path: rawPath,
        fileName,
        startLine,
        endLine,
        lineLabel,
      },
    });

    lastIndex = end;
  }

  if (lastIndex < text.length) {
    result.push({
      type: 'text',
      value: text.slice(lastIndex),
    });
  }

  return result;
}

/**
 * 根据文件后缀渲染对应技术栈图标
 */
export function FileLanguageIcon({ fileName }: { fileName: string }) {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  if (ext === 'tsx' || ext === 'jsx') {
    // React 原子矢量图（图1 同款）
    return (
      <svg
        width="14"
        height="14"
        viewBox="-11.5 -10.23174 23 20.46348"
        fill="none"
        style={{ flexShrink: 0 }}
      >
        <circle cx="0" cy="0" r="2.05" fill="#38bdf8" />
        <g stroke="#38bdf8" strokeWidth="1" fill="none">
          <ellipse rx="11" ry="4.2" />
          <ellipse rx="11" ry="4.2" transform="rotate(60)" />
          <ellipse rx="11" ry="4.2" transform="rotate(120)" />
        </g>
      </svg>
    );
  }

  if (ext === 'ts') {
    return (
      <span
        style={{
          width: 13,
          height: 13,
          borderRadius: 2,
          background: '#3178c6',
          color: '#fff',
          fontSize: 8.5,
          fontWeight: 800,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        TS
      </span>
    );
  }

  if (ext === 'js' || ext === 'mjs') {
    return (
      <span
        style={{
          width: 13,
          height: 13,
          borderRadius: 2,
          background: '#f7df1e',
          color: '#000',
          fontSize: 8.5,
          fontWeight: 800,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        JS
      </span>
    );
  }

  if (ext === 'java') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <path d="M18 8h1a4 4 0 0 1 0 8h-1" />
        <path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z" />
        <line x1="6" y1="1" x2="6" y2="4" />
        <line x1="10" y1="1" x2="10" y2="4" />
      </svg>
    );
  }

  if (ext === 'py') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2" style={{ flexShrink: 0 }}>
        <path d="M12 2a5 5 0 0 0-5 5v3h5v2H6a4 4 0 0 0-4 4 4 4 0 0 0 4 4h2v-2a3 3 0 0 1 3-3h5a3 3 0 0 0 3-3V7a5 5 0 0 0-5-5z" />
        <path d="M12 22a5 5 0 0 0 5-5v-3h-5v-2h6a4 4 0 0 0 4-4 4 4 0 0 0-4-4h-2v2a3 3 0 0 1-3 3h-5a3 3 0 0 0-3 3v4a5 5 0 0 0 5 5z" stroke="#f59e0b" />
      </svg>
    );
  }

  if (ext === 'cpp' || ext === 'cc' || ext === 'c' || ext === 'h' || ext === 'hpp') {
    return (
      <span
        style={{
          width: 13,
          height: 13,
          borderRadius: 2,
          background: '#00599c',
          color: '#fff',
          fontSize: 8,
          fontWeight: 700,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        C++
      </span>
    );
  }

  if (ext === 'go') {
    return (
      <span
        style={{
          width: 13,
          height: 13,
          borderRadius: 2,
          background: '#00add8',
          color: '#fff',
          fontSize: 8,
          fontWeight: 700,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        GO
      </span>
    );
  }

  // 通用文件图标
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.8 }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

/**
 * 图1同款代码引用 Pill 胶囊组件
 */
export const CodeRefPill: React.FC<{
  codeRef: ParsedCodeRef;
  onOpenFile?: (path: string, line?: number, endLine?: number) => void;
}> = ({ codeRef, onOpenFile }) => {
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onOpenFile) {
      onOpenFile(codeRef.path, codeRef.startLine, codeRef.endLine);
    } else {
      window.dispatchEvent(
        new CustomEvent('echoly:openFile', {
          detail: { path: codeRef.path, line: codeRef.startLine, endLine: codeRef.endLine },
        }),
      );
    }
  };

  return (
    <span
      className="chat-code-ref-pill"
      onClick={handleClick}
      title={`点击打开文件并高亮对应代码: ${codeRef.path}${codeRef.lineLabel || ''}`}
    >
      <FileLanguageIcon fileName={codeRef.fileName} />
      <span className="chat-code-ref-pill-name">{codeRef.fileName}</span>
      {codeRef.lineLabel && (
        <span className="chat-code-ref-pill-line">{codeRef.lineLabel}</span>
      )}
    </span>
  );
};
