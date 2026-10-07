// One frame's trackPair commands re-run, records printed:
//   node one.js <run> <shot base> [json extra options]
'use strict';
const fs = require('node:fs'), path = require('node:path');
const R = path.join(__dirname, '../../../');
const { trackPair } = require(R + 'src/lab/pairs');
const { parseCommand } = require('./retrack');
const { grayOf } = require('../2026-10-04-carry/lib');
const [run, base, extra] = process.argv.slice(2);
const dir = `results/${run}/pairs`;
const commands = JSON.parse(fs.readFileSync(R + dir + '/carry-commands.json', 'utf8'));
const G = grayOf(R + `generated/${run}/${base}.png`);
for (const c of commands[base] ?? []) {
  const { slot, p } = parseCommand(c);
  const r = trackPair(G, { line: { x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1 }, toward: [p.towardX, p.towardY], stripLevel: p.stripLevel, aperture: p.aperture },
    { guess: p.guess, strip: p.strip, profile: p.profile, ...JSON.parse(extra ?? '{}') });
  const f = (v) => (typeof v === 'number' ? +v.toFixed(3) : v);
  console.log(slot, p.strip, 'guess', f(p.guess), r && JSON.stringify({ model: r.model, gap: f(r.gap), ratio: f(r.ratio), freeRatio: f(r.freeRatio), strip: r.strip, stripFrom: r.stripFrom,
    levels: r.levels?.map(f), hyp: r.hypotheses?.map((h) => [h.model, f(h.gap), f(h.rms)]) }));
}
