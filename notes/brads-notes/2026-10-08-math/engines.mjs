// The package's math (packages/vision/src/math.js) in Node, Chrome and
// Firefox, over the same 200,000 inputs per function, compared bit for bit;
// the engines' own Math beside it for contrast. Item 6. Run from cv-lab with
// rr checked out beside it: node notes/brads-notes/2026-10-08-math/engines.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const esbuild = require(path.join(ROOT, 'node_modules/esbuild'));
const lib = (await esbuild.build({ entryPoints: [path.join(ROOT, 'packages/vision/src/math.js')], bundle: true,
  format: 'iife', globalName: 'pm', write: false })).outputFiles[0].text;
const probe = `(() => {
  ${lib}
  const own = { len2: pm.len2, atan2: pm.atan2, asin: pm.asin, acos: pm.acos, sin: pm.sin, cos: pm.cos, tan: pm.tan, log: pm.log };
  const eng = { len2: Math.hypot, atan2: Math.atan2, asin: Math.asin, acos: Math.acos, sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log };
  const arg = { len2: (a, b) => [a * 2000 - 1000, b * 2000 - 1000], atan2: (a, b) => [a * 2 - 1, b * 2 - 1], asin: (a) => [a * 2 - 1],
    acos: (a) => [a * 2 - 1], sin: (a) => [a * 40 - 20], cos: (a) => [a * 40 - 20], tan: (a) => [a * 3 - 1.5], log: (a, b) => [(b + 0.5) * Math.pow(2, Math.floor(a * 200 - 100))] };
  const out = {};
  for (const k of Object.keys(own)) for (const [which, f] of [['own', own[k]], ['engine', eng[k]]]) {
    let s = 12345; const r = () => (s = (s * 48271) % 2147483647) / 2147483647;
    const v = new Float64Array(200000);
    for (let i = 0; i < v.length; i++) v[i] = f(...arg[k](r(), r()));
    out[k + ' ' + which] = Array.from(v);
  }
  return out;
})()`;
const node = eval(probe);
const pw = require(require.resolve('playwright', { paths: [path.resolve(ROOT, '../rr/node_modules')] }));
const C = process.env.HOME + '/Library/Caches/ms-playwright';
for (const [name, opt] of [['chromium', { channel: 'chrome' }], ['firefox', { executablePath: C + '/firefox-1497/firefox/Nightly.app/Contents/MacOS/firefox' }]]) {
  const b = await pw[name].launch(opt);
  const res = await (await b.newPage()).evaluate(probe);
  const line = Object.keys(node).map((k) => {
    let n = 0; for (let i = 0; i < node[k].length; i++) if (!Object.is(node[k][i], res[k][i])) n++;
    return `${k} ${n}`;
  });
  console.log(`${name} ${b.version()} against node ${process.versions.v8}, differing of 200000:\n  ${line.join('\n  ')}`);
  await b.close();
}
