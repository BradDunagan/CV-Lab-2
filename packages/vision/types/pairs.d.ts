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
export function fitPairs(segments: any, raster: any, options?: {}): {
    rms: number;
    samples: any;
    iterations: number;
    converged: boolean;
    profile?: string | undefined;
    strip: string;
    aperture: any;
    apertureFrom: string;
    apertureSegments: any;
    ledge?: {
        gain: number;
        edge: string | number;
    } | null | undefined;
    type: string;
    id: number;
    a: {
        segment: any;
        x0: any;
        y0: any;
        x1: any;
        y1: any;
        shift: number;
    };
    b: {
        segment: any;
        x0: any;
        y0: any;
        x1: any;
        y1: any;
        shift: number;
    };
    x: any;
    y: any;
    nx: number;
    ny: number;
    gap: number;
    gapSigma: number | null;
    detectedGap: number;
    levels: any[];
    levelSlopes: any[] | null;
}[];
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
export function findPairs(segments: any, raster: any, options?: {}): {
    type: string;
    id: number;
    a: {
        segment: any;
        x0: any;
        y0: any;
        x1: any;
        y1: any;
        shift: any;
    };
    b: {
        segment: any;
        x0: any;
        y0: any;
        x1: any;
        y1: any;
        shift: any;
    };
    x: any;
    y: any;
    nx: number;
    ny: any;
    gap: number;
    gapSigma: number | null;
    detectedGap: number;
    levels: any[];
    strip: string;
    aperture: any;
    apertureFrom: string;
    apertureSegments: any;
    gain: number;
    rms: number;
    samples: any;
    iterations: number;
    converged: boolean;
}[];
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
export function trackPair(raster: any, carried: any, options?: {}): any;
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
export function hiddenIn(raster: any, l: any, from: any, to: any, aperture: any, opts: any, maxIterations: any): {
    side: number;
    gain: number;
    gap: number;
    fit: {
        edges: any;
        levels: any[];
        levelSlopes: any[] | null;
        aperture: any;
        gapSigma: number | null;
        rms: number;
        samples: any;
        iterations: number;
        converged: boolean;
    };
    base: {
        ox: any;
        oy: any;
        ux: any;
        uy: any;
        nx: number;
        ny: any;
        half: number;
    };
} | null;
/**
 * The segments in id order, every pair's frame, and which segments are in one.
 * fitPairs and findPairs both begin here, so they agree on which segments are
 * pairs -- and therefore on which are lone, which is what the aperture is
 * measured on.
 */
export function candidates(segments: any, opts: any): {
    segs: any;
    frames: {
        ox: any;
        oy: any;
        ux: number;
        uy: number;
        nx: number;
        ny: number;
        half: number;
        edges: {
            id: any;
            c: number;
            m: number;
        }[];
    }[];
    paired: Set<any>;
};
/**
 * The frame two near-parallel segments are fitted in, or null if they are not
 * a pair.
 *
 * The longer segment is the reference (the lower id, between equals). `t` runs
 * along it from the middle of the overlap and `h` across it. Each segment is
 * then h = c + m*t, and the one with the smaller c is edge 0.
 */
export function pairFrame(sa: any, sb: any, opts: any): {
    ox: any;
    oy: any;
    ux: number;
    uy: number;
    nx: number;
    ny: number;
    half: number;
    edges: {
        id: any;
        c: number;
        m: number;
    }[];
} | null;
/** The frame of one segment on its own: the same, with a single edge in it. */
export function loneFrame(seg: any, opts: any): {
    ox: any;
    oy: any;
    ux: number;
    uy: number;
    nx: number;
    ny: number;
    half: number;
    edges: {
        id: any;
        c: number;
        m: number;
    }[];
} | null;
/**
 * The pixels of the band, in row-major order: the frame's length, from `pad`
 * below its first edge to `pad` above its last, where the DETECTED edges put
 * them. Fixed before the fit starts, so the fit is over one set of pixels
 * throughout.
 */
export function bandSamples(raster: any, frame: any, opts: any): {
    t: number[];
    h: number[];
    v: any[];
};
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
export function fitBand(samples: any, frame: any, { aperture, fitAperture, heldStrip, slopedLevels, heldEdges, maxIterations, profile, occluder, stripAt }: {
    aperture: any;
    fitAperture?: boolean | undefined;
    heldStrip?: null | undefined;
    slopedLevels?: boolean | undefined;
    heldEdges?: never[] | undefined;
    maxIterations?: number | undefined;
    profile?: string | undefined;
    occluder?: null | undefined;
    stripAt?: number | undefined;
}): {
    edges: any;
    levels: any[];
    levelSlopes: any[] | null;
    aperture: any;
    gapSigma: number | null;
    rms: number;
    samples: any;
    iterations: number;
    converged: boolean;
} | null;
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
export function measureAperture(segments: any, raster: any, paired: any, opts: any): {
    width: any;
    segments: any;
} | null;
/** What each lone segment says the aperture is: [{ id, aperture }], in id order. */
export function loneApertures(segments: any, raster: any, paired: any, opts: any): {
    id: any;
    aperture: any;
}[];
/** The median of those, leaving out segment `except` if given. Null if none. */
export function medianAperture(found: any, except?: null): {
    width: any;
    segments: any;
} | null;
/**
 * The fraction of a square pixel lying beyond a straight step.
 *
 * `d` is how far the pixel's centre is past the step, along the step's normal.
 * `a <= b` are the half-widths of the square's two sides projected on that
 * normal. Projected, a square is a box convolved with a box: a trapezoid, flat
 * for |x| <= b - a and falling to nothing at |x| = a + b. This is its integral.
 */
export function coverage(d: any, a: any, b: any): number;
/** The trapezoid itself: d(coverage)/dd. */
export function density(d: any, a: any, b: any): number;
/**
 * Solve A x = b in place by elimination with partial pivoting. False if a
 * pivot is no larger than `tiny`: the caller scales A to a unit diagonal first
 * when it wants that to mean "singular" rather than "small numbers".
 */
export function solve(A: any, b: any, tiny?: number): boolean;
export namespace DEFAULTS {
    let maxGap: number;
    let maxAngle: number;
    let minOverlap: number;
    let pad: number;
    let inset: number;
    let strip: string;
    let stripLevel: number;
    let aperture: string;
    let apertureWidth: number;
    let profile: string;
    let minSigmas: number;
    let ledge: string;
    let levelSlope: string;
    let window: number;
    let reach: number;
    let minGain: number;
}
