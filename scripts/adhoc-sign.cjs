// electron-builder afterPack hook: ad-hoc sign the .app so macOS shows the
// normal "Open Anyway" flow instead of "DIRT is damaged" on other Macs.
// (No Apple Developer ID, so this is not notarized.)
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // Universal builds pack each arch into a *-temp dir first and merge them;
  // signing those halves breaks the merge, so only sign the final app.
  if (path.basename(context.appOutDir).endsWith('-temp')) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
