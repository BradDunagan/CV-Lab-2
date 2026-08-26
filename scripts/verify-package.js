#!/usr/bin/env node
'use strict';

/**
 * Assert that packaging actually produced a loadable app.
 *
 * This exists because the failure mode it catches is invisible everywhere
 * else: the addon compiles, CI goes green, installers are produced -- and the
 * app dies on launch because the .node never made it into the bundle, or made
 * it in but is stranded inside app.asar where dlopen cannot reach it.
 *
 * Since the renderer became a Vite build there is a second thing that can be
 * absent from a perfectly green build: the bundle itself. src/renderer/ is
 * Svelte source that only Vite can read and is deliberately NOT packaged, so
 * if dist-renderer/ is missing the window has nothing to load and the app
 * opens on an error dialog. Same shape of failure, same place to catch it.
 *
 *   node scripts/verify-package.js
 */

const fs = require('node:fs');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist');

function walk(dir, depth = 0) {
  if (depth > 8) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    out.push(full);
    if (entry.isDirectory()) out.push(...walk(full, depth + 1));
  }
  return out;
}

if (!fs.existsSync(DIST)) {
  console.error(`FAIL: no dist/ directory -- packaging did not run`);
  process.exit(1);
}

const all = walk(DIST);
const problems = [];

// 1. An app.asar must exist somewhere in the packaged output.
const asars = all.filter((p) => path.basename(p) === 'app.asar');
if (asars.length === 0) {
  problems.push('no app.asar found in dist/ -- asar packaging did not happen');
}

// 2. Every app.asar must have a sibling app.asar.unpacked containing our addon.
//    This is the ASAR trap: dlopen cannot read from inside the archive.
for (const asar of asars) {
  const unpacked = `${asar}.unpacked`;
  if (!fs.existsSync(unpacked)) {
    problems.push(`${path.relative(DIST, asar)}: no app.asar.unpacked sibling -- asarUnpack did not match anything`);
    continue;
  }
  const nodes = walk(unpacked).filter((p) => p.endsWith('.node'));
  if (nodes.length === 0) {
    problems.push(`${path.relative(DIST, unpacked)}: contains no .node file -- the addon was dropped or left inside the archive`);
  } else {
    for (const n of nodes) {
      const size = fs.statSync(n).size;
      if (size < 1024) {
        problems.push(`${path.relative(DIST, n)}: suspiciously small (${size} bytes)`);
      }
      console.log(`  ok   ${path.relative(DIST, n)} (${(size / 1024).toFixed(1)} KB)`);
    }
  }
}

// 3. The built renderer must be inside the archive.
//     It goes IN the asar rather than beside it: unlike a .node, it is read by
//     Chromium through Electron's patched fs, which reads the archive fine.
const { execFileSync } = require('node:child_process');
for (const asar of asars) {
  let listing = '';
  try {
    listing = execFileSync('npx', ['asar', 'list', asar], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    problems.push(`${path.relative(DIST, asar)}: could not be listed -- is it a valid asar?`);
    continue;
  }
  const lines = listing.split('\n');
  const built = lines.filter((l) => l.startsWith('/dist-renderer/'));
  const source = lines.filter((l) => l.startsWith('/src/renderer/'));
  const entry = built.some((l) => l === '/dist-renderer/index.html');
  const script = built.some((l) => l === '/dist-renderer/renderer.js');

  if (!entry || !script) {
    problems.push(
      `${path.relative(DIST, asar)}: dist-renderer/ is missing index.html or renderer.js ` +
        `-- run \`npm run build:renderer\` before packaging`
    );
  } else {
    console.log(`  ok   ${path.relative(DIST, asar)} carries the built renderer (${built.length} files)`);
  }
  if (source.length > 0) {
    problems.push(
      `${path.relative(DIST, asar)}: ships ${source.length} file(s) of src/renderer/ Svelte source, ` +
        `which cannot run -- the "!src/renderer/**/*" exclusion stopped matching`
    );
  }
}

// 4. Report the installers produced, so a silently-empty build is obvious.
const installers = all.filter((p) =>
  /\.(dmg|zip|exe|AppImage|deb|rpm|snap)$/.test(p) && fs.statSync(p).isFile()
);
if (installers.length === 0) {
  problems.push('no installer artifacts (.dmg/.exe/.AppImage/.deb) were produced');
}
for (const i of installers) {
  console.log(`  ok   ${path.relative(DIST, i)} (${(fs.statSync(i).size / 1e6).toFixed(1)} MB)`);
}

if (problems.length > 0) {
  console.error(`\nFAIL (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`\nPackage verification passed on ${process.platform}/${process.arch}.`);
