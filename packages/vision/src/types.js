/**
 * The contract between the vision package and its host, as types: what a
 * compute backend provides, and what a host passes to `createRegistry`.
 * Declarations only; `npm run build:types` turns these into
 * types/types.d.ts for TypeScript hosts such as rr.
 */

/**
 * An opaque handle to a buffer the backend owns. Only the backend that
 * made it can read it.
 * @typedef {object} BufferHandle
 */

/**
 * @typedef {object} BufferInfo
 * @property {number} width
 * @property {number} height
 * @property {number} channels
 * @property {'f32' | 'i32'} dtype
 * @property {'none' | 'srgb' | 'linear'} space
 * @property {number} bytes
 * @property {number} elements
 * @property {boolean} live  false once released
 */

/**
 * The C kernels behind one interface: the WebAssembly module (`loadWasm`)
 * or, in cv-lab, the Node-API addon. Both give the same results to the bit;
 * test/determinism.js holds them to the same hashes.
 * @typedef {object} Backend
 * @property {'wasm' | 'native'} backend
 * @property {string | undefined} build  the module's SHA-256; undefined for the addon
 * @property {(spec: {width: number, height: number, channels?: number, dtype?: 'f32' | 'i32', space?: 'none' | 'srgb' | 'linear'}) => BufferHandle} createBuffer
 * @property {(handle: BufferHandle) => BufferInfo} bufferInfo
 * @property {(handle: BufferHandle) => Float32Array | Int32Array} bufferRead  a copy
 * @property {(handle: BufferHandle, values: Float32Array | Int32Array) => void} bufferWrite
 * @property {(handle: BufferHandle) => string} bufferHash  SHA-256 of the bytes, hex
 * @property {(handle: BufferHandle) => void} bufferRelease
 * @property {(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, opts?: {from?: 'srgb' | 'linear', as?: 'srgb' | 'linear'}) => BufferHandle} bufferFromRGBA8
 * @property {(name: string, inputs: BufferHandle[], params?: Record<string, number | boolean | string>) => BufferHandle | {min: number, max: number, mean: number, stddev: number, count: number}} runKernel
 * @property {() => string[]} kernelNames
 * @property {(handle: BufferHandle, spec?: object) => {pixels: Uint8ClampedArray, width: number, height: number, lo: number, hi: number}} renderTile
 * @property {(handle: BufferHandle, spec?: object) => {counts: Int32Array, lo: number, hi: number}} histogram
 * @property {(handle: BufferHandle, x: number, y: number) => number[] | null} samplePixel
 * @property {(handle: BufferHandle) => object[]} fitSegments
 * @property {(handle: BufferHandle) => object[]} fitArcs
 */

/**
 * A decoded image, as a host's decoder returns it for `load`: 8-bit RGBA.
 * @typedef {object} DecodedImage
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array | Uint8ClampedArray} pixels
 * @property {string} [declared]  what the file says its encoding is
 * @property {string} [detail]
 */

/**
 * A float frame, as a host's `readFrame` returns it for `frame`: linear
 * light, rows top-down, samples interleaved. RGBA's alpha is dropped.
 * @typedef {object} Frame
 * @property {number} width
 * @property {number} height
 * @property {number} channels  3 or 4 (a PFM file may say 1, which `frame` refuses)
 * @property {Float32Array} data
 */

/**
 * What a host passes to `createRegistry`. Nothing is required to build a
 * registry; running a kernel needs a backend, `load` a decoder, `frame` a
 * frame reader, and `load(curve=)` and `groundTruth` a text reader.
 * @typedef {object} HostOptions
 * @property {Backend} [backend]
 * @property {(path: string) => Promise<DecodedImage>} [decodeFile]
 * @property {(source: string) => Promise<Frame>} [readFrame]
 * @property {(path: string) => Promise<string>} [readTextFile]
 */

export {};
