import fs from 'node:fs';
import path from 'node:path';

/**
 * 深入检测工作区实际技术栈（通过检查真实工程配置文件与特征目录）
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

    // 2. Node / TypeScript / 前端工程 (package.json)
    if (fileNames.has('package.json')) {
      return 'Node';
    }

    // 3. Python (requirements.txt, pyproject.toml, etc.)
    if (
      fileNames.has('requirements.txt') ||
      fileNames.has('pyproject.toml') ||
      fileNames.has('setup.py') ||
      fileNames.has('pipfile') ||
      fileNames.has('environment.yml')
    ) {
      return 'Python';
    }

    // 4. Go (go.mod, go.sum)
    if (fileNames.has('go.mod') || fileNames.has('go.sum')) {
      return 'Go';
    }

    // 5. Rust (Cargo.toml)
    if (fileNames.has('cargo.toml')) {
      return 'Rust';
    }

    // 6. C / C++ (CMakeLists.txt, Makefile, compile_commands.json)
    if (
      fileNames.has('cmakelists.txt') ||
      fileNames.has('makefile') ||
      fileNames.has('compile_commands.json')
    ) {
      return 'C++';
    }

    // 针对多模块/子模块工程（例如 server/package.json, backend/pom.xml, miniprogram/ 等）向下一层检查
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        entry.name !== 'node_modules' &&
        entry.name !== 'dist' &&
        entry.name !== 'build' &&
        entry.name !== 'target' &&
        entry.name !== 'out'
      ) {
        const subDir = path.join(rootPath, entry.name);
        try {
          const subEntries = fs.readdirSync(subDir);
          const subFiles = new Set(subEntries.map((f) => f.toLowerCase()));
          if (subFiles.has('pom.xml') || subFiles.has('build.gradle')) return 'Java';
          if (subFiles.has('package.json')) return 'Node';
          if (subFiles.has('requirements.txt') || subFiles.has('pyproject.toml')) return 'Python';
          if (subFiles.has('go.mod')) return 'Go';
          if (subFiles.has('cargo.toml')) return 'Rust';
          if (subFiles.has('cmakelists.txt')) return 'C++';
        } catch {
          // 忽略单个子目录读取错误
        }
      }
    }

    // 7. 包含 .git 仓库但未检测出具体语言
    if (fileNames.has('.git')) {
      return 'Git';
    }
  } catch {
    // 异常安全静默返回空
  }
  return '';
}
