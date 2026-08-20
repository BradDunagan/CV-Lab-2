#!/usr/bin/env node
'use strict';

/**
 * Writes assets/sample.png -- a large gradient image, big enough that the
 * difference between the sync and async buttons is obvious.
 *
 *   node scripts/make-sample.js [megapixels]
 *
 * PNG encoding lives in scripts/png.js, shared with test/renderer.js.
 */

const fs = require('node:fs');
const path = require('node:path');

const { encodePNG } = require('./png');

const megapixels = Number(process.argv[2]) || 12;
const width = Math.round(Math.sqrt(megapixels * 1e6 * 1.5));
const height = Math.round((width * 2) / 3);

// Raw scanlines: one filter byte (0 = none) followed by RGBA pixels.
const rgba = Buffer.alloc(width * height * 4);
let p = 0;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const u = x / width;
    const v = y / height;
    const rings = Math.sin(Math.hypot(u - 0.5, v - 0.5) * 42) * 0.5 + 0.5;
    rgba[p++] = Math.round(255 * u);
    rgba[p++] = Math.round(255 * v);
    rgba[p++] = Math.round(255 * rings);
    rgba[p++] = 255;
  }
}

const png = encodePNG(width, height, rgba);

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'sample.png');
fs.writeFileSync(outFile, png);

console.log(
  `Wrote ${outFile} — ${width}×${height} (${((width * height) / 1e6).toFixed(1)} MP, ${(png.length / 1e6).toFixed(1)} MB)`
);
