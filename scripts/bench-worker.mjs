/**
 * `npm run bench`'s browser side: bundled (esbuild, IIFE) into a Web Worker,
 * as rr would run the package. It fetches the module and the frames from the
 * bench's local server, so no frame crosses the automation protocol, and
 * posts back what bench-core measured.
 */

import { loadWasm } from '../packages/vision/src/wasm.js';
import { createRegistry } from '../packages/vision/src/ops.js';
import { decodePfm } from '../packages/vision/src/pfm.js';
import { benchFrames } from './bench-core.mjs';

self.onmessage = async ({ data: { wasm, frames, script, reps } }) => {
  try {
    const backend = await loadWasm(await fetch(wasm));
    const decoded = new Map();
    for (const { source } of frames) {
      decoded.set(source, decodePfm(new Uint8Array(await (await fetch(source)).arrayBuffer())));
    }
    const registry = createRegistry({ backend, readFrame: async (source) => decoded.get(source) });
    const results = await benchFrames({ registry, frames, script, reps });
    self.postMessage({ ok: true, build: backend.build, results });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && (err.stack || err.message) || err) });
  }
};
