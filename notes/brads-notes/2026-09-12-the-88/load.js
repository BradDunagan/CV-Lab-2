'use strict';

// Load one generated view the way `npm run lab` and `explain` see it, in plain
// node: the .features.json slots, the .gt.json, and the three AOV passes
// decoded to the same rasters the `explain` operation builds. 01-the-88.js
// checks that claim by reproducing every stored `explain` record.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const REPO = path.resolve(__dirname, '../../..');
const OUT = path.join(__dirname, 'out');
const VIEWS = ['p0-l0', 'p0-l1', 'p1-l0', 'p1-l1', 'p2-l0', 'p2-l1'];
const SET = 'helmet-256';

/** 8-bit non-interlaced RGBA only -- what pt-lab writes. Same decoder as scripts/overlay.js. */
function decodePNG(file) {
  const bytes = fs.readFileSync(file);
  let offset = 8, width = 0, height = 0, bitDepth = 0, colourType = 0;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colourType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (bitDepth !== 8 || colourType !== 6) throw new Error(`${file}: bit depth ${bitDepth}, colour type ${colourType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
      let v = line[x];
      if (filter === 1) v += a; else if (filter === 2) v += b; else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, px };
}

function toFloat(png) {
  const data = new Float32Array(png.px.length);
  for (let i = 0; i < data.length; i++) data[i] = png.px[i] / 255;
  return { width: png.width, height: png.height, channels: 4, data };
}

function loadView(name, set = SET) {
  const gen = path.join(REPO, 'generated', set);
  const gt = JSON.parse(fs.readFileSync(path.join(gen, `${name}.gt.json`), 'utf8'));
  const slots = new Map(JSON.parse(fs.readFileSync(path.join(REPO, 'results', set, `${name}.features.json`), 'utf8'))
    .map((e) => [e.slot, e.features]));
  // The same unpacking as the `explain` operation in src/lab/ops.js.
  const packed = toFloat(decodePNG(path.join(gen, 'aov', `${name}-depth.png`)));
  const metres = new Float32Array(packed.width * packed.height);
  for (let i = 0, p = 0; i < metres.length; i++, p += 4) {
    metres[i] = (packed.data[p] + packed.data[p + 1] / 255 + packed.data[p + 2] / 65025) * gt.maxDepth;
  }
  return {
    name, gt, slots,
    beauty: decodePNG(path.join(gen, `${name}.png`)),
    rasters: {
      depth: { width: packed.width, height: packed.height, channels: 1, data: metres },
      normal: toFloat(decodePNG(path.join(gen, 'aov', `${name}-normal.png`))),
      albedo: toFloat(decodePNG(path.join(gen, 'aov', `${name}-albedo.png`))),
      camera: gt.camera,
    },
  };
}

/** A segment turned 90 degrees about its midpoint: the control used throughout. */
function rotated(f) {
  const mx = (f.x0 + f.x1) / 2, my = (f.y0 + f.y1) / 2, hx = (f.x1 - f.x0) / 2, hy = (f.y1 - f.y0) / 2;
  return { ...f, x0: mx + hy, y0: my - hx, x1: mx - hy, y1: my + hx, angle: (f.angle + 90) % 180 };
}

/** The records match and explain wrote for one view, keyed by detected segment id. */
function verdicts(v) {
  return {
    EF: new Map(v.slots.get('EF').map((e) => [e.id, e])),
    MF: new Map(v.slots.get('MF').filter((r) => r.detected !== null).map((r) => [r.detected, r])),
  };
}

/** Population label used by every table: the 88 by tier once classified, else role + cause. */
function group(r) {
  if (r.tier) return `the88 ${r.tier}`;
  return `${r.role === 'hit' ? 'matched ' : 'invented'} ${r.cause}`;
}

function quantile(xs, p) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor(p * (s.length - 1))] : NaN;
}

/** The median as the session analysis took it: the upper middle for an even count. */
function mid(xs) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
}

function write(name, value) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(value));
}

function read(name) {
  const file = path.join(OUT, name);
  if (!fs.existsSync(file)) throw new Error(`${file} is missing -- run the earlier scripts first (see README.md)`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = { REPO, OUT, VIEWS, SET, decodePNG, loadView, rotated, verdicts, group, quantile, mid, write, read };
