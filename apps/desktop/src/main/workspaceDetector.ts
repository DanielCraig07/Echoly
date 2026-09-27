import fs from 'node:fs';
import path from 'node:path';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'target',
  'out',
  'bin',
  'obj',
  'vendor',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.idea',
  '.vscode',
  '.next',
  '.nuxt',
  '.cache',
]);

/**
 * 深入检测工作区实际技术栈（通过检查真实工程配置文件、特征目录及源码扩展名）
 */
export function detectWorkspaceTechFromDisk(rootPath: string): string {
  if (!rootPath) return '';
  try {
    if (!fs.existsSync(rootPath)) return '';
    const stat = fs.statSync(rootPath);
    if (!stat.isDirectory()) return '';

    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    const fileNames = new Set(entries.map((e) => e.name.toLowerCase()));

    // 1. Java / Maven / Gradle
    if (
      fileNames.has('pom.xml') ||
      fileNames.has('build.gradle') ||
      fileNames.has('build.gradle.kts') ||
      fileNames.has('mvnw') ||
      fileNames.has('.mvn') ||
      fileNames.has('gradlew')
    ) {
      return 'Java';
    }

    // 2. Node / TypeScript / 前端工程 (package.json / tsconfig / vite / etc.)
    if (
      fileNames.has('package.json') ||
      fileNames.has('tsconfig.json') ||
      fileNames.has('jsconfig.json') ||
      fileNames.has('vite.config.ts') ||
      fileNames.has('vite.config.js') ||
      fileNames.has('webpack.config.js') ||
      fileNames.has('next.config.js') ||
      fileNames.has('next.config.mjs')
    ) {
      return 'Node';
    }

    // 3. Python (requirements.txt, pyproject.toml, etc.)
    if (
      fileNames.has('requirements.txt') ||
      fileNames.has('pyproject.toml') ||
      fileNames.has('setup.py') ||
      fileNames.has('pipfile') ||
      fileNames.has('environment.yml') ||
      fileNames.has('poetry.lock')
    ) {
      return 'Python';
    }

    // 4. Go (go.mod, go.sum)
    if (fileNames.has('go.mod') || fileNames.has('go.sum')) {
      return 'Go';
    }

    // 5. Rust (Cargo.toml)
    if (fileNames.has('cargo.toml') || fileNames.has('cargo.lock')) {
      return 'Rust';
    }

    // 6. C / C++ (CMakeLists.txt, Makefile, compile_commands.json)
    if (
      fileNames.has('cmakelists.txt') ||
      fileNames.has('makefile') ||
      fileNames.has('compile_commands.json') ||
      fileNames.has('meson.build')
    ) {
      return 'C++';
    }

    // 针对多模块/子模块工程（例如 server/package.json, backend/pom.xml 等）向下一层检查
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        !IGNORED_DIRS.has(entry.name.toLowerCase())
      ) {
        const subDir = path.join(rootPath, entry.name);
        try {
          const subEntries = fs.readdirSync(subDir);
          const subFiles = new Set(subEntries.map((f) => f.toLowerCase()));
          if (subFiles.has('pom.xml') || subFiles.has('build.gradle')) return 'Java';
          if (subFiles.has('package.json') || subFiles.has('tsconfig.json')) return 'Node';
          if (subFiles.has('requirements.txt') || subFiles.has('pyproject.toml')) return 'Python';
          if (subFiles.has('go.mod')) return 'Go';
          if (subFiles.has('cargo.toml')) return 'Rust';
          if (subFiles.has('cmakelists.txt')) return 'C++';
        } catch {
          // 忽略单个子目录读取错误
        }
      }
    }

    // 7. 扫描目录下的源文件扩展名特征（向下遍历最多 2 层，统计主流语言文件数）
    const extCounts: Record<string, number> = {
      Java: 0,
      Node: 0,
      Python: 0,
      'C++': 0,
      Go: 0,
      Rust: 0,
    };

    const countExtensions = (dir: string, depth: number) => {
      if (depth > 2) return;
      try {
        const subList = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of subList) {
          if (item.isDirectory()) {
            if (!item.name.startsWith('.') && !IGNORED_DIRS.has(item.name.toLowerCase())) {
              countExtensions(path.join(dir, item.name), depth + 1);
            }
          } else if (item.isFile()) {
            const ext = path.extname(item.name).toLowerCase();
            if (ext === '.java' || ext === '.kt') extCounts.Java++;
            else if (
              ext === '.ts' ||
              ext === '.tsx' ||
              ext === '.js' ||
              ext === '.jsx' ||
              ext === '.vue' ||
              ext === '.html'
            )
              extCounts.Node++;
            else if (ext === '.py' || ext === '.ipynb') extCounts.Python++;
            else if (
              ext === '.cpp' ||
              ext === '.c' ||
              ext === '.cc' ||
              ext === '.cxx' ||
              ext === '.h' ||
              ext === '.hpp'
            )
              extCounts['C++']++;
            else if (ext === '.go') extCounts.Go++;
            else if (ext === '.rs') extCounts.Rust++;
          }
        }
      } catch {
        // ignore
      }
    };

    countExtensions(rootPath, 0);

    let maxLang = '';
    let maxCount = 0;
    for (const [lang, count] of Object.entries(extCounts)) {
      if (count > maxCount) {
        maxCount = count;
        maxLang = lang;
      }
    }
    if (maxCount > 0) {
      return maxLang;
    }

    // 8. 普通文件夹或未识别特定语言，杜绝误识别为 'Git'
    return '通用';
  } catch {
    // 异常安全静默返回通用
  }
  return '通用';
}
