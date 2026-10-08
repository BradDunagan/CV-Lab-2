// Each Math function over the same 200,000 inputs in Node, Chrome and
// Firefox, compared bit for bit (2026-10-08, item 5). Run from cv-lab with
// rr checked out beside it: node mathprobe.js

const path = require('node:path');
const fn = `(() => {
  let s = 12345; const r = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const tests = { hypot2: (a, b) => Math.hypot(a, b), hypot3: (a, b) => Math.hypot(a, b, a * b),
    asin: (a) => Math.asin(a * 2 - 1), acos: (a) => Math.acos(a * 2 - 1), atan2: (a, b) => Math.atan2(a - 0.5, b - 0.5),
    tan: (a) => Math.tan(a * 3 - 1.5), sin: (a) => Math.sin(a * 20 - 10), cos: (a) => Math.cos(a * 20 - 10),
    exp: (a) => Math.exp(a * 40 - 20), log: (a) => Math.log(a * 100 + 1e-9), pow: (a, b) => Math.pow(a * 10, b * 4 - 2),
    starstar: (a, b) => (a * 10) ** (b * 4 - 2), sqrt: (a) => Math.sqrt(a * 100), cbrt: (a) => Math.cbrt(a * 100 - 50), atan: (a) => Math.atan(a * 20 - 10) };
  const out = {};
  for (const [k, f] of Object.entries(tests)) {
    s = 12345; const v = new Float64Array(200000);
    for (let i = 0; i < v.length; i++) v[i] = f(r(), r());
    const u = new Uint32Array(v.buffer); let h = 0; for (let i = 0; i < u.length; i++) h = (Math.imul(h, 31) + u[i]) | 0;
    out[k] = { h, v: Array.from(v.slice(0, 0)) , all: v };
  }
  return out;
})()`;
(async () => {
  const node = eval(fn);
  const pw = require(require.resolve('playwright', { paths: [path.resolve('../rr/node_modules')] }));
  const C = process.env.HOME + '/Library/Caches/ms-playwright';
  for (const [name, opt] of [['chromium', { channel: 'chrome' }], ['firefox', { executablePath: C + '/firefox-1497/firefox/Nightly.app/Contents/MacOS/firefox' }]]) {
    const b = await pw[name].launch(opt); const p = await b.newPage();
    const res = await p.evaluate(`(() => { const o = ${fn}; const r = {}; for (const k in o) r[k] = { h: o[k].h, all: Array.from(o[k].all) }; return r; })()`);
    const line = [];
    for (const k of Object.keys(node)) {
      if (res[k].h === node[k].h) continue;
      let n = 0, ulp = 0; const a = node[k].all, c = res[k].all;
      for (let i = 0; i < a.length; i++) if (!Object.is(a[i], c[i])) { n++; }
      line.push(`${k} ${n}/${a.length}`);
    }
    console.log(`${name} ${b.version()} vs node ${process.versions.v8}: ${line.length ? line.join(', ') : 'all identical'}`);
    await b.close();
  }
})();
