/**
 * One frame's single-edge rows for the moving part, against a view's anchors.
 *
 * @param {object} input the frame's slots
 * @param {object[]} input.truth `groundTruth` records (gt-edge)
 * @param {object[]} input.matches `match` records of the frame's segments against that truth
 * @param {object[]} input.edges `fitEdges` records
 * @param {string | string[]} moving the moving part's name in the truth
 * @param {{x: number, y: number, ux: number, uy: number, nx: number, ny: number, half: number, angle: number}[]} anchors
 *   this view's anchors so far, in the order they were made; not changed
 * @param {object} [options] minLength, minVisible, clear, maxAngle, maxShift
 * @returns {{rows: object[], anchors: object[]}} the rows, and the anchors with any new edge's added
 */
export function edgeRows(input: {
    truth: object[];
    matches: object[];
    edges: object[];
}, moving: string | string[], anchors?: {
    x: number;
    y: number;
    ux: number;
    uy: number;
    nx: number;
    ny: number;
    half: number;
    angle: number;
}[], options?: object): {
    rows: object[];
    anchors: object[];
};
/** Edge rows' numbers start here, clear of any gap pair's. */
export const EDGE_BASE: 100;
