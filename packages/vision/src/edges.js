/**
 * Single-edge readings: where the moving part's own edges are, for where no
 * gap to the still part can be seen.
 *
 * A gap is read between two parts' facing edges. Down inside a pocket the
 * walls hide every such pair -- seated, not one view of 42 sees one
 * (design-lab-model.md §5, "A part inside a pocket") -- and what is left in
 * sight is the part's own outline above the walls. A lone edge placed as one
 * step (`fitEdges`) is as steady as a gap: every edge of the stack's top cube
 * with nothing near it stayed within 0.06 px of its geometry over poses 1 mm
 * apart, the spread 0.010 to 0.035 px.
 *
 * A gap means something in one frame; one edge's place means something only
 * against a reference that does not move. Each edge has an ANCHOR: a point
 * and a direction in the image, fixed the first time the edge is seen in a
 * view and kept for every frame after -- the cell's sweeps and its test poses
 * alike. A reading is the signed distance, across the anchor, from the anchor
 * to the fitted edge, at the anchor's middle and a sixth in from either end,
 * as a gap is read along a pair. The calibration fits a reference value and a
 * slope per reading, so where the anchor is does not matter, only that it
 * stays.
 *
 * The rows have gapRows' fields -- `pair`, `pairAngle`, `refit` with `gapPx`,
 * `endsPx` and `gapSigma`, the truth's beside them -- so calibrateCell and
 * solveCell take them beside gaps, unchanged. `pair` is EDGE_BASE plus the
 * anchor's number, and `edge: true` says the row is an edge's: its identity
 * is its anchor, not the angle a pair runs at (calibrate.js frameReadings).
 *
 * Only an edge with nothing beside it: an edge with another within `clear`
 * px is one of a pair, and a lone step fitted across two edges is pulled
 * between them (+0.34 and -0.63 px at the stack's gap). Beside it in the
 * truth, or among the detections: a truth predicted for the measured parts
 * alone (predictEdges `only`) has no robot finger in it, and the detector
 * sees one. Pure JavaScript, no pixels.
 */

import { len2, atan2, PI } from './math.js';

/** Edge rows' numbers start here, clear of any gap pair's. */
export const EDGE_BASE = 100;

const DEFAULTS = {
  minLength: 30,   // px of visible truth edge, at least
  minVisible: 0.9, // of it seen
  clear: 4,        // px from any other parallel edge, at least
  maxAngle: 5,     // degrees: parallel, and an anchor's own edge
  maxShift: 20,    // px an edge may have moved from its anchor and still be its
};

/** Two angles in [0, 180), how far apart as lines. */
const apart = (a, b) => { const d = Math.abs(a - b) % 180; return d > 90 ? 180 - d : d; };

/** A segment as a point, a unit direction, its normal and half its length; null if it has none. */
function lineOf(e) {
  const dx = e.x1 - e.x0, dy = e.y1 - e.y0, len = len2(dx, dy);
  if (!(len > 0)) return null;
  const ux = dx / len, uy = dy / len;
  return { x: (e.x0 + e.x1) / 2, y: (e.y0 + e.y1) / 2, ux, uy, nx: -uy, ny: ux, half: len / 2 };
}

/**
 * Where line `l` crosses the anchor's normal at `s` px along it: the signed
 * distance along the normal. Null where `l` runs along that normal.
 */
function crossing(anchor, l, s) {
  const px = anchor.x + anchor.ux * s, py = anchor.y + anchor.uy * s;
  const den = anchor.nx * l.uy - anchor.ny * l.ux;
  if (Math.abs(den) < 1e-9) return null;
  return ((l.x - px) * l.uy - (l.y - py) * l.ux) / den;
}

/** The angle of a segment as a line, in [0, 180). */
const angleOf = (e) => { const a = (atan2(e.y1 - e.y0, e.x1 - e.x0) * 180) / PI; return ((a % 180) + 180) % 180; };

/** Whether another edge -- a visible truth edge, or a detection not of `t` -- runs beside `t`, parallel, within `clear` px, along its length. */
function crowded(t, line, others, opts) {
  for (const u of others) {
    if (u === t || !(u.visible >= 0.5) || apart(u.angle, t.angle) > opts.maxAngle) continue;
    const a = (u.x0 - line.x) * line.ux + (u.y0 - line.y) * line.uy;
    const b = (u.x1 - line.x) * line.ux + (u.y1 - line.y) * line.uy;
    if (Math.min(a, b) > line.half || Math.max(a, b) < -line.half) continue;
    const da = (u.x0 - line.x) * line.nx + (u.y0 - line.y) * line.ny;
    const db = (u.x1 - line.x) * line.nx + (u.y1 - line.y) * line.ny;
    if (Math.min(Math.abs(da), Math.abs(db)) <= opts.clear || da * db < 0) return true;
  }
  return false;
}

/**
 * One frame's single-edge rows for the moving part, against a view's anchors.
 *
 * @param {object} input the frame's slots
 * @param {object[]} input.truth `groundTruth` records (gt-edge)
 * @param {object[]} input.matches `match` records of the frame's segments against that truth
 * @param {object[]} input.edges `fitEdges` records
 * @param {object[]} [input.segments] the frame's detected segments (`fit`): one
 *   beside an edge, not matched to it, makes it crowded as a truth edge does
 * @param {string | string[]} moving the moving part's name in the truth
 * @param {{x: number, y: number, ux: number, uy: number, nx: number, ny: number, half: number, angle: number}[]} anchors
 *   this view's anchors so far, in the order they were made; not changed
 * @param {object} [options] minLength, minVisible, clear, maxAngle, maxShift
 * @returns {{rows: object[], anchors: object[]}} the rows, and the anchors with any new edge's added
 */
export function edgeRows(input, moving, anchors = [], options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const names = Array.isArray(moving) ? moving : [moving];
  const truth = input.truth.filter((t) => t.type === 'gt-edge');
  const out = { rows: [], anchors: [...anchors] };
  const edgeOf = new Map(input.edges.filter((e) => e.type === 'edge-line').map((e) => [e.segment, e]));
  const used = new Set();
  const ours = truth
    .filter((t) => t.objects.length === 1 && names.includes(t.objects[0]) && t.visible >= opts.minVisible && t.length >= opts.minLength)
    .sort((a, b) => a.id - b.id);
  for (const t of ours) {
    const tl = lineOf(t);
    if (!tl || crowded(t, tl, truth, opts)) continue;
    // The detections matched to t are its own; any other beside it crowds it.
    const own = new Set(input.matches.filter((m) => m.role === 'hit' && m.truth === t.id).map((m) => m.detected));
    const detections = (input.segments ?? []).filter((d) => d.type === 'edge-segment' && !own.has(d.id))
      .map((d) => ({ ...d, visible: 1, angle: angleOf(d) }));
    if (crowded(t, tl, detections, opts)) continue;
    // The longest fitted edge among the segments matched to it.
    let fitted = null;
    for (const m of input.matches) {
      if (m.role !== 'hit' || m.truth !== t.id) continue;
      const e = edgeOf.get(m.detected);
      const l = e && lineOf(e);
      if (l && (!fitted || l.half > fitted.line.half)) fitted = { record: e, line: l };
    }
    if (!fitted) continue;
    // Its anchor: the nearest of this view's, by where the fitted edge passes it; else a new one, from the truth.
    let anchor = null, best = Infinity;
    out.anchors.forEach((a, k) => {
      if (used.has(k) || apart(a.angle, t.angle) > opts.maxAngle) return;
      const d = crossing(a, fitted.line, 0);
      if (d !== null && Math.abs(d) <= opts.maxShift && Math.abs(d) < best) { best = Math.abs(d); anchor = k; }
    });
    if (anchor === null) {
      anchor = out.anchors.length;
      out.anchors.push({ ...tl, angle: t.angle });
    }
    used.add(anchor);
    const a = out.anchors[anchor];
    const at = (l) => [0, -(2 / 3) * a.half, (2 / 3) * a.half].map((s) => crossing(a, l, s));
    const [mid, end1, end2] = at(fitted.line);
    const [tMid, tEnd1, tEnd2] = at(tl);
    if (mid === null) continue;
    out.rows.push({
      pair: EDGE_BASE + anchor + 1,
      edge: true,
      pairAngle: a.angle,
      moving: names.length === 1 ? names[0] : names,
      truthEdge: t.id,
      trueGapPx: tMid,
      endsTruePx: [tEnd1, tEnd2],
      pairFound: true,
      detectedPair: [fitted.record.segment, null],
      measuredGapPx: mid,
      endsDetectedPx: [end1, end2],
      errorPx: tMid === null ? null : mid - tMid,
      refit: { from: 'edge', gapPx: mid, endsPx: [end1, end2], gapSigma: fitted.record.sigma, errorPx: tMid === null ? null : mid - tMid },
      reason: null,
    });
  }
  return out;
}
