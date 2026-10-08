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
 * Every module is also importable on its own, `@cv-lab/vision/<name>`.
 */

export { loadWasm, instantiate } from './wasm.js';
export { createRegistry, buildOps } from './ops.js';
export { Session, SessionError, backendAdapter, hashScalars, hashFeatures } from './session.js';
export { parseStatement, parseScript, quoteString, ParseError } from './parser.js';
export { sha256 } from './sha256.js';

/** @typedef {import('./types.js').Backend} Backend */
/** @typedef {import('./types.js').BufferHandle} BufferHandle */
/** @typedef {import('./types.js').BufferInfo} BufferInfo */
/** @typedef {import('./types.js').HostOptions} HostOptions */
/** @typedef {import('./types.js').DecodedImage} DecodedImage */
