/**
 * Explain every feature in a list.
 *
 * Returns new records rather than mutating: a features slot is content-hashed,
 * and a kernel that edited its input in place would make two slots share one
 * object and one hash describe both.
 */
export function explainFeatures(features: any, rasters: any, opts?: {}): any;
/**
 * Measure what changes across a feature, and say what that makes it.
 *
 * `depth` is in metres, already unpacked. `normal` holds components in [0,1],
 * in view space. `albedo` is linear reflectance. `camera` needs only a `fov`,
 * and without it the depth evidence cannot be corrected for slant — see
 * `planeAccountsFor`. Any of them may be null, in which case the test it
 * settles is skipped and the cause falls through — an honest `unknown` rather
 * than a confident `shading` reached by not looking.
 */
export function explainFeature(feature: any, { depth, normal, albedo, camera }: {
    depth: any;
    normal: any;
    albedo: any;
    camera: any;
}, opts?: {}): {
    depthStep: any;
    planeStep: any;
    depthExcess: any;
    normalStep: any;
    albedoStep: any;
    slant: any;
    cause: string;
};
/**
 * The points to sample across one feature: pairs either side of it.
 *
 * A segment is crossed perpendicular at several places along its length, and
 * the results are combined with a MEDIAN rather than a mean. A fitted segment
 * routinely overshoots its real extent by a pixel or two, so a few of its
 * samples land past the end of whatever caused it and measure something else
 * entirely; a mean lets those decide the answer and a median does not.
 *
 * A corner is a point, so it is crossed along both axes instead.
 *
 * An arc is crossed RADIALLY — its normal turns with it, which is the only
 * thing that differs from a segment. Everything downstream of here works on
 * pairs of points and needs no notion of what shape produced them, so nothing
 * else in this file changes for a curve.
 */
export function crossings(feature: any, { offset, samples }: {
    offset: any;
    samples: any;
}): any[];
/** Bilinear read of one channel, clamped at the edges. */
export function sample(raster: any, x: any, y: any, channel: any): number;
/** Unit normal at a pixel, from a pass holding components packed into [0,1]. */
export function normalAt(raster: any, x: any, y: any): number[];
export function angleBetween(a: any, b: any): number;
export function median(xs: any): any;
/**
 * What a locally flat surface accounts for, so the rest can be the evidence.
 *
 * The normal pass is in VIEW space — established by measurement, since nothing
 * documented it: fitting the prediction below against the depth pass gives
 * 0.99 with the normals as they are and 1.16 with them rotated out of world
 * space, and one pixel's normal stays +Z-dominant across three cameras 6 m
 * apart, which world-space normals of a convex object cannot do.
 *
 * That is why only the FIELD OF VIEW is needed and not where the camera is: a
 * view-space normal is already in the frame the depth pass is measured in, so
 * the focal length is the whole of the camera that matters here.
 */
export function viewGeometry(camera: any, width: any, height: any): {
    f: number;
    cx: number;
    cy: number;
} | null;
/** The direction from the camera through a pixel, in view space: -Z forward. */
export function viewRay(g: any, x: any, y: any): number[];
/**
 * How far the depth on one side of a pair sits from where a continuous surface
 * would put it — the evidence that one surface ends in front of another.
 *
 * Each side's tangent plane is extended to the other side and asked what depth
 * it predicts there; the answer is compared with the depth actually recorded.
 * For a point at view-space depth `z` the position is `z * (ex, ey, -1)` — the
 * depth pass holds distance along the view axis, not radius — so the plane
 * `n·P = c` gives `z = c / (n·e)` at any other pixel. A surface that merely
 * recedes predicts its other side exactly and leaves nothing; a step is
 * precisely what extrapolation cannot reach.
 *
 * Two details, both of which a test had to find rather than reasoning reach:
 *
 * **Anchored on the samples, never on the midpoint between them.** The
 * midpoint of a pair straddling a real edge is the one place where neither
 * surface is — its normal is a blend of two and its depth the average of two —
 * and since the prediction scales with that depth, a 0.4 m step measured this
 * way accounted for a fifth of itself.
 *
 * **The LARGER of the two prediction errors, not the smaller.** A plane
 * anchored on the far side of a step is anchored deeper, and slant costs depth
 * in proportion to depth, so that side over-explains and hides the step it is
 * standing on. Taking the larger error asks whether the depth is reachable
 * from the nearer surface, which is the question.
 *
 * Returns null when it cannot be computed rather than guessing: no camera, no
 * normal pass, no normal recorded at either sample, or a plane so nearly
 * edge-on to the ray that the intersection runs away. A null leaves the raw
 * difference standing — v1's behaviour, reached honestly and visible in the
 * record as `planeStep: 0`.
 */
export function surfaceResidual(g: any, normal: any, depth: any, a: any, b: any): number | null;
/** How far the surface is turned from the line of sight, in degrees. */
export function slantAt(g: any, normal: any, x: any, y: any): number;
/** The causes, in the order they are tested. First match wins. */
export const CAUSES: string[];
export namespace DEFAULTS {
    let offset: number;
    let samples: number;
    let depthStep: number;
    let normalStep: number;
    let albedoStep: number;
}
