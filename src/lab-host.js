'use strict';

/**
 * cv-lab as a host of the vision package (packages/vision): the three
 * things the package asks a host for, supplied the Node way.
 *
 *   backend       the Node-API addon, or with CVLAB_BACKEND=wasm the same C
 *                 as WebAssembly (native/index.js decides)
 *   readTextFile  node:fs, for load(curve=) and groundTruth
 *   decodeFile    none here; the preload passes Chromium's decoder
 *
 * Everything that constructs a registry in this repository goes through
 * `createLabRegistry`, so the choices are made in one place.
 */

const fs = require('node:fs/promises');

const { createRegistry } = require('../packages/vision/src/ops.js');

const readTextFile = (file) => fs.readFile(file, 'utf8');

/*
 * The addon, required on first use: the registry and session suites run in
 * CI before the addon is built, and only running a kernel needs it.
 */
const native = new Proxy({}, { get: (_, key) => require('../native')[key] });

/** A registry with cv-lab's backend and file reader; `options` adds to or overrides them. */
function createLabRegistry(options = {}) {
  return createRegistry({ backend: native, readTextFile, ...options });
}

module.exports = { createLabRegistry, readTextFile, native };
