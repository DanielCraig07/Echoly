import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { loadEnvConfig } from './EnvironmentSettingsSection';
import {
  ProjectRuntimeConfigModal,
  loadProjectRuntimeConfig,
  type ProjectRuntimeConfig,
} from './ProjectRuntimeConfigModal';
import { resolveDebugConfig } from '../utils/debugLauncher';

interface Props {
  workspace: string | null;
  activePath?: string | null;
  onRunCommand: (
    command: string,
    cwd?: string,
    terminalType?: string,
    terminalTitle?: string,
  ) => void;
  onStopCommand?: () => void;
  isBottomExpanded: boolean;
  onExpandBottom: (targetTab?: 'terminal' | 'debug') => void;
  onSelectBottomTab?: (tab: 'terminal' | 'debug') => void;
  onShowToast?: (title: string, detail?: string, type?: 'success' | 'error' | 'info' | 'warn') => void;
}

export interface ScriptOption {
  id: string;
  name: string;
  command: string;
  source:
    | 'file'
    | 'npm'
    | 'pnpm'
    | 'yarn'
    | 'bun'
    | 'python'
    | 'java'
    | 'bash'
    | 'docker'
    | 'go'
    | 'cargo'
    | 'makefile'
    | 'cmake'
    | 'cpp'
    | 'c'
    | 'custom'
    | 'generic';
  badge: string;
  badgeBg: string;
  badgeColor: string;
  group: 'current' | 'project' | 'custom';
  description?: string;
}

interface CustomConfig {
  id: string;
  name: string;
  command: string;
}

/** 尝试从文件系统多语言检测项目运行配置 (包括 Java, C/C++, CMake, Python, Go, Node, Rust, Docker, Make 等) */
export async function detectProjectScripts(
  workspace: string,
  activePath?: string | null,
  runtimeCfg?: ProjectRuntimeConfig,
): Promise<ScriptOption[]> {
  const tryRead = async (p: string): Promise<string | null> => {
    try {
      const exists = await window.ide.pathExists(p);
      if (!exists) return null;
      const content = await window.ide.readFile(p);
      return content || null;
    } catch {
      return null;
    }
  };

  const exists = async (p: string): Promise<boolean> => {
    try {
      return await window.ide.pathExists(p);
    } catch {
      return false;
    }
  };

  // 获取根目录文件列表
  let rootFiles: string[] = [];
  try {
    const nodes = await window.ide.listDir('.');
    if (Array.isArray(nodes)) {
      rootFiles = nodes.map((n) => n.name);
    }
  } catch {
    /* ignore */
  }

  const results: ScriptOption[] = [];

  // ── 1. 动态检测当前激活文件 (Active File) ──────────────────────────
  if (activePath) {
    let relPath = activePath;
    if (workspace && relPath.startsWith(workspace)) {
      relPath = relPath.slice(workspace.length).replace(/^[/\\]+/, '');
    }
    const fileName = relPath.split('/').pop() || relPath;
    const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';

    if (ext === 'py') {
      results.push({
        id: `active:${relPath}`,
        name: fileName,
        command: `python3 "${relPath}"`,
        source: 'python',
        badge: 'Py',
        badgeBg: 'rgba(56, 189, 248, 0.15)',
        badgeColor: '#38bdf8',
        group: 'current',
        description: '运行当前 Python 文件',
      });
    } else if (ext === 'sh' || ext === 'bash' || ext === 'zsh') {
      results.push({
        id: `active:${relPath}`,
        name: fileName,
        command: `bash "${relPath}"`,
        source: 'bash',
        badge: 'Bash',
        badgeBg: 'rgba(74, 222, 128, 0.15)',
        badgeColor: '#4ade80',
        group: 'current',
        description: '执行当前 Shell 脚本',
      });
    } else if (ext === 'ts') {
      results.push({
        id: `active:${relPath}`,
        name: fileName,
        command: `npx tsx "${relPath}"`,
        source: 'npm',
        badge: 'TS',
        badgeBg: 'rgba(59, 130, 246, 0.15)',
        badgeColor: '#60a5fa',
        group: 'current',
        description: 'tsx 运行当前 TypeScript 文件',
      });
    } else if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
      results.push({
        id: `active:${relPath}`,
        name: fileName,
        command: `node "${relPath}"`,
        source: 'npm',
        badge: 'Node',
        badgeBg: 'rgba(167, 139, 250, 0.15)',
        badgeColor: '#c084fc',
        group: 'current',
        description: 'Node 运行当前脚本',
      });
    } else if (ext === 'java') {
      // 1. 读取 Java 文件内容，提取 package 与 类名
      const javaCode = await tryRead(relPath);
      let pkg = '';
      if (javaCode) {
        const pkgMatch = javaCode.match(/package\s+([a-zA-Z0-9_.]+)\s*;/);
        if (pkgMatch) {
          pkg = pkgMatch[1].trim();
        }
      }
      const rawClassName = fileName.replace(/\.java$/i, '');
      const fullClassName = pkg ? `${pkg}.${rawClassName}` : rawClassName;

      // 2. 检测是否属于 Maven 项目 (根目录有 pom.xml 或 mvnw)
      const hasPom = rootFiles.includes('pom.xml') || (await exists('pom.xml'));
      const hasMvnw =
        rootFiles.includes('mvnw') ||
        rootFiles.includes('mvnw.cmd') ||
        (await exists('mvnw')) ||
        (await exists('mvnw.cmd'));

      // 3. 构建高可用运行命令并接入项目全局运行时参数 (VM Options / 环境变量 / 程序参数)
      const isWin = typeof navigator !== 'undefined' && /win/i.test(navigator.platform);
      let javaPrefix = '';
      let envCfg: any = null;
      try {
        envCfg = loadEnvConfig(workspace || undefined);
      } catch {}

      const rCfg = runtimeCfg || loadProjectRuntimeConfig(workspace);

      const envPrefix = rCfg.envVars.trim()
        ? (isWin ? `set "${rCfg.envVars.trim()}" && ` : `export ${rCfg.envVars.trim().replace(/,/g, ' ')} && `)
        : '';

      if (envCfg?.selectedJavaHome) {
        javaPrefix = isWin
          ? `set "JAVA_HOME=${envCfg.selectedJavaHome}" && `
          : `export JAVA_HOME="${envCfg.selectedJavaHome}" && `;
      }
      javaPrefix = `${envPrefix}${javaPrefix}`;

      const profileArg = rCfg.activeProfiles.trim() ? `-P${rCfg.activeProfiles.trim()} ` : '';
      const vmArgsPart = rCfg.vmArgs.trim() ? ` ${rCfg.vmArgs.trim()}` : '';
      const progArgsPart = rCfg.programArgs.trim() ? ` -Dexec.args="${rCfg.programArgs.trim()}"` : '';

      if (hasPom || hasMvnw) {
        let mvnExe = 'mvn';
        if (envCfg?.customMvnPath) {
          mvnExe = envCfg.customMvnPath;
        } else if (hasMvnw) {
          mvnExe = isWin ? 'mvnw.cmd' : './mvnw';
        }

        let settingsArg = '';
        if (envCfg?.customSettingsPath) {
          settingsArg = `-s "${envCfg.customSettingsPath}" `;
        } else if (rootFiles.includes('.mvn') || (await exists('.mvn/settings.xml'))) {
          settingsArg = `-s .mvn/settings.xml `;
        }

        // 4. 智能检测是否包含 main 入口方法或属于单测
        const isTestFile = /Test|TestCase/i.test(rawClassName) || /@Test/i.test(javaCode || '');
        const hasMainMethod =
          /public\s+static\s+void\s+main\s*\(/i.test(javaCode || '') ||
          /static\s+public\s+void\s+main\s*\(/i.test(javaCode || '') ||
          /@SpringBootApplication/i.test(javaCode || '');

        if (hasMainMethod) {
          // 仅在明确含有 main 入口方法或 @SpringBootApplication 时，执行 exec:java 并附带项目全局 VM 参数与程序参数
          // 融合图 3 高级运行选项：
          // - skipBuildBeforeRun: 运行前不执行编译，直接秒级启动已有 class
          // - addProvidedToClasspath: 将 "provided" 依赖添加到类路径 (-Dexec.classpathScope=compile)，杜绝 NoClassDefFoundError
          // - saveConsoleToFile: 控制台输出写入日志文件
          const compilePhase = rCfg.skipBuildBeforeRun ? '' : 'compile ';
          const providedScopeArg = rCfg.addProvidedToClasspath ? ' -Dexec.classpathScope=compile' : '';
          const logRedirect = rCfg.saveConsoleToFile ? ' | tee -a .echoly/logs/run.log' : '';
          const mvnRunCmd = `${javaPrefix}${mvnExe} ${settingsArg}${profileArg}${compilePhase}exec:java -Dexec.mainClass="${fullClassName}"${providedScopeArg}${vmArgsPart}${progArgsPart}${logRedirect}`.trim();
          results.push({
            id: `active:${relPath}`,
            name: `${rawClassName}`,
            command: mvnRunCmd,
            source: 'java',
            badge: 'Java',
            badgeBg: 'rgba(251, 146, 60, 0.15)',
            badgeColor: '#fb923c',
            group: 'current',
            description: `Maven 运行主类 ${fullClassName}${rCfg.vmArgs.trim() ? ` [VM: ${rCfg.vmArgs.trim()}]` : ''}`,
          });
        } else if (isTestFile) {
          // 若是测试文件，提供一键单测执行
          results.push({
            id: `active:test:${relPath}`,
            name: `测试: ${rawClassName}`,
            command: `${javaPrefix}${mvnExe} ${settingsArg}${profileArg}test -Dtest=${rawClassName}${vmArgsPart}`.trim(),
            source: 'java',
            badge: 'Maven',
            badgeBg: 'rgba(251, 146, 60, 0.15)',
            badgeColor: '#fb923c',
            group: 'current',
            description: `Maven 运行单测 ${rawClassName}`,
          });
        } else {
          // 该业务类/接口未包含 main 入口方法：提供项目编译验证，杜绝 NoSuchMethodException 报错
          results.push({
            id: `active:compile:${relPath}`,
            name: `编译项目`,
            command: `${javaPrefix}${mvnExe} ${settingsArg}${profileArg}compile`.trim(),
            source: 'java',
            badge: 'Maven',
            badgeBg: 'rgba(251, 146, 60, 0.15)',
            badgeColor: '#fb923c',
            group: 'current',
            description: `Maven 编译工程 (${rawClassName} 未包含 main 入口方法)`,
          });
        }
      } else {
        // 非 Maven 工程: 智能计算 classpath
        const hasMainMethod =
          /public\s+static\s+void\s+main\s*\(/i.test(javaCode || '') ||
          /static\s+public\s+void\s+main\s*\(/i.test(javaCode || '');

        const javaProgArgs = rCfg.programArgs.trim() ? ` ${rCfg.programArgs.trim()}` : '';
        let javaCmd = `${javaPrefix}java${vmArgsPart} "${relPath}"${javaProgArgs}`;
        if (hasMainMethod) {
          if (pkg && relPath.includes('src/main/java/')) {
            const srcRoot = relPath.substring(
              0,
              relPath.indexOf('src/main/java/') + 'src/main/java'.length,
            );
            javaCmd = `${javaPrefix}java${vmArgsPart} -cp "${srcRoot}" "${fullClassName}"${javaProgArgs}`;
          } else if (pkg && relPath.includes('src/')) {
            const srcRoot = relPath.substring(0, relPath.indexOf('src/') + 'src'.length);
            javaCmd = `${javaPrefix}java${vmArgsPart} -cp "${srcRoot}" "${fullClassName}"${javaProgArgs}`;
          }
        } else {
          javaCmd = `javac "${relPath}"`;
        }
        results.push({
          id: `active:${relPath}`,
          name: hasMainMethod ? rawClassName : `编译: ${rawClassName}`,
          command: javaCmd,
          source: 'java',
          badge: 'Java',
          badgeBg: 'rgba(251, 146, 60, 0.15)',
          badgeColor: '#fb923c',
          group: 'current',
          description: hasMainMethod
            ? `运行 Java 主类 ${fullClassName}${rCfg.vmArgs.trim() ? ` [VM: ${rCfg.vmArgs.trim()}]` : ''}`
            : `javac 编译 ${rawClassName} (未包含 main 方法)`,
        });
      }
    } else if (ext === 'go') {
      const isTest = fileName.endsWith('_test.go');
      const goCode = await tryRead(relPath);
      const hasMain = /\bfunc\s+main\s*\(/.test(goCode || '');
      const dirPath = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '.';

      if (isTest) {
        results.push({
          id: `active:test:${relPath}`,
          name: `测试: ${fileName.replace('_test.go', '')}`,
          command: `go test -v ./${dirPath}`,
          source: 'go',
          badge: 'Go Test',
          badgeBg: 'rgba(45, 212, 191, 0.15)',
          badgeColor: '#2dd4bf',
          group: 'current',
          description: `执行 Go 单元测试 (${fileName})`,
        });
      } else if (hasMain) {
        results.push({
          id: `active:${relPath}`,
          name: fileName,
          command: `go run "./${dirPath}"`,
          source: 'go',
          badge: 'Go',
          badgeBg: 'rgba(45, 212, 191, 0.15)',
          badgeColor: '#2dd4bf',
          group: 'current',
          description: `运行 Go 主程序 (包目录: ./${dirPath})`,
        });
      } else {
        results.push({
          id: `active:vet:${relPath}`,
          name: `检查: ${fileName}`,
          command: `go vet "./${dirPath}"`,
          source: 'go',
          badge: 'Go',
          badgeBg: 'rgba(45, 212, 191, 0.15)',
          badgeColor: '#2dd4bf',
          group: 'current',
          description: `Go 静态语法检查 (非 main 包文件)`,
        });
      }
    } else if (ext === 'cpp' || ext === 'cc' || ext === 'cxx' || ext === 'c' || ext === 'h' || ext === 'hpp') {
      const isCpp = ext !== 'c';
      const isHeader = ext === 'h' || ext === 'hpp';
      const baseName = fileName.replace(/\.[^.]+$/, '');
      const code = await tryRead(relPath);
      const isWin = typeof navigator !== 'undefined' && /win/i.test(navigator.platform);

      const rCfg = runtimeCfg || loadProjectRuntimeConfig(workspace);
      const envPrefix = rCfg.envVars.trim()
        ? (isWin ? `set "${rCfg.envVars.trim()}" && ` : `export ${rCfg.envVars.trim().replace(/,/g, ' ')} && `)
        : '';
      const progArgs = rCfg.programArgs.trim() ? ` ${rCfg.programArgs.trim()}` : '';

      const hasMain =
        /\b(?:int|auto)\s+main\s*\([^)]*\)/.test(code || '') ||
        /\bmain\s*\([^)]*\)\s*\{/.test(code || '');
      const isTest =
        /#include\s*<gtest\/gtest\.h>/i.test(code || '') ||
        /\bTEST(?:_F|_P)?\s*\(/i.test(code || '') ||
        /\bTEST_CASE\s*\(/i.test(code || '');

      const defaultCompiler = isWin
        ? (isCpp ? 'g++' : 'gcc')
        : (isCpp ? 'clang++' : 'clang');

      // 智能识别工程头文件路径 (include, inc 等)，自动附加包含目录，防止 'demo.h' file not found
      const incList: string[] = [];
      if (await exists('include')) incList.push('include');
      if (await exists('inc')) incList.push('inc');
      if (await exists('src') && relPath.startsWith('src/')) incList.push('src');
      const incFlags = incList.length > 0 ? incList.map((d) => `-I"${d}"`).join(' ') + ' ' : '';

      if (isHeader) {
        const headerMode = isCpp && !fileName.endsWith('.hpp') ? '-x c++-header ' : '';
        results.push({
          id: `active:check:${relPath}`,
          name: `语法检查: ${fileName}`,
          command: `${envPrefix}${defaultCompiler} -fsyntax-only ${headerMode}${incFlags}"${relPath}"`.trim(),
          source: isCpp ? 'cpp' : 'c',
          badge: isCpp ? 'C++' : 'C',
          badgeBg: 'rgba(59, 130, 246, 0.15)',
          badgeColor: '#60a5fa',
          group: 'current',
          description: `检查头文件 ${fileName} 语法有效性`,
        });
      } else if (isTest) {
        const binDir = isWin ? '.echoly\\bin' : '.echoly/bin';
        const binPath = isWin ? `${binDir}\\${baseName}_test.exe` : `${binDir}/${baseName}_test`;
        const mkdirCmd = isWin ? `if not exist "${binDir}" mkdir "${binDir}" && ` : `mkdir -p "${binDir}" && `;
        const testLibs = /gtest/i.test(code || '') ? ' -lgtest -lgtest_main -pthread' : '';
        const stdFlag = isCpp ? '-std=c++17 ' : '-std=c11 ';
        const compileCmd = `${mkdirCmd}${envPrefix}${defaultCompiler} ${stdFlag}${incFlags}-g "${relPath}" -o "${binPath}"${testLibs} && "${binPath}"${progArgs}`.trim();
        results.push({
          id: `active:test:${relPath}`,
          name: `测试: ${baseName}`,
          command: compileCmd,
          source: isCpp ? 'cpp' : 'c',
          badge: isCpp ? 'C++ Test' : 'C Test',
          badgeBg: 'rgba(59, 130, 246, 0.15)',
          badgeColor: '#60a5fa',
          group: 'current',
          description: `编译并执行单元测试 ${baseName}`,
        });
      } else if (hasMain) {
        const binDir = isWin ? '.echoly\\bin' : '.echoly/bin';
        const binPath = isWin ? `${binDir}\\${baseName}.exe` : `${binDir}/${baseName}`;
        const mkdirCmd = isWin ? `if not exist "${binDir}" mkdir "${binDir}" && ` : `mkdir -p "${binDir}" && `;
        const stdFlag = isCpp ? '-std=c++17 ' : '-std=c11 ';
        const compileCmd = `${mkdirCmd}${envPrefix}${defaultCompiler} ${stdFlag}${incFlags}-g "${relPath}" -o "${binPath}" && "${binPath}"${progArgs}`.trim();
        results.push({
          id: `active:${relPath}`,
          name: baseName,
          command: compileCmd,
          source: isCpp ? 'cpp' : 'c',
          badge: isCpp ? 'C++' : 'C',
          badgeBg: 'rgba(59, 130, 246, 0.15)',
          badgeColor: '#60a5fa',
          group: 'current',
          description: `编译并运行 ${fileName}`,
        });
      } else {
        const nullDev = isWin ? 'NUL' : '/dev/null';
        results.push({
          id: `active:compile:${relPath}`,
          name: `编译检查: ${baseName}`,
          command: `${envPrefix}${defaultCompiler} -c ${incFlags}"${relPath}" -o ${nullDev}`.trim(),
          source: isCpp ? 'cpp' : 'c',
          badge: isCpp ? 'C++' : 'C',
          badgeBg: 'rgba(59, 130, 246, 0.15)',
          badgeColor: '#60a5fa',
          group: 'current',
          description: `验证编译 ${fileName} (未检测到 main 函数)`,
        });
      }
    }
  }

  // ── 2. Python 项目检测 ───────────────────────────────────────────
  const hasManagePy = rootFiles.includes('manage.py') || (await exists('manage.py'));
  const pyproject = await tryRead('pyproject.toml');
  const pipfile = await tryRead('Pipfile');
  const requirements = rootFiles.includes('requirements.txt') || (await exists('requirements.txt'));

  if (hasManagePy) {
    results.push(
      {
        id: 'py:manage:runserver',
        name: 'runserver',
        command: 'python3 manage.py runserver',
        source: 'python',
        badge: 'Django',
        badgeBg: 'rgba(16, 185, 129, 0.15)',
        badgeColor: '#34d399',
        group: 'project',
        description: '启动 Django 开发服务',
      },
      {
        id: 'py:manage:test',
        name: 'test',
        command: 'python3 manage.py test',
        source: 'python',
        badge: 'Django',
        badgeBg: 'rgba(16, 185, 129, 0.15)',
        badgeColor: '#34d399',
        group: 'project',
        description: '运行 Django 单元测试',
      },
    );
  }

  if (pyproject) {
    // Poetry scripts
    const m = pyproject.match(/\[tool\.poetry\.scripts\]\s*([\s\S]*?)(?=^\[|\s*$)/m);
    if (m && m[1]) {
      for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^\s*([a-zA-Z0-9_.-]+)\s*=\s*"(.+)"\s*$/);
        if (kv) {
          results.push({
            id: `py:poetry:${kv[1]}`,
            name: kv[1],
            command: `poetry run ${kv[1]}`,
            source: 'python',
            badge: 'Poetry',
            badgeBg: 'rgba(56, 189, 248, 0.15)',
            badgeColor: '#38bdf8',
            group: 'project',
          });
        }
      }
    }
    if (/fastapi|uvicorn/i.test(pyproject)) {
      results.push({
        id: 'py:uvicorn',
        name: 'uvicorn (FastAPI)',
        command: 'uvicorn main:app --reload',
        source: 'python',
        badge: 'FastAPI',
        badgeBg: 'rgba(20, 184, 166, 0.15)',
        badgeColor: '#2dd4bf',
        group: 'project',
        description: '启动 FastAPI 热重载服务',
      });
    }
    if (/pytest/i.test(pyproject)) {
      results.push({
        id: 'py:pytest',
        name: 'pytest',
        command: 'pytest',
        source: 'python',
        badge: 'Py',
        badgeBg: 'rgba(56, 189, 248, 0.15)',
        badgeColor: '#38bdf8',
        group: 'project',
        description: '运行 pytest 单元测试',
      });
    }
  }

  if (pipfile) {
    results.push({
      id: 'py:pipenv:run',
      name: 'pipenv run',
      command: 'pipenv run python main.py',
      source: 'python',
      badge: 'Pipenv',
      badgeBg: 'rgba(56, 189, 248, 0.15)',
      badgeColor: '#38bdf8',
      group: 'project',
    });
  }

  // 检测常见根目录及 src 分层目录下的 Python 入口
  const candidatePy = ['src/main.py', 'src/app.py', 'main.py', 'app.py', 'run.py', 'server.py'];
  const pyEntries: string[] = [];
  for (const f of candidatePy) {
    if (rootFiles.includes(f) || (await exists(f))) {
      pyEntries.push(f);
    }
  }
  if (pyEntries.length === 0 && !hasManagePy && !pyproject && requirements) {
    // 有 requirements.txt 但暂未找到入口
    results.push(
      {
        id: 'py:main',
        name: 'python main.py',
        command: 'python3 main.py',
        source: 'python',
        badge: 'Py',
        badgeBg: 'rgba(56, 189, 248, 0.15)',
        badgeColor: '#38bdf8',
        group: 'project',
      },
      {
        id: 'py:pytest:req',
        name: 'pytest',
        command: 'pytest',
        source: 'python',
        badge: 'Py',
        badgeBg: 'rgba(56, 189, 248, 0.15)',
        badgeColor: '#38bdf8',
        group: 'project',
      },
    );
  } else {
    for (const f of pyEntries) {
      if (!results.some((r) => r.command.includes(f))) {
        results.push({
          id: `py:${f}`,
          name: f,
          command: `python3 ${f}`,
          source: 'python',
          badge: 'Py',
          badgeBg: 'rgba(56, 189, 248, 0.15)',
          badgeColor: '#38bdf8',
          group: 'project',
          description: `执行 Python 脚本 ${f}`,
        });
      }
    }
  }

  // ── 3. Java 项目检测 (Maven / Gradle) ───────────────────────────
  const pom = await tryRead('pom.xml');
  const hasGradlew = rootFiles.includes('gradlew') || (await exists('gradlew'));
  const hasBuildGradle =
    rootFiles.includes('build.gradle') ||
    rootFiles.includes('build.gradle.kts') ||
    (await exists('build.gradle')) ||
    (await exists('build.gradle.kts'));

  if (pom) {
    const isSpringBoot = /spring-boot-maven-plugin/i.test(pom) || /spring-boot/i.test(pom);
    if (isSpringBoot) {
      results.push({
        id: 'java:mvn:spring-boot',
        name: 'spring-boot:run',
        command: 'mvn spring-boot:run',
        source: 'java',
        badge: 'Spring',
        badgeBg: 'rgba(16, 185, 129, 0.15)',
        badgeColor: '#34d399',
        group: 'project',
        description: 'Spring Boot 本地启动',
      });
    }
    results.push(
      {
        id: 'java:mvn:test',
        name: 'mvn test',
        command: 'mvn test',
        source: 'java',
        badge: 'Maven',
        badgeBg: 'rgba(251, 146, 60, 0.15)',
        badgeColor: '#fb923c',
        group: 'project',
        description: '执行 Maven 单元测试',
      },
      {
        id: 'java:mvn:package',
        name: 'mvn package',
        command: 'mvn clean package -DskipTests',
        source: 'java',
        badge: 'Maven',
        badgeBg: 'rgba(251, 146, 60, 0.15)',
        badgeColor: '#fb923c',
        group: 'project',
        description: 'Maven 清理并打包',
      },
    );
  } else if (hasBuildGradle) {
    const gCmd = hasGradlew ? './gradlew' : 'gradle';
    results.push(
      {
        id: 'java:gradle:bootRun',
        name: 'bootRun',
        command: `${gCmd} bootRun`,
        source: 'java',
        badge: 'Gradle',
        badgeBg: 'rgba(2, 132, 199, 0.15)',
        badgeColor: '#38bdf8',
        group: 'project',
        description: 'Gradle 运行应用',
      },
      {
        id: 'java:gradle:test',
        name: 'test',
        command: `${gCmd} test`,
        source: 'java',
        badge: 'Gradle',
        badgeBg: 'rgba(2, 132, 199, 0.15)',
        badgeColor: '#38bdf8',
        group: 'project',
        description: 'Gradle 测试',
      },
      {
        id: 'java:gradle:build',
        name: 'build',
        command: `${gCmd} build`,
        source: 'java',
        badge: 'Gradle',
        badgeBg: 'rgba(2, 132, 199, 0.15)',
        badgeColor: '#38bdf8',
        group: 'project',
        description: 'Gradle 构建',
      },
    );
  }

  // ── 4. Bash / Shell 脚本检测 (*.sh) ──────────────────────────────
  const shFiles = rootFiles.filter((f) => f.endsWith('.sh'));
  // 如果根目录检测不到，检查常见脚本名
  if (shFiles.length === 0) {
    const commonSh = [
      'start.sh',
      'run.sh',
      'dev.sh',
      'build.sh',
      'deploy.sh',
      'test.sh',
      'setup.sh',
    ];
    for (const sh of commonSh) {
      if (await exists(sh)) shFiles.push(sh);
    }
  }
  for (const sh of shFiles) {
    results.push({
      id: `bash:${sh}`,
      name: sh,
      command: `bash ${sh}`,
      source: 'bash',
      badge: 'Bash',
      badgeBg: 'rgba(74, 222, 128, 0.15)',
      badgeColor: '#4ade80',
      group: 'project',
      description: `执行脚本 bash ${sh}`,
    });
  }

  // ── 5. TypeScript / Node.js (package.json / tsconfig.json) ────────
  const pkgStr = await tryRead('package.json');
  if (pkgStr) {
    try {
      const parsed = JSON.parse(pkgStr);
      // 判断包管理器
      let pm = 'npm';
      if (rootFiles.includes('pnpm-lock.yaml') || (await exists('pnpm-lock.yaml'))) pm = 'pnpm';
      else if (rootFiles.includes('yarn.lock') || (await exists('yarn.lock'))) pm = 'yarn';
      else if (
        rootFiles.includes('bun.lockb') ||
        rootFiles.includes('bun.lock') ||
        (await exists('bun.lockb'))
      )
        pm = 'bun';

      const isTs =
        Boolean(parsed.devDependencies?.typescript || parsed.dependencies?.typescript) ||
        rootFiles.includes('tsconfig.json') ||
        (await exists('tsconfig.json'));

      if (parsed.scripts && typeof parsed.scripts === 'object') {
        const keys = Object.keys(parsed.scripts);
        for (const key of keys) {
          const isTsKey = isTs && (key.includes('tsc') || key.includes('type') || key.includes('check'));
          results.push({
            id: `npm:${key}`,
            name: key,
            command: pm === 'npm' ? `npm run ${key}` : `${pm} run ${key}`,
            source: 'npm',
            badge: isTsKey ? 'TS' : pm,
            badgeBg: isTsKey ? 'rgba(59, 130, 246, 0.15)' : 'rgba(167, 139, 250, 0.15)',
            badgeColor: isTsKey ? '#60a5fa' : '#c084fc',
            group: 'project',
            description: parsed.scripts[key],
          });
        }
      }
    } catch {
      /* parse error */
    }
  }

  const hasTsConfig = rootFiles.includes('tsconfig.json') || (await exists('tsconfig.json'));
  if (hasTsConfig && !results.some((r) => r.command.includes('tsc --noEmit'))) {
    results.push({
      id: 'ts:check',
      name: 'tsc:check',
      command: 'npx tsc --noEmit',
      source: 'npm',
      badge: 'TS',
      badgeBg: 'rgba(59, 130, 246, 0.15)',
      badgeColor: '#60a5fa',
      group: 'project',
      description: 'TypeScript 类型静态检查',
    });
  }

  // ── 6. Docker 检测 ────────────────────────────────────────────────
  const hasDockerCompose =
    rootFiles.includes('docker-compose.yml') ||
    rootFiles.includes('docker-compose.yaml') ||
    rootFiles.includes('compose.yaml') ||
    (await exists('docker-compose.yml')) ||
    (await exists('compose.yaml'));
  const hasDockerfile = rootFiles.includes('Dockerfile') || (await exists('Dockerfile'));

  if (hasDockerCompose) {
    results.push(
      {
        id: 'docker:compose:up',
        name: 'compose up',
        command: 'docker compose up',
        source: 'docker',
        badge: 'Docker',
        badgeBg: 'rgba(56, 189, 248, 0.15)',
        badgeColor: '#38bdf8',
        group: 'project',
        description: '前台启动容器服务',
      },
      {
        id: 'docker:compose:up-d',
        name: 'compose up -d',
        command: 'docker compose up -d',
        source: 'docker',
        badge: 'Docker',
        badgeBg: 'rgba(56, 189, 248, 0.15)',
        badgeColor: '#38bdf8',
        group: 'project',
        description: '后台静默启动容器服务',
      },
      {
        id: 'docker:compose:down',
        name: 'compose down',
        command: 'docker compose down',
        source: 'docker',
        badge: 'Docker',
        badgeBg: 'rgba(56, 189, 248, 0.15)',
        badgeColor: '#38bdf8',
        group: 'project',
        description: '停止并移除容器',
      },
    );
  } else if (hasDockerfile) {
    results.push({
      id: 'docker:build',
      name: 'docker build',
      command: 'docker build -t app .',
      source: 'docker',
      badge: 'Docker',
      badgeBg: 'rgba(56, 189, 248, 0.15)',
      badgeColor: '#38bdf8',
      group: 'project',
      description: '构建 Docker 镜像',
    });
  }

  // ── 7. Go 项目检测 ───────────────────────────────────────────────
  const hasGoMod = rootFiles.includes('go.mod') || (await exists('go.mod'));
  if (hasGoMod) {
    let goRunCmd = 'go run .';
    let goRunName = 'go run .';
    if (await exists('cmd/app/main.go') || (await exists('cmd/app'))) {
      goRunCmd = 'go run ./cmd/app';
      goRunName = 'go run ./cmd/app';
    } else if (await exists('cmd/server/main.go') || (await exists('cmd/server'))) {
      goRunCmd = 'go run ./cmd/server';
      goRunName = 'go run ./cmd/server';
    } else if (rootFiles.includes('main.go') || (await exists('main.go'))) {
      goRunCmd = 'go run .';
      goRunName = 'go run .';
    }

    results.push(
      {
        id: 'go:run',
        name: goRunName,
        command: goRunCmd,
        source: 'go',
        badge: 'Go',
        badgeBg: 'rgba(45, 212, 191, 0.15)',
        badgeColor: '#2dd4bf',
        group: 'project',
        description: `执行 Go 主程序 (${goRunCmd})`,
      },
      {
        id: 'go:test',
        name: 'go test',
        command: 'go test ./...',
        source: 'go',
        badge: 'Go',
        badgeBg: 'rgba(45, 212, 191, 0.15)',
        badgeColor: '#2dd4bf',
        group: 'project',
      },
      {
        id: 'go:build',
        name: 'go build',
        command: 'go build ./...',
        source: 'go',
        badge: 'Go',
        badgeBg: 'rgba(45, 212, 191, 0.15)',
        badgeColor: '#2dd4bf',
        group: 'project',
      },
    );
  }

  // ── 8. Rust 项目检测 ─────────────────────────────────────────────
  const cargo = await tryRead('Cargo.toml');
  if (cargo) {
    results.push(
      {
        id: 'cargo:run',
        name: 'cargo run',
        command: 'cargo run',
        source: 'cargo',
        badge: 'Rust',
        badgeBg: 'rgba(249, 115, 22, 0.15)',
        badgeColor: '#f97316',
        group: 'project',
      },
      {
        id: 'cargo:test',
        name: 'cargo test',
        command: 'cargo test',
        source: 'cargo',
        badge: 'Rust',
        badgeBg: 'rgba(249, 115, 22, 0.15)',
        badgeColor: '#f97316',
        group: 'project',
      },
      {
        id: 'cargo:build',
        name: 'cargo build',
        command: 'cargo build',
        source: 'cargo',
        badge: 'Rust',
        badgeBg: 'rgba(249, 115, 22, 0.15)',
        badgeColor: '#f97316',
        group: 'project',
      },
    );
  }

  // ── 8.5. CMake 项目检测 (CMakeLists.txt) ─────────────────────────
  const cmakeLists = await tryRead('CMakeLists.txt');
  if (cmakeLists) {
    const projMatch = cmakeLists.match(/project\s*\(\s*([a-zA-Z0-9_.-]+)/i);
    const projName = projMatch ? projMatch[1] : 'Project';

    // 提取 add_executable 目标
    const targetMatches = [...cmakeLists.matchAll(/add_executable\s*\(\s*([a-zA-Z0-9_.-]+)/gi)];
    const targets = targetMatches.map((m) => m[1]).filter(Boolean);

    // 0. 生成配置并导出编译数据库 (CMake: Configure)
    results.push({
      id: 'cmake:configure',
      name: 'CMake: Configure',
      command: 'cmake -B build -DCMAKE_BUILD_TYPE=Debug -DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
      source: 'cmake',
      badge: 'CMake',
      badgeBg: 'rgba(6, 182, 212, 0.15)',
      badgeColor: '#06b6d4',
      group: 'project',
      description: `生成构建配置并导出 compile_commands.json (${projName})`,
    });

    // 1. 全量配置并编译 (CMake: Build All)
    results.push({
      id: 'cmake:build',
      name: 'CMake: Build All',
      command: 'cmake -B build -DCMAKE_BUILD_TYPE=Debug -DCMAKE_EXPORT_COMPILE_COMMANDS=ON && cmake --build build -j',
      source: 'cmake',
      badge: 'CMake',
      badgeBg: 'rgba(6, 182, 212, 0.15)',
      badgeColor: '#06b6d4',
      group: 'project',
      description: `生成构建配置并全量编译 ${projName}`,
    });

    // 2. 为每个 executable 目标生成独立运行项
    const isWin = typeof navigator !== 'undefined' && /win/i.test(navigator.platform);
    for (const tgt of targets) {
      const runCmd = isWin
        ? `cmake --build build --target ${tgt} && (if exist "build\\Debug\\${tgt}.exe" (build\\Debug\\${tgt}.exe) else (build\\${tgt}.exe))`
        : `cmake --build build --target ${tgt} && (./build/${tgt} || ./build/bin/${tgt} || ./build/Debug/${tgt})`;
      results.push({
        id: `cmake:run:${tgt}`,
        name: `${tgt}`,
        command: runCmd,
        source: 'cmake',
        badge: 'CMake',
        badgeBg: 'rgba(6, 182, 212, 0.15)',
        badgeColor: '#06b6d4',
        group: 'project',
        description: `构建并运行目标 ${tgt}`,
      });
    }

    // 3. 测试支持 (若包含 enable_testing 或 add_test)
    if (/enable_testing|add_test/i.test(cmakeLists)) {
      results.push({
        id: 'cmake:test',
        name: 'CMake: Test (CTest)',
        command: 'ctest --test-dir build --output-on-failure',
        source: 'cmake',
        badge: 'CTest',
        badgeBg: 'rgba(6, 182, 212, 0.15)',
        badgeColor: '#06b6d4',
        group: 'project',
        description: '执行 CTest 单元测试集',
      });
    }

    // 4. 清理目标 (CMake: Clean)
    results.push({
      id: 'cmake:clean',
      name: 'CMake: Clean',
      command: 'cmake --build build --target clean',
      source: 'cmake',
      badge: 'CMake',
      badgeBg: 'rgba(6, 182, 212, 0.15)',
      badgeColor: '#06b6d4',
      group: 'project',
      description: '清理 CMake 编译缓存产物',
    });
  }

  // ── 9. Makefile 检测 ─────────────────────────────────────────────
  const makefile = await tryRead('Makefile');
  if (makefile) {
    const rawTargets: string[] = [];
    for (const line of makefile.split(/\r?\n/)) {
      const m = line.match(/^([a-zA-Z0-9_.-]+)\s*:\s*(.*)$/);
      if (m && !m[1].startsWith('.') && !/^[A-Z0-9_]+$/.test(m[1])) {
        rawTargets.push(m[1]);
      }
    }
    // 优先常用目标排序: all, build, run, test, clean
    const priority = ['all', 'build', 'run', 'start', 'test', 'clean'];
    rawTargets.sort((a, b) => {
      const ia = priority.indexOf(a);
      const ib = priority.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b);
    });
    for (const target of rawTargets) {
      results.push({
        id: `make:${target}`,
        name: target,
        command: `make ${target}`,
        source: 'makefile',
        badge: 'Make',
        badgeBg: 'rgba(148, 163, 184, 0.15)',
        badgeColor: '#94a3b8',
        group: 'project',
      });
    }
  }

  return results;
}

const STORAGE_CUSTOM_KEY = (ws: string) => `echoly_custom_run_configs_${ws}`;
const STORAGE_SELECTED_KEY = (ws: string) => `echoly_selected_run_config_${ws}`;

export function RunWidget({
  workspace,
  activePath,
  onRunCommand,
  onStopCommand,
  isBottomExpanded,
  onExpandBottom,
  onSelectBottomTab,
  onShowToast,
}: Props) {
  const [detectedScripts, setDetectedScripts] = useState<ScriptOption[]>([]);
  const [customConfigs, setCustomConfigs] = useState<CustomConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [dropdownOpen, setDropdownOpen] = useState<boolean>(false);
  const [filterText, setFilterText] = useState<string>('');
  const [isAddingCustom, setIsAddingCustom] = useState<boolean>(false);
  const [newConfigName, setNewConfigName] = useState<string>('');
  const [newConfigCommand, setNewConfigCommand] = useState<string>('');
  const [runtimeConfigModalOpen, setRuntimeConfigModalOpen] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState<ProjectRuntimeConfig>(() =>
    loadProjectRuntimeConfig(workspace || undefined),
  );

  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 监听工作区切换与运行时配置变更事件
  useEffect(() => {
    setRuntimeConfig(loadProjectRuntimeConfig(workspace || undefined));
  }, [workspace]);

  useEffect(() => {
    const handleRuntimeConfigChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ workspace?: string; config: ProjectRuntimeConfig }>).detail;
      if (!detail?.workspace || detail.workspace === workspace) {
        setRuntimeConfig(detail.config || loadProjectRuntimeConfig(workspace || undefined));
      }
    };
    window.addEventListener('echoly:runtimeConfigChanged', handleRuntimeConfigChanged);
    return () => window.removeEventListener('echoly:runtimeConfigChanged', handleRuntimeConfigChanged);
  }, [workspace]);

  const hasActiveRuntimeArgs = Boolean(
    runtimeConfig.vmArgs.trim() ||
      runtimeConfig.programArgs.trim() ||
      runtimeConfig.envVars.trim() ||
      runtimeConfig.activeProfiles.trim(),
  );

  // 读取自定义配置
  useEffect(() => {
    if (!workspace) return;
    try {
      const raw = localStorage.getItem(STORAGE_CUSTOM_KEY(workspace));
      if (raw) {
        setCustomConfigs(JSON.parse(raw));
      } else {
        setCustomConfigs([]);
      }
    } catch {
      setCustomConfigs([]);
    }
  }, [workspace]);

  // 自动检测工程运行配置 (依赖 runtimeConfig 实时动态计算生成的命令)
  useEffect(() => {
    if (!workspace) return;
    let isMounted = true;
    (async () => {
      const loaded = await detectProjectScripts(workspace, activePath, runtimeConfig);
      if (!isMounted) return;
      setDetectedScripts(loaded);
    })();
    return () => {
      isMounted = false;
    };
  }, [workspace, activePath, runtimeConfig]);

  // 将 customConfigs 映射为 ScriptOption
  const customScriptOptions = useMemo<ScriptOption[]>(() => {
    return customConfigs.map((c) => ({
      id: `custom:${c.id}`,
      name: c.name,
      command: c.command,
      source: 'custom',
      badge: '自定义',
      badgeBg: 'rgba(244, 114, 182, 0.15)',
      badgeColor: '#f472b6',
      group: 'custom',
    }));
  }, [customConfigs]);

  // 汇总所有配置
  const allScripts = useMemo<ScriptOption[]>(() => {
    return [...detectedScripts, ...customScriptOptions];
  }, [detectedScripts, customScriptOptions]);

  // 初始化 / 记忆选中项
  useEffect(() => {
    if (!workspace || allScripts.length === 0) return;
    const savedId = localStorage.getItem(STORAGE_SELECTED_KEY(workspace));
    if (savedId && allScripts.some((s) => s.id === savedId)) {
      setSelectedId(savedId);
    } else {
      // 优先级推选：活跃文件 > dev > start > runserver > bootRun > run > 第一个
      const priorityNames = [
        'dev',
        'start',
        'runserver',
        'bootRun',
        'run',
        'compose up',
        'go run .',
        'cargo run',
      ];
      const found =
        allScripts.find((s) => s.group === 'current') ||
        allScripts.find((s) => priorityNames.includes(s.name)) ||
        allScripts[0];
      if (found) {
        setSelectedId(found.id);
      }
    }
  }, [workspace, allScripts]);

  // 点击外部收起
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setIsAddingCustom(false);
        setFilterText('');
      }
    };
    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dropdownOpen]);

  // 打开下拉菜单自动聚焦搜索框
  useEffect(() => {
    if (dropdownOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 40);
    }
  }, [dropdownOpen]);

  const handleSelect = (s: ScriptOption) => {
    setSelectedId(s.id);
    if (workspace) {
      localStorage.setItem(STORAGE_SELECTED_KEY(workspace), s.id);
    }
    setDropdownOpen(false);
    setFilterText('');
  };

  const handleAddCustom = () => {
    if (!newConfigName.trim() || !newConfigCommand.trim() || !workspace) return;
    const newConf: CustomConfig = {
      id: Date.now().toString(36),
      name: newConfigName.trim(),
      command: newConfigCommand.trim(),
    };
    const nextList = [...customConfigs, newConf];
    setCustomConfigs(nextList);
    try {
      localStorage.setItem(STORAGE_CUSTOM_KEY(workspace), JSON.stringify(nextList));
    } catch {
      /* ignore */
    }
    setSelectedId(`custom:${newConf.id}`);
    localStorage.setItem(STORAGE_SELECTED_KEY(workspace), `custom:${newConf.id}`);
    setNewConfigName('');
    setNewConfigCommand('');
    setIsAddingCustom(false);
    setDropdownOpen(false);
  };

  const handleDeleteCustom = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!workspace) return;
    const realId = id.replace(/^custom:/, '');
    const nextList = customConfigs.filter((c) => c.id !== realId);
    setCustomConfigs(nextList);
    try {
      localStorage.setItem(STORAGE_CUSTOM_KEY(workspace), JSON.stringify(nextList));
    } catch {
      /* ignore */
    }
    if (selectedId === id) {
      const fallback = detectedScripts[0]?.id || '';
      setSelectedId(fallback);
      if (fallback) localStorage.setItem(STORAGE_SELECTED_KEY(workspace), fallback);
    }
  };

  const currentOption = allScripts.find((s) => s.id === selectedId) || allScripts[0] || null;

  const handleRun = useCallback(() => {
    if (!currentOption) return;
    const rCfg = loadProjectRuntimeConfig(workspace);
    if (rCfg.showSettingsBeforeRun) {
      setRuntimeConfigModalOpen(true);
      return;
    }

    // 联动下方面板：切换到终端并确保面板展开
    onSelectBottomTab?.('terminal');
    if (!isBottomExpanded) {
      onExpandBottom('terminal');
    }
    window.dispatchEvent(
      new CustomEvent('echoly:openBottomTab', {
        detail: { tab: 'terminal' },
      }),
    );
    setIsRunning(true);

    let termType: string = currentOption.source;
    let termTitle: string = currentOption.badge || '终端';

    if (currentOption.badge === 'Java') {
      termType = 'java';
      termTitle = 'Java';
    } else if (currentOption.source === 'java') {
      if (currentOption.badge === 'Maven') {
        termType = 'mvn';
        termTitle = 'Maven';
      } else {
        termType = 'java';
        termTitle = 'Java';
      }
    } else if (currentOption.source === 'python') {
      termType = 'python';
      termTitle = 'Python';
    } else if (
      currentOption.source === 'npm' ||
      currentOption.source === 'pnpm' ||
      currentOption.source === 'yarn' ||
      currentOption.source === 'bun'
    ) {
      termType = 'node';
      termTitle = 'Node';
    }

    onRunCommand(currentOption.command, undefined, termType, termTitle);
  }, [currentOption, isBottomExpanded, onExpandBottom, onSelectBottomTab, onRunCommand, workspace]);

  const handleDebug = useCallback(async () => {
    if (!currentOption) return;

    const rCfg = loadProjectRuntimeConfig(workspace);
    if (rCfg.showSettingsBeforeRun) {
      setRuntimeConfigModalOpen(true);
      return;
    }

    // 联动下方面板：切换到调试控制台并确保面板展开
    onSelectBottomTab?.('debug');
    if (!isBottomExpanded) {
      onExpandBottom('debug');
    }
    window.dispatchEvent(
      new CustomEvent('echoly:openBottomTab', {
        detail: { tab: 'debug' },
      }),
    );
    setIsRunning(true);

    const dbgConfig = resolveDebugConfig(currentOption, activePath);

    window.dispatchEvent(
      new CustomEvent('echoly:startDebug', {
        detail: {
          language: dbgConfig.language,
          port: dbgConfig.port,
          name: currentOption.name,
          command: dbgConfig.command,
        },
      }),
    );

    // 启动前将本地已标记的全部断点预同步给主进程，确保调试启动时能自动命中断点
    try {
      const bpKey = workspace ? `echoly.dap.breakpoints.${workspace}` : 'echoly.dap.breakpoints.global';
      const rawBps = localStorage.getItem(bpKey) || localStorage.getItem('echoly.dap.breakpoints');
      if (rawBps && window.ide?.dapSetBreakpoints) {
        const bpsList: Array<{ path: string; line: number }> = JSON.parse(rawBps);
        const grouped: Record<string, number[]> = {};
        for (const b of bpsList) {
          if (!grouped[b.path]) grouped[b.path] = [];
          grouped[b.path].push(b.line);
        }
        for (const [p, lines] of Object.entries(grouped)) {
          void window.ide.dapSetBreakpoints(p, lines);
        }
      }
    } catch {}

    if (dbgConfig.type === 'dap') {
      let binPath = '';
      if (currentOption.source === 'cmake') {
        const tgtMatch = currentOption.id.match(/^cmake:run:(.+)$/);
        const tgt = tgtMatch ? tgtMatch[1] : 'app';
        binPath = `build/${tgt}`;
      } else {
        const fileMatch = currentOption.id.match(/^active:(.+)$/);
        const relPath = fileMatch ? fileMatch[1] : (activePath || '');
        const baseName = (relPath.split('/').pop() || '').replace(/\.[^.]+$/, '');
        binPath = `.echoly/bin/${baseName}`;
      }

      let buildCmd = currentOption.command;
      if (buildCmd.includes(' && ')) {
        buildCmd = buildCmd.split(' && ')[0];
      }

      onRunCommand(buildCmd, undefined, dbgConfig.terminalType, dbgConfig.terminalTitle);
      onShowToast?.('启动 C/C++ 调试', dbgConfig.toastMessage, 'info');

      setTimeout(async () => {
        try {
          if (window.ide?.dapStartSession) {
            const res = await window.ide.dapStartSession({
              program: binPath,
              cwd: workspace || undefined,
              stopOnEntry: false,
            });
            if (!res.success) {
              console.warn('[RunWidget] DAP startSession failed:', res.error);
              window.dispatchEvent(new CustomEvent('echoly:stopDebug'));
              setIsRunning(false);
            }
          }
        } catch (err) {
          console.error('[RunWidget] Failed to launch debug session:', err);
          window.dispatchEvent(new CustomEvent('echoly:stopDebug'));
          setIsRunning(false);
        }
      }, 1200);
      return;
    }

    // 针对 Java (JDWP)、Python (debugpy)、Node.js (inspect)、Go (Delve) 等多语言调试
    onRunCommand(dbgConfig.command, undefined, dbgConfig.terminalType, dbgConfig.terminalTitle);
    onShowToast?.('启动调试', dbgConfig.toastMessage, 'info');

    if (dbgConfig.port && window.ide?.dapStartSession) {
      setTimeout(async () => {
        try {
          if (window.ide?.dapStartSession) {
            const res = await window.ide.dapStartSession({
              program: activePath || '',
              mode: 'socket',
              port: dbgConfig.port,
              language: dbgConfig.language,
              cwd: workspace || undefined,
              stopOnEntry: false,
            });
            if (!res.success) {
              console.warn('[RunWidget] DAP socket startSession failed:', res.error);
              if (dbgConfig.language === 'python') {
                onShowToast?.('⚠️ Python 缺少 debugpy 模块', '未能连接到 debugpy。请在终端执行: pip3 install debugpy', 'warn');
              } else {
                onShowToast?.('调试连接未就绪', res.error || '无法连接到调试监听端口', 'warn');
              }
              window.dispatchEvent(new CustomEvent('echoly:stopDebug'));
              setIsRunning(false);
            }
          }
        } catch (err) {
          console.error('[RunWidget] Failed to launch socket debug session:', err);
          window.dispatchEvent(new CustomEvent('echoly:stopDebug'));
          setIsRunning(false);
        }
      }, 700);
    }
  }, [currentOption, isBottomExpanded, onExpandBottom, onRunCommand, onShowToast, activePath, workspace]);

  // 监听进程执行结束或报错事件，自动解除 isRunning 运行状态
  useEffect(() => {
    const handleRunFinished = () => {
      setIsRunning(false);
    };
    window.addEventListener('echoly:runFinished', handleRunFinished);
    window.addEventListener('echoly:stopDebug', handleRunFinished);
    return () => {
      window.removeEventListener('echoly:runFinished', handleRunFinished);
      window.removeEventListener('echoly:stopDebug', handleRunFinished);
    };
  }, []);

  const handleStop = useCallback(() => {
    setIsRunning(false);
    onStopCommand?.();
    window.dispatchEvent(new CustomEvent('echoly:stopDebug'));
    window.dispatchEvent(
      new CustomEvent('echoly:stopTerminalCommand', {
        detail: {
          terminalType: currentOption?.source || currentOption?.badge?.toLowerCase() || undefined,
        },
      }),
    );
  }, [currentOption, onStopCommand]);

  // 过滤选项
  const filtered = useMemo(() => {
    if (!filterText.trim()) return allScripts;
    const q = filterText.toLowerCase();
    return allScripts.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.command.toLowerCase().includes(q) ||
        s.badge.toLowerCase().includes(q),
    );
  }, [allScripts, filterText]);

  // 分组
  const currentGroup = filtered.filter((s) => s.group === 'current');
  const projectGroup = filtered.filter((s) => s.group === 'project');
  const customGroup = filtered.filter((s) => s.group === 'custom');

  if (!workspace) return null;

  return (
    <div
      className="idea-run-widget"
      ref={dropdownRef}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        background: 'rgba(255, 255, 255, 0.04)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        borderRadius: 6,
        height: 30,
        padding: '0 4px',
        gap: 4,
        position: 'relative',
        fontSize: 12,
        userSelect: 'none',
      }}
    >
      {/* 脚本选择下拉按钮 */}
      <button
        type="button"
        onClick={() => setDropdownOpen((v) => !v)}
        title={
          currentOption
            ? `运行配置: ${currentOption.name} (${currentOption.command})`
            : '选择或配置运行命令'
        }
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: 'none',
          border: 'none',
          color: 'var(--text)',
          cursor: 'pointer',
          padding: '0 6px',
          height: '100%',
          fontSize: 12,
          fontWeight: 500,
          borderRadius: 4,
          maxWidth: 180,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
      >
        {isRunning && (
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              backgroundColor: '#4ade80',
              boxShadow: '0 0 6px #4ade80',
              flexShrink: 0,
            }}
          />
        )}
        {currentOption ? (
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            <span
              style={{
                fontSize: 10,
                padding: '1px 4px',
                borderRadius: 3,
                background: currentOption.badgeBg,
                color: currentOption.badgeColor,
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              {currentOption.badge}
            </span>
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {currentOption.name}
            </span>
          </div>
        ) : (
          <span style={{ color: 'var(--muted)' }}>无运行配置</span>
        )}
        <span style={{ fontSize: 9, opacity: 0.6, marginLeft: 2, flexShrink: 0 }}>▾</span>
      </button>

      {/* 下拉浮层 */}
      {dropdownOpen && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 5px)',
            right: 0,
            width: 320,
            maxHeight: 380,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--bg-modal, #141414)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: 8,
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(0,0,0,0.2)',
            zIndex: 1000,
            overflow: 'hidden',
          }}
        >
          {/* 顶部搜索框 */}
          <div
            style={{
              padding: '6px 8px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
              background: 'rgba(255, 255, 255, 0.02)',
            }}
          >
            <input
              ref={searchInputRef}
              type="text"
              placeholder="搜索或过滤运行配置..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              style={{
                width: '100%',
                background: '#0d0d0d',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                borderRadius: 5,
                padding: '4px 8px',
                fontSize: 11.5,
                color: '#ffffff',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {/* 滚动列表 */}
          <div style={{ overflowY: 'auto', flex: 1, padding: 4 }}>
            {/* 当前文件 */}
            {currentGroup.length > 0 && (
              <div style={{ marginBottom: 6 }}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: 'var(--muted)',
                    padding: '4px 8px',
                    letterSpacing: '0.04em',
                  }}
                >
                  当前文件 (Active File)
                </div>
                {currentGroup.map((s) => (
                  <ScriptItem
                    key={s.id}
                    item={s}
                    isSelected={s.id === selectedId}
                    onSelect={() => handleSelect(s)}
                  />
                ))}
              </div>
            )}

            {/* 项目配置 */}
            {projectGroup.length > 0 && (
              <div style={{ marginBottom: 6 }}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: 'var(--muted)',
                    padding: '4px 8px',
                    letterSpacing: '0.04em',
                  }}
                >
                  项目运行配置 (Detected)
                </div>
                {projectGroup.map((s) => (
                  <ScriptItem
                    key={s.id}
                    item={s}
                    isSelected={s.id === selectedId}
                    onSelect={() => handleSelect(s)}
                  />
                ))}
              </div>
            )}

            {/* 自定义配置 */}
            {customGroup.length > 0 && (
              <div style={{ marginBottom: 6 }}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: 'var(--muted)',
                    padding: '4px 8px',
                    letterSpacing: '0.04em',
                  }}
                >
                  自定义配置 (Custom)
                </div>
                {customGroup.map((s) => (
                  <ScriptItem
                    key={s.id}
                    item={s}
                    isSelected={s.id === selectedId}
                    onSelect={() => handleSelect(s)}
                    onDelete={(e) => handleDeleteCustom(e, s.id)}
                  />
                ))}
              </div>
            )}

            {allScripts.length === 0 && (
              <div
                style={{
                  padding: '16px 12px',
                  textAlign: 'center',
                  fontSize: 11.5,
                  color: 'var(--muted)',
                }}
              >
                未检测到项目预置运行配置
                <br />
                <span style={{ fontSize: 10.5, opacity: 0.7 }}>
                  可打开脚本文件直接运行，或在下方添加自定义命令
                </span>
              </div>
            )}

            {filtered.length === 0 && allScripts.length > 0 && (
              <div
                style={{
                  padding: '14px 12px',
                  textAlign: 'center',
                  fontSize: 11.5,
                  color: 'var(--muted)',
                }}
              >
                无匹配运行配置
              </div>
            )}
          </div>

          {/* 底部：添加自定义命令 */}
          <div
            style={{
              borderTop: '1px solid rgba(255, 255, 255, 0.08)',
              padding: 6,
              background: 'rgba(255, 255, 255, 0.02)',
            }}
          >
            {!isAddingCustom ? (
              <button
                type="button"
                onClick={() => setIsAddingCustom(true)}
                style={{
                  width: '100%',
                  background: 'none',
                  border: '1px dashed rgba(255, 255, 255, 0.15)',
                  borderRadius: 5,
                  padding: '5px 8px',
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                  transition: 'color 0.15s, border-color 0.15s, background 0.15s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = '#ffffff';
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.35)';
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'var(--muted)';
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)';
                  e.currentTarget.style.background = 'none';
                }}
              >
                <span>+</span> 添加自定义运行命令
              </button>
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  padding: '4px 2px',
                }}
              >
                <input
                  type="text"
                  placeholder="配置名称 (如: dev:prod, pytest, run.sh)"
                  value={newConfigName}
                  onChange={(e) => setNewConfigName(e.target.value)}
                  style={{
                    background: 'rgba(0, 0, 0, 0.3)',
                    border: '1px solid rgba(255, 255, 255, 0.14)',
                    borderRadius: 4,
                    padding: '4px 8px',
                    fontSize: 11,
                    color: '#fff',
                    outline: 'none',
                  }}
                />
                <input
                  type="text"
                  placeholder="执行命令 (如: python3 test.py --env=dev)"
                  value={newConfigCommand}
                  onChange={(e) => setNewConfigCommand(e.target.value)}
                  style={{
                    background: 'rgba(0, 0, 0, 0.3)',
                    border: '1px solid rgba(255, 255, 255, 0.14)',
                    borderRadius: 4,
                    padding: '4px 8px',
                    fontSize: 11,
                    color: '#fff',
                    outline: 'none',
                    fontFamily: 'var(--font-mono, monospace)',
                  }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => {
                      setIsAddingCustom(false);
                      setNewConfigName('');
                      setNewConfigCommand('');
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--muted)',
                      fontSize: 11,
                      padding: '3px 8px',
                      cursor: 'pointer',
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleAddCustom}
                    disabled={!newConfigName.trim() || !newConfigCommand.trim()}
                    style={{
                      background: 'var(--accent, #4c8dff)',
                      border: 'none',
                      borderRadius: 4,
                      color: '#ffffff',
                      fontSize: 11,
                      fontWeight: 500,
                      padding: '3px 10px',
                      cursor:
                        !newConfigName.trim() || !newConfigCommand.trim()
                          ? 'not-allowed'
                          : 'pointer',
                      opacity: !newConfigName.trim() || !newConfigCommand.trim() ? 0.5 : 1,
                    }}
                  >
                    保存配置
                  </button>
                </div>
              </div>
            )}
            {/* 底部项目运行参数入口 */}
            <div
              style={{
                borderTop: '1px solid var(--border)',
                padding: '6px 8px 4px',
                marginTop: 3,
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setDropdownOpen(false);
                  setRuntimeConfigModalOpen(true);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  width: '100%',
                  background: hasActiveRuntimeArgs ? 'rgba(56, 189, 248, 0.07)' : 'rgba(255, 255, 255, 0.03)',
                  border: hasActiveRuntimeArgs ? '1px solid rgba(56, 189, 248, 0.25)' : '1px solid rgba(255, 255, 255, 0.08)',
                  cursor: 'pointer',
                  padding: '7px 10px',
                  borderRadius: 6,
                  textAlign: 'left',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--bg-hover, rgba(255, 255, 255, 0.08))';
                  e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.45)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = hasActiveRuntimeArgs ? 'rgba(56, 189, 248, 0.07)' : 'rgba(255, 255, 255, 0.03)';
                  e.currentTarget.style.borderColor = hasActiveRuntimeArgs ? 'rgba(56, 189, 248, 0.25)' : 'var(--border)';
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, overflow: 'hidden' }}>
                  <span style={{ fontSize: 13, color: hasActiveRuntimeArgs ? '#38bdf8' : 'var(--muted)', flexShrink: 0 }}>
                    ⚙
                  </span>
                  <div style={{ minWidth: 0, overflow: 'hidden' }}>
                    <div
                      style={{
                        fontSize: 11.5,
                        fontWeight: 600,
                        color: hasActiveRuntimeArgs ? 'var(--text-bright, #fff)' : 'var(--text)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      项目全局运行参数配置
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: 'var(--muted)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        marginTop: 1,
                      }}
                    >
                      VM Options · 入口参数 · 环境变量
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: 10.5,
                    padding: '2px 8px',
                    borderRadius: 12,
                    background: hasActiveRuntimeArgs ? 'rgba(56, 189, 248, 0.18)' : 'rgba(255, 255, 255, 0.06)',
                    border: hasActiveRuntimeArgs
                      ? '1px solid rgba(56, 189, 248, 0.4)'
                      : '1px solid var(--border)',
                    color: hasActiveRuntimeArgs ? '#38bdf8' : 'var(--muted)',
                    whiteSpace: 'nowrap',
                    fontWeight: 500,
                  }}
                >
                  {hasActiveRuntimeArgs ? (
                    <>
                      <span style={{ fontSize: 7, color: '#38bdf8' }}>●</span>
                      <span>已生效</span>
                    </>
                  ) : (
                    <span>未配置</span>
                  )}
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 分隔线 */}
      <div
        style={{
          width: 1,
          height: 16,
          background: 'rgba(255, 255, 255, 0.14)',
          margin: '0 2px',
        }}
      />

      {/* 运行按钮 ▶ */}
      {!isRunning ? (
        <button
          type="button"
          className="panel-action-btn run-action-btn"
          onClick={handleRun}
          disabled={!currentOption}
          title={
            currentOption
              ? `一键运行 (Run): ${currentOption.command}`
              : '🚫 当前项目未检测到可运行配置 (不可运行)'
          }
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="6 4 20 12 6 20 6 4" />
          </svg>
        </button>
      ) : (
        <button
          type="button"
          className="panel-action-btn stop-action-btn"
          onClick={handleStop}
          title="停止当前运行 (Stop)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="5" y="5" width="14" height="14" rx="2" />
          </svg>
        </button>
      )}

      {/* 调试按钮 🪲 */}
      <button
        type="button"
        className="panel-action-btn debug-action-btn"
        onClick={handleDebug}
        disabled={!currentOption}
        title={
          currentOption
            ? `启动调试 (Debug): ${currentOption.name}`
            : '🚫 当前项目未检测到可调试配置 (不可调试)'
        }
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="8" y="9" width="8" height="10" rx="4" />
          <line x1="6" y1="4" x2="8" y2="7" />
          <line x1="18" y1="4" x2="16" y2="7" />
          <line x1="4" y1="11" x2="8" y2="11" />
          <line x1="20" y1="11" x2="16" y2="11" />
          <line x1="4" y1="15" x2="8" y2="15" />
          <line x1="20" y1="15" x2="16" y2="15" />
        </svg>
      </button>

      {/* 运行时参数配置按钮 ⚙ */}
      <button
        type="button"
        className="panel-action-btn settings-action-btn"
        onClick={() => setRuntimeConfigModalOpen(true)}
        title={
          hasActiveRuntimeArgs
            ? `项目运行时参数已生效 (VM: ${runtimeConfig.vmArgs || '无'}, Profile: ${runtimeConfig.activeProfiles || '无'}) - 单击修改`
            : '项目全局运行时参数配置 (VM Options / 启动参数 / 环境预设)'
        }
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        {hasActiveRuntimeArgs && (
          <span
            style={{
              position: 'absolute',
              top: 2,
              right: 2,
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: '#38bdf8',
              boxShadow: '0 0 4px #38bdf8',
            }}
          />
        )}
      </button>

      {/* 运行时参数配置弹窗 */}
      <ProjectRuntimeConfigModal
        isOpen={runtimeConfigModalOpen}
        onClose={() => setRuntimeConfigModalOpen(false)}
        workspace={workspace || undefined}
        activePath={activePath || undefined}
        onShowToast={onShowToast}
      />
    </div>
  );
}

function ScriptItem({
  item,
  isSelected,
  onSelect,
  onDelete,
}: {
  item: ScriptOption;
  isSelected: boolean;
  onSelect: () => void;
  onDelete?: (e: React.MouseEvent) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '5px 8px',
        borderRadius: 5,
        cursor: 'pointer',
        fontSize: 12,
        color: isSelected ? '#ffffff' : 'var(--text)',
        background: isSelected
          ? '#242424'
          : hovered
            ? 'rgba(255, 255, 255, 0.06)'
            : 'transparent',
        border: isSelected ? '1px solid rgba(255, 255, 255, 0.12)' : '1px solid transparent',
        marginBottom: 2,
        transition: 'background 0.1s',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minWidth: 0,
          flex: 1,
        }}
      >
        <span
          style={{
            fontSize: 9.5,
            padding: '1px 4px',
            borderRadius: 3,
            background: item.badgeBg,
            color: item.badgeColor,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {item.badge}
        </span>
        <span
          style={{
            fontWeight: isSelected ? 600 : 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 12,
          }}
        >
          {item.name}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
          marginLeft: 8,
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            color: isSelected ? 'rgba(255, 255, 255, 0.8)' : 'var(--muted)',
            fontFamily: 'var(--font-mono, monospace)',
            maxWidth: 120,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={item.command}
        >
          {item.command}
        </span>

        {onDelete && hovered && (
          <button
            type="button"
            onClick={onDelete}
            title="删除自定义配置"
            style={{
              background: 'none',
              border: 'none',
              color: '#ef4444',
              cursor: 'pointer',
              fontSize: 13,
              lineHeight: 1,
              padding: '0 2px',
            }}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
