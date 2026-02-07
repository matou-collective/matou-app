/**
 * electron-builder afterPack hook
 * Patches the Linux executable wrapper to pass --no-sandbox.
 *
 * AppImages extract to a FUSE mount where files can't be owned by root,
 * so the SUID chrome-sandbox binary doesn't work. This is the standard
 * fix used by VS Code, Brave, and other Electron apps on Linux.
 */
const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;

  // Find the main executable: it's the ELF binary that isn't chrome-sandbox
  // or chrome_crashpad_handler. Use executableName from the packager.
  const appOutDir = context.appOutDir;
  const executableName = context.packager.executableName;
  const executablePath = path.join(appOutDir, executableName);

  if (!fs.existsSync(executablePath)) {
    console.warn(`[afterPack] Executable not found at ${executablePath}, skipping`);
    return;
  }

  const realBinary = executablePath + '.bin';
  fs.renameSync(executablePath, realBinary);

  const wrapperScript = `#!/bin/bash
DIR="$(dirname "$(readlink -f "$0")")"
exec "$DIR/${path.basename(realBinary)}" --no-sandbox "$@"
`;
  fs.writeFileSync(executablePath, wrapperScript, { mode: 0o755 });
  console.log(`[afterPack] Created --no-sandbox wrapper: ${executableName}`);
};
