import { forwardRef, useImperativeHandle, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { FileTreeNode, GitStatusEntry, GitStatusResult } from '@deepseek-ide/shared';

export type PathClipboard = {
  mode: 'cut' | 'copy';
  path: string;
  isDirectory: boolean;
} | null;

export type FileTreeHandlers = {
  onOpenFile: (path: string) => void;
  onOpenTerminal: (cwdRel: string) => void;
  onAddToChat: (path: string) => void;
  onAddToNewChat: (path: string) => void;
  onSelectNode?: (node: { path: string; isDirectory: boolean } | null) => void;
};

type MenuTarget =
  | { kind: 'blank' }
  | { kind: 'node'; node: FileTreeNode };

type ContextMenuState = {
  x: number;
  y: number;
  target: MenuTarget;
};

type InlineEdit =
  | { mode: 'create-file' | 'create-folder'; parentPath: string }
  | { mode: 'rename'; node: FileTreeNode };

function parentOf(relPath: string): string {
  const norm = relPath.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  if (idx < 0) return '.';
  return norm.slice(0, idx) || '.';
}

function joinRel(parent: string, name: string): string {
  const p = parent === '.' || parent === '' ? '' : parent.replace(/\/$/, '');
  return p ? `${p}/${name}` : name;
}

function basename(relPath: string): string {
  const norm = relPath.replace(/\\/g, '/');
  const parts = norm.split('/');
  return parts[parts.length - 1] || norm;
}

interface MenuProps {
  state: ContextMenuState;
  clipboard: PathClipboard;
  onClose: () => void;
  onAction: (action: string) => void;
}

function FileTreeContextMenu({ state, clipboard, onClose, onAction }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const isBlank = state.target.kind === 'blank';
  const node = state.target.kind === 'node' ? state.target.node : null;
  const isDir = !!node?.isDirectory;
  const canPaste = !!clipboard;

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let { x, y } = state;
    if (x + rect.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - rect.width - 8);
    if (y + rect.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - rect.height - 8);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [state]);

  const item = (id: string, label: string, opts?: { disabled?: boolean; danger?: boolean }) => (
    <button
      key={id}
      type="button"
      className={`ctx-item${opts?.danger ? ' danger' : ''}`}
      disabled={opts?.disabled}
      onClick={() => {
        if (opts?.disabled) return;
        onAction(id);
      }}
    >
      {label}
    </button>
  );

  const sep = (key: string) => <div key={key} className="ctx-sep" />;

  const items: ReactNode[] = [];

  if (isBlank || node) {
    items.push(item('new-file', '新建文件...'));
    items.push(item('new-folder', '新建文件夹...'));
  }
  if (node) {
    items.push(item('open-terminal', '在集成终端中打开'));
    items.push(sep('s1'));
    items.push(item('add-chat', '添加到聊天'));
    items.push(item('add-new-chat', '在新对话中添加'));
    if (isDir) {
      items.push(sep('s2'));
      items.push(item('find-in-folder', '在文件夹中查找...'));
    }
    items.push(sep('s3'));
    items.push(item('cut', '剪切'));
    items.push(item('copy', '复制'));
  }
  items.push(item('paste', '粘贴', { disabled: !canPaste }));
  if (node && !isDir) {
    items.push(sep('s7'));
    items.push(item('git-history', 'Git: View File History'));
  }
  if (node) {
    items.push(sep('s5'));
    items.push(item('copy-abs', '复制路径'));
    items.push(item('copy-rel', '复制相对路径'));
    items.push(sep('s6'));
    items.push(item('rename', '重命名...'));
    items.push(item('delete', '永久删除', { danger: true }));
  }


  return (
    <div className="ctx-menu" ref={ref} role="menu">
      {items}
    </div>
  );
}

function InlineNameInput({
  initial,
  placeholder,
  depth,
  onSubmit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  depth: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div className="file-node file-inline-edit" style={{ paddingLeft: 12 + depth * 16 }}>
      <span>·</span>
      <input
        ref={ref}
        className="file-inline-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const name = value.trim();
            if (name) onSubmit(name);
            else onCancel();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          const name = value.trim();
          if (name) onSubmit(name);
          else onCancel();
        }}
      />
    </div>
  );
}


export function RenderFileTreeIcon({ name, isDirectory, isOpen }: { name: string; isDirectory: boolean; isOpen?: boolean }) {
  const lowerName = name.toLowerCase();
  const segments = lowerName.split(' / ').map(s => s.trim());
  const lastName = segments[segments.length - 1];

  const svgStyle: React.CSSProperties = { marginRight: 6, flexShrink: 0, verticalAlign: 'middle', display: 'inline-block' };

  if (isDirectory) {
    // 1. Git directory
    if (segments.some(s => s === '.git' || s === '.github' || s === '.gitlab')) {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <path d="M2 3a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1v2H2V3z" fill="#f05032" opacity="0.8" />
          <path d="M2 6.5h12v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6.5z" fill="#f05032" />
          <circle cx="8" cy="10" r="1.5" fill="#fff" />
          <path d="M8 8.5v3M6.5 10h3" stroke="#f05032" strokeWidth="0.8" />
        </svg>
      );
    }

    // 2. Node modules / vendor / packages
    if (segments.some(s => s === 'node_modules' || s === 'packages' || s === 'vendor')) {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <path d="M2 3a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1v2H2V3z" fill="#8d6e63" opacity="0.8" />
          <path d="M2 6.5h12v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6.5z" fill="#8d6e63" />
          <rect x="5.5" y="8" width="5" height="4" rx="0.5" stroke="#fff" strokeWidth="1" />
          <path d="M8 8v4M5.5 10h5" stroke="#fff" strokeWidth="0.8" />
        </svg>
      );
    }

    // 3. Source code / lib / core
    if (segments.some(s => s === 'src' || s === 'source' || s === 'lib' || s === 'core')) {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <path d="M2 3a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1v2H2V3z" fill={isOpen ? '#43a047' : '#2e7d32'} opacity="0.8" />
          <path d="M2 6.5h12v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6.5z" fill={isOpen ? '#4caf50' : '#388e3c'} />
          <path d="M6 9l-1.5 1.5L6 12M10 9l1.5 1.5L10 12" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    }

    // 4. Desktop / Electron / Apps
    if (segments.some(s => s === 'desktop' || s === 'apps' || s === 'app' || s === 'electron')) {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <path d="M2 3a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1v2H2V3z" fill="#1976d2" opacity="0.8" />
          <path d="M2 6.5h12v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6.5z" fill="#2196f3" />
          <rect x="5" y="8.5" width="6" height="4" rx="0.5" stroke="#fff" strokeWidth="1" />
          <line x1="6.5" y1="13" x2="9.5" y2="13" stroke="#fff" strokeWidth="1" />
        </svg>
      );
    }

    // 5. Components / UI / Views / Pages
    if (segments.some(s => s === 'components' || s === 'component' || s === 'ui' || s === 'views' || s === 'pages')) {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <path d="M2 3a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1v2H2V3z" fill="#f57c00" opacity="0.8" />
          <path d="M2 6.5h12v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6.5z" fill="#ff9800" />
          <rect x="5" y="8" width="2.5" height="2.5" rx="0.3" fill="#fff" />
          <rect x="8.5" y="8" width="2.5" height="2.5" rx="0.3" fill="#fff" opacity="0.7" />
          <rect x="5" y="11" width="2.5" height="2" rx="0.3" fill="#fff" opacity="0.7" />
          <rect x="8.5" y="11" width="2.5" height="2" rx="0.3" fill="#fff" opacity="0.9" />
        </svg>
      );
    }

    // 6. Config / Settings
    if (segments.some(s => ['config', 'configuration', 'settings', 'conf', '.config', '.vscode'].includes(s))) {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <path d="M2 3a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1v2H2V3z" fill="#0097a7" opacity="0.8" />
          <path d="M2 6.5h12v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6.5z" fill="#00bcd4" />
          <circle cx="8" cy="10" r="1.8" stroke="#fff" strokeWidth="1" />
          <circle cx="8" cy="10" r="0.6" fill="#fff" />
        </svg>
      );
    }

    // 7. Assets / Images / Public / Resources
    if (segments.some(s => ['assets', 'static', 'public', 'images', 'icons', 'fonts', 'media', 'resources'].includes(s))) {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <path d="M2 3a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1v2H2V3z" fill="#e65100" opacity="0.8" />
          <path d="M2 6.5h12v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6.5z" fill="#ffb300" />
          <circle cx="6" cy="9" r="0.9" fill="#fff" />
          <path d="M4.5 12.5l2.2-2.5 1.8 1.5 2-2.2 1.5 3.2z" fill="#fff" opacity="0.9" />
        </svg>
      );
    }

    // 8. Dist / Build / Out / Release
    if (segments.some(s => ['dist', 'build', 'out', 'release', 'bin', 'target', '.output'].includes(s))) {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <path d="M2 3a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1v2H2V3z" fill="#546e7a" opacity="0.8" />
          <path d="M2 6.5h12v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6.5z" fill="#78909c" />
          <path d="M8 8l-2.5 1.5v2.8L8 13.5l2.5-1.2V9.5z" stroke="#fff" strokeWidth="0.9" />
          <path d="M8 8v5.5M5.5 9.5L8 11l2.5-1.5" stroke="#fff" strokeWidth="0.8" />
        </svg>
      );
    }

    // 9. Tests / Specs
    if (segments.some(s => ['test', 'tests', 'spec', 'specs', '__tests__', '__mocks__'].includes(s))) {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <path d="M2 3a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1v2H2V3z" fill="#00796b" opacity="0.8" />
          <path d="M2 6.5h12v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6.5z" fill="#26a69a" />
          <path d="M7 8.5v3a1 1 0 0 0 2 0v-3" stroke="#fff" strokeWidth="1" strokeLinecap="round" />
        </svg>
      );
    }

    // 10. Utils / Hooks / Helpers / Store / Types
    if (segments.some(s => ['utils', 'helpers', 'hooks', 'store', 'stores', 'types', 'models', 'services'].includes(s))) {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <path d="M2 3a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1v2H2V3z" fill="#c2185b" opacity="0.8" />
          <path d="M2 6.5h12v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6.5z" fill="#ec407a" />
          <circle cx="6.5" cy="9.5" r="1.2" stroke="#fff" strokeWidth="0.9" />
          <circle cx="9.5" cy="11.5" r="1.2" stroke="#fff" strokeWidth="0.9" />
          <line x1="7.4" y1="10.2" x2="8.6" y2="10.8" stroke="#fff" strokeWidth="0.9" />
        </svg>
      );
    }

    // Generic Folder (Open or Closed) - VS Code warm amber folder
    if (isOpen) {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <path d="M1.5 3a1 1 0 0 1 1-1h3.293l1.5 1.5H13.5a1 1 0 0 1 1 1v2H2.5L1.5 3z" fill="#dca04d" opacity="0.85" />
          <path d="M1 7h14l-1.8 6.3a1 1 0 0 1-.96.7H2.76a1 1 0 0 1-.96-.7L1 7z" fill="#e5ad5b" />
          <path d="M1 7h14" stroke="#f6c77d" strokeWidth="0.75" />
        </svg>
      );
    }
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <path d="M1.5 3a1 1 0 0 1 1-1h3.293l1.5 1.5H13.5a1 1 0 0 1 1 1v1.5H1.5V3z" fill="#dca04d" opacity="0.85" />
        <path d="M1.5 5.5h13a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-6.5a1 1 0 0 1 1-1z" fill="#e5ad5b" />
      </svg>
    );
  }

  // =================== FILE ICONS ===================

  // 1. TypeScript (.ts, .cts, .mts)
  if (lowerName.endsWith('.ts') && !lowerName.endsWith('.d.ts') || lowerName.endsWith('.cts') || lowerName.endsWith('.mts')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle}>
        <rect width="16" height="16" rx="2.5" fill="#3178c6" />
        <text x="3.2" y="11.5" fill="#fff" fontSize="7.8" fontWeight="bold" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">TS</text>
      </svg>
    );
  }

  // 2. TypeScript Definition (.d.ts)
  if (lowerName.endsWith('.d.ts')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle}>
        <rect width="16" height="16" rx="2.5" fill="#1e4f8a" />
        <text x="2" y="11.5" fill="#fff" fontSize="7.2" fontWeight="bold" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">D.TS</text>
      </svg>
    );
  }

  // 3. React TypeScript (.tsx)
  if (lowerName.endsWith('.tsx')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle}>
        <rect width="16" height="16" rx="2.5" fill="#2d3748" />
        <ellipse cx="8" cy="8" rx="5.5" ry="2.2" stroke="#61dafb" strokeWidth="0.9" fill="none" transform="rotate(30 8 8)" />
        <ellipse cx="8" cy="8" rx="5.5" ry="2.2" stroke="#61dafb" strokeWidth="0.9" fill="none" transform="rotate(90 8 8)" />
        <ellipse cx="8" cy="8" rx="5.5" ry="2.2" stroke="#61dafb" strokeWidth="0.9" fill="none" transform="rotate(150 8 8)" />
        <circle cx="8" cy="8" r="1.3" fill="#61dafb" />
      </svg>
    );
  }

  // 4. JavaScript (.js, .cjs, .mjs)
  if (lowerName.endsWith('.js') || lowerName.endsWith('.cjs') || lowerName.endsWith('.mjs')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle}>
        <rect width="16" height="16" rx="2.5" fill="#f7df1e" />
        <text x="3.4" y="11.5" fill="#000" fontSize="8" fontWeight="bold" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">JS</text>
      </svg>
    );
  }

  // 5. React JavaScript (.jsx)
  if (lowerName.endsWith('.jsx')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle}>
        <rect width="16" height="16" rx="2.5" fill="#00b4d8" />
        <ellipse cx="8" cy="8" rx="5.5" ry="2.2" stroke="#fff" strokeWidth="0.9" fill="none" transform="rotate(30 8 8)" />
        <ellipse cx="8" cy="8" rx="5.5" ry="2.2" stroke="#fff" strokeWidth="0.9" fill="none" transform="rotate(90 8 8)" />
        <ellipse cx="8" cy="8" rx="5.5" ry="2.2" stroke="#fff" strokeWidth="0.9" fill="none" transform="rotate(150 8 8)" />
        <circle cx="8" cy="8" r="1.3" fill="#fff" />
      </svg>
    );
  }

  // 6. JSON (.json, .json5, .jsonc)
  if (lowerName.endsWith('.json') || lowerName.endsWith('.json5') || lowerName.endsWith('.jsonc')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle}>
        <rect width="16" height="16" rx="2.5" fill="#cb3837" opacity="0.1" />
        <text x="2" y="11.5" fill="#cbcb41" fontSize="9" fontWeight="bold" fontFamily="monospace">{"{}"}</text>
      </svg>
    );
  }

  // 7. Markdown (.md, .markdown)
  if (lowerName.endsWith('.md') || lowerName.endsWith('.markdown')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <rect width="16" height="16" rx="2.5" fill="#083344" />
        <path d="M3 11V5l2.2 2.5L7.4 5v6M10.5 8.5L12 10.5l1.5-2h-1V6h-1v2.5h-1z" stroke="#38bdf8" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // 8. HTML (.html, .htm)
  if (lowerName.endsWith('.html') || lowerName.endsWith('.htm')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <rect width="16" height="16" rx="2.5" fill="#e44d26" />
        <path d="M3.5 3.5l.8 9.5 3.7 1 3.7-1 .8-9.5H3.5z" fill="#f16529" />
        <path d="M8 4.5v8.6l2.8-.8.7-7.8H8z" fill="#ebebeb" opacity="0.4" />
        <path d="M5.5 6.2h5M5.5 8h4.5M6 10.2l2 .5 2-.5" stroke="#fff" strokeWidth="0.8" />
      </svg>
    );
  }

  // 9. CSS, SCSS, LESS, SASS
  if (lowerName.endsWith('.css')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <rect width="16" height="16" rx="2.5" fill="#264de4" />
        <path d="M3.5 3.5l.8 9.5 3.7 1 3.7-1 .8-9.5H3.5z" fill="#2965f1" />
        <text x="4.2" y="11" fill="#fff" fontSize="8" fontWeight="bold" fontFamily="sans-serif">#</text>
      </svg>
    );
  }
  if (lowerName.endsWith('.scss') || lowerName.endsWith('.sass')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle}>
        <rect width="16" height="16" rx="2.5" fill="#cd6799" />
        <text x="2.5" y="11" fill="#fff" fontSize="7" fontWeight="bold" fontFamily="sans-serif">S</text>
        <circle cx="10.5" cy="8.5" r="2" fill="#fff" opacity="0.8" />
      </svg>
    );
  }
  if (lowerName.endsWith('.less')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle}>
        <rect width="16" height="16" rx="2.5" fill="#1d365d" />
        <text x="2" y="11" fill="#fff" fontSize="6.5" fontWeight="bold" fontFamily="sans-serif">LESS</text>
      </svg>
    );
  }

  // 10. Vue (.vue)
  if (lowerName.endsWith('.vue')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <polygon points="1.5,3 8,14 14.5,3 11.5,3 8,9 4.5,3" fill="#41b883" />
        <polygon points="4.5,3 8,9 11.5,3 9.5,3 8,5.5 6.5,3" fill="#35495e" />
      </svg>
    );
  }

  // 11. Python (.py)
  if (lowerName.endsWith('.py')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <path d="M7.8 2C5.5 2 5.7 3 5.7 3l.01 1.2h2.2v.3H4.7S3 4.3 3 6.6c0 2.2 1.5 2.1 1.5 2.1h.9V7.5s-.1-1.3 1.3-1.3h2.2s1.3 0 1.3-1.2V3.2S10.3 2 7.8 2zm-.9.7a.5.5 0 1 1 0 1 .5.5 0 0 1 0-1z" fill="#3776ab" />
        <path d="M8.2 14c2.3 0 2.1-1 2.1-1l-.01-1.2H8.1v-.3h3.2s1.7.2 1.7-2.1c0-2.2-1.5-2.1-1.5-2.1h-.9v1.2s.1 1.3-1.3 1.3H7.1s-1.3 0-1.3 1.2v1.8s-.1 1.2 2.4 1.2zm.9-.7a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1z" fill="#ffd438" />
      </svg>
    );
  }

  // 12. Rust (.rs)
  if (lowerName.endsWith('.rs')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <circle cx="8" cy="8" r="6.5" stroke="#dea584" strokeWidth="1" strokeDasharray="1.5 1" />
        <circle cx="8" cy="8" r="4.5" fill="#dea584" />
        <text x="5.5" y="10.5" fill="#1e1e1e" fontSize="7" fontWeight="bold" fontFamily="sans-serif">R</text>
      </svg>
    );
  }

  // 13. Go (.go)
  if (lowerName.endsWith('.go')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle}>
        <rect width="16" height="16" rx="2.5" fill="#00add8" />
        <text x="2.5" y="11.5" fill="#fff" fontSize="8" fontWeight="bold" fontFamily="sans-serif">GO</text>
      </svg>
    );
  }

  // 14. Java & JVM (.java, .class, .jar)
  if (lowerName.endsWith('.java')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <rect width="16" height="16" rx="2.5" fill="#f44336" opacity="0.12" />
        <path d="M4 11.5c1.5.5 5.5.5 8 0M5 13c1.5.3 4 .3 6 0" stroke="#f44336" strokeWidth="1" strokeLinecap="round" />
        <path d="M7 3c-1 1.5 1 2.5 0 4M9 3c-1 1.5 1 2.5 0 4" stroke="#e53935" strokeWidth="1" strokeLinecap="round" />
      </svg>
    );
  }
  if (lowerName.endsWith('.class') || lowerName.endsWith('.jar') || lowerName.endsWith('.war') || lowerName === 'pom.xml') {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <path d="M8 2.5l5 2.5v6l-5 2.5-5-2.5V5l5-2.5z" stroke="#e57373" strokeWidth="1" fill="#c62828" opacity="0.2" />
        <path d="M8 2.5v11M3 5l5 2.5 5-2.5" stroke="#e57373" strokeWidth="0.9" />
      </svg>
    );
  }

  // 15. C / C++ (.c, .cpp, .cc, .cxx, .h, .hpp)
  if (lowerName.endsWith('.c') || lowerName.endsWith('.h')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle}>
        <rect width="16" height="16" rx="2.5" fill="#5c6bc0" />
        <text x="4.5" y="11.5" fill="#fff" fontSize="8.5" fontWeight="bold" fontFamily="sans-serif">C</text>
      </svg>
    );
  }
  if (lowerName.endsWith('.cpp') || lowerName.endsWith('.cc') || lowerName.endsWith('.cxx') || lowerName.endsWith('.hpp')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle}>
        <rect width="16" height="16" rx="2.5" fill="#00599c" />
        <text x="2" y="11" fill="#fff" fontSize="6.5" fontWeight="bold" fontFamily="sans-serif">C++</text>
      </svg>
    );
  }

  // 16. Git files (.gitignore, .gitmodules, .gitattributes)
  if (lowerName.startsWith('.git') || lowerName === '.gitignore' || lowerName === '.gitmodules') {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <rect width="16" height="16" rx="2.5" fill="#f05032" />
        <circle cx="8" cy="5" r="1.3" fill="#fff" />
        <circle cx="5.5" cy="11" r="1.3" fill="#fff" />
        <circle cx="10.5" cy="9.5" r="1.3" fill="#fff" />
        <path d="M8 5v4l-2.5 2M8 9l2.5.5" stroke="#fff" strokeWidth="1" strokeLinecap="round" />
      </svg>
    );
  }

  // 17. YAML / YML (.yaml, .yml)
  if (lowerName.endsWith('.yaml') || lowerName.endsWith('.yml')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle}>
        <rect width="16" height="16" rx="2.5" fill="#cb171e" />
        <text x="2" y="11" fill="#fff" fontSize="6.5" fontWeight="bold" fontFamily="sans-serif">YML</text>
      </svg>
    );
  }

  // 18. XML & SVG (.xml, .svg)
  if (lowerName.endsWith('.svg')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <rect width="16" height="16" rx="2.5" fill="#ff9900" opacity="0.15" />
        <circle cx="5" cy="6" r="2" stroke="#ff9900" strokeWidth="1" />
        <rect x="8.5" y="8" width="4.5" height="4.5" rx="0.5" stroke="#ff9900" strokeWidth="1" />
      </svg>
    );
  }
  if (lowerName.endsWith('.xml')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <rect width="16" height="16" rx="2.5" fill="#ff6f00" opacity="0.15" />
        <text x="2" y="11.5" fill="#ff6f00" fontSize="8" fontWeight="bold" fontFamily="monospace">&lt;&gt;</text>
      </svg>
    );
  }

  // 19. Env & Config (.env, .ini, .properties, .conf)
  if (lowerName.startsWith('.env') || lowerName.endsWith('.ini') || lowerName.endsWith('.conf') || lowerName.endsWith('.properties')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <rect width="16" height="16" rx="2.5" fill="#ffd54f" opacity="0.2" />
        <circle cx="8" cy="8" r="3" stroke="#fbc02d" strokeWidth="1.2" />
        <circle cx="8" cy="8" r="1.2" fill="#fbc02d" />
      </svg>
    );
  }

  // 20. Shell Script (.sh, .bash, .zsh, .fish, .bat, .cmd)
  if (lowerName.endsWith('.sh') || lowerName.endsWith('.bash') || lowerName.endsWith('.zsh') || lowerName.endsWith('.fish') || lowerName.endsWith('.bat') || lowerName.endsWith('.cmd')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <rect width="16" height="16" rx="2.5" fill="#263238" />
        <path d="M4 6l2.5 2L4 10M7.5 10h4" stroke="#4caf50" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // 21. SQL & Databases (.sql, .db, .sqlite)
  if (lowerName.endsWith('.sql') || lowerName.endsWith('.db') || lowerName.endsWith('.sqlite')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <ellipse cx="8" cy="4.5" rx="5" ry="2" fill="#0288d1" />
        <path d="M3 4.5v7c0 1.1 2.2 2 5 2s5-.9 5-2v-7" stroke="#0288d1" strokeWidth="1" />
        <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" stroke="#0288d1" strokeWidth="1" />
      </svg>
    );
  }

  // 22. Images (.png, .jpg, .jpeg, .gif, .webp, .ico, .bmp)
  if (/\.(png|jpg|jpeg|gif|webp|ico|bmp|avif)$/.test(lowerName)) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <rect width="16" height="16" rx="2.5" fill="#a855f7" opacity="0.15" />
        <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke="#a855f7" strokeWidth="1" />
        <circle cx="6" cy="6" r="1.2" fill="#a855f7" />
        <path d="M3.5 12l3-3.5 2 2 2-2.5 2.5 4z" fill="#a855f7" opacity="0.7" />
      </svg>
    );
  }

  // 23. Lockfiles (package-lock.json, pnpm-lock.yaml, yarn.lock, Cargo.lock)
  if (lowerName.includes('lock') || lowerName.endsWith('.lock')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <rect x="3.5" y="6.5" width="9" height="7" rx="1.5" fill="#78909c" />
        <path d="M5.5 6.5V4.5a2.5 2.5 0 0 1 5 0v2" stroke="#78909c" strokeWidth="1.2" />
        <circle cx="8" cy="10" r="1" fill="#fff" />
      </svg>
    );
  }

  // 24. WeChat Mini Program (.wxml, .wxss, .wxs)
  if (lowerName.endsWith('.wxml')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle}>
        <rect width="16" height="16" rx="2.5" fill="#07c160" />
        <text x="1.5" y="11" fill="#fff" fontSize="5.8" fontWeight="bold" fontFamily="sans-serif">WXML</text>
      </svg>
    );
  }
  if (lowerName.endsWith('.wxss')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle}>
        <rect width="16" height="16" rx="2.5" fill="#07c160" />
        <text x="1.5" y="11" fill="#fff" fontSize="5.8" fontWeight="bold" fontFamily="sans-serif">WXSS</text>
      </svg>
    );
  }
  if (lowerName.endsWith('.wxs')) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle}>
        <rect width="16" height="16" rx="2.5" fill="#07c160" />
        <text x="2.5" y="11" fill="#fff" fontSize="6.5" fontWeight="bold" fontFamily="sans-serif">WXS</text>
      </svg>
    );
  }

  // Default File - Clean VS Code style folded paper
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" style={svgStyle} fill="none">
      <path d="M3.5 2a1 1 0 0 1 1-1h5.5l3.5 3.5V14a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V2z" stroke="currentColor" strokeWidth="1" opacity="0.6" />
      <path d="M10 1v3.5h3.5" stroke="currentColor" strokeWidth="1" opacity="0.6" />
    </svg>
  );
}

function getNodeGitStatus(
  nodePath: string,
  isDir: boolean,
  entries: GitStatusEntry[] = [],
): { label?: string; hasChanges?: boolean; color?: string } | null {
  if (!nodePath || typeof nodePath !== 'string' || !entries || !Array.isArray(entries) || !entries.length) return null;
  const norm = nodePath.replace(/\\/g, '/');

  try {
    if (!isDir) {
      const matched = entries.find((e) => e && e.path === norm);
      if (!matched) return null;
      if (matched.untracked) return { label: 'U', color: '#4caf50' };
      if (matched.staged) return { label: 'A', color: '#4caf50' };
      if (matched.workTree && matched.workTree.trim()) return { label: 'M', color: '#e5a54b' };
      return null;
    } else {
      const hasSubChanges = entries.some(
        (e) => e && e.path && (e.path.startsWith(norm + '/') || e.path === norm),
      );
      if (hasSubChanges) {
        return { hasChanges: true, color: '#e5a54b' };
      }
      return null;
    }
  } catch {
    return null;
  }
}


function TreeNode({
  node,
  depth,
  activePath,
  selectedNode,
  gitEntries = [],
  refreshKey,
  expandPath,
  inlineEdit,
  onOpenFile,
  onSelectNode,
  onContextNode,
  onInlineDone,
  onInlineCancel,
}: {
  node: FileTreeNode;
  depth: number;
  activePath: string | null;
  selectedNode: { path: string; isDirectory: boolean } | null;
  gitEntries?: GitStatusEntry[];
  refreshKey: number;
  expandPath: string | null;
  inlineEdit: InlineEdit | null;
  onOpenFile: (path: string) => void;
  onSelectNode?: (node: { path: string; isDirectory: boolean } | null) => void;
  onContextNode: (e: ReactMouseEvent, node: FileTreeNode) => void;
  onInlineDone: (edit: InlineEdit, name: string) => void;
  onInlineCancel: () => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const [children, setChildren] = useState<FileTreeNode[] | null>(null);

  const showRename = inlineEdit?.mode === 'rename' && inlineEdit.node.path === node.path;
  const showCreateHere =
    inlineEdit &&
    (inlineEdit.mode === 'create-file' || inlineEdit.mode === 'create-folder') &&
    inlineEdit.parentPath === node.path;

  useEffect(() => {
    if (!node.isDirectory || !open) return;
    void window.ide.listDir(node.path).then(setChildren);
  }, [node.isDirectory, node.path, open, refreshKey]);

  useEffect(() => {
    if (!expandPath || !node.isDirectory) return;
    if (
      expandPath === node.path ||
      expandPath.startsWith(`${node.path}/`) ||
      node.path.startsWith(`${expandPath}/`)
    ) {
      setOpen(true);
    }
  }, [expandPath, node.isDirectory, node.path]);



  const gitMeta = getNodeGitStatus(node.path, node.isDirectory, gitEntries);

  const indents = [];
  for (let i = 1; i <= depth; i++) {
    indents.push(<div key={i} className="tree-indent-guide" style={{ left: 16 * i - 4 }} />);
  }

  if (node.isDirectory) {
    const stickyTop = (depth - 1) * 24;
    return (
      <div>
        {showRename ? (
          <InlineNameInput
            initial={node.name}
            placeholder="文件夹名"
            depth={depth}
            onSubmit={(name) => onInlineDone(inlineEdit, name)}
            onCancel={onInlineCancel}
          />
        ) : (
          <div
            className={`file-node file-node-dir ${(selectedNode?.path === node.path) ? 'active' : ''}`}
            style={{
              paddingLeft: 12 + depth * 16,
              position: 'sticky',
              top: stickyTop,
              zIndex: 50 - depth,
            }}
            onClick={() => {
              if (onSelectNode) onSelectNode({ path: node.path, isDirectory: node.isDirectory });
              setOpen((v) => !v);
            }}
            onContextMenu={(e) => onContextNode(e, node)}
          >
            {indents}
            <span style={{ marginRight: 6, fontSize: 13, fontWeight: 'bold', width: 12, display: 'inline-block', textAlign: 'center', zIndex: 1 }}>{open ? '▾' : '▸'}</span>
            <span style={{ zIndex: 1, display: 'flex' }}><RenderFileTreeIcon name={node.name} isDirectory={true} isOpen={open} /></span>
            <span
              className="file-node-name"
              style={{ color: gitMeta?.hasChanges ? '#e5a54b' : undefined }}
              title={node.name}
            >
              {node.name}
            </span>
            {gitMeta?.hasChanges && <span className="git-dir-dot">●</span>}
          </div>
        )}
        {open && (
          <>
            {showCreateHere && (
              <InlineNameInput
                initial=""
                placeholder={inlineEdit.mode === 'create-file' ? '文件名' : '文件夹名'}
                depth={depth + 1}
                onSubmit={(name) => onInlineDone(inlineEdit, name)}
                onCancel={onInlineCancel}
              />
            )}
            {children?.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                selectedNode={selectedNode}
                gitEntries={gitEntries}
                refreshKey={refreshKey}
                expandPath={expandPath}
                inlineEdit={inlineEdit}
                onOpenFile={onOpenFile}
                onSelectNode={onSelectNode}
                onContextNode={onContextNode}
                onInlineDone={onInlineDone}
                onInlineCancel={onInlineCancel}
              />
            ))}
          </>
        )}
      </div>
    );
  }

  const nodeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activePath === node.path && nodeRef.current) {
      // Small timeout to allow directory expansion to finish rendering
      setTimeout(() => {
        nodeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
    }
  }, [activePath, node.path]);

  if (showRename) {
    return (
      <InlineNameInput
        initial={node.name}
        placeholder="文件名"
        depth={depth}
        onSubmit={(name) => onInlineDone(inlineEdit, name)}
        onCancel={onInlineCancel}
      />
    );
  }

  return (
    <div
      ref={nodeRef}
      className={`file-node ${selectedNode?.path === node.path ? 'active' : ''}`}
      style={{ paddingLeft: 12 + depth * 16 }}
      onClick={() => {
        if (onSelectNode) onSelectNode({ path: node.path, isDirectory: false });
        onOpenFile(node.path);
      }}
      onContextMenu={(e) => onContextNode(e, node)}
    >
      {indents}
      <span style={{ width: 14, zIndex: 1 }} />
      <span style={{ zIndex: 1, display: 'flex' }}><RenderFileTreeIcon name={node.name} isDirectory={false} /></span>
      <span className="file-node-name" style={{ color: gitMeta?.color }} title={node.name}>
        {node.name}
      </span>
      {gitMeta?.label && (
        <span className="git-file-status-tag" style={{ color: gitMeta.color }}>
          {gitMeta.label}
        </span>
      )}
    </div>
  );
}



function FindInFolderModal({
  folderPath,
  onOpenFile,
  onClose,
}: {
  folderPath: string;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function walk(dir: string, acc: string[]): Promise<void> {
      const entries = await window.ide.listDir(dir);
      for (const e of entries) {
        if (cancelled) return;
        if (e.isDirectory) await walk(e.path, acc);
        else acc.push(e.path);
      }
    }
    setScanning(true);
    void (async () => {
      const all: string[] = [];
      try {
        await walk(folderPath, all);
      } catch {
        /* ignore */
      }
      if (!cancelled) {
        setHits(all);
        setScanning(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [folderPath]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? hits.filter((p) => basename(p).toLowerCase().includes(q) || p.toLowerCase().includes(q))
    : hits.slice(0, 200);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="find-folder-modal" onClick={(e) => e.stopPropagation()}>
        <h2>在文件夹中查找</h2>
        <p className="muted">{folderPath}</p>
        <input
          autoFocus
          placeholder="按文件名过滤…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="find-folder-results">
          {scanning && <div className="muted">扫描中…</div>}
          {!scanning && filtered.length === 0 && <div className="muted">无匹配文件</div>}
          {filtered.map((p) => (
            <button
              key={p}
              type="button"
              className="find-folder-hit"
              onClick={() => {
                onOpenFile(p);
                onClose();
              }}
            >
              {p}
            </button>
          ))}
        </div>
        <div className="settings-actions">
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

export type FileTreeHandle = {
  createFile: () => void;
  createFolder: () => void;
};

interface Props extends FileTreeHandlers {
  workspace: string | null;
  activePath: string | null;
  selectedNode?: { path: string; isDirectory: boolean } | null;
  gitStatus?: GitStatusResult | null;
  onViewFileHistory?: (path: string) => void;
  refreshKey: number;
}

export const FileTree = forwardRef<FileTreeHandle, Props>(function FileTree({
  workspace,
  activePath,
  selectedNode = null,
  gitStatus,
  onViewFileHistory,
  onOpenFile,
  onOpenTerminal,
  onAddToChat,
  onAddToNewChat,
  onSelectNode,
  refreshKey: extRefreshKey,
}: Props, ref) {

  const [roots, setRoots] = useState<FileTreeNode[]>([]);
  const [localRefreshKey, setLocalRefreshKey] = useState(0);
  const refreshKey = (extRefreshKey ?? 0) + localRefreshKey;
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [clipboard, setClipboard] = useState<PathClipboard>(null);
  const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null);
  const [expandPath, setExpandPath] = useState<string | null>(null);
  const [findFolder, setFindFolder] = useState<string | null>(null);

  const bump = () => setLocalRefreshKey((k) => k + 1);

  useImperativeHandle(ref, () => ({
    createFile: () => {
      const parent = selectedNode
        ? (selectedNode.isDirectory ? selectedNode.path : (selectedNode.path.includes('/') ? selectedNode.path.substring(0, selectedNode.path.lastIndexOf('/')) : '.'))
        : (activePath ? (activePath.includes('/') ? activePath.substring(0, activePath.lastIndexOf('/')) : '.') : '.');
      setExpandPath(parent === '.' ? null : parent);
      setInlineEdit({ mode: 'create-file', parentPath: parent });
      bump();
    },
    createFolder: () => {
      const parent = selectedNode
        ? (selectedNode.isDirectory ? selectedNode.path : (selectedNode.path.includes('/') ? selectedNode.path.substring(0, selectedNode.path.lastIndexOf('/')) : '.'))
        : (activePath ? (activePath.includes('/') ? activePath.substring(0, activePath.lastIndexOf('/')) : '.') : '.');
      setExpandPath(parent === '.' ? null : parent);
      setInlineEdit({ mode: 'create-folder', parentPath: parent });
      bump();
    },
  }));

  useEffect(() => {
    if (!workspace) {
      setRoots([]);
      return;
    }
    void window.ide.listDir('.').then(setRoots);
  }, [workspace, refreshKey]);

  // Auto-reveal active file: set expandPath to activePath
  useEffect(() => {
    if (activePath && activePath !== '.') {
      setExpandPath(activePath);
    }
  }, [activePath]);

  const openMenu = (e: ReactMouseEvent, target: MenuTarget) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, target });
  };

  const dirForCreate = (target: MenuTarget): string => {
    if (target.kind === 'blank') return '.';
    if (target.node.isDirectory) return target.node.path;
    return parentOf(target.node.path);
  };

  const terminalCwd = (target: MenuTarget): string => {
    if (target.kind === 'blank') return '.';
    if (target.node.isDirectory) return target.node.path;
    return parentOf(target.node.path);
  };

  async function uniqueName(parent: string, base: string): Promise<string> {
    let name = base;
    let i = 1;
    while (await window.ide.pathExists(joinRel(parent, name))) {
      const dot = base.lastIndexOf('.');
      if (dot > 0) {
        name = `${base.slice(0, dot)} (${i})${base.slice(dot)}`;
      } else {
        name = `${base} (${i})`;
      }
      i += 1;
    }
    return name;
  }

  async function handleInlineDone(edit: InlineEdit, name: string): Promise<void> {
    setInlineEdit(null);
    try {
      if (edit.mode === 'create-file') {
        const path = joinRel(edit.parentPath, name);
        if (await window.ide.pathExists(path)) {
          window.alert('已存在同名文件');
          return;
        }
        await window.ide.writeFile(path, '');
        setExpandPath(edit.parentPath === '.' ? path : edit.parentPath);
        bump();
        onOpenFile(path);
      } else if (edit.mode === 'create-folder') {
        const path = joinRel(edit.parentPath, name);
        if (await window.ide.pathExists(path)) {
          window.alert('已存在同名文件夹');
          return;
        }
        await window.ide.mkdir(path);
        setExpandPath(path);
        bump();
      } else if (edit.mode === 'rename') {
        const parent = parentOf(edit.node.path);
        const next = joinRel(parent, name);
        if (next === edit.node.path) return;
        if (await window.ide.pathExists(next)) {
          window.alert('目标已存在');
          return;
        }
        await window.ide.renamePath(edit.node.path, next);
        bump();
        if (!edit.node.isDirectory) onOpenFile(next);
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
      bump();
    }
  }

  async function handleAction(action: string): Promise<void> {
    if (!menu) return;
    const { target } = menu;
    setMenu(null);
    const node = target.kind === 'node' ? target.node : null;

    try {
      switch (action) {
        case 'new-file': {
          const parent = dirForCreate(target);
          setExpandPath(parent === '.' ? null : parent);
          setInlineEdit({ mode: 'create-file', parentPath: parent });
          if (parent === '.') bump();
          else setExpandPath(parent);
          bump();
          break;
        }
        case 'new-folder': {
          const parent = dirForCreate(target);
          setExpandPath(parent === '.' ? null : parent);
          setInlineEdit({ mode: 'create-folder', parentPath: parent });
          bump();
          break;
        }
        case 'open-terminal':
          onOpenTerminal(terminalCwd(target));
          break;
        case 'add-chat':
          if (node) onAddToChat(node.path);
          break;
        case 'add-new-chat':
          if (node) onAddToNewChat(node.path);
          break;
        case 'find-in-folder':
          if (node?.isDirectory) setFindFolder(node.path);
          break;
        case 'cut':
          if (node) setClipboard({ mode: 'cut', path: node.path, isDirectory: node.isDirectory });
          break;
        case 'copy':
          if (node) setClipboard({ mode: 'copy', path: node.path, isDirectory: node.isDirectory });
          break;
        case 'paste': {
          if (!clipboard) return;
          const destParent = dirForCreate(target);
          const name = await uniqueName(destParent, basename(clipboard.path));
          const dest = joinRel(destParent, name);
          if (clipboard.mode === 'copy') {
            await window.ide.copyPath(clipboard.path, dest);
          } else {
            await window.ide.renamePath(clipboard.path, dest);
            setClipboard(null);
          }
          setExpandPath(destParent === '.' ? dest : destParent);
          bump();
          break;
        }
        case 'download':
          if (node && !node.isDirectory) {
            await window.ide.downloadFile(node.path);
          }
          break;
        case 'git-history':
          if (node) onViewFileHistory?.(node.path);
          break;
        case 'copy-abs':
          if (node) {
            const abs = await window.ide.resolveAbsolutePath(node.path);
            await navigator.clipboard.writeText(abs);
          }
          break;
        case 'copy-rel':
          if (node) await navigator.clipboard.writeText(node.path);
          break;
        case 'rename':
          if (node) setInlineEdit({ mode: 'rename', node });
          break;
        case 'delete':
          if (node) {
            const ok = window.confirm(`永久删除「${node.name}」？此操作不可撤销。`);
            if (!ok) return;
            await window.ide.removePath(node.path);
            bump();
          }
          break;
        default:
          break;
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  }

  if (!workspace) {
    return <div className="empty-state">打开一个工作区以浏览文件</div>;
  }

  const rootCreate =
    inlineEdit &&
    (inlineEdit.mode === 'create-file' || inlineEdit.mode === 'create-folder') &&
    inlineEdit.parentPath === '.';

  return (
    <div className="file-tree" onContextMenu={(e) => openMenu(e, { kind: 'blank' })}>
      {rootCreate && (
        <InlineNameInput
          initial=""
          placeholder={inlineEdit.mode === 'create-file' ? '文件名' : '文件夹名'}
          depth={0}
          onSubmit={(name) => void handleInlineDone(inlineEdit, name)}
          onCancel={() => setInlineEdit(null)}
        />
      )}
      {roots.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={1}
          activePath={activePath}
          selectedNode={selectedNode}
          gitEntries={gitStatus?.entries ?? []}
          refreshKey={refreshKey}
          expandPath={expandPath}
          inlineEdit={inlineEdit}
          onOpenFile={onOpenFile}
          onSelectNode={onSelectNode}
          onContextNode={(e, n) => openMenu(e, { kind: 'node', node: n })}
          onInlineDone={(edit, name) => void handleInlineDone(edit, name)}
          onInlineCancel={() => setInlineEdit(null)}
        />
      ))}
      {menu && (
        <FileTreeContextMenu
          state={menu}
          clipboard={clipboard}
          onClose={() => setMenu(null)}
          onAction={(a) => void handleAction(a)}
        />
      )}
      {findFolder && (
        <FindInFolderModal
          folderPath={findFolder}
          onOpenFile={onOpenFile}
          onClose={() => setFindFolder(null)}
        />
      )}
    </div>
  );
});
