import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawn } from 'child_process';
import type { InstalledJdkInfo, OnlineJdkInfo, JdkInstallProgress } from '@deepseek-ide/shared';

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/** 用户本地存储与管理 JDK 的根目录 */
export function getEcholyJdksDir(): string {
  const dir = path.join(os.homedir(), '.echoly', 'jdks');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 扫描系统中所有已安装的 JDK
 */
export async function detectInstalledJdks(): Promise<InstalledJdkInfo[]> {
  const result: InstalledJdkInfo[] = [];
  const visitedPaths = new Set<string>();

  // 1. macOS 专属探测命令：/usr/libexec/java_home -V
  if (isMac) {
    try {
      const output = execSync('/usr/libexec/java_home -V 2>&1', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      // 匹配行如：
      // 17.0.16 (arm64) "Microsoft" - "OpenJDK 17.0.16" /Users/.../Contents/Home
      // 1.8.0_351 (x86_64) "Oracle Corporation" - "Java SE 8" /Library/.../Contents/Home
      const lines = output.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        const match = trimmed.match(/^(\d+(?:\.\d+)*[_\.\d]*)\s+\(([^)]+)\)\s+"([^"]+)"\s+-\s+"([^"]+)"\s+(.+)$/);
        if (match) {
          const [, version, arch, vendor, , homePath] = match;
          const cleanPath = homePath.trim();
          if (fs.existsSync(cleanPath) && !visitedPaths.has(cleanPath)) {
            visitedPaths.add(cleanPath);
            const major = parseInt(version.startsWith('1.') ? version.split('.')[1] : version.split('.')[0], 10) || undefined;
            result.push({
              id: `system-${cleanPath}`,
              version,
              majorVersion: major,
              arch,
              vendor,
              path: cleanPath,
            });
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. 扫描 ~/.echoly/jdks 目录下的所有 JDK
  const echolyDir = getEcholyJdksDir();
  try {
    if (fs.existsSync(echolyDir)) {
      const entries = fs.readdirSync(echolyDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const fullEntryPath = path.join(echolyDir, entry.name);
          const javaHome = resolveJavaHome(fullEntryPath);
          if (javaHome && !visitedPaths.has(javaHome)) {
            visitedPaths.add(javaHome);
            const verInfo = getJdkVersionFromHome(javaHome);
            result.push({
              id: `echoly-${entry.name}`,
              version: verInfo.version || entry.name,
              majorVersion: verInfo.major,
              arch: verInfo.arch || process.arch,
              vendor: verInfo.vendor || 'Echoly Managed',
              path: javaHome,
            });
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // 3. 检查系统环境变量 JAVA_HOME
  if (process.env.JAVA_HOME) {
    const p = process.env.JAVA_HOME.trim();
    if (fs.existsSync(p) && !visitedPaths.has(p)) {
      visitedPaths.add(p);
      const verInfo = getJdkVersionFromHome(p);
      result.push({
        id: `env-java-home`,
        version: verInfo.version || 'Custom',
        majorVersion: verInfo.major,
        arch: verInfo.arch || process.arch,
        vendor: 'System JAVA_HOME',
        path: p,
      });
    }
  }

  // 4. 检查 PATH 中的 java
  try {
    const whichCmd = isWin ? 'where java' : 'which java';
    const javaBin = execSync(whichCmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).split('\n')[0]?.trim();
    if (javaBin && fs.existsSync(javaBin)) {
      // 常见为 /usr/bin/java -> 符号链接
      try {
        const realJava = fs.realpathSync(javaBin);
        const guessedHome = path.dirname(path.dirname(realJava));
        if (fs.existsSync(guessedHome) && !visitedPaths.has(guessedHome)) {
          visitedPaths.add(guessedHome);
          const verInfo = getJdkVersionFromHome(guessedHome);
          result.push({
            id: `path-java`,
            version: verInfo.version || 'PATH Java',
            majorVersion: verInfo.major,
            arch: verInfo.arch || process.arch,
            vendor: 'System PATH',
            path: guessedHome,
          });
        }
      } catch {}
    }
  } catch {}

  // 5. Windows 常用安装位置
  if (isWin) {
    const winPaths = [
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft',
      path.join(os.homedir(), '.jdks'),
    ];
    for (const root of winPaths) {
      if (fs.existsSync(root)) {
        try {
          const subs = fs.readdirSync(root, { withFileTypes: true });
          for (const s of subs) {
            if (s.isDirectory()) {
              const full = path.join(root, s.name);
              const javaHome = resolveJavaHome(full);
              if (javaHome && !visitedPaths.has(javaHome)) {
                visitedPaths.add(javaHome);
                const verInfo = getJdkVersionFromHome(javaHome);
                result.push({
                  id: `win-${s.name}`,
                  version: verInfo.version || s.name,
                  majorVersion: verInfo.major,
                  arch: verInfo.arch || process.arch,
                  vendor: 'Installed',
                  path: javaHome,
                });
              }
            }
          }
        } catch {}
      }
    }
  }

  return result;
}

/**
 * 给定一个目录，寻找其中的 JAVA_HOME
 * macOS 常见为 <dir>/Contents/Home
 * 通用结构为直接包含 bin/java (或 bin/java.exe)
 */
export function resolveJavaHome(candidateDir: string): string | null {
  if (!fs.existsSync(candidateDir)) return null;

  const checkHome = (p: string): boolean => {
    const javaExec = isWin ? path.join(p, 'bin', 'java.exe') : path.join(p, 'bin', 'java');
    return fs.existsSync(javaExec);
  };

  if (checkHome(candidateDir)) return candidateDir;

  // macOS 特有结构
  const macHome = path.join(candidateDir, 'Contents', 'Home');
  if (checkHome(macHome)) return macHome;

  // 检查可能嵌套的一级子目录 (解压 tar.gz 常见的如 jdk-21.0.x/)
  try {
    const items = fs.readdirSync(candidateDir, { withFileTypes: true });
    for (const item of items) {
      if (item.isDirectory()) {
        const sub = path.join(candidateDir, item.name);
        if (checkHome(sub)) return sub;
        const subMac = path.join(sub, 'Contents', 'Home');
        if (checkHome(subMac)) return subMac;
      }
    }
  } catch {}

  return null;
}

function getJdkVersionFromHome(javaHome: string): { version?: string; major?: number; arch?: string; vendor?: string } {
  try {
    const javaExec = isWin ? path.join(javaHome, 'bin', 'java.exe') : path.join(javaHome, 'bin', 'java');
    if (fs.existsSync(javaExec)) {
      const out = execSync(`"${javaExec}" -version 2>&1`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      // openjdk version "21.0.2" ... 或 java version "1.8.0_351"
      const vMatch = out.match(/(?:java|openjdk) version "([^"]+)"/i);
      const version = vMatch ? vMatch[1] : undefined;
      let major: number | undefined = undefined;
      if (version) {
        major = parseInt(version.startsWith('1.') ? version.split('.')[1] : version.split('.')[0], 10) || undefined;
      }
      let vendor = 'OpenJDK';
      if (/Temurin|Adoptium/i.test(out)) vendor = 'Eclipse Temurin';
      else if (/Microsoft/i.test(out)) vendor = 'Microsoft OpenJDK';
      else if (/Zulu/i.test(out)) vendor = 'Azul Zulu';
      else if (/Oracle/i.test(out)) vendor = 'Oracle Java';
      else if (/Corretto/i.test(out)) vendor = 'Amazon Corretto';

      return { version, major, arch: process.arch, vendor };
    }
  } catch {}
  return {};
}

/**
 * 获取官方推荐可供在线安装的 JDK 列表
 */
export async function getAvailableOnlineJdks(): Promise<OnlineJdkInfo[]> {
  const platform = process.platform;
  const arch = process.arch; // 'arm64' | 'x64'
  const echolyDir = getEcholyJdksDir();

  // 根据当前架构生成下载映射
  const isMacArm = platform === 'darwin' && arch === 'arm64';
  const isMacX64 = platform === 'darwin' && arch === 'x64';
  const isWinX64 = platform === 'win32' && arch === 'x64';
  const isLinuxX64 = platform === 'linux' && arch === 'x64';
  const isLinuxArm = platform === 'linux' && arch === 'arm64';

  const jdks: OnlineJdkInfo[] = [
    {
      id: 'temurin-21',
      name: 'Eclipse Temurin 21 (LTS)',
      version: '21',
      vendor: 'Eclipse Adoptium',
      description: '最新 LTS 长期支持版，推荐 Spring Boot 3.x 及现代 Java 开发',
      recommended: true,
      sizeMb: 195,
      downloadUrl: isMacArm
        ? 'https://api.adoptium.net/v3/binary/latest/21/ga/mac/aarch64/jdk/hotspot/normal/eclipse'
        : isMacX64
        ? 'https://api.adoptium.net/v3/binary/latest/21/ga/mac/x64/jdk/hotspot/normal/eclipse'
        : isWinX64
        ? 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse'
        : isLinuxArm
        ? 'https://api.adoptium.net/v3/binary/latest/21/ga/linux/aarch64/jdk/hotspot/normal/eclipse'
        : 'https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse',
    },
    {
      id: 'temurin-17',
      name: 'Eclipse Temurin 17 (LTS)',
      version: '17',
      vendor: 'Eclipse Adoptium',
      description: '主流生产级 LTS 版本，广泛应用于微服务与企业系统',
      recommended: false,
      sizeMb: 185,
      downloadUrl: isMacArm
        ? 'https://api.adoptium.net/v3/binary/latest/17/ga/mac/aarch64/jdk/hotspot/normal/eclipse'
        : isMacX64
        ? 'https://api.adoptium.net/v3/binary/latest/17/ga/mac/x64/jdk/hotspot/normal/eclipse'
        : isWinX64
        ? 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse'
        : isLinuxArm
        ? 'https://api.adoptium.net/v3/binary/latest/17/ga/linux/aarch64/jdk/hotspot/normal/eclipse'
        : 'https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse',
    },
    {
      id: 'temurin-11',
      name: 'Eclipse Temurin 11 (LTS)',
      version: '11',
      vendor: 'Eclipse Adoptium',
      description: '企业成熟 LTS 版本，兼容老版本 Spring Boot 2.x 工程',
      recommended: false,
      sizeMb: 175,
      downloadUrl: isMacArm
        ? 'https://api.adoptium.net/v3/binary/latest/11/ga/mac/aarch64/jdk/hotspot/normal/eclipse'
        : isMacX64
        ? 'https://api.adoptium.net/v3/binary/latest/11/ga/mac/x64/jdk/hotspot/normal/eclipse'
        : isWinX64
        ? 'https://api.adoptium.net/v3/binary/latest/11/ga/windows/x64/jdk/hotspot/normal/eclipse'
        : isLinuxArm
        ? 'https://api.adoptium.net/v3/binary/latest/11/ga/linux/aarch64/jdk/hotspot/normal/eclipse'
        : 'https://api.adoptium.net/v3/binary/latest/11/ga/linux/x64/jdk/hotspot/normal/eclipse',
    },
    {
      id: 'jdk-8',
      name: isMacArm ? 'Azul Zulu 8 (LTS - Apple Silicon 原生)' : 'Eclipse Temurin 8 (LTS)',
      version: '8',
      vendor: isMacArm ? 'Azul Systems' : 'Eclipse Adoptium',
      description: '经典 Java 8 长期支持，维护旧版企业架构首选',
      recommended: false,
      sizeMb: isMacArm ? 95 : 110,
      downloadUrl: isMacArm
        ? 'https://cdn.azul.com/zulu/bin/zulu8.96.0.205-ca-fx-jdk8.0.504-macosx_aarch64.tar.gz'
        : isMacX64
        ? 'https://api.adoptium.net/v3/binary/latest/8/ga/mac/x64/jdk/hotspot/normal/eclipse'
        : isWinX64
        ? 'https://api.adoptium.net/v3/binary/latest/8/ga/windows/x64/jdk/hotspot/normal/eclipse'
        : isLinuxArm
        ? 'https://api.adoptium.net/v3/binary/latest/8/ga/linux/aarch64/jdk/hotspot/normal/eclipse'
        : 'https://api.adoptium.net/v3/binary/latest/8/ga/linux/x64/jdk/hotspot/normal/eclipse',
    },
    {
      id: 'temurin-22',
      name: 'Eclipse Temurin 22 (最新特性版)',
      version: '22',
      vendor: 'Eclipse Adoptium',
      description: '包含外语接口、结构化并发预览及现代语言特性的前沿版本',
      recommended: false,
      sizeMb: 200,
      downloadUrl: isMacArm
        ? 'https://api.adoptium.net/v3/binary/latest/22/ga/mac/aarch64/jdk/hotspot/normal/eclipse'
        : isMacX64
        ? 'https://api.adoptium.net/v3/binary/latest/22/ga/mac/x64/jdk/hotspot/normal/eclipse'
        : isWinX64
        ? 'https://api.adoptium.net/v3/binary/latest/22/ga/windows/x64/jdk/hotspot/normal/eclipse'
        : isLinuxArm
        ? 'https://api.adoptium.net/v3/binary/latest/22/ga/linux/aarch64/jdk/hotspot/normal/eclipse'
        : 'https://api.adoptium.net/v3/binary/latest/22/ga/linux/x64/jdk/hotspot/normal/eclipse',
    },
    {
      id: 'corretto-21',
      name: 'Amazon Corretto 21 (LTS)',
      version: '21',
      vendor: 'Amazon',
      description: '亚马逊针对云原生生产环境特别优化的多平台无成本分发版',
      recommended: false,
      sizeMb: 190,
      downloadUrl: isMacArm
        ? 'https://corretto.aws/downloads/latest/amazon-corretto-21-aarch64-macos-jdk.tar.gz'
        : isMacX64
        ? 'https://corretto.aws/downloads/latest/amazon-corretto-21-x64-macos-jdk.tar.gz'
        : isWinX64
        ? 'https://corretto.aws/downloads/latest/amazon-corretto-21-x64-windows-jdk.zip'
        : isLinuxArm
        ? 'https://corretto.aws/downloads/latest/amazon-corretto-21-aarch64-linux-jdk.tar.gz'
        : 'https://corretto.aws/downloads/latest/amazon-corretto-21-x64-linux-jdk.tar.gz',
    },
    {
      id: 'corretto-17',
      name: 'Amazon Corretto 17 (LTS)',
      version: '17',
      vendor: 'Amazon',
      description: '高稳定性生产级发行版，针对高并发微服务进行调优',
      recommended: false,
      sizeMb: 180,
      downloadUrl: isMacArm
        ? 'https://corretto.aws/downloads/latest/amazon-corretto-17-aarch64-macos-jdk.tar.gz'
        : isMacX64
        ? 'https://corretto.aws/downloads/latest/amazon-corretto-17-x64-macos-jdk.tar.gz'
        : isWinX64
        ? 'https://corretto.aws/downloads/latest/amazon-corretto-17-x64-windows-jdk.zip'
        : isLinuxArm
        ? 'https://corretto.aws/downloads/latest/amazon-corretto-17-aarch64-linux-jdk.tar.gz'
        : 'https://corretto.aws/downloads/latest/amazon-corretto-17-x64-linux-jdk.tar.gz',
    },
    {
      id: 'corretto-11',
      name: 'Amazon Corretto 11 (LTS)',
      version: '11',
      vendor: 'Amazon',
      description: '成熟可靠的企业级 Java 11 发行版，适用云端生产部署',
      recommended: false,
      sizeMb: 170,
      downloadUrl: isMacArm
        ? 'https://corretto.aws/downloads/latest/amazon-corretto-11-aarch64-macos-jdk.tar.gz'
        : isMacX64
        ? 'https://corretto.aws/downloads/latest/amazon-corretto-11-x64-macos-jdk.tar.gz'
        : isWinX64
        ? 'https://corretto.aws/downloads/latest/amazon-corretto-11-x64-windows-jdk.zip'
        : isLinuxArm
        ? 'https://corretto.aws/downloads/latest/amazon-corretto-11-aarch64-linux-jdk.tar.gz'
        : 'https://corretto.aws/downloads/latest/amazon-corretto-11-x64-linux-jdk.tar.gz',
    },
    {
      id: 'zulu-21',
      name: 'Azul Zulu 21 (LTS)',
      version: '21',
      vendor: 'Azul Systems',
      description: '100% 开源兼容的经过 TCK 严格测试认证的专业 OpenJDK 发行版',
      recommended: false,
      sizeMb: 195,
      downloadUrl: isMacArm
        ? 'https://cdn.azul.com/zulu/bin/zulu21.38.21-ca-jdk21.0.5-macosx_aarch64.tar.gz'
        : isMacX64
        ? 'https://cdn.azul.com/zulu/bin/zulu21.38.21-ca-jdk21.0.5-macosx_x64.tar.gz'
        : isWinX64
        ? 'https://cdn.azul.com/zulu/bin/zulu21.38.21-ca-jdk21.0.5-win_x64.zip'
        : isLinuxArm
        ? 'https://cdn.azul.com/zulu/bin/zulu21.38.21-ca-jdk21.0.5-linux_aarch64.tar.gz'
        : 'https://cdn.azul.com/zulu/bin/zulu21.38.21-ca-jdk21.0.5-linux_x64.tar.gz',
    },
    {
      id: 'graalvm-21',
      name: 'GraalVM Community Edition 21 (Native Image)',
      version: '21',
      vendor: 'Oracle GraalVM',
      description: '支持 ahead-of-time (AOT) 极速本地可执行文件打包编译的高性能运行时',
      recommended: false,
      sizeMb: 240,
      downloadUrl: isMacArm
        ? 'https://github.com/graalvm/graalvm-ce-builds/releases/download/jdk-21.0.2/graalvm-community-jdk-21.0.2_macos-aarch64_bin.tar.gz'
        : isMacX64
        ? 'https://github.com/graalvm/graalvm-ce-builds/releases/download/jdk-21.0.2/graalvm-community-jdk-21.0.2_macos-x64_bin.tar.gz'
        : isWinX64
        ? 'https://github.com/graalvm/graalvm-ce-builds/releases/download/jdk-21.0.2/graalvm-community-jdk-21.0.2_windows-x64_bin.zip'
        : isLinuxArm
        ? 'https://github.com/graalvm/graalvm-ce-builds/releases/download/jdk-21.0.2/graalvm-community-jdk-21.0.2_linux-aarch64_bin.tar.gz'
        : 'https://github.com/graalvm/graalvm-ce-builds/releases/download/jdk-21.0.2/graalvm-community-jdk-21.0.2_linux-x64_bin.tar.gz',
    },
  ];

  // 检查哪些已经安装在 echolyDir
  for (const jdk of jdks) {
    const installTargetDir = path.join(echolyDir, jdk.id);
    const home = resolveJavaHome(installTargetDir);
    if (home) {
      jdk.isInstalled = true;
      jdk.installedPath = home;
    } else {
      jdk.isInstalled = false;
    }
  }

  return jdks;
}

/**
 * 广播安装进度给所有渲染进程窗口
 */
function broadcastProgress(progress: JdkInstallProgress) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron');
    if (electron?.BrowserWindow?.getAllWindows) {
      electron.BrowserWindow.getAllWindows().forEach((w: any) => {
        if (!w.isDestroyed()) {
          w.webContents.send('java:installProgress', progress);
        }
      });
    }
  } catch {}
}

/**
 * 在线下载并自动安装指定的 JDK
 */
export async function installOnlineJdk(
  jdkId: string,
): Promise<{ success: boolean; javaHome?: string; message: string }> {
  const list = await getAvailableOnlineJdks();
  const target = list.find((item) => item.id === jdkId);
  if (!target) {
    return { success: false, message: `未找到指定的 JDK 配置: ${jdkId}` };
  }

  const echolyDir = getEcholyJdksDir();
  const installTargetDir = path.join(echolyDir, jdkId);
  const tempArchive = path.join(echolyDir, `${jdkId}-download.tmp`);

  try {
    broadcastProgress({
      id: jdkId,
      status: 'downloading',
      percent: 0,
      message: `开始从官方源下载 ${target.name}...`,
    });

    // 1. 发起请求并支持 302/307 追踪
    const response = await fetch(target.downloadUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Echoly-IDE/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`下载失败，HTTP 状态码: ${response.status}`);
    }

    const contentLengthHeader = response.headers.get('content-length');
    const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : (target.sizeMb || 180) * 1024 * 1024;
    let downloadedBytes = 0;

    const fileStream = fs.createWriteStream(tempArchive);
    if (!response.body) {
      throw new Error('响应数据流为空');
    }

    // Node 18+ web stream to node stream
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        fileStream.write(Buffer.from(value));
        downloadedBytes += value.byteLength;
        const percent = Math.min(99, Math.round((downloadedBytes / totalBytes) * 100));
        broadcastProgress({
          id: jdkId,
          status: 'downloading',
          percent,
          downloadedBytes,
          totalBytes,
          message: `正在下载 ${target.name} (${Math.round(downloadedBytes / 1024 / 1024)}MB / ${Math.round(totalBytes / 1024 / 1024)}MB)...`,
        });
      }
    }
    fileStream.end();

    await new Promise<void>((resolve) => {
      fileStream.on('finish', () => resolve());
    });

    // 2. 解压阶段
    broadcastProgress({
      id: jdkId,
      status: 'extracting',
      percent: 100,
      message: `正在解压安装 ${target.name}...`,
    });

    if (fs.existsSync(installTargetDir)) {
      fs.rmSync(installTargetDir, { recursive: true, force: true });
    }
    fs.mkdirSync(installTargetDir, { recursive: true });

    // 使用系统内置 tar 解压
    const tarCmd = isWin
      ? `tar -xf "${tempArchive}" -C "${installTargetDir}"`
      : `tar -xzf "${tempArchive}" -C "${installTargetDir}"`;
    execSync(tarCmd, { stdio: 'ignore' });

    // 清理临时压缩包
    try {
      if (fs.existsSync(tempArchive)) fs.unlinkSync(tempArchive);
    } catch {}

    // macOS 去除 quarantine 并赋予执行权限
    if (isMac) {
      try {
        execSync(`xattr -r -d com.apple.quarantine "${installTargetDir}" 2>/dev/null || true`);
        execSync(`find "${installTargetDir}" -type f -name "java" -exec chmod +x {} + 2>/dev/null || true`);
      } catch {}
    }

    const home = resolveJavaHome(installTargetDir);
    if (!home) {
      throw new Error('解压成功但未能找到有效的 JAVA_HOME 目录');
    }

    broadcastProgress({
      id: jdkId,
      status: 'done',
      percent: 100,
      message: `安装完成: ${target.name}`,
    });

    return {
      success: true,
      javaHome: home,
      message: `已成功安装 ${target.name}！`,
    };
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    try {
      if (fs.existsSync(tempArchive)) fs.unlinkSync(tempArchive);
    } catch {}

    broadcastProgress({
      id: jdkId,
      status: 'error',
      percent: 0,
      message: `安装失败: ${errorMsg}`,
    });

    return {
      success: false,
      message: `安装失败: ${errorMsg}`,
    };
  }
}
