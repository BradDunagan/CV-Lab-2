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
 * the image -- at the place the gap is measured, since a long edge seen
 * obliquely spans a great deal of depth. The depth test is what stops a far edge that happens to project
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
 * Gaps are signed along the target edge's normal, oriented toward the middle
 * of the moving part. A detected gap with the wrong sign is the detector
 * putting the edges in the wrong order, which an absolute value would hide.
 * A TRUE gap with a negative sign is the moving part's edge past the
 * target's: an overhang.
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
function facing(a, b, { maxAngle, minOverlap }, toward = null, away = null) {
  if (angleBetween(a, b) > maxAngle) return null;
  const ta0 = dot(sub(a.p0, b.p0), b.u);
  const ta1 = dot(sub(a.p1, b.p0), b.u);
  const lo = Math.max(0, Math.min(ta0, ta1));
  const hi = Math.min(b.len, Math.max(ta0, ta1));
  if (hi - lo < minOverlap) return null;
  const at = add(b.p0, b.u, (lo + hi) / 2);
  /*
   * Which way is positive. Toward `toward` when the caller has one -- the
   * middle of the moving PART -- and otherwise toward a itself.
   *
   * The difference is the whole of the sign. Oriented toward a, the gap is
   * positive by construction, whichever side a is on; a part slid until its
   * edge crosses the target's then reads as the gap closing to zero and
   * opening again, a V. Oriented toward the part, the edge that has crossed
   * is on the wrong side of the target's and the gap is negative, which is
   * what an overhang is.
   */
  const side = away ? dot(away, b.n) : dot(sub(toward ?? add(a.p0, a.u, a.len / 2), at), b.n);
  const normal = side >= 0 ? b.n : [-b.n[0], -b.n[1]];
  const gap = crossing(a, at, normal);
  if (gap === null) return null;
  return { at, normal, gap, lo, hi, overlap: hi - lo };
}

/**
 * A truth edge's depth at a point on it. Depth is not linear along an edge in
 * the image; its reciprocal is, so that is what is interpolated between the
 * two ends. Clamped to the edge: past an end, the end's depth.
 */
function depthAt(edge, l, p) {
  const s = Math.max(0, Math.min(1, dot(sub(p, l.p0), l.u) / l.len));
  return 1 / ((1 - s) / edge.z0 + s / edge.z1);
}

/* ---- the row ------------------------------------------------------- */

const only = (edge, name, other) => edge.objects.includes(name) && !edge.objects.includes(other);

/**
 * The truth edges facing each other across the gap.
 *
 * @param {object[]} truth  gt-edge records
 * @param {number} gapM     the shot's gap in metres, for the depth test
 */
function facingCandidates(truth, moving, target, gapM, opts) {
  const visible = truth.filter((e) => e.type === 'gt-edge' && e.visible >= opts.minVisible);
  const movingEdges = visible.filter((e) => only(e, moving, target));
  const targetEdges = visible.filter((e) => only(e, target, moving));
  // The middle of the moving part in the image: the mean of the midpoints of
  // ALL its edges, seen or not, so that it does not shift as edges come into
  // view.
  const whole = truth.filter((e) => e.type === 'gt-edge' && only(e, moving, target));
  const middle = whole.length === 0 ? null : [
    whole.reduce((s, e) => s + (e.x0 + e.x1) / 2, 0) / whole.length,
    whole.reduce((s, e) => s + (e.y0 + e.y1) / 2, 0) / whole.length,
  ];
  /*
   * Which side of the gap the moving part is on, for the sign. The part's
   * middle was enough with the moving part above: seen from above, a part
   * BELOW the gap has its middle projected above its own near top edge -- its
   * depth carries it up the picture further than its half height carries it
   * down -- and from 50 degrees up every gap of a base cube lowered from the
   * one above it read as an overhang (design-lab-model.md §5, "A
   * thirty-fifth"). The still part's middle is displaced the same way, so the
   * direction from it to the moving part's is the side, above or below.
   */
  const still = truth.filter((e) => e.type === 'gt-edge' && only(e, target, moving));
  const stillMiddle = still.length === 0 ? null : [
    still.reduce((s, e) => s + (e.x0 + e.x1) / 2, 0) / still.length,
    still.reduce((s, e) => s + (e.y0 + e.y1) / 2, 0) / still.length,
  ];
  const away = middle && stillMiddle ? [middle[0] - stillMiddle[0], middle[1] - stillMiddle[1]] : null;
  const out = [];
  for (const ea of movingEdges) {
    const a = line(ea);
    if (!a) continue;
    for (const eb of targetEdges) {
      const b = line(eb);
      if (!b) continue;
      const f = facing(a, b, opts, middle, away);
      if (!f) continue;
      // Depth where the gap is measured, not each edge's average. A table's
      // edge a metre long, seen at 45 degrees, has a mean depth nowhere near
      // that of a 10 cm cube edge resting on its near end, and comparing
      // means found no facing pair at all from any yaw past about 30 degrees.
      const depthA = depthAt(ea, a, onLine(a, f.at));
      const depthB = depthAt(eb, b, f.at);
      if (Math.abs(depthA - depthB) > gapM + opts.depthSlack) continue;
      out.push({ a: ea, b: eb, facing: f });
    }
  }
  return out;
}

function truthPair(truth, moving, target, gapM, opts) {
  let best = null;
  for (const c of facingCandidates(truth, moving, target, gapM, opts)) {
    if (!best || Math.abs(c.facing.gap) < Math.abs(best.facing.gap)) best = c;
  }
  return best;
}

/**
 * EVERY pair of truth edges facing each other across the gap, for a fixture
 * that has more than one: a cube stacked on a cube shows two, at right angles,
 * and each measures a different direction of the same displacement.
 *
 * A pair is kept when each edge is the other's NEAREST facing edge. That is
 * what makes a top cube's bottom edge pair with the base's top edge and not
 * with the base's bottom edge 10 cm below, which is also parallel, also
 * overlapping and also near in depth; and what stops the top cube's own top
 * edge, whose nearest target edge is that same one, from being a second pair
 * with it.
 *
 * In order of where each is measured, left to right and then top to bottom,
 * so that with the camera held still pair k is the same pair in every shot.
 */
function truthPairs(truth, moving, target, gapM, opts) {
  const all = facingCandidates(truth, moving, target, gapM, opts);
  const nearest = (key) => {
    const best = new Map();
    for (const c of all) {
      const was = best.get(c[key].id);
      if (!was || Math.abs(c.facing.gap) < Math.abs(was.facing.gap)) best.set(c[key].id, c);
    }
    return best;
  };
  const ofMoving = nearest('a'), ofTarget = nearest('b');
  const mutual = all.filter((c) => ofMoving.get(c.a.id) === c && ofTarget.get(c.b.id) === c);
  /*
   * And not far further apart than the closest pair is. Each-other's-nearest
   * is true of two edges that have nothing nearer, however far apart: in two
   * of the gap sweep's 28 views the cube's top edge and the table's far edge
   * were such a pair, 205 px apart beside a real one at 6, and got a row.
   * Pairs across one gap are the same gap seen from different sides, and
   * differ by the views' foreshortening and by a slide's few pixels, not by
   * a factor of thirty. Three times the closest, or 10 px more than it,
   * whichever is larger: the second is for a closest pair that is nearly
   * closed.
   */
  const closest = Math.min(...mutual.map((c) => Math.abs(c.facing.gap)));
  return mutual
    .filter((c) => Math.abs(c.facing.gap) <= Math.max(3 * closest, closest + 10))
    .sort((p, q) => p.facing.at[0] - q.facing.at[0] || p.facing.at[1] - q.facing.at[1]);
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
 * @param {object[]} [input.pairs]    edge-pair records for F, if the pipeline
 *                                    ran fitPairs or findPairs
 * @param {object} shot  { gapMm }
 * @param {object} parts { moving, target } -- object names, as the truth has them
 */
function gapRow(input, shot, parts, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const row = rowBase(input, shot, parts, opts);
  const pair = truthPair(input.truth, parts.moving, parts.target, separation(shot), opts);
  if (!pair) return { ...row, reason: 'no facing pair in the ground truth' };
  return rowFor(row, pair, input, parts, opts);
}

/**
 * One row per facing truth pair in the image -- `truthPairs` -- each numbered
 * in `pair`, from 1. A shot with no facing pair still gets its one row, saying
 * so, with `pair` null. What is counted over the whole image (segments
 * spanning both parts, edges found) is the same in each of a shot's rows.
 */
function gapRows(input, shot, parts, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const base = rowBase(input, shot, parts, opts);
  const found = truthPairs(input.truth, parts.moving, parts.target, separation(shot), opts);
  if (found.length === 0) {
    const reason = 'no facing pair in the ground truth';
    const tracks = (input.tracks ?? []).filter((t) => t.type === 'edge-track');
    if (tracks.length === 0) return [{ ...base, pair: null, reason }];
    /*
     * At contact the two truth edges coincide and there is no facing pair --
     * and that is the frame where a track's reading matters most: does it say
     * zero, or a gap? So each track is a row of its own, read at its own
     * middle, and numbered like the rest by the angle of its still line. On a
     * sweep down to contact the true gap there is zero by construction;
     * anywhere else it is not known, and no error is claimed.
     */
    const contact = shot.gapMm === 0 && shot.separationMm === undefined;
    return tracks.map((t, k) => {
      const l = line(t.still);
      const deg = l ? (Math.atan2(l.u[1], l.u[0]) * 180) / Math.PI : null;
      return {
        ...base,
        trueGapPx: contact ? 0 : null,
        pairAngle: deg === null ? null : ((deg % 180) + 180) % 180,
        tracked: { gapPx: t.gap, endsPx: null, errorPx: contact && t.gap !== null ? t.gap : null, movingOffsetPx: null,
          targetOffsetPx: null, gapSigma: t.gapSigma, rms: t.rms, stripLevel: t.stripLevel,
          ...(t.model === 'ambiguous' ? { ambiguous: true, hypotheses: t.hypotheses.map((h) => ({ model: h.model,
            gapPx: h.gap, endsPx: null, errorPx: contact ? h.gap : null, gapSigma: h.gapSigma })) } : {}) },
        pair: k + 1,
        reason,
      };
    });
  }
  return found.map((pair, k) => ({ ...rowFor({ ...base }, pair, input, parts, opts), pair: k + 1 }));
}

/**
 * How far apart the two parts are in this shot, in metres, for the depth
 * test. The swept step, unless the shot says otherwise: a sweep ACROSS an open
 * gap carries `separationMm`, because its step is not the distance.
 */
const separation = (shot) => Math.abs(shot.separationMm ?? shot.gapMm) / 1000;

function rowBase({ truth, segments, matches }, shot, { moving, target }, opts) {
  const row = {
    gapMm: shot.gapMm,
    trueGapPx: null,
    overlapPx: null,
    pairAngle: null,
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
    endsTruePx: null,
    endsDetectedPx: null,
    refit: null,
    tracked: null,
    reason: null,
  };
  return row;
}

function rowFor(row, pair, { segments, explained, matches, pairs, tracks, ledgeFits }, { moving, target }, opts) {
  row.trueGapPx = pair.facing.gap;
  // How much edge there is to measure it on: the stretch the two truth edges
  // share, which a view from the side foreshortens.
  row.overlapPx = pair.facing.overlap;
  // Which way the pair runs in the image, 0 to 180 degrees: what tells one
  // pair of a fixture from another when a shot has lost one of them.
  {
    const l = line(pair.b);
    const deg = (Math.atan2(l.u[1], l.u[0]) * 180) / Math.PI;
    row.pairAngle = ((deg % 180) + 180) % 180;
  }
  row.truthPair = [pair.a.id, pair.b.id];
  row.causes = causesInGap(explained, pair, opts);
  const ends = endPoints(pair.facing);
  row.endsTruePx = ends.map((p) => crossing(line(pair.a), p, pair.facing.normal));

  const da = detectionAt(pair.a.id, pair.facing.at, matches, segments);
  const db = detectionAt(pair.b.id, pair.facing.at, matches, segments);
  // Before the detections' own reading and whatever stops it: a refit can
  // exist where that reading does not, which is the case findPairs is for.
  row.refit = refitReading(pairs ?? [], pair, da, db, opts);
  // And a reading carried from an earlier frame, which needs no detection.
  row.tracked = trackedReading(tracks ?? [], pair, opts);
  // And the ledge a free fit placed in this frame, where one was asked for
  // (gap-sweep --ledge-fit): what scripts/ledge.js measures a scene's from.
  if (ledgeFits) row.ledgeFit = ledgeFitReading(ledgeFits, pair, opts);

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
  row.endsDetectedPx = readAtPoints(da.line, db.line, pair.facing, ends, opts.reach);
  row.measuredGapPx = read.gap;
  row.errorPx = read.gap - row.trueGapPx;
  row.movingOffsetPx = read.movingOffset;
  row.targetOffsetPx = read.targetOffset;
  return row;
}

/**
 * The gap as an `edge-pair` record has it, read exactly as the detections
 * are: at the same point, split by edge the same way. Beside the detections'
 * reading rather than instead of it -- where both exist, the difference
 * between them is the blur's displacement, which is the thing being measured.
 *
 * Two kinds of record can speak for a truth pair:
 *
 *   - `fitPairs` placed the two detected segments again. Joined by their ids,
 *     which also says which edge is the moving part's. `from: 'pair'`.
 *   - `findPairs` found both edges inside ONE detected segment -- the only
 *     detection there is of either truth edge, or one that matched both. The
 *     record's two edges name that segment, so ids cannot say which is which;
 *     position does. The one further toward the moving part is the moving
 *     part's. `from: 'segment'`.
 *
 * Neither is extrapolated: a record whose stretch stops more than `reach`
 * short of the measuring point is not a reading of the gap there.
 */
function refitReading(pairs, pair, da, db, opts) {
  const T = pair.facing;
  const records = pairs.filter((p) => p.type === 'edge-pair');
  const reaches = (l) => {
    const along = dot(sub(T.at, l.p0), l.u);
    return Math.max(0, -along, along - l.len) <= opts.reach;
  };
  const reading = (record, movingEdge, targetEdge, from) => {
    const la = line(movingEdge), lb = line(targetEdge);
    if (!la || !lb || !reaches(la) || !reaches(lb)) return null;
    const r = measureAt(la, lb, T);
    if (!r) return null;
    return {
      pair: record.id,
      from,
      gapPx: r.gap,
      endsPx: readAtPoints(la, lb, T, endPoints(T), opts.reach),
      errorPx: r.gap - T.gap,
      movingOffsetPx: r.movingOffset,
      targetOffsetPx: r.targetOffset,
      gapSigma: record.gapSigma,
      strip: record.strip,
      stripLevel: record.levels[1],
      // Whether a shadow ramp lies inside the strip (fitPairs's `ledge`):
      // the edge it starts at is the one this reading cannot be trusted on.
      ledge: record.ledge ?? null,
    };
  };

  if (da && db && da.seg.id !== db.seg.id) {
    const record = records.find((p) => (p.a.segment === da.seg.id && p.b.segment === db.seg.id)
      || (p.a.segment === db.seg.id && p.b.segment === da.seg.id));
    if (record) {
      const [ea, eb] = record.a.segment === da.seg.id ? [record.a, record.b] : [record.b, record.a];
      const r = reading(record, ea, eb, 'pair');
      if (r) return r;
    }
    /*
     * No pair of the two. If both detections reach the measuring point, that
     * is the end of it: they ARE the two edges, fitPairs declined them (too
     * far apart, usually), and a strip found inside one of them is some other
     * strip. A sideways sweep found this at its widest step: 6.5 px apart,
     * over maxGap, and the reading taken was a 2 px shadow strip inside the
     * lower edge's segment, 4 px wrong.
     *
     * If one of them stops short, fall through. A 7 px fragment matched to one
     * truth edge does not stop the other detection from holding both.
     */
    if (da.outside <= opts.reach && db.outside <= opts.reach) return null;
  }

  const holders = new Set([da, db].filter(Boolean).map((d) => d.seg.id));
  for (const record of records) {
    if (record.a.segment !== record.b.segment || !holders.has(record.a.segment)) continue;
    const la = line(record.a), lb = line(record.b);
    if (!la || !lb) continue;
    const ha = crossing(la, T.at, T.normal), hb = crossing(lb, T.at, T.normal);
    if (ha === null || hb === null) continue;
    const r = ha >= hb
      ? reading(record, record.a, record.b, 'segment')
      : reading(record, record.b, record.a, 'segment');
    if (r) return r;
  }
  return null;
}

/**
 * The gap as an `edge-track` record has it -- trackPair's, from a line carried
 * in from an earlier frame -- read exactly as the refit is: at the truth
 * pair's measuring point, along the still line's normal, and a sixth in from
 * each end.
 *
 * Which record speaks for which truth pair is decided by where its still line
 * lies, not by its slot's name: the one within TRACK_MATCH px of the target's
 * truth edge at the measuring point, parallel to it within maxAngle, nearest
 * first. The driver numbers its slots by the pair numbers of ITS analysis,
 * and nothing here should have to agree with that.
 */
const TRACK_MATCH = 3;
function trackedReading(tracks, pair, opts) {
  const best = trackFor(tracks, pair, opts);
  if (!best) return null;
  const T = pair.facing;
  if (best.record.model === 'ambiguous') {
    /*
     * No gap: a strip and one edge fit about as well. Both are read as a gap
     * would be, and kept apart; whatever reads gapPx sees no reading.
     */
    const hypotheses = best.record.hypotheses.map((h) => {
      const m = line(h.moving);
      const r = m && measureAt(m, best.still, T);
      return r ? { model: h.model, gapPx: r.gap, endsPx: readAtPoints(m, best.still, T, endPoints(T), opts.reach),
        errorPx: r.gap - T.gap, gapSigma: h.gapSigma } : null;
    }).filter(Boolean);
    return { gapPx: null, endsPx: null, errorPx: null, movingOffsetPx: null, targetOffsetPx: null, gapSigma: null,
      rms: null, strip: null, stripLevel: best.record.stripLevel, ambiguous: true, hypotheses };
  }
  const r = measureAt(best.moving, best.still, T);
  if (!r) return null;
  return {
    gapPx: r.gap,
    endsPx: readAtPoints(best.moving, best.still, T, endPoints(T), opts.reach),
    errorPx: r.gap - T.gap,
    movingOffsetPx: r.movingOffset,
    targetOffsetPx: r.targetOffset,
    gapSigma: best.record.gapSigma,
    rms: best.record.rms,
    strip: best.record.strip,
    stripLevel: best.record.stripLevel,
    ...(best.record.ledge ? { ledge: best.record.ledge } : {}),
  };
}

/** The track record speaking for a truth pair: see trackedReading. */
function trackFor(tracks, pair, opts) {
  const T = pair.facing;
  const tb = line(pair.b);
  let best = null;
  for (const record of tracks) {
    if (record.type !== 'edge-track') continue;
    const still = line(record.still);
    // An ambiguous record has no moving line of its own, only its hypotheses'.
    const moving = line(record.moving ?? record.hypotheses?.[0]?.moving);
    if (!still || !moving || angleBetween(still, tb) > opts.maxAngle) continue;
    const off = Math.abs(dot(sub(T.at, still.p0), still.n));
    const along = dot(sub(T.at, still.p0), still.u);
    if (off > TRACK_MATCH || Math.max(0, -along, along - still.len) > opts.reach) continue;
    if (!best || off < best.off) best = { off, record, still, moving };
  }
  return best;
}

/**
 * A free ledge fit's record for a truth pair (trackPair with ledge=fit): the
 * shadow it placed, px from the moving edge, its width, how much better it
 * fitted than the strip alone, and whether it was in sight at all. Null
 * where the fit read no strip.
 */
function ledgeFitReading(fits, pair, opts) {
  const best = trackFor(fits, pair, opts);
  return best?.record.ledge ? { ...best.record.ledge } : null;
}

/**
 * Where the gap is also read, besides the middle: a sixth of the shared
 * stretch in from each end. One number per pair says how far apart two edges
 * are; two say whether they are parallel. A part turned about the vertical
 * opens a pair's gap at one end and closes it at the other, and a reading at
 * the middle alone cannot see that.
 */
function endPoints(T) {
  const along = [-T.normal[1], T.normal[0]];
  const half = (T.hi - T.lo) / 2, inset = (T.hi - T.lo) / 6;
  return [-(half - inset), half - inset].map((s) => add(T.at, along, s));
}

/**
 * The gap between two lines at each of `points` on the target's, along T's
 * normal, as `measureAt` reads it at the middle. Null at a point the lines
 * stop more than `reach` short of.
 */
function readAtPoints(movingLine, targetLine, T, points, reach) {
  const reaches = (l, p) => {
    const along = dot(sub(p, l.p0), l.u);
    return Math.max(0, -along, along - l.len) <= reach;
  };
  return points.map((p) => {
    if (!reaches(movingLine, p) || !reaches(targetLine, p)) return null;
    const at = onLine(targetLine, p);
    const normal = dot(targetLine.n, T.normal) >= 0 ? targetLine.n : [-targetLine.n[0], -targetLine.n[1]];
    return crossing(movingLine, at, normal);
  });
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
 * Number a sweep's pairs so that pair k is the same pair in every shot.
 *
 * `gapRows` numbers the pairs of ONE shot, left to right. That is the same
 * numbering in every shot only while every shot has every pair, and they do
 * not: at 50 mm the stack's side pair is not parallel enough to be a pair, and
 * what is left is called 1 whichever it is. What does not change along a
 * sweep is the direction a pair runs in the image, so the rows of one view
 * are grouped by that -- within `tolerance` degrees, round the 0/180 join --
 * and the groups are numbered in order of angle.
 *
 * Rows of one view only: from another view the same pair runs another way.
 */
function numberPairs(rows, tolerance = 10) {
  const angles = [...new Set(rows.filter((r) => r.pairAngle !== null && r.pairAngle !== undefined)
    .map((r) => r.pairAngle))].sort((a, b) => a - b);
  const groups = [];
  for (const a of angles) {
    const last = groups[groups.length - 1];
    if (last && a - last[last.length - 1] <= tolerance) last.push(a);
    else groups.push([a]);
  }
  // 179 degrees and 1 degree are two degrees apart.
  if (groups.length > 1) {
    const first = groups[0], last = groups[groups.length - 1];
    if (first[0] + 180 - last[last.length - 1] <= tolerance) { first.unshift(...last); groups.pop(); }
  }
  const numberOf = new Map();
  groups.forEach((group, k) => group.forEach((a) => numberOf.set(a, k + 1)));
  return rows.map((r) => ({ ...r, pair: numberOf.get(r.pairAngle) ?? null }));
}

/**
 * Pixels per millimetre along a sweep that does not start at contact: the
 * least-squares slope of the true image gap against the step. Signed -- a
 * part slid one way closes the gap a pair sees and slid the other opens it --
 * and near zero for a pair whose edges run along the swept direction, which
 * that pair cannot see. Null with fewer than two steps that have a truth pair.
 */
function pxPerMmSlope(rows) {
  const pts = rows.filter((r) => Number.isFinite(r.trueGapPx) && Number.isFinite(r.gapMm));
  if (pts.length < 2) return null;
  const mx = pts.reduce((a, r) => a + r.gapMm, 0) / pts.length;
  const my = pts.reduce((a, r) => a + r.trueGapPx, 0) / pts.length;
  let sxx = 0, sxy = 0;
  for (const r of pts) { sxx += (r.gapMm - mx) ** 2; sxy += (r.gapMm - mx) * (r.trueGapPx - my); }
  return sxx > 0 ? sxy / sxx : null;
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

/**
 * The views of a grid: a camera orbited about its own target, at its own
 * distance. Yaw and elevation are the generator's (src/generate/driver.js):
 * the camera sits at target + r * (sin yaw cos el, sin el, cos yaw cos el),
 * so yaw 0 looks along -z and elevation is above the horizontal. Degrees.
 *
 * Every yaw is taken with every elevation, elevation outermost. A list left
 * out is the camera's own angle, so one list alone sweeps one axis through
 * the saved view.
 *
 * Null when neither is given: there is one view, the saved camera to the
 * bit, and it is the caller's to use as it stands rather than a reconstruction
 * of it through two arctangents.
 *
 * @param {{position: number[], target: number[]}} camera
 * @param {{yaw?: number[]|null, elevation?: number[]|null}} angles
 * @returns {{yaw: number, elevation: number, camera: number[]}[]|null}
 */
function orbitViews(camera, { yaw, elevation }) {
  if (!yaw && !elevation) return null;
  const d = camera.position.map((c, k) => c - camera.target[k]);
  const flat = Math.hypot(d[0], d[2]);
  const radius = Math.hypot(flat, d[1]);
  // To a thousandth of a degree: these become file names and table cells.
  const deg = (r) => Math.round(((r * 180) / Math.PI) * 1000) / 1000;
  const yaws = yaw ?? [deg(Math.atan2(d[0], d[2]))];
  const elevations = elevation ?? [deg(Math.atan2(d[1], flat))];
  const views = [];
  for (const el of elevations) {
    for (const yw of yaws) {
      const y = (yw * Math.PI) / 180, e = (el * Math.PI) / 180;
      views.push({
        yaw: yw,
        elevation: el,
        camera: [
          camera.target[0] + radius * Math.sin(y) * Math.cos(e),
          camera.target[1] + radius * Math.sin(e),
          camera.target[2] + radius * Math.cos(y) * Math.cos(e),
        ],
      });
    }
  }
  return views;
}

module.exports = { gapRow, gapRows, numberPairs, pxPerMm, pxPerMmSlope, truthPair, truthPairs, facing, line, changedInputs, orbitViews, DEFAULTS };
