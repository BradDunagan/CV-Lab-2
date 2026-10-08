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
export function matchArcs(detected: any, truth: any, { maxDistance, maxAngle, minVisible }: {
    maxDistance: any;
    maxAngle: any;
    minVisible: any;
}): any;
/**
 * Distance from a point to an arc, clamped to the arc's own extent.
 *
 * The analogue of pointToSegment, and clamped for the same reason: an arc is
 * a piece of a circle, not the whole one, and a detection on the far side of
 * that circle is not near this arc. Beside the arc the answer is the radial
 * distance; past either end it is the distance to that end.
 */
export function pointToArc(px: any, py: any, a: any): number;
/** The point a fraction `u` along an arc's own sweep. */
export function arcPoint(a: any, u: any): {
    x: any;
    y: any;
};
/**
 * The arc's direction there, folded onto [0, 180) so it compares with a
 * truth edge's `angle` on the same terms — a tangent is a line and a line has
 * no direction, which is the fold `fit` applies too.
 */
export function arcTangent(a: any, u: any): number;
/** Where a point sits along an arc, as a fraction of its sweep, clamped. */
export function arcFraction(a: any, px: any, py: any): number;
export function matchFeatures(detected: any, truth: any, opts?: {}): any;
/** Tally a match list. Reporting only — nothing here decides anything. */
export function summarise(records: any): {
    hit: any;
    falsePositive: any;
    miss: any;
    detections: any;
    expected: any;
    precision: number | null;
    recall: number | null;
};
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
export const MIN_VISIBLE: 0.5;
/** Angle between two lines, in [0, 90]. Both inputs are in [0, 180). */
export function lineAngleDifference(a: any, b: any): number;
/** Distance from a point to a SEGMENT — not to its infinite line. */
export function pointToSegment(px: any, py: any, x0: any, y0: any, x1: any, y1: any): number;
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
export function nearestAlong(from: any, others: any, samples: any): {
    distance: any;
    modal: any;
};
/** One sample per pixel, so a long line is not judged on as few points as a short one. */
export function sampleCount(length: any): number;
export function median(values: any): any;
