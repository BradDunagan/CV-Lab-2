/**
 * @cv-lab/vision -- what a host needs to measure with cv-lab's library.
 *
 * A host supplies three things and the library touches nothing else: a
 * compute backend (the WebAssembly module, `loadWasm`, or in cv-lab the
 * Node-API addon), an image decoder for `load`, and a text reader for the
 * files `load(curve=)` and `groundTruth` name. No file system, no Node
 * built-in, no global state: two registries with different backends can
 * live in one process.
 *
 *   import { loadWasm, createRegistry, Session } from '@cv-lab/vision';
 *   const backend = await loadWasm(new URL('@cv-lab/vision/cvlab.wasm', import.meta.url));
 *   const session = new Session({ registry: createRegistry({ backend, decodeFile }) });
 *   await session.run('A = load("frame.png", as=linear)\nG = gray(A)');
 *
 * A cell then calibrates once, from sweeps it commanded, and estimates each
 * frame:
 *
 *   const calibrated = calibrateReadings({ sweepFrames, unknowns, mode: 'hinged', pick });
 *   const { solution } = estimatePose({ calibrated: [...calibrated.values()], medianSigma },
 *     frameReadings(rows, angles), carryForward(last, move, motionVariance));
 *
 * Every module is also importable on its own, `@cv-lab/vision/<name>`.
 */

export { loadWasm, instantiate } from './wasm.js';
export { createRegistry, buildOps } from './ops.js';
export { Session, SessionError, backendAdapter, hashScalars, hashFeatures } from './session.js';
export { parseStatement, parseScript, quoteString, ParseError } from './parser.js';
export { sha256 } from './sha256.js';

// From readings to a pose: calibrate against commanded sweeps, then solve
// each frame against the last pose carried forward.
export {
  calibrateReadings, solvePose, estimatePose, frameReadings, pairAngles, carryForward,
  readingsOf, keyOf, modelAt, hingeFor, POINTS, ANGLES,
} from './calibrate.js';
export { solvePosition, solveLifted } from './position.js';
// Carrying what a wide frame measured into the narrow ones, and the ledge.
export { carryPlan } from './carry.js';
export { ledgeTable, flushLines, movingBelow } from './ledge.js';
// A frame's gap readings, from its features (gap-sweep's rows).
export { gapRows } from './gapsweep.js';

/** @typedef {import('./types.js').Backend} Backend */
/** @typedef {import('./types.js').BufferHandle} BufferHandle */
/** @typedef {import('./types.js').BufferInfo} BufferInfo */
/** @typedef {import('./types.js').HostOptions} HostOptions */
/** @typedef {import('./types.js').DecodedImage} DecodedImage */
