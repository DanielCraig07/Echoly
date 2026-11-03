/**
 * Extension Loader
 * 负责加载和解析 VSCode 扩展（.vsix 文件）
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// 添加 fs 到类型中
import type { Stats } from 'fs';

export interface ExtensionManifest {
  name: string;
  displayName: string;
  description: string;
  version: string;
  publisher: string;
  engines: {
    vscode: string;
  };
  categories?: string[];
  activationEvents?: string[];
  main?: string;
  contributes?: {
    commands?: Array<{
      command: string;
      title: string;
      category?: string;
    }>;
    configuration?: any;
    views?: any;
    viewsContainers?: any;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface LoadedExtension {
  manifest: ExtensionManifest;
  extensionPath: string;
  mainModule?: any;
  /**
   * `main` 声明了、但模块没能加载起来的原因。
   *
   * 必须留下来：这条失败以前只打一行日志，随后 activateExtension 看到没有 mainModule
   * 就走「该扩展没有 activate 函数」那条分支 —— 于是「包里没有 main」和「main 崩了」
   * 在用户那里长得一模一样：装上了，什么都没发生。
   */
  mainModuleError?: string;
}

/**
 * 从 .vsix 文件解压扩展
 */
export async function extractVsix(vsixPath: string, targetDir: string): Promise<string> {
  console.log(`[extractVsix] 开始解压: ${vsixPath}`);
  console.log(`[extractVsix] 目标目录: ${targetDir}`);

  // 如果目标目录已存在，先删除（避免 unzip 等待覆盖确认）
  if (await exists(targetDir)) {
    console.log(`[extractVsix] 目标目录已存在，先清理...`);
    await fs.rm(targetDir, { recursive: true, force: true });
  }

  // 创建目标目录
  await fs.mkdir(targetDir, { recursive: true });

  // 检查文件大小
  const stat = await fs.stat(vsixPath);
  console.log(`[extractVsix] 文件大小: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);

  // .vsix 实际上是 zip 文件，使用 unzip 解压
  try {
    console.log(`[extractVsix] 执行 unzip 命令...`);
    // macOS 和 Linux 使用 unzip，-o 自动覆盖，-q 静默模式，增加超时为 5 分钟（300秒）
    const { spawn } = require('child_process');

    await new Promise<void>((resolve, reject) => {
      const unzip = spawn('unzip', ['-o', '-q', vsixPath, '-d', targetDir]);
      let stderr = '';

      const timeout = setTimeout(() => {
        unzip.kill('SIGTERM');
        reject(new Error('解压超时（5分钟）'));
      }, 300000);

      unzip.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      unzip.on('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });

      unzip.on('close', (code: number | null) => {
        clearTimeout(timeout);
        if (code === 0) {
          console.log(`[extractVsix] unzip 完成`);
          resolve();
        } else {
          reject(new Error(`unzip 失败，退出码: ${code}, 错误: ${stderr}`));
        }
      });
    });
  } catch (err) {
    throw new Error(`Failed to extract .vsix file: ${err}`);
  }

  console.log(`[extractVsix] 解压完成，检查目录结构...`);

  // .vsix 内部结构：extension/ 文件夹包含实际扩展内容
  const extensionDir = path.join(targetDir, 'extension');
  if (await exists(extensionDir)) {
    console.log(`[extractVsix] 找到 extension/ 目录`);
    return extensionDir;
  }

  console.log(`[extractVsix] 使用根目录: ${targetDir}`);
  return targetDir;
}

/**
 * 加载扩展的 package.json 清单
 */
export async function loadManifest(extensionPath: string): Promise<ExtensionManifest> {
  const manifestPath = path.join(extensionPath, 'package.json');
  const content = await fs.readFile(manifestPath, 'utf-8');
  return JSON.parse(content);
}

/**
 * 把 `package.json` 的 `main` 解析成磁盘上真实存在的文件。
 *
 * **不能直接拿字面量去判存在。** VS Code 扩展的 `main` 普遍不带扩展名
 * （`"./out/src/extension"`、`"./dist/extension"`）—— 那个写法是给 Node 的 require 用的，
 * require 自己会补 `.js`。按字面量判存在会把一大票正常扩展判成「没有主模块」，
 * 而这条失败路径只打一行日志、不抛错，界面上表现为**「装是装上了，但什么都不会发生」**。
 *
 * 解析顺序照抄 Node：原样 → `.js` → `.json` → `.node` → 当作目录取 `index.js`。
 */
export async function resolveExtensionMainFile(
  extensionPath: string,
  mainFile: string,
): Promise<string | null> {
  const base = path.join(extensionPath, mainFile);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.json`,
    `${base}.node`,
    path.join(base, 'index.js'),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

/**
 * 加载扩展模块
 */
export async function loadExtensionModule(extensionPath: string, mainFile: string): Promise<any> {
  const mainPath = await resolveExtensionMainFile(extensionPath, mainFile);
  if (!mainPath) {
    throw new Error(`Extension main file not found: ${path.join(extensionPath, mainFile)}`);
  }

  try {
    // 动态导入扩展模块
    // 注意：这需要在 Node.js 环境中运行
    return require(mainPath);
  } catch (err) {
    throw new Error(`Failed to load extension module: ${err}`);
  }
}

/**
 * 完整加载扩展
 */
export async function loadExtension(extensionPath: string): Promise<LoadedExtension> {
  console.log(`[loadExtension] 开始加载扩展: ${extensionPath}`);

  // 加载清单
  console.log(`[loadExtension] 读取 package.json...`);
  const manifest = await loadManifest(extensionPath);
  console.log(
    `[loadExtension] 扩展名: ${manifest.displayName || manifest.name}, 版本: ${manifest.version}`,
  );

  // 加载主模块（如果有）
  let mainModule: any;
  let mainModuleError: string | undefined;
  if (manifest.main) {
    console.log(`[loadExtension] 加载主模块: ${manifest.main}`);
    try {
      mainModule = await loadExtensionModule(extensionPath, manifest.main);
      console.log(`[loadExtension] 主模块加载成功`);
    } catch (err: any) {
      mainModuleError = err?.message ?? String(err);
      console.error(`[loadExtension] Failed to load extension main module:`, err);
    }
  } else {
    console.log(`[loadExtension] 无主模块`);
  }

  console.log(`[loadExtension] 扩展加载完成`);
  return {
    manifest,
    extensionPath,
    mainModule,
    ...(mainModuleError ? { mainModuleError } : {}),
  };
}

/**
 * 从 .vsix 文件加载扩展
 */
export async function loadExtensionFromVsix(
  vsixPath: string,
  extractDir: string,
): Promise<LoadedExtension> {
  // 解压 .vsix
  const extensionPath = await extractVsix(vsixPath, extractDir);

  // 加载扩展
  return loadExtension(extensionPath);
}

/**
 * 下载 Claude Code 扩展（带重试机制）
 */
export async function downloadClaudeCodeExtension(
  targetPath: string,
  onProgress?: (progress: { percent: number; downloaded: number; total: number }) => void,
): Promise<string> {
  const extensionId = 'Anthropic.claude-code';
  const downloadUrl = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/Anthropic/vsextensions/claude-code/latest/vspackage`;
  const vsixPath = path.join(targetPath, 'claude-code.vsix');

  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `Downloading ${extensionId} from VS Code Marketplace... (尝试 ${attempt}/${maxRetries})`,
      );
      // 第 2 次起续传：这个包有 122MB，重试从 0 开始意味着前面下的全部白费
      // （日志里那次失败已经下到 75MB 了）。
      return await downloadWithProgress(downloadUrl, vsixPath, onProgress, {
        minBytes: CLAUDE_CODE_MIN_BYTES,
        resume: attempt > 1,
      });
    } catch (err: any) {
      lastError = err;
      console.error(`下载失败 (尝试 ${attempt}/${maxRetries}):`, err.message);

      // **不删分片**：留着下一次续传。只有全部重试都失败时才清掉（见函数末尾）。

      // 如果不是最后一次尝试，等待后重试
      if (attempt < maxRetries) {
        const waitTime = attempt * 2000; // 2秒, 4秒
        console.log(`等待 ${waitTime / 1000} 秒后重试...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }
  }

  // 全部重试都失败了：这才把分片清掉，免得留下一个半截的 .vsix 让人以为装过了
  try {
    await fs.unlink(vsixPath);
  } catch {}

  throw new Error(
    `下载失败（已重试 ${maxRetries} 次）: ${lastError?.message}\n\n建议：\n1. 检查网络连接\n2. 使用"从路径加载"手动安装`,
  );
}

/**
 * 只读文件开头的若干字节。
 *
 * 单独写这个而不是 `readFile().slice(0, 4)`：后者会把整个文件读进内存，
 * 而我们只需要 4 个字节 —— 对一个一百多 MB 的 .vsix 是纯粹的浪费。
 */
async function readFirstBytes(filePath: string, count: number): Promise<Uint8Array> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(count);
    await handle.read(buffer, 0, count, 0);
    return buffer;
  } finally {
    await handle.close();
  }
}

/**
 * 执行下载（内部函数）
 */
/**
 * 通用下载的最小体积。
 *
 * 只用来挡住「HTTP 错误页被当成 .vsix 存下来」这种情形（那种文件通常几百字节到几 KB）。
 * **不要**拿它当「这个扩展该有多大」的判断 —— 扩展体积从几十 KB 到一百多 MB 都有。
 */
export const DOWNLOAD_MIN_BYTES = 1024;

/** Claude Code 的 .vsix 至少这么大（它自带一整套 VS Code 运行时代码）。 */
export const CLAUDE_CODE_MIN_BYTES = 50 * 1024 * 1024;

/** ZIP 文件头：`PK\x03\x04`。.vsix 本质是 ZIP。 */
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

export interface VsixValidationInput {
  size: number;
  /** 文件开头若干字节（至少 4 个） */
  header: Uint8Array;
  minBytes: number;
}

/**
 * 校验下载结果。
 *
 * 抽成纯函数是为了能被测到：原先这段校验**没有任何测试**，而它就藏在通用下载器里，
 * 于是「Claude Code 至少 50MB」这条判据被带进了通用路径 ——
 * 结果是从扩展市场安装任何小于 50MB 的扩展都会失败（也就是几乎所有扩展）。
 * 纯函数 + 单测是唯一能让这种「共享路径里混进特定用途的假设」当场暴露的办法。
 */
export function validateVsix(
  input: VsixValidationInput,
): { ok: true } | { ok: false; reason: string } {
  if (!Number.isFinite(input.size) || input.size <= 0) {
    return { ok: false, reason: '下载的文件为空' };
  }
  if (input.size < input.minBytes) {
    return {
      ok: false,
      reason: `下载的文件太小 (${(input.size / 1024).toFixed(1)}KB，至少需要 ${(input.minBytes / 1024).toFixed(1)}KB)，可能下载不完整`,
    };
  }
  const header = input.header;
  if (header.length < 4) return { ok: false, reason: '下载的文件不完整（读取不到文件头）' };
  for (let i = 0; i < ZIP_SIGNATURE.length; i += 1) {
    if (header[i] !== ZIP_SIGNATURE[i]) {
      return { ok: false, reason: '下载的文件不是有效的 ZIP 文件（文件头损坏）' };
    }
  }
  return { ok: true };
}

/**
 * curl 参数。
 *
 * 几个参数都不是「保险多写几个」，各自对应一类真实失败：
 * - `--http1.1`：一百多 MB 的文件走 HTTP/2 时，CDN 中途 CANCEL 掉流是常见现象
 *   （curl 退出码 92，日志是 `HTTP/2 stream ... was not closed cleanly`）。
 *   降到 HTTP/1.1 是这类问题的标准解法。
 * - `-f`：HTTP 4xx/5xx 直接失败，而不是把错误页写进 .vsix 再靠体积校验兜住。
 * - `--retry*`：让 curl 自己重试瞬时断流。它比外层的「删掉重下」好得多 ——
 *   外层重试是从 0 开始的，一百多 MB 白下。
 * - `-C -`：续传。配合外层重试，第二次从已下载的字节继续。
 */
export function buildCurlArgs(input: {
  downloadUrl: string;
  vsixPath: string;
  resume?: boolean;
}): string[] {
  const args = [
    '-L',
    '-f',
    '--http1.1',
    '--retry',
    '3',
    '--retry-delay',
    '2',
    '--retry-all-errors',
    '--connect-timeout',
    '30',
  ];
  if (input.resume) args.push('-C', '-');
  args.push(input.downloadUrl, '-o', input.vsixPath);
  return args;
}

/**
 * 下载任意一个 .vsix 到本地。
 *
 * 导出成通用下载器（原来只服务「下载 Claude Code」那一条路径）：扩展市场里
 * 每个扩展的地址都不同，各自再写一遍 curl + 进度解析，只会多出若干份要同步维护的副本。
 *
 * `minBytes` 默认只挡错误页；调用方如果有更强的判据（比如 Claude Code 那个 122MB 的包）
 * 再自己传 —— **特定扩展的体积假设不能留在通用路径里**。
 */
export async function downloadVsix(
  downloadUrl: string,
  vsixPath: string,
  onProgress?: (progress: { percent: number; downloaded: number; total: number }) => void,
  opts: { minBytes?: number; resume?: boolean } = {},
): Promise<string> {
  return await downloadWithProgress(downloadUrl, vsixPath, onProgress, opts);
}

async function downloadWithProgress(
  downloadUrl: string,
  vsixPath: string,
  onProgress?: (progress: { percent: number; downloaded: number; total: number }) => void,
  opts: { minBytes?: number; resume?: boolean } = {},
): Promise<string> {
  const minBytes = opts.minBytes ?? DOWNLOAD_MIN_BYTES;
  try {
    // 使用 curl 标准输出来解析进度（包含总大小）
    const { spawn } = require('child_process');

    return await new Promise<string>((resolve, reject) => {
      // 不使用静默模式，解析 curl 的进度输出
      const curl = spawn(
        'curl',
        buildCurlArgs({ downloadUrl, vsixPath, resume: opts.resume === true }),
      );

      let totalSize = 0;
      let stderr = '';

      // curl 的进度输出在 stderr
      curl.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;

        // 解析 curl 进度输出格式：
        // "  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current"
        // "                                 Dload  Upload   Total   Spent    Left  Speed"
        // "  7  100M    7 7500k    0     0   531k      0  0:03:13  0:00:14  0:02:59  880k"
        const lines = chunk.split('\n');
        for (const line of lines) {
          // 匹配进度行：开头是百分比，然后是总大小、百分比、已下载大小
          // 使用 \s+ 来匹配一个或多个空格
          const match = line.match(/^\s*(\d+)\s+([\d.]+)([kMG]?)\s+\d+\s+([\d.]+)([kMG]?)\s+/);
          if (match) {
            const percent = parseInt(match[1]);
            const totalSizeNum = parseFloat(match[2]);
            const totalUnit = match[3] || '';
            const downloadedNum = parseFloat(match[4]);
            const downloadedUnit = match[5] || '';

            // 转换单位为字节
            const unitMultiplier: any = { '': 1, k: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024 };
            const newTotalSize = Math.floor(totalSizeNum * (unitMultiplier[totalUnit] || 1));
            const downloaded = Math.floor(downloadedNum * (unitMultiplier[downloadedUnit] || 1));

            // 更新总大小（只在有效时更新）
            if (newTotalSize > 0) {
              totalSize = newTotalSize;
            }

            // 报告进度（即使是 0% 也报告，便于 UI 显示"下载中"状态）
            if (onProgress) {
              onProgress({
                percent: Math.min(percent, 100),
                downloaded,
                total: totalSize > 0 ? totalSize : downloaded * 2, // 如果总大小未知，估算为已下载的2倍
              });
            }
          }
        }
      });

      curl.on('error', (err: Error) => {
        reject(new Error(`下载失败: ${err.message}`));
      });

      curl.on('close', async (code: number | null) => {
        if (code !== 0) {
          reject(new Error(`下载失败，退出代码: ${code}\n${stderr}`));
          return;
        }

        try {
          const stat = await fs.stat(vsixPath);
          const actualSize = stat.size;

          // 只读前 4 个字节做文件头校验：以前是 readFile 读整份，
          // 对一个 122MB 的包等于在主进程里凭空造一个 122MB 的 Buffer。
          const header = await readFirstBytes(vsixPath, 4);

          const verdict = validateVsix({ size: actualSize, header, minBytes });
          if (!verdict.ok) throw new Error(verdict.reason);

          // 最终进度 100%，使用真实文件大小
          if (onProgress) {
            onProgress({ percent: 100, downloaded: actualSize, total: actualSize });
          }

          console.log(`Downloaded to ${vsixPath} (${(actualSize / 1024 / 1024).toFixed(1)}MB)`);
          resolve(vsixPath);
        } catch (err: any) {
          // 验证失败，删除损坏的文件
          try {
            await fs.unlink(vsixPath);
          } catch {}
          reject(new Error(`下载验证失败: ${err.message}`));
        }
      });
    });
  } catch (err: any) {
    // 清理失败的下载
    try {
      await fs.unlink(vsixPath);
    } catch {}

    throw new Error(`下载失败: ${err.message}`);
  }
}

/**
 * 检查文件/目录是否存在
 */
async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
