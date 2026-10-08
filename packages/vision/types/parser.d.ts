/**
 * Parse one statement.
 * @returns {{target: string|null, op: string, positional: Array, named: object}|null}
 *          null for a blank or comment-only line
 */
export function parseStatement(source: any, lineNumber?: number): {
    target: string | null;
    op: string;
    positional: any[];
    named: object;
} | null;
/**
 * Parse a whole script.
 * @returns {Array<{line:number, source:string, statement:object}>}
 */
export function parseScript(source: any): Array<{
    line: number;
    source: string;
    statement: object;
}>;
/**
 * Quote a value for the command language — the inverse of the string handling
 * in `tokenize`.
 *
 * Needed because `\` is an escape character here, so a Windows path pasted in
 * raw loses every separator: `C:\\Users\\me` parses as `C:Usersme`. Anything
 * building a command from a filesystem path must go through this.
 */
export function quoteString(value: any): string;
/**
 * The command language — design-lab-model.md §4.
 *
 *   B = gaussian(A, sigma=1.4)
 *   C = sobel(B, axis=mag)
 *   stats(C)
 *   // comments, so scripts document themselves
 *
 * Grammar, and nothing more:
 *
 *   statement := [ IDENT '=' ] IDENT '(' [ arg { ',' arg } ] ')'
 *   arg       := value | IDENT '=' value
 *   value     := IDENT | NUMBER | STRING | 'true' | 'false'
 *
 * Deliberately absent: control flow, arithmetic, user-defined functions,
 * variables that are not slots. §4 says that if loops are ever needed, embed a
 * real scripting engine rather than growing this into a language.
 */
export class ParseError extends Error {
    constructor(message: any, line: any, column: any, text: any);
    line: any;
    column: any;
    text: any;
}
