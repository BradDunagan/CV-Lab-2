'use strict';

/**
 * cv-lab's loader for the WebAssembly backend: the module file, read from
 * disk and instantiated synchronously, which Node allows at this size. The
 * backend itself -- the addon's functions over the module -- is the vision
 * package's (packages/vision/src/wasm.js), host-free, so rr's browser build
 * loads the same code its own way (`loadWasm`).
 *
 * `CVLAB_BACKEND=wasm` makes `require('../native')` return this.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { instantiate } = require('../packages/vision/src/wasm.js');

const WASM_FILE = path.join(__dirname, '..', 'packages', 'vision', 'wasm', 'cvlab.wasm');

/** The module this repository builds, compiled and instantiated. */
function load(file = WASM_FILE) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    throw new Error(`cv-lab-2: no WebAssembly module at ${file}. Run: npm run build:wasm\n  ${err.message}`);
  }
  const build = crypto.createHash('sha256').update(bytes).digest('hex');
  return instantiate(new WebAssembly.Module(bytes), { build });
}

module.exports = { instantiate, load, WASM_FILE };
