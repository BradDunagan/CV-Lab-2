'use strict';

/**
 * Thin JS wrapper around the compiled addon.
 *
 * Keeping this seam means the rest of the app never reaches into build/
 * directly, and you get a useful error instead of a raw dlopen failure when
 * the binary is missing or built for the wrong runtime.
 */

const path = require('node:path');

const CANDIDATES = [
  path.join(__dirname, '..', 'build', 'Release', 'cvlab.node'),
  path.join(__dirname, '..', 'build', 'Debug', 'cvlab.node'),
];

function load() {
  const errors = [];
  for (const candidate of CANDIDATES) {
    try {
      return require(candidate);
    } catch (err) {
      errors.push(`  ${candidate}\n    ${err.message}`);
    }
  }

  const runtime = process.versions.electron ? 'Electron' : 'Node';
  const fix = process.versions.electron
    ? 'npm run rebuild:electron'
    : 'npm run build:native';

  throw new Error(
    `cv-lab-2: could not load the native addon under ${runtime}.\n` +
      `Run: ${fix}\n\n` +
      `Because this is a Node-API addon, one binary works under both Node and\n` +
      `Electron -- so this is almost always "not built yet" rather than an ABI\n` +
      `mismatch. A NODE_MODULE_VERSION error here would mean something in the\n` +
      `chain stopped being Node-API based.\n\n` +
      `Tried:\n${errors.join('\n')}`
  );
}

const addon = load();

module.exports = {
  /**
   * Invert RGBA pixels in place on a background thread. Alpha is preserved.
   * @param {Uint8ClampedArray|Uint8Array} pixels length must be a multiple of 4
   * @returns {Promise<void>}
   */
  invert: addon.invert,

  /**
   * Same kernel, but blocks the calling thread. Present so the app can
   * demonstrate what NOT to do. Do not call this from the UI thread.
   * @param {Uint8ClampedArray|Uint8Array} pixels
   */
  invertSync: addon.invertSync,

  // --- buffers (design-lab-model.md §1-2) -------------------------------
  //
  // The C layer owns the memory; JS holds an opaque handle. bufferView()
  // returns a typed array aliasing that same memory, with no copy.

  /**
   * @param {{width:number, height:number, channels?:number,
   *          dtype?:'f32'|'i32', space?:'none'|'srgb'|'linear'}} spec
   * @returns {object} an opaque buffer handle
   */
  createBuffer: addon.createBuffer,

  /**
   * @param {object} handle
   * @returns {{width:number, height:number, channels:number, dtype:string,
   *            space:string, bytes:number, elements:number, live:boolean}}
   */
  bufferInfo: addon.bufferInfo,

  /**
   * Copy the buffer's contents out as a Float32Array or Int32Array.
   *
   * This is a COPY, not a view. Electron forbids external ArrayBuffers
   * (napi_status 22), so C-owned memory cannot be aliased from JS. Sized for
   * debugging and tests; the display path should ask for a downsampled tile
   * rather than reading whole buffers.
   * @param {object} handle
   */
  bufferRead: addon.bufferRead,

  /**
   * Copy a typed array into the buffer. Kind and length must match exactly.
   * @param {object} handle
   * @param {Float32Array|Int32Array} values
   */
  bufferWrite: addon.bufferWrite,

  /**
   * Free the memory now rather than waiting for GC. Idempotent. Buffers are
   * large enough that leaving 400 MB to the collector is not acceptable.
   * @param {object} handle
   */
  bufferRelease: addon.bufferRelease,

  // --- kernels (design-lab-model.md §3) ---------------------------------
  //
  // One entry point for every operation. The kernels share a C signature, so
  // dispatch is uniform and there is no per-op marshalling anywhere.

  /**
   * @param {string} name       a kernel from kernelNames()
   * @param {object[]} inputs   buffer handles
   * @param {object} [params]   plain values; the kernel reads what it needs
   * @returns {object} a buffer handle, or a scalars object
   */
  runKernel: addon.runKernel,

  /** @returns {string[]} every kernel compiled into the addon */
  kernelNames: addon.kernelNames,
};
