'use strict';

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

class ParseError extends Error {
  constructor(message, line, column, text) {
    super(`line ${line}:${column}: ${message}`);
    this.line = line;
    this.column = column;
    this.text = text;
  }
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

function tokenize(source, lineNumber) {
  const tokens = [];
  let i = 0;

  const fail = (msg, at = i) => { throw new ParseError(msg, lineNumber, at + 1, source); };

  while (i < source.length) {
    const ch = source[i];

    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }

    if (ch === '/' && source[i + 1] === '/') break; // comment to end of line

    if ('=(),'.includes(ch)) {
      tokens.push({ kind: ch, column: i + 1 });
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      let value = '';
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          const next = source[i + 1];
          if (next === undefined) fail('unterminated escape', i);
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
        } else {
          value += source[i];
          i++;
        }
      }
      if (i >= source.length) fail('unterminated string', start);
      i++; // closing quote
      tokens.push({ kind: 'string', value, column: start + 1 });
      continue;
    }

    if (DIGIT.test(ch) || (ch === '-' && DIGIT.test(source[i + 1] ?? ''))) {
      const start = i;
      if (ch === '-') i++;
      while (i < source.length && DIGIT.test(source[i])) i++;
      if (source[i] === '.') { i++; while (i < source.length && DIGIT.test(source[i])) i++; }
      if (source[i] === 'e' || source[i] === 'E') {
        i++;
        if (source[i] === '+' || source[i] === '-') i++;
        if (!DIGIT.test(source[i] ?? '')) fail('malformed exponent', start);
        while (i < source.length && DIGIT.test(source[i])) i++;
      }
      const text = source.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) fail(`malformed number "${text}"`, start);
      tokens.push({ kind: 'number', value, column: start + 1 });
      continue;
    }

    if (IDENT_START.test(ch)) {
      const start = i;
      while (i < source.length && IDENT_CHAR.test(source[i])) i++;
      tokens.push({ kind: 'ident', value: source.slice(start, i), column: start + 1 });
      continue;
    }

    fail(`unexpected character "${ch}"`);
  }

  return tokens;
}

/**
 * Parse one statement.
 * @returns {{target: string|null, op: string, positional: Array, named: object}|null}
 *          null for a blank or comment-only line
 */
function parseStatement(source, lineNumber = 1) {
  const tokens = tokenize(source, lineNumber);
  if (tokens.length === 0) return null;

  let pos = 0;
  const peek = (offset = 0) => tokens[pos + offset];
  const fail = (msg, token) =>
    { throw new ParseError(msg, lineNumber, token ? token.column : source.length + 1, source); };

  const expect = (kind, what) => {
    const token = peek();
    if (!token || token.kind !== kind) fail(`expected ${what}`, token);
    pos++;
    return token;
  };

  let target = null;
  if (peek()?.kind === 'ident' && peek(1)?.kind === '=' && peek(2)?.kind === 'ident'
      && peek(3)?.kind === '(') {
    target = expect('ident', 'a slot name').value;
    pos++; // '='
  }

  const opToken = peek();
  if (!opToken || opToken.kind !== 'ident') fail('expected an operation name', opToken);
  pos++;
  const op = opToken.value;

  expect('(', '"(" after the operation name');

  const positional = [];
  const named = {};
  const namedSeen = new Set();

  if (peek()?.kind !== ')') {
    for (;;) {
      const token = peek();
      if (!token) fail('unterminated argument list');

      // key=value
      if (token.kind === 'ident' && peek(1)?.kind === '=') {
        const key = token.value;
        pos += 2;
        const valueToken = peek();
        if (!valueToken) fail('expected a value after "="');
        const value = readValue(valueToken, fail);
        pos++;
        if (namedSeen.has(key)) fail(`parameter "${key}" given twice`, token);
        namedSeen.add(key);
        named[key] = value;
      } else {
        if (namedSeen.size > 0) {
          fail('positional arguments must come before named ones', token);
        }
        positional.push(readValue(token, fail));
        pos++;
      }

      if (peek()?.kind === ',') { pos++; continue; }
      break;
    }
  }

  expect(')', '")" to close the argument list');
  if (pos !== tokens.length) fail('unexpected trailing input', peek());

  return { target, op, positional, named };
}

function readValue(token, fail) {
  switch (token.kind) {
    case 'number': return { kind: 'number', value: token.value };
    case 'string': return { kind: 'string', value: token.value };
    case 'ident':
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      // Bare identifiers are slot names in input position and enum values in
      // parameter position. The registry decides which, since it knows the op.
      return { kind: 'ident', value: token.value };
    default:
      return fail('expected a value', token);
  }
}

/**
 * Parse a whole script.
 * @returns {Array<{line:number, source:string, statement:object}>}
 */
function parseScript(source) {
  const out = [];
  const lines = String(source).split(/\r?\n/);
  for (const [index, text] of lines.entries()) {
    const statement = parseStatement(text, index + 1);
    if (statement) out.push({ line: index + 1, source: text.trim(), statement });
  }
  return out;
}

module.exports = { parseStatement, parseScript, ParseError };
