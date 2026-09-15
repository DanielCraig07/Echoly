const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * electron-builder afterPack hook for macOS.
 * Ensures the generated .app bundle and its helpers are properly ad-hoc signed
 * with resources/entitlements.mac.plist even when no Apple Developer Certificate
 * is configured (identity: null).
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  if (!fs.existsSync(appPath)) return;

  const entitlementsPath = path.join(__dirname, '..', 'resources', 'entitlements.mac.plist');
  if (!fs.existsSync(entitlementsPath)) return;

  console.log(`[after-pack] Re-signing ${appPath} with entitlements: ${entitlementsPath}`);
  try {
    execSync(
      `codesign --force --deep --sign - --entitlements "${entitlementsPath}" "${appPath}"`,
      { stdio: 'inherit' },
    );
    console.log('[after-pack] Ad-hoc re-sign with entitlements completed successfully');
  } catch (err) {
    console.warn('[after-pack] codesign warning:', err && err.message ? err.message : err);
  }
};
