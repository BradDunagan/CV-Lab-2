/**
 * Every operation, bound to the host's backend, decoder and reader.
 * @param {import('./types.js').HostOptions} [options]
 * @returns {import('./registry.js').Registry & {backend: import('./types.js').Backend | null}}
 */
export function createRegistry(options?: import("./types.js").HostOptions): import("./registry.js").Registry & {
    backend: import("./types.js").Backend | null;
};
/** @param {import('./types.js').HostOptions} [options] */
export function buildOps({ backend: given, decodeFile, readTextFile }?: import("./types.js").HostOptions): object[];
