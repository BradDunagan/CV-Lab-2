#!/usr/bin/env node
'use strict';

/**
 * Refuse to run under a Node this project does not support, and say so.
 *
 * package.json has declared `engines: { node: ">=22.12.0" }` from the start,
 * and npm treats that as advice: it prints a warning nobody reads and carries
 * on. What the user actually got was this, from three layers inside the build:
 *
 *     SyntaxError: The requested module 'node:util' does not provide an
 *     export named 'styleText'
 *
 * which names neither the cause nor the fix.
 *
 * Nothing here is new, either. node-gyp 13's bundled undici breaks on Node 20,
 * Vite needs 20.19+/22.12+, and CI has always run 22. The requirement only
 * became VISIBLE when the renderer became a Vite build: before that, `npm
 * start` ran `electron .`, which uses Electron's own bundled Node and never
 * touched the one on PATH.
 *
 * Deliberately dependency-free and written in old syntax, because it runs as a
 * preinstall hook -- before node_modules exists, on whatever Node is present,
 * including one far too old to parse anything modern.
 *
 *   node scripts/check-node.js
 */

var required = require('../package.json').engines.node; // ">=22.12.0"
var minimum = required.replace(/[^0-9.]/g, '').split('.').map(Number);
var actual = process.versions.node.split('.').map(Number);

function older(a, b) {
  for (var i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  }
  return false;
}

if (older(actual, minimum)) {
  var lines = [
    '',
    'cv-lab-2 needs Node ' + required + ', and this is v' + process.versions.node + '.',
    '  ' + process.execPath,
    '',
    'There is an .nvmrc in the project root, so from this directory:',
    '',
    '    nvm use',
    '',
    'If that reports the version is not installed:',
    '',
    '    nvm install',
    '',
    'A shell that keeps landing on an old Node usually has an nvm default',
    'pointing at a version that is not installed -- `nvm ls` shows it as',
    '"-> system". Fix it once with:',
    '',
    '    nvm alias default 22',
    '',
  ];
  console.error(lines.join('\n'));
  process.exit(1);
}
