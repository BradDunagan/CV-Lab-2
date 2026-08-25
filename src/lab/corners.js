'use strict';

/**
 * Corner hypotheses from fitted segments.
 *
 * Pure JavaScript, deliberately: this is O(segments²) arithmetic over a few
 * dozen records with no pixels involved, so putting it in C would buy nothing
 * and cost the ability to read it.
 *
 * The design point, and it is not a detail: this does NOT decide which
 * intersections are corners. Real edges systematically stop short of the
 * corners they belong to — blur rounds the vertex, non-maximum suppression
 * deletes junction pixels, and weak ends fall below threshold. So the gap
 * between a segment's end and a true corner is the normal case, and any fixed
 * pixel threshold is wrong for half of any image.
 *
 * Instead each candidate carries how far it had to reach and what that reach
 * costs in accuracy, so a later stage can spend effort only where the geometry
 * says it might pay off.
 */

/** Line through a fitted segment, as unit normal and offset. */
function lineOf(f) {
  const dx = f.x1 - f.x0, dy = f.y1 - f.y0;
  const len = Math.hypot(dx, dy) || 1;
  const tx = dx / len, ty = dy / len;      // along the line
  const nx = -ty, ny = tx;                 // perpendicular to it
  return { nx, ny, c: -(nx * f.x0 + ny * f.y0), tx, ty, len };
}

/**
 * Angular standard error of a total-least-squares fit.
 *
 * A line fitted to n points spread over length L, whose points sit an RMS
 * distance s off it, has roughly this much slop in its direction. The √12
 * comes from the spread of a uniform distribution along the segment. This is
 * the quantity that makes extrapolation honest: a short stubby fit is allowed
 * to be much less sure of its direction than a long clean one.
 */
function angularError(f) {
  const n = Math.max(f.pixels, 2);
  const spread = Math.max(f.length, 1) / Math.sqrt(12);
  const s = Math.max(f.rms ?? f.residual ?? 0, 1e-3);
  return s / (spread * Math.sqrt(n));
}

/**
 * @param {Array} features fitted segments, as `fit` produces them
 * @param {{minAngle?:number, maxReachRatio?:number, cluster?:number}} [opts]
 * @returns {Array} corner candidates, strongest agreement first
 */
function findCorners(features, opts = {}) {
  const minAngle = opts.minAngle ?? 15;          // degrees
  const maxReachRatio = opts.maxReachRatio ?? 2; // of the segment's own length
  const clusterRadius = opts.cluster ?? 3;       // pixels

  const lines = features.map(lineOf);
  const raw = [];

  for (let i = 0; i < features.length; i++) {
    for (let j = i + 1; j < features.length; j++) {
      const A = lines[i], B = lines[j];

      // Near-parallel lines intersect somewhere far away and wrongly: the
      // position error goes as 1/sin(angle between).
      const sin = Math.abs(A.nx * B.ny - A.ny * B.nx);
      const between = Math.asin(Math.min(1, sin)) * 180 / Math.PI;
      if (between < minAngle) continue;

      const det = A.nx * B.ny - A.ny * B.nx;
      const x = (-A.c * B.ny + B.c * A.ny) / det;
      const y = (-A.nx * B.c + B.nx * A.c) / det;

      // How far past each segment's nearer end does the meeting point lie?
      // Negative means it falls inside the segment, which is the strongest
      // case of all: the two really do cross.
      const reach = (f) => {
        const d0 = Math.hypot(x - f.x0, y - f.y0);
        const d1 = Math.hypot(x - f.x1, y - f.y1);
        const nearest = Math.min(d0, d1);
        const inside = d0 + d1 <= f.length + 1e-9;
        return inside ? -nearest : nearest;
      };
      const reachA = reach(features[i]), reachB = reach(features[j]);

      if (Math.max(reachA, 0) > maxReachRatio * features[i].length) continue;
      if (Math.max(reachB, 0) > maxReachRatio * features[j].length) continue;

      // Propagated uncertainty: each line's direction is uncertain by dθ, so
      // extrapolating it a distance d smears the endpoint by d·dθ, and the
      // two smears combine and are divided by the sine of the crossing angle.
      const eA = Math.abs(reachA) * angularError(features[i]) +
                 (features[i].rms ?? 0) / Math.sqrt(Math.max(features[i].pixels, 1));
      const eB = Math.abs(reachB) * angularError(features[j]) +
                 (features[j].rms ?? 0) / Math.sqrt(Math.max(features[j].pixels, 1));
      const sigma = Math.hypot(eA, eB) / Math.max(sin, 1e-6);

      raw.push({
        x, y, a: features[i].id, b: features[j].id,
        angle: between, reachA, reachB, sigma,
      });
    }
  }

  /*
   * Cluster coincident intersections.
   *
   * Three edges meet at a cube's vertex, so three independent pairs predict
   * the same point. Agreement between them is far stronger evidence than any
   * one pair on its own, and `support` is exactly that count -- which is the
   * number worth sorting by when deciding where to spend further analysis.
   */
  const used = new Array(raw.length).fill(false);
  const corners = [];
  // Deterministic: consider candidates in a fixed order, not whatever order
  // the pair loops produced.
  const order = raw.map((_, i) => i).sort((p, q) =>
    raw[p].x - raw[q].x || raw[p].y - raw[q].y || raw[p].a - raw[q].a || raw[p].b - raw[q].b);

  for (const seed of order) {
    if (used[seed]) continue;
    const group = [raw[seed]];
    used[seed] = true;
    for (const other of order) {
      if (used[other]) continue;
      if (Math.hypot(raw[other].x - raw[seed].x, raw[other].y - raw[seed].y) <= clusterRadius) {
        used[other] = true;
        group.push(raw[other]);
      }
    }
    // Weight the position by each estimate's confidence, so a tight pair
    // dominates a loose one rather than being averaged away by it.
    let wsum = 0, wx = 0, wy = 0;
    for (const g of group) {
      const w = 1 / Math.max(g.sigma * g.sigma, 1e-6);
      wsum += w; wx += w * g.x; wy += w * g.y;
    }
    const segments = [...new Set(group.flatMap((g) => [g.a, g.b]))].sort((p, q) => p - q);
    corners.push({
      x: wx / wsum,
      y: wy / wsum,
      support: group.length,
      segments,
      sigma: Math.min(...group.map((g) => g.sigma)),
      reach: Math.max(...group.map((g) => Math.max(g.reachA, g.reachB))),
      angle: Math.max(...group.map((g) => g.angle)),
    });
  }

  // Best evidence first: most agreement, then tightest estimate.
  corners.sort((p, q) => q.support - p.support || p.sigma - q.sigma
    || p.x - q.x || p.y - q.y);
  return corners.map((c, i) => ({ id: i + 1, ...c }));
}

module.exports = { findCorners };
