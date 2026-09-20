'use strict';

/**
 * Do the nut's curves survive nms + segments + merge as coherent regions?
 *
 *   node 01-arcs.js           the note's numbers: chaining gated by a circle fit
 *   node 01-arcs.js naive     dead end: chaining on endpoint distance and turn
 *                             angle alone, which walks around the hexagon
 *
 * Writes sheets/nut-arcs.png (or sheets/nut-arcs-naive.png) and prints every
 * table quoted in ../2026-09-20.md.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  ROOT, DEFAULTS, decodePNG, tlsLine, circleFit, conicFit, sweepAbout,
  labelMap, groupsOf, labelCount,
} = require('./lib.js');

const { encodePNG } = require(path.join(ROOT, 'scripts', 'png.js'));

const NAIVE = process.argv.includes('naive');
const IMAGE = path.join(ROOT, 'assets', 'nut-1-10x-256x256.png');
const SHEET = path.join(__dirname, 'sheets', NAIVE ? 'nut-arcs-naive.png' : 'nut-arcs.png');

/* Model selection. A circle is a strictly richer model than a line, so it wins
 * on residual alone every time; the margin is what pays for the parameter. */
const GAIN = 1.5, MIN_SWEEP = 8;

/* Chaining. CHAIN_RESIDUAL is `merge`'s claim, restated for a circle: one
 * curve has to hold every pixel of both pieces. `naive` drops it. */
const CHAIN_GAP = 4.0, MIN_TURN = 2, MAX_TURN = 40, CHAIN_RESIDUAL = 1.0;

const fmt = (v, w = 6, p = 2) => (v === null || v === undefined ? '-' : v.toFixed(p)).padStart(w);

/* --- detect -------------------------------------------------------------- */

const img = decodePNG(IMAGE);
const map = labelMap(img);
const W = img.width, H = img.height;

console.log(`${path.basename(IMAGE)}  ${W}x${H}${NAIVE ? '   [naive chaining]' : ''}`);
console.log(`  thinned magnitude: max ${map.stats.max.toFixed(4)}`
  + `  mean ${map.stats.mean.toFixed(4)}  stddev ${map.stats.stddev.toFixed(4)}`);
console.log(`  segments: ${labelCount(map.before)}   after merge: ${labelCount(map.after)}`);

const records = [];
for (const [id, pts] of [...groupsOf(map.after, W)].sort((a, b) => a[0] - b[0])) {
  const line = tlsLine(pts);
  const circle = circleFit(pts);
  if (circle === null) continue;
  let lo = Infinity, hi = -Infinity, a = null, b = null;
  for (const p of pts) {
    const t = line.tx * p.x + line.ty * p.y;
    if (t < lo) { lo = t; a = p; }
    if (t > hi) { hi = t; b = p; }
  }
  records.push({
    id, pts, n: pts.length, a, b, line, circle,
    conic: conicFit(pts),
    length: Math.hypot(b.x - a.x, b.y - a.y),
    ...sweepAbout(pts, circle.cx, circle.cy),
    gain: line.rms / Math.max(circle.rms, 1e-9),
  });
}

const isArc = (r) => r.gain >= GAIN && r.sweep >= MIN_SWEEP && r.circle.r <= Math.hypot(W, H);
const arcs = records.filter(isArc);
const straight = records.filter((r) => !isArc(r));

console.log(`\n  ${records.length} labels: ${straight.length} stay straight,`
  + ` ${arcs.length} prefer an arc`);
console.log(`  pixels in arc-preferring labels: ${arcs.reduce((s, r) => s + r.n, 0)}`
  + ` of ${records.reduce((s, r) => s + r.n, 0)}`);

const perLabel = (rows, title) => {
  console.log(`\n  ${title}`);
  console.log('    id     px   len   lineRMS  circRMS  conicRMS   gain      r   sweep');
  for (const r of [...rows].sort((x, y) => y.n - x.n).slice(0, 12)) {
    console.log(`  ${String(r.id).padStart(5)} ${String(r.n).padStart(6)} ${fmt(r.length, 5, 1)}`
      + `   ${fmt(r.line.rms, 6, 3)}   ${fmt(r.circle.rms, 6, 3)}    ${fmt(r.conic?.rms ?? null, 6, 3)}`
      + `  ${fmt(r.gain, 5, 2)} ${fmt(r.circle.r, 6, 1)}  ${fmt(r.sweep, 5, 1)}`);
  }
};
perLabel(arcs, 'the twelve largest arc-preferring labels');
perLabel(straight, 'the twelve largest straight labels, for contrast');

/* --- chain --------------------------------------------------------------- */

const parent = new Map(records.map((r) => [r.id, r.id]));
const find = (i) => {
  while (parent.get(i) !== i) { parent.set(i, parent.get(parent.get(i))); i = parent.get(i); }
  return i;
};
const members = new Map(records.map((r) => [r.id, [r]]));
const tangentAngle = (r) => Math.atan2(r.line.ty, r.line.tx) * 180 / Math.PI;

/* Cheap filters first, exactly as k_merge orders them. */
const candidates = [];
for (let i = 0; i < records.length; i++) {
  for (let j = i + 1; j < records.length; j++) {
    const p = records[i], q = records[j];
    let best = Infinity;
    for (const [e, f] of [[p.a, q.a], [p.a, q.b], [p.b, q.a], [p.b, q.b]]) {
      best = Math.min(best, Math.hypot(e.x - f.x, e.y - f.y));
    }
    if (best > CHAIN_GAP) continue;
    let turn = Math.abs(tangentAngle(p) - tangentAngle(q)) % 180;
    if (turn > 90) turn = 180 - turn;
    /* A non-zero turn is the point: `merge` wants collinear and refuses these. */
    if (turn < MIN_TURN || turn > MAX_TURN) continue;
    candidates.push({ gap: best, p, q });
  }
}
/* Closest first, ties by id: a total order, so the outcome does not depend on
 * the sort implementation. Same reason k_merge does it. */
candidates.sort((a, b) => a.gap - b.gap || a.p.id - b.p.id || a.q.id - b.q.id);

let accepted = 0, rejected = 0;
for (const { p, q } of candidates) {
  const ra = find(p.id), rb = find(q.id);
  if (ra === rb) continue;
  const pts = [...members.get(ra), ...members.get(rb)].flatMap((r) => r.pts);
  if (!NAIVE) {
    const c = circleFit(pts);
    if (c === null || c.max > CHAIN_RESIDUAL) { rejected++; continue; }
  }
  parent.set(ra, rb);
  members.set(rb, [...members.get(ra), ...members.get(rb)]);
  members.delete(ra);
  accepted++;
}

const chains = new Map();
for (const r of records) {
  const root = find(r.id);
  if (!chains.has(root)) chains.set(root, []);
  chains.get(root).push(r);
}
const multi = [...chains.values()].filter((c) => c.length > 1)
  .sort((a, b) => b.reduce((s, r) => s + r.n, 0) - a.reduce((s, r) => s + r.n, 0));

console.log(`\n  chaining: ${accepted} joins accepted, ${rejected} refused by the circle test`
  + `${NAIVE ? ' (test disabled)' : ''}`);
console.log(`  ${multi.length} chains of 2+ labels`);

const meanMag = (pts) => pts.reduce((s, p) => s + map.thin[p.y * W + p.x], 0) / pts.length;
const chainFits = [];
for (const chain of multi) {
  const pts = chain.flatMap((r) => r.pts);
  const c = circleFit(pts);
  if (c === null) continue;
  chainFits.push({ chain, pts, c, q: conicFit(pts), ext: sweepAbout(pts, c.cx, c.cy), mag: meanMag(pts) });
}

console.log('    pieces     px   circRMS  circMax   conicRMS       r   sweep    mag  conic');
for (const { chain, pts, c, q, ext, mag } of chainFits.slice(0, 12)) {
  console.log(`  ${String(chain.length).padStart(8)} ${String(pts.length).padStart(6)}`
    + `    ${fmt(c.rms, 6, 3)}   ${fmt(c.max, 6, 3)}     ${fmt(q?.rms ?? null, 6, 3)}`
    + `  ${fmt(c.r, 6, 1)}  ${fmt(ext.sweep, 5, 1)}  ${fmt(mag, 5, 3)}`
    + `  ${q ? q.kind : '-'}${q?.ratio ? ' ' + q.ratio.toFixed(2) : ''}`);
}

/*
 * No AOVs ship with assets/, so `explain` cannot run and nothing here can SAY
 * a chain is a shadow. Contrast is the next best thing -- a penumbra is a soft
 * edge and a silhouette is not. Evidence, not a verdict.
 */
if (chainFits.length > 0) {
  const sorted = [...chainFits].sort((a, b) => a.mag - b.mag);
  console.log(`\n  chain contrast: weakest ${fmt(sorted[0].mag, 5, 3)},`
    + ` median ${fmt(sorted[Math.floor(sorted.length / 2)].mag, 5, 3)},`
    + ` strongest ${fmt(sorted[sorted.length - 1].mag, 5, 3)}`);
}

/* --- why the pieces are the length they are ------------------------------ */

/*
 * Two ceilings, and which one binds says which parameter to blame.
 *
 *   straightness: an arc of chord L departs from its own TLS line by at most
 *                 L^2/(12r), so maxResidual caps L at sqrt(12 * r * maxRes)
 *   direction:    the gradient turns with the arc, so angleTol caps arc
 *                 length at r * angleTol in radians
 *
 * `segments` applies both greedily, against the fit so far, so real pieces
 * should sit a little under the smaller of the two.
 */
console.log('\n  piece length against what the two predicates allow');
console.log('        r   pieces   meanLen   straight   direction   bound   ratio');
const ratios = [];
for (const { chain, c } of chainFits.slice(0, 12)) {
  const mean = chain.reduce((s, r) => s + r.length, 0) / chain.length;
  const byResidual = Math.sqrt(12 * c.r * DEFAULTS.segments.maxResidual);
  const byAngle = c.r * (DEFAULTS.segments.angleTol * Math.PI / 180);
  const bound = Math.min(byResidual, byAngle);
  ratios.push(mean / bound);
  console.log(`  ${fmt(c.r, 7, 1)} ${String(chain.length).padStart(8)}   ${fmt(mean, 7, 1)}`
    + `    ${fmt(byResidual, 7, 1)}     ${fmt(byAngle, 7, 1)}`
    + `  ${(byResidual < byAngle ? 'residual' : '   angle').padStart(8)}   ${fmt(mean / bound, 5, 2)}`);
}
if (ratios.length > 0) {
  console.log(`  ratio: mean ${fmt(ratios.reduce((s, v) => s + v, 0) / ratios.length, 4, 2)},`
    + ` range ${fmt(Math.min(...ratios), 4, 2)} to ${fmt(Math.max(...ratios), 4, 2)}`);
}

/* --- the picture, because a table reports a number whether or not it is right */

const out = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  const v = Math.round(img.rgba[i * 4] * 0.45);      /* the subject, dimmed */
  out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
}
const put = (x, y, r, g, b) => {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
};

const chained = new Set(multi.flatMap((c) => c.map((r) => r.id)));
for (const r of records) {
  const colour = chained.has(r.id) ? [255, 60, 60] : isArc(r) ? [255, 210, 40] : [70, 130, 255];
  for (const p of r.pts) put(p.x, p.y, ...colour);
}
/*
 * Each chain's fitted ARC, between its own endpoints. Drawing the whole circle
 * -- the first version of this -- buried the fit under three hundred pixels of
 * curve that no evidence supports, and hid the hexagon bug for a run.
 */
for (const { c, ext } of chainFits) {
  if (c.r > 2 * Math.max(W, H)) continue;
  let span = ext.end - ext.start;
  while (span < 0) span += 2 * Math.PI;
  const steps = Math.max(16, Math.ceil(c.r * span * 4));
  for (let k = 0; k <= steps; k++) {
    const t = ext.start + span * (k / steps);
    put(c.cx + c.r * Math.cos(t), c.cy + c.r * Math.sin(t), 60, 255, 120);
  }
}
fs.writeFileSync(SHEET, encodePNG(W, H, out));

/* 3x nearest-neighbour as well: at 256 px the marks are one pixel wide and
 * nothing about them is readable on screen, which is how the first run's
 * hexagon bug survived a look at the overlay. */
const Z = 3, ZW = W * Z, ZH = H * Z;
const zoom = Buffer.alloc(ZW * ZH * 4);
for (let y = 0; y < ZH; y++) {
  for (let x = 0; x < ZW; x++) {
    const s = (((y / Z) | 0) * W + ((x / Z) | 0)) * 4, d = (y * ZW + x) * 4;
    zoom[d] = out[s]; zoom[d + 1] = out[s + 1]; zoom[d + 2] = out[s + 2]; zoom[d + 3] = 255;
  }
}
fs.writeFileSync(SHEET.replace(/\.png$/, '-3x.png'), encodePNG(ZW, ZH, zoom));

console.log(`\n  wrote ${path.relative(process.cwd(), SHEET)} and its 3x copy`);
console.log('  blue = stays straight   yellow = prefers an arc'
  + '   red = chained   green = the fitted arc');
