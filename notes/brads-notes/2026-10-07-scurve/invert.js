// A degraded run with its S-curve undone, as a load that knew the curve
// would: every 8-bit value through the exact inverse, written back as 8 bits.
//   node invert.js <k> generated/<run> generated/<new-run>
'use strict';
const fs = require('node:fs'), path = require('node:path');
const { encodePNG, decodePNG } = require('../../../scripts/png');
const [k, src, dst] = [Number(process.argv[2]), process.argv[3], process.argv[4]];
const t = Math.tanh(k / 2);
const inv = (e) => 0.5 + Math.atanh(Math.max(-0.999999, Math.min(0.999999, (2 * e - 1) * t))) / k;
const lut = Array.from({ length: 256 }, (_, u) => Math.max(0, Math.min(255, Math.round(inv(u / 255) * 255))));
fs.cpSync(src, dst, { recursive: true });
for (const f of fs.readdirSync(dst)) {
  if (!f.endsWith('.png')) continue;
  const img = decodePNG(fs.readFileSync(path.join(dst, f)));
  const n = img.channels, out = Buffer.alloc(img.width * img.height * 4);
  for (let i = 0; i < img.width * img.height; i++) {
    for (let c = 0; c < 3; c++) out[i * 4 + c] = lut[img.data[i * n + Math.min(c, n - 1)]];
    out[i * 4 + 3] = n === 4 ? img.data[i * n + 3] : 255;
  }
  fs.writeFileSync(path.join(dst, f), encodePNG(img.width, img.height, out));
}
