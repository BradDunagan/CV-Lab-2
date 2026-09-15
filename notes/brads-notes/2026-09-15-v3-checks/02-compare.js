'use strict';

// Check 2: candidate v3 rules, on every set, against two populations defined
// WITHOUT the jump fit:
//
//   real steps   depth difference that does not grow with where you look --
//                raw depthStep at offset 8 under twice that at offset 1, and
//                at least 2 cm at offset 1. 09-10's growth test. A rule that
//                stops calling one of these occlusion is losing a real step.
//   scaling      v2 occlusions whose residual grows super-linearly with the
//                offset at BOTH steps (exponent >= 1.5 for 1.25->2.5 and for
//                2.5->5): a surface, a fold or a neighbouring contour, not a
//                step under the line. On helmet-256 this is the curvature and
//                step-beside tiers.
//
// R1 and R3 are built from the residual's scaling, so their row against
// `scaling` is partly circular; J and J+loc are not.
//
//   node 02-compare.js [set ...]

const { SETS, read } = require('./lib');

const T = 0.02;
const lg = (a, b) => Math.log2(Math.max(a, 1e-9) / Math.max(b, 1e-9));
const RULES = {
  'v2': (r) => r.ex[2.5] >= T,
  'R1 also@1.25': (r) => r.ex[2.5] >= T && r.ex[1.25] >= T,
  'R3 exp<1.5|5cm': (r) => r.ex[2.5] >= T && (lg(r.ex[2.5], r.ex[1.25]) < 1.5 || r.ex[1.25] >= 0.05),
  'J jump>=2cm': (r) => r.ex[2.5] >= T && r.jump >= T,
  'J+loc <=1.5px': (r) => r.ex[2.5] >= T && r.jump >= T && r.breakAt !== null && r.breakAt <= 1.5,
};
const realStep = (r) => r.raw1 >= T && r.raw8 / Math.max(r.raw1, 1e-9) < 2;
const scaling = (r) => r.ex[2.5] >= T && lg(r.ex[2.5], r.ex[1.25]) >= 1.5 && lg(r.ex[5], r.ex[2.5]) >= 1.5;

const sets = process.argv.length > 2 ? process.argv.slice(2) : SETS;
const cell = (xs, rule) => String(xs.filter(rule).length).padStart(15);
for (const set of sets) {
  const rows = read(`${set}.json`);
  const hit = rows.filter((r) => r.role === 'hit'), inv = rows.filter((r) => r.role !== 'hit');
  const pops = [
    ['real steps, matched', hit.filter(realStep)],
    ['real steps, invented', inv.filter(realStep)],
    ['scaling, matched', hit.filter(scaling)],
    ['scaling, invented', inv.filter(scaling)],
  ];
  console.log(`\n${set}  (${rows.length} segments, ${hit.length} matched)`);
  console.log('called occlusion'.padEnd(30), Object.keys(RULES).map((k) => k.padStart(15)).join(''));
  for (const [label, xs] of pops) console.log(`${label} (${xs.length})`.padEnd(30), Object.values(RULES).map((f) => cell(xs, f)).join(''));
  console.log(`all matched (${hit.length})`.padEnd(30), Object.values(RULES).map((f) => cell(hit, f)).join(''));
  console.log(`all invented (${inv.length})`.padEnd(30), Object.values(RULES).map((f) => cell(inv, f)).join(''));

  // What J takes away from matched v2 occlusions, by the kind of truth edge they matched.
  const lost = hit.filter((r) => RULES.v2(r) && !RULES['J jump>=2cm'](r));
  const kinds = {};
  for (const r of lost) kinds[r.truthCause] = (kinds[r.truthCause] ?? 0) + 1;
  const med = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
  console.log(`J reclassifies ${lost.length} matched v2 occlusions: ${JSON.stringify(kinds)}; median exponent ` +
    `${med(lost.map((r) => lg(r.ex[2.5], r.ex[1.25]))).toFixed(2)} / ${med(lost.map((r) => lg(r.ex[5], r.ex[2.5]))).toFixed(2)}; ` +
    `real steps among them: ${lost.filter(realStep).length}`);
}
