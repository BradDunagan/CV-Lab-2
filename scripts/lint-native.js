#!/usr/bin/env node
'use strict';

/**
 * Strict syntax check of the pure-C sources.
 *
 * Exists because `posix_memalign` was implicitly declared on every Linux build
 * for weeks and nobody noticed: macOS declares it unconditionally, so it never
 * appeared locally, and CI logs were only ever searched for "error". An
 * implicit declaration is undefined behaviour that happens to work, and gcc 14
 * rejects it outright — a build break waiting for a newer runner image.
 *
 * Only buffer.c, kernels.c and render.c are checked: they include no Node
 * headers, so they compile standalone, and they are where the portability risk
 * lives. The addon_*.c files need node_api.h and are covered by the real build.
 *
 * IMPORTANT: running this on macOS would NOT have caught the bug that prompted
 * it. Apple's stdlib.h declares posix_memalign unconditionally, so the code
 * compiles silently here and warns only against glibc. Verified by
 * reintroducing the bug locally: clean. The check therefore earns its keep in
 * CI, on Linux, and is a weaker signal on a developer machine.
 *
 * That is the general shape of the problem: a check that runs in one place
 * can pass for the wrong reason. Anything about platform differences has to
 * run on the platforms.
 *
 *   npm run lint:native
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCES = ['native/buffer.c', 'native/kernels.c', 'native/render.c'];
const FLAGS = ['-std=c11', '-Wall', '-Wextra', '-pedantic', '-fsyntax-only', '-I', 'native'];

const compiler = process.env.CC || 'cc';
const result = spawnSync(compiler, [...FLAGS, ...SOURCES], { cwd: ROOT, encoding: 'utf8' });

if (result.error) {
  console.error(`lint:native — could not run ${compiler}: ${result.error.message}`);
  process.exit(1);
}

const output = `${result.stdout}${result.stderr}`.trim();
if (output) {
  console.error(output);
  console.error(`\nlint:native FAILED — ${compiler} reported the above.`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`lint:native FAILED — ${compiler} exited ${result.status}`);
  process.exit(1);
}

console.log(`lint:native — ${SOURCES.length} sources clean under ${FLAGS.slice(0, 4).join(' ')}`);
