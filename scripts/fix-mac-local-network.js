/**
 * macOS 局域网访问权限（Local Network Access）配置脚本。
 *
 * macOS 15 (Sequoia) 强化了局域网安全隐私限制。开发环境下运行 Electron 时，
 * 若 node_modules/electron/dist/Electron.app 的 Info.plist 中未声明
 * NSLocalNetworkUsageDescription，macOS 会静默拦截一切向局域网 IP（192.168.x.x 等）
 * 的连接请求，导致 SSH 报错 "No route to host (EHOSTUNREACH)"，且无法触发系统授权弹窗。
 *
 * 此脚本检测并在开发用 Electron.app 中注入 NSLocalNetworkUsageDescription，
 * 并重新进行本地 ad-hoc 签名，确保本地开发调试与局域网 SSH 连通正常。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fixMacLocalNetwork() {
  if (process.platform !== 'darwin') return;

  const electronAppPath = path.join(
    __dirname,
    '..',
    'node_modules',
    'electron',
    'dist',
    'Electron.app',
  );
  const plistPath = path.join(electronAppPath, 'Contents', 'Info.plist');

  if (!fs.existsSync(plistPath)) {
    return;
  }

  let content = fs.readFileSync(plistPath, 'utf8');

  let modified = false;

  // 检查是否已经存在 NSLocalNetworkUsageDescription
  if (!content.includes('<key>NSLocalNetworkUsageDescription</key>')) {
    console.log('[fix-mac-network] Injecting NSLocalNetworkUsageDescription into Electron.app...');
    const injection = `\t<key>NSLocalNetworkUsageDescription</key>\n\t<string>Echoly 需要访问本地局域网以连接远程 SSH 服务器及内网 AI 服务。</string>\n`;
    if (content.includes('</dict>\n</plist>')) {
      content = content.replace('</dict>\n</plist>', `${injection}</dict>\n</plist>`);
    } else if (content.includes('</dict></plist>')) {
      content = content.replace('</dict></plist>', `${injection}</dict></plist>`);
    } else {
      content = content.replace('<dict>', `<dict>\n${injection}`);
    }
    modified = true;
  }

  // 检查是否已经存在 NSBonjourServices
  if (!content.includes('<key>NSBonjourServices</key>')) {
    console.log('[fix-mac-network] Injecting NSBonjourServices into Electron.app...');
    const bonjourInjection = `\t<key>NSBonjourServices</key>\n\t<array>\n\t\t<string>_ssh._tcp</string>\n\t\t<string>_sftp-ssh._tcp</string>\n\t\t<string>_lnp._tcp</string>\n\t</array>\n`;
    if (content.includes('</dict>\n</plist>')) {
      content = content.replace('</dict>\n</plist>', `${bonjourInjection}</dict>\n</plist>`);
    } else if (content.includes('</dict></plist>')) {
      content = content.replace('</dict></plist>', `${bonjourInjection}</dict></plist>`);
    } else {
      content = content.replace('<dict>', `<dict>\n${bonjourInjection}`);
    }
    modified = true;
  }

  if (!modified) {
    return;
  }

  fs.writeFileSync(plistPath, content, 'utf8');

  // 修改了 Info.plist 后，需要对 Electron.app 重新做 ad-hoc 签名
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', electronAppPath], {
      stdio: 'ignore',
    });
    console.log('[fix-mac-network] Ad-hoc re-signed Electron.app successfully');
  } catch (err) {
    console.warn('[fix-mac-network] codesign warning:', err?.message || err);
  }
}

fixMacLocalNetwork();
