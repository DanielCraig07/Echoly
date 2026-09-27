import React from 'react';

export type CodeSubtype =
  | 'class'
  | 'interface'
  | 'enum'
  | 'annotation'
  | 'record'
  | 'abstract'
  | 'exception'
  | 'test'
  | 'entry'
  | 'config'
  | 'default';

export interface IconProps {
  name: string;
  isDirectory: boolean;
  isOpen?: boolean;
  codeType?: CodeSubtype;
  contentSnippet?: string;
}

const svgStyle: React.CSSProperties = {
  marginRight: 6,
  flexShrink: 0,
  verticalAlign: 'middle',
  display: 'inline-block',
};

export function detectCodeSubtype(name: string, contentSnippet?: string): CodeSubtype {
  const lower = name.toLowerCase();

  // 1. Java 深度语义检测
  if (lower.endsWith('.java')) {
    if (contentSnippet) {
      if (/@interface\s+\w+/.test(contentSnippet)) return 'annotation';
      if (/\benum\s+\w+/.test(contentSnippet)) return 'enum';
      if (/\binterface\s+\w+/.test(contentSnippet)) return 'interface';
      if (/\brecord\s+\w+/.test(contentSnippet)) return 'record';
      if (/\babstract\s+(?:(?:non-sealed|sealed)\s+)?class\s+\w+/i.test(contentSnippet) || /\bclass\s+\w+.*?\babstract\b/i.test(contentSnippet)) return 'abstract';
      if (/\bclass\s+\w+.*?\bextends\s+(?:Throwable|Exception|RuntimeException|Error|\w*Exception)\b/s.test(contentSnippet)) return 'exception';
      if (/@Test\b|\bextends\s+TestCase\b|\borg\.junit\b|\borg\.testng\b/.test(contentSnippet)) return 'test';
      if (/\bclass\s+\w+/.test(contentSnippet)) return 'class';
    }
    // 依据文件名智能推断（全面适配 Java 业界标准约定）
    if (/(?:Test|Tests|TestCase|IT)\.java$/i.test(name)) return 'test';
    if (/(?:Exception|Error|Fault)\.java$/i.test(name)) return 'exception';
    if (/(?:Enum|Type|Status|Mode|State)\.java$/i.test(name)) return 'enum';
    if (/(?:Annotation|Anno)\.java$/i.test(name)) return 'annotation';
    if (/(?:Record)\.java$/i.test(name)) return 'record';
    if (/^(?:Abstract|Base)\w*\.java$/i.test(name)) return 'abstract';
    if (
      /(?:Interface|Listener|Callback|Handler|Mapper|Repository|Repo|Service)\.java$/i.test(name) &&
      !/(?:Impl|Base|Abstract)\.java$/i.test(name)
    ) {
      return 'interface';
    }
    if (/^I[A-Z]\w*\.java$/.test(name)) return 'interface';
    return 'class';
  }

  // 1.1 Kotlin 深度语义检测
  if (lower.endsWith('.kt') || lower.endsWith('.kts')) {
    if (lower.endsWith('.kts')) return 'config';
    if (/(?:Test|Tests|TestCase|Spec)\.kt$/i.test(name)) return 'test';
    if (contentSnippet) {
      if (/\binterface\s+\w+/.test(contentSnippet)) return 'interface';
      if (/\benum\s+class\s+\w+/.test(contentSnippet)) return 'enum';
      if (/@Test\b|\borg\.junit\b/.test(contentSnippet)) return 'test';
      if (/\bobject\s+\w+/.test(contentSnippet)) return 'class';
    }
    if (/interface|listener/i.test(name)) return 'interface';
    if (/enum|type/i.test(name)) return 'enum';
    return 'class';
  }

  // 1.2 Scala 深度语义检测
  if (lower.endsWith('.scala')) {
    if (/(?:Test|Tests|Spec|Suite)\.scala$/i.test(name)) return 'test';
    if (contentSnippet) {
      if (/\btrait\s+\w+/.test(contentSnippet)) return 'interface';
      if (/\bobject\s+\w+/.test(contentSnippet)) return 'class';
    }
    if (/trait|interface/i.test(name)) return 'interface';
    return 'class';
  }

  // 2. TypeScript / JavaScript 深度语义检测
  if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.js') || lower.endsWith('.jsx')) {
    if (lower.endsWith('.test.ts') || lower.endsWith('.test.tsx') || lower.endsWith('.spec.ts') || lower.endsWith('.spec.tsx') || lower.endsWith('.test.js')) {
      return 'test';
    }
    if (lower.endsWith('.d.ts') || lower.endsWith('.d.cts') || lower.endsWith('.d.mts') || /type|types|interface|interfaces|schema|schemas/i.test(name)) {
      return 'interface';
    }
    if (/config|rc|\.env/i.test(name)) {
      return 'config';
    }
  }

  // 3. Python 深度检测
  if (lower.endsWith('.py')) {
    if (/^test_|_test\.py$/.test(lower)) return 'test';
    if (lower === '__init__.py') return 'config';
    if (lower === '__main__.py' || lower === 'main.py' || lower === 'app.py' || lower === 'manage.py') return 'entry';
  }

  // 4. C / C++ 深度检测
  if (lower.endsWith('.c') || lower.endsWith('.cpp') || lower.endsWith('.cc') || lower.endsWith('.cxx')) {
    if (/main\.(c|cpp|cc|cxx)$/.test(lower)) return 'entry';
    if (/test|spec/i.test(name)) return 'test';
    return 'class';
  }
  if (lower.endsWith('.h') || lower.endsWith('.hpp') || lower.endsWith('.hxx')) {
    return 'interface';
  }

  // 5. Go 深度检测
  if (lower.endsWith('.go')) {
    if (lower.endsWith('_test.go')) return 'test';
    if (lower === 'main.go') return 'entry';
    if (/interface|types|models/i.test(name)) return 'interface';
  }

  // 6. Rust 深度检测
  if (lower.endsWith('.rs')) {
    if (lower === 'main.rs') return 'entry';
    if (lower === 'lib.rs') return 'class';
    if (lower === 'mod.rs') return 'config';
    if (lower.endsWith('_test.rs') || lower.startsWith('test_')) return 'test';
  }

  return 'default';
}

// ── Minimalist Outline Folder Icons ──────────────────────────────────────────
// 采用轻量通透的线条轮廓风格，去除厚重色块堆叠

function renderFolderIcon(name: string, isOpen = false): React.ReactElement {
  const lowerName = name.toLowerCase().replace(/\\/g, '/').trim();
  const segments = lowerName.split('/').map((s) => s.trim());
  const match = (names: string[]) =>
    names.some((n) => lowerName === n || lowerName.endsWith('/' + n) || segments.includes(n));

  const outline = (color: string, badge?: React.ReactNode, fillColor?: string) => {
    const fill = fillColor || 'none';
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
            fill={fill}
          />
          {/* Front flap tilted open */}
          <path
            d="M2 7h12l-1.6 5.8a1 1 0 0 1-.96.7H3.56a1 1 0 0 1-.96-.7L1.6 7z"
            stroke={color}
            strokeWidth="1.15"
            strokeLinejoin="round"
            fill={fill !== 'none' ? fill : 'rgba(255, 255, 255, 0.04)'}
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
          fill={fill}
        />
        {badge}
      </svg>
    );
  };

  // 1. Java / Maven (.mvn, src/main/java, src/test/java, java, resources, target)
  if (match(['.mvn', 'mvn', 'java', 'main/java', 'test/java', 'src/main/java', 'src/test/java'])) {
    return outline(
      '#f97316',
      <path
        d="M8 8.5c-.8 1-1.2 1.8-.4 2.8.6.8 1.8.8 2.4 0 .8-1 .4-1.8-.4-2.8z"
        stroke="#f97316"
        strokeWidth="1"
        fill="#f97316"
      />
    );
  }
  if (match(['resources', 'main/resources', 'test/resources'])) {
    return outline(
      '#fb923c',
      <circle cx="11.5" cy="11.5" r="1.3" fill="#fb923c" />
    );
  }
  if (match(['gradle', '.gradle'])) {
    return outline(
      '#0284c7',
      <path d="M8 10l2 2 3-3" stroke="#0284c7" strokeWidth="1.1" strokeLinecap="round" />
    );
  }

  // 2. Python (.venv, venv, env, __pycache__, site-packages)
  if (match(['.venv', 'venv', 'env', '.env', '__pycache__', 'site-packages'])) {
    return outline(
      '#22c55e',
      <g>
        <circle cx="10" cy="11.5" r="1.2" fill="#388bfd" />
        <circle cx="12.5" cy="11.5" r="1.2" fill="#eab308" />
      </g>
    );
  }

  // 3. C / C++ / CMake (include, cmake, deps, third_party)
  if (match(['include', 'includes', 'cmake', 'deps', 'third_party', 'thirdparty'])) {
    return outline(
      '#06b6d4',
      <text
        x="11.5"
        y="13"
        textAnchor="middle"
        fill="#06b6d4"
        fontSize="5.5"
        fontWeight="bold"
        fontFamily="sans-serif"
      >
        C
      </text>
    );
  }

  // 4. Go (cmd, pkg, internal)
  if (match(['cmd', 'pkg', 'internal'])) {
    return outline(
      '#00add8',
      <text
        x="11.5"
        y="13"
        textAnchor="middle"
        fill="#00add8"
        fontSize="5.5"
        fontWeight="800"
        fontFamily="sans-serif"
      >
        G
      </text>
    );
  }

  // 5. Rust (crates, benches)
  if (match(['crates', 'benches'])) {
    return outline(
      '#ea580c',
      <circle cx="11.5" cy="11.5" r="1.4" stroke="#ea580c" strokeWidth="1" />
    );
  }

  // 6. Node modules
  if (match(['node_modules'])) {
    return outline('#8b949e', <circle cx="12" cy="11.5" r="1.4" fill="#22c55e" />);
  }

  // 7. Scripts / bin
  if (match(['scripts', 'script', 'bin'])) {
    return outline(
      '#8b949e',
      <path
        d="M7.5 11l-1.4 1.2 1.4 1.2M11.5 11l1.4 1.2-1.4 1.2"
        stroke="#f87171"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  }

  // 8. Packages & Vendor
  if (match(['packages', 'package', 'vendor'])) {
    return outline('#d29922');
  }

  // 9. Source code (src, source, lib, core, app)
  if (match(['src', 'source', 'lib', 'core', 'app'])) {
    return outline(
      '#3fb950',
      <path
        d="M8.5 11l-1 1.5 1 1.5M12.5 11l1 1.5-1 1.5"
        stroke="#3fb950"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  }

  // 10. Components & Views & Pages
  if (match(['components', 'component', 'ui', 'widgets', 'views', 'pages', 'screens', 'layouts', 'routes'])) {
    return outline(
      '#f0883e',
      <g fill="#f0883e">
        <circle cx="10" cy="11.5" r="0.8" />
        <circle cx="12.5" cy="11.5" r="0.8" />
      </g>
    );
  }

  // 11. Assets & Media & Public
  if (match(['assets', 'static', 'public', 'images', 'img', 'icons', 'fonts', 'media'])) {
    return outline('#bc8cff');
  }

  // 12. Styles & Themes
  if (match(['styles', 'style', 'css', 'scss', 'sass', 'theme', 'themes'])) {
    return outline('#db61a2');
  }

  // 13. Dist, Target & Build outputs
  if (match(['dist', 'build', 'out', 'release', 'target', '.output', '.next', '.nuxt'])) {
    return outline('#7d8590');
  }

  // 14. Tests
  if (match(['test', 'tests', 'spec', 'specs', '__tests__', '__mocks__'])) {
    return outline(
      '#39c5bb',
      <circle cx="11.5" cy="11.5" r="1.3" stroke="#39c5bb" strokeWidth="1" />
    );
  }

  // 15. Utils, Helpers & Hooks & Services & Store
  if (match(['utils', 'util', 'helpers', 'helper', 'tools', 'common', 'shared', 'hooks', 'services', 'store', 'stores', 'types', 'api'])) {
    return outline('#a371f7');
  }

  // 16. Git directory & CI/CD
  if (match(['.git', '.github', '.gitlab', '.circleci'])) {
    return outline('#f78166');
  }

  // 17. Docker & Cloud / Infra
  if (match(['docker', '.docker', 'k8s', 'kubernetes', 'helm', 'terraform'])) {
    return outline('#38bdf8');
  }

  // 18. Config & IDE
  if (match(['.vscode', '.idea', '.cursor', '.settings', 'config', 'configurations', '.config'])) {
    return outline('#58a6ff');
  }

  // 19. Database
  if (match(['database', 'db', 'models', 'prisma', 'migrations', 'sql'])) {
    return outline('#388bfd');
  }

  // 20. Docs
  if (match(['docs', 'doc', 'documentation', 'manual'])) {
    return outline('#eab308');
  }

  // Default folder outline (warm clean folder)
  return outline('#9ca3af');
}

// ── Minimalist File Icons ───────────────────────────────────────────────────
// 采用无厚重底色的轻盈图标风格（文本字标、线框与官方图形）

function renderFileIcon(name: string, codeType?: CodeSubtype, contentSnippet?: string): React.ReactElement {
  const lower = name.toLowerCase();
  const resolvedType = codeType && codeType !== 'default' ? codeType : detectCodeSubtype(name, contentSnippet);

  // 0. 测试代码文件（烧瓶图标 🧪 - 排除 Java/Kotlin/Scala 等有官方专属测试类徽标的语言）
  if (
    resolvedType === 'test' &&
    !lower.endsWith('.html') &&
    !lower.endsWith('.json') &&
    !lower.endsWith('.java') &&
    !lower.endsWith('.kt') &&
    !lower.endsWith('.scala')
  ) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <path
          d="M6 2h4M7 2v3.5L3.5 12a1.5 1.5 0 0 0 1.3 2h6.4a1.5 1.5 0 0 0 1.3-2L9 5.5V2"
          stroke="#22c55e"
          strokeWidth="1.15"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M4.8 11.5h6.4" stroke="#22c55e" strokeWidth="1" strokeLinecap="round" />
        <circle cx="7" cy="9.5" r="0.8" fill="#22c55e" />
        <circle cx="9.2" cy="8.2" r="0.6" fill="#22c55e" />
      </svg>
    );
  }

  // 0.1 程序运行入口文件（启动三角）
  if (resolvedType === 'entry') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <circle cx="8" cy="8" r="6" stroke="#38bdf8" strokeWidth="1.1" fill="rgba(56, 189, 248, 0.12)" />
        <polygon points="6.5,5 11.5,8 6.5,11" fill="#38bdf8" />
      </svg>
    );
  }

  // 0.2 Spring Boot 配置文件 (application.yml, application.properties, bootstrap.yml 等) -> IntelliJ IDEA 经典 Spring 绿叶 🍃
  if (
    /^(?:application|bootstrap)(?:-[\w-]+)?\.(?:ya?ml|properties)$/i.test(name) ||
    lower === 'spring.factories'
  ) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <path
          d="M13.5 2.5C8 2 3.5 6 3 11c0 1.5.8 2.5 2 2.5 5 0 8.5-4.5 8.5-11z"
          fill="#6db33f"
        />
        <path
          d="M4 12c2.5-3 5-5.5 8-8M6.5 9c1.5-1 3-1.8 4.5-2.2M9 11.5c1-.8 2-1.5 2.8-2"
          stroke="#ffffff"
          strokeWidth="0.85"
          strokeLinecap="round"
        />
      </svg>
    );
  }

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

  // C/C++ CMake files
  if (lower === 'cmakelists.txt' || lower.endsWith('.cmake')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <polygon points="2,14 8,2 14,14" stroke="#06b6d4" strokeWidth="1.2" fill="rgba(6, 182, 212, 0.15)" />
        <line x1="4.5" y1="9" x2="11.5" y2="9" stroke="#f43f5e" strokeWidth="1.1" />
      </svg>
    );
  }

  // Maven pom.xml
  if (lower === 'pom.xml' || lower.startsWith('pom.') && lower.endsWith('.xml')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <path
          d="M8 2c2.5 3 2.5 8 0 12M5 5c2 2 2 6 0 8M11 5c-2 2-2 6 0 8"
          stroke="#f97316"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
        <text
          x="8"
          y="11"
          textAnchor="middle"
          fill="#f97316"
          fontSize="5"
          fontWeight="900"
          fontFamily="sans-serif"
        >
          MVN
        </text>
      </svg>
    );
  }

  // Gradle files
  if (lower.startsWith('build.gradle') || lower.startsWith('settings.gradle') || lower === 'gradle.properties') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <circle cx="8" cy="8" r="6" stroke="#0284c7" strokeWidth="1.1" />
        <path d="M5.5 8.5l2 2 3.5-4" stroke="#0284c7" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // Rust Cargo
  if (lower === 'cargo.toml' || lower === 'cargo.lock') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <polygon
          points="8,2 13.5,5.2 13.5,11.5 8,14.7 2.5,11.5 2.5,5.2"
          stroke="#ea580c"
          strokeWidth="1.1"
          fill="rgba(234, 88, 12, 0.12)"
        />
        <circle cx="8" cy="8.4" r="2.2" stroke="#ea580c" strokeWidth="1" />
      </svg>
    );
  }

  // Go module & sum
  if (lower === 'go.mod' || lower === 'go.sum' || lower === 'go.work') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" stroke="#00add8" strokeWidth="1.1" />
        <text
          x="8"
          y="10.2"
          textAnchor="middle"
          fill="#00add8"
          fontSize="6.5"
          fontWeight="900"
          fontFamily="sans-serif"
        >
          MOD
        </text>
      </svg>
    );
  }

  // Python dependencies & project files
  if (
    lower === 'requirements.txt' ||
    lower === 'pipfile' ||
    lower === 'pyproject.toml' ||
    lower === 'setup.py' ||
    lower === 'setup.cfg'
  ) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <path
          d="M7.8 2.2C5.8 2.2 6 3 6 3l.01 1h2v.3H5.2S3.8 4.2 3.8 6.2c0 2 1.3 1.9 1.3 1.9h.8V7s-.1-1.1 1.1-1.1h2s1.1 0 1.1-1.1V3.2S9.9 2.2 7.8 2.2z"
          fill="#388bfd"
        />
        <path
          d="M8.2 13.8c2 0 1.8-.8 1.8-.8l-.01-1h-2v-.3h2.8s1.4.1 1.4-1.9c0-2-1.3-1.9-1.3-1.9h-.8v1.1s.1 1.1-1.1 1.1h-2s-1.1 0-1.1 1.1v1.6s-.1 1.1 2.3 1.1z"
          fill="#eab308"
        />
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
    if (resolvedType === 'interface') {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <circle cx="8" cy="8" r="6.2" fill="#00add8" />
          <text x="8" y="11.2" textAnchor="middle" fill="#ffffff" fontSize="9" fontWeight="900" fontFamily="sans-serif">I</text>
        </svg>
      );
    }
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
    if (resolvedType === 'config' || lower === 'mod.rs') {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <circle cx="8" cy="8" r="5.5" stroke="#dea584" strokeWidth="1.2" />
          <path d="M5.5 8h5M8 5.5v5" stroke="#dea584" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    }
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

  // Java (.java) -> 深度适配 IntelliJ IDEA 官方规范：
  // Class (C) -> 经典天蓝 (#3592C4) 圆形与加粗白色 C
  // Interface (I) -> 经典草绿 (#59A869) 圆形与加粗白色 I
  // Enum (E) -> 经典橙色 (#E08930) 圆形与加粗白色 E
  // Annotation (@) -> 经典紫色 (#9973B5) 圆形与加粗白色 @
  // Record (R) -> 经典赭石橙 (#D4772A) 圆形与加粗白色 R
  // Abstract (C) -> 细线天蓝描边与半透明底色，斜体天蓝 C
  // Exception (!) -> 告警红色 (#E55757) 圆形与白色感叹号 !
  // Test (C) -> 天蓝圆底白 C 附带右下角绿色测试运行三角徽标
  if (lower.endsWith('.java')) {
    if (resolvedType === 'interface') {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <circle cx="8" cy="8" r="6.2" fill="#59A869" />
          <text x="8" y="11.2" textAnchor="middle" fill="#ffffff" fontSize="9.2" fontWeight="900" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">I</text>
        </svg>
      );
    }
    if (resolvedType === 'enum') {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <circle cx="8" cy="8" r="6.2" fill="#E08930" />
          <text x="8" y="11.2" textAnchor="middle" fill="#ffffff" fontSize="9.2" fontWeight="900" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">E</text>
        </svg>
      );
    }
    if (resolvedType === 'annotation') {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <circle cx="8" cy="8" r="6.2" fill="#9973B5" />
          <text x="8" y="11.2" textAnchor="middle" fill="#ffffff" fontSize="9.2" fontWeight="900" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">@</text>
        </svg>
      );
    }
    if (resolvedType === 'record') {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <circle cx="8" cy="8" r="6.2" fill="#D4772A" />
          <text x="8" y="11.2" textAnchor="middle" fill="#ffffff" fontSize="9.2" fontWeight="900" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">R</text>
        </svg>
      );
    }
    if (resolvedType === 'abstract') {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <circle cx="8" cy="8" r="5.6" stroke="#3592C4" strokeWidth="1.3" fill="rgba(53, 146, 196, 0.12)" />
          <text x="8" y="11.2" textAnchor="middle" fill="#3592C4" fontSize="9.2" fontWeight="900" fontStyle="italic" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">C</text>
        </svg>
      );
    }
    if (resolvedType === 'exception') {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <circle cx="8" cy="8" r="6.2" fill="#E55757" />
          <text x="8" y="11.5" textAnchor="middle" fill="#ffffff" fontSize="9.5" fontWeight="900" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">!</text>
        </svg>
      );
    }
    if (resolvedType === 'test') {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <circle cx="8" cy="8" r="6.2" fill="#3592C4" />
          <text x="7" y="11.2" textAnchor="middle" fill="#ffffff" fontSize="8.5" fontWeight="900" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">C</text>
          {/* IntelliJ 测试运行绿标 */}
          <circle cx="12" cy="12" r="3.2" fill="#59A869" />
          <polygon points="10.8,10.7 13.6,12 10.8,13.3" fill="#ffffff" />
        </svg>
      );
    }
    // 默认 Class (C) - IntelliJ IDEA 天蓝加粗 C
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <circle cx="8" cy="8" r="6.2" fill="#3592C4" />
        <text x="8" y="11.2" textAnchor="middle" fill="#ffffff" fontSize="9.2" fontWeight="900" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">C</text>
      </svg>
    );
  }

  // Kotlin (.kt, .kts) -> 对齐 IntelliJ IDEA 规范
  if (lower.endsWith('.kt') || lower.endsWith('.kts')) {
    if (lower.endsWith('.kts')) {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <rect x="2" y="2" width="12" height="12" rx="2.5" fill="#7f52ff" />
          <path d="M4.5 4.5v7M11.5 4.5L7.5 8.5l4 3" stroke="#ffffff" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    }
    if (resolvedType === 'interface') {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <circle cx="8" cy="8" r="6.2" fill="#59A869" />
          <text x="8" y="11.2" textAnchor="middle" fill="#ffffff" fontSize="9.2" fontWeight="900" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">I</text>
        </svg>
      );
    }
    if (resolvedType === 'enum') {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <circle cx="8" cy="8" r="6.2" fill="#E08930" />
          <text x="8" y="11.2" textAnchor="middle" fill="#ffffff" fontSize="9.2" fontWeight="900" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">E</text>
        </svg>
      );
    }
    if (resolvedType === 'test') {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <circle cx="8" cy="8" r="6.2" fill="#3592C4" />
          <text x="7" y="11.2" textAnchor="middle" fill="#ffffff" fontSize="8.5" fontWeight="900" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">K</text>
          <circle cx="12" cy="12" r="3.2" fill="#59A869" />
          <polygon points="10.8,10.7 13.6,12 10.8,13.3" fill="#ffffff" />
        </svg>
      );
    }
    // Kotlin Class (K)
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <circle cx="8" cy="8" r="6.2" fill="#3592C4" />
        <text x="8" y="11.2" textAnchor="middle" fill="#ffffff" fontSize="9.2" fontWeight="900" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">K</text>
      </svg>
    );
  }

  // Scala (.scala) -> 对齐 IntelliJ IDEA 规范
  if (lower.endsWith('.scala')) {
    if (resolvedType === 'interface') {
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
          <circle cx="8" cy="8" r="6.2" fill="#59A869" />
          <text x="8" y="11.2" textAnchor="middle" fill="#ffffff" fontSize="9.2" fontWeight="900" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">T</text>
        </svg>
      );
    }
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <circle cx="8" cy="8" r="6.2" fill="#3592C4" />
        <text x="8" y="11.2" textAnchor="middle" fill="#ffffff" fontSize="9.2" fontWeight="900" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">S</text>
      </svg>
    );
  }

  // C / C++ Source (.c, .cpp, .cc, .cxx)
  if (lower.endsWith('.c') || lower.endsWith('.cpp') || lower.endsWith('.cc') || lower.endsWith('.cxx')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <text
          x="8"
          y="11.4"
          textAnchor="middle"
          fill="#06b6d4"
          fontSize="7.5"
          fontWeight="800"
          fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        >
          {lower.endsWith('.c') ? 'C' : 'C++'}
        </text>
      </svg>
    );
  }

  // C / C++ Header (.h, .hpp, .hxx, .inl)
  if (lower.endsWith('.h') || lower.endsWith('.hpp') || lower.endsWith('.hxx') || lower.endsWith('.inl')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <text
          x="8"
          y="11.4"
          textAnchor="middle"
          fill="#a855f7"
          fontSize="7.5"
          fontWeight="800"
          fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        >
          {lower.endsWith('.h') ? 'H' : 'H++'}
        </text>
      </svg>
    );
  }

  // XML (.xml)
  if (lower.endsWith('.xml')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <text
          x="8"
          y="11.2"
          textAnchor="middle"
          fill="#ea580c"
          fontSize="6.8"
          fontWeight="800"
          letterSpacing="-0.2px"
          fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        >
          XML
        </text>
      </svg>
    );
  }

  // TOML (.toml)
  if (lower.endsWith('.toml')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <text
          x="8"
          y="11.2"
          textAnchor="middle"
          fill="#b45309"
          fontSize="6"
          fontWeight="800"
          letterSpacing="-0.2px"
          fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        >
          TOML
        </text>
      </svg>
    );
  }

  // Properties (.properties)
  if (lower.endsWith('.properties') || lower.includes('.properties.')) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle} fill="none">
        <line x1="3" y1="5" x2="13" y2="5" stroke="#10b981" strokeWidth="1.2" strokeLinecap="round" />
        <circle cx="6" cy="5" r="1.8" fill="#10b981" />
        <line x1="3" y1="11" x2="13" y2="11" stroke="#10b981" strokeWidth="1.2" strokeLinecap="round" />
        <circle cx="10" cy="11" r="1.8" fill="#10b981" />
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
  codeType,
  contentSnippet,
}: IconProps): React.ReactElement {
  if (isDirectory) {
    return renderFolderIcon(name, isOpen);
  }
  return renderFileIcon(name, codeType, contentSnippet);
}
