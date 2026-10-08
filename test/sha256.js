'use strict';

/**
 * The vision package's SHA-256 (packages/vision/src/sha256.js) against
 * node:crypto: what a session hashes feature lists and scalars with, so it
 * must give node:crypto's answer for every input, or every pinned hash in
 * test/determinism.js moves. Lengths round the 55/56/64-byte padding
 * boundaries, and text that is not ASCII, since it hashes UTF-8.
 *
 *   node test/sha256.js
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { sha256 } = require('../packages/vision/src/sha256.js');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

const reference = (input) => crypto.createHash('sha256').update(input).digest('hex');

console.log('cv-lab-2 SHA-256 tests');

test('the FIPS 180-4 examples', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('every length from 0 to 300 bytes, as node:crypto', () => {
  for (let n = 0; n <= 300; n++) {
    const s = Array.from({ length: n }, (_, i) => String.fromCharCode(32 + ((i * 37 + n) % 95))).join('');
    assert.equal(sha256(s), reference(s), `length ${n}`);
  }
});

test('UTF-8, and bytes given as bytes', () => {
  for (const s of ['Δx = 0.5 mm', '±180°', 'naïve — “quoted”', '🦀'.repeat(40)]) assert.equal(sha256(s), reference(s), s);
  const bytes = crypto.randomBytes(100000);
  assert.equal(sha256(new Uint8Array(bytes)), reference(bytes));
});

test('a feature list as the session writes it', () => {
  const canonical = JSON.stringify([[['angle', 12.345678901234567], ['id', 3], ['x0', -0.1]]]);
  assert.equal(sha256(canonical), reference(canonical));
});

console.log(failures === 0 ? '\nAll SHA-256 tests passed.' : `\n${failures} failing.`);
process.exit(failures === 0 ? 0 : 1);
