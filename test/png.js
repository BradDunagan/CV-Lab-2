'use strict';

/**
 * PNG colour-chunk reading — how a file declares what its samples mean.
 *
 * Pure JavaScript, no addon and no Electron.
 *
 *   node test/png.js
 */

const assert = require('node:assert/strict');
const { encodePNG, decodePNG, readPngColour } = require('../scripts/png');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

/* --- fixtures ---------------------------------------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const BASE = encodePNG(1, 1, Buffer.from([128, 128, 128, 255]));
const AFTER_IHDR = 8 + 25; // signature + IHDR

/** Insert chunks between IHDR and IDAT, where colour chunks belong. */
const withChunks = (...cs) =>
  Buffer.concat([BASE.subarray(0, AFTER_IHDR), ...cs, BASE.subarray(AFTER_IHDR)]);

const gama = (value) => {
  const d = Buffer.alloc(4);
  d.writeUInt32BE(value);
  return chunk('gAMA', d);
};

console.log('cv-lab-2 png colour-chunk tests');

/* --- the common case --------------------------------------------------- */

test('a file with no colour chunks is undeclared', () => {
  const result = readPngColour(BASE);
  assert.equal(result.declared, 'undeclared');
  assert.deepEqual(result.chunks, ['IHDR']);
});

test('our own encoder writes no colour chunks', () => {
  // Worth pinning: everything this project generates is undeclared, so the
  // sRGB convention is what gives those files meaning.
  assert.equal(readPngColour(encodePNG(2, 2, Buffer.alloc(16, 200))).declared, 'undeclared');
});

/* --- gAMA -------------------------------------------------------------- */

test('gAMA 1.0 means LINEAR samples', () => {
  // The case that matters: treating these as sRGB applies a curve that was
  // never there.
  const r = readPngColour(withChunks(gama(100000)));
  assert.equal(r.declared, 'linear');
  assert.match(r.detail, /gamma 1\.0/);
});

test('gAMA 1/2.2 means sRGB-ish samples', () => {
  assert.equal(readPngColour(withChunks(gama(45455))).declared, 'srgb');
});

test('a gAMA that is neither is reported rather than guessed at', () => {
  const r = readPngColour(withChunks(gama(50000)));
  assert.equal(r.declared, 'icc', 'an unusual gamma should not be forced into srgb or linear');
  assert.match(r.detail, /0\.5000/);
});

test('gAMA close to a landmark still counts', () => {
  assert.equal(readPngColour(withChunks(gama(45454))).declared, 'srgb');
  assert.equal(readPngColour(withChunks(gama(100100))).declared, 'linear');
});

/* --- the other three declarations -------------------------------------- */

test('an sRGB chunk declares sRGB', () => {
  const r = readPngColour(withChunks(chunk('sRGB', Buffer.from([0]))));
  assert.equal(r.declared, 'srgb');
  assert.match(r.detail, /sRGB chunk/);
});

test('an embedded ICC profile is reported, not interpreted', () => {
  // Parsing an ICC transfer curve is out of scope; saying "there is one" is
  // honest, guessing sRGB would not be.
  const payload = Buffer.concat([Buffer.from('Display P3\0\0', 'latin1'), Buffer.alloc(8)]);
  const r = readPngColour(withChunks(chunk('iCCP', payload)));
  assert.equal(r.declared, 'icc');
  assert.match(r.detail, /Display P3/);
});

test('cICP transfer characteristics are recognised', () => {
  const cicp = (transfer) => chunk('cICP', Buffer.from([1, transfer, 0, 1]));
  assert.equal(readPngColour(withChunks(cicp(8))).declared, 'linear', 'H.273 transfer 8 is linear');
  assert.equal(readPngColour(withChunks(cicp(13))).declared, 'srgb', 'H.273 transfer 13 is sRGB');
  assert.equal(readPngColour(withChunks(cicp(16))).declared, 'icc', 'PQ is neither');
});

/* --- precedence -------------------------------------------------------- */

test('precedence follows the specification', () => {
  // cICP over iCCP over sRGB over gAMA. A contradictory file must resolve
  // deterministically rather than depending on chunk order.
  const icc = chunk('iCCP', Buffer.from('p\0\0', 'latin1'));
  const srgb = chunk('sRGB', Buffer.from([0]));
  const cicp = chunk('cICP', Buffer.from([1, 8, 0, 1]));

  assert.equal(readPngColour(withChunks(gama(100000), srgb)).declared, 'srgb',
    'sRGB chunk beats a contradictory gAMA');
  assert.equal(readPngColour(withChunks(srgb, icc)).declared, 'icc',
    'iCCP beats the sRGB chunk');
  assert.equal(readPngColour(withChunks(icc, cicp)).declared, 'linear',
    'cICP beats iCCP');
});

test('chunk order in the file does not change the answer', () => {
  const a = readPngColour(withChunks(gama(100000), chunk('sRGB', Buffer.from([0]))));
  const b = readPngColour(withChunks(chunk('sRGB', Buffer.from([0])), gama(100000)));
  assert.equal(a.declared, b.declared);
});

/* --- robustness -------------------------------------------------------- */

test('non-PNG input is undeclared rather than an error', () => {
  assert.equal(readPngColour(Buffer.from([1, 2, 3])).declared, 'undeclared');
  assert.equal(readPngColour(Buffer.alloc(0)).declared, 'undeclared');
  assert.equal(readPngColour(Buffer.from('GIF89a not a png')).declared, 'undeclared');
});

test('a truncated file does not run off the end', () => {
  for (const cut of [10, 20, 33, 40, BASE.length - 1]) {
    const r = readPngColour(BASE.subarray(0, cut));
    assert.ok(typeof r.declared === 'string', `crashed or returned nothing at ${cut} bytes`);
  }
});

test('a chunk claiming an absurd length is ignored', () => {
  const bad = Buffer.alloc(12);
  bad.writeUInt32BE(0x7fffffff, 0);
  bad.write('gAMA', 4, 'ascii');
  const r = readPngColour(Buffer.concat([BASE.subarray(0, AFTER_IHDR), bad]));
  assert.equal(r.declared, 'undeclared');
});

test('it stops at IDAT rather than scanning the whole file', () => {
  // Colour chunks precede the image data, so a large file costs nothing.
  const big = encodePNG(256, 256, Buffer.alloc(256 * 256 * 4, 120));
  const started = process.hrtime.bigint();
  readPngColour(big);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 2, `took ${ms.toFixed(2)} ms — is it walking the pixel data?`);
});

/* --- decoding ---------------------------------------------------------- */

test('what the encoder writes, the decoder reads back exactly', () => {
  const rgba = Buffer.alloc(7 * 5 * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + 11) & 255;
  const d = decodePNG(encodePNG(7, 5, rgba));
  assert.deepEqual([d.width, d.height, d.channels], [7, 5, 4]);
  assert.ok(d.data.equals(rgba));
});

test('every filter type is undone, as the specification defines it', () => {
  // The encoder writes filter 0 only; a renderer's file uses all five. Each
  // row here is filtered with type y % 5, by the definitions in the spec.
  const w = 6, h = 10, ch = 3, stride = w * ch;
  const px = Buffer.alloc(h * stride);
  for (let i = 0; i < px.length; i++) px[i] = (i * 73 + (i >> 3) * 29) & 255;
  const at = (y, x) => (y < 0 || x < 0 ? 0 : px[y * stride + x]);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    const f = y % 5;
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const v = at(y, x), a = at(y, x - ch), b = at(y - 1, x), c = at(y - 1, x - ch);
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f];
      raw[y * (stride + 1) + 1 + x] = (v - pred) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const file = Buffer.concat([BASE.subarray(0, 8), chunk('IHDR', ihdr),
    chunk('IDAT', require('node:zlib').deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const d = decodePNG(file);
  assert.equal(d.channels, 3);
  assert.ok(d.data.equals(px));
});

console.log(failures === 0 ? '\nAll png tests passed.' : `\n${failures} failing.`);
process.exit(failures === 0 ? 0 : 1);
