/**
 * The backend, from the module's bytes, or from a URL or Response to stream
 * them from (a browser: `loadWasm(new URL('@cv-lab/vision/cvlab.wasm', import.meta.url))`
 * or however its bundler names the file). `build` defaults to the bytes'
 * SHA-256, which a session records as what computed it.
 * @param {ArrayBuffer | ArrayBufferView | URL | Response | Promise<Response>} source
 * @param {{build?: string}} [identity]
 * @returns {Promise<import('./types.js').Backend>}
 */
export function loadWasm(source: ArrayBuffer | ArrayBufferView | URL | Response | Promise<Response>, { build }?: {
    build?: string;
}): Promise<import("./types.js").Backend>;
/**
 * The backend, from a compiled module. Synchronous: in Node, and in a browser
 * worker, `new WebAssembly.Module(bytes)` is fine at this size (~70 KB).
 * @param {WebAssembly.Module} module
 * @param {{build?: string}} [identity] the module file's SHA-256, for the
 *   session's environment record: what computed the results, exactly
 * @returns {import('./types.js').Backend}
 */
export function instantiate(module: WebAssembly.Module, { build }?: {
    build?: string;
}): import("./types.js").Backend;
