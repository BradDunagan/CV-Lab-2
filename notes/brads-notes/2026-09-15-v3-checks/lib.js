'use strict';

// Shared by the v3 checks. The loader is 09-12's, used as it was committed; the
// jump fit and the crop drawing are copied from 09-12's 05-jump.js (variant
// `fixed`) and 10-crops.js rather than imported, because those are scripts, and
// a note directory is a snapshot that is not edited to suit a later one.

const fs = require('node:fs');
const path = require('node:path');
const base = require('../2026-09-12-the-88/load');

const { REPO, VIEWS, loadView, verdicts, mid, quantile } = base;
const { sample, median } = require(`${REPO}/src/lab/explain`);
const { MIN_VISIBLE } = require(`${REPO}/src/lab/match`);
const { encodePNG } = require(`${REPO}/scripts/png`);
const { crossings, DEFAULTS } = require(`${REPO}/src/lab/explain`);

const OUT = path.join(__dirname, 'out');
const SETS = ['helmet-256', 'helmet-512', 'clutter'];

/* ------------------------------------------------------------------ */
/* the jump fit -- 09-12 05-jump.js, variant `fixed`, unchanged        */
/* ------------------------------------------------------------------ */

const U = [];
for (let u = -4.5; u <= 4.5 + 1e-9; u += 0.25) U.push(+u.toFixed(2));

function solve4(A, b) {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 4; c++) {
    let p = c; for (let r = c + 1; r < 4; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 4; r++) if (r !== c) { const k = M[r][c] / M[c][c]; for (let j = c; j < 5; j++) M[r][j] -= k * M[c][j]; }
  }
  return M.map((row, i) => row[4] / row[i]);
}

function jumpAt(depth, px, py, nx, ny) {
  const prof = U.map((u) => [u, sample(depth, px + nx * u, py + ny * u, 0)]);
  let best = null;
  for (const u0 of U) {
    if (Math.abs(u0) > 2.5) continue;
    const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], bb = [0, 0, 0, 0];
    const rows = [];
    for (const [u, z] of prof) {
      if (Math.abs(u - u0) < 0.75) continue;
      const x = [1, u - u0, Math.max(0, u - u0), u > u0 ? 1 : 0];
      rows.push([x, z]);
      for (let i = 0; i < 4; i++) { bb[i] += x[i] * z; for (let j = 0; j < 4; j++) A[i][j] += x[i] * x[j]; }
    }
    const p = solve4(A, bb);
    if (!p) continue;
    let rss = 0;
    for (const [x, z] of rows) { const e = z - (p[0] + p[1] * x[1] + p[2] * x[2] + p[3] * x[3]); rss += e * e; }
    if (!best || rss < best.rss) best = { rss, u: u0, gap: Math.abs(p[3]) };
  }
  return best;
}

/** Median jump over explain's seven crossings, and where across the line each break sits. */
function jumpFit(f, depth) {
  const dx = f.x1 - f.x0, dy = f.y1 - f.y0, len = Math.hypot(dx, dy);
  const nx = -dy / len, ny = dx / len;
  const cs = [];
  for (let i = 0; i < 7; i++) {
    const t = (i + 1) / 8;
    cs.push(jumpAt(depth, f.x0 + dx * t, f.y0 + dy * t, nx, ny));
  }
  const strong = cs.filter((c) => c.gap >= 0.02).map((c) => Math.abs(c.u));
  return { jump: median(cs.map((c) => c.gap)), jumpN: strong.length, breakAt: strong.length ? mid(strong) : null, us: cs.map((c) => c.u) };
}

/* ------------------------------------------------------------------ */
/* crops -- 09-12 10-crops.js, drawing unchanged, rows passed in       */
/* ------------------------------------------------------------------ */

const WIN = 36, S = 7, P = WIN * S, GAP = 6;

function put(c, x, y, col, a = 1) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
  const o = (y * c.width + x) * 4;
  for (let k = 0; k < 3; k++) c.px[o + k] = c.px[o + k] * (1 - a) + col[k] * a;
  c.px[o + 3] = 255;
}

function line(c, ox, oy, clip, x0, y0, x1, y1, col, a = 1, r = 0) {
  const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
  for (let i = 0; i <= n; i++) {
    const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n;
    if (x < 0 || y < 0 || x >= clip || y >= clip) continue;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) put(c, ox + x + dx, oy + y + dy, col, a);
  }
}

function drawRow(c, v, r, oy) {
  const cx = Math.round((r.x0 + r.x1) / 2) - WIN / 2, cy = Math.round((r.y0 + r.y1) / 2) - WIN / 2;
  const { beauty, rasters } = v;
  const D = rasters.depth, N = rasters.normal, w = beauty.width;
  for (let py = 0; py < P; py++) for (let px = 0; px < P; px++) {
    const sx = cx + Math.floor(px / S), sy = cy + Math.floor(py / S);
    if (sx < 0 || sy < 0 || sx >= w || sy >= w) continue;
    const i = sy * w + sx;
    put(c, px, oy + py, [beauty.px[i * 4], beauty.px[i * 4 + 1], beauty.px[i * 4 + 2]].map((q) => q * 0.8));
    put(c, P + GAP + px, oy + py, [N.data[i * 4], N.data[i * 4 + 1], N.data[i * 4 + 2]].map((q) => q * 255));
    let m = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const qx = sx + dx, qy = sy + dy;
      if (qx < 0 || qy < 0 || qx >= w || qy >= w) continue;
      m = Math.max(m, Math.abs(D.data[i] - D.data[qy * w + qx]));
    }
    const g = Math.max(0, Math.min(1, (Math.log10(m + 1e-4) + 3) / 3)) * 255;
    put(c, 2 * (P + GAP) + px, oy + py, [g, g, g]);
  }
  for (const e of v.slots.get('T')) {
    if (e.type !== 'gt-edge') continue;
    const occl = e.cause !== 'crease', vis = e.visible >= MIN_VISIBLE;
    const col = occl ? (vis ? [0, 230, 255] : [255, 0, 200]) : (vis ? [255, 255, 255] : null);
    if (!col) continue;
    const a = occl ? 1 : 0.45;
    const X0 = (e.x0 - cx) * S, Y0 = (e.y0 - cy) * S, X1 = (e.x1 - cx) * S, Y1 = (e.y1 - cy) * S;
    line(c, 0, oy, P, X0, Y0, X1, Y1, col, a);
    if (occl) line(c, 2 * (P + GAP), oy, P, X0, Y0, X1, Y1, col, a);
  }
  for (const ox of [0, P + GAP, 2 * (P + GAP)]) {
    line(c, ox, oy, P, (r.x0 - cx) * S, (r.y0 - cy) * S, (r.x1 - cx) * S, (r.y1 - cy) * S, [255, 40, 40], 1, 1);
  }
  for (const [a, b] of crossings(r, DEFAULTS)) {
    for (const p of [a, b]) line(c, 0, oy, P, (p.x - cx) * S, (p.y - cy) * S, (p.x - cx) * S, (p.y - cy) * S, [255, 230, 0], 1, 1);
  }
}

/** Write `rows` (each carrying view, x0..y1) as sheets of `perSheet`; returns the file names. */
function drawSheets(set, rows, stem, perSheet, dir) {
  const views = new Map();
  const view = (n) => { if (!views.has(n)) views.set(n, loadView(n, set)); return views.get(n); };
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (let start = 0, sheet = 0; start < rows.length; start += perSheet, sheet++) {
    const chunk = rows.slice(start, start + perSheet);
    const c = { width: 3 * P + 2 * GAP, height: chunk.length * P + (chunk.length - 1) * GAP };
    c.px = Buffer.alloc(c.width * c.height * 4, 255);
    chunk.forEach((r, row) => drawRow(c, view(r.view), r, row * (P + GAP)));
    const file = `${stem}-${sheet}.png`;
    fs.writeFileSync(path.join(dir, file), encodePNG(c.width, c.height, c.px));
    files.push({ file, rows: chunk });
  }
  return files;
}

function write(name, value) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(value));
}

function read(name) {
  const file = path.join(OUT, name);
  if (!fs.existsSync(file)) throw new Error(`${file} is missing -- run 01-measure.js first (see README.md)`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = { REPO, VIEWS, SETS, loadView, verdicts, mid, quantile, jumpFit, drawSheets, write, read };
