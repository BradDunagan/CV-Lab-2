/**
 * An opaque handle to a buffer the backend owns. Only the backend that
 * made it can read it.
 */
export type BufferHandle = object;
export type BufferInfo = {
    width: number;
    height: number;
    channels: number;
    dtype: "f32" | "i32";
    space: "none" | "srgb" | "linear";
    bytes: number;
    elements: number;
    /**
     * false once released
     */
    live: boolean;
};
/**
 * The C kernels behind one interface: the WebAssembly module (`loadWasm`)
 * or, in cv-lab, the Node-API addon. Both give the same results to the bit;
 * test/determinism.js holds them to the same hashes.
 */
export type Backend = {
    backend: "wasm" | "native";
    /**
     * the module's SHA-256; undefined for the addon
     */
    build: string | undefined;
    createBuffer: (spec: {
        width: number;
        height: number;
        channels?: number;
        dtype?: "f32" | "i32";
        space?: "none" | "srgb" | "linear";
    }) => BufferHandle;
    bufferInfo: (handle: BufferHandle) => BufferInfo;
    /**
     * a copy
     */
    bufferRead: (handle: BufferHandle) => Float32Array | Int32Array;
    bufferWrite: (handle: BufferHandle, values: Float32Array | Int32Array) => void;
    /**
     * SHA-256 of the bytes, hex
     */
    bufferHash: (handle: BufferHandle) => string;
    bufferRelease: (handle: BufferHandle) => void;
    bufferFromRGBA8: (pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, opts?: {
        from?: "srgb" | "linear";
        as?: "srgb" | "linear";
    }) => BufferHandle;
    runKernel: (name: string, inputs: BufferHandle[], params?: Record<string, number | boolean | string>) => BufferHandle | {
        min: number;
        max: number;
        mean: number;
        stddev: number;
        count: number;
    };
    kernelNames: () => string[];
    renderTile: (handle: BufferHandle, spec?: object) => {
        pixels: Uint8ClampedArray;
        width: number;
        height: number;
        lo: number;
        hi: number;
    };
    histogram: (handle: BufferHandle, spec?: object) => {
        counts: Int32Array;
        lo: number;
        hi: number;
    };
    samplePixel: (handle: BufferHandle, x: number, y: number) => number[] | null;
    fitSegments: (handle: BufferHandle) => object[];
    fitArcs: (handle: BufferHandle) => object[];
};
/**
 * A decoded image, as a host's decoder returns it for `load`: 8-bit RGBA.
 */
export type DecodedImage = {
    width: number;
    height: number;
    pixels: Uint8Array | Uint8ClampedArray;
    /**
     * what the file says its encoding is
     */
    declared?: string | undefined;
    detail?: string | undefined;
};
/**
 * A float frame, as a host's `readFrame` returns it for `frame`: linear
 * light, rows top-down, samples interleaved. RGBA's alpha is dropped.
 */
export type Frame = {
    width: number;
    height: number;
    /**
     * 3 or 4 (a PFM file may say 1, which `frame` refuses)
     */
    channels: number;
    data: Float32Array;
};
/**
 * What a host passes to `createRegistry`. Nothing is required to build a
 * registry; running a kernel needs a backend, `load` a decoder, `frame` a
 * frame reader, and `load(curve=)` and `groundTruth` a text reader.
 */
export type HostOptions = {
    backend?: Backend | undefined;
    decodeFile?: ((path: string) => Promise<DecodedImage>) | undefined;
    readFrame?: ((source: string) => Promise<Frame>) | undefined;
    readTextFile?: ((path: string) => Promise<string>) | undefined;
};
