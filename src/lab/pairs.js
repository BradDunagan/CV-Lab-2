'use strict';

/**
 * Two edges too close together to be placed one at a time.
 *
 * Every edge the pipeline reports was found in a BLURRED image: `gaussian`
 * first, then the gradient. That is what makes detection work at all, and for
 * an edge on its own it costs nothing -- a symmetric blur leaves a step's
 * gradient peak where the step is. Two steps a few pixels apart are not on
 * their own. Each one's gradient is displaced by the other's tail, and the
 * weaker of the two is displaced more. Measured on the gap sweep, 2026-10-01:
 * a true gap of 2.32 px read 3.50, and 1.14 of that 1.18 px was the weaker
 * edge. No sigma fixes it -- less blur trades the displacement for noise, and
 * at 1.16 px no sigma finds both edges.
 *
 * The gap is nevertheless in the pixels (2026-10-02): unblurred, a 1.16 px
 * strip is two steps with a dip between them. So the detection is kept for
 * what it is good at, saying THAT there are two edges and roughly where, and
 * the placing is done again here against the image nothing has been done to.
 *
 * THE MODEL
 *
 * Three plateaus and two straight steps between them:
 *
 *     below | strip | above        levels[0] | levels[1] | levels[2]
 *
 * A pixel is not a point sample. It reports the average of what it covers, so
 * a pixel a step runs through holds a mix, in proportion to the area either
 * side. `coverage` is that proportion, exactly, for a square pixel and a
 * straight step -- which is the whole reason a sub-pixel position can be read
 * off at all.
 *
 * THE APERTURE IS THE CAMERA'S, NOT THE PAIR'S
 *
 * How far a pixel gathers its light from -- the side of that square, in px --
 * decides how soft every step looks, and it cannot be fitted pair by pair. A
 * single step seen through an aperture of 1 is, pixel for pixel, two steps
 * half a pixel apart with a strip midway between their levels seen through an
 * aperture of a half. Fitted per pair, one edge found twice came back as
 * exactly that, with a gapSigma of 0.002 px. Assumed instead, it is wrong
 * where it matters: over a true 1.16 px gap the reading swung from +0.15 to
 * -0.26 px between an aperture of 1 and of 1.4, claiming ±0.04 both times.
 *
 * So it is measured where it CAN be -- on the image's lone segments, each a
 * single step with nothing near it -- and then held for every pair. The
 * lower quartile is taken, not the middle: nothing in an image is sharper than
 * the aperture allows, and plenty is softer (a shadow's edge, a rounded
 * corner), so the sharp end of the distribution is the camera and the rest is
 * the scene.
 *
 * WHAT THE PIXELS DO NOT DETERMINE
 *
 * Once the strip is narrower than a pixel, no pixel is wholly inside it, and
 * a narrow dark strip and a wider, less dark one put nearly the same light on
 * every pixel. How nearly depends on the gap. Seeded from ground truth over
 * two renders of each (2026-10-02), with the aperture measured:
 *
 *   true gap   strip fitted          strip held at its level from 5 mm
 *   1.16 px    0.97, 0.97  ±0.04     0.97, 0.97  ±0.02
 *   0.58 px    none, 0.91  ±0.13     0.25, 0.28  ±0.02
 *
 * At 1.16 px the fit finds the strip's level itself, to 0.002. At 0.58 px it
 * does not, and `gapSigma` is how the record says so: it comes from the
 * curvature of the fit and grows as the answer leaves the image. A gap the
 * fit cannot tell from none produces no record at all. A caller who knows the
 * strip's level -- measured while the gap was still wide -- can hold it.
 *
 * Pure JavaScript, handed one decoded raster and the fitted segments, like
 * explain.js. Nothing transcendental is evaluated on the way to a position:
 * coverage is piecewise quadratic, and the solver is elimination in a fixed
 * order over sums taken in row-major pixel order (design-lab-model.md §5).
 */

const DEFAULTS = {
  maxGap: 6,        // px between two segments still fitted jointly
  maxAngle: 5,      // degrees between them
  minOverlap: 10,   // px they must share along their length
  pad: 4,           // px of plateau taken beyond each edge
  inset: 2,         // px left off each end of the overlap
  strip: 'fit',     // or 'held', at stripLevel
  stripLevel: 0,
  aperture: 'fit',  // measured on this image's lone segments; or 'held'
  apertureWidth: 1, // the value held, and the one used when none can be measured
  minSigmas: 3,     // a gap under this many gapSigma is not told from none
};

const MAX_ITERATIONS = 200;
/** A fitted aperture at either end of this is not a measurement of one. */
const APERTURE_RANGE = [0.25, 8];
/** A lone segment shorter than this says too little about the aperture. */
const APERTURE_MIN_LENGTH = 20;

/* ---- one pixel across one step -------------------------------------- */

/**
 * The fraction of a square pixel lying beyond a straight step.
 *
 * `d` is how far the pixel's centre is past the step, along the step's normal.
 * `a <= b` are the half-widths of the square's two sides projected on that
 * normal. Projected, a square is a box convolved with a box: a trapezoid, flat
 * for |x| <= b - a and falling to nothing at |x| = a + b. This is its integral.
 */
function coverage(d, a, b) {
  if (d <= -(a + b)) return 0;
  if (d >= a + b) return 1;
  if (a === 0) return 0.5 + d / (2 * b);
  if (d < a - b) { const x = d + a + b; return (x * x) / (8 * a * b); }
  if (d > b - a) { const x = a + b - d; return 1 - (x * x) / (8 * a * b); }
  return 0.5 + d / (2 * b);
}

/** The trapezoid itself: d(coverage)/dd. */
function density(d, a, b) {
  const x = Math.abs(d);
  // > and not >=: an axis-aligned edge lying exactly on a pixel boundary has
  // a = 0 and x = b for the pixels either side, and a slope of zero there
  // leaves the fit with nothing to move along.
  if (x > a + b) return 0;
  if (a === 0 || x <= b - a) return 1 / (2 * b);
  return (a + b - x) / (4 * a * b);
}

/* ---- which segments, and the frame they are fitted in ---------------- */

function lineOf(seg) {
  let dx = seg.x1 - seg.x0;
  let dy = seg.y1 - seg.y0;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return null;
  // One direction per line whichever way its endpoints were written, so the
  // frame -- and with it which edge is "below" -- does not depend on that.
  let x0 = seg.x0, y0 = seg.y0;
  if (dx < 0 || (dx === 0 && dy < 0)) { x0 = seg.x1; y0 = seg.y1; dx = -dx; dy = -dy; }
  return { x0, y0, ux: dx / len, uy: dy / len, len };
}

/**
 * The frame two near-parallel segments are fitted in, or null if they are not
 * a pair.
 *
 * The longer segment is the reference (the lower id, between equals). `t` runs
 * along it from the middle of the overlap and `h` across it. Each segment is
 * then h = c + m*t, and the one with the smaller c is edge 0.
 */
function pairFrame(sa, sb, opts) {
  const la = lineOf(sa), lb = lineOf(sb);
  if (!la || !lb) return null;
  const [ref, other, refSeg, otherSeg] = lb.len > la.len ? [lb, la, sb, sa] : [la, lb, sa, sb];

  let cos = ref.ux * other.ux + ref.uy * other.uy;
  if (cos < 0) {
    // Two near-vertical lines can be given opposite directions by lineOf.
    other.x0 += other.ux * other.len; other.y0 += other.uy * other.len;
    other.ux = -other.ux; other.uy = -other.uy;
    cos = -cos;
  }
  const sin = ref.ux * other.uy - ref.uy * other.ux;
  // tan against a tolerance in degrees: one conversion, of a constant.
  if (!(cos > 0) || Math.abs(sin) > cos * Math.tan((opts.maxAngle * Math.PI) / 180)) return null;

  const along = (x, y) => (x - ref.x0) * ref.ux + (y - ref.y0) * ref.uy;
  const o0 = along(other.x0, other.y0);
  const o1 = o0 + other.len * cos;
  const lo = Math.max(0, o0) + opts.inset;
  const hi = Math.min(ref.len, o1) - opts.inset;
  if (!(hi - lo >= opts.minOverlap)) return null;

  const mid = (lo + hi) / 2;
  const ox = ref.x0 + ref.ux * mid, oy = ref.y0 + ref.uy * mid;
  const nx = -ref.uy, ny = ref.ux;
  // The other segment in the frame: where it crosses t = 0, and its slope.
  const m = sin / cos;
  const c = ((other.x0 - ox) * nx + (other.y0 - oy) * ny) - m * ((other.x0 - ox) * ref.ux + (other.y0 - oy) * ref.uy);
  if (!(Math.abs(c) > 0) || Math.abs(c) > opts.maxGap) return null;

  const edges = c > 0
    ? [{ id: refSeg.id, c: 0, m: 0 }, { id: otherSeg.id, c, m }]
    : [{ id: otherSeg.id, c, m }, { id: refSeg.id, c: 0, m: 0 }];
  return { ox, oy, ux: ref.ux, uy: ref.uy, nx, ny, half: (hi - lo) / 2, edges };
}

/** The frame of one segment on its own: the same, with a single edge in it. */
function loneFrame(seg, opts) {
  const l = lineOf(seg);
  if (!l) return null;
  const half = l.len / 2 - opts.inset;
  if (!(half > 0)) return null;
  return {
    ox: l.x0 + l.ux * (l.len / 2), oy: l.y0 + l.uy * (l.len / 2),
    ux: l.ux, uy: l.uy, nx: -l.uy, ny: l.ux, half,
    edges: [{ id: seg.id, c: 0, m: 0 }],
  };
}

/* ---- the fit -------------------------------------------------------- */

/**
 * Solve A x = b in place by elimination with partial pivoting. False if a
 * pivot is no larger than `tiny`: the caller scales A to a unit diagonal first
 * when it wants that to mean "singular" rather than "small numbers".
 */
function solve(A, b, tiny = 1e-300) {
  const n = b.length;
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(A[i][k]) > Math.abs(A[p][k])) p = i;
    if (!(Math.abs(A[p][k]) > tiny)) return false;
    if (p !== k) { [A[p], A[k]] = [A[k], A[p]]; [b[p], b[k]] = [b[k], b[p]]; }
    for (let i = k + 1; i < n; i++) {
      const f = A[i][k] / A[k][k];
      if (f === 0) continue;
      for (let j = k; j < n; j++) A[i][j] -= f * A[k][j];
      b[i] -= f * b[k];
    }
  }
  for (let k = n - 1; k >= 0; k--) {
    let s = b[k];
    for (let j = k + 1; j < n; j++) s -= A[k][j] * b[j];
    b[k] = s / A[k][k];
  }
  return true;
}

/**
 * The pixels of the band, in row-major order: the frame's length, from `pad`
 * below its first edge to `pad` above its last, where the DETECTED edges put
 * them. Fixed before the fit starts, so the fit is over one set of pixels
 * throughout.
 */
function bandSamples(raster, frame, opts) {
  const { width, height, channels, data } = raster;
  const first = frame.edges[0], last = frame.edges[frame.edges.length - 1];
  const reach = frame.half + Math.abs(first.c) + Math.abs(last.c) + opts.pad
    + frame.half * (Math.abs(first.m) + Math.abs(last.m)) + 2;
  const x0 = Math.max(0, Math.floor(frame.ox - reach)), x1 = Math.min(width - 1, Math.ceil(frame.ox + reach));
  const y0 = Math.max(0, Math.floor(frame.oy - reach)), y1 = Math.min(height - 1, Math.ceil(frame.oy + reach));
  const t = [], h = [], v = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const rx = x - frame.ox, ry = y - frame.oy;
      const tt = rx * frame.ux + ry * frame.uy;
      if (tt < -frame.half || tt > frame.half) continue;
      const hh = rx * frame.nx + ry * frame.ny;
      if (hh < first.c + first.m * tt - opts.pad || hh > last.c + last.m * tt + opts.pad) continue;
      t.push(tt); h.push(hh); v.push(data[(y * width + x) * channels]);
    }
  }
  return { t, h, v };
}

/**
 * Fit steps between plateaus to one band: one step for a lone segment, two
 * for a pair.
 *
 * Levenberg-Marquardt. The parameters are each edge's line (c, m), then the
 * levels from below the first edge to above the last, then the aperture when
 * `fitAperture` asks for it. `heldStrip`, for a pair, takes the middle level
 * out of the parameters. The Jacobian is written out, except the aperture's
 * column, which is differenced.
 *
 * Returns null when the model does not describe the band: the edges cross
 * inside it, or some parameter has no effect on any pixel, so that nothing can
 * be said about how well the rest are known.
 */
function fitBand(samples, frame, { aperture, fitAperture = false, heldStrip = null }) {
  const { t, h, v } = samples;
  const n = v.length;
  const E = frame.edges.length;
  const nMin = Math.min(Math.abs(frame.nx), Math.abs(frame.ny)) / 2;
  const nMax = Math.max(Math.abs(frame.nx), Math.abs(frame.ny)) / 2;

  // Where each level lives in the parameter vector; -1 for the held strip.
  const levelAt = [];
  let k = 2 * E;
  for (let j = 0; j <= E; j++) levelAt.push(heldStrip !== null && j === 1 ? -1 : k++);
  const APERTURE = fitAperture ? k++ : -1;
  if (n <= k) return null;

  const level = (q, j) => (levelAt[j] < 0 ? heldStrip : q[levelAt[j]]);
  const widthOf = (q) => (fitAperture ? q[APERTURE] : aperture);

  /** One pixel's value under q, and the coverages that made it. */
  const cover = new Array(E);
  const predict = (q, i, w) => {
    let value = level(q, 0);
    for (let e = 0; e < E; e++) {
      cover[e] = coverage(h[i] - q[2 * e] - q[2 * e + 1] * t[i], w * nMin, w * nMax);
      value += (level(q, e + 1) - level(q, e)) * cover[e];
    }
    return value;
  };

  /** Residuals' sum of squares at q, and optionally the normal equations. */
  const evaluate = (q, JtJ, Jtr) => {
    const w = widthOf(q);
    let sse = 0;
    const row = new Array(k);
    for (let i = 0; i < n; i++) {
      const r = predict(q, i, w) - v[i];
      sse += r * r;
      if (!JtJ) continue;
      for (let e = 0; e < E; e++) {
        const d = h[i] - q[2 * e] - q[2 * e + 1] * t[i];
        const g = -(level(q, e + 1) - level(q, e)) * density(d, w * nMin, w * nMax);
        row[2 * e] = g; row[2 * e + 1] = g * t[i];
      }
      // Level j is weighted by the coverage gained at edge j-1 and lost at j.
      for (let j = 0; j <= E; j++) {
        if (levelAt[j] < 0) continue;
        row[levelAt[j]] = (j === 0 ? 1 : cover[j - 1]) - (j === E ? 0 : cover[j]);
      }
      if (fitAperture) row[APERTURE] = (predict(q, i, w + 1e-4) - predict(q, i, w - 1e-4)) / 2e-4;
      for (let c = 0; c < k; c++) {
        Jtr[c] += row[c] * r;
        for (let e = c; e < k; e++) JtJ[c][e] += row[c] * row[e];
      }
    }
    if (JtJ) for (let c = 0; c < k; c++) for (let e = 0; e < c; e++) JtJ[c][e] = JtJ[e][c];
    return sse;
  };

  const normal = (q) => {
    const JtJ = Array.from({ length: k }, () => new Array(k).fill(0));
    const Jtr = new Array(k).fill(0);
    const sse = evaluate(q, JtJ, Jtr);
    return { JtJ, Jtr, sse };
  };

  /*
   * Start from the detected lines, with each level the mean of the pixels
   * that lie clear of every edge on its own side of them.
   */
  let p = new Array(k).fill(0);
  frame.edges.forEach((e, j) => { p[2 * j] = e.c; p[2 * j + 1] = e.m; });
  if (fitAperture) p[APERTURE] = aperture;
  {
    const sum = new Array(E + 1).fill(0), count = new Array(E + 1).fill(0);
    for (let i = 0; i < n; i++) {
      let j = 0;
      while (j < E && h[i] > p[2 * j] + p[2 * j + 1] * t[i]) j++;
      sum[j] += v[i]; count[j]++;
    }
    for (let j = 0; j <= E; j++) {
      if (levelAt[j] >= 0) p[levelAt[j]] = count[j] > 0 ? sum[j] / count[j] : 0;
    }
  }

  /*
   * Every solve is of the matrix scaled to a unit diagonal, so "singular" is
   * a property of the problem and not of the units: a level is in light, a
   * slope in px per px, and their columns differ by orders of magnitude.
   * A parameter no pixel responds to has a zero diagonal; it is held still
   * for the step, and the fit as a whole is then not one to report.
   */
  const scaleOf = (JtJ) => JtJ.map((row, c) => (row[c] > 0 ? Math.sqrt(row[c]) : 0));

  let state = normal(p);
  let lambda = 1e-3;
  let iterations = 0;
  let converged = false;
  while (iterations < MAX_ITERATIONS && !converged) {
    iterations++;
    const d = scaleOf(state.JtJ);
    const A = state.JtJ.map((row, c) => row.map((x, e) => {
      if (d[c] === 0 || d[e] === 0) return c === e ? 1 : 0;
      return x / (d[c] * d[e]) + (c === e ? lambda : 0);
    }));
    const step = state.Jtr.map((x, c) => (d[c] === 0 ? 0 : -x / d[c]));
    if (!solve(A, step, 1e-14)) { lambda *= 10; if (lambda > 1e12) return null; continue; }
    const q = p.map((x, c) => (d[c] === 0 ? x : x + step[c] / d[c]));
    if (fitAperture) q[APERTURE] = Math.min(APERTURE_RANGE[1], Math.max(APERTURE_RANGE[0], q[APERTURE]));
    const sse = evaluate(q);
    if (sse <= state.sse) {
      // Converged on how far the EDGES moved at the ends of the band, in px:
      // the one unit every parameter can be compared in.
      let moved = 0;
      for (let e = 0; e < E; e++) {
        moved = Math.max(moved,
          Math.abs(q[2 * e] - p[2 * e]) + Math.abs(q[2 * e + 1] - p[2 * e + 1]) * frame.half);
      }
      p = q;
      state = normal(p);
      lambda = Math.max(lambda / 4, 1e-9);
      if (moved < 1e-7) converged = true;
    } else {
      lambda *= 4;
      if (lambda > 1e12) converged = true; // no downhill step left to take
    }
  }

  // Edges in the order they were given, at both ends of the band.
  for (let e = 1; e < E; e++) {
    const gap = p[2 * e] - p[2 * e - 2], tilt = Math.abs(p[2 * e + 1] - p[2 * e - 1]) * frame.half;
    if (!(gap - tilt > 0)) return null;
  }

  /*
   * How well the pixels pin each parameter: the inverse of the normal matrix
   * under the fit's own residual. Neighbouring pixels' residuals are not
   * independent, so what comes out is a scale for comparing fits and not a
   * confidence interval: two renders of one 2.32 px gap differed by 0.05 px
   * under a sigma of 0.015 and 0.027.
   */
  const d = scaleOf(state.JtJ);
  if (d.some((x) => x === 0)) return null;
  const inverseColumn = (col) => {
    const A = state.JtJ.map((row, c) => row.map((x, e) => x / (d[c] * d[e])));
    const e = new Array(k).fill(0); e[col] = 1;
    return solve(A, e, 1e-14) ? e.map((x, c) => x / (d[c] * d[col])) : null;
  };
  const s2 = state.sse / (n - k);
  let gapSigma = null;
  if (E === 2) {
    const i0 = inverseColumn(0), i2 = inverseColumn(2);
    if (!i0 || !i2) return null;
    const variance = s2 * (i0[0] + i2[2] - 2 * i0[2]);
    if (!(variance >= 0)) return null;
    gapSigma = Math.sqrt(variance);
  }

  return {
    edges: frame.edges.map((_, e) => ({ c: p[2 * e], m: p[2 * e + 1] })),
    levels: levelAt.map((_, j) => level(p, j)),
    aperture: widthOf(p),
    gapSigma,
    rms: Math.sqrt(state.sse / n),
    samples: n,
    iterations,
    converged,
  };
}

/* ---- the aperture --------------------------------------------------- */

/**
 * The aperture this image was made through, from its lone segments.
 *
 * Each segment that is in no pair, and long enough, is fitted as ONE step with
 * the aperture free. The lower quartile of what they return is the answer:
 * the sharpest edges are the camera, the rest are the scene.
 *
 * An axis-aligned segment says nothing -- every pixel along it crosses the
 * step at the same phase, so one soft step and a sharper one a little to the
 * side are the same pixels -- and its fit is singular or runs to the end of
 * the range; both are left out. Returns null when nothing is left.
 */
function measureAperture(segments, raster, paired, opts) {
  const found = [];
  for (const seg of segments) {
    if (paired.has(seg.id)) continue;
    const frame = loneFrame(seg, opts);
    if (!frame || 2 * frame.half < APERTURE_MIN_LENGTH) continue;
    const fit = fitBand(bandSamples(raster, frame, opts), frame,
      { aperture: opts.apertureWidth, fitAperture: true });
    if (!fit || !fit.converged) continue;
    if (!(fit.aperture > APERTURE_RANGE[0]) || !(fit.aperture < APERTURE_RANGE[1])) continue;
    found.push(fit.aperture);
  }
  if (found.length === 0) return null;
  found.sort((a, b) => a - b);
  return { width: found[Math.floor((found.length - 1) / 4)], segments: found.length };
}

/* ---- the records ---------------------------------------------------- */

/**
 * Refit every pair of close, near-parallel segments against the raster.
 *
 * One `edge-pair` record per pair, in order of (lower id, higher id) and
 * numbered from 1. A pair the model cannot describe produces no record, and
 * neither does one whose gap the fit cannot tell from none: that is one edge
 * found twice, or two parts in contact, and this cannot say which.
 *
 * Each record carries both edges as they now stand -- `a` is the one below
 * the strip in the frame, `b` the one above -- with the id of the segment each
 * came from, over the stretch they share. `shift` is how far the fit moved
 * each from its detection at the middle of that stretch, in px along the
 * normal from a toward b: two edges pushed apart by blur come back as a
 * positive shift on a and a negative one on b.
 *
 * `aperture` is the same in every record of one call, with where it came
 * from: `segments` (measured, over `apertureSegments` of them), `held`, or
 * `default` when it was to be measured and no segment could say.
 */
function fitPairs(segments, raster, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const segs = segments
    .filter((s) => s.type === 'edge-segment')
    .sort((p, q) => p.id - q.id);

  const frames = [];
  const paired = new Set();
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const frame = pairFrame(segs[i], segs[j], opts);
      if (!frame) continue;
      frames.push(frame);
      paired.add(segs[i].id); paired.add(segs[j].id);
    }
  }
  if (frames.length === 0) return [];

  let aperture = { width: opts.apertureWidth, from: 'held', segments: 0 };
  if (opts.aperture !== 'held') {
    const measured = measureAperture(segs, raster, paired, opts);
    aperture = measured
      ? { width: measured.width, from: 'segments', segments: measured.segments }
      : { width: opts.apertureWidth, from: 'default', segments: 0 };
  }

  const out = [];
  for (const frame of frames) {
    const fit = fitBand(bandSamples(raster, frame, opts), frame, {
      aperture: aperture.width,
      heldStrip: opts.strip === 'held' ? opts.stripLevel : null,
    });
    if (!fit) continue;
    const gap = fit.edges[1].c - fit.edges[0].c;
    if (!(gap > opts.minSigmas * fit.gapSigma)) continue;

    const at = (edge, t) => {
      const hh = edge.c + edge.m * t;
      return [frame.ox + frame.ux * t + frame.nx * hh, frame.oy + frame.uy * t + frame.ny * hh];
    };
    const edge = (k) => {
      const [x0, y0] = at(fit.edges[k], -frame.half);
      const [x1, y1] = at(fit.edges[k], frame.half);
      return { segment: frame.edges[k].id, x0, y0, x1, y1, shift: fit.edges[k].c - frame.edges[k].c };
    };
    out.push({
      type: 'edge-pair',
      id: out.length + 1,
      a: edge(0),
      b: edge(1),
      x: frame.ox, y: frame.oy,
      nx: frame.nx, ny: frame.ny,
      gap,
      gapSigma: fit.gapSigma,
      detectedGap: frame.edges[1].c - frame.edges[0].c,
      levels: fit.levels,
      strip: opts.strip,
      aperture: aperture.width,
      apertureFrom: aperture.from,
      apertureSegments: aperture.segments,
      rms: fit.rms,
      samples: fit.samples,
      iterations: fit.iterations,
      converged: fit.converged,
    });
  }
  return out;
}

module.exports = {
  fitPairs, pairFrame, loneFrame, bandSamples, fitBand, measureAperture,
  coverage, density, solve, DEFAULTS,
};
