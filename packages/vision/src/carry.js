/**
 * Carrying across frames: what one frame measured well, written into the
 * readings of the frames that cannot measure it -- the still part's edge,
 * the strip's level, the aperture, and a ledge where there is one. Moved here
 * from scripts/gap-sweep.js (its --carry), which reads and writes the files;
 * this decides what is carried, from where, into which frame's trackPair
 * commands. design-lab-model.md §5, "A twelfth", "A sixteenth" and "A
 * thirty-second" say why each is.
 */

import { movingBelow, median, angleApart } from './ledge.js';

/**
 * What --carry writes into each frame.
 *
 * For every view and every pair, ONE frame is carried from: of the frames
 * whose refit read the pair as two detected edges at least `carryMin` px
 * apart with no ledge in them (fitPairs's `ledge.gain` under `ledgeMax`),
 * the one whose still edge is the median of theirs. Its fitPairs record gives the still part's edge, a point on
 * the moving side, the strip level and the aperture. Every frame of that view,
 * in any order, then reads the pair again with `K<pair> = trackPair(G, ...)`:
 *
 *   - the still edge HELD, everywhere. The still part does not move, and a
 *     frame where a ledge in soft shadow lies along its edge cannot place it
 *     (design-lab-model.md §5, the fifteenth); a frame without one can;
 *   - the strip FITTED where the frame read the pair at least `carryMin` px
 *     wide itself, and HELD at the carried level where it did not: under
 *     about a pixel and a half, width and level trade (the twelfth).
 *
 * A pair with no frame to carry from -- every wide frame has a ledge, or none
 * is wide -- gets nothing, and the plan says so.
 *
 * `pooled` are candidates from other runs (--carry-from), each already
 * placed: the same view, matched to a pair here by the angle it runs at.
 * Given any, this run's own frames are candidates only if `ownToo`.
 *
 * Arguments: gap-sweep's `rows` for the run and its `shots`; `featuresOf(shot)`,
 * the slots of that shot's features (its `fitted` pairs); `opts`, the sweep's
 * own -- carryMin, ledgeMax, offset, axis, poses, ledgeLift, ledgeFit, and
 * ledge (a name, for messages) -- and `ledgeTable`, ledgeTable()'s entries
 * under `entries`. Returns the plan: the commands per shot, which frame each
 * pair was carried from, the pairs with none, and the ledges held.
 */
/** trackPair's starting width from a frame's own reading, which may be an overhang's negative one. */
export const guessFrom = (read) => (read > 0 ? read : 0.5);

export function carryPlan(rows, shots, featuresOf, opts, pooled = null, ownToo = true, ownRun = '', ledgeTable = null) {
  // Whose top face a ledge is: the still part's, unless the moving part is below it.
  const below = movingBelow({ offsetMm: opts.offset, axis: opts.axis, poses: opts.poses });
  for (const e of ledgeTable?.entries ?? []) {
    if ((e.on ?? 'still') !== (below ? 'moving' : 'still')) {
      throw new Error(`--ledge ${opts.ledge}: measured with the moving part ${e.on === 'moving' ? 'below' : 'above'} the still one, and this run has it ${below ? 'below' : 'above'}`);
    }
  }
  const viewOf = (x) => `${x.view?.yaw ?? x.yaw ?? ''},${x.view?.elevation ?? x.elevation ?? ''}`;
  const n = (v) => v.toFixed(6);
  const shotOf = (s) => (r) => r.gapMm === s.gapMm && (s.pose === undefined || r.pose === s.pose);
  const commands = {};
  const sources = [];
  const missing = [];
  const ledges = [];
  for (const view of new Set(shots.map(viewOf))) {
    const frames = shots.filter((s) => viewOf(s) === view);
    const pairs = [...new Set(rows.filter((r) => viewOf(r) === view && r.pair).map((r) => r.pair))].sort((a, b) => a - b);
    for (const pair of pairs) {
      const rowIn = (s) => rows.find((r) => viewOf(r) === view && r.pair === pair && shotOf(s)(r));
      const candidates = (ownToo ? frames : []).map((s) => ({ s, row: rowIn(s) }))
        .filter(({ row }) => row?.refit?.from === 'pair' && row.refit.gapPx >= opts.carryMin)
        .filter(({ row }) => !(row.refit.ledge?.gain >= opts.ledgeMax))
        .sort((a, b) => b.row.refit.gapPx - a.row.refit.gapPx);
      // Each candidate's still edge, from its fitPairs record. detectedPair is
      // [moving, target]; the record's edges name segments.
      const placed = candidates.map((c) => {
        const record = (featuresOf(c.s).fitted ?? []).find((p) => p.id === c.row.refit.pair);
        if (!record) return null;
        const [moving, still] = record.a.segment === c.row.detectedPair[1] ? [record.b, record.a] : [record.a, record.b];
        return { ...c, record, moving, still };
      }).filter(Boolean);
      const angle = median(rows.filter((r) => viewOf(r) === view && r.pair === pair && r.pairAngle != null).map((r) => r.pairAngle));
      placed.push(...(pooled ?? []).filter((c) => c.view === view && angle !== null && angleApart(c.pairAngle, angle) <= 10));
      if (placed.length === 0) { missing.push({ view, pair }); continue; }
      // In a fixed order before anything is measured against the first, so
      // that runs given the same candidates choose the same one.
      const order = (c) => `${c.s.run ?? ownRun}/${c.s.name}`;
      placed.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
      /*
       * The median of them, not the widest. A mild ledge can stay under
       * ledgeMax and still move its frame's still edge 0.1 px: on the x
       * sweep the widest frame under it read that edge 0.09 to 0.13 px off,
       * and every frame carried it. Ordered by where each puts the still edge
       * -- its offset along the first one's normal at the first one's middle
       * -- the middle one is outvoted by nothing.
       */
      const ref = placed[0].still;
      const len = Math.hypot(ref.x1 - ref.x0, ref.y1 - ref.y0);
      const normal = [-(ref.y1 - ref.y0) / len, (ref.x1 - ref.x0) / len];
      const m = [(ref.x0 + ref.x1) / 2, (ref.y0 + ref.y1) / 2];
      const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
      // Where line e crosses the normal through ref's middle, along that normal.
      const offsetOf = (e) => {
        const u = [e.x1 - e.x0, e.y1 - e.y0];
        return cross([e.x0 - m[0], e.y0 - m[1]], u) / cross(normal, u);
      };
      placed.sort((a, b) => offsetOf(a.still) - offsetOf(b.still));
      const { s: from, row, record, moving, still } = placed[(placed.length - 1) >> 1];
      const carried = { line: still, toward: [(moving.x0 + moving.x1) / 2, (moving.y0 + moving.y1) / 2],
        stripLevel: record.levels[1], aperture: record.aperture, profile: record.profile ?? 'box' };
      sources.push({ ...(from.view ?? {}), pair, ...(from.run ? { run: from.run } : {}), from: from.name, fromMm: from.gapMm, gapPx: row.refit.gapPx,
        ledgeGain: row.refit.ledge?.gain ?? null, of: placed.length, stripLevel: carried.stripLevel, aperture: carried.aperture });
      // The ledge this view-pair has, from --ledge's file, matched like the
      // pooled edges by the angle the pair runs at.
      const ledge = (ledgeTable?.entries ?? []).find((e) => `${e.yaw},${e.elevation}` === view
        && angle !== null && angleApart(e.pairAngle, angle) <= 10) ?? null;
      if (ledgeTable) ledges.push({ view, pair, ...(ledge ? { flush: ledge.flush, widthPerMm: ledge.widthPerMm } : { none: true }) });
      for (const s of frames) {
        const own = rowIn(s);
        const read = own?.refit?.gapPx ?? own?.measuredGapPx ?? null;
        const wide = read !== null && read >= opts.carryMin;
        const common = `x0=${n(carried.line.x0)}, y0=${n(carried.line.y0)}, `
          + `x1=${n(carried.line.x1)}, y1=${n(carried.line.y1)}, towardX=${n(carried.toward[0])}, `
          + `towardY=${n(carried.toward[1])}, stripLevel=${n(carried.stripLevel)}, aperture=${n(carried.aperture)}, `
          // A start, not a reading: an overhang's negative refit starts at half a pixel.
          + `guess=${n(guessFrom(read ?? row.refit.gapPx))}, strip=${wide ? 'fit' : 'held'}`
          + `${carried.profile !== 'box' ? `, profile=${carried.profile}` : ''}`
          // The moving part below the still one: see trackPair's `moving`.
          + `${below ? ', moving=below' : ''}`;
        /*
         * The ledge, held: it ends where the still edge would be were the
         * moving part flush at this frame's lift -- the y sweep's gap at
         * that lift -- so a frame at flush has none, and one slid back has
         * as much as it slid. The shadow's width grows with the lift as a
         * penumbra does. The lift is the commanded one: what the robot was
         * told, not where the part is (design-lab-model.md §5, "A
         * thirty-second").
         */
        // The lift is how far the upper part is above the lower: the moving
        // part's own rise, or, when it is the one below, its drop.
        const lift = opts.ledgeLift ?? (below ? -1 : 1) * displacementOf(s, opts)[1];
        const offset = ledge ? ledge.flush[0] * lift + ledge.flush[1] : null;
        const held = offset > 0
          ? `, ledge=held, ledgeOffset=${n(offset)}, ledgeWidth=${n(Math.max(0, ledge.widthPerMm * lift))}` : '';
        const list = (commands[s.name.replace(/\.png$/, '')] ??= []);
        list.push(`K${pair} = trackPair(G, ${common}${held})`);
        if (opts.ledgeFit) list.push(`L${pair} = trackPair(G, ${common}, ledge=fit)`);
      }
    }
  }
  return { minPx: opts.carryMin, ledgeMax: opts.ledgeMax, sources, missing, commands, ...(ledgeTable ? { ledges } : {}) };
}

/** The moving part's displacement from contact for a shot, mm: its pose, or the sweep's step. */
export function displacementOf(s, opts) {
  if (s.poseMm) return s.poseMm;
  return [0, 1, 2].map((k) => (opts.offset?.[k] ?? 0) + opts.axis[k] * s.gapMm);
}
