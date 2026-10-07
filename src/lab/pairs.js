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
  profile: 'box',   // a pixel's step: 'box', or 'smooth' -- a box blurred (see below)
  minSigmas: 3,     // a gap under this many gapSigma is not told from none
  ledge: 'detect',  // fitPairs: whether a shadow ramp lies inside the strip; or 'none'
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

/*
 * THE SMOOTH PROFILE. A box is right for a pixel and wrong for a lens: an
 * optic's blur has tails, and 0.8 px of it is what real cameras do. With
 * `profile: 'smooth'` the projected pixel (a unit square, so a = nMin and
 * b = nMax) is convolved with a blur made of three equal boxes -- a quadratic
 * B-spline, the classic stand-in for a Gaussian, and still piecewise
 * polynomial, so nothing transcendental enters. The aperture keeps its
 * meaning: the width of the box with the same spread, so a number measured
 * under one profile is comparable with one measured under the other.
 * Variance adds: w^2/12 = 1/12 + 3 s^2/12. At w <= 1 there is no blur left
 * to model, and the profile is the box (design-lab-model.md §5, "A
 * twenty-fifth").
 */
const SMOOTH_MIN = 1.004; // below this the blur is too narrow to be worth its cancellation

/** The pixel side and the blur-box width an aperture `w` stands for. */
function shapeOf(w, profile) {
  if (profile !== 'smooth' || !(w > SMOOTH_MIN)) return { p: w, s: 0 };
  return { p: 1, s: Math.sqrt((w * w - 1) / 3) };
}

/*
 * The distribution of a sum of uniform variables, by inclusion-exclusion over
 * the boxes: F(y) = sum over subsets S of (-1)^|S| (y - sum S)_+^n / (n! prod w).
 * Evaluated on the lower half only, the upper by symmetry, which keeps the
 * terms -- and the cancellation between them -- small. A box under 1e-3 px is
 * left out: dropping it moves the result by O(w^2), less than keeping it
 * costs in cancellation.
 */
let termsKey = [], terms = null;
function termsOf(widths) {
  if (widths.length === termsKey.length && widths.every((w, i) => w === termsKey[i])) return terms;
  const ws = widths.filter((w) => w >= 1e-3);
  const n = ws.length;
  let W = 0, prod = 1;
  for (const w of ws) { W += w; prod *= w; }
  const shifts = [], odds = [];
  for (let mask = 0; mask < (1 << n); mask++) {
    let shift = 0, odd = false;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { shift += ws[i]; odd = !odd; }
    // Only the lower half is ever evaluated.
    if (shift < W / 2) { shifts.push(shift); odds.push(odd); }
  }
  termsKey = widths.slice();
  terms = { n, W, prod, shifts, odds };
  return terms;
}
function boxSum(x, widths, wantDensity) {
  const { n, W, prod, shifts, odds } = termsOf(widths);
  if (x <= -W / 2) return 0;
  if (x >= W / 2) return wantDensity ? 0 : 1;
  let y = x + W / 2;
  const flip = y > W / 2;
  if (flip) y = W - y;
  const power = wantDensity ? n - 1 : n;
  let acc = 0;
  for (let m = 0; m < shifts.length; m++) {
    const shift = shifts[m];
    if (shift >= y) continue;
    let term = 1;
    for (let j = 0; j < power; j++) term *= y - shift;
    acc += odds[m] ? -term : term;
  }
  let norm = prod;
  for (let j = 2; j <= power; j++) norm *= j;
  const value = acc / norm;
  return wantDensity ? value : (flip ? 1 - value : value);
}

/** `coverage`, with a blur of three boxes `s` wide on top when s > 0. */
function smoothCoverage(d, a, b, s) {
  return s > 0 ? boxSum(d, [2 * a, 2 * b, s, s, s], false) : coverage(d, a, b);
}
function smoothDensity(d, a, b, s) {
  return s > 0 ? boxSum(d, [2 * a, 2 * b, s, s, s], true) : density(d, a, b);
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
  heldEdges = [], maxIterations = MAX_ITERATIONS, profile = 'box', occluder = null, stripAt = 1 }) {
  const { t, h, v } = samples;
  const n = v.length;
  const E = frame.edges.length;
  const nMin = Math.min(Math.abs(frame.nx), Math.abs(frame.ny)) / 2;
  const nMax = Math.max(Math.abs(frame.nx), Math.abs(frame.ny)) / 2;

  // Where each level lives in the parameter vector; -1 for the held strip.
  const levelAt = [];
  let k = 2 * E;
  for (let j = 0; j <= E; j++) levelAt.push(heldStrip !== null && j === stripAt ? -1 : k++);
  const slopeAt = [];
  for (let j = 0; j <= E; j++) slopeAt.push(slopedLevels && levelAt[j] >= 0 ? k++ : -1);
  const APERTURE = fitAperture ? k++ : -1;
  // A soft edge -- a shadow's, inside a strip -- has a width of its own, added
  // to what the aperture gives every edge; `heldWidth` holds it at `width`.
  const softAt = frame.edges.map((e) => (e.soft && !e.heldWidth ? k++ : -1));
  /*
   * An ANCHORED soft edge starts its ramp at another edge: a penumbra that
   * begins at the crease that casts or bounds it. Its line is that edge's,
   * moved by its own half-width toward `side`, so its position is not a
   * parameter of its own; its two slots are held like a held edge's. With an
   * `offset` instead, its middle is that far from the anchor's line, along
   * the normal, whatever its width: a shadow that moves with the edge that
   * casts it.
   */
  const anchorOf = frame.edges.map((e) => (e.soft && e.anchor !== undefined ? e.anchor : -1));
  /*
   * A BOUNDED soft edge cannot pass the adjacent edge `bound`: a shadow on a
   * ledge, where the ledge ends at the still part's edge and the shadow
   * beyond it falls on nothing the camera sees. Where it would pass, its
   * coverage is clamped to the bound's, and the level between the two is
   * seen by no pixel -- the ledge hidden, the two-edge model exactly. So that
   * level, and the edge's width and position, may have no pixel at all, and
   * are then held where they are rather than refusing the fit. `within`
   * names the edge on its other side, which it cannot pass either: a shadow
   * on the ledge is between the two edges, or not in sight.
   */
  const boundOf = frame.edges.map((e) => (e.soft && e.bound !== undefined ? e.bound : -1));
  const withinOf = frame.edges.map((e) => (e.soft && e.within !== undefined ? e.within : -1));
  const ledgeLevelAt = boundOf.map((b, e) => (b < 0 ? -1 : b < e ? e : e + 1));
  const still = [...heldEdges, ...anchorOf.map((a, e) => (a >= 0 ? e : -1)).filter((e) => e >= 0)];
  // A held edge keeps its two slots, with columns of zero: the solve below
  // holds still any parameter no pixel responds to.
  const held = (c) => c < 2 * E && still.includes(c >> 1);
  const free = k - 2 * still.length;
  if (n <= free) return null;

  // A level at t along the band: its value at the middle, plus its slope.
  const level = (q, j, tt = 0) => (levelAt[j] < 0 ? heldStrip
    : q[levelAt[j]] + (slopeAt[j] < 0 ? 0 : q[slopeAt[j]] * tt));
  const widthOf = (q) => (fitAperture ? q[APERTURE] : aperture);
  // The pixel's side and the blur's box, for an aperture w.
  let shapeW = NaN, shape = null;
  const shapeFor = (w) => { if (w !== shapeW) { shapeW = w; shape = shapeOf(w, profile); } return shape; };
  const lowOf = (w) => shapeFor(w).p * nMin;
  const blurOf = (w) => shapeFor(w).s;
  const softOf = (q, e) => (softAt[e] >= 0 ? q[softAt[e]] : frame.edges[e].soft ? frame.edges[e].width : 0);
  const reachOf = (q, e, w) => shapeFor(w).p * nMax + softOf(q, e);
  const cOf = (q, e, w) => (anchorOf[e] < 0 ? q[2 * e]
    : frame.edges[e].offset !== undefined ? q[2 * anchorOf[e]] + frame.edges[e].offset
      : q[2 * anchorOf[e]] + frame.edges[e].side * reachOf(q, e, w));
  const mOf = (q, e) => (anchorOf[e] < 0 ? q[2 * e + 1] : q[2 * anchorOf[e] + 1]);

  /*
   * OCCLUSION. Two edges of a pair, `occluder` naming the one whose part is
   * in front: where that edge has crossed the other, its face covers the
   * other's edge and there is no strip. A pixel's strip share is then
   * max(0, beyond the still edge - beyond the moving one) rather than the
   * difference, so the other edge's coverage is clamped to the occluder's.
   * Where the edges do not cross the clamp never acts and the model is the
   * one above. Where they do, the band is a strip at one end and one edge at
   * the other -- a part turned so far that its pair's edges cross in the
   * picture -- and the fit reads both ends, rather than refusing the band
   * (design-lab-model.md §5, "A twenty-ninth"). Two edges, no soft ones.
   */
  const occluding = occluder !== null && E === 2 && softAt.every((at) => at < 0);
  const other = occluding ? 1 - occluder : -1;
  // Whether the other edge's coverage was clamped to the occluder's, per pixel.
  let clamped = false;
  const clampCover = () => {
    clamped = occluder === 1 ? cover[1] > cover[0] : cover[0] < cover[1];
    if (clamped) cover[other] = cover[occluder];
  };

  // Whether each bounded edge's coverage was clamped to its bound's, per pixel.
  const bounded = new Array(E).fill(false);
  // The bound an edge was clamped to, or -1.
  const boundAt = new Array(E).fill(-1);
  const clampBound = () => {
    for (let e = 0; e < E; e++) {
      boundAt[e] = -1;
      for (const b of [boundOf[e], withinOf[e]]) {
        if (b < 0) continue;
        if (b < e ? cover[e] > cover[b] : cover[e] < cover[b]) { cover[e] = cover[b]; boundAt[e] = b; }
      }
      bounded[e] = boundAt[e] >= 0;
    }
  };

  /** One pixel's value under q, and the coverages that made it. */
  const cover = new Array(E);
  const predict = (q, i, w) => {
    let value = level(q, 0, t[i]);
    for (let e = 0; e < E; e++) {
      cover[e] = smoothCoverage(h[i] - cOf(q, e, w) - mOf(q, e) * t[i], lowOf(w), reachOf(q, e, w), blurOf(w));
    }
    if (occluding) clampCover();
    clampBound();
    for (let e = 0; e < E; e++) value += (level(q, e + 1, t[i]) - level(q, e, t[i])) * cover[e];
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
      for (let e = 0; e < E; e++) { row[2 * e] = 0; row[2 * e + 1] = 0; }
      for (let e = 0; e < E; e++) {
        // A clamped edge's term follows the occluder's line, and so does its
        // derivative; a bounded one's, its bound's.
        const at = occluding && clamped && e === other ? occluder : bounded[e] ? boundAt[e] : e;
        const d = h[i] - cOf(q, at, w) - mOf(q, at) * t[i];
        const step = level(q, e + 1, t[i]) - level(q, e, t[i]);
        const b = reachOf(q, at, w);
        const lo = lowOf(w), s = blurOf(w);
        const g = -step * smoothDensity(d, lo, b, s);
        if (softAt[e] >= 0 && bounded[e]) row[softAt[e]] = 0;
        else if (softAt[e] >= 0) {
          // Its width widens the ramp, and an anchored one's also moves it --
          // unless it is anchored by an offset, which fixes its middle.
          const shift = anchorOf[e] >= 0 && frame.edges[e].offset === undefined ? frame.edges[e].side : 0;
          row[softAt[e]] = step * (smoothCoverage(d - shift * 1e-4, lo, b + 1e-4, s)
            - smoothCoverage(d + shift * 1e-4, lo, b - 1e-4, s)) / 2e-4;
        }
        if (heldEdges.includes(at)) continue;
        const own = anchorOf[at] >= 0 ? anchorOf[at] : at;
        row[2 * own] += g; row[2 * own + 1] += g * t[i];
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
  frame.edges.forEach((e, j) => { if (softAt[j] >= 0) p[softAt[j]] = e.width ?? 0.5; });
  // An anchored edge's slots hold where it is, for the start and the checks.
  const place = (q) => { for (let e = 0; e < E; e++) if (anchorOf[e] >= 0) { q[2 * e] = cOf(q, e, widthOf(q)); q[2 * e + 1] = mOf(q, e); } };
  place(p);
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
    // A ledge no pixel centre falls on starts between its neighbours, or
    // where the caller says it is.
    frame.edges.forEach((e, j) => {
      const at = ledgeLevelAt[j];
      if (at < 0 || levelAt[at] < 0) return;
      if (e.level !== undefined) p[levelAt[at]] = e.level;
      else if (count[at] === 0) p[levelAt[at]] = (level(p, at - 1) + level(p, at + 1)) / 2;
    });
  }

  /*
   * Every solve is of the matrix scaled to a unit diagonal, so "singular" is
   * a property of the problem and not of the units: a level is in light, a
   * slope in px per px, and their columns differ by orders of magnitude.
   * A parameter no pixel responds to has a zero diagonal; it is held still
   * for the step, and the fit as a whole is then not one to report.
   */
  const scaleOf = (JtJ) => JtJ.map((row, c) => (row[c] > 0 ? Math.sqrt(row[c]) : 0));
  // What a hidden ledge leaves without a pixel: held where it is, not refused.
  const mayVanish = new Set();
  boundOf.forEach((b, e) => {
    if (b < 0) return;
    const at = ledgeLevelAt[e];
    if (levelAt[at] >= 0) mayVanish.add(levelAt[at]);
    if (slopeAt[at] >= 0) mayVanish.add(slopeAt[at]);
    if (softAt[e] >= 0) mayVanish.add(softAt[e]);
    if (anchorOf[e] < 0) { mayVanish.add(2 * e); mayVanish.add(2 * e + 1); }
    // And the level on its other side, when it is pressed against `within`.
    const wi = withinOf[e];
    if (wi >= 0) {
      const other = wi > e ? e + 1 : e;
      if (levelAt[other] >= 0) mayVanish.add(levelAt[other]);
      if (slopeAt[other] >= 0) mayVanish.add(slopeAt[other]);
    }
  });

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
    for (const at of softAt) if (at >= 0) q[at] = Math.max(q[at], 1e-3);
    place(q);
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

  // Edges in the order they were given, at both ends of the band -- unless
  // one occludes the other, when crossing is what the model is for. A
  // bounded edge may lie anywhere: past its bound it is simply not seen.
  const ordered = frame.edges.map((_, e) => e).filter((e) => boundOf[e] < 0);
  for (let i = 1; i < ordered.length && !occluding; i++) {
    const [e0, e1] = [ordered[i - 1], ordered[i]];
    const gap = p[2 * e1] - p[2 * e0], tilt = Math.abs(p[2 * e1 + 1] - p[2 * e0 + 1]) * frame.half;
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
  if (d.some((x, c) => x === 0 && !held(c) && !mayVanish.has(c))) return null;
  // Over the free parameters; a held one is an identity row, and known
  // exactly, and so is one a hidden ledge left without a pixel.
  const idle = (c) => held(c) || (d[c] === 0 && mayVanish.has(c));
  const inverseColumn = (col) => {
    if (idle(col)) return new Array(k).fill(0);
    const A = state.JtJ.map((row, c) => row.map((x, e) => (idle(c) || idle(e)
      ? (c === e ? 1 : 0) : x / (d[c] * d[e]))));
    const e = new Array(k).fill(0); e[col] = 1;
    return solve(A, e, 1e-14) ? e.map((x, c) => (idle(c) ? 0 : x / (d[c] * d[col]))) : null;
  };
  const s2 = state.sse / (n - free);
  let gapSigma = null;
  if (E >= 2) {
    // Between the outermost edges: a soft edge inside a strip is not a side of it.
    const last = 2 * (E - 1);
    const i0 = inverseColumn(0), iL = inverseColumn(last);
    if (!i0 || !iL) return null;
    const variance = s2 * (i0[0] + iL[last] - 2 * i0[last]);
    if (!(variance >= 0)) return null;
    gapSigma = Math.sqrt(variance);
  } else if (E === 1 && !held(0)) {
    // One edge: how well its position is pinned, which trackPair reads a gap
    // off when there is no strip.
    const i0 = inverseColumn(0);
    if (i0 && s2 * i0[0] >= 0) gapSigma = Math.sqrt(s2 * i0[0]);
  }

  return {
    edges: frame.edges.map((f, e) => ({ c: p[2 * e], m: p[2 * e + 1], ...(f.soft ? { width: softOf(p, e) } : {}) })),
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
      { aperture: opts.apertureWidth, fitAperture: true, profile: opts.profile });
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
    const samples = bandSamples(raster, frame, opts);
    const fit = fitBand(samples, frame, {
      aperture: aperture.width,
      heldStrip: opts.strip === 'held' ? opts.stripLevel : null,
      slopedLevels: opts.levelSlope === 'fit',
      profile: opts.profile,
    });
    if (!fit) continue;
    const gap = fit.edges[1].c - fit.edges[0].c;
    if (!(gap > opts.minSigmas * fit.gapSigma)) continue;
    const ledge = opts.ledge === 'detect' && opts.strip !== 'held' ? ledgeOf(samples, frame, fit, aperture.width, opts) : null;

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
      ...(opts.ledge === 'detect' ? { ledge } : {}),
      strip: opts.strip,
      aperture: aperture.width,
      apertureFrom: aperture.from,
      apertureSegments: aperture.segments,
      ...(opts.profile !== 'box' ? { profile: opts.profile } : {}),
      rms: fit.rms,
      samples: fit.samples,
      iterations: fit.iterations,
      converged: fit.converged,
    });
  }
  return out;
}

/**
 * Whether the strip holds a ledge in soft shadow (design-lab-model.md §5, the
 * fifteenth): the same pixels fitted again with a ramp that starts at one of
 * the two edges and runs into the strip, a penumbra across a ledge that edge
 * bounds. `gain` is how much better that fits than two plain edges, and
 * `edge` which edge the ramp starts at.
 *
 * A DETECTOR, not a measurement. The ramp fit tells ledge frames (gain 1.4 to
 * 2.5 on the stack) from clean ones (1.0 to 1.1) reliably, but does not place
 * the edge under the penumbra: a ramp starting at an edge and an edge a little
 * further out with a ramp beyond it are nearly the same picture. So the record
 * keeps its two-edge fit, and says the edge it names is not to be trusted --
 * gap-sweep --carry then takes that edge from a frame without a ledge.
 *
 * Null under LEDGE_MIN_GAP, where a ramp inside the strip cannot be told from
 * the strip.
 */
const LEDGE_MIN_GAP = 2;
function ledgeOf(samples, frame, fit, aperture, opts) {
  const [e0, e1] = fit.edges;
  if (!(e1.c - e0.c >= LEDGE_MIN_GAP)) return null;
  let best = null;
  for (const [anchor, side, edge] of [[0, 1, 'a'], [2, -1, 'b']]) {
    for (const width of [0.3, 1, 2]) {
      const soft = { c: 0, m: 0, soft: true, anchor, side, width };
      const three = fitBand(samples, { ...frame, edges: [{ c: e0.c, m: e0.m }, soft, { c: e1.c, m: e1.m }] },
        { aperture, slopedLevels: opts.levelSlope === 'fit', maxIterations: SCREEN_ITERATIONS, profile: opts.profile });
      if (three && three.rms > 0 && (!best || three.rms < best.rms)) best = { rms: three.rms, edge, width: three.edges[1].width };
    }
  }
  return best ? { gain: fit.rms / best.rms, edge: best.edge } : null;
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
    { ...base, edges: loneEdges }, { aperture, maxIterations, profile: opts.profile });
  if (!lone) return null;
  const { c, m } = lone.edges[0];
  const heldStrip = opts.strip === 'held' ? opts.stripLevel : null;

  let best = null;
  for (const side of [-1, 1]) {
    const pairAt = (g) => (side > 0 ? [{ c, m }, { c: c + g, m }] : [{ c: c - g, m }, { c, m }]);
    const samples = bandSamples(raster, { ...base, edges: pairAt(opts.reach) }, opts);
    const one = fitBand(samples, { ...base, edges: [{ c, m }] }, { aperture, maxIterations, profile: opts.profile });
    if (!one) continue;
    // Three starting widths, because a start far from the answer closes the
    // strip up instead of finding it; the best of them is the fit.
    let two = null;
    for (const g of [opts.reach / 4, opts.reach / 2, opts.reach]) {
      const fit = fitBand(samples, { ...base, edges: pairAt(g) }, { aperture, heldStrip, maxIterations, profile: opts.profile });
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

/** trackPair: two edges must fit this much better than one to be a strip, */
const TRACK_STRIP_RATIO = 1.2;
/** ...and one edge is the picture when two fit no better than this, */
const TRACK_EDGE_RATIO = 1.0;
/** ...unless two FREE edges beat one by this: then there is a strip, whatever the line. */
const TRACK_FREE_RATIO = 1.15;

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
 * `options.strip` is 'held' (the default: the strip level carried in) or
 * 'fit': over a gap wide enough to show its own strip, only the still line is
 * carried. That is how a ledge is read (the fifteenth): the still part's edge
 * where a frame without one placed it, the rest from this frame.
 *
 * Returns one `edge-track` record: the gap at the middle of the line, positive
 * toward `toward`, with `gapSigma`, the `still` line as given and the `moving`
 * edge over the same stretch; or, where a strip and one edge fit about as
 * well, `model: 'ambiguous'` with no gap and both readings as `hypotheses`,
 * each with its gap and moving line; or null when no
 * strip can be fitted -- the edges cross, which is what contact does in most
 * views. A gap returned is NOT tested against its sigma: at contact a few
 * views return 0.02 to 0.09 px with sigmas that would pass, and the caller is
 * the one who knows whether the parts can be touching.
 */
function trackPair(raster, carried, options = {}) {
  const opts = { ...DEFAULTS, guess: 1, ...options };
  // Its own option, not DEFAULTS.strip: fitPairs fits its strip by default,
  // and trackPair holds it unless told otherwise.
  const fitStrip = options.strip === 'fit';
  const l = lineOf(carried.line);
  if (!l) return null;
  const frame = {
    ox: l.x0 + l.ux * (l.len / 2), oy: l.y0 + l.uy * (l.len / 2),
    ux: l.ux, uy: l.uy, nx: -l.uy, ny: l.ux, half: l.len / 2,
  };
  const side = (carried.toward[0] - frame.ox) * frame.nx + (carried.toward[1] - frame.oy) * frame.ny >= 0 ? 1 : -1;
  const edgesAt = (g, m = 0) => (side > 0 ? [{ c: 0, m: 0 }, { c: g, m }] : [{ c: -g, m }, { c: 0, m: 0 }]);
  /*
   * Where the fits start: parallel to the line at several widths, and at
   * the guessed width turned either way. A part turned far enough for its
   * edge to cross the still one sits in a different minimum from the
   * parallel starts': from them, a strip 0.56 px wide fitted a true 1.25
   * whose ends were -2.0 and +4.5, no better than one edge.
   */
  const starts = [...[0.25, 0.5, 1, 2, opts.guess].filter((g) => g > 0).map((g) => [g, 0]),
    ...(opts.guess > 0 ? [-0.15, -0.075, 0.075, 0.15].map((m) => [opts.guess, m]) : [])];
  // One set of pixels for every start, and for the single edge below: wide
  // enough for the widest strip on the moving side. The band's own `pad`
  // reaches an overhang of a few pixels on the other; reaching further pulled
  // in the still part's next edge, and the two-edge fit failed on it.
  const samples = bandSamples(raster, { ...frame, edges: edgesAt(Math.max(opts.guess + 1.5, 3)) }, opts);
  const still = side > 0 ? 0 : 1;
  // The still and the moving edge of a fit, which has a shadow between them
  // when there is a ledge.
  const stillOf = (f) => (side > 0 ? f.edges[0] : f.edges[f.edges.length - 1]);
  const movingOf = (f) => (side > 0 ? f.edges[f.edges.length - 1] : f.edges[0]);
  /*
   * A two-edge fit whose moving edge is past the still one along the whole
   * band has a strip nowhere: under occlusion that IS the one-edge model,
   * with a still edge and a strip level that touch no pixel. It is not a
   * reading of a strip, and is left to the one-edge fit below.
   */
  const open = (f) => {
    const [ms, ss] = [movingOf(f), stillOf(f)];
    const gap = side * (ms.c - ss.c), tilt = Math.abs(ms.m - ss.m) * frame.half;
    return gap + tilt > 0;
  };
  let best = null;
  for (const [g, m] of starts) {
    const fit = fitBand(samples, { ...frame, edges: edgesAt(g, m) }, {
      aperture: carried.aperture, heldStrip: fitStrip ? null : carried.stripLevel,
      slopedLevels: opts.levelSlope === 'fit', heldEdges: [still], profile: opts.profile, occluder: 1 - still,
    });
    if (fit && open(fit) && (!best || fit.rms < best.rms)) best = fit;
  }
  /*
   * A LEDGE (design-lab-model.md §5, "A thirty-second"). Slid back, the
   * moving part uncovers a strip of the still part's top face inside the
   * gap, lit, with the moving part's own shadow across it. The strip is then
   * three levels -- the lit ledge against the still edge, the shadow's soft
   * edge, the dark beyond it -- and fitted as one, the dark level comes out
   * too light and the moving edge too far out. `ledge: 'fit'` places the
   * shadow's edge freely, its width and the ledge's level too. Given
   * `{ offset, width }`, the shadow's middle is `offset` px from the moving
   * edge toward the still one, as a shadow that moves with the part casting
   * it is, and its width is held: one more level, and nothing else. Either
   * way the ledge ends at the still edge, and a shadow that reaches past it
   * hides the ledge: that is the two-edge model, exactly.
   */
  let shadowAt = -1, ledgeGain = null;
  if (opts.ledge) {
    const plain = best;
    best = null;
    const spec = opts.ledge === 'fit' ? null : opts.ledge;
    const ledgeEdges = (g, m, x) => {
      const [s0, m0] = [{ c: 0, m: 0 }, { c: side * g, m }];
      const shadow = spec
        ? { c: 0, m: 0, soft: true, width: spec.width ?? 0.5, heldWidth: spec.width != null, anchor: side > 0 ? 2 : 0, offset: -side * spec.offset }
        : { c: side * g * x, m: m * x, soft: true, width: 0.5 };
      shadow.bound = side > 0 ? 0 : 2;
      shadow.within = side > 0 ? 2 : 0;
      return side > 0 ? [s0, shadow, m0] : [m0, shadow, s0];
    };
    const sIdx = side > 0 ? 0 : 2;
    for (const [g, m] of starts) {
      for (const x of spec ? [0] : [0.3, 0.6]) {
        const fit = fitBand(samples, { ...frame, edges: ledgeEdges(g, m, x) }, {
          aperture: carried.aperture, heldStrip: fitStrip ? null : carried.stripLevel,
          slopedLevels: opts.levelSlope === 'fit', heldEdges: [sIdx], profile: opts.profile, stripAt: side > 0 ? 2 : 1,
        });
        if (fit && open(fit) && (!best || fit.rms < best.rms)) best = fit;
      }
    }
    /*
     * The ledge is kept only when it fits better than the strip alone by
     * `ledgeGain`: one more level, or four, always fit a little better. And
     * only when it moves the moving edge less than `ledgeShift` px from where
     * the strip alone put it. Over every stack run, clean and blurred, a ledge
     * moved it -0.59 to +0.39 px; a sharp shadow can instead pass for the
     * moving edge, and then the fit puts the moving edge out on the moving
     * part's face. One such fit read 11.67 px for 5.52, fitting 1.003 times
     * better, and cost the test poses a millimetre (design-lab-model.md §5,
     * "A thirty-third").
     */
    ledgeGain = best && plain && best.rms > 0 ? plain.rms / best.rms : null;
    const shift = best && plain ? Math.abs(movingOf(best).c - movingOf(plain).c) : 0;
    if (best && (!plain || (ledgeGain >= (opts.ledgeGain ?? 1) && shift <= (opts.ledgeShift ?? 1)))) shadowAt = 1;
    else best = plain;
  }
  /*
   * The same pixels as ONE edge beside the line, free. Where the two parts'
   * faces meet with no strip between them -- in contact, or the moving edge
   * past the still one, an overhang -- the picture is one edge, the moving
   * part's, and its signed distance from the still line is the gap: about
   * zero, or negative. Two edges forced onto it invent a strip of 0.1 to
   * 0.5 px; on the stack's test poses, one overhang of 1.19 px read +0.18.
   *
   * Which picture it is, is how much better two edges fit than one (`ratio`,
   * the one edge's rms over the two's). Over a real strip 1.2 and up; over
   * an overhang under 1. Between, both happen -- a real 0.3 px gap reads
   * 1.11, an overhang of 0.4 px 1.09 -- and there no gap is given: a
   * reading that may be off by half a pixel either way is not one. Both are
   * given instead, as `hypotheses`, for a caller that can tell them apart
   * from outside the frame: a pose carried from the last frame predicts the
   * gap (design-lab-model.md §5, "A twenty-first").
   */
  let lone = null;
  for (const c0 of [-1, 0, 1]) {
    const fit = fitBand(samples, { ...frame, edges: [{ c: side * c0, m: 0 }] }, {
      aperture: carried.aperture, slopedLevels: opts.levelSlope === 'fit', profile: opts.profile,
    });
    if (fit && (!lone || fit.rms < lone.rms)) lone = fit;
  }
  /*
   * And whether there is a strip at all, asked WITHOUT the carried line: two
   * free edges against the one. A carried line a little off makes the held
   * fit worse and could hand a real 0.6 px strip to the single edge, as a
   * 0.4 px overhang; the free fit still sees the strip. Over an overhang it
   * finds nothing the one edge does not (1.00 on the stack, every time).
   */
  let free = null;
  for (const [g, m] of starts) {
    const f = fitBand(samples, { ...frame, edges: edgesAt(g, m) }, {
      aperture: carried.aperture, heldStrip: fitStrip ? null : carried.stripLevel,
      slopedLevels: opts.levelSlope === 'fit', profile: opts.profile, occluder: 1 - still,
    });
    if (f && open(f) && (!free || f.rms < free.rms)) free = f;
  }
  const ratio = best && lone && best.rms > 0 ? lone.rms / best.rms : null;
  const freeRatio = free && lone && free.rms > 0 ? lone.rms / free.rms : null;
  let model;
  if (best && (lone === null || ratio >= TRACK_STRIP_RATIO || freeRatio >= TRACK_FREE_RATIO)) model = 'strip';
  // One edge only on evidence: two that fit no better. Two that failed to fit
  // at all are not that -- at 50 degrees they failed on gaps of 1.2 to 2.7 px.
  else if (lone && ratio !== null && ratio < TRACK_EDGE_RATIO && !(freeRatio >= TRACK_FREE_RATIO)) model = 'edge';
  else if (best && lone) model = 'ambiguous';
  else return null;
  const movingLine = (edge) => {
    const at = (t) => {
      const hh = edge.c + edge.m * t;
      return [frame.ox + frame.ux * t + frame.nx * hh, frame.oy + frame.uy * t + frame.ny * hh];
    };
    const [x0, y0] = at(-frame.half), [x1, y1] = at(frame.half);
    return { x0, y0, x1, y1 };
  };
  const stillLine = { x0: carried.line.x0, y0: carried.line.y0, x1: carried.line.x1, y1: carried.line.y1 };
  if (model === 'ambiguous') {
    const hypothesis = (m, f, edge) => ({ model: m, gap: side * edge.c, gapSigma: f.gapSigma, moving: movingLine(edge), rms: f.rms });
    return {
      type: 'edge-track',
      id: 1,
      still: stillLine,
      toward: [carried.toward[0], carried.toward[1]],
      gap: null,
      gapSigma: null,
      moving: null,
      model,
      ratio,
      freeRatio,
      hypotheses: [hypothesis('strip', best, movingOf(best)), hypothesis('edge', lone, lone.edges[0])],
      stripLevel: fitStrip ? best.levels[side > 0 ? best.levels.length - 2 : 1] : carried.stripLevel,
      aperture: carried.aperture,
    };
  }
  const ledgeOf3 = (f) => {
    const [sh, mv, st] = [f.edges[1], movingOf(f), stillOf(f)];
    return {
      offset: side * (mv.c - sh.c), width: sh.width,
      level: f.levels[side > 0 ? 1 : 2], seen: side * (sh.c - st.c) > 0, lit: side * (sh.c - st.c), gain: ledgeGain,
    };
  };
  const fit = model === 'strip' ? best : lone;
  const moving = model === 'strip' ? movingOf(best) : lone.edges[0];
  const { x0, y0, x1, y1 } = movingLine(moving);
  return {
    type: 'edge-track',
    id: 1,
    still: { x0: carried.line.x0, y0: carried.line.y0, x1: carried.line.x1, y1: carried.line.y1 },
    toward: [carried.toward[0], carried.toward[1]],
    gap: side * moving.c,
    gapSigma: fit.gapSigma,
    moving: { x0, y0, x1, y1 },
    // 'strip': two edges and a strip between them. 'edge': one edge, the
    // moving part's, against the still part's face -- contact or overhang.
    model,
    ratio,
    freeRatio,
    levels: fit.levels,
    levelSlopes: fit.levelSlopes,
    strip: model === 'edge' ? null : fitStrip ? 'fit' : 'held',
    stripLevel: model === 'edge' ? null : fitStrip ? best.levels[side > 0 ? best.levels.length - 2 : 1] : carried.stripLevel,
    // The ledge as fitted: the shadow's middle, px from the moving edge toward
    // the still one, its width, the lit ledge's level, how far the shadow's
    // middle is from the still edge (`lit`) and so whether any of it is in
    // sight, and how much better than the strip alone it fits.
    ...(model === 'strip' && shadowAt >= 0 ? { ledge: ledgeOf3(best) } : {}),
    aperture: carried.aperture,
    rms: fit.rms,
    samples: fit.samples,
    iterations: fit.iterations,
    converged: fit.converged,
  };
}

module.exports = {
  fitPairs, findPairs, trackPair, hiddenIn, candidates, pairFrame, loneFrame, bandSamples, fitBand,
  measureAperture, loneApertures, medianAperture,
  coverage, density, solve, DEFAULTS,
};
