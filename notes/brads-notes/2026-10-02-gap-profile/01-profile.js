'use strict';

/**
 * Is the gap in the pixels at all, where the pipeline cannot read it?
 *
 *   node 01-profile.js                      every table in ../2026-10-02.md
 *   node 01-profile.js profile <run> <gap>  one frame's raw profile, e.g.
 *                                           profile gap-1-front-linear gap-1mm
 *
 * Every pixel in a band around the gap sweep's truth pair is one sample, at
 * its own signed distance from the Table's truth edge: no blur and no
 * interpolation. The edge is ~8 degrees off the pixel grid, so ~105 px of it
 * covers every sub-pixel phase. A model of three plateaus (table front, strip,
 * cube face) and two steps, each averaged over the pixel's own footprint, is
 * fitted to those samples.
 *
 * SEEDED FROM GROUND TRUTH: the band, the starting positions and the edges'
 * convergence along their length all come from the truth pair. This asks what
 * the pixels hold, not whether a detector could find it.
 */

const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
const repo = path.resolve(__dirname, '..', '..', '..');
const { truthPair, line, DEFAULTS } = require(path.join(repo, 'src/lab/gapsweep'));

/* ---- PNG (8-bit RGBA, non-interlaced) -> linear gray ---------------- */
function decodePNG(file) {
  const b = fs.readFileSync(file);
  let p = 8, w = 0, h = 0, idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8);
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('expected 8-bit RGBA non-interlaced');
    } else if (type === 'IDAT') idat.push(data);
    p += len + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= bpp ? out[y * stride + i - bpp] : 0;
      const u = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp] : 0;
      let v;
      if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + u;
      else if (f === 3) v = x + ((a + u) >> 1);
      else { const pa = Math.abs(u - c), pb = Math.abs(a - c), pc = Math.abs(a + u - 2 * c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? u : c); }
      out[y * stride + i] = v & 255;
    }
  }
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.2126 * lin(out[4 * i]) + 0.7152 * lin(out[4 * i + 1]) + 0.0722 * lin(out[4 * i + 2]);
  return { w, h, g };
}

/* ---- model ---------------------------------------------------------- */
function erf(x) { // Abramowitz-Stegun 7.1.26, 1.5e-7
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
}
const K = 6; // subpixel grid for the pixel's own footprint
const SUB = []; for (let i = 0; i < K; i++) SUB.push((i + 0.5) / K - 0.5);
/** Fraction of a pixel centred at distance d from a step that lies beyond it. */
function esf(d, nx, ny, s) {
  let acc = 0;
  for (const dx of SUB) for (const dy of SUB) {
    const x = d + dx * nx + dy * ny;
    acc += s > 1e-3 ? 0.5 * (1 + erf(x / (s * Math.SQRT2))) : (x > 0 ? 1 : x < 0 ? 0 : 0.5);
  }
  return acc / (K * K);
}

function nelderMead(f, x0, step, iters = 1500) {
  const n = x0.length;
  let sim = [x0.slice()];
  for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += step[i]; sim.push(x); }
  let val = sim.map(f);
  for (let it = 0; it < iters; it++) {
    const order = val.map((v, i) => i).sort((a, b) => val[a] - val[b]);
    sim = order.map((i) => sim[i]); val = order.map((i) => val[i]);
    if (Math.abs(val[n] - val[0]) < 1e-14) break;
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += sim[i][j] / n;
    const pt = (t) => c.map((cj, j) => cj + t * (sim[n][j] - cj));
    const xr = pt(-1), fr = f(xr);
    if (fr < val[0]) { const xe = pt(-2), fe = f(xe); if (fe < fr) { sim[n] = xe; val[n] = fe; } else { sim[n] = xr; val[n] = fr; } }
    else if (fr < val[n - 1]) { sim[n] = xr; val[n] = fr; }
    else { const xc = pt(fr < val[n] ? -0.5 : 0.5), fc = f(xc);
      if (fc < Math.min(fr, val[n])) { sim[n] = xc; val[n] = fc; }
      else for (let i = 1; i <= n; i++) { sim[i] = sim[i].map((v, j) => sim[0][j] + 0.5 * (v - sim[0][j])); val[i] = f(sim[i]); } }
  }
  const best = val.indexOf(Math.min(...val));
  return { x: sim[best], f: val[best] };
}

/* ---- one frame ------------------------------------------------------ */
function frame(run, name, opts) {
  const img = decodePNG(path.join(repo, 'generated', run, `${name}.png`));
  const feats = JSON.parse(fs.readFileSync(path.join(repo, 'results', run, `${name}.features.json`), 'utf8'));
  const T = feats.find((s) => s.slot === 'T').features;
  const gapMm = Number(name.replace('gap-', '').replace('mm', '').replace('p', '.'));
  const pair = truthPair(T, 'Cube', 'Table', gapMm / 1000, DEFAULTS);
  if (!pair) return { name, gapMm, none: true };
  const a = line(pair.a), b = line(pair.b);
  const { at, normal, gap, lo, hi } = pair.facing;
  const n = normal, u = b.u;
  // local true gap along the normal as a function of t (edges converge in perspective)
  const gapAt = (t) => {
    const q = [b.p0[0] + u[0] * t, b.p0[1] + u[1] * t];
    const det = a.u[0] * -n[1] - a.u[1] * -n[0];
    const r = [q[0] - a.p0[0], q[1] - a.p0[1]];
    return (a.u[0] * r[1] - a.u[1] * r[0]) / det;
  };
  const pad = opts.pad, t0 = lo + 5, t1 = hi - 5;
  const samples = [];
  const xs = [b.p0[0] + u[0] * t0, b.p0[0] + u[0] * t1], ys = [b.p0[1] + u[1] * t0, b.p0[1] + u[1] * t1];
  const R = Math.abs(gap) + pad + 4;
  for (let y = Math.max(0, Math.floor(Math.min(...ys) - R)); y <= Math.min(img.h - 1, Math.ceil(Math.max(...ys) + R)); y++) {
    for (let x = Math.max(0, Math.floor(Math.min(...xs) - R)); x <= Math.min(img.w - 1, Math.ceil(Math.max(...xs) + R)); x++) {
      const r = [x - b.p0[0], y - b.p0[1]];
      const t = r[0] * u[0] + r[1] * u[1];
      if (t < t0 || t > t1) continue;
      const h = r[0] * n[0] + r[1] * n[1];
      const g = gapAt(t);
      if (h < -pad || h > g + pad) continue;
      samples.push({ h, g, v: img.g[y * img.w + x] });
    }
  }
  return { name, gapMm, gap, gLo: gapAt(t0), gHi: gapAt(t1), n, samples, len: t1 - t0 };
}

function binned(fr, width = 0.25) {
  // h measured from the table truth edge; the cube truth edge is at h = g(t).
  // Shift each sample so the cube edge lands at the mid-window gap: only
  // samples above mid-gap move, so both edges stay sharp in the printout.
  const bins = new Map();
  for (const s of fr.samples) {
    const h = s.h > s.g / 2 ? s.h - s.g + fr.gap : s.h;
    const k = Math.floor(h / width);
    const e = bins.get(k) ?? { sum: 0, n: 0 }; e.sum += s.v; e.n++; bins.set(k, e);
  }
  return [...bins.keys()].sort((p, q) => p - q).map((k) => ({ h: (k + 0.5) * width, v: bins.get(k).sum / bins.get(k).n, n: bins.get(k).n }));
}

/** p = [T, S, F, d1, d2, s]; table edge at d1, cube edge at g(t) + d2. */
function model(p, s, n) {
  const [Tv, Sv, Fv, d1, d2, sg] = p;
  return Tv + (Sv - Tv) * esf(s.h - d1, n[0], n[1], sg) + (Fv - Sv) * esf(s.h - s.g - d2, n[0], n[1], sg);
}
function sse(p, fr) { let e = 0; for (const s of fr.samples) { const r = model(p, s, fr.n) - s.v; e += r * r; } return e; }

function fit(fr, fixed = {}) {
  // fixed: { gapErr, S, s } hold d2-d1, the strip level, the blur.
  const lowS = fr.samples.filter((s) => s.h < -2), hiS = fr.samples.filter((s) => s.h > s.g + 2);
  const mean = (a) => a.reduce((q, s) => q + s.v, 0) / Math.max(1, a.length);
  const T0 = mean(lowS), F0 = mean(hiS);
  const mid = fr.samples.filter((s) => s.h > 0 && s.h < s.g);
  const S0 = fixed.S ?? (mid.length ? Math.min(...mid.map((s) => s.v)) : Math.min(T0, F0) / 2);
  const free = ['T', 'F', 'd1'];
  if (fixed.S === undefined) free.push('S');
  if (fixed.gapErr === undefined) free.push('d2');
  if (fixed.s === undefined) free.push('s');
  const init = { T: T0, F: F0, d1: 0, S: S0, d2: 0, s: 0.3 };
  const stepOf = { T: 0.02, F: 0.02, d1: 0.2, S: 0.03, d2: 0.2, s: 0.15 };
  const unpack = (x) => {
    const q = { ...init }; free.forEach((k, i) => { q[k] = x[i]; });
    if (fixed.S !== undefined) q.S = fixed.S;
    if (fixed.s !== undefined) q.s = fixed.s;
    if (fixed.gapErr !== undefined) q.d2 = q.d1 + fixed.gapErr;
    return [q.T, q.S, q.F, q.d1, q.d2, Math.abs(q.s)];
  };
  let best = null;
  for (const start of (fixed.gapErr === undefined ? [0, 0.6, -0.4] : [0])) {
    const x0 = free.map((k) => (k === 'd2' ? start : init[k]));
    let r = nelderMead((x) => sse(unpack(x), fr), x0, free.map((k) => stepOf[k]));
    r = nelderMead((x) => sse(unpack(x), fr), r.x, free.map((k) => stepOf[k] / 4));
    if (!best || r.f < best.f) best = r;
  }
  const p = unpack(best.x);
  return { T: p[0], S: p[1], F: p[2], d1: p[3], d2: p[4], s: p[5], gapErr: p[4] - p[3], rms: Math.sqrt(best.f / fr.samples.length) };
}

/* ---- what the note quotes ------------------------------------------ */

const RUNS = ['gap-1-front-linear', 'gap-1-front-linear-2'];
const GAPS = ['gap-50mm', 'gap-20mm', 'gap-10mm', 'gap-5mm', 'gap-2mm', 'gap-1mm', 'gap-0p5mm'];
const f = (v, d = 3) => (v >= 0 ? '+' : '') + v.toFixed(d);

if (process.argv[2] === 'profile') {
  const fr = frame(process.argv[3], process.argv[4], { pad: 6 });
  console.log(`${fr.name}: true gap ${fr.gap.toFixed(3)} px; h is px from the Table's truth edge, toward the Cube`);
  for (const b of binned(fr)) console.log(`  h=${f(b.h).padStart(7)}  ${b.v.toFixed(4)}  ${'#'.repeat(Math.round(b.v * 120))}`);
} else {
  for (const run of RUNS) {
    console.log(`\n== ${run}`);
    const frames = Object.fromEntries(GAPS.map((g) => [g, frame(run, g, { pad: 6 })]));
    const ref = fit(frames['gap-5mm']);
    console.log('1. everything free: T, S, F, both edges, blur');
    for (const g of GAPS) {
      const fr = frames[g], r = fit(fr);
      console.log(`  ${g.padEnd(10)} true ${fr.gap.toFixed(3).padStart(6)} (${fr.gLo.toFixed(2)}..${fr.gHi.toFixed(2)} along ${fr.len.toFixed(0)} px, ${fr.samples.length} pixels)  gap error ${f(r.gapErr)}  table ${f(r.d1)}  cube ${f(r.d2)}  T|S|F ${r.T.toFixed(3)}|${r.S.toFixed(3)}|${r.F.toFixed(3)}  blur ${r.s.toFixed(2)}  rms ${r.rms.toFixed(4)}`);
    }
    console.log('2. gap error held, the rest refitted: how well the width is pinned (rms, and the strip level S it needs)');
    for (const g of ['gap-5mm', 'gap-2mm', 'gap-1mm', 'gap-0p5mm']) {
      const fr = frames[g], free = fit(fr), cells = [];
      for (const ge of [-0.6, -0.3, -0.15, 0, 0.15, 0.3, 0.6, 1]) {
        if (fr.gap + ge <= 0.02) { cells.push('      --      '); continue; }
        const r = fit(fr, { gapErr: ge, s: free.s });
        cells.push(`${r.rms.toFixed(4)} S ${r.S.toFixed(3).padStart(6)}`);
      }
      console.log(`  ${g.padEnd(10)} ${cells.join(' | ')}`);
    }
    console.log(`3. strip level and blur carried from this run's 5 mm fit: S ${ref.S.toFixed(3)}, blur ${ref.s.toFixed(2)}`);
    for (const g of ['gap-2mm', 'gap-1mm', 'gap-0p5mm']) {
      const fr = frames[g], r = fit(fr, { S: ref.S, s: ref.s });
      console.log(`  ${g.padEnd(10)} true ${fr.gap.toFixed(3)}  read ${(fr.gap + r.gapErr).toFixed(3)}  gap error ${f(r.gapErr)}  table ${f(r.d1)}  cube ${f(r.d2)}  rms ${r.rms.toFixed(4)}`);
    }
  }
}
