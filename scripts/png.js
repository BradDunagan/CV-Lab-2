'use strict';

/**
 * A minimal PNG encoder, so the project stays dependency-free.
 *
 * Shared by scripts/make-sample.js and test/renderer.js — the latter needs to
 * produce a fixture whose exact pixel values it can then assert on after a
 * round trip through Chromium's decoder.
 */

const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Buffer|Uint8Array} rgba width*height*4 bytes, 8 bits per channel
 * @returns {Buffer} a complete PNG
 */
function encodePNG(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePNG: expected ${width * height * 4} bytes, got ${rgba.length}`);
  }

  // Raw scanlines: one filter byte (0 = none) followed by the row's pixels.
  const raw = Buffer.alloc(height * (1 + width * 4));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let i = 0; i < width * 4; i++) raw[p++] = rgba[y * width * 4 + i];
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // bytes 10-12: compression, filter, interlace — all 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { encodePNG };
