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
//
//     The header is parsed here rather than shelled out to `npx asar list`,
//     for two reasons that both showed up on Windows. npx is npx.cmd there and
//     execFileSync cannot run it without a shell; and npx would DOWNLOAD the
//     asar package from the registry mid-verification, putting a network
//     dependency inside the step that is supposed to be checking a local
//     artifact. The format is four little-endian lengths and then JSON.
function readAsarHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) < 16) return null;
    const headerSize = head.readUInt32LE(12);
    if (!headerSize || headerSize > 64 * 1024 * 1024) return null;
    const json = Buffer.alloc(headerSize);
    fs.readSync(fd, json, 0, headerSize, 16);
    return JSON.parse(json.toString('utf8'));
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Depth-first count of file entries under a node, for reporting. */
function countFiles(node) {
  if (!node || !node.files) return node ? 1 : 0;
  return Object.values(node.files).reduce((n, child) => n + countFiles(child), 0);
}

for (const asar of asars) {
  const where = path.relative(DIST, asar);
  const tree = readAsarHeader(asar);
  if (!tree || !tree.files) {
    problems.push(`${where}: could not read the asar header -- is it a valid archive?`);
    continue;
  }

  const built = tree.files['dist-renderer'];
  const entry = built?.files?.['index.html'];
  const script = built?.files?.['renderer.js'];
  if (!entry || !script) {
    problems.push(
      `${where}: dist-renderer/ is missing index.html or renderer.js ` +
        '-- run `npm run build:renderer` before packaging'
    );
  } else {
    console.log(`  ok   ${where} carries the built renderer (${countFiles(built)} files)`);
  }

  // The Svelte source cannot run; shipping it too would put two copies of the
  // UI in the bundle, one of them dead.
  const source = tree.files['src']?.files?.['renderer'];
  if (source) {
    problems.push(
      `${where}: ships src/renderer/ Svelte source, which cannot run ` +
        '-- the "!src/renderer/**/*" exclusion stopped matching'
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
