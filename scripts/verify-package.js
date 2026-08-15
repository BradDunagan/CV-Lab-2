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

// 3. Report the installers produced, so a silently-empty build is obvious.
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
