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
};
