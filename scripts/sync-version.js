#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 1. 尝试按优先级获取目标版本号：
// - 命令行参数 (如: node scripts/sync-version.js 0.0.5)
// - 环境变量 GITHUB_REF_NAME (GitHub Actions push tag 时自动提供，如 "v0.0.5")
// - 环境变量 RELEASE_VERSION
// - 本地 Git 当前所在 commit 的 tag 或最近的 tag
let rawVersion =
  process.argv[2] ||
  process.env.RELEASE_VERSION ||
  process.env.GITHUB_REF_NAME;

if (!rawVersion) {
  try {
    rawVersion = execSync(
      'git describe --tags --exact-match 2>/dev/null || git describe --tags --abbrev=0 2>/dev/null',
      { encoding: 'utf-8' }
    ).trim();
  } catch {
    // 未打 tag 或无法检测
  }
}

if (!rawVersion) {
  console.error('❌ 未指定版本号，且无法从当前 Git Tag 自动检测。');
  console.error('用法: node scripts/sync-version.js <tag或版本号> (例如: node scripts/sync-version.js v0.0.5)');
  process.exit(1);
}

// 规范化：去除 "refs/tags/" 前缀以及开头的 "v"
const cleanVersion = rawVersion
  .replace(/^refs\/tags\//, '')
  .replace(/^v/i, '')
  .trim();

// 简单的 SemVer 校验
if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(cleanVersion)) {
  console.error(`❌ 非法版本号格式: "${rawVersion}" (解析为 "${cleanVersion}")`);
  console.error('版本号必须符合 SemVer 格式，例如: 0.0.5 或 1.0.0-beta.1');
  process.exit(1);
}

console.log(`🔍 检测到版本号: ${cleanVersion} (原始输入/Tag: "${rawVersion}")`);

const rootDir = path.resolve(__dirname, '..');
const filesToUpdate = [
  path.join(rootDir, 'package.json'),
  path.join(rootDir, 'apps', 'desktop', 'package.json'),
];

let changedCount = 0;
for (const filePath of filesToUpdate) {
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const pkg = JSON.parse(content);
    const oldVersion = pkg.version;
    if (oldVersion !== cleanVersion) {
      pkg.version = cleanVersion;
      fs.writeFileSync(filePath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
      console.log(`  ✓ 更新 ${path.relative(rootDir, filePath)}: ${oldVersion} -> ${cleanVersion}`);
      changedCount++;
    } else {
      console.log(`  - 保持 ${path.relative(rootDir, filePath)}: 已经是 ${cleanVersion}`);
    }
  }
}

// 同步 packages/shared/src/index.ts 的 APP_VERSION
const sharedIndexPath = path.join(rootDir, 'packages', 'shared', 'src', 'index.ts');
if (fs.existsSync(sharedIndexPath)) {
  const content = fs.readFileSync(sharedIndexPath, 'utf-8');
  const updated = content.replace(
    /export const APP_VERSION = ['"][^'"]+['"];/,
    `export const APP_VERSION = '${cleanVersion}';`
  );
  if (updated !== content) {
    fs.writeFileSync(sharedIndexPath, updated, 'utf-8');
    console.log(`  ✓ 更新 ${path.relative(rootDir, sharedIndexPath)}: APP_VERSION -> '${cleanVersion}'`);
    changedCount++;
  } else {
    console.log(`  - 保持 ${path.relative(rootDir, sharedIndexPath)}: APP_VERSION 已经是 '${cleanVersion}'`);
  }
}

console.log(`✅ 版本号同步完成 (共更新 ${changedCount} 个文件)`);
