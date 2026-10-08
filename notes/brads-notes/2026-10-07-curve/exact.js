// degrade --scurve <k>'s exact inverse as a curve file, for load(curve=):
// separates what the measurement costs from what the load path does.
//   node exact.js <k> <out.json>
'use strict';
const fs = require('node:fs');
const k = Number(process.argv[2]);
const toLin = (e) => (e <= 0.04045 ? e / 12.92 : ((e + 0.055) / 1.055) ** 2.4);
const inv = (y) => 0.5 + Math.atanh(Math.max(-0.999999, Math.min(0.999999, (2 * y - 1) * Math.tanh(k / 2)))) / k;
fs.writeFileSync(process.argv[3], `${JSON.stringify({ kind: 'response', method: `exact inverse of degrade --scurve ${k}`, linear: Array.from({ length: 256 }, (_, z) => Math.max(0, toLin(inv(z / 255)))) }, null, 2)}\n`);
