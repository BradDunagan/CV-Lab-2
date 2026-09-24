'use strict';

/**
 * Scoring what the pipeline found against what is really there.
 *
 * Pure JavaScript for the same reason `corners.js` is: this is arithmetic over
 * a few hundred records with no pixels involved, so putting it in C would buy
 * nothing and cost the ability to read it.
 *
 * WHAT THIS CAN AND CANNOT SETTLE
 *
 * The ground truth is the scene's GEOMETRY. Three consequences, and every
 * number out of here has to be read with them in mind:
 *
 *   - **A geometric edge need not be a visible one.** Two faces meeting under
 *     flat lighting produce no gradient at all, and a corner formed by two
 *     such faces is invisible in the picture. A miss is not automatically a
 *     failure of the detector.
 *   - **A visible edge need not be geometric.** Texture, shadow boundaries and
 *     specular terminators are real image edges and none of them are in the
 *     ground truth. A false positive here may be a perfectly good detection of
 *     something that is not geometry — which is exactly what the albedo and
 *     normal passes are for.
 *   - **Visibility is rasterised**, so the ground truth itself is right to
 *     about a pixel and no better.
 *
 * So the honest reading of a match rate is "how much of what the pipeline
 * found is explained by geometry", not "how often the pipeline is right".
 */

/** Angle between two lines, in [0, 90]. Both inputs are in [0, 180). */
function lineAngleDifference(a, b) {
  const d = Math.abs(a - b) % 180;
  return d > 90 ? 180 - d : d;
}

/** Distance from a point to a SEGMENT — not to its infinite line. */
function pointToSegment(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(px - x0, py - y0);
  // Clamped, so a segment does not attract points beyond its own ends. An
  // unclamped (infinite-line) distance would match a detected segment to a
  // ground-truth edge on the far side of the image that happens to be
  // collinear with it.
  let t = ((px - x0) * dx + (py - y0) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

function median(values) {
  if (values.length === 0) return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Median distance from one polyline to the NEAREST of a set of others, and
 * which of them was nearest most often.
 *
 * Nearest per SAMPLE, not per candidate, and that is the whole point. A
 * detected segment routinely lies along several ground-truth edges at once — a
 * smooth object's silhouette arrives as a polyline of three-pixel facets, and
 * one fitted segment covers a dozen of them — so asking "which single edge is
 * this closest to" throws most of the answer away. Asking "how far is this
 * from the nearest geometry, at each point along it" does not.
 *
 * The MEDIAN over samples rather than the mean or the maximum. A detected
 * segment routinely overshoots at one end — `fit` projects its endpoints onto
 * the fitted line, and the line is an average over pixels that may run a
 * little past the geometry — and a maximum would throw away an otherwise
 * perfect match on account of the last two pixels. A mean would let a line
 * that coincides for half its length and then leaves score respectably, which
 * is worse.
 */
function nearestAlong(from, others, samples) {
  const dx = from.x1 - from.x0;
  const dy = from.y1 - from.y0;
  const distances = [];
  const votes = new Map();
  for (let s = 0; s < samples; s++) {
    const u = samples === 1 ? 0.5 : s / (samples - 1);
    const px = from.x0 + dx * u;
    const py = from.y0 + dy * u;
    let best = Infinity;
    let bestOther = null;
    for (const other of others) {
      const d = pointToSegment(px, py, other.x0, other.y0, other.x1, other.y1);
      // Ties broken by id, for the same reason the modal vote below is: a
      // sample at the junction of two truth chords is exactly equidistant
      // from both, and keeping the first-seen would make the answer depend on
      // the order the list arrived in.
      if (d < best || (d === best && bestOther !== null && other.id < bestOther.id)) {
        best = d;
        bestOther = other;
      }
    }
    if (bestOther === null) continue;
    distances.push(best);
    votes.set(bestOther, (votes.get(bestOther) ?? 0) + 1);
  }
  let modal = null;
  let mostVotes = 0;
  for (const [other, count] of votes) {
    // Ties broken by id, so the record does not depend on iteration order.
    if (count > mostVotes || (count === mostVotes && modal !== null && other.id < modal.id)) {
      modal = other;
      mostVotes = count;
    }
  }
  return { distance: median(distances), modal };
}

/** One sample per pixel, so a long line is not judged on as few points as a short one. */
function sampleCount(length) {
  return Math.min(256, Math.max(4, Math.ceil(length) + 1));
}

/* ------------------------------------------------------------------ */
/* arcs, as geometry                                                   */
/*                                                                     */
/* Everything below treats an arc as a CURVE and never as its chord. An */
/* edge-arc carries x0,y0,x1,y1 like a segment does and means its two   */
/* ENDS by them, so reusing the segment helpers would silently measure  */
/* the straight line between a curve's ends -- the same failure         */
/* overlay-features.mjs and corners.js are each guarded against.        */
/* ------------------------------------------------------------------ */

/** The point a fraction `u` along an arc's own sweep. */
function arcPoint(a, u) {
  const t = ((a.angle0 + a.sweep * u) * Math.PI) / 180;
  return { x: a.cx + a.r * Math.cos(t), y: a.cy + a.r * Math.sin(t) };
}

/**
 * The arc's direction there, folded onto [0, 180) so it compares with a
 * truth edge's `angle` on the same terms — a tangent is a line and a line has
 * no direction, which is the fold `fit` applies too.
 */
function arcTangent(a, u) {
  const t = a.angle0 + a.sweep * u + 90;
  return ((t % 180) + 180) % 180;
}

/**
 * Distance from a point to an arc, clamped to the arc's own extent.
 *
 * The analogue of pointToSegment, and clamped for the same reason: an arc is
 * a piece of a circle, not the whole one, and a detection on the far side of
 * that circle is not near this arc. Beside the arc the answer is the radial
 * distance; past either end it is the distance to that end.
 */
function pointToArc(px, py, a) {
  if (!(a.r > 0) || !(a.sweep > 0)) return Math.hypot(px - a.cx, py - a.cy);
  const dx = px - a.cx, dy = py - a.cy;
  const radial = Math.abs(Math.hypot(dx, dy) - a.r);
  let u = (Math.atan2(dy, dx) * 180) / Math.PI - a.angle0;
  u = ((u % 360) + 360) % 360;
  if (u <= a.sweep) return radial;
  // Past an end. Which one is nearer round the circle decides which end.
  const end = (u - a.sweep) <= (360 - u) ? arcPoint(a, 1) : arcPoint(a, 0);
  return Math.hypot(px - end.x, py - end.y);
}

/** Where a point sits along an arc, as a fraction of its sweep, clamped. */
function arcFraction(a, px, py) {
  if (!(a.sweep > 0)) return 0;
  let u = (Math.atan2(py - a.cy, px - a.cx) * 180) / Math.PI - a.angle0;
  u = ((u % 360) + 360) % 360;
  return Math.min(1, Math.max(0, u / a.sweep));
}

/**
 * The generic version of `nearestAlong`: walk one feature, and at each step
 * find the nearest of the others.
 *
 * Takes the three things that differ between a line and a curve -- how to walk
 * it, how far a point is from a candidate, and which way that candidate runs
 * where the point is -- so the two passes below read the same for both.
 *
 * Reports the MEDIAN distance and angle difference rather than the mean, for
 * the reason `nearestAlong` already gives: a fitted feature routinely
 * overshoots its real extent, and a few samples landing past the end of
 * whatever caused it should not decide the answer.
 */
function nearestAlongCurve(walk, others, samples, distanceTo, angleAt, ownAngle) {
  const distances = [], angles = [];
  const votes = new Map();
  for (let s = 0; s < samples; s++) {
    const u = samples === 1 ? 0.5 : s / (samples - 1);
    const { x, y } = walk(u);
    let best = Infinity, bestOther = null;
    for (const other of others) {
      const d = distanceTo(other, x, y);
      // Ties broken by id. A sample landing exactly where two truth chords
      // meet is equidistant from both, and `d < best` alone would keep
      // whichever arrived first -- which is the input's order, not the
      // image's. On a tessellated curve that happens at every junction.
      if (d < best || (d === best && bestOther !== null && other.id < bestOther.id)) {
        best = d;
        bestOther = other;
      }
    }
    if (bestOther === null) continue;
    distances.push(best);
    angles.push(lineAngleDifference(ownAngle(u), angleAt(bestOther, x, y)));
    votes.set(bestOther, (votes.get(bestOther) ?? 0) + 1);
  }
  let modal = null, mostVotes = 0;
  for (const [other, count] of votes) {
    // Ties broken by id, as nearestAlong does, so the record does not depend
    // on iteration order.
    if (count > mostVotes || (count === mostVotes && modal !== null && other.id < modal.id)) {
      modal = other;
      mostVotes = count;
    }
  }
  return {
    distance: distances.length > 0 ? median(distances) : null,
    angleDiff: angles.length > 0 ? median(angles) : null,
    modal,
  };
}

/**
 * Match detected features against ground-truth ones.
 *
 * Dispatches on the type of the DETECTED records — `edge-segment` and
 * `edge-arc` score against `gt-edge`, `edge-corner` against `gt-vertex`. That
 * they go to different ground truth is why the feature types are namespaced
 * at all.
 *
 * @param {Array} detected  `fit` or `corners` output
 * @param {Array} truth     `groundTruth` output
 * @param {object} opts
 * @returns {Array} one `edge-match` record per detection and per missed
 *                  ground-truth feature
 */
/**
 * How much of an edge has to be showing before anything is held responsible
 * for finding it.
 *
 * Exported because it is not only the matcher's business. `visible` is a
 * FRACTION, and anything that reports how many edges are in a view is making
 * the same judgement -- so the generator's progress line and the overlay's
 * visible/hidden colouring read this rather than each choosing a number.
 * They did not agree before: the generator counted `visible > 0`, which
 * called a 1.7%-visible edge findable and reported twelve where the score
 * worked from nine.
 */
const MIN_VISIBLE = 0.5;

function matchFeatures(detected, truth, opts = {}) {
  const maxDistance = opts.maxDistance ?? 3;
  const maxAngle = opts.maxAngle ?? 20;
  const minVisible = opts.minVisible ?? MIN_VISIBLE;
  const minAngle = opts.minAngle ?? 30;

  const kinds = new Set(detected.map((f) => f.type));
  if (kinds.size > 1) {
    throw new Error(
      `match: the detected list mixes feature types (${[...kinds].sort().join(', ')}). ` +
        `Match one kind at a time.`
    );
  }
  const kind = detected.length === 0 ? null : [...kinds][0];
  const KNOWN = ['edge-segment', 'edge-arc', 'edge-corner'];
  if (kind !== null && !KNOWN.includes(kind)) {
    throw new Error(
      `match: nothing to compare a "${kind}" against. ` +
        `Expects edge-segment (from fit), edge-arc (from fitArcs) ` +
        `or edge-corner (from corners).`
    );
  }

  if (kind === 'edge-corner') return matchCorners(detected, truth, { maxDistance, minAngle });
  if (kind === 'edge-arc') {
    return matchArcs(detected, truth, { maxDistance, maxAngle, minVisible });
  }
  return matchSegments(detected, truth, { maxDistance, maxAngle, minVisible });
}

/* ------------------------------------------------------------------ */
/* segments                                                            */
/* ------------------------------------------------------------------ */

function matchSegments(detected, truth, { maxDistance, maxAngle, minVisible }) {
  /*
   * Only edges the renderer says are actually visible are candidates.
   *
   * An edge hidden behind the object it belongs to is in the ground truth
   * because it EXISTS, and holding a detector responsible for not finding it
   * would be nonsense. `minVisible` is where that line gets drawn, and it is a
   * parameter rather than a constant because a partly-occluded edge is a
   * genuine judgement call.
   */
  const candidates = truth.filter((f) => f.type === 'gt-edge' && f.visible >= minVisible);
  const records = [];

  /*
   * TWO PASSES, ASKING TWO DIFFERENT QUESTIONS.
   *
   * Precision walks the detections: is this one explained by geometry?
   * Recall walks the ground truth: was this edge found by anything?
   *
   * They are not each other's inverse, and treating them as one pass was a
   * real defect here. The first version credited, per detection, only the
   * single nearest ground-truth edge — so a fitted segment lying along twelve
   * facets of a ball's silhouette marked one found and eleven missed. Recall
   * read 40% for a pipeline that had drawn a line straight down the middle of
   * all of them.
   */
  for (const seg of detected) {
    const { distance, modal } = nearestAlong(seg, candidates, sampleCount(seg.length));
    const angleDiff = modal === null ? null : lineAngleDifference(seg.angle, modal.angle);
    const hit = modal !== null && distance <= maxDistance && angleDiff <= maxAngle;
    records.push({
      kind: 'segment',
      role: hit ? 'hit' : 'false-positive',
      detected: seg.id,
      truth: hit ? modal.id : null,
      cause: hit ? modal.cause : null,
      objects: hit ? modal.objects : [],
      // Reported even when it did not match, because "nearest geometry was 40
      // pixels away" and "nearest geometry was 3.2 pixels away but at the
      // wrong angle" are different findings and both are worth seeing.
      distance: modal === null ? null : distance,
      angleDiff,
      x: (seg.x0 + seg.x1) / 2,
      y: (seg.y0 + seg.y1) / 2,
    });
  }

  for (const edge of candidates) {
    const { distance, modal } = nearestAlong(edge, detected, sampleCount(edge.length));
    const angleDiff = modal === null ? null : lineAngleDifference(edge.angle, modal.angle);
    if (modal !== null && distance <= maxDistance && angleDiff <= maxAngle) continue;
    records.push({
      kind: 'segment',
      role: 'miss',
      detected: null,
      truth: edge.id,
      cause: edge.cause,
      objects: edge.objects,
      distance: modal === null ? null : distance,
      angleDiff,
      x: (edge.x0 + edge.x1) / 2,
      y: (edge.y0 + edge.y1) / 2,
    });
  }

  return numbered(records);
}

/* ------------------------------------------------------------------ */
/* arcs                                                                */
/* ------------------------------------------------------------------ */

/**
 * Score fitted arcs against the same `gt-edge` truth segments do.
 *
 * WHY THIS IS NOT HARDER THAN IT LOOKS. The worry written into
 * design-lab-model.md §11 was that ground truth lists straight chords off a
 * tessellated mesh, so one arc crosses a fan of them and "matches" only the
 * modal one -- reading as one hit in twelve on a perfect detection. That is a
 * real failure and `match` already does not have it: the two passes below ask
 * two different questions, and RECALL walks the truth. An arc lying along
 * twelve chords is credited with finding all twelve, because each of the
 * twelve is asked separately whether anything covers it. This is the same
 * defect, and the same fix, that the ball's silhouette forced on segments.
 *
 * What genuinely differs is only the geometry: sample along the curve, measure
 * distance to the curve, and compare a truth edge's angle against the arc's
 * TANGENT where that edge is, not against some single angle for the whole arc.
 *
 * WHAT THE NUMBERS DO AND DO NOT MEAN. Precision is honest on its own: every
 * arc is asked whether geometry explains it. Recall is only over the truth
 * this list could have found -- run `fit` and `fitArcs` on one label map and a
 * truth edge covered by a segment counts as missed here. There is no operation
 * that builds one list from both, so a combined recall cannot be computed
 * today; §11 records that.
 */
function matchArcs(detected, truth, { maxDistance, maxAngle, minVisible }) {
  const candidates = truth.filter((f) => f.type === 'gt-edge' && f.visible >= minVisible);
  const records = [];

  const edgeDistance = (e, x, y) => pointToSegment(x, y, e.x0, e.y0, e.x1, e.y1);
  const edgeAngle = (e) => e.angle;

  /* Precision: is this arc explained by geometry? */
  for (const arc of detected) {
    const { distance, angleDiff, modal } = nearestAlongCurve(
      (u) => arcPoint(arc, u),
      candidates,
      sampleCount(arc.arcLength ?? arc.length ?? 0),
      edgeDistance, edgeAngle,
      (u) => arcTangent(arc, u)
    );
    const hit = modal !== null && distance <= maxDistance && angleDiff <= maxAngle;
    const mid = arcPoint(arc, 0.5);
    records.push({
      kind: 'arc',
      role: hit ? 'hit' : 'false-positive',
      detected: arc.id,
      truth: hit ? modal.id : null,
      cause: hit ? modal.cause : null,
      objects: hit ? modal.objects : [],
      distance: modal === null ? null : distance,
      angleDiff,
      // The middle of the ARC, not of its chord: on a half circle those are
      // most of a radius apart, and this is what the overlay draws on.
      x: mid.x,
      y: mid.y,
    });
  }

  /* Recall: was this edge found by anything? */
  for (const edge of candidates) {
    const { distance, angleDiff, modal } = nearestAlongCurve(
      (u) => ({ x: edge.x0 + (edge.x1 - edge.x0) * u, y: edge.y0 + (edge.y1 - edge.y0) * u }),
      detected,
      sampleCount(edge.length),
      (a, x, y) => pointToArc(x, y, a),
      (a, x, y) => arcTangent(a, arcFraction(a, x, y)),
      () => edge.angle
    );
    if (modal !== null && distance <= maxDistance && angleDiff <= maxAngle) continue;
    records.push({
      kind: 'arc',
      role: 'miss',
      detected: null,
      truth: edge.id,
      cause: edge.cause,
      objects: edge.objects,
      distance: modal === null ? null : distance,
      angleDiff,
      x: (edge.x0 + edge.x1) / 2,
      y: (edge.y0 + edge.y1) / 2,
    });
  }

  return numbered(records);
}

/* ------------------------------------------------------------------ */
/* corners                                                             */
/* ------------------------------------------------------------------ */

function matchCorners(detected, truth, { maxDistance, minAngle }) {
  /*
   * Which ground-truth vertices count as CORNERS.
   *
   * Not all of them do, and this is the subtlety that decides whether the
   * numbers mean anything. A smooth object's silhouette arrives as a polyline,
   * so its interior points are vertices of degree 2 whose two edges run almost
   * straight through — geometrically vertices, visually not corners, and no
   * corner detector should be marked down for missing one. `angle` is the
   * widest angle between any two edges meeting there, so thresholding it is
   * exactly the distinction wanted: a cube's vertices sit at 74-87 degrees, a
   * sphere's silhouette bends by a few.
   */
  const candidates = truth.filter(
    (f) => f.type === 'gt-vertex' && f.visible && f.onFrame && f.angle >= minAngle
  );

  /*
   * One-to-one, unlike segments.
   *
   * A single vertex being claimed by three detected corners is three answers
   * to a question with one answer, and counting all three as correct would
   * report a detector that fires everywhere as highly accurate. Pairs are
   * taken shortest-first, which is the standard greedy assignment and, at
   * these distances, the optimal one often enough not to be worth solving
   * properly.
   */
  const pairs = [];
  for (const corner of detected) {
    for (const vertex of candidates) {
      const distance = Math.hypot(corner.x - vertex.x, corner.y - vertex.y);
      if (distance <= maxDistance) pairs.push({ corner, vertex, distance });
    }
  }
  pairs.sort((a, b) =>
    a.distance - b.distance || a.corner.id - b.corner.id || a.vertex.id - b.vertex.id);

  const takenCorner = new Map();
  const takenVertex = new Set();
  for (const pair of pairs) {
    if (takenCorner.has(pair.corner.id) || takenVertex.has(pair.vertex.id)) continue;
    takenCorner.set(pair.corner.id, pair);
    takenVertex.add(pair.vertex.id);
  }

  const records = [];
  for (const corner of detected) {
    const pair = takenCorner.get(corner.id);
    // Even for a false positive, how far the nearest real corner was is worth
    // reporting: 4 px is a near miss and 60 px is an invention.
    let nearest = null;
    for (const vertex of candidates) {
      const distance = Math.hypot(corner.x - vertex.x, corner.y - vertex.y);
      if (nearest === null || distance < nearest) nearest = distance;
    }
    records.push({
      kind: 'corner',
      role: pair ? 'hit' : 'false-positive',
      detected: corner.id,
      truth: pair ? pair.vertex.id : null,
      cause: null,
      objects: pair ? pair.vertex.objects : [],
      distance: pair ? pair.distance : nearest,
      angleDiff: null,
      x: corner.x,
      y: corner.y,
    });
  }
  for (const vertex of candidates) {
    if (takenVertex.has(vertex.id)) continue;
    records.push({
      kind: 'corner',
      role: 'miss',
      detected: null,
      truth: vertex.id,
      cause: null,
      objects: vertex.objects,
      distance: null,
      angleDiff: null,
      x: vertex.x,
      y: vertex.y,
    });
  }

  return numbered(records);
}

/* ------------------------------------------------------------------ */

/**
 * Give the records a stable order and identity.
 *
 * Sorted rather than left in whatever order the loops produced, so the same
 * inputs hash the same however the lists arrived — the same rule the corner
 * clustering follows.
 */
function numbered(records) {
  records.sort((a, b) =>
    a.role.localeCompare(b.role) ||
    (a.detected ?? 0) - (b.detected ?? 0) ||
    (a.truth ?? 0) - (b.truth ?? 0));
  return records.map((r, i) => ({ type: 'edge-match', id: i + 1, ...r }));
}

/** Tally a match list. Reporting only — nothing here decides anything. */
function summarise(records) {
  const hit = records.filter((r) => r.role === 'hit').length;
  const falsePositive = records.filter((r) => r.role === 'false-positive').length;
  const miss = records.filter((r) => r.role === 'miss').length;
  const detections = hit + falsePositive;
  const expected = hit + miss;
  return {
    hit,
    falsePositive,
    miss,
    detections,
    expected,
    precision: detections > 0 ? hit / detections : null,
    recall: expected > 0 ? hit / expected : null,
  };
}

module.exports = {
  matchArcs, pointToArc, arcPoint, arcTangent, arcFraction,
  matchFeatures, summarise, MIN_VISIBLE,
  lineAngleDifference, pointToSegment, nearestAlong, sampleCount, median,
};
