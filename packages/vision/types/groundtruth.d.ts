/**
 * Turn a parsed ground-truth document into feature records.
 *
 * @param {object} doc   the parsed JSON
 * @param {string} where a label for error messages, normally the file path
 * @returns {{features: Array, width: number, height: number, meta: object}}
 */
export function parseGroundTruth(doc: object, where?: string): {
    features: any[];
    width: number;
    height: number;
    meta: object;
};
/** Parse from text, so the caller decides how the bytes arrived. */
export function readGroundTruth(text: any, where: any): {
    features: any[];
    width: number;
    height: number;
    meta: object;
};
export class GroundTruthError extends Error {
}
/**
 * Where a pixel's centre is, and why ground truth moves at load.
 *
 * The lab's detections are fitted through pixel INDICES (native/
 * addon_kernels.c), so pixel i's centre is at x = i. pt-lab projects the
 * frame onto [0, size] (groundTruthGeometry's toImage), so pixel i spans
 * [i, i+1] and its centre is at i + 0.5. Compared as they came, every
 * detection sat at (-0.5, -0.5) px from its truth -- fitted over every
 * matched edge of cube1, (-0.507, -0.457), and removing it took the rms
 * offset from 0.50 to 0.07 px. match's 3 px tolerance hid it from every
 * table; splitting the gap sweep's error by edge found it, 2026-10-01.
 *
 * The file keeps pt-lab's convention; the lab's is the one every kernel
 * already uses, so the truth moves into it here, once, where it is read.
 * Anything drawing lab coordinates over an image puts pixel i's centre at
 * (i + 0.5) * scale.
 */
export const PIXEL_CENTRE: 0.5;
