import React from 'react';

interface IconProps {
  name: string;
  isDirectory: boolean;
  isOpen?: boolean;
}

const svgStyle: React.CSSProperties = {
  marginRight: 6,
  flexShrink: 0,
  verticalAlign: 'middle',
  display: 'inline-block',
};

// ── Minimalist Outline Folder Icons ──────────────────────────────────────────
// 采用轻量通透的线条轮廓风格，去除厚重色块堆叠

function renderFolderIcon(name: string, isOpen = false): React.ReactElement {
  const lowerName = name.toLowerCase();
  const segments = lowerName.split(' / ').map((s) => s.trim());
  const match = (names: string[]) => segments.some((s) => names.includes(s));

  const outline = (color: string, badge?: React.ReactNode) => {
    if (isOpen) {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          {/* Back tab outline */}
          <path
            d="M2 4.2a1 1 0 0 1 1-1h3.382a1 1 0 0 1 .707.293L8.2 4.6H13a1 1 0 0 1 1 1V7"
            stroke={color}
            strokeWidth="1.15"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Front flap tilted open */}
          <path
            d="M2 7h12l-1.6 5.8a1 1 0 0 1-.96.7H3.56a1 1 0 0 1-.96-.7L1.6 7z"
            stroke={color}
            strokeWidth="1.15"
            strokeLinejoin="round"
          />
          {badge}
        </svg>
      );
    }
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        {/* Closed folder outline */}
        <path
          d="M2 3.8a1 1 0 0 1 1-1h3.382a1 1 0 0 1 .707.293L8.2 4.2H13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.8z"
          stroke={color}
          strokeWidth="1.15"
          strokeLinejoin="round"
        />
        {badge}
      </svg>
    );
  };

  // 1. node_modules (Grey folder outline + green dot, exactly as in screenshot)
  if (match(['node_modules'])) {
    return outline('#8b949e', <circle cx="12.5" cy="11.5" r="1.5" fill="#22c55e" />);
  }

  // 2. scripts / bin (Folder outline + small red/orange </> badge, as in screenshot)
  if (match(['scripts', 'script', 'bin'])) {
    return outline(
      '#8b949e',
      <g>
        <path
          d="M7 11.2l-1.6 1.3 1.6 1.3M11 11.2l1.6 1.3-1.6 1.3"
          stroke="#f87171"
          strokeWidth="1.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>,
    );
  }

  // 3. packages (Warm golden amber outline, as in screenshot)
  if (match(['packages', 'package', 'vendor'])) {
    return outline('#d29922');
  }

  // 4. Source code (src, source, lib, core, app)
  if (match(['src', 'source', 'lib', 'core', 'app'])) {
    return outline(
      '#3fb950',
      <path
        d="M8.5 11l-1 1.5 1 1.5M12.5 11l1 1.5-1 1.5"
        stroke="#3fb950"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />,
    );
  }

  // 5. Components & UI
  if (match(['components', 'component', 'ui', 'widgets', 'views', 'pages', 'screens'])) {
    return outline(
      '#f0883e',
      <g fill="#f0883e">
        <circle cx="10" cy="11.5" r="0.8" />
        <circle cx="12.5" cy="11.5" r="0.8" />
      </g>,
    );
  }

  // 6. Assets & Media
  if (match(['assets', 'static', 'public', 'images', 'img', 'icons', 'fonts', 'media'])) {
    return outline('#bc8cff');
  }

  // 7. Styles & Themes
  if (match(['styles', 'style', 'css', 'scss', 'sass', 'theme'])) {
    return outline('#db61a2');
  }

  // 8. Dist & Build
  if (match(['dist', 'build', 'out', 'release', 'target', '.output', '.next', '.nuxt'])) {
    return outline('#7d8590');
  }

  // 9. Tests
  if (match(['test', 'tests', 'spec', 'specs', '__tests__', '__mocks__'])) {
    return outline('#39c5bb');
  }

  // 10. Utils & Helpers
  if (match(['utils', 'util', 'helpers', 'helper', 'tools', 'common', 'shared'])) {
    return outline('#a371f7');
  }

  // 11. Git directory
  if (match(['.git', '.github', '.gitlab'])) {
    return outline('#f78166');
  }

  // 12. Config & VS Code
  if (match(['.vscode', '.idea', '.cursor', 'config', 'configurations', '.config'])) {
    return outline('#58a6ff');
  }

  // 13. Database
  if (match(['database', 'db', 'models', 'prisma', 'migrations'])) {
    return outline('#388bfd');
  }

  // 14. Default folder outline (Crisp minimal outline)
  return outline('#8b949e');
}

// ── Minimalist File Icons ───────────────────────────────────────────────────
// 采用无厚重底色的轻盈图标风格（文本字标、线框与官方图形）

function renderFileIcon(name: string): React.ReactElement {
  const lower = name.toLowerCase();

  // ── 1. 特殊全文件名匹配 ──────────────────────────────────────────────────

  // tsconfig.*.tsbuildinfo -> 金黄大括号 { } (如截图所示)
  if (lower.endsWith('.tsbuildinfo')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <path
          d="M5.8 3.2c-.8 0-1.8.4-1.8 1.8v1.8c0 .9-.5 1.2-1.4 1.2.9 0 1.4.3 1.4 1.2v1.8c0 1.4 1 1.8 1.8 1.8"
          stroke="#d29922"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M10.2 3.2c.8 0 1.8.4 1.8 1.8v1.8c0 .9.5 1.2 1.4 1.2-.9 0-1.4.3-1.4 1.2v1.8c0 1.4-1 1.8-1.8 1.8"
          stroke="#d29922"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  // tsconfig.json / tsconfig.*.json -> 蓝色 T + 小灰色齿轮 ⚙ (如截图所示)
  if (lower === 'tsconfig.json' || (lower.startsWith('tsconfig.') && lower.endsWith('.json'))) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <text
          x="5"
          y="11.8"
          textAnchor="middle"
          fill="#388bfd"
          fontSize="9.5"
          fontWeight="800"
          fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        >
          T
        </text>
        {/* Small gear on bottom right */}
        <circle cx="12" cy="11" r="1.7" stroke="#8b949e" strokeWidth="1" />
        <circle cx="12" cy="11" r="0.6" fill="#8b949e" />
        <path d="M12 8.6v.9M12 12.5v.9M9.6 11h.9M13.5 11h.9" stroke="#8b949e" strokeWidth="0.8" />
      </svg>
    );
  }

  // package.json -> 绿色六边形内嵌 JS (如截图所示)
  if (lower === 'package.json') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <path
          d="M8 1.8l5 2.9v6.6L8 14.2l-5-2.9V4.7L8 1.8z"
          stroke="#2dd4bf"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <text
          x="8"
          y="10.4"
          textAnchor="middle"
          fill="#2dd4bf"
          fontSize="6.5"
          fontWeight="800"
          fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        >
          JS
        </text>
      </svg>
    );
  }

  // vite config
  if (lower.startsWith('vite.config.')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <path d="M10.5 2L5 8.5h3L4.5 14 12 7.5H9L10.5 2z" fill="#a855f7" />
        <path d="M8 8.5L4.5 14 12 7.5H9L10.5 2" stroke="#ffbd2e" strokeWidth="0.8" />
      </svg>
    );
  }

  // tailwind config
  if (lower.startsWith('tailwind.config.')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <path
          d="M4.5 8c.8-1.4 2-1.8 3.5-1.4 1 .3 1.6 1.1 2.4 1.2 1.2.2 2.2-.6 2.6-2.2-.8 1.4-2 1.8-3.5 1.4-1-.3-1.6-1.1-2.4-1.2-1.2-.2-2.2.6-2.6 2.2zm-2 4c.8-1.4 2-1.8 3.5-1.4 1 .3 1.6 1.1 2.4 1.2 1.2.2 2.2-.6 2.6-2.2-.8 1.4-2 1.8-3.5 1.4-1-.3-1.6-1.1-2.4-1.2-1.2-.2-2.2.6-2.6 2.2z"
          fill="#38bdf8"
        />
      </svg>
    );
  }

  // Next.js config
  if (lower.startsWith('next.config.')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <circle cx="8" cy="8" r="6" stroke="#8b949e" strokeWidth="1.1" />
        <path d="M5.5 11V5h1.2l3.8 5V5h1.2v6h-1.2L6.7 6v5H5.5z" fill="#e6edf3" />
      </svg>
    );
  }

  // Dockerfile & compose
  if (
    lower === 'dockerfile' ||
    lower.startsWith('dockerfile.') ||
    lower.includes('docker-compose') ||
    lower === 'compose.yaml' ||
    lower === 'compose.yml'
  ) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <rect x="3.5" y="6" width="1.6" height="1.4" rx="0.2" fill="#388bfd" />
        <rect x="5.7" y="6" width="1.6" height="1.4" rx="0.2" fill="#388bfd" />
        <rect x="7.9" y="6" width="1.6" height="1.4" rx="0.2" fill="#388bfd" />
        <rect x="5.7" y="4.2" width="1.6" height="1.4" rx="0.2" fill="#388bfd" />
        <rect x="7.9" y="4.2" width="1.6" height="1.4" rx="0.2" fill="#388bfd" />
        <path
          d="M2.5 8.5c.5 2.8 2.8 4.2 5.5 4.2 3.2 0 5-1.5 5.5-3.2 0-.5-.4-.8-.9-.8H2.5z"
          fill="#388bfd"
        />
      </svg>
    );
  }

  // Git ignore & config
  if (lower.startsWith('.git')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <circle cx="8" cy="4" r="1.3" fill="#f78166" />
        <circle cx="5" cy="11.5" r="1.3" fill="#f78166" />
        <circle cx="11" cy="9.5" r="1.3" fill="#f78166" />
        <path d="M8 4v5L5 11.5M8 8.5l3 1" stroke="#f78166" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
    );
  }

  // Environment file (.env)
  if (lower.startsWith('.env')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <circle cx="8" cy="7" r="2.5" stroke="#e3b341" strokeWidth="1.2" />
        <path d="M8 9.5V13M6.5 11.5h3" stroke="#e3b341" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }

  // Lockfiles (package-lock, yarn.lock, pnpm-lock)
  if (lower.includes('lock')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <rect x="3.5" y="6.5" width="9" height="7" rx="1" stroke="#8b949e" strokeWidth="1.1" />
        <path d="M5.5 6.5V4.5a2.5 2.5 0 0 1 5 0v2" stroke="#8b949e" strokeWidth="1.1" />
        <circle cx="8" cy="10" r="0.8" fill="#8b949e" />
      </svg>
    );
  }

  // ── 2. 文件扩展名匹配 ────────────────────────────────────────────────────

  // HTML (.html, .htm) -> 橙色代码尖括号 </> (如截图所示)
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <path
          d="M5.5 5L2.5 8l3 3M10.5 5l3 3-3 3M9.5 4l-3 8"
          stroke="#e34c26"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  // TypeScript (.ts, .cts, .mts) -> 纯净蓝色加粗 TS (如截图所示)
  if (
    (lower.endsWith('.ts') && !lower.endsWith('.d.ts')) ||
    lower.endsWith('.cts') ||
    lower.endsWith('.mts')
  ) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <text
          x="8"
          y="11.6"
          textAnchor="middle"
          fill="#388bfd"
          fontSize="9"
          fontWeight="800"
          fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        >
          TS
        </text>
      </svg>
    );
  }

  // TypeScript Defs (.d.ts) -> 暗蓝/浅蓝纯净 D.TS
  if (lower.endsWith('.d.ts') || lower.endsWith('.d.cts') || lower.endsWith('.d.mts')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <text
          x="8"
          y="11.2"
          textAnchor="middle"
          fill="#79c0ff"
          fontSize="6.8"
          fontWeight="800"
          letterSpacing="-0.3px"
          fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        >
          D.TS
        </text>
      </svg>
    );
  }

  // JavaScript (.js, .cjs, .mjs) -> 金黄色加粗 JS (如截图所示)
  if (lower.endsWith('.js') || lower.endsWith('.cjs') || lower.endsWith('.mjs')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <text
          x="8"
          y="11.6"
          textAnchor="middle"
          fill="#e3b341"
          fontSize="9"
          fontWeight="800"
          fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        >
          JS
        </text>
      </svg>
    );
  }

  // JSON (.json, .json5, .jsonc) -> 金黄大括号 { } (如截图所示)
  if (lower.endsWith('.json') || lower.endsWith('.json5') || lower.endsWith('.jsonc')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <path
          d="M5.8 3.2c-.8 0-1.8.4-1.8 1.8v1.8c0 .9-.5 1.2-1.4 1.2.9 0 1.4.3 1.4 1.2v1.8c0 1.4 1 1.8 1.8 1.8"
          stroke="#d29922"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M10.2 3.2c.8 0 1.8.4 1.8 1.8v1.8c0 .9.5 1.2 1.4 1.2-.9 0-1.4.3-1.4 1.2v1.8c0 1.4-1 1.8-1.8 1.8"
          stroke="#d29922"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  // React TSX (.tsx) -> 青蓝 React 原子
  if (lower.endsWith('.tsx')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <ellipse
          cx="8"
          cy="8"
          rx="5.5"
          ry="2.2"
          stroke="#58a6ff"
          strokeWidth="0.9"
          transform="rotate(30 8 8)"
        />
        <ellipse
          cx="8"
          cy="8"
          rx="5.5"
          ry="2.2"
          stroke="#58a6ff"
          strokeWidth="0.9"
          transform="rotate(90 8 8)"
        />
        <ellipse
          cx="8"
          cy="8"
          rx="5.5"
          ry="2.2"
          stroke="#58a6ff"
          strokeWidth="0.9"
          transform="rotate(150 8 8)"
        />
        <circle cx="8" cy="8" r="1.3" fill="#58a6ff" />
      </svg>
    );
  }

  // React JSX (.jsx) -> 金黄 React 原子
  if (lower.endsWith('.jsx')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <ellipse
          cx="8"
          cy="8"
          rx="5.5"
          ry="2.2"
          stroke="#e3b341"
          strokeWidth="0.9"
          transform="rotate(30 8 8)"
        />
        <ellipse
          cx="8"
          cy="8"
          rx="5.5"
          ry="2.2"
          stroke="#e3b341"
          strokeWidth="0.9"
          transform="rotate(90 8 8)"
        />
        <ellipse
          cx="8"
          cy="8"
          rx="5.5"
          ry="2.2"
          stroke="#e3b341"
          strokeWidth="0.9"
          transform="rotate(150 8 8)"
        />
        <circle cx="8" cy="8" r="1.3" fill="#e3b341" />
      </svg>
    );
  }

  // Python (.py, .pyw)
  if (lower.endsWith('.py') || lower.endsWith('.pyw')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <path
          d="M7.8 2C5.5 2 5.7 3 5.7 3l.01 1.2h2.2v.3H4.7S3 4.3 3 6.6c0 2.2 1.5 2.1 1.5 2.1h.9V7.5s-.1-1.3 1.3-1.3h2.2s1.3 0 1.3-1.2V3.2S10.3 2 7.8 2zm-.9.7a.5.5 0 1 1 0 1 .5.5 0 0 1 0-1z"
          fill="#388bfd"
        />
        <path
          d="M8.2 14c2.3 0 2.1-1 2.1-1l-.01-1.2H8.1v-.3h3.2s1.7.2 1.7-2.1c0-2.2-1.5-2.1-1.5-2.1h-.9v1.2s.1 1.3-1.3 1.3H7.1s-1.3 0-1.3 1.2v1.8s-.1 1.2 2.4 1.2zm.9-.7a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1z"
          fill="#e3b341"
        />
      </svg>
    );
  }

  // Vue (.vue)
  if (lower.endsWith('.vue')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <polygon points="1.5,3 8,14 14.5,3 11.5,3 8,9 4.5,3" fill="#41b883" />
        <polygon points="4.5,3 8,9 11.5,3 9.5,3 8,5.5 6.5,3" fill="#35495e" />
      </svg>
    );
  }

  // CSS (.css) -> 蓝色 #
  if (lower.endsWith('.css')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <text
          x="8"
          y="12"
          textAnchor="middle"
          fill="#58a6ff"
          fontSize="11"
          fontWeight="800"
          fontFamily="sans-serif"
        >
          #
        </text>
      </svg>
    );
  }

  // SCSS / SASS (.scss, .sass) -> 粉色 S
  if (lower.endsWith('.scss') || lower.endsWith('.sass')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <text
          x="8"
          y="11.8"
          textAnchor="middle"
          fill="#f43f5e"
          fontSize="10"
          fontWeight="800"
          fontFamily="sans-serif"
        >
          S
        </text>
      </svg>
    );
  }

  // Markdown (.md, .markdown, .mdx) -> 标志性 M 标
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdx')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <path
          d="M2.5 11.5V4.5l2.8 3.2 2.8-3.2v7M11.5 8.5L13 10.5l1.5-2h-1V5.5h-1v3h-1z"
          stroke="#58a6ff"
          strokeWidth="1.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  // Shell Script (.sh, .bash, .zsh) -> 纯净绿色命令行 >_
  if (
    lower.endsWith('.sh') ||
    lower.endsWith('.bash') ||
    lower.endsWith('.zsh') ||
    lower.endsWith('.fish') ||
    lower.endsWith('.bat') ||
    lower.endsWith('.cmd')
  ) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <path
          d="M3.5 5.5l3 2.5-3 2.5M8.5 10.5h4"
          stroke="#3fb950"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  // Go (.go)
  if (lower.endsWith('.go')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <text
          x="8"
          y="11.5"
          textAnchor="middle"
          fill="#00add8"
          fontSize="8.5"
          fontWeight="800"
          fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        >
          GO
        </text>
      </svg>
    );
  }

  // Rust (.rs)
  if (lower.endsWith('.rs')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <circle cx="8" cy="8" r="5.5" stroke="#dea584" strokeWidth="1.2" />
        <text
          x="8"
          y="10.6"
          textAnchor="middle"
          fill="#dea584"
          fontSize="7.5"
          fontWeight="bold"
          fontFamily="sans-serif"
        >
          R
        </text>
      </svg>
    );
  }

  // Java (.java) -> 红色咖啡杯线条
  if (lower.endsWith('.java')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <path
          d="M4.5 12c2 .4 5 .4 7 0M5.5 13.5c1.5.3 3.5.3 5 0"
          stroke="#f87171"
          strokeWidth="1"
          strokeLinecap="round"
        />
        <path
          d="M7 3.5c-1 1.2.8 2.2 0 3.8M9 3.5c-1 1.2.8 2.2 0 3.8"
          stroke="#f97316"
          strokeWidth="1"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  // YAML (.yaml, .yml)
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <text
          x="8"
          y="11.2"
          textAnchor="middle"
          fill="#f87171"
          fontSize="6.8"
          fontWeight="800"
          letterSpacing="-0.2px"
          fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        >
          YML
        </text>
      </svg>
    );
  }

  // SQL & DB (.sql, .db, .sqlite)
  if (
    lower.endsWith('.sql') ||
    lower.endsWith('.db') ||
    lower.endsWith('.sqlite') ||
    lower.endsWith('.sqlite3')
  ) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <ellipse cx="8" cy="4.5" rx="5" ry="1.8" stroke="#388bfd" strokeWidth="1.1" />
        <path d="M3 4.5v7c0 1 2.2 1.8 5 1.8s5-.8 5-1.8v-7" stroke="#388bfd" strokeWidth="1.1" />
        <path d="M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8" stroke="#388bfd" strokeWidth="1.1" />
      </svg>
    );
  }

  // Images (.png, .jpg, .svg, .webp)
  if (/\.(png|jpg|jpeg|gif|webp|ico|bmp|avif|svg)$/.test(lower)) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke="#a855f7" strokeWidth="1.1" />
        <circle cx="6" cy="6" r="1.2" fill="#a855f7" />
        <path d="M3.5 12l3-3.5 2 2 2-2.5 2.5 4z" fill="#a855f7" opacity="0.8" />
      </svg>
    );
  }

  // Default File (Minimalist Outline Sheet)
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
      <path
        d="M3.5 2.5a1 1 0 0 1 1-1h5l3.5 3.5v8.5a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1v-11z"
        stroke="#8b949e"
        strokeWidth="1.1"
      />
      <path d="M9.5 1.5v3.5h3.5" stroke="#8b949e" strokeWidth="1.1" />
    </svg>
  );
}

export function RenderFileTreeIcon({
  name,
  isDirectory,
  isOpen = false,
}: IconProps): React.ReactElement {
  if (isDirectory) {
    return renderFolderIcon(name, isOpen);
  }
  return renderFileIcon(name);
}
