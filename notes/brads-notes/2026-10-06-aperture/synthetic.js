// A straight strip drawn exactly -- area-sampled at 32x, then a renderer-like
// spread (sigma0) and an optic's Gaussian blur (sigma) on the pixel grid --
// fitted with each profile: the aperture a lone edge gives, and the gap at it.
//   node synthetic.js [sigma] [gap px] [angle deg]
'use strict';
const { fitBand } = require('../../../src/lab/pairs');
const sigma = Number(process.argv[2] ?? 0.8), gapTrue = Number(process.argv[3] ?? 2.5), angle = Number(process.argv[4] ?? 7);
const W = 64, H = 64, SS = 32, sigma0 = Number(process.env.SIGMA0 ?? 0.26);
const th = (angle * Math.PI) / 180, nx = Math.cos(th), ny = Math.sin(th);
const cx = W / 2, cy = H / 2;
function draw(edges, levels) {
  const img = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
      const px = x - 0.5 + (i + 0.5) / SS, py = y - 0.5 + (j + 0.5) / SS;
      const h = (px - cx) * nx + (py - cy) * ny;
      let k = 0; while (k < edges.length && h > edges[k]) k++;
      acc += levels[k];
    }
    img[y * W + x] = acc / (SS * SS);
  }
  return img;
}
function blur(img, s) {
  if (!(s > 0)) return img;
  const r = Math.ceil(4 * s), k = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * s * s)));
  const sum = k.reduce((a, b) => a + b, 0);
  let cur = img;
  for (const [dx, dy] of [[1, 0], [0, 1]]) {
    const t = new Float64Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const xx = Math.max(0, Math.min(W - 1, x + i * dx)), yy = Math.max(0, Math.min(H - 1, y + i * dy));
        acc += cur[yy * W + xx] * k[i + r];
      }
      t[y * W + x] = acc / sum;
    }
    cur = t;
  }
  return cur;
}
const spread = Math.sqrt(sigma0 * sigma0 + sigma * sigma);
const frameOf = (edges) => ({ ox: cx, oy: cy, ux: -ny, uy: nx, nx, ny, half: 20, edges: edges.map((c) => ({ c, m: 0 })) });
function samples(img, frame, lo, hi) {
  const t = [], h = [], v = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const rx = x - cx, ry = y - cy, tt = rx * frame.ux + ry * frame.uy, hh = rx * nx + ry * ny;
    if (Math.abs(tt) > frame.half || hh < lo || hh > hi) continue;
    t.push(tt); h.push(hh); v.push(img[y * W + x]);
  }
  return { t, h, v };
}
const lone = blur(draw([0.3], [0.2, 0.7]), spread);
const pair = blur(draw([-gapTrue / 2, gapTrue / 2], [0.5, 0.1, 0.8]), spread);
const expected = Math.sqrt(1 + 12 * spread * spread);
console.log(`sigma ${sigma} (+ ${sigma0} renderer), gap ${gapTrue} px, ${angle} deg; same-variance box ${expected.toFixed(3)}`);
for (const profile of ['box', 'smooth']) {
  const f = fitBand(samples(lone, frameOf([0]), -6, 6), frameOf([0]), { aperture: 1.5, fitAperture: true, profile });
  const at = (w) => {
    const g = fitBand(samples(pair, frameOf([-gapTrue / 2, gapTrue / 2]), -gapTrue / 2 - 5, gapTrue / 2 + 5),
      frameOf([-gapTrue / 2, gapTrue / 2]), { aperture: w, profile });
    return g ? `${(g.edges[1].c - g.edges[0].c - gapTrue >= 0 ? '+' : '')}${(g.edges[1].c - g.edges[0].c - gapTrue).toFixed(3)} (rms ${g.rms.toExponential(1)})` : 'no fit';
  };
  console.log(`${profile.padEnd(7)} lone edge: aperture ${f.aperture.toFixed(3)}, edge ${(f.edges[0].c - 0.3).toFixed(4)}, rms ${f.rms.toExponential(1)};  gap error at it ${at(f.aperture)}, at ${expected.toFixed(2)} ${at(expected)}`);
}
