'use strict';

/**
 * Run the examples in README.md.
 *
 * The README's "all the way to geometry" pipeline produced nothing at all —
 * empty label maps, an empty feature list, no corners — and said so nowhere,
 * because every stage succeeded. `nms` was handed a signed derivative instead
 * of a magnitude and discarded half the edges; `segments` was left on its
 * default `minPixels=8` against a checkerboard whose blocks are 8 pixels
 * wide. Both are the kind of mistake that reads perfectly well.
 *
 * `test/renderer.js` had already hit the second one and worked around it with
 * `minPixels=5` in its own script. The workaround never reached the README or
 * the default, because nothing connected the two — which is the actual lesson
 * here: the fix existed, in the repo, for two commits, next to a document
 * still telling people to do the broken thing.
 *
 * So the document is the fixture. Every ```lab block in README.md is parsed
 * and executed against a real session, in order, sharing slots — exactly as a
 * reader typing them in sequence would. Adding an example to the README adds
 * a test; breaking one breaks the build.
 *
 * What is asserted is deliberately weak on values and strong on liveness:
 * commands parse, commands run, and nothing that should produce geometry
 * quietly produces none. Pinning the numbers belongs in test/determinism.js,
 * which exists for that; pinning them here would make the README hard to edit
 * for no gain.
 *
 *   node test/readme.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createRegistry } = require('../src/lab/ops');
const { Session } = require('../src/lab/session');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

console.log('cv-lab-2 README tests');

const README = path.join(__dirname, '..', 'README.md');

/**
 * Every ```lab fenced block, in document order.
 *
 * Tagged rather than "every untagged fence" because the README also fences a
 * directory tree and a shell session, and a test that tried to run those
 * would fail for reasons that have nothing to do with the lab.
 */
function labBlocks(markdown) {
  const blocks = [];
  const fence = /^```lab[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
  let match;
  while ((match = fence.exec(markdown)) !== null) blocks.push(match[1]);
  return blocks;
}

/**
 * Stand in for the one thing a README block needs that the README cannot carry:
 * a ground-truth file, which a reader produces by running the generator.
 *
 * Weakening the fence tag to stop the block being executed would have been the
 * easy fix and the wrong one — the whole point of this file is that a document
 * telling people to do something is checked by doing it. So the FILE is
 * synthesised and the commands still really run: `groundTruth` really parses
 * it, `match` really consumes it alongside the F and C the earlier blocks
 * produced, and a change that broke either would still break the build.
 *
 * Its size is read out of the README's own `pattern(width=…)` rather than
 * written here, because `match` refuses two feature lists measured in
 * different images and a hardcoded 512 would go stale the moment the example
 * changed.
 */
function writeStandInTruth(blocks) {
  const size = Number(/pattern\([^)]*width=(\d+)/.exec(blocks.join('\n'))?.[1]);
  assert.ok(Number.isInteger(size) && size > 0,
    'could not read an image size out of the README\'s pattern(...) call');

  const paths = [...blocks.join('\n').matchAll(/groundTruth\(\s*"([^"]+)"/g)].map((m) => m[1]);
  const written = [];
  for (const rel of paths) {
    const file = path.join(process.cwd(), rel);
    if (fs.existsSync(file)) continue;
    /*
     * Lines on the checkerboard's own block boundaries, so `match` has
     * something it can actually hit rather than scoring a list of misses.
     */
    const mid = Math.round(size / 2);
    const line = (id, x0, y0, x1, y1) => ({
      id, cause: 'crease', objects: ['Checker'],
      x0, y0, x1, y1, z0: 1, z1: 1,
      length: Math.hypot(x1 - x0, y1 - y0),
      angle: ((Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI) % 180 + 180) % 180,
      dihedral: 90, visible: 1, clipped: false, v0: 1, v1: 1,
    });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      size,
      edges: [line(1, 0, mid, size, mid), line(2, mid, 0, mid, size)],
      vertices: [{
        id: 1, x: mid, y: mid, z: 1, degree: 2, visibleDegree: 2,
        onFrame: true, visible: true, angle: 90, objects: ['Checker'],
      }],
    }));
    written.push(file);
  }
  return written;
}

(async () => {
  const markdown = fs.readFileSync(README, 'utf8');
  const blocks = labBlocks(markdown);
  const standIns = writeStandInTruth(blocks);

  await test('the README still contains runnable examples', () => {
    // Guards everything below: zero blocks would make every other assertion
    // here vacuously true, which is how this file could rot into a no-op if
    // someone renamed the fence tag.
    assert.ok(blocks.length >= 2,
      `expected at least 2 \`\`\`lab blocks in README.md, found ${blocks.length}`);
  });

  /*
   * One session across all blocks, because that is how the README reads: the
   * second block opens with `Gx = sobel(B, axis=x)` and B is defined in the
   * first. Running them in isolation would pass while the document as written
   * still failed on `unknown slot "B"`.
   */
  const session = new Session({ registry: createRegistry() });
  const entries = [];

  for (const [index, block] of blocks.entries()) {
    const label = `README example ${index + 1} runs`;
    // eslint-disable-next-line no-await-in-loop
    await test(label, async () => {
      const produced = await session.run(block);
      entries.push(...produced);
      assert.ok(produced.length > 0, 'block executed no commands');
    });
  }

  await test('no stage silently produces an empty result', () => {
    /*
     * The failure this file exists for. Every stage "succeeded" — the log had
     * thirteen green entries — and `S`, `R`, `F` and `C` were all empty. An
     * all-zero label map and an empty feature list are legitimate outputs, so
     * only the pipeline as a whole can say they are wrong here.
     */
    const empty = [];
    for (const entry of entries) {
      const out = entry.output;
      if (out.kind === 'features' && out.count === 0) empty.push(entry.text);
    }
    assert.equal(empty.length, 0,
      `these produced nothing:\n         ${empty.join('\n         ')}`);
  });

  await test('the geometry pipeline finds segments, fits and corners', () => {
    const slot = (name) => {
      const binding = session.slots.get(name);
      assert.ok(binding, `the README no longer defines slot "${name}"`);
      return binding.value;
    };
    assert.equal(slot('F').kind, 'features');
    assert.ok(slot('F').features.length > 0, 'fit found no segments');
    assert.equal(slot('C').kind, 'features');
    assert.ok(slot('C').features.length > 0, 'corners found nothing');

    // Every feature carries its namespaced type — §1. Corner records sharing
    // only `id` and `angle` with segments is what made the feature hash
    // collapse once already.
    for (const f of slot('F').features) assert.equal(f.type, 'edge-segment');
    for (const f of slot('C').features) assert.equal(f.type, 'edge-corner');
  });

  await test('scoring against ground truth produces a verdict per feature', () => {
    /*
     * Liveness, not values. `match` returning an empty list would mean the
     * README's scoring example ran and decided nothing — the same shape of
     * failure as the thirteen green entries that produced no geometry, and the
     * reason this file exists.
     */
    for (const name of ['MF', 'MC']) {
      const binding = session.slots.get(name);
      assert.ok(binding, `the README no longer defines slot "${name}"`);
      assert.equal(binding.value.kind, 'features');
      assert.ok(binding.value.features.length > 0, `${name} scored nothing`);
      for (const f of binding.value.features) assert.equal(f.type, 'edge-match');
    }
  });

  await test('label maps are not silently blank', () => {
    // `segments` and `merge` return i32 buffers, so the check above cannot
    // see them: an all-zero label map has the same shape as a full one.
    for (const name of ['S', 'R']) {
      const entry = [...session.log].reverse()
        .find((e) => e.produced && e.produced.slot === name);
      assert.ok(entry, `the README no longer produces "${name}"`);
      assert.equal(entry.output.kind, 'buffer');
    }
    // fit reads R, so a non-empty F above already proves R had labels in it.
    assert.ok(session.slots.get('F').value.features.length > 0);
  });

  for (const file of standIns) {
    fs.rmSync(file, { force: true });
    // Leave no directory behind either: the default output directory is one a
    // reader will really use, and an empty one appearing after `npm test` is
    // confusing.
    try { fs.rmdirSync(path.dirname(file)); } catch { /* not empty: not ours */ }
  }

  console.log(failures === 0
    ? '\nAll README tests passed.'
    : `\n${failures} README test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})();
