// The ledge carried: per view, pair 2's shadow offset and width held at the
// values given, every frame. node carried.js <run> '<{"35/20":[off,w],...}>'
'use strict';
const { retrack } = require('./retrack');
const [run, json] = process.argv.slice(2);
const by = JSON.parse(json);
const rows = retrack(run, (shot, p, slot) => {
  const v = by[`${shot.view.yaw}/${shot.view.elevation}`];
  return slot === 'K2' && v ? { ledge: { offset: v[0], width: v[1] } } : {};
});
const f = (t) => (t && Number.isFinite(t.errorPx) ? (t.errorPx >= 0 ? '+' : '') + t.errorPx.toFixed(3) : '  --  ');
const views = new Map();
for (const r of rows.filter((r) => r.pair === 2)) {
  const k = r.view;
  if (!views.has(k)) views.set(k, []);
  views.get(k).push(`${String(r.gapMm).padStart(3)}: ${f(r.was)} ${f(r.tracked)}`);
}
for (const [k, v] of views) console.log(`${k.padEnd(6)} ${v.join('  ')}`);
