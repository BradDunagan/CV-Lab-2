/**
 * @param {object[]} rows the run's numbered rows
 * @param {object[]} shots the run's shots: name, gapMm, and pose and view where it has them
 * @param {(shot: object) => {fitted: object[] | null}} featuresOf
 * @param {object} opts carryMin, ledgeMax, offset, axis, poses, ledgeLift, ledgeFit, ledge
 * @param {object[] | null} [pooled] other runs' candidates (cell.js poolCandidates)
 * @param {boolean} [ownToo] whether this run's own frames are candidates too, given pooled ones
 * @param {string} [ownRun] what sources call this run
 * @param {{entries: object[]} | null} [ledgeTable]
 * @returns {{minPx: number, ledgeMax: number, sources: object[], missing: object[],
 *   commands: Record<string, string[]>, ledges?: object[]}}
 */
export function carryPlan(rows: object[], shots: object[], featuresOf: (shot: object) => {
    fitted: object[] | null;
}, opts: object, pooled?: object[] | null, ownToo?: boolean, ownRun?: string, ledgeTable?: {
    entries: object[];
} | null): {
    minPx: number;
    ledgeMax: number;
    sources: object[];
    missing: object[];
    commands: Record<string, string[]>;
    ledges?: object[];
};
/** The moving part's displacement from contact for a shot, mm: its pose, or the sweep's step. */
export function displacementOf(s: any, opts: any): any;
export function guessFrom(read: any): any;
