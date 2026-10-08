/**
 * From gap readings to where the part is: calibrating each reading against
 * known motions, and solving a pose from a frame's readings.
 *
 * This was the body of scripts/solve-position.js and scripts/servo.js, mixed
 * with their files and their printing. A robot cell needs it without either:
 * it commands calibration sweeps, calibrates from what it read
 * (`calibrateReadings`, `joint` or `hinged` -- no truth anywhere), and then
 * solves each frame (`estimatePose`), carrying the last pose forward by the
 * move it commanded. The scripts keep what is theirs: reading result files,
 * scoring against a renderer's truth, and saying what they found.
 *
 * Vocabulary. A READING is one gap, in one view, of one facing pair, at one
 * POINT along it -- the middle, or a sixth in from either end -- keyed
 * `<view> / pair <n> / <point>`. A frame's readings come from gap-sweep's
 * rows (`readingsOf`). A calibrated reading is a model of how that gap moves
 * with the displacement d from the reference pose: a reference value, a slope
 * per unknown (the Jacobian), and optionally hinge terms (a second slope that
 * applies on one side of flush only, where a ledge is in sight) and lift terms
 * (slopes that change with the height). design-lab-model.md §5, the ninth to
 * the thirty-fifth, says why each exists.
 */

import { solvePosition, solveLifted } from './position.js';
import { cos, log, sq } from './math.js';

/** The angular unknowns, in degrees; the rest (x, y, z) are millimetres. */
export const ANGLES = ['turn', 'tipx', 'tipz'];

/** Where along each pair the gap is read, by the name solve-position's --readings takes. */
export const POINTS = { mid: ['mid'], ends: ['end 1', 'end 2'], both: ['mid', 'end 1', 'end 2'] };

/** A gap-sweep row's view, as reading keys name it. */
export const viewOf = (r) => (r.yaw === undefined ? 'the saved view' : `yaw ${r.yaw}, elev ${r.elevation}`);

/** The key of one reading: `<view> / pair <n> / <point>`. */
export const keyOf = (r, point) => `${viewOf(r)} / pair ${r.pair} / ${point}`;

/** One row's readings at each point, as truth, detected, refit and tracked, with their sigmas. */
export function readingsOf(r) {
  const at = (k) => ({
    truth: r.endsTruePx?.[k] ?? null,
    detected: r.endsDetectedPx?.[k] ?? null,
    refit: r.refit?.endsPx?.[k] ?? null,
    sigma: r.refit?.gapSigma ?? null,
    tracked: r.tracked?.endsPx?.[k] ?? null,
    trackedSigma: r.tracked?.gapSigma ?? null,
  });
  return {
    mid: { truth: r.trueGapPx, detected: r.measuredGapPx, refit: r.refit?.gapPx ?? null, sigma: r.refit?.gapSigma ?? null,
      tracked: r.tracked?.gapPx ?? null, trackedSigma: r.tracked?.gapSigma ?? null },
    'end 1': at(0),
    'end 2': at(1),
  };
}

/** Least-squares slope and intercept of y against x. Null with under two points. */
export function fitLine(points) {
  const p = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (p.length < 2) return null;
  const mx = p.reduce((s, [x]) => s + x, 0) / p.length;
  const my = p.reduce((s, [, y]) => s + y, 0) / p.length;
  let sxx = 0, sxy = 0;
  for (const [x, y] of p) { sxx += sq(x - mx); sxy += (x - mx) * (y - my); }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  return { slope, at0: my - slope * mx };
}

/**
 * The hinge's side: where a ledge is in sight. Slid back (x or z below zero)
 * with the moving part above; slid out the other way with it below, when the
 * ledge is its own top face (design-lab-model.md §5, "A thirty-fifth").
 */
export const hingeFor = (movingBelow) => (x) => (movingBelow ? Math.max(x, 0) : Math.min(x, 0));

/**
 * A calibrated reading's value at displacement d: the reference, the slopes,
 * the hinges, and the lift's terms (the lift is d[liftAxis]).
 */
export function modelAt(o, d, { hingeOf = hingeFor(false), liftAxis = 1 } = {}) {
  return o.reference + o.jacobian.reduce((acc, j, a) => acc + j * d[a]
    + (o.hinge?.[a] ?? 0) * hingeOf(d[a]) + (o.lift?.[a] ?? 0) * d[liftAxis] * d[a]
    + (o.liftHinge?.[a] ?? 0) * d[liftAxis] * hingeOf(d[a]), 0);
}

const finite = (v) => v !== null && v !== undefined && Number.isFinite(v);

/**
 * Each reading's model, from calibration frames whose displacement is known.
 *
 * @param {object} c
 * @param {Array<{sweep: string, step: number, row: object}>} c.sweepFrames
 *   every frame of every sweep, sweep by sweep in `unknowns` order: the
 *   unknown it moved along, and how far, in mm or degrees
 * @param {Array<{row: object, d: number[]}>} [c.liftFrames] frames made at
 *   another lift, each with its whole displacement; they join a joint or
 *   hinged calibration and add lift terms
 * @param {string[]} c.unknowns e.g. ['x', 'y', 'z', 'turn']
 * @param {'full' | 'reference' | 'joint' | 'hinged'} c.mode
 *   full: each slope from its own sweep, the reference their intercepts'
 *   mean; reference: only the reference, from the frames at zero, the
 *   Jacobian kept from `base`; joint: every slope and the reference in one
 *   least-squares fit over every frame, frames more than 3 MADs off dropped
 *   and the fit made again; hinged: joint, with a one-sided slope in x and z
 * @param {(reading: object) => number | null} c.pick which value of a
 *   reading (see readingsOf) to calibrate: the tracked one, the refit...
 * @param {string[]} [c.points] POINTS.both by default
 * @param {(x: number) => number} [c.hingeOf] hingeFor(movingBelow)
 * @param {number} [c.liftAxis] the index of y in `unknowns`
 * @param {Map<string, object>} [c.base] readings to calibrate, keyed: the
 *   truth's, in cv-lab; their other fields are kept. Without it, every key
 *   the frames hold
 * @returns {Map<string, {key: string, view: string, reference: number, jacobian: number[],
 *   hinge?: number[], lift?: number[], liftHinge?: number[], calibration?: {frames: number, kept: number, rms: number}}>}
 */
export function calibrateReadings({ sweepFrames, liftFrames = [], unknowns, mode, pick, points = POINTS.both,
  hingeOf = hingeFor(false), liftAxis = unknowns.indexOf('y'), base = null }) {
  const lifted = liftFrames.length > 0;
  const keyed = base ?? new Map(keysOf(sweepFrames, points).map((key) => [key, { key, view: key.split(' / ')[0] }]));
  const out = new Map();
  for (const [key, truth] of keyed) {
    const point = key.split(' / ')[2];
    const valuesOf = (u) => sweepFrames.filter((f) => f.sweep === u && keyOf(f.row, point) === key)
      .map((f) => [f.step, pick(readingsOf(f.row)[point])])
      .filter(([, v]) => finite(v));
    if (mode === 'joint' || mode === 'hinged') {
      /*
       * reading = reference + J . d, over every frame of every sweep where
       * this reading was made: one fit, so a frame's error pulls on every
       * coefficient a little rather than on one slope a lot, and the sweeps
       * agree on one reference. A frame the fit disagrees with by more than
       * 3 MADs (scaled to a sigma, and never under 0.05 px) is dropped and
       * the fit made again.
       */
      const displacementOf = (f) => unknowns.map((v) => (v === f.sweep ? f.step : 0));
      const pts = [...sweepFrames.filter((f) => keyOf(f.row, point) === key)
        .map((f) => [displacementOf(f), pick(readingsOf(f.row)[point])]),
      ...liftFrames.filter(({ row }) => keyOf(row, point) === key).map(({ row, d }) => [d, pick(readingsOf(row)[point])])]
        .filter(([, v]) => finite(v));
      // Hinged: one more column per lateral axis, the displacement where
      // it is below zero and nothing where it is not.
      const hinged = mode === 'hinged' ? unknowns.map((u) => u === 'x' || u === 'z') : unknowns.map(() => false);
      // Lifted: one more column per other axis, its displacement times the lift's.
      const liftOn = unknowns.map((u, a) => lifted && a !== liftAxis);
      // And the hinges' own lift terms, when both.
      const columns = (d) => [1, ...d, ...d.filter((_, a) => hinged[a]).map(hingeOf),
        ...d.filter((_, a) => liftOn[a]).map((x) => x * d[liftAxis]),
        ...d.filter((_, a) => lifted && hinged[a]).map((x) => hingeOf(x) * d[liftAxis])];
      const fit = (ps) => solvePosition(ps.map(([d, v]) => ({ jacobian: columns(d), reference: 0, measured: v })));
      let f = fit(pts);
      /*
       * A reading whose frames do not pin a one-sided slope -- every frame
       * on one side of flush lost -- is not dropped: it is fitted without
       * hinges, as joint would. Dropped, it took a whole pair of a view out
       * of the solve (four of 24 readings in one render, six in another).
       */
      if (!f.determined && hinged.some(Boolean)) { hinged.fill(false); f = fit(pts); }
      if (!f.determined) continue;
      const resid = (ps, q) => ps.map(([d, v]) => v - columns(d).reduce((acc, x, a) => acc + x * q[a], 0));
      const r0 = resid(pts, f.d).map(Math.abs).sort((a, b) => a - b);
      const cut = Math.max(0.05, 3 * 1.4826 * r0[(r0.length - 1) >> 1]);
      const kept = pts.filter((_, i) => Math.abs(resid([pts[i]], f.d)[0]) <= cut);
      if (kept.length < pts.length) { const g = fit(kept); if (g.determined) f = g; }
      /*
       * How well a straight model describes this reading over the frames it
       * was fitted to, in px: 0.016 to 0.13 on the stack. A diagnostic only.
       * Weighting the solve by it was tried and made every axis worse (x
       * 0.19 -> 0.33 mm, the turn 0.06 -> 0.29 degrees): the readings it
       * marks down are the end readings, and they carry the turn.
       */
      const rk = resid(kept, f.d);
      const fitRms = Math.sqrt(rk.reduce((acc, x) => acc + x * x, 0) / Math.max(1, kept.length - f.d.length));
      let h = 1 + unknowns.length;
      const hinge = hinged.map((on) => (on ? f.d[h++] : 0));
      const lift = liftOn.map((on) => (on ? f.d[h++] : 0));
      const liftHinge = hinged.map((on) => (lifted && on ? f.d[h++] : 0));
      out.set(key, { ...truth, reference: f.d[0], jacobian: f.d.slice(1, 1 + unknowns.length),
        ...(hinged.some(Boolean) ? { hinge } : {}), ...(lifted ? { lift } : {}),
        ...(lifted && hinged.some(Boolean) ? { liftHinge } : {}),
        calibration: { frames: pts.length, kept: kept.length, rms: fitRms } });
    } else if (mode === 'reference') {
      const at = unknowns.flatMap((u) => valuesOf(u).filter(([x]) => x === 0).map(([, v]) => v));
      if (at.length === 0) continue;
      out.set(key, { ...truth, reference: at.reduce((s, v) => s + v, 0) / at.length });
    } else if (mode === 'full') {
      const lines = unknowns.map((u) => fitLine(valuesOf(u)));
      if (lines.some((l) => l === null)) continue;
      out.set(key, { ...truth, jacobian: lines.map((l) => l.slope),
        reference: lines.reduce((s, l) => s + l.at0, 0) / lines.length });
    } else {
      throw new Error(`calibrateReadings: mode is full, reference, joint or hinged, not ${mode}`);
    }
  }
  return out;
}

/** Every reading key the frames hold at these points, sorted. */
export function keysOf(sweepFrames, points = POINTS.both) {
  const keys = new Set();
  for (const { row } of sweepFrames) for (const p of points) keys.add(keyOf(row, p));
  return [...keys].sort();
}

/**
 * One pose from its readings, Huber-reweighted when `robust` > 0: a reading
 * further off than `robust` px keeps robust/|r| of its weight, five rounds
 * from the plain solve. With a prior, the readings' weights are made
 * absolute first -- `readingSigma` px for a reading whose own sigma is
 * `medianSigma` -- since a prior in millimetres is weighed against them.
 */
export function robustSolve(obs0, { prior = null, robust = 0, medianSigma = 1, readingSigma = 0.1,
  liftAxis = 1, hingeOf = hingeFor(false) } = {}) {
  const obs = prior ? obs0.map((o) => ({ ...o, weight: (o.weight ?? 1) * sq(medianSigma / readingSigma) })) : obs0;
  let s = solveLifted(obs, { prior, liftAxis });
  if (!(robust > 0)) return s;
  for (let round = 0; round < 5 && s.determined; round++) {
    const w = obs.map((o) => {
      if (!Number.isFinite(o.measured)) return o;
      const r = Math.abs(o.measured - modelAt(o, s.d, { hingeOf, liftAxis }));
      return { ...o, weight: (o.weight ?? 1) * (r > robust ? robust / r : 1) };
    });
    const next = solveLifted(w, { prior, liftAxis });
    if (!next.determined) break;
    s = { ...next, residualRms: s.residualRms };
  }
  return s;
}

/**
 * A pose from one frame's readings, or why not.
 *
 * Refused three ways. Not determined. Determined, but from readings that
 * barely separate the unknowns: the UNWEIGHTED sigma -- millimetres per pixel
 * of reading error -- over `maxSigma` (the weighted solve's own sigma is
 * scaled by 1/gapSigma^2 and refused nothing: the stack's two 50-degree
 * views solved a pose 5 mm off from two pairs, the twentieth). And when its
 * readings disagree with it by more than `maxResidual` px RMS (three pairs of
 * a part turned past the pairing limit solved 98 mm off, the twenty-third).
 *
 * @param {object[]} used calibrated readings (calibrateReadings' values)
 * @param {Map<string, object>} readings this frame's, keyed (readingsOf's per point)
 * @param {object} o
 * @param {(r: object) => number | null} o.pick the value to use from a reading
 * @param {(r: object) => number | null} [o.sigmaOf] its gapSigma, for weights
 * @param {'sigma' | 'none'} [o.weights]
 * @param {number} [o.maxSigma] mm (or degrees) per px of reading error, at most
 * @param {number} [o.maxResidual] px RMS, at most
 * @param {{d: number[], covariance: number[][]} | null} [o.prior] see robustSolve
 * @param {number} [o.robust] see robustSolve
 * @param {number} [o.medianSigma] see robustSolve
 * @param {number} [o.readingSigma] see robustSolve
 * @param {number} [o.liftAxis]
 * @param {(x: number) => number} [o.hingeOf]
 * @returns {{solution: object, refused: null | 'undetermined' | 'geometry' | 'residual'}}
 */
export function solvePose(used, readings, { pick, sigmaOf = () => null, weights = 'sigma', maxSigma = 10,
  maxResidual = Infinity, ...solveOptions }) {
  /*
   * Weighted by the reading's gapSigma. Not because sigma predicts the error
   * -- reading by reading it hardly does, a rank correlation of 0.34 -- but
   * it is lowest where a gap is wide and its edges long, and among the
   * readings of ONE pose that is enough (design-lab-model.md §5, "An
   * eleventh").
   */
  const obs = used.map((p) => {
    const r = readings.get(p.key);
    const sigma = sigmaOf(r);
    return { jacobian: p.jacobian, hinge: p.hinge, lift: p.lift, liftHinge: p.liftHinge, reference: p.reference, measured: r ? pick(r) : null,
      weight: weights === 'sigma' && sigma > 0 ? 1 / (sigma * sigma) : 1 };
  });
  const s = robustSolve(obs, solveOptions);
  const geometry = solvePosition(obs.filter((o) => Number.isFinite(o.measured))
    .map((o) => ({ jacobian: o.jacobian, reference: 0, measured: 0 })));
  if (!s.determined) return { solution: s, refused: 'undetermined' };
  if (!geometry.determined || Math.max(...geometry.sigma) > maxSigma) return { solution: s, refused: 'geometry' };
  if (s.residualRms > maxResidual) return { solution: s, refused: 'residual' };
  return { solution: s, refused: null };
}

/* ---- a closed loop's frame ------------------------------------------- */

/** Seeded normal deviates: a robot's errors drawn repeatably, in a simulation. */
export function gaussians(seed) {
  let x = seed >>> 0;
  const u = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return (x + 0.5) / 4294967296; };
  return () => Math.sqrt(-2 * log(u())) * cos(2 * Math.PI * u());
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[(s.length - 1) >> 1] : null; };

/**
 * Each view's pairs by the angle they run at in the image, from the rows the
 * calibration was made from. gap-sweep numbers a run's pairs by angle within
 * that run, so a frame that lost one pair would call the other "1"; matching
 * on the angle keeps a reading the reading it was calibrated as.
 * @param {object[]} rows every row of every calibration sweep
 * @returns {Map<string, number>} `<view> / pair <n>` -> its median angle, degrees
 */
export function pairAngles(rows) {
  const angles = new Map();
  for (const r of rows) {
    if (r.pair == null || r.pairAngle == null) continue;
    const k = `${viewOf(r)} / pair ${r.pair}`;
    if (!angles.has(k)) angles.set(k, []);
    angles.get(k).push(r.pairAngle);
  }
  return new Map([...angles].map(([k, a]) => [k, median(a)]));
}

/** The calibrated pair a row is, by its angle, within 10 degrees; null if none. */
export function pairOf(r, angles) {
  let best = null;
  for (const [k, a] of angles) {
    if (!k.startsWith(`${viewOf(r)} / `)) continue;
    const d = Math.abs(((r.pairAngle - a + 90) % 180 + 180) % 180 - 90);
    if (d <= 10 && (!best || d < best.d)) best = { d, pair: Number(k.split(' pair ')[1]) };
  }
  return best?.pair ?? null;
}

/**
 * One frame's readings, the carried mode's -- tracked, else refit, else
 * detected -- keyed as the calibration keys them: `[value, sigma]`, or
 * `[null, sigma, [a, b]]` where a track could not tell a strip from one edge
 * and gives both hypotheses for the prior to choose between.
 * @param {object[]} rows gap-sweep's rows for this frame
 * @param {Map<string, number>} angles pairAngles of the calibration
 */
export function frameReadings(rows, angles) {
  const out = new Map();
  for (const r of rows) {
    if (r.pairAngle == null) continue;
    const pair = pairOf(r, angles);
    if (pair === null) continue;
    const pick = (truth, tracked, refit, detected, sigmaT, sigmaR) => (tracked != null ? [tracked, sigmaT]
      : refit != null ? [refit, sigmaR] : [detected, null]);
    const points = {
      mid: pick(r.trueGapPx, r.tracked?.gapPx, r.refit?.gapPx, r.pairFound ? r.measuredGapPx : null, r.tracked?.gapSigma, r.refit?.gapSigma),
      'end 1': pick(r.endsTruePx?.[0], r.tracked?.endsPx?.[0], r.refit?.endsPx?.[0], r.endsDetectedPx?.[0], r.tracked?.gapSigma, r.refit?.gapSigma),
      'end 2': pick(r.endsTruePx?.[1], r.tracked?.endsPx?.[1], r.refit?.endsPx?.[1], r.endsDetectedPx?.[1], r.tracked?.gapSigma, r.refit?.gapSigma),
    };
    for (const [p, v] of Object.entries(points)) {
      if (v[0] != null && Number.isFinite(v[0])) out.set(`${viewOf(r)} / pair ${pair} / ${p}`, v);
    }
    // A track that could not tell a strip from one edge: both readings, for
    // the prior to choose between (trackPair's `hypotheses`).
    if (r.tracked?.hypotheses?.length && r.tracked.gapPx == null && r.refit?.gapPx == null) {
      const at = { mid: (h) => h.gapPx, 'end 1': (h) => h.endsPx?.[0], 'end 2': (h) => h.endsPx?.[1] };
      for (const [p, f] of Object.entries(at)) {
        const key = `${viewOf(r)} / pair ${pair} / ${p}`;
        const hs = r.tracked.hypotheses.map(f).filter((v) => v != null && Number.isFinite(v));
        if (!out.has(key) && hs.length === 2) out.set(key, [null, r.tracked.hypotheses[0].gapSigma, hs]);
      }
    }
  }
  return out;
}

/**
 * The prior a frame is solved against: the last solution moved by the move
 * commanded since, its covariance grown by the move's own variance.
 * @param {{d: number[], covariance: number[][]}} state
 * @param {number[]} move
 * @param {number[]} motionVariance per unknown
 */
export function carryForward(state, move, motionVariance) {
  return { d: state.d.map((v, a) => v + move[a]),
    covariance: state.covariance.map((row, a) => row.map((x, b) => x + (a === b ? motionVariance[a] : 0))) };
}

/**
 * One frame of a closed loop: the pose from this frame's readings and the
 * prior, a calibration made by calibrateReadings (as saved: `calibrated`,
 * `medianSigma`, `reference`).
 *
 * A reading's weight is absolute -- `readingSigma` px for a reading whose
 * gapSigma is the calibration's median -- since the prior is in millimetres.
 * A reading given as two hypotheses is taken where the prior predicts one of
 * them: the prediction, with its own uncertainty through the Jacobian and the
 * reading's, must be nearer one by three sigmas; otherwise it is left out.
 *
 * @returns {{solution: object, alone: object, observations: object[], hypotheses: {resolved: number, unresolved: number}}}
 *   `solution` with the prior, `alone` without it (unweighted), both in
 *   displacement from the calibration's reference pose
 */
export function estimatePose(calibration, readings, prior, { readingSigma = 0.1, movingBelow = calibration.movingBelow ?? false } = {}) {
  const used = calibration.calibrated;
  const hingeOf = hingeFor(movingBelow);
  const weightOf = (sigma) => {
    const rel = sigma > 0 && calibration.medianSigma ? sigma / calibration.medianSigma : 1;
    return 1 / sq(readingSigma * rel);
  };
  const obs = used.map((p) => {
    const v = readings.get(p.key);
    return { jacobian: p.jacobian, hinge: p.hinge, lift: p.lift, liftHinge: p.liftHinge, reference: p.reference, measured: v ? v[0] : null, weight: weightOf(v?.[1]) };
  });
  let resolved = 0, unresolved = 0;
  for (const [i, p] of used.entries()) {
    const v = readings.get(p.key);
    if (!v?.[2]) continue;
    const predicted = modelAt(p, prior.d, { hingeOf, liftAxis: 1 });
    const jp = p.jacobian.map((_, a) => prior.covariance[a].reduce((acc, c, b) => acc + c * p.jacobian[b], 0));
    const sigma = Math.sqrt(p.jacobian.reduce((acc, j, a) => acc + j * jp[a], 0) + sq(readingSigma));
    const [near, far] = [...v[2]].sort((x, y) => Math.abs(x - predicted) - Math.abs(y - predicted));
    if (Math.abs(far - predicted) - Math.abs(near - predicted) >= 3 * sigma) { obs[i].measured = near; resolved++; } else unresolved++;
  }
  const solution = solveLifted(obs, { prior });
  const alone = solveLifted(obs.map((o) => ({ ...o, weight: 1 })));
  return { solution, alone, observations: obs, hypotheses: { resolved, unresolved } };
}
