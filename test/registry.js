'use strict';

/**
 * Operation registry tests — design-lab-model.md §3.
 *
 *   node test/registry.js
 */

const assert = require('node:assert/strict');
const {
  defineOp, resolveCall, formatCall, OpDefinitionError, CallError,
} = require('../src/lab/registry');
const { parseStatement } = require('../src/lab/parser');
const { createRegistry } = require('../src/lab/ops');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

const SOBEL = defineOp({
  name: 'sobel',
  version: 1,
  inputs: [{ name: 'src', channels: [1] }],
  params: [
    { name: 'axis', type: 'enum', values: ['x', 'y', 'mag'], default: 'mag' },
    { name: 'scale', type: 'number', default: 1, min: 0 },
    { name: 'preview', type: 'bool', default: false, semantic: false },
  ],
  output: { channels: 1, dtype: 'f32' },
});

const ref = (slot, version) => ({ slot, version });

console.log('cv-lab-2 registry tests');

/* --- the registry catches its own definition bugs --------------------- */

test('rejects a param with no default', () => {
  assert.throws(() => defineOp({
    name: 'x', version: 1, inputs: [], output: {},
    params: [{ name: 'k', type: 'number' }],
  }), OpDefinitionError);
});

test('rejects a default that violates its own constraints', () => {
  assert.throws(() => defineOp({
    name: 'x', version: 1, inputs: [], output: {},
    params: [{ name: 'k', type: 'number', default: -5, min: 0 }],
  }), /default is invalid/);
});

test('rejects an enum default outside its values', () => {
  assert.throws(() => defineOp({
    name: 'x', version: 1, inputs: [], output: {},
    params: [{ name: 'k', type: 'enum', values: ['a', 'b'], default: 'z' }],
  }), /default is invalid/);
});

test('rejects a bad name, version, dtype or duplicate param', () => {
  assert.throws(() => defineOp({ name: 'Not Valid', version: 1, inputs: [], output: {} }), /identifier/);
  assert.throws(() => defineOp({ name: 'x', version: 0, inputs: [], output: {} }), /integer/);
  assert.throws(() => defineOp({ name: 'x', version: 1, inputs: [], output: { dtype: 'u8' } }), /f32 or i32/);
  assert.throws(() => defineOp({
    name: 'x', version: 1, inputs: [], output: {},
    params: [{ name: 'k', type: 'bool', default: true }, { name: 'k', type: 'bool', default: true }],
  }), /duplicate/);
});

test('params are semantic unless explicitly opted out', () => {
  assert.equal(SOBEL.params.find((p) => p.name === 'axis').semantic, true);
  assert.equal(SOBEL.params.find((p) => p.name === 'preview').semantic, false);
});

/* --- resolving a call ------------------------------------------------- */

test('resolves defaults at record time', () => {
  const record = resolveCall(SOBEL, { inputs: [ref('B', 2)], params: {} });
  assert.deepEqual(record.params, { axis: 'mag', scale: 1 });
  assert.equal(formatCall(record), 'sobel(B#2, axis=mag, scale=1)');
});

test('a supplied value overrides the default', () => {
  const record = resolveCall(SOBEL, { inputs: [ref('B', 2)], params: { axis: 'x' } });
  assert.equal(record.params.axis, 'x');
});

test('incidental params are kept out of the record', () => {
  const record = resolveCall(SOBEL, { inputs: [ref('B', 2)], params: { preview: true } });
  assert.equal('preview' in record.params, false, 'preview leaked into the record');
  assert.equal(record.incidental.preview, true);
  // The whole point: toggling it must not change the hashed record.
  const plain = resolveCall(SOBEL, { inputs: [ref('B', 2)], params: {} });
  assert.deepEqual(record.params, plain.params);
  assert.equal(formatCall(record), formatCall(plain));
});

test('the record carries the op version', () => {
  assert.equal(resolveCall(SOBEL, { inputs: [ref('B', 2)], params: {} }).version, 1);
});

test('formatted commands parse back', () => {
  // The log renders the canonical form of a call. Rendering a path unquoted
  // made it display something the parser rejects: pasting a log line back
  // gave `unexpected character "/"`.
  const OP = defineOp({
    name: 'load', version: 1, inputs: [],
    params: [
      { name: 'path', type: 'string', default: '' },
      { name: 'as', type: 'enum', values: ['srgb', 'linear'], default: 'srgb' },
    ],
    output: { channels: 3, dtype: 'f32' },
  });
  for (const path of [
    '/Users/me/Downloads/ABC-x0.20-y1.00-z0.70.png',
    'C:\\Users\\me\\a b.png',
    'has "quotes".png',
    '',
  ]) {
    const text = formatCall(resolveCall(OP, { inputs: [], params: { path } }));
    const reparsed = parseStatement(`X = ${text}`);
    assert.equal(reparsed.named.path.value, path, `round trip failed for ${JSON.stringify(path)}`);
  }
});

test('identifier-like strings stay unquoted for readability', () => {
  const record = resolveCall(SOBEL, { inputs: [ref('B', 2)], params: { axis: 'x' } });
  assert.equal(formatCall(record), 'sobel(B#2, axis=x, scale=1)');
});

test('param order is canonical regardless of call order', () => {
  const a = resolveCall(SOBEL, { inputs: [ref('B', 2)], params: { scale: 2, axis: 'y' } });
  const b = resolveCall(SOBEL, { inputs: [ref('B', 2)], params: { axis: 'y', scale: 2 } });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

/* --- rejections ------------------------------------------------------- */

test('rejects an unknown parameter, and suggests a near match', () => {
  assert.throws(
    () => resolveCall(SOBEL, { inputs: [ref('B', 2)], params: { axes: 'x' } }),
    /no parameter "axes".*did you mean axis/s
  );
});

test('rejects an out-of-range number and a bad enum value', () => {
  assert.throws(() => resolveCall(SOBEL, { inputs: [ref('B', 2)], params: { scale: -1 } }), />= 0/);
  assert.throws(() => resolveCall(SOBEL, { inputs: [ref('B', 2)], params: { axis: 'z' } }), /one of x, y, mag/);
  assert.throws(() => resolveCall(SOBEL, { inputs: [ref('B', 2)], params: { scale: NaN } }), /finite/);
});

test('rejects the wrong number of inputs', () => {
  assert.throws(() => resolveCall(SOBEL, { inputs: [], params: {} }), /takes 1 input/);
  assert.throws(() => resolveCall(SOBEL, { inputs: [ref('A', 1), ref('B', 1)], params: {} }), /takes 1 input/);
});

test('rejects a bare slot name without a version', () => {
  assert.throws(
    () => resolveCall(SOBEL, { inputs: ['B'], params: {} }),
    /\{ slot, version \} reference/
  );
});

test('reports every problem, not just the first', () => {
  try {
    resolveCall(SOBEL, { inputs: [], params: { axis: 'z', nope: 1 } });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof CallError);
    assert.equal(err.problems.length, 3, `expected 3 problems, got ${err.problems.length}`);
  }
});

/* --- the real first-slice registry ------------------------------------ */

test('the first slice registers cleanly', () => {
  const r = createRegistry();
  assert.deepEqual(r.names(),
    ['gaussian', 'gray', 'hysteresis', 'load', 'nms', 'pattern', 'sobel', 'stats',
     'threshold', 'toLinear', 'toSrgb']);
});

test('load is unimplemented without a decoder, implemented with one', () => {
  // Chromium's decoder only exists in a renderer, so ops.js takes one by
  // injection rather than assuming it is there.
  assert.deepEqual(
    createRegistry().list().filter((op) => !op.implemented).map((op) => op.name),
    ['load']);
  assert.deepEqual(
    createRegistry({ decodeFile: async () => ({}) })
      .list().filter((op) => !op.implemented).map((op) => op.name),
    []);
});

test('unknown op names list what is available', () => {
  assert.throws(() => createRegistry().get('sobol'), /unknown operation "sobol".*gaussian/s);
});

test('ops declare the colour space they need', () => {
  const r = createRegistry();
  assert.equal(r.get('gray').inputs[0].space, 'linear', 'luminance needs linear');
  assert.equal(r.get('gaussian').inputs[0].space, 'linear', 'blur mixes light');
  assert.equal(r.get('threshold').inputs[0].space, 'any', 'ordering is space-invariant');
  assert.equal(r.get('sobel').inputs[0].space, 'any', 'different, not wrong');
});

test('threshold produces an i32 mask with no colour space', () => {
  const out = createRegistry().get('threshold').output;
  assert.equal(out.dtype, 'i32');
  assert.equal(out.space, 'none');
});

test('a definition is frozen', () => {
  assert.throws(() => { SOBEL.version = 99; }, TypeError);
});

console.log(failures === 0 ? '\nAll registry tests passed.' : `\n${failures} failing.`);
process.exit(failures === 0 ? 0 : 1);
