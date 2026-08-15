#!/usr/bin/env node
'use strict';

/**
 * Rebuild the addon against Electron's ABI.
 *
 * @electron/rebuild targets native modules inside node_modules; this addon is
 * part of the app itself, so we drive node-gyp directly. Written in JS rather
 * than a shell one-liner so it works identically on Windows CI.
 */

const { spawnSync } = require('node:child_process');

const electronVersion = require('electron/package.json').version;
const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js');

const args = [
  nodeGyp,
  'rebuild',
  '--runtime=electron',
  `--target=${electronVersion}`,
  '--dist-url=https://electronjs.org/headers',
  `--arch=${process.arch}`,
];

console.log(`Rebuilding addon for Electron ${electronVersion} (${process.platform}/${process.arch})`);

const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
