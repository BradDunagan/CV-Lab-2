'use strict';

/**
 * Shared pieces for the 09-20 curved-edge probe.
 *
 * A snapshot, like everything in notes/. Plain node; it uses the addon but not
 * Electron, and reads `assets/` as it was on 09-20.
 *
 * Nothing here is proposed as an implementation. The fits are the cheapest
 * thing that answers the question in the note, written in JS so that no C had
 * to be committed to before knowing whether the curves survive detection at
 * all. Where a real implementation would differ is called out in the comments.
 */

const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');

/* ------------------------------------------------------------------ */
/* PNG decode                                                          */
/*                                                                     */
/* scripts/png.js is an encoder only, and `load` borrows Chromium's     */
/* decoder, which means Electron. This is here so the probe stays plain */
/* node -- 8-bit RGBA, non-interlaced, which is what assets/ holds.     */
/* ------------------------------------------------------------------ */

function decodePNG(file) {
  const b = fs.readFileSync(file);
  let off = 8, ihdr = null;
  const idat = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('ascii', off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8],
               color: data[9], interlace: data[12] };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (ihdr === null || ihdr.depth !== 8 || ihdr.color !== 6 || ihdr.interlace !== 0) {
    throw new Error(`${file}: expected 8-bit RGBA non-interlaced, got ${JSON.stringify(ihdr)}`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { w, h } = ihdr;
  const bpp = 4, stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const row = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, y * stride + stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const bb = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += bb;
      else if (filter === 3) v += (a + bb) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(bb - c), pb = Math.abs(a - c), pc = Math.abs(a + bb - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c);
      }
      cur[i] = v & 0xff;
    }
  }
  return { width: w, height: h, rgba: out };
}

/* ------------------------------------------------------------------ */
/* the three fits                                                      */
/* ------------------------------------------------------------------ */

/**
 * A port of cv_tls_line, so the line numbers here are comparable with `fit`.
 * Same algebraic eigenvector, same catastrophic-cancellation branch, same
 * tx >= 0 canonicalisation.
 */
function tlsLine(pts) {
  const n = pts.length;
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  const mx = sx / n, my = sy / n;
  let cxx = 0, cyy = 0, cxy = 0;
  for (const p of pts) {
    const u = p.x - mx, v = p.y - my;
    cxx += u * u; cyy += v * v; cxy += u * v;
  }
  cxx /= n; cyy /= n; cxy /= n;
  let tx, ty;
  if (cxy === 0) { if (cxx >= cyy) { tx = 1; ty = 0; } else { tx = 0; ty = 1; } }
  else {
    const d = cxx - cyy, r = Math.sqrt(d * d + 4 * cxy * cxy);
    let vx, vy;
    if (d >= 0) { vx = d + r; vy = 2 * cxy; } else { vx = 2 * cxy; vy = r - d; }
    if (vx < 0) { vx = -vx; vy = -vy; }
    const len = Math.hypot(vx, vy);
    tx = vx / len; ty = vy / len;
  }
  const nx = -ty, ny = tx, c = -(nx * mx + ny * my);
  let worst = 0, sum = 0;
  for (const p of pts) {
    const d = Math.abs(nx * p.x + ny * p.y + c);
    if (d > worst) worst = d;
    sum += d * d;
  }
  return { nx, ny, c, mx, my, tx, ty, rms: Math.sqrt(sum / n), max: worst };
}

/**
 * Kasa circle fit on centred coordinates.
 *
 * Closed form: a 2x2 solve, only + - * / and sqrt, so it is the variant that
 * could go into C without the determinism problem cv_tls_line's comment
 * describes. Residuals reported here are true geometric radial distances.
 *
 * Kasa is biased towards small radii on short arcs. Pratt or Taubin correct
 * that and are also closed form; not worth it for this question, would be for
 * an implementation.
 */
function circleFit(pts) {
  const n = pts.length;
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  const mx = sx / n, my = sy / n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p.x - mx, v = p.y - my;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v;
    suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-12) return null;
  const r1 = 0.5 * (suuu + suvv), r2 = 0.5 * (svvv + svuu);
  const a = (r1 * svv - r2 * suv) / det;
  const b = (r2 * suu - r1 * suv) / det;
  const cx = mx + a, cy = my + b;
  const radius = Math.sqrt(a * a + b * b + (suu + svv) / n);
  let worst = 0, sum = 0;
  for (const p of pts) {
    const d = Math.abs(Math.hypot(p.x - cx, p.y - cy) - radius);
    if (d > worst) worst = d;
    sum += d * d;
  }
  return { cx, cy, r: radius, rms: Math.sqrt(sum / n), max: worst };
}

/** Gaussian elimination with partial pivoting, for the 5x5 below. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-14) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

/**
 * General conic a x^2 + b xy + c y^2 + d x + e y + 1 = 0, algebraic least
 * squares on centred and scaled coordinates, residual as the Sampson distance
 * |Q| / |grad Q| -- a first-order approximation to the geometric one.
 *
 * TWO SHORTCUTS, both of which the note's conclusions depend on not being
 * mistaken for a real fitter:
 *
 *   - Fixing f = 1 excludes conics through the origin of the scaled frame and
 *     biases the fit. Fitzgibbon/Halir-Flusser or Taubin avoid it.
 *   - Nothing constrains the result to be an ellipse, which is why four of the
 *     twelve chains in the note come back `hyperbola`. On a 30-degree sweep
 *     that is the fit wandering, not the geometry.
 *
 * It is here to answer "is a circle enough on this subject", which it can:
 * the axis ratios it reports are far enough from 1 to settle that. It cannot
 * be read as "a conic fits this well".
 */
function conicFit(pts) {
  const n = pts.length;
  if (n < 6) return null;
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  const mx = sx / n, my = sy / n;
  let scale = 0;
  for (const p of pts) scale = Math.max(scale, Math.hypot(p.x - mx, p.y - my));
  if (scale < 1e-9) return null;
  const u = pts.map((p) => [(p.x - mx) / scale, (p.y - my) / scale]);

  const A = Array.from({ length: 5 }, () => new Array(5).fill(0));
  const rhs = new Array(5).fill(0);
  for (const [X, Y] of u) {
    const v = [X * X, X * Y, Y * Y, X, Y];
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) A[i][j] += v[i] * v[j];
      rhs[i] += -v[i];
    }
  }
  const s = solve(A, rhs);
  if (s === null) return null;
  const [a, b, c] = s, d = s[3], e = s[4];

  let worst = 0, sum = 0;
  for (const [X, Y] of u) {
    const Q = a * X * X + b * X * Y + c * Y * Y + d * X + e * Y + 1;
    const gx = 2 * a * X + b * Y + d, gy = b * X + 2 * c * Y + e;
    const g = Math.hypot(gx, gy);
    if (g < 1e-12) continue;
    const dist = Math.abs(Q) / g * scale;          /* back into pixels */
    if (dist > worst) worst = dist;
    sum += dist * dist;
  }
  const disc = b * b - 4 * a * c;
  const tr = a + c, det2 = a * c - b * b / 4;
  const rad = Math.sqrt(Math.max(0, tr * tr / 4 - det2));
  const l1 = tr / 2 + rad, l2 = tr / 2 - rad;
  return {
    rms: Math.sqrt(sum / n), max: worst,
    kind: disc < 0 ? 'ellipse' : (disc > 0 ? 'hyperbola' : 'parabola'),
    ratio: l1 * l2 <= 0 ? null
      : Math.sqrt(Math.max(Math.abs(l1), Math.abs(l2)) / Math.min(Math.abs(l1), Math.abs(l2))),
  };
}

/**
 * Angular extent about a centre, by the largest-gap construction.
 *
 * Min and max of the angle is WRONG for any arc straddling the branch cut --
 * it returns the two ends of the gap rather than the two ends of the arc. So
 * the arc is defined as everything except the largest angular gap.
 *
 * Untested at every rotation. Same class as the vector-sum-not-angle-average
 * note in k_segments, and the note lists it as open.
 */
function sweepAbout(pts, cx, cy) {
  const angles = pts.map((p) => Math.atan2(p.y - cy, p.x - cx)).sort((a, b) => a - b);
  let gap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
  let at = angles.length - 1;
  for (let i = 1; i < angles.length; i++) {
    const g = angles[i] - angles[i - 1];
    if (g > gap) { gap = g; at = i - 1; }
  }
  return { sweep: (2 * Math.PI - gap) * 180 / Math.PI, gapDeg: gap * 180 / Math.PI,
           start: angles[(at + 1) % angles.length], end: angles[at] };
}

/* ------------------------------------------------------------------ */
/* the pipeline, through the real kernels                              */
/* ------------------------------------------------------------------ */

/** `segments` and `merge` at their declared defaults, so nothing here is tuned. */
const DEFAULTS = {
  sigma: 1.4,
  segments: { angleTol: 22.5, minMag: 0.005, maxResidual: 1.0, minPixels: 8, polarity: 'signed' },
  merge: { gap: 6.0, maxResidual: 1.0, angleTol: 15.0 },
};

function labelMap(image, overrides = {}) {
  const native = require(path.join(ROOT, 'native'));
  const run = (name, inputs, params) => native.runKernel(name, inputs, params ?? {});
  const segParams = { ...DEFAULTS.segments, ...overrides };

  const rgb = native.bufferFromRGBA8(image.rgba, image.width, image.height,
    { from: 'srgb', as: 'linear' });
  const gray = run('gray', [rgb], {});
  const blur = run('gaussian', [gray], { sigma: DEFAULTS.sigma });
  const gx = run('sobel', [blur], { axis: 'x' });
  const gy = run('sobel', [blur], { axis: 'y' });
  const mag = run('sobel', [blur], { axis: 'mag' });
  const thin = run('nms', [mag, gx, gy], {});
  const raw = run('segments', [thin, gx, gy], segParams);
  const merged = run('merge', [raw], DEFAULTS.merge);

  return {
    stats: run('stats', [thin], {}),
    thin: native.bufferRead(thin),
    before: native.bufferRead(raw),
    after: native.bufferRead(merged),
    params: segParams,
  };
}

/** Pixels per label, in raster order, from an i32 label map. */
function groupsOf(labels, width) {
  const groups = new Map();
  for (let i = 0; i < labels.length; i++) {
    const id = labels[i];
    if (id <= 0) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push({ x: i % width, y: Math.floor(i / width) });
  }
  return groups;
}

const labelCount = (arr) => { let m = 0; for (const v of arr) if (v > m) m = v; return m; };

module.exports = {
  ROOT, DEFAULTS,
  decodePNG, tlsLine, circleFit, conicFit, solve, sweepAbout,
  labelMap, groupsOf, labelCount,
};
