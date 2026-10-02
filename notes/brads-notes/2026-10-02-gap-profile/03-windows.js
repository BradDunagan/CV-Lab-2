'use strict';

/**
 * One step or two, window by window along the table's edge.
 *
 *   node 03-windows.js                 the table in ../2026-10-02.md
 *   node 03-windows.js <run> <frame>   every window of one frame, e.g.
 *                                      gap-1-front-linear gap-1mm
 *
 * What findPairs decides on, shown rather than decided: for each 24 px window
 * of the table's front edge (one 512 px segment in these frames), the
 * rms of a one-step fit over the rms of the best two-step fit on the same
 * pixels, on the side that does better. findPairs reports a window when that
 * gain reaches 1.3 and its other gates pass; this prints the gain whether or
 * not they do. The Cube is over x = 200 to 315.
 */

const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
const repo = path.resolve(__dirname, '..', '..', '..');
const P = require(path.join(repo, 'src/lab/pairs'));

/** 8-bit RGBA PNG -> linear luminance, as load(as=linear) then gray. */
function decodeGray(file) {
  const b = fs.readFileSync(file);
  let p = 8, w = 0, h = 0; const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8);
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    else if (type === 'IDAT') idat.push(data);
    p += len + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= bpp ? out[y * stride + i - bpp] : 0;
      const u = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp] : 0;
      let v;
      if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + u;
      else if (f === 3) v = x + ((a + u) >> 1);
      else { const pa = Math.abs(u - c), pb = Math.abs(a - c), pc = Math.abs(a + u - 2 * c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? u : c); }
      out[y * stride + i] = v & 255;
    }
  }
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.2126 * lin(out[4 * i]) + 0.7152 * lin(out[4 * i + 1]) + 0.0722 * lin(out[4 * i + 2]);
  return { width: w, height: h, channels: 1, data: g };
}


function windows(run, name) {
  const lists = JSON.parse(fs.readFileSync(path.join(repo, 'results', run, `${name}.features.json`), 'utf8'));
  const F = lists.find((s) => s.slot === 'F').features;
  const raster = decodeGray(path.join(repo, 'generated', run, `${name}.png`));
  const opts = { ...P.DEFAULTS };
  const { segs, paired } = P.candidates(F, opts);
  // The table's front edge: the long segment passing under the Cube, at
  // about (257, 267). There is a second 510 px segment in every frame.
  const near = (s) => {
    const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
    return Math.abs((257 - s.x0) * dy - (267 - s.y0) * dx) / Math.hypot(dx, dy) < 3;
  };
  const seg = segs.filter((s) => s.length > 400 && near(s))[0];
  const aperture = P.medianAperture(P.loneApertures(segs, raster, paired, opts), seg.id).width;

  let dx = seg.x1 - seg.x0, dy = seg.y1 - seg.y0, x0 = seg.x0, y0 = seg.y0;
  const len = Math.hypot(dx, dy);
  if (dx < 0) { x0 = seg.x1; y0 = seg.y1; dx = -dx; dy = -dy; }
  const ux = dx / len, uy = dy / len;
  const out = [];
  for (let from = opts.inset; from + opts.window <= len - opts.inset; from += opts.window / 2) {
    const mid = from + opts.window / 2;
    const base = { ox: x0 + ux * mid, oy: y0 + uy * mid, ux, uy, nx: -uy, ny: ux, half: opts.window / 2 };
    const lone = P.fitBand(P.bandSamples(raster, { ...base, edges: [{ c: 0, m: 0 }] }, opts),
      { ...base, edges: [{ c: 0, m: 0 }] }, { aperture });
    if (!lone) continue;
    const { c, m } = lone.edges[0];
    let best = null;
    for (const side of [-1, 1]) {
      const pairAt = (g) => (side > 0 ? [{ c, m }, { c: c + g, m }] : [{ c: c - g, m }, { c, m }]);
      const samples = P.bandSamples(raster, { ...base, edges: pairAt(opts.reach) }, opts);
      const one = P.fitBand(samples, { ...base, edges: [{ c, m }] }, { aperture });
      let two = null;
      for (const g of [opts.reach / 4, opts.reach / 2, opts.reach]) {
        const fit = P.fitBand(samples, { ...base, edges: pairAt(g) }, { aperture });
        if (fit && (!two || fit.rms < two.rms)) two = fit;
      }
      if (!one || !two) continue;
      const gain = one.rms / two.rms;
      if (!best || gain > best.gain) best = { gain, gap: two.edges[1].c - two.edges[0].c, levels: two.levels };
    }
    out.push({ x: base.ox, ...(best ?? { gain: null }) });
  }
  return { aperture, out };
}

const [run, frame] = process.argv.slice(2);
if (run) {
  const { aperture, out } = windows(run, frame);
  console.log(`${run} ${frame}: aperture ${aperture.toFixed(2)}`);
  for (const w of out) {
    console.log(`  x ${w.x.toFixed(0).padStart(3)}  ` + (w.gain === null ? 'no two-step fit'
      : `gain ${w.gain.toFixed(2)}  gap ${w.gap.toFixed(2)}  levels ${w.levels.map((v) => v.toFixed(2)).join('|')}`));
  }
} else {
  const range = (ws) => {
    const g = ws.filter((w) => w.gain !== null).map((w) => w.gain);
    return g.length ? `${Math.min(...g).toFixed(2)} to ${Math.max(...g).toFixed(2)} (${g.length} windows)` : 'none';
  };
  for (const r of ['gap-1-front-linear', 'gap-1-front-linear-2']) {
    for (const f of ['gap-1mm', 'gap-0p5mm', 'gap-0mm']) {
      const { out } = windows(r, f);
      // Wholly under the Cube, and wholly clear of it.
      const under = out.filter((w) => w.x - 12 >= 203 && w.x + 12 <= 313);
      const clear = out.filter((w) => w.x + 12 < 195 || w.x - 12 > 320);
      console.log(`${r.padEnd(21)} ${f.padEnd(9)} under the Cube: ${range(under).padEnd(28)} clear of it: ${range(clear)}`);
    }
  }
}
