#!/usr/bin/env node
/**
 * 打包 Cursor VSIX 扩展。
 *
 * esbuild 已将 @deepseek-ide/* 依赖打包进 extension.js，
 * vsce 打包时不能有 workspace symlink 依赖，因此需要：
 * 1. 复制 build 产物到临时目录
 * 2. 清理 package.json（移除 dependencies / devDependencies / scripts）
 * 3. 在该临时目录中运行 vsce package
 * 4. 将 .vsix 复制回源目录
 */

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, '../packages/cursor-extension');
const OUT_VSIX = join(EXT_DIR, 'deepseek-cursor-connector.vsix');
const BUILD_JS = join(EXT_DIR, 'out/extension.js');

if (!existsSync(BUILD_JS)) {
  console.error('❌ 请先运行 npm run build');
  process.exit(1);
}

// 创建临时目录
const tmpDir = join(tmpdir(), `deepseek-vsix-${Date.now()}`);
mkdirSync(join(tmpDir, 'out'), { recursive: true });

// 复制必需文件
cpSync(BUILD_JS, join(tmpDir, 'out/extension.js'));

const pkg = JSON.parse(readFileSync(join(EXT_DIR, 'package.json'), 'utf-8'));
// 清理：vsce 处理不了 workspace symlink 依赖
delete pkg.dependencies;
delete pkg.devDependencies;
delete pkg.scripts;
writeFileSync(join(tmpDir, 'package.json'), JSON.stringify(pkg, null, 2));

// 打包
console.log('📦 打包 VSIX...');
execSync('npx --yes @vscode/vsce package --out .', {
  cwd: tmpDir,
  stdio: 'inherit',
});

// 复制结果
const vsixName = `${pkg.name}-${pkg.version}.vsix`;
const vsixPath = join(tmpDir, vsixName);
if (existsSync(vsixPath)) {
  cpSync(vsixPath, OUT_VSIX);
  console.log(`✅ VSIX 已生成: ${OUT_VSIX} (${(readFileSync(OUT_VSIX).length / 1024).toFixed(1)} KB)`);
} else {
  console.error(`❌ 未找到 VSIX 文件: ${vsixPath}`);
  process.exit(1);
}

// 清理
rmSync(tmpDir, { recursive: true });
