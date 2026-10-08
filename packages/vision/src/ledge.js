/**
 * A scene's ledge, from gap-sweep runs with no truth: where it ends and how
 * soft its shadow is, per view and pair, for trackPair to hold in every
 * frame. Moved here from scripts/ledge.js, which reads the runs and writes
 * the table; this computes it.
 *
 * Slid back, a part held above another uncovers a strip of the lower part's
 * top face inside the gap, lit up to the upper part's shadow; read as one
 * flat strip it puts the moving edge too far out, and by more the further it
 * slid (design-lab-model.md §5, "A fifteenth" and "A thirty-second"). Two
 * things place it in a frame, both per view and pair:
 *
 *   1. WHERE IT ENDS: where the still edge would be were the moving part flush,
 *      the gap a sweep straight up reads at that lift: its tracked gap as a
 *      straight line in the commanded lift, px = a * lift + b.
 *   2. HOW SOFT THE SHADOW IS: the width a free ledge fit gives it where the
 *      lit ledge is wide and the fit clearly better than the strip alone, per
 *      millimetre of lift -- a penumbra grows with the distance from what
 *      casts it. The median; zero where none qualifies. Measure it on SHARP
 *      images, or not at all ("A thirty-third").
 */

export const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[(s.length - 1) >> 1] : null; };
export const angleApart = (a, b) => Math.abs((((a - b + 90) % 180) + 180) % 180 - 90);

/**
 * Whether a run's moving part is the one BELOW: moved down from contact, by
 * its offset, its sweep, or every pose. The ledge is then its own top face, in
 * the still part's shadow (design-lab-model.md §5, "A thirty-fifth").
 */
export function movingBelow(run) {
  if (run.poses?.length) return run.poses.every((p) => (p.mm ?? p)[1] <= 0) && run.poses.some((p) => (p.mm ?? p)[1] < 0);
  return (run.offsetMm?.[1] ?? 0) < 0 || ((run.offsetMm?.[1] ?? 0) === 0 && (run.axis?.[1] ?? 0) < 0);
}

/** How far the upper part is above the lower for a row of a run, mm: the moving part's lift, or its drop. */
export function liftOf(run, r) {
  const dy = r.poseMm ? r.poseMm[1] : (run.offsetMm?.[1] ?? 0) + (run.axis?.[1] ?? 0) * r.gapMm;
  return movingBelow(run) ? -dy : dy;
}

/**
 * Per view and pair, the tracked gap as a line in the lift, least squares.
 * The run must be a sweep along y with nothing slid: elsewhere the gap is not
 * the flush one.
 */
export function flushLines(run) {
  const slid = (run.offsetMm ?? [0, 0, 0]).some((v, k) => k !== 1 && v !== 0)
    || (run.axis ?? [0, 1, 0]).some((v, k) => k !== 1 && v !== 0);
  if (run.rows.some((r) => r.poseMm) || slid) throw new Error('--flush needs a sweep along y with nothing slid (--axis 0,1,0, no x or z offset)');
  const by = new Map();
  for (const r of run.rows) {
    if (r.pair == null || !Number.isFinite(r.tracked?.gapPx)) continue;
    const k = `${r.yaw},${r.elevation},${r.pair}`;
    if (!by.has(k)) by.set(k, { yaw: r.yaw, elevation: r.elevation, pair: r.pair, points: [], angles: [] });
    const e = by.get(k);
    e.points.push([liftOf(run, r), r.tracked.gapPx]);
    if (r.pairAngle != null) e.angles.push(r.pairAngle);
  }
  const out = [];
  for (const e of by.values()) {
    const n = e.points.length;
    if (n < 3) continue;
    const mx = e.points.reduce((s, p) => s + p[0], 0) / n, my = e.points.reduce((s, p) => s + p[1], 0) / n;
    const sxx = e.points.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
    if (!(sxx > 0)) continue;
    const a = e.points.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / sxx;
    const b = my - a * mx;
    const rms = Math.sqrt(e.points.reduce((s, p) => s + (p[1] - a * p[0] - b) ** 2, 0) / n);
    out.push({ yaw: e.yaw, elevation: e.elevation, pair: e.pair, pairAngle: median(e.angles), flush: [a, b], flushRms: rms, flushOf: n,
      on: movingBelow(run) ? 'moving' : 'still' });
  }
  return out;
}

/** Each qualifying free fit's shadow width per mm of lift, keyed to an entry by view and angle. */
function widths(entries, runs, minGain, minLit) {
  const found = entries.map(() => []);
  for (const run of runs) {
    if (entries.length && (movingBelow(run) ? 'moving' : 'still') !== entries[0].on) {
      throw new Error('a --fits run has the moving part on the other side of the still one from --flush');
    }
    for (const r of run.rows) {
      const f = r.ledgeFit;
      // A shadow within a pixel and a half of the still edge leaves too little
      // lit ledge to say how soft it is: on the x sweep two such fits came out
      // 6 and 14 times wider than the wide ones.
      if (!f || !(f.lit >= minLit) || !(f.gain >= minGain) || !Number.isFinite(f.width)) continue;
      const lift = liftOf(run, r);
      if (!(lift > 0)) continue;
      const k = entries.findIndex((e) => e.yaw === r.yaw && e.elevation === r.elevation
        && r.pairAngle != null && angleApart(e.pairAngle, r.pairAngle) <= 10);
      if (k >= 0) found[k].push(f.width / lift);
    }
  }
  return found;
}

/**
 * The table: each flush line with its shadow's width per mm.
 * @param {object} flushRun a gap-sweep record, swept along y with nothing slid
 * @param {object[]} fitRuns gap-sweep records with free ledge fits
 */
export function ledgeTable(flushRun, fitRuns, { minGain = 1.5, minLit = 1.5 } = {}) {
  const entries = flushLines(flushRun);
  const found = widths(entries, fitRuns, minGain, minLit);
  return entries.map((e, k) => ({ ...e, widthPerMm: found[k].length ? median(found[k]) : 0, widthsOf: found[k].length }));
}
