// A run at k times the exposure, made from its float frames rather than
// rendered again: the frame times k IS that render (the same samples), and
// its PNG is that frame clipped at 1 and sRGB-encoded to 8 bits, as pt-lab's
// canvas would have written it (2026-10-08: pt-lab's own PNGs match this
// encoding of their float frames in 99.86% of samples, the rest by 1 code).
//   node brighter.mjs <generated/run> <generated/new> <k>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { encodePNG } = require('../../../scripts/png.js');
const { decodePfm, encodePfm } = await import('../../../packages/vision/src/pfm.js');
const [from, to, k] = [process.argv[2], process.argv[3], Number(process.argv[4])];
if (!(k > 0) || fs.existsSync(to)) throw new Error('usage: brighter.mjs <run> <new run, not existing> <k>');
fs.cpSync(from, to, { recursive: true });
const enc = (v) => { v = Math.min(1, Math.max(0, v)); return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)); };
let clipped = 0, total = 0;
for (const name of fs.readdirSync(to).filter((n) => n.endsWith('.pfm'))) {
  const f = decodePfm(fs.readFileSync(path.join(to, name)));
  const data = f.data.map((v) => v * k);
  const rgba = new Uint8Array(f.width * f.height * 4);
  for (let i = 0; i < f.width * f.height; i++) {
    let c = false;
    for (let j = 0; j < 3; j++) { rgba[i * 4 + j] = enc(data[i * 3 + j]); c ||= data[i * 3 + j] > 1; }
    rgba[i * 4 + 3] = 255; clipped += c; total++;
  }
  fs.writeFileSync(path.join(to, name), encodePfm({ ...f, data }));
  fs.writeFileSync(path.join(to, name.replace(/\.pfm$/, '.png')), encodePNG(f.width, f.height, rgba));
  const gt = path.join(to, name.replace(/\.pfm$/, '.gt.json'));
  const doc = JSON.parse(fs.readFileSync(gt, 'utf8'));
  doc.toneMapping = { ...doc.toneMapping, exposure: doc.toneMapping.exposure * k, madeBy: `brighter.mjs x${k} from ${from}` };
  fs.writeFileSync(gt, JSON.stringify(doc, null, 2));
}
console.log(`${to}: x${k}, ${(100 * clipped / total).toFixed(1)}% of pixels clipped in the PNG`);
