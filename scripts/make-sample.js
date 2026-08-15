#!/usr/bin/env node
'use strict';

/**
 * Writes assets/sample.png -- a large gradient image, big enough that the
 * difference between the sync and async buttons is obvious.
 *
 *   node scripts/make-sample.js [megapixels]
 *
 * Hand-rolled PNG encoder so the project stays dependency-free.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const megapixels = Number(process.argv[2]) || 12;
const width = Math.round(Math.sqrt(megapixels * 1e6 * 1.5));
const height = Math.round((width * 2) / 3);

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

// Raw scanlines: one filter byte (0 = none) followed by RGBA pixels.
const raw = Buffer.alloc(height * (1 + width * 4));
let p = 0;
for (let y = 0; y < height; y++) {
  raw[p++] = 0;
  for (let x = 0; x < width; x++) {
    const u = x / width;
    const v = y / height;
    const rings = Math.sin(Math.hypot(u - 0.5, v - 0.5) * 42) * 0.5 + 0.5;
    raw[p++] = Math.round(255 * u);
    raw[p++] = Math.round(255 * v);
    raw[p++] = Math.round(255 * rings);
    raw[p++] = 255;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
// bytes 10-12: compression, filter, interlace -- all 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'sample.png');
fs.writeFileSync(outFile, png);

console.log(
  `Wrote ${outFile} — ${width}×${height} (${((width * height) / 1e6).toFixed(1)} MP, ${(png.length / 1e6).toFixed(1)} MB)`
);
