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
  // The C layer owns the memory; JS holds an opaque handle and reaches the
  // pixels through an explicit COPY -- bufferRead and bufferWrite, named so
  // that no caller assumes otherwise.
  //
  // There is deliberately no bufferView(). Electron refuses
  // napi_create_external_arraybuffer with napi_status 22, because V8 is built
  // with pointer compression and a backing store must live inside its memory
  // cage, so JS cannot alias C memory at all here. See design-lab-model.md §8
  // and electron-guide.md §1 -- both measured, in both runtimes.

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

  /**
   * Build a 3-channel f32 buffer from 8-bit RGBA, as Chromium's decoder
   * produces it. Alpha is dropped.
   *
   * `from` says what the stored bytes MEAN; `as` says what the buffer should
   * hold. When they differ the transfer function is applied as an exact
   * 256-entry lookup -- 8-bit input makes the whole curve enumerable, so
   * there is no per-pixel power function and no approximation.
   * @param {Uint8ClampedArray|Uint8Array} pixels
   * @param {number} width
   * @param {number} height
   * @param {{from?:'srgb'|'linear', as?:'srgb'|'linear'}} [opts]
   */
  bufferFromRGBA8: addon.bufferFromRGBA8,

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

  // --- the display path (design-lab-model.md §6, §8) --------------------
  //
  // Downsampling and the display transform happen in C, so only
  // display-resolution RGBA crosses into JS. That matters doubly here: every
  // crossing is a real copy, since Electron forbids external ArrayBuffers.

  /**
   * @param {object} handle
   * @param {{width:number, height:number, x?:number, y?:number, w?:number, h?:number,
   *          range?:'auto'|'fixed'|'percentile'|'symmetric', lo?:number, hi?:number,
   *          percentile?:number, curve?:'linear'|'log'|'abs'|'sqrt',
   *          colormap?:'gray'|'viridis'|'turbo'|'diverging'|'categorical'|'cyclic',
   *          channel?:number}} spec
   * @returns {{pixels:Uint8ClampedArray, width:number, height:number, lo:number, hi:number}}
   */
  renderTile: addon.renderTile,

  /** @returns {{counts:Int32Array, lo:number, hi:number}} */
  histogram: addon.histogram,

  /** @returns {number[]|null} one value per channel, or null outside the image */
  samplePixel: addon.samplePixel,

  /**
   * Geometry out of a segment label map — the first result that is not pixels.
   * @param {object} handle an i32 label map
   * @returns {Array<{type:'edge-segment', id:number, pixels:number,
   *   x0:number, y0:number, x1:number, y1:number, length:number, angle:number,
   *   residual:number, rms:number, cx:number, cy:number}>}
   */
  fitSegments: addon.fitSegments,
};
