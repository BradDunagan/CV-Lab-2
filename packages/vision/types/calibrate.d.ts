/** One row's readings at each point, as truth, detected, refit and tracked, with their sigmas. */
export function readingsOf(r: any): {
    mid: {
        truth: any;
        detected: any;
        refit: any;
        sigma: any;
        tracked: any;
        trackedSigma: any;
    };
    'end 1': {
        truth: any;
        detected: any;
        refit: any;
        sigma: any;
        tracked: any;
        trackedSigma: any;
    };
    'end 2': {
        truth: any;
        detected: any;
        refit: any;
        sigma: any;
        tracked: any;
        trackedSigma: any;
    };
};
/** Least-squares slope and intercept of y against x. Null with under two points. */
export function fitLine(points: any): {
    slope: number;
    at0: number;
} | null;
/**
 * A calibrated reading's value at displacement d: the reference, the slopes,
 * the hinges, and the lift's terms (the lift is d[liftAxis]).
 */
export function modelAt(o: any, d: any, { hingeOf, liftAxis }?: {
    hingeOf?: ((x: any) => number) | undefined;
    liftAxis?: number | undefined;
}): any;
/**
 * Each reading's model, from calibration frames whose displacement is known.
 *
 * @param {object} c
 * @param {Array<{sweep: string, step: number, row: object}>} c.sweepFrames
 *   every frame of every sweep, sweep by sweep in `unknowns` order: the
 *   unknown it moved along, and how far, in mm or degrees
 * @param {Array<{row: object, d: number[]}>} [c.liftFrames] frames made at
 *   another lift, each with its whole displacement; they join a joint or
 *   hinged calibration and add lift terms
 * @param {string[]} c.unknowns e.g. ['x', 'y', 'z', 'turn']
 * @param {'full' | 'reference' | 'joint' | 'hinged'} c.mode
 *   full: each slope from its own sweep, the reference their intercepts'
 *   mean; reference: only the reference, from the frames at zero, the
 *   Jacobian kept from `base`; joint: every slope and the reference in one
 *   least-squares fit over every frame, frames more than 3 MADs off dropped
 *   and the fit made again; hinged: joint, with a one-sided slope in x and z
 * @param {(reading: object) => number | null} c.pick which value of a
 *   reading (see readingsOf) to calibrate: the tracked one, the refit...
 * @param {string[]} [c.points] POINTS.both by default
 * @param {(x: number) => number} [c.hingeOf] hingeFor(movingBelow)
 * @param {number} [c.liftAxis] the index of y in `unknowns`
 * @param {Map<string, object>} [c.base] readings to calibrate, keyed: the
 *   truth's, in cv-lab; their other fields are kept. Without it, every key
 *   the frames hold
 * @returns {Map<string, {key: string, view: string, reference: number, jacobian: number[],
 *   hinge?: number[], lift?: number[], liftHinge?: number[], calibration?: {frames: number, kept: number, rms: number}}>}
 */
export function calibrateReadings({ sweepFrames, liftFrames, unknowns, mode, pick, points, hingeOf, liftAxis, base }: {
    sweepFrames: Array<{
        sweep: string;
        step: number;
        row: object;
    }>;
    liftFrames?: {
        row: object;
        d: number[];
    }[] | undefined;
    unknowns: string[];
    mode: "full" | "reference" | "joint" | "hinged";
    pick: (reading: object) => number | null;
    points?: string[] | undefined;
    hingeOf?: ((x: number) => number) | undefined;
    liftAxis?: number | undefined;
    base?: Map<string, object> | undefined;
}): Map<string, {
    key: string;
    view: string;
    reference: number;
    jacobian: number[];
    hinge?: number[];
    lift?: number[];
    liftHinge?: number[];
    calibration?: {
        frames: number;
        kept: number;
        rms: number;
    };
}>;
/** Every reading key the frames hold at these points, sorted. */
export function keysOf(sweepFrames: any, points?: string[]): any[];
/**
 * One pose from its readings, Huber-reweighted when `robust` > 0: a reading
 * further off than `robust` px keeps robust/|r| of its weight, five rounds
 * from the plain solve. With a prior, the readings' weights are made
 * absolute first -- `readingSigma` px for a reading whose own sigma is
 * `medianSigma` -- since a prior in millimetres is weighed against them.
 */
export function robustSolve(obs0: any, { prior, robust, medianSigma, readingSigma, liftAxis, hingeOf }?: {
    prior?: null | undefined;
    robust?: number | undefined;
    medianSigma?: number | undefined;
    readingSigma?: number | undefined;
    liftAxis?: number | undefined;
    hingeOf?: ((x: any) => number) | undefined;
}): {
    residualRms: number | null;
    determined?: boolean | undefined;
    d?: number[] | null | undefined;
    sigma?: number[] | null | undefined;
    covariance?: number[][] | null | undefined;
    observations?: number | undefined;
    reason?: string | null | undefined;
} | null;
/**
 * A pose from one frame's readings, or why not.
 *
 * Refused three ways. Not determined. Determined, but from readings that
 * barely separate the unknowns: the UNWEIGHTED sigma -- millimetres per pixel
 * of reading error -- over `maxSigma` (the weighted solve's own sigma is
 * scaled by 1/gapSigma^2 and refused nothing: the stack's two 50-degree
 * views solved a pose 5 mm off from two pairs, the twentieth). And when its
 * readings disagree with it by more than `maxResidual` px RMS (three pairs of
 * a part turned past the pairing limit solved 98 mm off, the twenty-third).
 *
 * @param {object[]} used calibrated readings (calibrateReadings' values)
 * @param {Map<string, object>} readings this frame's, keyed (readingsOf's per point)
 * @param {object} o
 * @param {(r: object) => number | null} o.pick the value to use from a reading
 * @param {(r: object) => number | null} [o.sigmaOf] its gapSigma, for weights
 * @param {'sigma' | 'none'} [o.weights]
 * @param {number} [o.maxSigma] mm (or degrees) per px of reading error, at most
 * @param {number} [o.maxResidual] px RMS, at most
 * @param {{d: number[], covariance: number[][]} | null} [o.prior] see robustSolve
 * @param {number} [o.robust] see robustSolve
 * @param {number} [o.medianSigma] see robustSolve
 * @param {number} [o.readingSigma] see robustSolve
 * @param {number} [o.liftAxis]
 * @param {(x: number) => number} [o.hingeOf]
 * @returns {{solution: object, refused: null | 'undetermined' | 'geometry' | 'residual'}}
 */
export function solvePose(used: object[], readings: Map<string, object>, { pick, sigmaOf, weights, maxSigma, maxResidual, ...solveOptions }: {
    pick: (r: object) => number | null;
    sigmaOf?: ((r: object) => number | null) | undefined;
    weights?: "sigma" | "none" | undefined;
    maxSigma?: number | undefined;
    maxResidual?: number | undefined;
    prior?: {
        d: number[];
        covariance: number[][];
    } | null | undefined;
    robust?: number | undefined;
    medianSigma?: number | undefined;
    readingSigma?: number | undefined;
    liftAxis?: number | undefined;
    hingeOf?: ((x: number) => number) | undefined;
}): {
    solution: object;
    refused: null | "undetermined" | "geometry" | "residual";
};
/** Seeded normal deviates: a robot's errors drawn repeatably, in a simulation. */
export function gaussians(seed: any): () => number;
/**
 * Each view's pairs by the angle they run at in the image, from the rows the
 * calibration was made from. gap-sweep numbers a run's pairs by angle within
 * that run, so a frame that lost one pair would call the other "1"; matching
 * on the angle keeps a reading the reading it was calibrated as.
 * @param {object[]} rows every row of every calibration sweep
 * @returns {Map<string, number>} `<view> / pair <n>` -> its median angle, degrees
 */
export function pairAngles(rows: object[]): Map<string, number>;
/** The calibrated pair a row is, by its angle, within 10 degrees; null if none. */
export function pairOf(r: any, angles: any): number | null;
/**
 * One frame's readings, the carried mode's -- tracked, else refit, else
 * detected -- keyed as the calibration keys them: `[value, sigma]`, or
 * `[null, sigma, [a, b]]` where a track could not tell a strip from one edge
 * and gives both hypotheses for the prior to choose between.
 * @param {object[]} rows gap-sweep's rows for this frame
 * @param {Map<string, number>} angles pairAngles of the calibration
 */
export function frameReadings(rows: object[], angles: Map<string, number>): Map<any, any>;
/**
 * The prior a frame is solved against: the last solution moved by the move
 * commanded since, its covariance grown by the move's own variance.
 * @param {{d: number[], covariance: number[][]}} state
 * @param {number[]} move
 * @param {number[]} motionVariance per unknown
 */
export function carryForward(state: {
    d: number[];
    covariance: number[][];
}, move: number[], motionVariance: number[]): {
    d: number[];
    covariance: number[][];
};
/**
 * One frame of a closed loop: the pose from this frame's readings and the
 * prior, a calibration made by calibrateReadings (as saved: `calibrated`,
 * `medianSigma`, `reference`).
 *
 * A reading's weight is absolute -- `readingSigma` px for a reading whose
 * gapSigma is the calibration's median -- since the prior is in millimetres.
 * A reading given as two hypotheses is taken where the prior predicts one of
 * them: the prediction, with its own uncertainty through the Jacobian and the
 * reading's, must be nearer one by three sigmas; otherwise it is left out.
 *
 * @returns {{solution: object, alone: object, observations: object[], hypotheses: {resolved: number, unresolved: number}}}
 *   `solution` with the prior, `alone` without it (unweighted), both in
 *   displacement from the calibration's reference pose
 */
export function estimatePose(calibration: any, readings: any, prior: any, { readingSigma, movingBelow }?: {
    readingSigma?: number | undefined;
    movingBelow?: any;
}): {
    solution: object;
    alone: object;
    observations: object[];
    hypotheses: {
        resolved: number;
        unresolved: number;
    };
};
/** The angular unknowns, in degrees; the rest (x, y, z) are millimetres. */
export const ANGLES: string[];
export namespace POINTS {
    let mid: string[];
    let ends: string[];
    let both: string[];
}
export function viewOf(r: any): string;
export function keyOf(r: any, point: any): string;
export function hingeFor(movingBelow: any): (x: any) => number;
