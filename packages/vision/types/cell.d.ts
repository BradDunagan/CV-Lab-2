/**
 * A run's rows, each view's pairs numbered by the angle they run at
 * (gapsweep.js numberPairs), so that pair 1 is one pair down the run even
 * through the frames that lost the other. Rows keep their order.
 * @param {object[]} rows every frame's gapRows, with the view's `yaw` and `elevation`
 */
export function numberByView(rows: object[]): any[];
/**
 * A row's two edges as fitPairs placed them: its record among the frame's
 * fitted pairs (the P slot), and which of the record's edges is the moving
 * part's and which the still one's. detectedPair is [moving, target]; the
 * record's edges name segments. Null when the frame has no such record.
 * @param {object} row a gapRows row whose refit came from a pair
 * @param {object[]} fitted the frame's fitPairs records
 */
export function fittedEdges(row: object, fitted: object[]): {
    record: object;
    moving: any;
    still: any;
} | null;
/**
 * Another run's frames as candidates for carryPlan's `pooled`: each frame
 * whose refit can be carried from, with its edges placed. carryPlan then
 * matches them to its own pairs by view and the angle they run at.
 * @param {object[]} rows the other run's numbered rows
 * @param {(row: object) => {name: string, fitted: object[] | null} | null} frameOf
 *   the frame a row came from: its shot name and its fitPairs records
 * @param {{carryMin: number, ledgeMax: number}} opts
 * @param {string} run what the plan calls the other run in its sources
 */
export function poolCandidates(rows: object[], frameOf: (row: object) => {
    name: string;
    fitted: object[] | null;
} | null, opts: {
    carryMin: number;
    ledgeMax: number;
}, run: string): {
    view: string;
    pairAngle: any;
    s: {
        view?: {
            yaw: any;
            elevation: any;
        } | undefined;
        name: string;
        gapMm: any;
        run: string;
    };
    row: object;
    record: object;
    moving: any;
    still: any;
}[];
/**
 * Every frame of every sweep, with the step it was commanded to, as
 * calibrateReadings takes them: sweep by sweep in `unknowns` order.
 * @param {Record<string, {rows: object[], axis?: number[]}>} sweeps by unknown
 * @param {string[]} unknowns
 */
export function sweepFrames(sweeps: Record<string, {
    rows: object[];
    axis?: number[];
}>, unknowns: string[]): any[];
/**
 * Frames grouped into poses: one per pose (or, in a sweep, per step and
 * angle), every view's readings at each point keyed as the calibration keys
 * them, and the pose's displacement from the reference.
 * @param {object[]} rows
 * @param {(row: object) => number[]} displacementFor
 * @param {string[]} points POINTS[...]
 * @returns {{d: number[], label: null, readings: Map<string, object>}[]}
 */
export function posesFrom(rows: object[], displacementFor: (row: object) => number[], points: string[]): {
    d: number[];
    label: null;
    readings: Map<string, object>;
}[];
/**
 * The median gapSigma of the calibration frames, tracked and refit together:
 * what a reading's weight is made absolute against, when it is weighed
 * against a prior. Null when there is none.
 * @param {object[]} rows every calibration frame's row
 */
export function medianGapSigma(rows: object[]): any;
/**
 * A calibration from a cell's own sweeps, in the form solve-position's
 * --save-calibration writes and estimatePose reads: per reading, the carried
 * mode's reference and Jacobian (and hinges), fitted by `mode` -- joint or
 * hinged, from what was read, with no truth.
 *
 * @param {object} c
 * @param {Record<string, {rows: object[], axis?: number[]}>} c.sweeps each
 *   sweep's numbered rows, by the unknown it moved along: x, y and z, and
 *   optionally turn, tipx, tipz. Every frame of a sweep is at the reference
 *   pose but for that one unknown
 * @param {'joint' | 'hinged'} [c.mode] hinged by default
 * @param {'mid' | 'ends' | 'both'} [c.readings] where along each pair; both by default
 * @param {boolean} [c.movingBelow] the moving part is below the still one
 * @returns {{unknowns: string[], calibrate: string, readings: string, movingBelow?: true,
 *   medianSigma: number | null, calibrated: object[]}}
 */
export function calibrateCell({ sweeps, mode, readings, movingBelow }: {
    sweeps: Record<string, {
        rows: object[];
        axis?: number[];
    }>;
    mode?: "joint" | "hinged" | undefined;
    readings?: "mid" | "ends" | "both" | undefined;
    movingBelow?: boolean | undefined;
}): {
    unknowns: string[];
    calibrate: string;
    readings: string;
    movingBelow?: true;
    medianSigma: number | null;
    calibrated: object[];
};
/**
 * Where the part is in one frame -- every view captured at one pose -- from
 * a calibrateCell calibration: its displacement from the reference pose, one
 * value per unknown (mm, or degrees for an angle), or why it was refused.
 * Solved as solve-position solves a test pose: the carried readings, each
 * weighed by 1/gapSigma^2, refused when the readings barely separate the
 * unknowns (`maxSigma` mm or degrees per px of reading error) or disagree
 * with the solution by more than `maxResidual` px RMS.
 *
 * @param {ReturnType<typeof calibrateCell>} calibration
 * @param {object[]} rows the frame's rows, numbered with the calibration's frames
 *   so that its pairs are the calibration's
 * @param {{weights?: 'sigma' | 'none', maxSigma?: number, maxResidual?: number}} [o]
 * @returns {{d: number[] | null, sigma: number[] | null, residualRms: number | null,
 *   refused: null | 'undetermined' | 'geometry' | 'residual', readings: number}}
 */
export function solveCell(calibration: ReturnType<typeof calibrateCell>, rows: object[], { weights, maxSigma, maxResidual }?: {
    weights?: "sigma" | "none";
    maxSigma?: number;
    maxResidual?: number;
}): {
    d: number[] | null;
    sigma: number[] | null;
    residualRms: number | null;
    refused: null | "undetermined" | "geometry" | "residual";
    readings: number;
};
/** The translational unknowns, in millimetres, in this order. */
export const AXES: string[];
export function carriable(row: any, { carryMin, ledgeMax }: {
    carryMin: any;
    ledgeMax: any;
}): boolean;
export function angleOf(u: any, r: any): any;
export function sweepStep(u: string, r: object, axis?: number[]): any;
export function pairRows(rows: any): any;
export function refitPick(r: any): any;
export function carriedPick(r: any): any;
export function pickSigma(pick: any, r: any): any;
