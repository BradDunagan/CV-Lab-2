export class Session {
    /**
     * Re-execute a saved session and compare hashes.
     *
     * This is what makes reproducibility assertable rather than aspirational:
     * a kernel change that altered results announces itself here.
     *
     * @returns {{entries:Array, mismatches:Array}}
     */
    static replay(saved: any, options: any): {
        entries: any[];
        mismatches: any[];
    };
    /**
     * @param {object} options
     * @param {import('./registry.js').Registry} options.registry
     * @param {object} [options.buffers] adapter: { describe, hash, release }
     * @param {object} [options.environment] recorded once per session (§5)
     */
    constructor({ registry, buffers, environment }?: {
        registry: import("./registry.js").Registry;
        buffers?: object | undefined;
        environment?: object | undefined;
    });
    registry: import("./registry.js").Registry;
    buffers: object;
    environment: object;
    /** @type {Map<string, {version:number, value:object}>} name -> binding */
    slots: Map<string, {
        version: number;
        value: object;
    }>;
    /** @type {Array<object>} the append-only log */
    log: Array<object>;
    /** @type {Map<string, number>} "A#1" -> entry number that produced it */
    _producedBy: Map<string, number>;
    /** @type {Map<string, number[]>} "A#1" -> entry numbers that consumed it */
    _consumedBy: Map<string, number[]>;
    /**
     * Parse, validate, execute, and append one log entry.
     *
     * Awaitable because kernels will move onto libuv's thread pool so the UI
     * cannot block (§3). They are synchronous today; making the CONTRACT async
     * now means that change touches only the kernel binding, not every caller.
     *
     * @param {string} source one statement of the command language
     */
    execute(source: string): Promise<{
        n: number;
        source: string;
        text: string;
        record: any;
        output: any;
        produced: null;
    } | null>;
    executeStatement(statement: any, source?: string): Promise<{
        n: number;
        source: string;
        text: string;
        record: any;
        output: any;
        produced: null;
    }>;
    /**
     * The execution core, shared by live execution and replay.
     *
     * Replay comes through here with a record read from a file rather than one
     * just built from typed text. That is deliberate: the record is what is
     * authoritative, not `entry.text`. The text carries versioned refs like
     * `A#1` for the reader's benefit and is not itself re-parseable.
     */
    _apply(op: any, record: any, target: any, source?: string): Promise<{
        n: number;
        source: string;
        text: string;
        record: any;
        output: any;
        produced: null;
    }>;
    /**
     * Enforce the KIND an operation declares it needs.
     *
     * Declaring `kind: 'features'` on an input is not enough on its own -- the
     * same lesson as the colour space check below, which was declared in the
     * registry and enforced nowhere for one commit while `gray` quietly computed
     * luma and called it luminance.
     */
    _checkInputKind(op: any, index: any, ref: any, value: any): void;
    /**
     * Enforce the colour space an operation declares it needs (§2).
     *
     * Declaring it in the registry is not enough on its own: without this check
     * `gray` will happily apply luminance coefficients to sRGB-encoded values
     * and produce luma while calling it luminance — silently wrong output rather
     * than an error, which is precisely the failure §2 exists to prevent.
     *
     * `none` satisfies any requirement. A gradient or a mask is not a colour, so
     * the linear-versus-sRGB question does not apply to it.
     */
    _checkSpace(op: any, index: any, ref: any, value: any): void;
    _describeResult(result: any, outputKind: any): any;
    /** Run a whole script, stopping at the first failure. */
    run(script: any): Promise<{
        n: number;
        source: string;
        text: string;
        record: any;
        output: any;
        produced: null;
    }[]>;
    entry(n: any): object;
    /** Current version of a slot, or null. */
    versionOf(slot: any): number | null;
    /**
     * Backward: every entry this one transitively depends on, including itself.
     * A DAG walk, not a tree walk — a node can be reached by several routes, so
     * `seen` is what keeps this terminating and linear.
     * @returns {number[]} entry numbers, ascending
     */
    ancestry(n: any): number[];
    /** Forward: entries that consumed a particular slot version. */
    consumers(slot: any, version: any): number[];
    /** Human-readable provenance for the current binding of a slot. */
    provenanceOf(slot: any): object[];
    toJSON(): {
        format: string;
        formatVersion: number;
        environment: object;
        entries: {
            n: any;
            text: any;
            target: any;
            record: any;
            output: any;
        }[];
    };
    /**
     * Discard every slot and the whole log, freeing buffer memory immediately.
     *
     * Deliberately destructive and deliberately not an operation: it cannot go
     * in the log, because it destroys the log. Callers holding anything worth
     * keeping should save first.
     *
     * @returns {{entries:number, slots:number}} what was discarded
     */
    reset(): {
        entries: number;
        slots: number;
    };
    /** The log as the user sees it, one line per entry. */
    format(): string;
}
export class SessionError extends Error {
}
/**
 * Hashing and buffer inspection are injected so the session is testable
 * without a backend. The default adapter is the registry's backend: the
 * addon or the WebAssembly module, which hash a buffer in C where its bytes
 * are (`bufferHash`), so nothing is copied out to be hashed.
 */
export function backendAdapter(backend: any): {
    describe(handle: any): {
        width: any;
        height: any;
        channels: any;
        dtype: any;
        space: any;
    };
    hash(handle: any): any;
    release(handle: any): void;
};
export function hashScalars(values: any): string;
/**
 * Hash a feature list.
 *
 * Every field of every record, with keys SORTED rather than taken in whatever
 * order the producer happened to build the object in — so the hash describes
 * the geometry and not the construction, and cannot depend on insertion order.
 *
 * Sorted rather than a fixed key list, and that is a correction: the first
 * version listed the fields of a line segment, so when corner records arrived
 * with different fields entirely, every one of them hashed on `id` and `angle`
 * alone. Two completely different sets of corners produced the same hash, which
 * is worse than having no hash, because a matching hash is supposed to mean
 * matching results. A hardcoded list silently drops whatever it was not written
 * for; sorting the keys cannot.
 *
 * Numbers go in at full precision: rounding would hide real changes, which is
 * the opposite of the point.
 */
export function hashFeatures(features: any, meta: any): string;
