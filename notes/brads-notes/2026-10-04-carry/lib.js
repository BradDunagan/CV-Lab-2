'use strict';
// Rebuild the pipeline's G (gray, linear, f32) from a PNG in plain node.
const fs = require('fs'), zlib = require('zlib');
const LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) { const s = i / 255; LUT[i] = Math.fround(s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)); }
function decodePNG(file) {
  const b = fs.readFileSync(file);
  let p = 8, w, h, depth, ctype; const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8), d = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; if (d[12]) throw new Error('interlaced'); }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8) throw new Error('depth ' + depth);
  const ch = { 2: 3, 6: 4, 0: 1, 4: 2 }[ctype];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[y * stride + x - ch] : 0, up = y ? out[(y - 1) * stride + x] : 0, c = (x >= ch && y) ? out[(y - 1) * stride + x - ch] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? up : c); }
      out[y * stride + x] = v & 255;
    }
  }
  return { width: w, height: h, ch, data: out };
}
function grayOf(file) {
  const img = decodePNG(file); const n = img.width * img.height; const data = new Float32Array(n);
  for (let i = 0; i < n; i++) { const q = i * img.ch; const r = LUT[img.data[q]], g = LUT[img.data[q + 1]], bl = LUT[img.data[q + 2]]; data[i] = Math.fround(0.2126 * r + 0.7152 * g + 0.0722 * bl); }
  return { width: img.width, height: img.height, channels: 1, data };
}
const slot = (F, name) => F.find((s) => s.slot === name).features;
module.exports = { decodePNG, grayOf, slot };
