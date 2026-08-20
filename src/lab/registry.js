'use strict';

/**
 * The operation registry — design-lab-model.md §3.
 *
 * One entry per operation, and that entry is the single source of truth for:
 *
 *   - the operation dropdowns and their parameter forms
 *   - validation in the command parser, and its error messages
 *   - generated documentation
 *   - the shape of a provenance record
 *
 * Pure JavaScript with no Electron and no native dependency, so it can be
 * tested under plain node.
 */

const PARAM_TYPES = new Set(['number', 'int', 'bool', 'enum', 'string']);
const DTYPES = new Set(['f32', 'i32']);
const SPACES = new Set(['none', 'srgb', 'linear']);
/** `any` means the operation does not care; `same` means "as the input". */
const INPUT_SPACES = new Set(['any', 'srgb', 'linear']);

class OpDefinitionError extends Error {}
class CallError extends Error {
  constructor(message, problems) {
    super(message);
    this.problems = problems ?? [message];
  }
}

/* ------------------------------------------------------------------ */
/* defining an operation                                               */
/* ------------------------------------------------------------------ */

function requireField(spec, field, predicate, expected) {
  const value = spec[field];
  if (!predicate(value)) {
    throw new OpDefinitionError(
      `op "${spec.name ?? '?'}": ${field} ${expected} (got ${JSON.stringify(value)})`
    );
  }
  return value;
}

function checkParamSpec(opName, param) {
  const where = `op "${opName}" param "${param?.name ?? '?'}"`;
  if (!param || typeof param.name !== 'string' || !param.name) {
    throw new OpDefinitionError(`${where}: needs a name`);
  }
  if (!PARAM_TYPES.has(param.type)) {
    throw new OpDefinitionError(
      `${where}: type must be one of ${[...PARAM_TYPES].join(', ')}`
    );
  }
  if (param.type === 'enum') {
    if (!Array.isArray(param.values) || param.values.length === 0) {
      throw new OpDefinitionError(`${where}: enum needs a non-empty values array`);
    }
  }
  if (!('default' in param)) {
    throw new OpDefinitionError(
      `${where}: needs a default. Every parameter must be resolvable at record ` +
        `time, so a log entry stays meaningful when a default later changes.`
    );
  }
  // A bad default is a definition bug; catch it now rather than at call time.
  const problem = checkValue(param, param.default);
  if (problem) throw new OpDefinitionError(`${where}: default is invalid — ${problem}`);
}

/**
 * @param {object} spec
 * @returns {Readonly<object>} the frozen definition
 */
function defineOp(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new OpDefinitionError('defineOp(spec): spec must be an object');
  }
  requireField(spec, 'name', (v) => typeof v === 'string' && /^[a-z][a-zA-Z0-9_]*$/.test(v),
    'must be a lowerCamelCase identifier');
  requireField(spec, 'version', (v) => Number.isInteger(v) && v >= 1,
    'must be an integer >= 1');
  requireField(spec, 'inputs', (v) => Array.isArray(v), 'must be an array');
  requireField(spec, 'output', (v) => v && typeof v === 'object', 'must be an object');

  for (const input of spec.inputs) {
    if (!input || typeof input.name !== 'string') {
      throw new OpDefinitionError(`op "${spec.name}": each input needs a name`);
    }
    if (input.channels !== undefined &&
        !(Array.isArray(input.channels) && input.channels.every(Number.isInteger))) {
      throw new OpDefinitionError(
        `op "${spec.name}" input "${input.name}": channels must be an array of integers`
      );
    }
    const space = input.space ?? 'any';
    if (!INPUT_SPACES.has(space)) {
      throw new OpDefinitionError(
        `op "${spec.name}" input "${input.name}": space must be one of ${[...INPUT_SPACES].join(', ')}`
      );
    }
  }

  if (spec.output.dtype !== undefined && !DTYPES.has(spec.output.dtype)) {
    throw new OpDefinitionError(`op "${spec.name}": output.dtype must be f32 or i32`);
  }
  if (spec.output.space !== undefined &&
      !(SPACES.has(spec.output.space) || spec.output.space === 'same')) {
    throw new OpDefinitionError(
      `op "${spec.name}": output.space must be same, or one of ${[...SPACES].join(', ')}`
    );
  }

  const params = spec.params ?? [];
  const seen = new Set();
  for (const param of params) {
    checkParamSpec(spec.name, param);
    if (seen.has(param.name)) {
      throw new OpDefinitionError(`op "${spec.name}": duplicate param "${param.name}"`);
    }
    seen.add(param.name);
  }

  return Object.freeze({
    name: spec.name,
    version: spec.version,
    summary: spec.summary ?? '',
    inputs: Object.freeze(spec.inputs.map((i) =>
      Object.freeze({ ...i, space: i.space ?? 'any' }))),
    params: Object.freeze(params.map((p) =>
      // Semantic unless explicitly opted out: §3 makes opting out deliberate.
      Object.freeze({ ...p, semantic: p.semantic !== false }))),
    output: Object.freeze({ ...spec.output }),
    cancellable: spec.cancellable !== false,
    kernel: spec.kernel ?? null,
    implemented: typeof spec.kernel === 'function',
  });
}

/* ------------------------------------------------------------------ */
/* validating one supplied value against a param spec                  */
/* ------------------------------------------------------------------ */

/** @returns {string|null} a problem description, or null if the value is fine */
function checkValue(param, value) {
  switch (param.type) {
    case 'bool':
      return typeof value === 'boolean' ? null : 'expected true or false';
    case 'string':
      return typeof value === 'string' ? null : 'expected a string';
    case 'enum':
      return param.values.includes(value)
        ? null
        : `expected one of ${param.values.join(', ')}`;
    case 'int':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 'expected a finite number';
      }
      if (param.type === 'int' && !Number.isInteger(value)) {
        return 'expected an integer';
      }
      if (param.min !== undefined && value < param.min) {
        return `must be >= ${param.min}`;
      }
      if (param.max !== undefined && value > param.max) {
        return `must be <= ${param.max}`;
      }
      return null;
    }
    default:
      return `unknown param type ${param.type}`;
  }
}

/* ------------------------------------------------------------------ */
/* resolving a call into a provenance record                           */
/* ------------------------------------------------------------------ */

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
function resolveCall(op, call) {
  const problems = [];
  const inputs = call?.inputs ?? [];
  const supplied = call?.params ?? {};

  if (inputs.length !== op.inputs.length) {
    problems.push(
      `${op.name} takes ${op.inputs.length} input${op.inputs.length === 1 ? '' : 's'} ` +
        `(${op.inputs.map((i) => i.name).join(', ')}), got ${inputs.length}`
    );
  }
  for (const [index, ref] of inputs.entries()) {
    if (!ref || typeof ref.slot !== 'string' || !Number.isInteger(ref.version)) {
      problems.push(
        `${op.name} input ${index + 1}: expected a { slot, version } reference — ` +
          `bare slot names are ambiguous once a slot is reassigned`
      );
    }
  }

  const known = new Set(op.params.map((p) => p.name));
  for (const name of Object.keys(supplied)) {
    if (!known.has(name)) {
      const nearest = [...known].filter((k) => k.startsWith(name.slice(0, 2)));
      problems.push(
        `${op.name} has no parameter "${name}"` +
          (nearest.length ? ` — did you mean ${nearest.join(' or ')}?` : '')
      );
    }
  }

  const params = {};
  const incidental = {};
  for (const param of op.params) {
    const provided = Object.prototype.hasOwnProperty.call(supplied, param.name);
    const value = provided ? supplied[param.name] : param.default;
    const problem = provided ? checkValue(param, value) : null;
    if (problem) {
      problems.push(`${op.name} parameter "${param.name}": ${problem}`);
      continue;
    }
    // Semantic params go in the record and the cache key; incidental ones do
    // not, so toggling a preview flag never invalidates a result or perturbs
    // a hash comparison.
    (param.semantic ? params : incidental)[param.name] = value;
  }

  if (problems.length > 0) {
    throw new CallError(problems[0], problems);
  }

  return {
    op: op.name,
    version: op.version,
    inputs: inputs.map((r) => ({ slot: r.slot, version: r.version })),
    params: sortKeys(params),
    incidental: sortKeys(incidental),
  };
}

/** Canonical key order, so a record hashes identically however it was built. */
function sortKeys(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

/**
 * Render a record as the canonical command text used in the log.
 * `sobel(B#2, axis=mag)` — always with defaults present.
 */
function formatCall(record) {
  const args = [
    ...record.inputs.map((r) => `${r.slot}#${r.version}`),
    ...Object.entries(record.params).map(([k, v]) => `${k}=${formatValue(v)}`),
  ];
  return `${record.op}(${args.join(', ')})`;
}

function formatValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/* ------------------------------------------------------------------ */
/* the registry itself                                                 */
/* ------------------------------------------------------------------ */

class Registry {
  constructor() {
    this._ops = new Map();
  }

  register(spec) {
    const op = spec && spec.name && Object.isFrozen(spec) ? spec : defineOp(spec);
    if (this._ops.has(op.name)) {
      throw new OpDefinitionError(`op "${op.name}" is already registered`);
    }
    this._ops.set(op.name, op);
    return op;
  }

  has(name) { return this._ops.has(name); }

  /** @throws {CallError} with a listing when the name is unknown */
  get(name) {
    const op = this._ops.get(name);
    if (!op) {
      throw new CallError(
        `unknown operation "${name}" — known: ${this.names().join(', ')}`
      );
    }
    return op;
  }

  names() { return [...this._ops.keys()].sort(); }
  list() { return this.names().map((n) => this._ops.get(n)); }

  /** Convenience: look up and resolve in one step. */
  resolve(name, call) { return resolveCall(this.get(name), call); }

  /** Generated documentation — §3's fourth job for the registry. */
  describe(name) {
    const op = this.get(name);
    const args = [
      ...op.inputs.map((i) => i.name),
      ...op.params.map((p) => `${p.name}=${formatValue(p.default)}`),
    ];
    const lines = [`${op.name}(${args.join(', ')})  [v${op.version}]`];
    if (op.summary) lines.push(`  ${op.summary}`);
    if (!op.implemented) lines.push('  (declared, no kernel yet)');
    for (const p of op.params) {
      const bits = [p.type];
      if (p.type === 'enum') bits.push(p.values.join('|'));
      if (p.min !== undefined) bits.push(`min ${p.min}`);
      if (p.max !== undefined) bits.push(`max ${p.max}`);
      if (!p.semantic) bits.push('not recorded');
      lines.push(`  ${p.name}: ${bits.join(', ')} (default ${formatValue(p.default)})`);
    }
    return lines.join('\n');
  }
}

module.exports = {
  Registry,
  defineOp,
  resolveCall,
  formatCall,
  checkValue,
  OpDefinitionError,
  CallError,
  PARAM_TYPES,
};
