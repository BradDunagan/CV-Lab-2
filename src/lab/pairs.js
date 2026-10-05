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
 * MEDIAN of what they return is taken.
 *
 * It was the lower quartile for a day, on an argument: nothing in an image is
 * sharper than the aperture allows and plenty is softer, so the sharp end is
 * the camera. The argument assumed nothing reads sharper than the truth, and
 * things do -- a segment with a dark strip hidden against it fits a step
 * 0.93 wide in an image drawn through 1.4. Measured over sixteen frames from
 * one renderer, where the answer is a constant, the quartile ranged 1.06 to
 * 1.31 (sd 0.081) and the median 1.31 to 1.39 (sd 0.022). Shadow edges, at 5
 * and more, are a minority in every frame seen and do not reach the median.
 *
 * WHAT THE PIXELS DO NOT DETERMINE
 *
 * Once the strip is narrower than a pixel, no pixel is wholly inside it, and
 * a narrow dark strip and a wider, less dark one put nearly the same light on
 * every pixel. How nearly depends on the gap. Seeded from ground truth over
 * two renders of each (2026-10-02), with the aperture measured:
 *
 *   true gap   strip fitted          strip held at its level from 5 mm
 *   2.32 px    2.22, 2.25  ±0.02     2.24, 2.23  ±0.02
 *   1.16 px    0.92, 0.86  ±0.04     0.99, 1.02  ±0.02
 *   0.58 px    1.02, 0.99  ±0.15     0.37, 0.40  ±0.02
 *
 * At 2.32 px holding the level changes nothing. At 1.16 px the fitted level
 * comes out at 0.10 and 0.08 where the wider frames all say 0.12, and the gap
 * 0.1 px narrower for it. At 0.58 px the fit has gone the other way, to a
 * shallow strip twice as wide as the true one. `gapSigma` follows that, which
 * is what it is for: it comes from the curvature of the fit and grows as the
 * answer leaves the image. It does not follow it far enough. A gap the fit
 * cannot tell from none produces no record at all. A caller who knows the
 * strip's level -- measured while the gap was still wide -- should hold it
 * for anything under about a pixel and a half.
 *
 * (For a day this table read 0.97, 0.97 at 1.16 px and concluded that the fit
 * finds the level itself there. That was the lower-quartile aperture, which
 * happened to be 1.26 and 1.21 in those two frames. The reading moves 0.07 px
 * for 0.08 of aperture.)
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
  levelSlope: 'fit', // fitPairs: each level may change along the pair; or 'none'
  // findPairs only:
  window: 24,       // px of a segment tested at a time for a strip inside it
  reach: 2.4,       // px to one side that the second edge is looked for
  minGain: 1.3,     // two steps must beat one step's rms by this factor
};

const MAX_ITERATIONS = 200;
/*
 * findPairs asks a few hundred windows a yes-or-no question before it fits
 * anything it reports, and most of them are no: a second edge with nothing to
 * find wanders until the iterations run out. Capped here, the search is 2.5
 * times faster and found exactly what it found uncapped, on every frame of
 * the gap sweep. The fit that is reported runs to MAX_ITERATIONS.
 */
const SCREEN_ITERATIONS = 40;
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
 * out of the parameters. `slopedLevels` gives every fitted level a slope along
 * the band as well, after the levels. The Jacobian is written out, except the
 * aperture's column, which is differenced.
 *
 * WHY THE LEVELS SLOPE. A face is not evenly lit: the light falls off across
 * it, and along a pair 100 px long a face can brighten by several percent.
 * Fitted as one flat level, that turns each edge -- and turns the two of a
 * pair OPPOSITE ways, because a step that is brighter than the model at one
 * end is matched by moving its edge, and the edges either side of a strip move
 * apart for the same mismatch. On the stack's renders that was 0.12 degrees
 * each way on every pair in every view, 0.3 px of gap from one end of a pair
 * to the other, while the middle read true. A flat strip alone was tried and
 * did nothing; it is the faces' slopes that matter.
 *
 * Returns null when the model does not describe the band: the edges cross
 * inside it, or some parameter has no effect on any pixel, so that nothing can
 * be said about how well the rest are known.
 */
function fitBand(samples, frame, { aperture, fitAperture = false, heldStrip = null, slopedLevels = false,
  heldEdges = [], maxIterations = MAX_ITERATIONS }) {
  const { t, h, v } = samples;
  const n = v.length;
  const E = frame.edges.length;
  const nMin = Math.min(Math.abs(frame.nx), Math.abs(frame.ny)) / 2;
  const nMax = Math.max(Math.abs(frame.nx), Math.abs(frame.ny)) / 2;

  // Where each level lives in the parameter vector; -1 for the held strip.
  const levelAt = [];
  let k = 2 * E;
  for (let j = 0; j <= E; j++) levelAt.push(heldStrip !== null && j === 1 ? -1 : k++);
  const slopeAt = [];
  for (let j = 0; j <= E; j++) slopeAt.push(slopedLevels && levelAt[j] >= 0 ? k++ : -1);
  const APERTURE = fitAperture ? k++ : -1;
  // A held edge keeps its two slots, with columns of zero: the solve below
  // holds still any parameter no pixel responds to.
  const held = (c) => c < 2 * E && heldEdges.includes(c >> 1);
  const free = k - 2 * heldEdges.length;
  if (n <= free) return null;

  // A level at t along the band: its value at the middle, plus its slope.
  const level = (q, j, tt = 0) => (levelAt[j] < 0 ? heldStrip
    : q[levelAt[j]] + (slopeAt[j] < 0 ? 0 : q[slopeAt[j]] * tt));
  const widthOf = (q) => (fitAperture ? q[APERTURE] : aperture);

  /** One pixel's value under q, and the coverages that made it. */
  const cover = new Array(E);
  const predict = (q, i, w) => {
    let value = level(q, 0, t[i]);
    for (let e = 0; e < E; e++) {
      cover[e] = coverage(h[i] - q[2 * e] - q[2 * e + 1] * t[i], w * nMin, w * nMax);
      value += (level(q, e + 1, t[i]) - level(q, e, t[i])) * cover[e];
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
        const g = -(level(q, e + 1, t[i]) - level(q, e, t[i])) * density(d, w * nMin, w * nMax);
        if (heldEdges.includes(e)) { row[2 * e] = 0; row[2 * e + 1] = 0; continue; }
        row[2 * e] = g; row[2 * e + 1] = g * t[i];
      }
      // Level j is weighted by the coverage gained at edge j-1 and lost at j.
      for (let j = 0; j <= E; j++) {
        if (levelAt[j] < 0) continue;
        row[levelAt[j]] = (j === 0 ? 1 : cover[j - 1]) - (j === E ? 0 : cover[j]);
        if (slopeAt[j] >= 0) row[slopeAt[j]] = row[levelAt[j]] * t[i];
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
  while (iterations < maxIterations && !converged) {
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
  if (d.some((x, c) => x === 0 && !held(c))) return null;
  // Over the free parameters; a held one is an identity row, and known exactly.
  const inverseColumn = (col) => {
    if (held(col)) return new Array(k).fill(0);
    const A = state.JtJ.map((row, c) => row.map((x, e) => (held(c) || held(e)
      ? (c === e ? 1 : 0) : x / (d[c] * d[e]))));
    const e = new Array(k).fill(0); e[col] = 1;
    return solve(A, e, 1e-14) ? e.map((x, c) => (held(c) ? 0 : x / (d[c] * d[col]))) : null;
  };
  const s2 = state.sse / (n - free);
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
    levelSlopes: slopeAt.some((at) => at >= 0) ? slopeAt.map((at) => (at < 0 ? 0 : p[at])) : null,
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
 * the aperture free. The median of what they return is the answer (the lower
 * of the middle two, for an even count); see the top of this file for why it
 * is not the lower quartile.
 *
 * An axis-aligned segment says nothing -- every pixel along it crosses the
 * step at the same phase, so one soft step and a sharper one a little to the
 * side are the same pixels -- and its fit is singular or runs to the end of
 * the range; both are left out. Returns null when nothing is left.
 */
function measureAperture(segments, raster, paired, opts) {
  return medianAperture(loneApertures(segments, raster, paired, opts));
}

/** What each lone segment says the aperture is: [{ id, aperture }], in id order. */
function loneApertures(segments, raster, paired, opts) {
  const found = [];
  for (const seg of segments) {
    if (paired.has(seg.id)) continue;
    const frame = loneFrame(seg, opts);
    if (!frame || 2 * frame.half < APERTURE_MIN_LENGTH) continue;
    const fit = fitBand(bandSamples(raster, frame, opts), frame,
      { aperture: opts.apertureWidth, fitAperture: true });
    if (!fit || !fit.converged) continue;
    if (!(fit.aperture > APERTURE_RANGE[0]) || !(fit.aperture < APERTURE_RANGE[1])) continue;
    found.push({ id: seg.id, aperture: fit.aperture });
  }
  return found;
}

/** The median of those, leaving out segment `except` if given. Null if none. */
function medianAperture(found, except = null) {
  const values = found.filter((f) => f.id !== except).map((f) => f.aperture).sort((a, b) => a - b);
  if (values.length === 0) return null;
  return { width: values[Math.floor((values.length - 1) / 2)], segments: values.length };
}

/* ---- what both operations start from -------------------------------- */

/**
 * The segments in id order, every pair's frame, and which segments are in one.
 * fitPairs and findPairs both begin here, so they agree on which segments are
 * pairs -- and therefore on which are lone, which is what the aperture is
 * measured on.
 */
function candidates(segments, opts) {
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
  return { segs, frames, paired };
}

/** The aperture a call works through, and where it came from. */
function apertureOf(segs, raster, paired, opts) {
  if (opts.aperture === 'held') return { width: opts.apertureWidth, from: 'held', segments: 0 };
  return apertureFrom(measureAperture(segs, raster, paired, opts), opts);
}

function apertureFrom(measured, opts) {
  return measured
    ? { width: measured.width, from: 'segments', segments: measured.segments }
    : { width: opts.apertureWidth, from: 'default', segments: 0 };
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
 * `levels` are at the middle of that stretch; `levelSlopes`, in the same
 * order, how much each changes per px along it -- null with levelSlope 'none'.
 *
 * `aperture` is the same in every record of one call, with where it came
 * from: `segments` (measured, over `apertureSegments` of them), `held`, or
 * `default` when it was to be measured and no segment could say.
 */
function fitPairs(segments, raster, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const { segs, frames, paired } = candidates(segments, opts);
  if (frames.length === 0) return [];
  const aperture = apertureOf(segs, raster, paired, opts);

  const out = [];
  for (const frame of frames) {
    const fit = fitBand(bandSamples(raster, frame, opts), frame, {
      aperture: aperture.width,
      heldStrip: opts.strip === 'held' ? opts.stripLevel : null,
      slopedLevels: opts.levelSlope === 'fit',
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
      levelSlopes: fit.levelSlopes,
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

/* ---- a strip inside one segment ------------------------------------- */

/**
 * One stretch of one segment, asked whether it is one step or two.
 *
 * `from` and `to` are px along the segment's line `l`. The single step is
 * fitted first, on its own band, to say where the edge is. Then, to each
 * side in turn, a second edge is tried within `reach` of it, and the one-step
 * and two-step models are scored on the SAME pixels -- a wider band always has
 * a different rms, and a ratio of two rms values over different pixels says
 * nothing.
 *
 * Returns the better side that passes every gate, or null:
 *
 *   - the two steps fit better than the one by `minGain`. Two steps have
 *     three more parameters and always fit a little better: along 400 px of a
 *     table edge with nothing hidden in it, 1.00 to 1.05 a window. Under the
 *     cube at 1 mm, 1.35 to 2.57. The default sits between them -- two renders
 *     of one scene, which is a calibration and not a law. It does not keep
 *     out a 0.58 px gap in another scene, read as 1.02 px at a gain of 1.31.
 *   - the gap is told from none, as for a detected pair.
 *   - the strip is darker than both its neighbours, or brighter than both.
 *     One BETWEEN them is what a single soft edge looks like, and an edge
 *     softer than the aperture -- a shadow's, a rounded corner's -- is common.
 *     A dip or a bump is not something softness produces. With the strip held
 *     this gate is the caller's: the level is what they said it was.
 */
function hiddenIn(raster, l, from, to, aperture, opts, maxIterations) {
  const mid = (from + to) / 2;
  const base = {
    ox: l.x0 + l.ux * mid, oy: l.y0 + l.uy * mid,
    ux: l.ux, uy: l.uy, nx: -l.uy, ny: l.ux, half: (to - from) / 2,
  };
  const loneEdges = [{ c: 0, m: 0 }];
  const lone = fitBand(bandSamples(raster, { ...base, edges: loneEdges }, opts),
    { ...base, edges: loneEdges }, { aperture, maxIterations });
  if (!lone) return null;
  const { c, m } = lone.edges[0];
  const heldStrip = opts.strip === 'held' ? opts.stripLevel : null;

  let best = null;
  for (const side of [-1, 1]) {
    const pairAt = (g) => (side > 0 ? [{ c, m }, { c: c + g, m }] : [{ c: c - g, m }, { c, m }]);
    const samples = bandSamples(raster, { ...base, edges: pairAt(opts.reach) }, opts);
    const one = fitBand(samples, { ...base, edges: [{ c, m }] }, { aperture, maxIterations });
    if (!one) continue;
    // Three starting widths, because a start far from the answer closes the
    // strip up instead of finding it; the best of them is the fit.
    let two = null;
    for (const g of [opts.reach / 4, opts.reach / 2, opts.reach]) {
      const fit = fitBand(samples, { ...base, edges: pairAt(g) }, { aperture, heldStrip, maxIterations });
      if (fit && (!two || fit.rms < two.rms)) two = fit;
    }
    if (!two || !(two.rms > 0)) continue;
    const gain = one.rms / two.rms;
    const gap = two.edges[1].c - two.edges[0].c;
    const [below, strip, above] = two.levels;
    const outside = strip < Math.min(below, above) || strip > Math.max(below, above);
    if (!(gain >= opts.minGain)) continue;
    // Past `reach` the second edge has left the pixels it was looked for in
    // and found something else: 4 to 15 px away, when this was not checked.
    if (!(gap <= opts.reach)) continue;
    if (!(gap > opts.minSigmas * two.gapSigma)) continue;
    if (heldStrip === null && !outside) continue;
    if (!best || gain > best.gain) best = { side, gain, gap, fit: two, base };
  }
  return best;
}

/**
 * Find the pairs the detector reported as one segment.
 *
 * Below about a pixel and a half apart, two edges are detected as one: the
 * blur that finds edges merges them. The gap sweep's Cube at 1 mm (1.16 px)
 * over the Table leaves a single 512 px segment along the table's edge, with
 * the strip under the cube hidden in 114 px of it. So every segment that is
 * in no pair is walked in windows, each window is asked whether it is one
 * step or two (`hiddenIn`), runs of windows that say two on the same side are
 * joined, and each run is fitted once more as a whole.
 *
 * The records are `edge-pair`, as fitPairs writes them, with both edges
 * naming the SAME segment and a `gain` beside them. `shift` is each edge's
 * distance from the detected line, so one of the two is small -- the edge the
 * detector found -- and the other is about the gap. `aperture` is measured
 * on the lone segments OTHER than the one searched, so unlike fitPairs's it
 * can differ from one record to the next.
 *
 * The stretch reported is where the strip was fitted, not where it ends: see
 * the trimming below.
 */
function findPairs(segments, raster, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const { segs, paired } = candidates(segments, opts);
  const lone = segs.filter((s) => !paired.has(s.id));
  if (lone.length === 0) return [];
  const held = opts.aperture === 'held';
  const apertures = held ? [] : loneApertures(segs, raster, paired, opts);

  const out = [];
  for (const seg of lone) {
    const l = lineOf(seg);
    if (!l || l.len - 2 * opts.inset < opts.window) continue;
    /*
     * A sub-pixel strip is read off pixels that cross the edge at different
     * places across their width. Along a segment nearly on the pixel grid
     * they all cross at the same place, and a window that climbs less than
     * one pixel from end to end has nothing to read it from: on a cube's
     * edge 0.9 degrees off vertical, one render of two reported a bright
     * strip half a pixel wide. Not searched.
     */
    if (opts.window * Math.min(Math.abs(l.ux), Math.abs(l.uy)) < 1) continue;
    /*
     * Measured on the OTHER lone segments. The one being searched is the one
     * that may be hiding a strip, and a segment with a dark strip against it
     * reads sharper than the image is: 0.93 where it was drawn through 1.4.
     * Among a dozen segments the median shrugs that off; between two it IS
     * the median.
     */
    const aperture = held
      ? { width: opts.apertureWidth, from: 'held', segments: 0 }
      : apertureFrom(medianAperture(apertures, seg.id), opts);

    // Windows half overlapping, so a strip's end falls well inside one.
    const runs = [];
    let run = null;
    for (let from = opts.inset; from + opts.window <= l.len - opts.inset; from += opts.window / 2) {
      const hit = hiddenIn(raster, l, from, from + opts.window, aperture.width, opts, SCREEN_ITERATIONS);
      if (hit && run && run.side === hit.side) { run.to = from + opts.window; continue; }
      if (run) runs.push(run);
      run = hit ? { side: hit.side, from, to: from + opts.window } : null;
    }
    if (run) runs.push(run);

    for (const r of runs) {
      /*
       * A window half on the strip can pass or fail, so a run's ends are
       * uncertain by half a window either way -- and a stretch that runs past
       * the strip fits two steps to pixels that hold one. A run long enough
       * to spare it gives up half a window at each end.
       */
      if (r.to - r.from >= 2 * opts.window) { r.from += opts.window / 2; r.to -= opts.window / 2; }
      const hit = hiddenIn(raster, l, r.from, r.to, aperture.width, opts);
      if (!hit || hit.side !== r.side) continue;
      const { fit, base } = hit;
      const at = (edge, t) => {
        const hh = edge.c + edge.m * t;
        return [base.ox + base.ux * t + base.nx * hh, base.oy + base.uy * t + base.ny * hh];
      };
      const edge = (k) => {
        const [x0, y0] = at(fit.edges[k], -base.half);
        const [x1, y1] = at(fit.edges[k], base.half);
        return { segment: seg.id, x0, y0, x1, y1, shift: fit.edges[k].c };
      };
      out.push({
        type: 'edge-pair',
        id: out.length + 1,
        a: edge(0),
        b: edge(1),
        x: base.ox, y: base.oy,
        nx: base.nx, ny: base.ny,
        gap: hit.gap,
        gapSigma: fit.gapSigma,
        detectedGap: 0,
        levels: fit.levels,
        strip: opts.strip,
        aperture: aperture.width,
        apertureFrom: aperture.from,
        apertureSegments: aperture.segments,
        gain: hit.gain,
        rms: fit.rms,
        samples: fit.samples,
        iterations: fit.iterations,
        converged: fit.converged,
      });
    }
  }
  return out;
}

/* ---- carried from an earlier frame ---------------------------------- */

/**
 * One pair read again in a later frame, from what an earlier one measured.
 *
 * Below about a pixel the image alone does not determine a gap: width and
 * strip level trade, and the detector reports one segment or none. But in an
 * approach only one part moves. The other's edge is the same line in every
 * frame, and the strip's level and the aperture were measured while the gap
 * was wide. Carried in, they leave one edge to find -- the moving part's --
 * beside a line that is known, and nothing needs to have been detected.
 *
 * `carried`:
 *   - `line`, {x0, y0, x1, y1}: the still part's edge as fitted in the earlier
 *     frame, over the stretch the pair shared. It is HELD. Over a pixel an
 *     error in it is an error in the gap, one for one; under one, a strip of
 *     known level is as wide as its darkness says, and the moving edge
 *     follows the line instead -- 0.2 px off cost a 0.6 px gap 0.02. Either
 *     way `rms` grows with it.
 *   - `toward`, [x, y]: a point on the moving part's side of it.
 *   - `stripLevel` and `aperture`, as that frame's record had them.
 *
 * `options.guess` is where to start, in px (default 1); the fit is also
 * started at a quarter, a half, one and two pixels, and the best is kept.
 *
 * Returns the gap at the middle of the line, positive toward `toward`, with
 * `gapSigma` and the moving edge over the same stretch; or null when no
 * strip can be fitted -- the edges cross, which is what contact does in most
 * views. A gap returned is NOT tested against its sigma: at contact a few
 * views return 0.02 to 0.09 px with sigmas that would pass, and the caller is
 * the one who knows whether the parts can be touching.
 */
function trackPair(raster, carried, options = {}) {
  const opts = { ...DEFAULTS, guess: 1, ...options };
  const l = lineOf(carried.line);
  if (!l) return null;
  const frame = {
    ox: l.x0 + l.ux * (l.len / 2), oy: l.y0 + l.uy * (l.len / 2),
    ux: l.ux, uy: l.uy, nx: -l.uy, ny: l.ux, half: l.len / 2,
  };
  const side = (carried.toward[0] - frame.ox) * frame.nx + (carried.toward[1] - frame.oy) * frame.ny >= 0 ? 1 : -1;
  const edgesAt = (g) => (side > 0 ? [{ c: 0, m: 0 }, { c: g, m: 0 }] : [{ c: -g, m: 0 }, { c: 0, m: 0 }]);
  // One set of pixels for every start: wide enough for the widest of them.
  const samples = bandSamples(raster, { ...frame, edges: edgesAt(Math.max(opts.guess + 1.5, 3)) }, opts);
  const still = side > 0 ? 0 : 1;
  let best = null;
  for (const g of [0.25, 0.5, 1, 2, opts.guess]) {
    if (!(g > 0)) continue;
    const fit = fitBand(samples, { ...frame, edges: edgesAt(g) }, {
      aperture: carried.aperture, heldStrip: carried.stripLevel,
      slopedLevels: opts.levelSlope === 'fit', heldEdges: [still],
    });
    if (fit && (!best || fit.rms < best.rms)) best = fit;
  }
  if (!best) return null;
  const moving = best.edges[1 - still];
  const at = (t) => {
    const hh = moving.c + moving.m * t;
    return [frame.ox + frame.ux * t + frame.nx * hh, frame.oy + frame.uy * t + frame.ny * hh];
  };
  const [x0, y0] = at(-frame.half), [x1, y1] = at(frame.half);
  return {
    gap: side * moving.c,
    gapSigma: best.gapSigma,
    moving: { x0, y0, x1, y1 },
    levels: best.levels,
    levelSlopes: best.levelSlopes,
    stripLevel: carried.stripLevel,
    aperture: carried.aperture,
    rms: best.rms,
    samples: best.samples,
    iterations: best.iterations,
    converged: best.converged,
  };
}

module.exports = {
  fitPairs, findPairs, trackPair, hiddenIn, candidates, pairFrame, loneFrame, bandSamples, fitBand,
  measureAperture, loneApertures, medianAperture,
  coverage, density, solve, DEFAULTS,
};
