#!/usr/bin/env node
'use strict';

/**
 * `npm run test:wasm` -- the WebAssembly build checked against the addon:
 * test/wasm.js side by side in one process, then every suite that runs under
 * plain node run again with CVLAB_BACKEND=wasm, test/determinism.js among
 * them, so the hashes written for the addon are the module's acceptance test.
 *
 * A script rather than `CVLAB_BACKEND=wasm node ...` in package.json because
 * Windows' cmd has no such syntax, and this has to run on all three runners:
 * the module is the same bytes everywhere, the engines running it are not.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SUITES = ['smoke', 'buffer', 'kernels', 'arcs', 'render', 'registry', 'session', 'png', 'corners',
  'explain', 'groundtruth', 'gapsweep', 'position', 'pairs', 'determinism', 'readme'];

const run = (file, env) => spawnSync(process.execPath, [path.join('test', `${file}.js`)],
  { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } }).status;

const failed = [];
if (run('wasm', {}) !== 0) failed.push('wasm');
for (const suite of SUITES) {
  console.log(`\n--- ${suite} (CVLAB_BACKEND=wasm)`);
  if (run(suite, { CVLAB_BACKEND: 'wasm' }) !== 0) failed.push(suite);
}
console.log(failed.length ? `\ntest:wasm FAILED: ${failed.join(', ')}` : `\ntest:wasm: ${SUITES.length + 1} suites passed on the WebAssembly build`);
process.exit(failed.length ? 1 : 0);
