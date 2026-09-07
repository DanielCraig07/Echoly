#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function run(cmd, options = {}) {
  return execSync(cmd, { stdio: 'inherit', ...options });
}

function runCapture(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

const arg = process.argv[2];
if (!arg) {
  console.log('💡 用法: npm run release <新版本号或 patch/minor/major>');
  console.log('   例如: npm run release 0.0.5');
  console.log('   或者: npm run release patch (自动在 0.0.4 基础上递增到 0.0.5)');
  process.exit(1);
}

// 检查当前 Git 工作区是否有未提交的代码
const status = runCapture('git status --porcelain');
// 允许带有未提交的改动，但给出提示
if (status) {
  console.log('⚠️  检测到当前工作区有未提交的改动:');
  console.log(status);
  console.log('建议先提交或暂存现有改动，以避免混入发布 commit。');
}

// 获取当前版本号
const rootPkgPath = path.resolve(__dirname, '../package.json');
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8'));
const currentVersion = rootPkg.version;

let targetVersion = arg.replace(/^v/i, '').trim();

if (['patch', 'minor', 'major'].includes(targetVersion)) {
  const parts = currentVersion.split('.').map(Number);
  if (parts.length < 3 || parts.some(isNaN)) {
    console.error(`无法根据当前版本 "${currentVersion}" 自动计算递增版本`);
    process.exit(1);
  }
  if (targetVersion === 'patch') parts[2]++;
  if (targetVersion === 'minor') { parts[1]++; parts[2] = 0; }
  if (targetVersion === 'major') { parts[0]++; parts[1] = 0; parts[2] = 0; }
  targetVersion = parts.join('.');
}

const tag = `v${targetVersion}`;

console.log(`\n🚀 准备发布版本: ${tag} (当前: v${currentVersion})`);

// 1. 同步各 package.json 的版本号
run(`node ${path.join(__dirname, 'sync-version.js')} ${targetVersion}`);

// 2. 尝试同步更新 package-lock.json（快速更新）
try {
  run('npm install --package-lock-only --ignore-scripts');
} catch (e) {
  // 如果失败不阻断
}

// 3. Git 提交与打 Tag
const filesToAdd = ['package.json', 'apps/desktop/package.json', 'package-lock.json'];
const existingFiles = filesToAdd.filter((f) => fs.existsSync(path.resolve(__dirname, '..', f)));

console.log(`\n📌 正在暂存并创建 Git Commit: chore: release ${tag}`);
run(`git add ${existingFiles.join(' ')}`);

try {
  run(`git commit -m "chore: release ${tag}"`);
} catch (e) {
  console.log('ℹ️ 文件内容无变化或已提交。');
}

console.log(`\n🏷️ 正在创建 Git Tag: ${tag}`);
// 检查 tag 是否已存在
const tagExists = runCapture(`git tag -l "${tag}"`);
if (tagExists) {
  console.error(`❌ Tag "${tag}" 已经存在！如需重新发布请先删除旧 tag: git tag -d ${tag}`);
  process.exit(1);
}

run(`git tag -a ${tag} -m "Release ${tag}"`);

console.log('\n========================================');
console.log(`🎉 版本 ${tag} 创建成功！`);
console.log('推送并触发 GitHub Actions 自动打包构建:');
console.log(`   git push && git push origin ${tag}`);
console.log('========================================\n');
