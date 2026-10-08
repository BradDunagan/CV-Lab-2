'use strict';

/**
 * The WebAssembly backend: the same functions native/index.js exports, from
 * the same C compiled to wasm32 (native/wasm_api.c, `npm run build:wasm`),
 * for a host that cannot load a Node-API addon -- a browser, and anything
 * that wants to run what a browser runs.
 *
 * `CVLAB_BACKEND=wasm` makes `require('../native')` return this, so every
 * suite that runs on the addon runs on the module unchanged; test/determinism.js
 * is then the parity check, its hashes written for the addon.
 *
 * Errors are the addon's, message for message and class for class (Error,
 * TypeError, RangeError), because tests and callers match on them.
 *
 * The module imports nothing: no WASI, no host functions. Its libm is
 * compiled into it, so `exp` and `pow` are the same bits in every engine,
 * which is more than the addon's three platform libms promise.
 *
 * Buffers are the module's memory, and a handle is an object holding its
 * CvBuffer's address. bufferRead and bufferWrite copy, as the addon's do --
 * here because the memory can grow, and a view of it is detached when it
 * does. A handle that is collected without bufferRelease is freed by a
 * FinalizationRegistry, as the addon's finalizer frees its own.
 */

const fs = require('node:fs');
const path = require('node:path');

const WASM_FILE = path.join(__dirname, 'wasm', 'cvlab.wasm');

const DTYPES = ['f32', 'i32'];
const SPACES = ['none', 'srgb', 'linear'];
const SEGMENT_KEYS = ['id', 'pixels', 'x0', 'y0', 'x1', 'y1', 'length', 'angle', 'residual', 'rms', 'cx', 'cy'];
const ARC_KEYS = ['id', 'pixels', 'cx', 'cy', 'r', 'x0', 'y0', 'x1', 'y1', 'angle0', 'angle1', 'sweep',
  'arcLength', 'chord', 'sagitta', 'residual', 'rms', 'lineRms', 'mx', 'my'];
const PARAMS_MAX = 16;

/** napi_get_value_int64's conversion: truncated, and zero for anything non-finite. */
const int64 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);

/**
 * The backend, from a compiled module. Synchronous: in Node, and in a browser
 * worker, `new WebAssembly.Module(bytes)` is fine at this size (~70 KB).
 * @param {WebAssembly.Module} module
 * @param {{build?: string}} [identity] the module file's SHA-256, for the
 *   session's environment record: what computed the results, exactly
 */
function instantiate(module, { build } = {}) {
  const instance = new WebAssembly.Instance(module, {});
  const w = instance.exports;
  w._initialize();

  const memory = () => w.memory.buffer;
  const u8 = () => new Uint8Array(memory());
  const f64 = (ptr, n) => new Float64Array(memory(), ptr, n);
  const i32at = (ptr) => new Int32Array(memory(), ptr, 1)[0];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const cstring = (ptr) => {
    const bytes = u8();
    let end = ptr;
    while (bytes[end] !== 0) end++;
    return decoder.decode(bytes.subarray(ptr, end));
  };
  const statusText = (status) => cstring(w.cvw_status_str(status));
  const lastStatus = () => w.cvw_last_status();

  /** Run fn with scratch memory, freed afterwards whatever happens. */
  function scratch(fn) {
    const owned = [];
    const alloc = (bytes) => { const p = w.cvw_malloc(bytes); owned.push(p); return p; };
    const str = (s) => {
      const bytes = encoder.encode(s);
      const p = alloc(bytes.length + 1);
      u8().set(bytes, p);
      u8()[p + bytes.length] = 0;
      return p;
    };
    try { return fn(alloc, str); } finally { for (const p of owned) w.cvw_free(p); }
  }

  // --- handles ---------------------------------------------------------
  const ptrs = new WeakMap();
  const finalizer = new FinalizationRegistry((ptr) => w.cvw_buffer_destroy(ptr));
  const wrap = (ptr) => {
    const handle = {};
    ptrs.set(handle, ptr);
    finalizer.register(handle, ptr);
    return handle;
  };
  const unwrap = (handle, message = 'expected a buffer handle') => {
    const ptr = handle !== null && typeof handle === 'object' ? ptrs.get(handle) : undefined;
    if (ptr === undefined) throw new TypeError(message);
    return ptr;
  };
  const live = (ptr) => w.cvw_buffer_data(ptr) !== 0;
  const handleArg = (handle) => {
    const ptr = unwrap(handle);
    if (!live(ptr)) throw new Error('buffer has been released');
    return ptr;
  };

  /**
   * CvParams from a plain object, as the addon's read_params builds them:
   * every enumerable key, numbers, booleans and strings kept, anything else
   * skipped, more than sixteen refused. The caller frees the result.
   */
  function params(object, str) {
    if (object !== undefined && object !== null && typeof object !== 'object') {
      throw new TypeError('params must be an object');
    }
    const p = w.cvw_params_new();
    let count = 0;
    try {
      // eslint-disable-next-line guard-for-in -- napi_get_property_names is for...in
      for (const key in object ?? {}) {
        const value = object[key];
        const kind = typeof value;
        if (kind !== 'number' && kind !== 'boolean' && kind !== 'string') continue;
        if (count >= PARAMS_MAX) throw new RangeError('too many parameters');
        const name = str(key);
        if (kind === 'number') w.cvw_params_number(p, name, value);
        else if (kind === 'boolean') w.cvw_params_bool(p, name, value ? 1 : 0);
        else w.cvw_params_string(p, name, str(value));
        count++;
      }
    } catch (err) {
      w.cvw_params_free(p);
      throw err;
    }
    return p;
  }
  const withParams = (object, fn) => scratch((alloc, str) => {
    const p = params(object, str);
    try { return fn(p, alloc, str); } finally { w.cvw_params_free(p); }
  });

  const kernels = new Map();
  for (let i = 0; i < w.cvw_kernel_count(); i++) {
    kernels.set(cstring(w.cvw_kernel_name(i)), {
      index: i, inputs: w.cvw_kernel_inputs(i), producesBuffer: w.cvw_kernel_produces_buffer(i) === 1,
    });
  }

  function typedArrayKind(values) {
    if (values instanceof Float32Array) return 'f32';
    if (values instanceof Int32Array) return 'i32';
    return 'other';
  }

  /** The addon's checks, for the demo pair that inverts RGBA in place. */
  function rgbaPixels(pixels) {
    if (!ArrayBuffer.isView(pixels) || pixels instanceof DataView) {
      throw new TypeError('expected a Uint8ClampedArray of RGBA pixels');
    }
    if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)) {
      throw new TypeError('expected a Uint8ClampedArray or Uint8Array');
    }
    if (pixels.length === 0 || pixels.length % 4 !== 0) {
      throw new RangeError('pixel length must be a non-zero multiple of 4 (RGBA)');
    }
    return pixels;
  }
  function invertRgba(pixels) {
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 255 - pixels[i];
      pixels[i + 1] = 255 - pixels[i + 1];
      pixels[i + 2] = 255 - pixels[i + 2];
    }
  }

  return {
    backend: 'wasm',
    build,

    /* No thread pool here: the promise is for the addon's signature. */
    invert(pixels) {
      if (arguments.length < 1) throw new TypeError('invert(pixels) requires 1 argument');
      invertRgba(rgbaPixels(pixels));
      return Promise.resolve();
    },
    invertSync(pixels) {
      if (arguments.length < 1) throw new TypeError('invertSync(pixels) requires 1 argument');
      invertRgba(rgbaPixels(pixels));
      return undefined;
    },

    createBuffer(spec) {
      if (arguments.length < 1) throw new Error('createBuffer(spec) requires 1 argument');
      if (spec === null || typeof spec !== 'object') {
        throw new TypeError('createBuffer(spec): spec must be an object');
      }
      const num = (v, fallback) => {
        if (v === undefined || v === null) return fallback;
        if (typeof v !== 'number') throw new TypeError('width, height and channels must be numbers');
        return int64(v);
      };
      const str = (v, fallback) => {
        if (v === undefined || v === null) return fallback;
        if (typeof v !== 'string') throw new TypeError('dtype and space must be strings');
        return v;
      };
      const width = num(spec.width, -1), height = num(spec.height, -1), channels = num(spec.channels, 1);
      const dtype = DTYPES.indexOf(str(spec.dtype, 'f32'));
      const space = SPACES.indexOf(str(spec.space, 'none'));
      if (dtype < 0) throw new Error('unknown dtype (expected f32 or i32)');
      if (space < 0) throw new Error('unknown space (expected none, srgb or linear)');
      if (channels < -2147483648 || channels > 2147483647) throw new Error('channels out of range');
      const ptr = w.cvw_buffer_create(width, height, channels, dtype, space);
      if (ptr === 0) throw new RangeError(statusText(lastStatus()));
      return wrap(ptr);
    },

    bufferInfo(handle) {
      if (arguments.length < 1) throw new Error('bufferInfo(handle) requires 1 argument');
      const ptr = unwrap(handle);
      return {
        width: w.cvw_buffer_width(ptr),
        height: w.cvw_buffer_height(ptr),
        channels: w.cvw_buffer_channels(ptr),
        dtype: DTYPES[w.cvw_buffer_dtype(ptr)],
        space: SPACES[w.cvw_buffer_space(ptr)],
        bytes: w.cvw_buffer_bytes(ptr),
        elements: w.cvw_buffer_elements(ptr),
        live: live(ptr),
      };
    },

    bufferRead(handle) {
      if (arguments.length < 1) throw new Error('bufferRead(handle) requires 1 argument');
      const ptr = unwrap(handle);
      if (!live(ptr)) throw new Error('buffer has been released');
      const bytes = w.cvw_buffer_bytes(ptr);
      const copy = memory().slice(w.cvw_buffer_data(ptr), w.cvw_buffer_data(ptr) + bytes);
      return w.cvw_buffer_dtype(ptr) === 0 ? new Float32Array(copy) : new Int32Array(copy);
    },

    bufferWrite(handle, values) {
      if (arguments.length < 2) throw new Error('bufferWrite(handle, values) requires 2 arguments');
      const ptr = unwrap(handle);
      if (!live(ptr)) throw new Error('buffer has been released');
      if (!ArrayBuffer.isView(values) || values instanceof DataView) {
        throw new TypeError('bufferWrite: values must be a typed array');
      }
      if (typedArrayKind(values) !== DTYPES[w.cvw_buffer_dtype(ptr)]) {
        throw new TypeError('bufferWrite: typed array kind does not match the buffer dtype');
      }
      if (values.length !== w.cvw_buffer_elements(ptr)) {
        throw new RangeError('bufferWrite: length does not match the buffer element count');
      }
      u8().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), w.cvw_buffer_data(ptr));
      return undefined;
    },

    bufferRelease(handle) {
      if (arguments.length < 1) throw new Error('bufferRelease(handle) requires 1 argument');
      w.cvw_buffer_release(unwrap(handle));
      return undefined;
    },

    bufferFromRGBA8(pixels, width, height, opts) {
      if (arguments.length < 3) {
        throw new Error('bufferFromRGBA8(pixels, width, height, opts) requires 3 arguments');
      }
      if (!ArrayBuffer.isView(pixels) || pixels instanceof DataView) {
        throw new TypeError('bufferFromRGBA8: pixels must be a typed array');
      }
      if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)) {
        throw new TypeError('bufferFromRGBA8: pixels must be 8-bit');
      }
      if (typeof width !== 'number' || typeof height !== 'number') {
        throw new TypeError('bufferFromRGBA8: width and height must be numbers');
      }
      const as = typeof opts?.as === 'string' ? opts.as : 'srgb';
      const from = typeof opts?.from === 'string' ? opts.from : 'srgb';
      if (!['srgb', 'linear'].includes(as) || !['srgb', 'linear'].includes(from)) {
        throw new Error('bufferFromRGBA8: `as` and `from` must be "srgb" or "linear"');
      }
      return scratch((alloc) => {
        const p = alloc(pixels.length);
        u8().set(pixels, p);
        const ptr = w.cvw_buffer_from_rgba8(p, pixels.length, int64(width), int64(height),
          from === 'linear' ? 1 : 0, as === 'linear' ? 1 : 0);
        if (ptr === 0) {
          const status = lastStatus();
          if (statusText(status) === 'buffer size overflows') throw new Error('bufferFromRGBA8: dimensions overflow');
          if (statusText(status) === 'inputs must all have the same dimensions') {
            throw new RangeError('bufferFromRGBA8: pixel length does not match width * height * 4');
          }
          throw new RangeError(statusText(status));
        }
        return wrap(ptr);
      });
    },

    runKernel(name, inputs, object) {
      if (arguments.length < 2) throw new Error('runKernel(name, inputs, params) requires at least 2 arguments');
      if (typeof name !== 'string') throw new TypeError('runKernel: name must be a string');
      const entry = kernels.get(name);
      if (entry === undefined) throw new Error(`no kernel named "${name}"`);
      if (!Array.isArray(inputs)) throw new TypeError('runKernel: inputs must be an array');
      if (inputs.length !== entry.inputs) {
        throw new RangeError(`kernel "${name}" takes ${entry.inputs} input(s), got ${inputs.length}`);
      }
      if (inputs.length > 8) throw new Error('too many inputs');
      const ptrs_ = inputs.map((h) => {
        const ptr = unwrap(h, 'runKernel: inputs must be buffer handles');
        if (!live(ptr)) throw new Error('runKernel: an input buffer has been released');
        return ptr;
      });
      return withParams(arguments.length >= 3 ? object : undefined, (p, alloc) => {
        const list = alloc(4 * Math.max(1, ptrs_.length));
        new Int32Array(memory(), list, ptrs_.length).set(ptrs_);
        const scalars = alloc(8 * 5);
        const out = w.cvw_run_kernel(entry.index, list, ptrs_.length, p, scalars);
        const status = lastStatus();
        if (status !== 0) throw new Error(statusText(status));
        if (!entry.producesBuffer) {
          const [min, max, mean, stddev, count] = f64(scalars, 5);
          return { min, max, mean, stddev, count };
        }
        return wrap(out);
      });
    },

    kernelNames: () => [...kernels.keys()],

    renderTile(handle, spec) {
      if (arguments.length < 1) throw new Error('renderTile(handle, spec) requires a handle');
      const ptr = handleArg(handle);
      return withParams(arguments.length >= 2 ? spec : undefined, (p, alloc) => {
        const result = alloc(8 * 4);
        const tile = w.cvw_render_tile(ptr, p, result);
        if (tile === 0) {
          const status = lastStatus();
          if (statusText(status) === 'width and height must be between 1 and 1048576') {
            throw new Error('renderTile: width and height must be between 1 and 16384');
          }
          throw new Error(statusText(status));
        }
        const [width, height, lo, hi] = f64(result, 4);
        const pixels = new Uint8ClampedArray(memory().slice(tile, tile + width * height * 4));
        w.cvw_free(tile);
        return { pixels, width, height, lo, hi };
      });
    },

    histogram(handle, spec) {
      if (arguments.length < 1) throw new Error('histogram(handle, spec) requires a handle');
      const ptr = handleArg(handle);
      return withParams(arguments.length >= 2 ? spec : undefined, (p, alloc) => {
        const result = alloc(8 * 2);
        const bins = alloc(4);
        const counts = w.cvw_histogram(ptr, p, result, bins);
        if (counts === 0) {
          const status = lastStatus();
          if (statusText(status).startsWith('parameter out of range')) {
            throw new Error('histogram: bins must be between 2 and 4096');
          }
          throw new Error(statusText(status));
        }
        const n = i32at(bins);
        const [lo, hi] = f64(result, 2);
        const out = new Int32Array(memory().slice(counts, counts + n * 4));
        w.cvw_free(counts);
        return { counts: out, lo, hi };
      });
    },

    samplePixel(handle, x, y) {
      if (arguments.length < 3) throw new Error('samplePixel(handle, x, y) requires 3 arguments');
      const ptr = handleArg(handle);
      return scratch((alloc) => {
        const values = alloc(8 * 4);
        const n = w.cvw_sample(ptr, int64(x), int64(y), values);
        return n < 0 ? null : Array.from(f64(values, n));
      });
    },

    fitSegments(handle) {
      return fit('fitSegments', 'edge-segment', SEGMENT_KEYS, w.cvw_fit_segments, arguments.length, handle);
    },

    fitArcs(handle) {
      return fit('fitArcs', 'edge-arc', ARC_KEYS, w.cvw_fit_arcs, arguments.length, handle);
    },
  };

  function fit(fn, type, keys, call, argc, handle) {
    if (argc < 1) throw new Error(`${fn}(handle) requires a buffer handle`);
    const ptr = handleArg(handle);
    if (w.cvw_buffer_dtype(ptr) !== 1) throw new Error(`${fn}: expects an i32 label map`);
    if (w.cvw_buffer_channels(ptr) !== 1) throw new Error(`${fn}: expects 1 channel`);
    return scratch((alloc) => {
      const countPtr = alloc(4);
      const flat = call(ptr, countPtr);
      const status = lastStatus();
      if (status !== 0) throw new Error(statusText(status));
      const count = i32at(countPtr);
      if (flat === 0) return [];
      const values = f64(flat, count * keys.length);
      const list = [];
      for (let k = 0; k < count; k++) {
        const entry = { type };
        keys.forEach((key, j) => { entry[key] = values[k * keys.length + j]; });
        list.push(entry);
      }
      w.cvw_free(flat);
      return list;
    });
  }
}

/** The module this repository builds, compiled and instantiated. */
function load(file = WASM_FILE) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    throw new Error(`cv-lab-2: no WebAssembly module at ${file}. Run: npm run build:wasm\n  ${err.message}`);
  }
  const build = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  return instantiate(new WebAssembly.Module(bytes), { build });
}

module.exports = { instantiate, load, WASM_FILE };
