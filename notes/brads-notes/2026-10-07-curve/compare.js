// A measured curve against degrade --scurve <k>'s exact inverse, scale removed:
// the log ratio about its mean over codes 16-239, and at a few codes.
//   node compare.js <curve.json> <k>
'use strict';
const fs = require('node:fs');
const [file, k] = [process.argv[2], Number(process.argv[3])];
const { linear } = JSON.parse(fs.readFileSync(file, 'utf8'));
const toLin = (e) => (e <= 0.04045 ? e / 12.92 : ((e + 0.055) / 1.055) ** 2.4);
const truth = (z) => toLin(0.5 + Math.atanh(Math.max(-0.999999, Math.min(0.999999, (2 * z / 255 - 1) * Math.tanh(k / 2)))) / k);
const codes = []; for (let z = 16; z < 240; z++) codes.push(z);
const lr = (z) => Math.log(linear[z] / truth(z));
const mean = codes.reduce((a, z) => a + lr(z), 0) / codes.length;
const dev = codes.map((z) => Math.abs(lr(z) - mean));
const rms = Math.sqrt(codes.reduce((a, z) => a + (lr(z) - mean) ** 2, 0) / codes.length);
console.log(`${file}: rms ${(100 * rms).toFixed(2)}%, worst ${(100 * Math.max(...dev)).toFixed(2)}% (codes 16-239); at 4/32/128/224/250: ${[4, 32, 128, 224, 250].map((z) => (100 * (lr(z) - mean)).toFixed(1)).join(' / ')}%`);
