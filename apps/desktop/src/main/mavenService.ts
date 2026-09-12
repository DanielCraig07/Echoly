import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile, execSync } from 'child_process';
import type { MavenEnvironmentInfo } from '@deepseek-ide/shared';

const isWin = process.platform === 'win32';

/**
 * 探测系统中可用的 Maven 环境
 * 优先级：
 * 1. 工程内自带的 Maven Wrapper (./mvnw 或 .\\mvnw.cmd)
 * 2. 环境变量 PATH 中的 mvn
 * 3. 常见系统安装路径 (Homebrew, SDKMAN, MacPorts, JetBrains 内置, Windows 常用路径等)
 * 4. 便携版路径 (~/.echoly/tools/maven)
 */
export async function detectMavenEnvironment(
  workspaceRoot?: string,
): Promise<MavenEnvironmentInfo> {
  const homeDir = os.homedir();

  // 1. 检查工程内的 Maven Wrapper
  if (workspaceRoot) {
    const mvnwScript = isWin
      ? path.join(workspaceRoot, 'mvnw.cmd')
      : path.join(workspaceRoot, 'mvnw');
    if (fs.existsSync(mvnwScript)) {
      return {
        available: true,
        type: 'wrapper',
        executablePath: isWin ? '.\\mvnw.cmd' : './mvnw',
        hasJava: checkHasJava(),
        detail: '使用项目内置 Maven Wrapper (mvnw)',
      };
    }
  }

  // 2. 检查环境变量中的 mvn
  const pathMvn = checkMvnInPath();
  if (pathMvn) {
    return {
      available: true,
      type: 'system',
      executablePath: 'mvn',
      hasJava: checkHasJava(),
      mavenVersion: pathMvn.version,
      detail: `系统全局 Maven (${pathMvn.version || 'PATH'})`,
    };
  }

  // 3. 检查常见安装位置
  const candidatePaths: string[] = isWin
    ? [
        path.join(homeDir, '.echoly', 'tools', 'maven', 'bin', 'mvn.cmd'),
        'C:\\Program Files\\Apache\\maven\\bin\\mvn.cmd',
        'C:\\ProgramData\\chocolatey\\bin\\mvn.cmd',
        'C:\\tools\\maven\\bin\\mvn.cmd',
        path.join(homeDir, 'scoop', 'shims', 'mvn.cmd'),
      ]
    : [
        // macOS Homebrew
        '/opt/homebrew/bin/mvn',
        '/usr/local/bin/mvn',
        // Linux standard
        '/usr/bin/mvn',
        // SDKMAN
        path.join(homeDir, '.sdkman', 'candidates', 'maven', 'current', 'bin', 'mvn'),
        // asdf
        path.join(homeDir, '.asdf', 'shims', 'mvn'),
        // MacPorts
        '/opt/local/bin/mvn',
        // JetBrains Bundled Maven (macOS)
        '/Applications/IntelliJ IDEA.app/Contents/plugins/maven/lib/maven3/bin/mvn',
        '/Applications/IntelliJ IDEA CE.app/Contents/plugins/maven/lib/maven3/bin/mvn',
        // Echoly Portable Tools
        path.join(homeDir, '.echoly', 'tools', 'maven', 'bin', 'mvn'),
      ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      return {
        available: true,
        type: 'detected',
        executablePath: p,
        hasJava: checkHasJava(),
        detail: `自动检测到 Maven: ${p}`,
      };
    }
  }

  // 4. 未找到任何 Maven，检查是否有 Java
  const hasJava = checkHasJava();
  return {
    available: false,
    type: 'none',
    executablePath: isWin ? 'mvn.cmd' : 'mvn',
    hasJava,
    detail: hasJava
      ? '未检测到系统 Maven，但已检测到 Java 环境。可点击“一键生成项目 mvnw 包装器”即可免安装运行 Maven！'
      : '未检测到 Maven 和 Java 环境，请先安装 JDK 或配置 Maven 环境变量。',
  };
}

function checkMvnInPath(): { version?: string } | null {
  try {
    const cmd = isWin ? 'where' : 'which';
    const res = execSync(`${cmd} mvn`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    if (res && res.trim()) {
      let version = '';
      try {
        const vOut = execSync('mvn -v', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
        const firstLine = vOut.split('\n')[0]?.trim() || '';
        version = firstLine.replace(/^Apache Maven\s*/i, '');
      } catch {}
      return { version };
    }
  } catch {}
  return null;
}

function checkHasJava(): boolean {
  try {
    const cmd = isWin ? 'where' : 'which';
    const res = execSync(`${cmd} java`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    return Boolean(res && res.trim());
  } catch {
    return Boolean(process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME));
  }
}

/**
 * 为工程自动生成正统的 Apache Maven Wrapper (mvnw / mvnw.cmd / .mvn/wrapper/...)
 * 这样无论这台电脑装没装系统全局 mvn，只要有 java 就能自动下载并运行 maven
 */
export async function initMavenWrapper(
  workspaceRoot?: string,
): Promise<{ ok: boolean; success: boolean; detail: string; message: string }> {
  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
    return {
      ok: false,
      success: false,
      detail: '无效的工作区目录',
      message: '无效的工作区目录',
    };
  }

  try {
    const wrapperDir = path.join(workspaceRoot, '.mvn', 'wrapper');
    if (!fs.existsSync(wrapperDir)) {
      fs.mkdirSync(wrapperDir, { recursive: true });
    }

    // 1. 写 maven-wrapper.properties
    const propsPath = path.join(wrapperDir, 'maven-wrapper.properties');
    const propsContent = [
      '# Licensed to the Apache Software Foundation',
      'wrapperVersion=3.2.0',
      'distributionType=bin',
      'distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.6/apache-maven-3.9.6-bin.zip',
      '',
    ].join('\n');
    fs.writeFileSync(propsPath, propsContent, 'utf8');

    // 2. 写 unix mvnw 启动脚本
    const mvnwBashPath = path.join(workspaceRoot, 'mvnw');
    const mvnwBashContent = `#!/bin/sh
# ----------------------------------------------------------------------------
# Maven Wrapper Executable for Unix
# ----------------------------------------------------------------------------
PRG="$0"
while [ -h "$PRG" ]; do
  ls=\`ls -ld "$PRG"\`
  link=\`expr "$ls" : '.*-> \\(.*\\)$'\`
  if expr "$link" : '/.*' > /dev/null; then
    PRG="$link"
  else
    PRG=\`dirname "$PRG"\`/"$link"
  fi
done
SAVED="\`pwd\`"
cd "\`dirname \\"$PRG\\"\`" >/dev/null
MAVEN_PROJECTBASEDIR="\`pwd -P\`"
cd "$SAVED" >/dev/null

WRAPPER_JAR="$MAVEN_PROJECTBASEDIR/.mvn/wrapper/maven-wrapper.jar"
WRAPPER_LAUNCHER="org.apache.maven.wrapper.MavenWrapperMain"

# Find Java
if [ -n "$JAVA_HOME" ] ; then
    if [ -x "$JAVA_HOME/jre/sh/java" ] ; then
        JAVACMD="$JAVA_HOME/jre/sh/java"
    else
        JAVACMD="$JAVA_HOME/bin/java"
    fi
fi
if [ -z "$JAVACMD" ] ; then
    JAVACMD="java"
fi

if [ ! -x "$JAVACMD" ] ; then
    echo "Error: JAVA_HOME is not set and no 'java' command could be found in your PATH." >&2
    exit 1
fi

# If wrapper jar is not present, use system mvn if available or download
if [ ! -f "$WRAPPER_JAR" ]; then
    if command -v mvn >/dev/null 2>&1; then
        exec mvn "$@"
    else
        echo "Maven Wrapper: downloading wrapper..."
        mkdir -p "$MAVEN_PROJECTBASEDIR/.mvn/wrapper"
        curl -sfo "$WRAPPER_JAR" "https://repo.maven.apache.org/maven2/org/apache/maven/wrapper/maven-wrapper/3.2.0/maven-wrapper-3.2.0.jar" 2>/dev/null || \\
        curl -sfo "$WRAPPER_JAR" "https://maven.aliyun.com/repository/public/org/apache/maven/wrapper/maven-wrapper/3.2.0/maven-wrapper-3.2.0.jar" 2>/dev/null
    fi
fi

exec "$JAVACMD" \\
    -Dmaven.home="$MAVEN_PROJECTBASEDIR/.mvn/wrapper/dist" \\
    -Dmaven.multiModuleProjectDirectory="$MAVEN_PROJECTBASEDIR" \\
    -classpath "$WRAPPER_JAR" \\
    "$WRAPPER_LAUNCHER" "$@"
`;
    fs.writeFileSync(mvnwBashPath, mvnwBashContent, { encoding: 'utf8', mode: 0o755 });

    // 3. 写 Windows mvnw.cmd 脚本
    const mvnwCmdPath = path.join(workspaceRoot, 'mvnw.cmd');
    const mvnwCmdContent = `@REM ----------------------------------------------------------------------------
@REM Maven Startup Script for Windows
@REM ----------------------------------------------------------------------------
@echo off
setlocal

set "DIR=%~dp0"
set "MAVEN_PROJECTBASEDIR=%DIR%"
if "%MAVEN_PROJECTBASEDIR:~-1%"=="\\" set "MAVEN_PROJECTBASEDIR=%MAVEN_PROJECTBASEDIR:~0,-1%"

set "WRAPPER_JAR=%MAVEN_PROJECTBASEDIR%\\.mvn\\wrapper\\maven-wrapper.jar"
set "WRAPPER_LAUNCHER=org.apache.maven.wrapper.MavenWrapperMain"

if not defined JAVA_HOME (
  set "JAVACMD=java"
) else (
  set "JAVACMD=%JAVA_HOME%\\bin\\java.exe"
)

if not exist "%WRAPPER_JAR%" (
  where mvn >nul 2>nul
  if %ERRORLEVEL% EQU 0 (
    mvn %*
    exit /b %ERRORLEVEL%
  )
  powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('https://repo.maven.apache.org/maven2/org/apache/maven/wrapper/maven-wrapper/3.2.0/maven-wrapper-3.2.0.jar', '%WRAPPER_JAR%')" 2>nul
)

"%JAVACMD%" ^
  "-Dmaven.multiModuleProjectDirectory=%MAVEN_PROJECTBASEDIR%" ^
  -classpath "%WRAPPER_JAR%" ^
  "%WRAPPER_LAUNCHER%" %*
`;
    fs.writeFileSync(mvnwCmdPath, mvnwCmdContent, 'utf8');

    return {
      ok: true,
      success: true,
      message: '已成功为项目生成 Maven Wrapper (mvnw)！有 Java 即可免装 Maven 运行',
      detail: '已成功为项目生成 Maven Wrapper (mvnw)！有 Java 即可免装 Maven 运行',
    };
  } catch (err: any) {
    const msg = err.message || String(err);
    return { ok: false, success: false, message: msg, detail: msg };
  }
}

/**
 * 为工程生成或配置推荐的 Maven settings.xml 文件 (预置阿里云等国内高速镜像)
 */
export async function initMavenSettings(
  workspaceRoot?: string,
): Promise<{ success: boolean; path?: string; message: string }> {
  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
    return { success: false, message: '无效的工作区目录' };
  }

  try {
    const mvnDir = path.join(workspaceRoot, '.mvn');
    if (!fs.existsSync(mvnDir)) {
      fs.mkdirSync(mvnDir, { recursive: true });
    }

    const settingsPath = path.join(mvnDir, 'settings.xml');
    const settingsContent = `<?xml version="1.0" encoding="UTF-8"?>
<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.2.0 https://maven.apache.org/xsd/settings-1.2.0.xsd">
  <mirrors>
    <!-- 阿里云国内公共镜像库 (极大加速国内依赖下载) -->
    <mirror>
      <id>aliyunmaven</id>
      <mirrorOf>central</mirrorOf>
      <name>阿里云公共仓库</name>
      <url>https://maven.aliyun.com/repository/public</url>
    </mirror>
  </mirrors>

  <profiles>
    <profile>
      <id>jdk-default</id>
      <activation>
        <activeByDefault>true</activeByDefault>
      </activation>
      <properties>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
        <project.reporting.outputEncoding>UTF-8</project.reporting.outputEncoding>
      </properties>
    </profile>
  </profiles>
</settings>
`;

    fs.writeFileSync(settingsPath, settingsContent, 'utf8');

    return {
      success: true,
      path: settingsPath,
      message: '已成功在当前工作区生成 .mvn/settings.xml（预配置阿里云镜像源加速）！',
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    return { success: false, message: `生成 settings.xml 失败: ${msg}` };
  }
}
