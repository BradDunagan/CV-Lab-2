#!/usr/bin/env node
'use strict';

/**
 * Read what `npm run lab` wrote and tally it.
 *
 *   npm run score -- results/
 *
 * Reporting only. Nothing here computes a result — `match` already did that,
 * inside the lab, where it is recorded in the log and content-hashed like
 * everything else. This adds up records and prints tables, which is why it is
 * a plain node script and not an operation: a tally is not a measurement, and
 * putting it in the registry would suggest otherwise.
 *
 * The one thing here that is more than addition is the discrimination sweep at
 * the end, and it is the reason this script exists at all. design-lab-model.md
 * §5 claims `endpointGap` separates real corners from invented ones with a 14x
 * margin, from ONE hand-read image, and says in as many words that it is a
 * single data point. This sweeps every field a corner candidate carries
 * against ground truth, over as many views as were rendered, and reports which
 * of them actually separates.
 */

const fs = require('node:fs');
const path = require('node:path');

const USAGE = `
cv-lab-2 scoring report

  npm run score -- <results-dir> [options]

  <results-dir>     a directory of <name>.features.json, written by
                    'npm run lab -- --out <dir>'
  --match <slots>   comma-separated match slots to read (default MF,MC)
  --corners <slot>  slot holding the corner candidates  (default C)
  --quiet           tables only, no per-image lines
`.trim();

/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { dir: null, match: ['MF', 'MC'], corners: 'C', quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--match': opts.match = String(argv[++i] ?? '').split(',').filter(Boolean); break;
      case '--corners': opts.corners = argv[++i]; break;
      case '--quiet': opts.quiet = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
        if (opts.dir) throw new Error('one results directory at a time');
        opts.dir = arg;
    }
  }
  return opts;
}

/** Slot -> feature list, for one image. */
function readFeatures(file) {
  const slots = new Map();
  for (const entry of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    slots.set(entry.slot, entry.features);
  }
  return slots;
}

function tally(records) {
  const counts = { hit: 0, 'false-positive': 0, miss: 0 };
  for (const r of records) counts[r.role] = (counts[r.role] ?? 0) + 1;
  const detections = counts.hit + counts['false-positive'];
  const expected = counts.hit + counts.miss;
  return {
    ...counts,
    detections,
    expected,
    precision: detections > 0 ? counts.hit / detections : null,
    recall: expected > 0 ? counts.hit / expected : null,
  };
}

const pct = (v) => (v === null ? '   — ' : `${(v * 100).toFixed(0).padStart(4)}%`);

/* ------------------------------------------------------------------ */
/* the discrimination sweep                                            */
/* ------------------------------------------------------------------ */

/**
 * For one field of a corner candidate, how well does thresholding it separate
 * corners that matched a real vertex from those that did not?
 *
 * Reported as the best F1 over every threshold the data itself offers, plus
 * the range each class occupies — because a separation with no overlap is a
 * different and much stronger claim than a good F1, and the design doc's
 * existing claim is of the first kind.
 *
 * `direction` says which side is supposed to be the real one: 'below' for
 * fields where small means real (endpointGap, sigma, reach), 'above' for
 * fields where large means real (support, angle).
 */
function sweep(samples, field, direction) {
  const values = samples
    .map((s) => ({ value: s.corner[field], real: s.real }))
    .filter((s) => typeof s.value === 'number' && Number.isFinite(s.value));
  if (values.length === 0) return null;

  const real = values.filter((v) => v.real).map((v) => v.value);
  const fake = values.filter((v) => !v.real).map((v) => v.value);
  if (real.length === 0 || fake.length === 0) return null;

  const keep = (value, threshold) =>
    direction === 'below' ? value <= threshold : value >= threshold;

  let best = null;
  for (const threshold of [...new Set(values.map((v) => v.value))].sort((a, b) => a - b)) {
    const kept = values.filter((v) => keep(v.value, threshold));
    const tp = kept.filter((v) => v.real).length;
    const fp = kept.length - tp;
    const fn = real.length - tp;
    if (tp === 0) continue;
    const precision = tp / (tp + fp);
    const recall = tp / (tp + fn);
    const f1 = (2 * precision * recall) / (precision + recall);
    if (best === null || f1 > best.f1) best = { threshold, precision, recall, f1, tp, fp, fn };
  }
  if (best === null) return null;

  const realRange = [Math.min(...real), Math.max(...real)];
  const fakeRange = [Math.min(...fake), Math.max(...fake)];
  /*
   * Does thresholding separate them CLEANLY -- no overlap at all? That is what
   * the design doc claims for endpointGap, and it is a far stronger property
   * than a high F1: it means one number decides, on this data, with no
   * exceptions.
   */
  const clean = direction === 'below'
    ? realRange[1] < fakeRange[0]
    : realRange[0] > fakeRange[1];
  const margin = direction === 'below'
    ? fakeRange[0] / (realRange[1] || 1e-9)
    : realRange[0] / (fakeRange[1] || 1e-9);

  return { field, direction, best, realRange, fakeRange, clean, margin,
           realCount: real.length, fakeCount: fake.length };
}

const range = (r) => `${r[0].toFixed(2)} – ${r[1].toFixed(2)}`;

/* ------------------------------------------------------------------ */

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}
if (opts.help || !opts.dir) {
  console.log(USAGE);
  process.exit(opts.help ? 0 : 2);
}
if (!fs.existsSync(opts.dir)) {
  console.error(`no such directory: ${opts.dir}`);
  process.exit(2);
}

const files = fs.readdirSync(opts.dir)
  .filter((f) => f.endsWith('.features.json'))
  .sort();
if (files.length === 0) {
  console.error(`no *.features.json in ${opts.dir} — did 'npm run lab' get --out?`);
  process.exit(2);
}

const totals = new Map();          // slot -> pooled records
const byCause = new Map();         // cause -> pooled segment records
const inventedCorners = new Map(); // explained cause -> count, false positives only
const cornerSamples = [];          // one per detected corner, across all images

for (const file of files) {
  const name = file.replace(/\.features\.json$/, '');
  const slots = readFeatures(path.join(opts.dir, file));

  /*
   * What the renderer says put each detection there, if `explain` was run.
   *
   * A match record's `cause` comes from the ground-truth edge it hit, so a
   * FALSE POSITIVE has none -- it matched nothing to take a cause from. That
   * left every invented detection in one bucket called "(not geometry)",
   * which pooled two very different findings: a detector that was wrong, and
   * a detector that was right about an edge the ground truth does not model.
   * A shadow boundary is a real image edge belonging to the light.
   *
   * Found by shape rather than by slot name, so a pipeline can call the slot
   * whatever it likes: any features carrying a `cause` that are not match
   * records are an explanation.
   */
  const explained = new Map();       // "segment:12" -> "shading"
  for (const features of slots.values()) {
    for (const f of features) {
      if (f.type === 'edge-match' || typeof f.cause !== 'string') continue;
      const kind = f.type === 'edge-corner' ? 'corner' : 'segment';
      explained.set(`${kind}:${f.id}`, f.cause);
    }
  }

  for (const slot of opts.match) {
    const records = slots.get(slot);
    if (!records) continue;
    if (!totals.has(slot)) totals.set(slot, []);
    totals.get(slot).push(...records);

    for (const r of records) {
      if (r.kind !== 'segment') continue;
      const cause = r.cause
        ?? (r.role === 'false-positive'
          ? explained.get(`segment:${r.detected}`) ?? '(not geometry)'
          : '(unknown)');
      if (!byCause.has(cause)) byCause.set(cause, []);
      byCause.get(cause).push(r);
    }

    /*
     * Corners get their own tally rather than joining the segment table: the
     * two are different questions and the recall column would be meaningless
     * pooled. Only the inventions, because a hit's cause is the geometry it
     * hit and is already reported above.
     */
    for (const r of records) {
      if (r.kind !== 'corner' || r.role !== 'false-positive') continue;
      const cause = explained.get(`corner:${r.detected}`);
      if (!cause) continue;
      inventedCorners.set(cause, (inventedCorners.get(cause) ?? 0) + 1);
    }
  }

  /*
   * Join each detected corner to its verdict, by id. The corner record carries
   * the evidence -- support, endpointGap, reach, sigma -- and the match record
   * carries whether it was real. Neither alone can answer the question.
   */
  const corners = slots.get(opts.corners) ?? [];
  const verdicts = new Map();
  for (const slot of opts.match) {
    for (const r of slots.get(slot) ?? []) {
      if (r.kind === 'corner' && r.detected !== null) verdicts.set(r.detected, r);
    }
  }
  for (const corner of corners) {
    const verdict = verdicts.get(corner.id);
    if (!verdict) continue;
    cornerSamples.push({ image: name, corner, real: verdict.role === 'hit' });
  }

  if (!opts.quiet) {
    const parts = [];
    for (const slot of opts.match) {
      const records = slots.get(slot);
      if (!records) continue;
      const t = tally(records);
      const kind = records.length > 0 ? records[0].kind : slot;
      parts.push(`${kind}s ${t.hit}/${t.detections} found, ${t.miss} missed`);
    }
    console.log(`  ${name.padEnd(10)} ${parts.join('   ')}`);
  }
}

/* ------------------------------------------------------------------ */

console.log(`\n${files.length} image(s)\n`);

console.log('OVERALL');
console.log('  what          detected   real   invented   missed   precision   recall');
for (const [slot, records] of totals) {
  if (records.length === 0) continue;
  const t = tally(records);
  const kind = `${records[0].kind}s`;
  console.log(
    `  ${kind.padEnd(12)}  ${String(t.detections).padStart(8)}` +
    `${String(t.hit).padStart(7)}${String(t['false-positive']).padStart(11)}` +
    `${String(t.miss).padStart(9)}${pct(t.precision).padStart(12)}${pct(t.recall).padStart(9)}`
  );
}

if (byCause.size > 0) {
  console.log('\nSEGMENTS BY WHAT THE GEOMETRY IS');
  console.log('  cause             detected   real   missed   recall');
  for (const [cause, records] of [...byCause].sort()) {
    const t = tally(records);
    console.log(
      `  ${cause.padEnd(16)}${String(t.detections).padStart(10)}` +
      `${String(t.hit).padStart(7)}${String(t.miss).padStart(9)}${pct(t.recall).padStart(9)}`
    );
  }
}

if (inventedCorners.size > 0) {
  /*
   * The invented corners, by what the renderer says was actually there.
   *
   * `shading` is not a detector failure. A shadow boundary and a specular
   * terminator are real image edges belonging to the LIGHT, so a corner where
   * two of them meet is something the detector was right to find and the
   * ground truth -- which models geometry alone -- is right to call invented.
   *
   * The rows that deserve attention are `occlusion` and `crease`: a detection
   * sitting on a real depth step or a real fold that matched nothing is
   * either geometry the truth does not list, or a matching tolerance that is
   * too tight. Both are worth chasing; shading is worth counting and leaving
   * alone.
   */
  const total = [...inventedCorners.values()].reduce((a, b) => a + b, 0);
  console.log('\nINVENTED CORNERS BY WHAT WAS REALLY THERE');
  console.log('  cause          count   share');
  for (const [cause, n] of [...inventedCorners].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cause.padEnd(13)}${String(n).padStart(7)}${pct(n / total).padStart(8)}`);
  }
  console.log('\n  shading is the light rather than the object, and not a miss.');
}

/* ------------------------------------------------------------------ */

if (cornerSamples.length > 0) {
  const real = cornerSamples.filter((s) => s.real).length;
  console.log(
    `\nWHICH FIELD TELLS A REAL CORNER FROM AN INVENTED ONE` +
    `\n  ${cornerSamples.length} candidates over ${files.length} view(s): ` +
    `${real} real, ${cornerSamples.length - real} invented\n`
  );
  console.log('  field          keep      real range          invented range      ' +
              'best F1   at        clean');
  const FIELDS = [
    ['endpointGap', 'below'],
    ['reach', 'below'],
    ['sigma', 'below'],
    ['support', 'above'],
    ['angle', 'above'],
  ];
  for (const [field, direction] of FIELDS) {
    const result = sweep(cornerSamples, field, direction);
    if (!result) { console.log(`  ${field.padEnd(14)} (not separable — one class is empty)`); continue; }
    console.log(
      `  ${field.padEnd(14)} ${direction.padEnd(8)} ${range(result.realRange).padEnd(19)} ` +
      `${range(result.fakeRange).padEnd(19)} ${result.best.f1.toFixed(2).padStart(7)}   ` +
      `${result.best.threshold.toFixed(2).padStart(7)}   ` +
      `${result.clean ? `yes, ${result.margin.toFixed(1)}x` : 'no'}`
    );
  }
  console.log(
    '\n  "clean" means the two ranges do not overlap at all, so one threshold\n' +
    '  decides every candidate on this data. That is the claim design-lab-model.md\n' +
    '  §5 makes for endpointGap, from a single hand-read image.'
  );
}
