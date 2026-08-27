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
      if (d < best) { best = d; bestOther = other; }
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

/**
 * Match detected features against ground-truth ones.
 *
 * Dispatches on the type of the DETECTED records — `edge-segment` scores
 * against `gt-edge`, `edge-corner` against `gt-vertex`. That the two go to
 * different ground truth is why the feature types are namespaced at all.
 *
 * @param {Array} detected  `fit` or `corners` output
 * @param {Array} truth     `groundTruth` output
 * @param {object} opts
 * @returns {Array} one `edge-match` record per detection and per missed
 *                  ground-truth feature
 */
function matchFeatures(detected, truth, opts = {}) {
  const maxDistance = opts.maxDistance ?? 3;
  const maxAngle = opts.maxAngle ?? 20;
  const minVisible = opts.minVisible ?? 0.5;
  const minAngle = opts.minAngle ?? 30;

  const kinds = new Set(detected.map((f) => f.type));
  if (kinds.size > 1) {
    throw new Error(
      `match: the detected list mixes feature types (${[...kinds].sort().join(', ')}). ` +
        `Match one kind at a time.`
    );
  }
  const kind = detected.length === 0 ? null : [...kinds][0];
  if (kind !== null && kind !== 'edge-segment' && kind !== 'edge-corner') {
    throw new Error(
      `match: nothing to compare a "${kind}" against. ` +
        `Expects edge-segment (from fit) or edge-corner (from corners).`
    );
  }

  return kind === 'edge-corner'
    ? matchCorners(detected, truth, { maxDistance, minAngle })
    : matchSegments(detected, truth, { maxDistance, maxAngle, minVisible });
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
  matchFeatures, summarise,
  lineAngleDifference, pointToSegment, nearestAlong, sampleCount, median,
};
