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
export function gapRow(input: {
    truth: object[];
    segments: object[];
    explained: object[];
    matches: object[];
    pairs?: object[] | undefined;
}, shot: object, parts: object, options?: {}): any;
/**
 * One row per facing truth pair in the image -- `truthPairs` -- each numbered
 * in `pair`, from 1. A shot with no facing pair still gets its one row, saying
 * so, with `pair` null. What is counted over the whole image (segments
 * spanning both parts, edges found) is the same in each of a shot's rows.
 */
export function gapRows(input: any, shot: any, parts: any, options?: {}): any;
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
export function numberPairs(rows: any, tolerance?: number): any;
/**
 * Pixels per millimetre of gap, from the truth alone: the median of
 * trueGapPx / gapMm over the steps with a gap. The image scale near the
 * contact, so an error in pixels can be read in millimetres.
 */
export function pxPerMm(rows: any): any;
/**
 * Pixels per millimetre along a sweep that does not start at contact: the
 * least-squares slope of the true image gap against the step. Signed -- a
 * part slid one way closes the gap a pair sees and slid the other opens it --
 * and near zero for a pair whose edges run along the swept direction, which
 * that pair cannot see. Null with fewer than two steps that have a truth pair.
 */
export function pxPerMmSlope(rows: any): number | null;
export function truthPair(truth: any, moving: any, target: any, gapM: any, opts: any): {
    a: object;
    b: object;
    facing: {
        at: any[];
        normal: any;
        gap: number;
        lo: number;
        hi: number;
        overlap: number;
    };
} | null;
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
export function truthPairs(truth: any, moving: any, target: any, gapM: any, opts: any): {
    a: object;
    b: object;
    facing: {
        at: any[];
        normal: any;
        gap: number;
        lo: number;
        hi: number;
        overlap: number;
    };
}[];
/**
 * The overlap of two near-parallel segments along b's direction, and the
 * signed gap at its middle. Null if they are not parallel or do not overlap.
 */
export function facing(a: any, b: any, { maxAngle, minOverlap }: {
    maxAngle: any;
    minOverlap: any;
}, toward?: null, away?: null): {
    at: any[];
    normal: any;
    gap: number;
    lo: number;
    hi: number;
    overlap: number;
} | null;
export function line(seg: any): {
    p0: any[];
    p1: any[];
    u: number[];
    n: number[];
    len: number;
} | null;
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
export function changedInputs(previous: any, now: any): {
    shot: string;
    files: string[];
}[];
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
export function orbitViews(camera: {
    position: number[];
    target: number[];
}, { yaw, elevation }: {
    yaw?: number[] | null;
    elevation?: number[] | null;
}): {
    yaw: number;
    elevation: number;
    camera: number[];
}[] | null;
export namespace DEFAULTS {
    export let maxAngle: number;
    export let minOverlap: number;
    export let depthSlack: number;
    export let spanTolerance: number;
    export let bandMargin: number;
    export let reach: number;
    export { MIN_VISIBLE as minVisible };
}
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
declare const MIN_VISIBLE: 0.5;
export {};
