'use strict';

/**
 * One row of a gap sweep: how well the pipeline sees the gap between two
 * parts, measured against what the renderer says is there.
 *
 * The quantity is the one image-based servoing would drive to zero -- the
 * distance IN THE IMAGE between the moving part's leading edge and the edge of
 * the target it is closing on -- rather than a 6-DoF relative pose. cv-lab has
 * no pose estimator, and putting one in front of this measurement would make
 * its errors part of the result.
 *
 * Pure JavaScript over the feature records `npm run lab` writes, like the rest
 * of src/lab/. No pixels.
 *
 * THE FACING PAIR
 *
 * The true gap is measured between two ground-truth edges: one belonging only
 * to the moving part, one only to the target, near-parallel in the image,
 * overlapping along their length, and near each other IN DEPTH as well as in
 * the image. The depth test is what stops a far edge that happens to project
 * close -- the back of a table behind a cube -- from being taken for the near
 * one. Among the pairs that pass, the one closest in the image wins.
 *
 * The measured gap is the same distance between the two detected segments
 * that `match` paired with those truth edges, taken at the SAME image point:
 * the middle of the truth pair's overlap. Two numbers measured at different
 * places along an edge in perspective would differ for reasons that are not
 * error.
 *
 * SIGN
 *
 * Gaps are signed along the target edge's normal, oriented toward the moving
 * part. A detected gap with the wrong sign is the detector putting the edges
 * in the wrong order, which an absolute value would hide.
 */

const MIN_VISIBLE = 0.5; // as match.js: below this an edge is not findable

const DEFAULTS = {
  maxAngle: 5,      // degrees between two edges still called parallel
  minOverlap: 10,   // px the facing edges must share along their length
  depthSlack: 0.02, // m of depth difference allowed beyond the gap itself
  spanTolerance: 1.5, // px from a truth edge for a sample to count as on it
  bandMargin: 4,    // px either side of the gap that counts as "in" it
  reach: 2,         // px a detection may stop short of the measuring point
  minVisible: MIN_VISIBLE,
};

/* ---- geometry ------------------------------------------------------ */

function line(seg) {
  const dx = seg.x1 - seg.x0;
  const dy = seg.y1 - seg.y0;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return null;
  const u = [dx / len, dy / len];
  return { p0: [seg.x0, seg.y0], p1: [seg.x1, seg.y1], u, n: [-u[1], u[0]], len };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s];

/** Undirected angle between two lines, in degrees, 0..90. */
function angleBetween(a, b) {
  const c = Math.min(1, Math.abs(dot(a.u, b.u)));
  return (Math.acos(c) * 180) / Math.PI;
}

/**
 * Where line `a` crosses the normal to line `b` through point `at` (already on
 * b), as a signed distance along `normal`. Null when a runs along that normal.
 */
function crossing(a, at, normal) {
  // a.p0 + s*a.u = at + h*normal  ->  solve for h.
  const det = a.u[0] * -normal[1] - a.u[1] * -normal[0];
  if (Math.abs(det) < 1e-9) return null;
  const r = sub(at, a.p0);
  return (a.u[0] * r[1] - a.u[1] * r[0]) / det;
}

/** The point on line b nearest `p`. */
function onLine(b, p) {
  return add(b.p0, b.u, dot(sub(p, b.p0), b.u));
}

/** Distance from point p to the segment of line l. */
function toSegment(l, p) {
  const t = Math.max(0, Math.min(l.len, dot(sub(p, l.p0), l.u)));
  const q = add(l.p0, l.u, t);
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
}

/**
 * The overlap of two near-parallel segments along b's direction, and the
 * signed gap at its middle. Null if they are not parallel or do not overlap.
 */
function facing(a, b, { maxAngle, minOverlap }) {
  if (angleBetween(a, b) > maxAngle) return null;
  const ta0 = dot(sub(a.p0, b.p0), b.u);
  const ta1 = dot(sub(a.p1, b.p0), b.u);
  const lo = Math.max(0, Math.min(ta0, ta1));
  const hi = Math.min(b.len, Math.max(ta0, ta1));
  if (hi - lo < minOverlap) return null;
  const at = add(b.p0, b.u, (lo + hi) / 2);
  // Normal oriented toward a, so a positive gap means "a is on its own side".
  const side = dot(sub(add(a.p0, a.u, a.len / 2), at), b.n);
  const normal = side >= 0 ? b.n : [-b.n[0], -b.n[1]];
  const gap = crossing(a, at, normal);
  if (gap === null) return null;
  return { at, normal, gap, lo, hi, overlap: hi - lo };
}

/* ---- the row ------------------------------------------------------- */

const only = (edge, name, other) => edge.objects.includes(name) && !edge.objects.includes(other);

/**
 * The truth edges facing each other across the gap.
 *
 * @param {object[]} truth  gt-edge records
 * @param {number} gapM     the shot's gap in metres, for the depth test
 */
function truthPair(truth, moving, target, gapM, opts) {
  const visible = truth.filter((e) => e.type === 'gt-edge' && e.visible >= opts.minVisible);
  const movingEdges = visible.filter((e) => only(e, moving, target));
  const targetEdges = visible.filter((e) => only(e, target, moving));
  let best = null;
  for (const ea of movingEdges) {
    const a = line(ea);
    if (!a) continue;
    for (const eb of targetEdges) {
      const b = line(eb);
      if (!b) continue;
      const depthA = (ea.z0 + ea.z1) / 2;
      const depthB = (eb.z0 + eb.z1) / 2;
      if (Math.abs(depthA - depthB) > gapM + opts.depthSlack) continue;
      const f = facing(a, b, opts);
      if (!f) continue;
      if (!best || Math.abs(f.gap) < Math.abs(best.facing.gap)) {
        best = { a: ea, b: eb, facing: f };
      }
    }
  }
  return best;
}

/**
 * The detected segment `match` paired with truth edge `id` that reaches the
 * measuring point -- not simply the longest. A long edge is often found in
 * pieces, and the longest piece can lie well away from where the gap is
 * measured; a gap read off it is an extrapolation, and the error that adds
 * looks exactly like detector error. Returns the nearest piece and how far
 * outside its own extent the point lies (0 when it covers it).
 */
function detectionAt(id, at, matches, segments) {
  const ids = new Set(matches
    .filter((m) => m.kind === 'segment' && m.role === 'hit' && m.truth === id)
    .map((m) => m.detected));
  let best = null;
  for (const s of segments) {
    if (!ids.has(s.id)) continue;
    const l = line(s);
    if (!l) continue;
    const along = dot(sub(at, l.p0), l.u);
    const outside = Math.max(0, -along, along - l.len);
    if (!best || outside < best.outside) best = { seg: s, line: l, outside };
  }
  return best;
}

/**
 * Detected segments lying along BOTH parts' edges: the merge failure, where
 * the pipeline has joined an edge of one part to an edge of the other.
 *
 * Every pixel-step along a segment is attributed to the nearest visible truth
 * edge within `spanTolerance`. A segment spans both when each part claims at
 * least a fifth of it, and three samples at the least. Below about twice the
 * tolerance the two truth edges are themselves that close, so a span there is
 * a statement about resolution as much as about the detector -- the row
 * carries the true gap beside it for that reason.
 */
function spanningBoth(segments, truth, moving, target, opts) {
  const visible = truth
    .filter((e) => e.type === 'gt-edge' && e.visible >= opts.minVisible)
    .map((e) => ({ e, l: line(e) }))
    .filter((x) => x.l);
  const out = [];
  for (const s of segments) {
    const l = line(s);
    if (!l) continue;
    const steps = Math.max(1, Math.floor(l.len));
    let onMoving = 0;
    let onTarget = 0;
    for (let i = 0; i <= steps; i++) {
      const p = add(l.p0, l.u, (l.len * i) / steps);
      let nearest = null;
      let d = opts.spanTolerance;
      for (const { e, l: tl } of visible) {
        const dist = toSegment(tl, p);
        if (dist <= d) { d = dist; nearest = e; }
      }
      if (!nearest) continue;
      if (only(nearest, moving, target)) onMoving++;
      else if (only(nearest, target, moving)) onTarget++;
    }
    const need = Math.max(3, 0.2 * (steps + 1));
    if (onMoving >= need && onTarget >= need) out.push(s.id);
  }
  return out;
}

/** Truth edges of one part that are findable, and how many were found. */
function survival(truth, matches, name, other, opts) {
  const findable = truth.filter((e) =>
    e.type === 'gt-edge' && e.visible >= opts.minVisible && only(e, name, other));
  const missed = new Set(matches
    .filter((m) => m.kind === 'segment' && m.role === 'miss')
    .map((m) => m.truth));
  return { findable: findable.length, found: findable.filter((e) => !missed.has(e.id)).length };
}

/** `explain` causes of the detections whose middle lies in the gap. */
function causesInGap(explained, pair, opts) {
  const b = line(pair.b);
  const { normal, gap, lo, hi } = pair.facing;
  const low = Math.min(0, gap) - opts.bandMargin;
  const high = Math.max(0, gap) + opts.bandMargin;
  const counts = {};
  for (const s of explained) {
    const mid = [(s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2];
    const t = dot(sub(mid, b.p0), b.u);
    const h = dot(sub(mid, b.p0), normal);
    if (t < lo || t > hi || h < low || h > high) continue;
    const cause = s.cause ?? 'none';
    counts[cause] = (counts[cause] ?? 0) + 1;
  }
  return counts;
}

/**
 * Reduce one image's feature lists to one row.
 *
 * @param {object} input
 * @param {object[]} input.truth      gt-edge records (the T slot)
 * @param {object[]} input.segments   edge-segment records (F)
 * @param {object[]} input.explained  F after explain (EF): same ids, with `cause`
 * @param {object[]} input.matches    edge-match records for F (MF)
 * @param {object[]} [input.pairs]    edge-pair records for F (P), if the
 *                                    pipeline ran fitPairs
 * @param {object} shot  { gapMm }
 * @param {object} parts { moving, target } -- object names, as the truth has them
 */
function gapRow({ truth, segments, explained, matches, pairs }, shot, { moving, target }, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const row = {
    gapMm: shot.gapMm,
    trueGapPx: null,
    measuredGapPx: null,
    errorPx: null,
    pairFound: false,
    truthPair: null,
    detectedPair: null,
    spansBoth: spanningBoth(segments, truth, moving, target, opts).length,
    moving: survival(truth, matches, moving, target, opts),
    target: survival(truth, matches, target, moving, opts),
    causes: {},
    movingOffsetPx: null,
    targetOffsetPx: null,
    refit: null,
    reason: null,
  };

  const pair = truthPair(truth, moving, target, shot.gapMm / 1000, opts);
  if (!pair) return { ...row, reason: 'no facing pair in the ground truth' };
  row.trueGapPx = pair.facing.gap;
  row.truthPair = [pair.a.id, pair.b.id];
  row.causes = causesInGap(explained, pair, opts);

  const da = detectionAt(pair.a.id, pair.facing.at, matches, segments);
  const db = detectionAt(pair.b.id, pair.facing.at, matches, segments);
  if (!da) return { ...row, reason: `no detection matched ${moving}'s edge` };
  if (!db) return { ...row, reason: `no detection matched ${target}'s edge` };
  if (da.seg.id === db.seg.id) return { ...row, reason: 'one detection matched both edges' };
  if (da.outside > opts.reach || db.outside > opts.reach) {
    return { ...row, reason: `detections stop ${Math.max(da.outside, db.outside).toFixed(1)} px short of the measuring point` };
  }
  if (angleBetween(da.line, db.line) > opts.maxAngle) {
    return { ...row, reason: 'detected edges are not parallel' };
  }

  const read = measureAt(da.line, db.line, pair.facing);
  if (!read) return { ...row, reason: 'detected edges are not parallel' };

  row.pairFound = true;
  row.detectedPair = [da.seg.id, db.seg.id];
  row.measuredGapPx = read.gap;
  row.errorPx = read.gap - row.trueGapPx;
  row.movingOffsetPx = read.movingOffset;
  row.targetOffsetPx = read.targetOffset;

  /*
   * The same two edges as `fitPairs` placed them, if the pipeline ran it and
   * it took these two as a pair. Measured exactly as the detections are, at
   * the same point, so the two readings differ only in where the edges were
   * put. Beside the detections' reading rather than instead of it: the
   * difference between them is the thing being measured.
   */
  const refit = (pairs ?? []).find((p) => p.type === 'edge-pair'
    && ((p.a.segment === da.seg.id && p.b.segment === db.seg.id)
      || (p.a.segment === db.seg.id && p.b.segment === da.seg.id)));
  if (refit) {
    const [ea, eb] = refit.a.segment === da.seg.id ? [refit.a, refit.b] : [refit.b, refit.a];
    const la = line(ea), lb = line(eb);
    const along = (l) => dot(sub(pair.facing.at, l.p0), l.u);
    const outside = (l) => Math.max(0, -along(l), along(l) - l.len);
    const r = la && lb && Math.max(outside(la), outside(lb)) <= opts.reach
      ? measureAt(la, lb, pair.facing) : null;
    if (r) {
      row.refit = {
        pair: refit.id,
        gapPx: r.gap,
        errorPx: r.gap - row.trueGapPx,
        movingOffsetPx: r.movingOffset,
        targetOffsetPx: r.targetOffset,
        gapSigma: refit.gapSigma,
        strip: refit.strip,
        stripLevel: refit.levels[1],
      };
    }
  }
  return row;
}

/**
 * The gap between two lines, and each one's offset from its own truth edge.
 *
 * The gap is taken at the truth pair's measuring point, along the TARGET
 * line's normal, oriented as the truth's was. Null when the moving line runs
 * along that normal.
 *
 * The offsets split the error by edge: where each line crosses the TRUTH
 * pair's normal at the measuring point, against where its own truth edge
 * does. Positive is toward the moving part, as the gap is. So
 *   error ~= movingOffset - targetOffset
 * exactly when the lines are parallel to the truth's; otherwise the two
 * frames differ by the cosine of a small angle, and the gap itself is still
 * measured as it always was, along the target line.
 *
 * These found the pixel-convention mismatch between pt-lab's truth and the
 * lab's detections: both edges displaced the same way by about half a
 * pixel. The truth is converted at load now (PIXEL_CENTRE in
 * groundtruth.js), so what is left here is each edge's own offset.
 */
function measureAt(movingLine, targetLine, T) {
  const at = onLine(targetLine, T.at);
  const normal = dot(targetLine.n, T.normal) >= 0 ? targetLine.n : [-targetLine.n[0], -targetLine.n[1]];
  const gap = crossing(movingLine, at, normal);
  if (gap === null) return null;
  const ca = crossing(movingLine, T.at, T.normal);
  const cb = crossing(targetLine, T.at, T.normal);
  const split = ca !== null && cb !== null;
  return { gap, movingOffset: split ? ca - T.gap : null, targetOffset: split ? cb : null };
}

/**
 * Pixels per millimetre of gap, from the truth alone: the median of
 * trueGapPx / gapMm over the steps with a gap. The image scale near the
 * contact, so an error in pixels can be read in millimetres.
 */
function pxPerMm(rows) {
  const r = rows
    .filter((x) => x.gapMm > 0 && Number.isFinite(x.trueGapPx))
    .map((x) => x.trueGapPx / x.gapMm)
    .sort((a, b) => a - b);
  if (r.length === 0) return null;
  const m = Math.floor(r.length / 2);
  return r.length % 2 ? r[m] : (r[m - 1] + r[m]) / 2;
}

/**
 * Which shots' inputs differ between two analyses of the same run.
 *
 * Each argument maps a shot name to the hashes of the files the lab read for
 * it -- { image, truth, depth, normal, albedo }. A render is a sample, not a
 * function of its shot, so two analyses under one name are comparable only
 * if every one of these is the same; a shot present on one side only counts
 * as changed. Returns [{ shot, files: [...] }], in the order of `now`, then
 * any shots `now` no longer has.
 */
function changedInputs(previous, now) {
  const out = [];
  for (const [shot, files] of Object.entries(now)) {
    const was = previous[shot];
    if (!was) { out.push({ shot, files: ['new'] }); continue; }
    const kinds = [...new Set([...Object.keys(was), ...Object.keys(files)])]
      .filter((k) => was[k] !== files[k]);
    if (kinds.length > 0) out.push({ shot, files: kinds });
  }
  for (const shot of Object.keys(previous)) {
    if (!(shot in now)) out.push({ shot, files: ['gone'] });
  }
  return out;
}

module.exports = { gapRow, pxPerMm, truthPair, facing, line, changedInputs, DEFAULTS };
