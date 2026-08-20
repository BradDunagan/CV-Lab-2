'use strict';

/**
 * Parser, session log and provenance — design-lab-model.md §4–5.
 *
 * Uses fake JS kernels, so it needs no native addon: the point here is the
 * log and the provenance graph, not the pixels.
 *
 *   node test/session.js
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { parseStatement, parseScript, ParseError } = require('../src/lab/parser');
const { Registry, defineOp } = require('../src/lab/registry');
const { Session, SessionError } = require('../src/lab/session');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

/* --- a toy world: buffers are just arrays of numbers ------------------ */

const fakeBuffers = {
  describe: (h) => ({ width: h.values.length, height: 1, channels: 1, dtype: 'f32', space: h.space }),
  hash: (h) => crypto.createHash('sha256').update(Buffer.from(Float32Array.from(h.values).buffer)).digest('hex'),
  release: () => {},
};

function buildRegistry() {
  const r = new Registry();
  r.register(defineOp({
    name: 'ramp', version: 1, inputs: [],
    params: [{ name: 'n', type: 'int', default: 4, min: 1 }],
    output: { channels: 1, dtype: 'f32' },
    kernel: ({ params }) => ({
      kind: 'buffer',
      handle: { values: Array.from({ length: params.n }, (_, i) => i), space: 'linear' },
    }),
  }));
  r.register(defineOp({
    name: 'scale', version: 1, inputs: [{ name: 'src' }],
    params: [
      { name: 'by', type: 'number', default: 2 },
      { name: 'preview', type: 'bool', default: false, semantic: false },
    ],
    output: { channels: 1, dtype: 'f32' },
    kernel: ({ inputs, params }) => ({
      kind: 'buffer',
      handle: { values: inputs[0].handle.values.map((v) => v * params.by), space: inputs[0].handle.space },
    }),
  }));
  r.register(defineOp({
    name: 'add', version: 1, inputs: [{ name: 'a' }, { name: 'b' }],
    params: [], output: { channels: 1, dtype: 'f32' },
    kernel: ({ inputs }) => ({
      kind: 'buffer',
      handle: {
        values: inputs[0].handle.values.map((v, i) => v + inputs[1].handle.values[i]),
        space: 'linear',
      },
    }),
  }));
  r.register(defineOp({
    name: 'total', version: 1, inputs: [{ name: 'src' }], params: [],
    output: { kind: 'scalars' },
    kernel: ({ inputs }) => ({
      kind: 'scalars',
      values: { sum: inputs[0].handle.values.reduce((a, b) => a + b, 0) },
    }),
  }));
  return r;
}

const newSession = () => new Session({ registry: buildRegistry(), buffers: fakeBuffers });

console.log('cv-lab-2 parser + session tests');

/* --- parser ----------------------------------------------------------- */

test('parses assignment, args, named params and comments', () => {
  assert.deepEqual(parseStatement('B = scale(A, by=1.5)'), {
    target: 'B', op: 'scale',
    positional: [{ kind: 'ident', value: 'A' }],
    named: { by: { kind: 'number', value: 1.5 } },
  });
  assert.equal(parseStatement('  // nothing here'), null);
  assert.equal(parseStatement('   '), null);
  assert.equal(parseStatement('total(A) // trailing').op, 'total');
});

test('parses numbers, strings, booleans', () => {
  const s = parseStatement('x = op(-1.5e2, "a,b", true, false)');
  assert.deepEqual(s.positional.map((p) => p.value), [-150, 'a,b', true, false]);
});

test('reports line and column on a syntax error', () => {
  try { parseStatement('B = scale(A,', 7); assert.fail('should throw'); }
  catch (err) {
    assert.ok(err instanceof ParseError);
    assert.equal(err.line, 7);
    assert.match(err.message, /line 7:/);
  }
});

test('rejects positional after named, and a repeated parameter', () => {
  assert.throws(() => parseStatement('B = scale(by=2, A)'), /positional arguments must come before/);
  assert.throws(() => parseStatement('B = scale(A, by=1, by=2)'), /given twice/);
});

test('parseScript keeps line numbers and skips blanks', () => {
  const parsed = parseScript('A = ramp()\n\n// comment\nB = scale(A)');
  assert.deepEqual(parsed.map((p) => p.line), [1, 4]);
});

/* --- execution and the log -------------------------------------------- */

test('executes and appends a canonical entry', () => {
  const s = newSession();
  const entry = s.execute('A = ramp(n=3)');
  assert.equal(entry.n, 1);
  assert.equal(entry.text, 'ramp(n=3)');
  assert.deepEqual(entry.produced, { slot: 'A', version: 1 });
  assert.equal(entry.output.kind, 'buffer');
  assert.match(entry.output.hash, /^[0-9a-f]{64}$/);
});

test('defaults appear in the log even when not typed', () => {
  const s = newSession();
  s.execute('A = ramp()');
  assert.equal(s.entry(1).text, 'ramp(n=4)', 'default was not resolved into the record');
});

test('an incidental param does not change the recorded text or hash', () => {
  const a = newSession(); a.execute('A = ramp()'); a.execute('B = scale(A)');
  const b = newSession(); b.execute('A = ramp()'); b.execute('B = scale(A, preview=true)');
  assert.equal(a.entry(2).text, b.entry(2).text);
  assert.equal(a.entry(2).output.hash, b.entry(2).output.hash);
});

test('reassignment appends a version rather than mutating', () => {
  const s = newSession();
  s.execute('A = ramp(n=3)');
  s.execute('A = scale(A, by=10)');
  assert.equal(s.versionOf('A'), 2);
  // The entry that produced A#2 consumed A#1 -- names move, history does not.
  assert.deepEqual(s.entry(2).record.inputs, [{ slot: 'A', version: 1 }]);
  assert.deepEqual(s.entry(2).produced, { slot: 'A', version: 2 });
});

test('unknown slots and unknown ops are refused', () => {
  const s = newSession();
  assert.throws(() => s.execute('B = scale(Q)'), /unknown slot "Q"/);
  assert.throws(() => s.execute('B = nope(A)'), /unknown operation/);
});

test('a buffer op needs a target; a scalar op must not have one', () => {
  const s = newSession();
  s.execute('A = ramp()');
  assert.throws(() => s.execute('ramp()'), /needs a target/);
  assert.throws(() => s.execute('X = total(A)'), /cannot be assigned/);
});

test('a declared-but-unimplemented op is refused', () => {
  const { createRegistry } = require('../src/lab/ops');
  const s = new Session({ registry: createRegistry(), buffers: fakeBuffers });
  assert.throws(() => s.execute('A = load("x.png")'), /no kernel yet/);
});

test('scalars are recorded and hashed too', () => {
  const s = newSession();
  s.execute('A = ramp(n=4)');
  const entry = s.execute('total(A)');
  assert.equal(entry.produced, null);
  assert.deepEqual(entry.output.values, { sum: 6 });
  assert.match(entry.output.hash, /^[0-9a-f]{64}$/);
});

/* --- the provenance DAG ----------------------------------------------- */

function diamond() {
  // A ─┬─► B ─► C ─┐
  //    └────────────┴─► D     (D reaches A by two routes)
  const s = newSession();
  s.run(`
    A = ramp(n=4)
    B = scale(A, by=2)
    C = scale(B, by=3)
    D = add(A, C)
  `);
  return s;
}

test('ancestry is transitive and de-duplicated', () => {
  const s = diamond();
  assert.deepEqual(s.ancestry(4), [1, 2, 3, 4]);
  assert.deepEqual(s.ancestry(2), [1, 2]);
  assert.deepEqual(s.ancestry(1), [1]);
});

test('a slot reached by two routes appears once, not twice', () => {
  const s = diamond();
  const ancestors = s.ancestry(4);
  assert.equal(new Set(ancestors).size, ancestors.length, 'duplicate entries in ancestry');
});

test('consumers read the graph forwards', () => {
  const s = diamond();
  assert.deepEqual(s.consumers('A', 1), [2, 4], 'A#1 feeds both B and D');
  assert.deepEqual(s.consumers('C', 1), [4]);
  assert.deepEqual(s.consumers('D', 1), []);
});

test('provenanceOf returns entries, oldest first', () => {
  const s = diamond();
  assert.deepEqual(s.provenanceOf('D').map((e) => e.text),
    ['ramp(n=4)', 'scale(A#1, by=2)', 'scale(B#1, by=3)', 'add(A#1, C#1)']);
});

test('log entries are frozen', () => {
  const s = newSession();
  const entry = s.execute('A = ramp()');
  assert.throws(() => { entry.n = 99; }, TypeError);
});

/* --- persistence and replay ------------------------------------------- */

test('a session round-trips through JSON', () => {
  const saved = diamond().toJSON();
  assert.equal(saved.format, 'cv-lab-2/session');
  assert.equal(saved.entries.length, 4);
  assert.equal(saved.entries[3].text, 'add(A#1, C#1)');
});

test('replay reproduces every hash', () => {
  const saved = diamond().toJSON();
  const { mismatches, entries } = Session.replay(saved,
    { registry: buildRegistry(), buffers: fakeBuffers });
  assert.equal(entries.length, 4);
  assert.deepEqual(mismatches, [], 'replay did not reproduce the original hashes');
});

test('replay reports a kernel whose behaviour changed', () => {
  const saved = diamond().toJSON();
  const altered = buildRegistry();
  // Simulate an edited kernel that was not version-bumped.
  const scale = altered.get('scale');
  const broken = { ...scale, kernel: ({ inputs, params }) => ({
    kind: 'buffer',
    handle: { values: inputs[0].handle.values.map((v) => v * params.by + 1), space: 'linear' },
  }) };
  altered._ops.set('scale', Object.freeze(broken));

  const { mismatches } = Session.replay(saved, { registry: altered, buffers: fakeBuffers });
  assert.equal(mismatches.length, 3, 'expected the changed entry and everything downstream');
  assert.equal(mismatches[0].n, 2);
  assert.notEqual(mismatches[0].expected, mismatches[0].actual);
});

test('format() renders a readable log', () => {
  const text = diamond().format();
  assert.match(text, /#1 {2}A#1 ← ramp\(n=4\)/);
  assert.match(text, /#4 {2}D#1 ← add\(A#1, C#1\)/);
  assert.match(text, /sha256:[0-9a-f]{8}…/);
});

console.log(failures === 0 ? '\nAll session tests passed.' : `\n${failures} failing.`);
process.exit(failures === 0 ? 0 : 1);
