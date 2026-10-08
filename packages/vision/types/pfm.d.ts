/**
 * A float frame, rows top-down.
 */
export type Frame = import("./types.js").Frame;
/**
 * Float frames as Portable Float Maps: the file form of what rr's analysis
 * camera hands the package in memory.
 *
 * PFM is the simplest format that holds linear light losslessly: a text
 * header -- `PF` (three channels) or `Pf` (one), the size, and a scale whose
 * sign is the byte order -- then float32 samples, rows bottom-up. pt-lab
 * writes it (`npm run generate -- --float`), and cv-lab's host reads it for
 * `frame()`. The package itself only ever sees a `Frame`.
 */
/**
 * A float frame, rows top-down.
 * @typedef {import('./types.js').Frame} Frame
 */
/**
 * A PFM file's bytes as a frame, rows turned top-down. Refuses anything that
 * is not exactly a header and width x height x channels samples.
 * @param {Uint8Array} bytes
 * @returns {Frame}
 */
export function decodePfm(bytes: Uint8Array): Frame;
/**
 * A frame as PFM bytes, little-endian, rows bottom-up. Alpha, if any, is not
 * written: PFM has no place for it.
 * @param {Frame} frame
 * @returns {Uint8Array}
 */
export function encodePfm({ width, height, channels, data }: Frame): Uint8Array;
