#!/usr/bin/env node
'use strict';

/**
 * Make the macOS menu bar say "CV-Lab" in development.
 *
 * Everything else the OS displays comes from app.setName() and productName,
 * and those already work. The bold menu title immediately right of the Apple
 * menu does not: macOS reads it from the RUNNING BUNDLE's Info.plist, and
 * `electron .` runs Electron's own bundle. So in development it says
 * "Electron" no matter what the app calls itself.
 *
 * The packaged app is unaffected and always has been -- electron-builder
 * writes CFBundleName from productName, so dist/mac-arm64/CV-Lab.app is
 * already correct. This is a development-only cosmetic fix.
 *
 * It edits node_modules, which is worth being uncomfortable about. Three
 * things keep it contained: the bundle is this project's own devDependency
 * and not shared with anything else, the change is idempotent, and it is
 * reapplied by postinstall whenever npm restores the tree.
 *
 * Never fatal. A branded menu bar is not worth failing an install over, so
 * every failure here is a warning and exit 0.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DISPLAY_NAME = 'CV-Lab';
const PLIST = path.join(__dirname, '..', 'node_modules', 'electron', 'dist',
  'Electron.app', 'Contents', 'Info.plist');

function main() {
  // CFBundleName is a macOS concept; there is nothing to do elsewhere.
  if (process.platform !== 'darwin') return;
  if (!fs.existsSync(PLIST)) return;   // electron not installed yet, or not a mac build

  const read = (key) => {
    try {
      return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, PLIST],
        { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  const write = (key, value) => {
    const verb = read(key) === null ? 'Add' : 'Set';
    const arg = verb === 'Add' ? `Add :${key} string ${value}` : `Set :${key} ${value}`;
    execFileSync('/usr/libexec/PlistBuddy', ['-c', arg, PLIST]);
  };

  if (read('CFBundleName') === DISPLAY_NAME) return;   // already branded

  write('CFBundleName', DISPLAY_NAME);
  write('CFBundleDisplayName', DISPLAY_NAME);
  console.log(`brand-dev-electron — the development menu bar now reads "${DISPLAY_NAME}"`);
}

try {
  main();
} catch (err) {
  console.warn(`brand-dev-electron — skipped: ${err.message}`);
}
