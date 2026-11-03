/**
 * 扩展「装上之后能不能用」的验证脚本。
 *
 * 为什么需要它：安装链路有三段（下载 → 解压加载 → 激活），任何一段坏掉，
 * 界面上看起来都一样 —— 「装好了但没反应」。而这三段全都能在**纯 Node** 里跑：
 * - 下载走 curl（与主进程同一个函数）；
 * - 解压加载走 `unzip` + 读 package.json；
 * - 激活不需要 Electron —— `ExtensionHost` 的 `vscode` 模块注入是
 *   `Module.prototype.require` 打补丁，纯 Node 机制。
 *
 * 所以「装了能不能用」不再只能靠人肉点一遍：跑 `npm run verify:extension`
 * 就会真的从 Open VSX 下一个扩展、解压、加载、激活，并断言它注册了东西。
 *
 * 用法：npm run verify:extension [publisher.name]
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { downloadVsix, loadExtensionFromVsix } from '../packages/vscode-shim/src/extensionLoader';
import { ExtensionHost } from '../packages/vscode-shim/src/extensionHost';
import { buildDownloadUrl } from '../packages/vscode-shim/src/openVsx';
import { writeVscodeShimModule } from '../packages/vscode-shim/src/vscodeShimModule';

const registry = 'https://open-vsx.org';
const extensionId = process.argv[2] ?? 'christian-kohler.npm-intellisense';

async function main() {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'echoly-ext-verify-'));
  const [namespace, name] = extensionId.split('.');
  if (!namespace || !name) throw new Error(`扩展 id 不合法：${extensionId}`);

  // 1) 问注册表要版本与下载地址（和面板里点「安装」走的是同一条）
  const metaRes = await fetch(`${registry}/api/${namespace}/${name}`, {
    headers: { Accept: 'application/json' },
  });
  if (!metaRes.ok) throw new Error(`注册表返回 ${metaRes.status}`);
  const meta = (await metaRes.json()) as { version: string; files?: { download?: string } };
  const downloadUrl = buildDownloadUrl(
    registry,
    namespace,
    name,
    meta.version,
    meta.files?.download,
  );
  console.log(`→ 下载 ${extensionId}@${meta.version}`);

  // 2) 下载（与主进程同一个函数，含重试与断点续传）
  const vsixPath = path.join(workDir, `${extensionId}.vsix`);
  await downloadVsix(downloadUrl, vsixPath);
  const size = (await fs.stat(vsixPath)).size;
  console.log(`✓ 下载完成 ${(size / 1024).toFixed(0)}KB`);

  // 3) 先起扩展宿主，再解压加载。
  //    顺序不能反：`require('vscode')` 能解析到东西，靠的是 ExtensionHost 构造时
  //    对 `Module.prototype.require` 打的补丁 —— 主进程里也是这个顺序（宿主先于安装存在）。
  const registered: string[] = [];
  const host = new ExtensionHost({
    workspaceRoot: workDir,
    onCommand: async (command: string) => {
      registered.push(command);
      return undefined;
    },
    onMessage: () => {},
  });
  // 同时把磁盘上的 shim 写出来：ESM 形式的扩展（`import 'vscode'`）绕不过 require 补丁，
  // 只能靠真的模块文件解析到 —— 主进程里由 ExtensionManager 在构造时做同一件事。
  await writeVscodeShimModule(path.join(workDir, 'node_modules'), Object.keys(host.vscodeApi));

  // 4) 解压 + 加载
  const loaded = await loadExtensionFromVsix(vsixPath, path.join(workDir, 'ext'));
  console.log(
    `✓ 加载清单 ${loaded.manifest.publisher}.${loaded.manifest.name}@${loaded.manifest.version}`,
  );
  if (loaded.manifest.main && !loaded.mainModule) {
    // 主模块加载失败会被 loadExtension 吞掉（只打日志），这里必须显式失败：
    // 「包里没有 main 文件」和「main 加载崩了」在界面上完全一样，但原因不同。
    throw new Error(`主模块加载失败：${loaded.manifest.main}`);
  }

  // 5) 激活
  await host.activateExtension(loaded);
  console.log('✓ 激活成功');

  console.log(
    `\n命令注册：${registered.length > 0 ? registered.join(', ') : '（该扩展没有注册命令）'}`,
  );
  await fs.rm(workDir, { recursive: true, force: true });
  console.log('\n✓ 扩展安装链路（下载 → 解压加载 → 激活）全部通过');
}

main().catch((err) => {
  console.error('\n✗ 验证失败：', err?.message ?? err);
  process.exit(1);
});
