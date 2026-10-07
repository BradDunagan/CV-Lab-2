// A run re-read with the ledge carried, written where solve-position reads it:
//   node variant.js <kappa.json> <suffix> <run> ...
// results/<run><suffix>/pairs/gap-sweep.json is the run's own with every
// tracked reading replaced. Offset = kappa * lift, width = omega * lift, per
// view and pair, lift from the shot's commanded pose.
'use strict';
const fs = require('node:fs'), path = require('node:path');
const R = path.join(__dirname, '../../../');
const { retrack } = require('./retrack');
const { liftOf } = require('./lift');
const [kappaFile, suffix, ...runs] = process.argv.slice(2);
const table = JSON.parse(fs.readFileSync(kappaFile, 'utf8'));
// MODE: 'kappa' (offset kappa*lift), 'gate' (the same, plain where the frame's
// guess is under GATE px wider than the y sweep's flush gap at its lift),
// 'flush' (offset = that flush gap). FLUSH: the y run giving the flush lines.
const { flushLines } = require('./flush');
const MODE = process.env.MODE ?? 'kappa', GATE = Number(process.env.GATE ?? 0.5);
const flush = process.env.FLUSH ? flushLines(process.env.FLUSH) : null;
// Which carried pair a K slot is: the run's own numbering, K<pair>.
for (const run of runs) {
  const dir = `results/${run}/pairs`;
  const sweep = JSON.parse(fs.readFileSync(R + dir + '/gap-sweep.json', 'utf8'));
  const rows = retrack(run, (shot, p, slot) => {
    const k = `${shot.view.yaw}/${shot.view.elevation}|${slot.slice(1)}`;
    // PAIRS=all: every view-pair the flush lines know, not only the table's;
    // WIDTH: the shadow's width held at that, px, in place of omega * lift;
    // OMEGA_SCALE: every width scaled by this;
    // LIFT_ERR: mm added to every lift, as a robot that is off would.
    const t = table[k] ?? (process.env.PAIRS === 'all' && flush?.[k] ? { kappa: 0, omega: 0 } : null);
    if (!t) return {};
    const lift = liftOf(sweep, { gapMm: shot.gapMm, poseMm: shot.poseMm }) + Number(process.env.LIFT_ERR ?? 0);
    if (!(lift > 0)) return {};
    // WIDTH=fit: the width fitted in each frame, the offset still held.
    const width = process.env.WIDTH === 'fit' ? null
      : process.env.WIDTH !== undefined ? Number(process.env.WIDTH) : Math.max(t.omega * Number(process.env.OMEGA_SCALE ?? 1) * lift, 0);
    const line = flush?.[k];
    const atFlush = line ? line[0] * lift + line[1] : null;
    if (MODE === 'flush') return atFlush > 0 ? { ledge: { offset: atFlush, width } } : {};
    if (MODE === 'gate' && !(atFlush !== null && p.guess - atFlush >= GATE)) return {};
    return { ledge: { offset: t.kappa * lift, width } };
  });
  let changed = 0;
  const out = { ...sweep, ledgeCarried: { kappaFile, table: Object.fromEntries(Object.entries(table).map(([k, v]) => [k, { kappa: v.kappa, omega: v.omega }])) } };
  out.rows = sweep.rows.map((o) => {
    const n = rows.find((r) => r.shot === o.shot && r.truthPair && o.truthPair && r.truthPair.join() === o.truthPair.join());
    if (!n) return o;
    const t = n.tracked ? { ...n.tracked } : null;
    if (t && o.tracked) {
      t.carriedFrom = o.tracked.carriedFrom; t.carriedFromMm = o.tracked.carriedFromMm;
      t.errorMm = o.tracked.errorMm != null && o.tracked.errorPx ? t.errorPx * (o.tracked.errorMm / o.tracked.errorPx) : null;
    }
    if (JSON.stringify(t?.gapPx) !== JSON.stringify(o.tracked?.gapPx)) changed++;
    return { ...o, tracked: t, ...(n.ledge ? { ledge: n.ledge } : {}) };
  });
  const to = R + `results/${run}${suffix}/pairs`;
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(to + '/gap-sweep.json', JSON.stringify(out, null, 1));
  console.log(`${run}${suffix}: ${changed} of ${out.rows.length} rows changed`);
}
