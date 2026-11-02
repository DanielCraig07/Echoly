#!/usr/bin/env node
/**
 * 把远端 runner 打成一个自包含的 .mjs。
 *
 * 为什么必须自包含：远端主机上**只有用户的项目**，没有本项目的代码、也不该为了跑一个任务
 * 去 npm install（企业内网常常装不上）。所以把 runner 连同它的依赖（agent / tools / llm）
 * 打成一个文件拷过去，远端只需要一个 `node`。
 *
 * 两个刻意的选择：
 * 1. **不打包本地 embedding**。`@huggingface/transformers` 是动态 import 的，
 *    只有语义检索会用到，而远端压根没有代码库索引能力。把它标成 external，
 *    打包结果才不会从 200KB 膨胀到几十 MB，也不会把 onnxruntime 的原生库拖进来。
 *    远端真的走到那条路时，动态 import 会失败并被上层当作「不可用」——
 *    这正是我们想要的降级（Agent 会得到明确的「不可用」，而不是一个空结果）。
 * 2. **banner 里带上协议版本号**。IDE 上传前会先问远端的 sha，从而判断要不要重传；
 *    版本号写进文件头，是为了万一 sha 比不了（比如远端没有 sha256sum 也没有 shasum）时，
 *    还能靠头部注释认出这是哪一版。
 */

import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const entry = path.join(root, 'packages/runner/src/main.ts');
const outDir = path.join(root, 'packages/runner/dist');
const outFile = path.join(outDir, 'echoly-runner.mjs');

/** 与 IDE 侧 protocol.ts / runner 的 RUNNER_VERSION 一致。 */
const RUNNER_VERSION = '1';

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // Node 内置模块不用打（远端一定有）；transformers 见文件头第 1 条
  external: ['@huggingface/transformers', 'onnxruntime-node', 'sharp'],
  banner: {
    js: `// Echoly remote agent runner v${RUNNER_VERSION} — 由 scripts/build-runner.mjs 生成，请勿手工编辑`,
  },
  logLevel: 'warning',
});

const content = readFileSync(outFile);
const sha = createHash('sha256').update(content).digest('hex');
// 把 sha 与版本一起写到一个旁挂文件：IDE 侧打包时读它，用来判断远端那份是否需要更新
writeFileSync(
  path.join(outDir, 'runner-manifest.json'),
  `${JSON.stringify({ version: RUNNER_VERSION, sha256: sha, bytes: content.length }, null, 2)}\n`,
  'utf8',
);

console.log(
  `[build-runner] ${path.relative(root, outFile)}  ${(content.length / 1024).toFixed(1)} KB  sha256=${sha.slice(0, 12)}`,
);
