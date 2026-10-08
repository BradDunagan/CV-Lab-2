/**
 * Whether a run's moving part is the one BELOW: moved down from contact, by
 * its offset, its sweep, or every pose. The ledge is then its own top face, in
 * the still part's shadow (design-lab-model.md §5, "A thirty-fifth").
 */
export function movingBelow(run: any): any;
/** How far the upper part is above the lower for a row of a run, mm: the moving part's lift, or its drop. */
export function liftOf(run: any, r: any): any;
/**
 * Per view and pair, the tracked gap as a line in the lift, least squares.
 * The run must be a sweep along y with nothing slid: elsewhere the gap is not
 * the flush one.
 */
export function flushLines(run: any): {
    yaw: any;
    elevation: any;
    pair: any;
    pairAngle: any;
    flush: number[];
    flushRms: number;
    flushOf: any;
    on: string;
}[];
/**
 * The table: each flush line with its shadow's width per mm.
 * @param {object} flushRun a gap-sweep record, swept along y with nothing slid
 * @param {object[]} fitRuns gap-sweep records with free ledge fits
 */
export function ledgeTable(flushRun: object, fitRuns: object[], { minGain, minLit }?: {
    minGain?: number | undefined;
    minLit?: number | undefined;
}): {
    widthPerMm: any;
    widthsOf: any;
    yaw: any;
    elevation: any;
    pair: any;
    pairAngle: any;
    flush: number[];
    flushRms: number;
    flushOf: any;
    on: string;
}[];
export function median(a: any): any;
export function angleApart(a: any, b: any): number;
