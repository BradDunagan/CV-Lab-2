// Re-run a --carry run's trackPair commands with extra options, outside the
// lab, and score them as gap-sweep does.
//   node retrack.js <run> '<options json>' [pair] [--rows]
// <run> is a results name (results/<run>/pairs, generated/<run>). Prints the
// tracked error per view beside the run's own, and returns the rows.
'use strict';
const fs = require('node:fs'), path = require('node:path');
const R = path.join(__dirname, '../../../');
const { grayOf } = require('../2026-10-04-carry/lib');
const { trackPair } = require(R + 'src/lab/pairs');
const GS = require(R + 'src/lab/gapsweep');

function parseCommand(cmd) {
  const m = cmd.match(/^(K\d+) = trackPair\(G, (.*)\)$/);
  const p = Object.fromEntries(m[2].split(', ').map((kv) => kv.split('=')).map(([k, v]) => [k, Number.isFinite(Number(v)) ? Number(v) : v]));
  return { slot: m[1], p };
}

function retrack(run, extra, { gen = run, dir = `results/${run}/pairs`, carried = null } = {}) {
  const sweep = JSON.parse(fs.readFileSync(R + dir + '/gap-sweep.json', 'utf8'));
  const commands = JSON.parse(fs.readFileSync(R + dir + '/carry-commands.json', 'utf8'));
  const shots = JSON.parse(fs.readFileSync(R + `generated/${gen}/shots.json`, 'utf8'));
  const out = [];
  for (const shot of shots) {
    const base = shot.name.replace(/\.png$/, '');
    const cmds = commands[base] ?? [];
    const lists = JSON.parse(fs.readFileSync(R + `${dir}/${base}.features.json`, 'utf8'));
    const by = Object.fromEntries(lists.map((l) => [l.slot, l.features]));
    const G = grayOf(R + `generated/${gen}/${shot.name}`);
    const tracks = [];
    for (const c of cmds) {
      const { slot, p } = parseCommand(c);
      const record = trackPair(G, {
        line: { x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1 }, toward: [p.towardX, p.towardY],
        stripLevel: p.stripLevel, aperture: p.aperture,
      }, { guess: p.guess, strip: p.strip, profile: p.profile, ...(typeof extra === 'function' ? extra(shot, p, slot) : extra) });
      if (record) tracks.push(record);
    }
    const pairs = by.P || by.H ? [...(by.P ?? []), ...(by.H ?? [])] : null;
    const rows = GS.gapRows({ truth: by.T, segments: by.F, explained: by.EF, matches: by.MF, pairs, tracks }, shot,
      { moving: sweep.moving, target: sweep.target },
      // As gap-sweep --max-angle scored the run (12 for turned poses).
      process.env.MAX_ANGLE ? { maxAngle: Number(process.env.MAX_ANGLE) } : {});
    for (const r of rows) {
      const old = sweep.rows.find((o) => o.shot === shot.name && o.truthPair && r.truthPair && o.truthPair.join() === r.truthPair.join());
      out.push({ shot: shot.name, view: `${shot.view.yaw}/${shot.view.elevation}`, gapMm: shot.gapMm, pose: shot.pose, poseMm: shot.poseMm, turnDeg: shot.turnDeg,
        pair: old?.pair ?? null, truthPair: r.truthPair, trueGapPx: r.trueGapPx, tracked: r.tracked, was: old?.tracked ?? null,
        ledge: tracks.find((t) => r.tracked && t.ledge && Math.abs(t.gap - r.tracked.gapPx) < 0.5)?.ledge ?? null });
    }
  }
  return out;
}
module.exports = { retrack, parseCommand };

if (require.main === module) {
  const [run, json, pair] = process.argv.slice(2);
  const rows = retrack(run, JSON.parse(json || '{}'));
  const f = (t) => (t && Number.isFinite(t.errorPx) ? (t.errorPx >= 0 ? '+' : '') + t.errorPx.toFixed(3) : '  --  ');
  const views = new Map();
  for (const r of rows) {
    if (pair && String(r.pair) !== pair) continue;
    const k = `${r.view} p${r.pair}`;
    if (!views.has(k)) views.set(k, []);
    views.get(k).push(`${String(r.gapMm ?? r.shot.replace(/.*pose-|\.png/g, '')).padStart(4)}: ${f(r.was)} ${f(r.tracked)}${r.ledge ? ` [${r.ledge.offset.toFixed(2)},${r.ledge.width.toFixed(2)},${r.ledge.seen ? "s" : "h"},${r.ledge.gain?.toFixed(3)}]` : ''}`);
  }
  for (const [k, v] of views) console.log(`${k.padEnd(10)} ${v.join('  ')}`);
}
