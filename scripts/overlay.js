#!/usr/bin/env node
'use strict';

/**
 * Draw the ground truth and what the pipeline found on top of the image.
 *
 *   npm run overlay -- generated/p0-l0.png results/ overlays/
 *
 * This exists because of a lesson that has now cost this project twice. The
 * black-and-white square hid a transfer function; pt-lab's default HDR scene
 * put two thirds of a segment count into the background, and the note for the
 * day it was found says the moral plainly: **a fixture nobody has looked at is
 * not a fixture.** A scoring table has exactly the same problem. It will
 * report 65% recall whether the matcher is right or subtly, plausibly wrong,
 * and nothing in the number says which.
 *
 * Both of the real defects in the ground-truth work were found by looking at
 * one of these rather than by reading a table:
 *
 *   - a visibility tolerance "fixed" against a degenerate view, which made the
 *     measurement strictly worse on every other view
 *   - recall asked per detection instead of per ground-truth edge, so one
 *     fitted segment lying along twelve facets of a ball's silhouette marked
 *     one found and eleven missed
 *
 * It writes a PNG rather than opening a window, so it works over ssh, in CI,
 * and in a terminal.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { encodePNG } = require('./png');
// The same threshold the matcher scores with, so the picture and the tally
// cannot disagree about which edges were findable.
const { MIN_VISIBLE } = require('../src/lab/match');

const USAGE = `
cv-lab-2 overlay

  npm run overlay -- <image.png> <results-dir> [out-dir] [options]

  <image.png>       a beauty render; its ground truth is <image>.gt.json beside it
  <results-dir>     where 'npm run lab -- --out' wrote <name>.features.json
  [out-dir]         where to write <name>.overlay.png   (default: beside the image)

  --scale <n>       pixels per source pixel             (default 3)
  --dim <f>         how far to fade the photograph      (default 0.55)
  --min-angle <d>   ground-truth vertices below this are bends, not corners
                    (default 30 — must match what 'match' was given)

  white / grey      ground-truth edges: visible / hidden
  green / red       detected segments:  matched to geometry / not
  blue rings        ground-truth corners that a detector is answerable for
  yellow / red dots detected corners:   matched / invented
`.trim();

/* ------------------------------------------------------------------ */
/* PNG in                                                              */
/* ------------------------------------------------------------------ */

/**
 * Decode an 8-bit RGBA PNG.
 *
 * Deliberately narrow: this reads what pt-lab writes and nothing else. The
 * general case is what Chromium's decoder is for (design-lab-model.md §11),
 * and that only exists in a renderer — which this script is not, because
 * needing Electron to look at a picture would defeat the point.
 */
function decodePNG(file) {
  const bytes = fs.readFileSync(file);
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || SIG.some((b, i) => bytes[i] !== b)) {
    throw new Error(`${file} is not a PNG`);
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8 || colourType !== 6 || interlace !== 0) {
    throw new Error(
      `${file}: only 8-bit non-interlaced RGBA is supported here ` +
      `(got bit depth ${bitDepth}, colour type ${colourType}` +
      `${interlace ? ', interlaced' : ''})`
    );
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(height * stride);
  // The five PNG filters, undone in place. Each byte predicts from its left
  // neighbour (a), the byte above (b) and the one above-left (c).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw new Error(`${file}: unknown PNG filter ${filter} on row ${y}`);
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, px };
}

/* ------------------------------------------------------------------ */
/* drawing                                                             */
/* ------------------------------------------------------------------ */

const COLOURS = {
  truthVisible: [255, 255, 255],
  truthHidden: [130, 130, 130],
  matched: [80, 255, 120],
  unmatched: [255, 70, 70],
  truthCorner: [110, 170, 255],
  matchedCorner: [255, 220, 60],
};

function makeCanvas(src, scale, dim) {
  const width = src.width * scale;
  const height = src.height * scale;
  const px = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (Math.floor(y / scale) * src.width + Math.floor(x / scale)) * 4;
      const d = (y * width + x) * 4;
      // Nearest-neighbour, and faded. Faded so the overlay reads over a bright
      // subject; nearest so a pixel stays a pixel — this is a picture of where
      // things are, and smoothing it would move them.
      px[d] = src.px[s] * dim;
      px[d + 1] = src.px[s + 1] * dim;
      px[d + 2] = src.px[s + 2] * dim;
      px[d + 3] = 255;
    }
  }
  return { width, height, px };
}

function dot(canvas, x, y, colour, radius = 0) {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const ix = Math.round(x + dx);
      const iy = Math.round(y + dy);
      if (ix < 0 || iy < 0 || ix >= canvas.width || iy >= canvas.height) continue;
      const o = (iy * canvas.width + ix) * 4;
      canvas.px[o] = colour[0];
      canvas.px[o + 1] = colour[1];
      canvas.px[o + 2] = colour[2];
      canvas.px[o + 3] = 255;
    }
  }
}

function line(canvas, x0, y0, x1, y1, colour, radius = 0) {
  // Two samples per pixel of length, so a steep line has no gaps.
  const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
  for (let i = 0; i <= steps; i++) {
    dot(canvas, x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, colour, radius);
  }
}

function ring(canvas, x, y, radius, colour) {
  const steps = Math.max(16, Math.ceil(radius * 8));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    dot(canvas, x + Math.cos(a) * radius, y + Math.sin(a) * radius, colour);
  }
}

/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { image: null, results: null, out: null, scale: 3, dim: 0.55, minAngle: 30 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const num = () => {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v)) throw new Error(`${arg} needs a number`);
      return v;
    };
    switch (arg) {
      case '--scale': opts.scale = num(); break;
      case '--dim': opts.dim = num(); break;
      case '--min-angle': opts.minAngle = num(); break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
        positional.push(arg);
    }
  }
  [opts.image, opts.results, opts.out] = positional;
  return opts;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}
if (opts.help || !opts.image || !opts.results) {
  console.log(USAGE);
  process.exit(opts.help ? 0 : 2);
}

const name = path.basename(opts.image).replace(/\.[^.]+$/, '');
const truthFile = path.join(path.dirname(opts.image), `${name}.gt.json`);
const featuresFile = path.join(opts.results, `${name}.features.json`);

for (const [label, file] of [['image', opts.image], ['ground truth', truthFile],
                             ['features', featuresFile]]) {
  if (!fs.existsSync(file)) {
    console.error(`no ${label} at ${file}`);
    process.exit(2);
  }
}

const source = decodePNG(opts.image);
const truth = JSON.parse(fs.readFileSync(truthFile, 'utf8'));
const slots = new Map(
  JSON.parse(fs.readFileSync(featuresFile, 'utf8')).map((e) => [e.slot, e.features])
);

if (truth.size !== source.width || source.width !== source.height) {
  console.error(
    `the ground truth is ${truth.size} square and the image is ` +
    `${source.width}x${source.height} — they do not describe the same picture`
  );
  process.exit(2);
}

const canvas = makeCanvas(source, opts.scale, opts.dim);
const S = opts.scale;

/*
 * Order matters: ground truth underneath, detections on top. What is being
 * checked is whether the detections land on the geometry, so the detections
 * are what must stay legible where the two coincide.
 */
for (const e of truth.edges) {
  line(canvas, e.x0 * S, e.y0 * S, e.x1 * S, e.y1 * S,
    e.visible >= MIN_VISIBLE ? COLOURS.truthVisible : COLOURS.truthHidden);
}

/** Verdict per detected feature id, from whichever match slot covers that kind. */
function verdicts(kind) {
  const map = new Map();
  for (const [, records] of slots) {
    for (const r of records) {
      if (r.type === 'edge-match' && r.kind === kind && r.detected !== null) {
        map.set(r.detected, r.role);
      }
    }
  }
  return map;
}

const segmentVerdict = verdicts('segment');
for (const [, features] of slots) {
  for (const f of features) {
    if (f.type !== 'edge-segment') continue;
    line(canvas, f.x0 * S, f.y0 * S, f.x1 * S, f.y1 * S,
      segmentVerdict.get(f.id) === 'hit' ? COLOURS.matched : COLOURS.unmatched, 1);
  }
}

/*
 * Only the vertices a detector is answerable for. A smooth object's silhouette
 * is a polyline whose interior points are vertices of degree two running almost
 * straight through — geometrically vertices, visually not corners. This must
 * use the same threshold `match` was given or the picture will disagree with
 * the table for reasons that are nobody's fault.
 */
for (const v of truth.vertices) {
  if (!v.visible || v.onFrame === false || v.angle < opts.minAngle) continue;
  ring(canvas, v.x * S, v.y * S, (5 * S) / 2, COLOURS.truthCorner);
}

const cornerVerdict = verdicts('corner');
for (const [, features] of slots) {
  for (const f of features) {
    if (f.type !== 'edge-corner') continue;
    dot(canvas, f.x * S, f.y * S,
      cornerVerdict.get(f.id) === 'hit' ? COLOURS.matchedCorner : COLOURS.unmatched, 2);
  }
}

const outDir = opts.out ?? path.dirname(opts.image);
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${name}.overlay.png`);
fs.writeFileSync(outFile, encodePNG(canvas.width, canvas.height, canvas.px));

console.log(
  `${outFile}\n` +
  `  white / grey       ground-truth edges: visible / hidden\n` +
  `  green / red        detected segments:  matched to geometry / not\n` +
  `  blue rings         ground-truth corners above ${opts.minAngle}°\n` +
  `  yellow / red dots  detected corners:   matched / invented`
);
