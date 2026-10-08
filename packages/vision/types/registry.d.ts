export class Registry {
    _ops: Map<any, any>;
    register(spec: any): any;
    has(name: any): boolean;
    /** @throws {CallError} with a listing when the name is unknown */
    get(name: any): any;
    names(): any[];
    list(): any[];
    /** Convenience: look up and resolve in one step. */
    resolve(name: any, call: any): {
        op: string;
        version: number;
        inputs: any[];
        params: object;
        incidental: object;
    };
    /** Generated documentation — §3's fourth job for the registry. */
    describe(name: any): string;
}
/**
 * @param {object} spec
 * @returns {Readonly<object>} the frozen definition
 */
export function defineOp(spec: object): Readonly<object>;
/**
 * Validate a call and produce the canonical record for the log.
 *
 * Defaults are resolved here, deliberately. §3: the user types `sobel(B)` and
 * the log must store `sobel(B#2, axis=mag)`, so that changing a default later
 * cannot silently alter what an old session replays as.
 *
 * @param {object} op        a definition from defineOp
 * @param {object} call      { inputs: [{slot, version}], params: {...} }
 * @returns {{op:string, version:number, inputs:Array, params:object, incidental:object}}
 */
export function resolveCall(op: object, call: object): {
    op: string;
    version: number;
    inputs: any[];
    params: object;
    incidental: object;
};
/**
 * Map the parser's positional and named arguments onto an op's shape.
 *
 * Positional arguments fill the declared inputs first, then the declared
 * params in order. So `load("a.png")` puts the string into `path` because
 * load has no inputs, while `sobel(B, x)` puts B into `src` and "x" into
 * `axis`.
 *
 * @returns {{inputSlots: string[], params: object}} slot NAMES, not refs --
 *          only the session knows which version each name currently binds to.
 */
export function bindArgs(op: any, positional?: any[], named?: {}): {
    inputSlots: string[];
    params: object;
};
/**
 * Render a record as the canonical command text used in the log.
 * `sobel(B#2, axis=mag)` — always with defaults present.
 */
export function formatCall(record: any): string;
/** @returns {string|null} a problem description, or null if the value is fine */
export function checkValue(param: any, value: any): string | null;
export class OpDefinitionError extends Error {
}
export class CallError extends Error {
    constructor(message: any, problems: any);
    problems: any;
}
export const PARAM_TYPES: Set<string>;
