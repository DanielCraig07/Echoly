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
 * 加载扩展模块
 */
export async function loadExtensionModule(extensionPath: string, mainFile: string): Promise<any> {
  const mainPath = path.join(extensionPath, mainFile);

  // 检查文件是否存在
  if (!(await exists(mainPath))) {
    throw new Error(`Extension main file not found: ${mainPath}`);
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
  console.log(`[loadExtension] 扩展名: ${manifest.displayName || manifest.name}, 版本: ${manifest.version}`);

  // 加载主模块（如果有）
  let mainModule: any;
  if (manifest.main) {
    console.log(`[loadExtension] 加载主模块: ${manifest.main}`);
    try {
      mainModule = await loadExtensionModule(extensionPath, manifest.main);
      console.log(`[loadExtension] 主模块加载成功`);
    } catch (err) {
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
  onProgress?: (progress: { percent: number; downloaded: number; total: number }) => void
): Promise<string> {
  const extensionId = 'Anthropic.claude-code';
  const downloadUrl = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/Anthropic/vsextensions/claude-code/latest/vspackage`;
  const vsixPath = path.join(targetPath, 'claude-code.vsix');
  
  const maxRetries = 3;
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Downloading ${extensionId} from VS Code Marketplace... (尝试 ${attempt}/${maxRetries})`);
      return await downloadWithProgress(downloadUrl, vsixPath, onProgress);
    } catch (err: any) {
      lastError = err;
      console.error(`下载失败 (尝试 ${attempt}/${maxRetries}):`, err.message);
      
      // 删除部分下载的文件
      try {
        await fs.unlink(vsixPath);
      } catch {}
      
      // 如果不是最后一次尝试，等待后重试
      if (attempt < maxRetries) {
        const waitTime = attempt * 2000; // 2秒, 4秒
        console.log(`等待 ${waitTime / 1000} 秒后重试...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // 所有重试都失败了
  throw new Error(`下载失败（已重试 ${maxRetries} 次）: ${lastError?.message}\n\n建议：\n1. 检查网络连接\n2. 使用"从路径加载"手动安装`);
}

/**
 * 执行下载（内部函数）
 */
async function downloadWithProgress(
  downloadUrl: string,
  vsixPath: string,
  onProgress?: (progress: { percent: number; downloaded: number; total: number }) => void
): Promise<string> {
  
  try {
    // 使用 curl 标准输出来解析进度（包含总大小）
    const { spawn } = require('child_process');
    
    return await new Promise<string>((resolve, reject) => {
      // 不使用静默模式，解析 curl 的进度输出
      const curl = spawn('curl', [
        '-L',
        downloadUrl,
        '-o',
        vsixPath
      ]);

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
            const unitMultiplier: any = { '': 1, 'k': 1024, 'M': 1024 * 1024, 'G': 1024 * 1024 * 1024 };
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
                total: totalSize > 0 ? totalSize : downloaded * 2 // 如果总大小未知，估算为已下载的2倍
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
          // 获取真实的文件大小
          const stat = await fs.stat(vsixPath);
          const actualSize = stat.size;
          
          // 验证文件大小（Claude Code 扩展至少 50MB）
          if (actualSize < 50 * 1024 * 1024) {
            throw new Error(`下载的文件太小 (${(actualSize / 1024 / 1024).toFixed(1)}MB)，可能下载不完整`);
          }
          
          // 验证 ZIP 文件头（.vsix 是 ZIP 格式）
          const buffer = await fs.readFile(vsixPath);
          const zipSignature = buffer.slice(0, 4);
          // ZIP 文件头: 50 4B 03 04 (PK\x03\x04)
          if (zipSignature[0] !== 0x50 || zipSignature[1] !== 0x4B || 
              zipSignature[2] !== 0x03 || zipSignature[3] !== 0x04) {
            throw new Error('下载的文件不是有效的 ZIP 文件（文件头损坏）');
          }
          
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
