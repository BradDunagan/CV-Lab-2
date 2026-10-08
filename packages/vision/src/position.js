/**
 * Where one part is relative to another, from several gap readings.
 *
 * A gap between two facing edges is ONE number, and a part's position is
 * three. Worse, the one number mixes them: lift the top cube of a stack and
 * the gap a pair sees opens; slide it toward the camera and, seen from above,
 * the same gap opens too. From one pair in one view the two are the same
 * reading. A second pair at an angle sees a different mixture, and so does the
 * same pair from another view, and with enough different mixtures the three
 * come apart. That is all this does.
 *
 * THE MODEL
 *
 * Near a reference pose, each reading is linear in the displacement d:
 *
 *     gap_i = reference_i + jacobian_i . d
 *
 * `jacobian_i` is how many pixels reading i moves per millimetre of
 * displacement along each axis. It is measured, not derived: the slope of the
 * TRUE gap along a sweep of each axis, which the renderer supplies. So the
 * solve needs no camera model, and it is only as good as "linear" is over the
 * range it is used in -- perspective bends it, a little.
 *
 * WHAT THE SIGMAS ARE
 *
 * `sigma` is the other half of the answer and the half that needs no
 * measurement at all: how many millimetres of error each axis gets per pixel
 * of error in the readings, sqrt(diag((J'J)^-1)). It is a property of WHICH
 * pairs and views were combined, known before anything is detected, and it is
 * what says whether a set of views is worth using. A direction no reading
 * responds to makes J'J singular; then there is no answer, and `determined` is
 * false rather than the answer being a large number.
 *
 * Pure JavaScript and exact arithmetic on the way: sums in the order given,
 * elimination in a fixed order.
 */

import { solve } from './pairs.js';

/**
 * @param {{jacobian: number[], reference: number, measured: number, weight?: number}[]} observations
 *   `jacobian` in px per mm along each axis; `reference` and `measured` in px;
 *   `weight` multiplies that observation's squared residual (default 1).
 * @param {{prior?: {d: number[], covariance: number[][]}}} [options]
 *   `prior`: what is already known of the displacement -- carried from the
 *   previous frame -- as a mean and a covariance, in the unknowns' own units.
 *   It counts as one more set of observations, of d itself; with it, weights
 *   must be absolute (1 / variance in px^2), or the two cannot be balanced.
 * @returns {{determined: boolean, d: number[]|null, sigma: number[]|null,
 *            covariance: number[][]|null, residualRms: number|null,
 *            observations: number, reason: string|null}}
 */
function solvePosition(observations, { prior = null } = {}) {
  const obs = observations.filter((o) => Number.isFinite(o.measured) && Number.isFinite(o.reference)
    && o.jacobian.every(Number.isFinite));
  const n = obs.length;
  const k = n > 0 ? obs[0].jacobian.length : prior ? prior.d.length : 0;
  const none = (reason) => ({ determined: false, d: null, sigma: null, covariance: null, residualRms: null,
    observations: n, reason });
  if (n === 0 && !prior) return none('no readings');
  if (n < k && !prior) return none(`${n} reading${n === 1 ? '' : 's'} for ${k} unknowns`);

  const JtJ = Array.from({ length: k }, () => new Array(k).fill(0));
  const Jtr = new Array(k).fill(0);
  for (const o of obs) {
    const w = o.weight ?? 1;
    const r = o.measured - o.reference;
    for (let a = 0; a < k; a++) {
      Jtr[a] += w * o.jacobian[a] * r;
      for (let b = 0; b < k; b++) JtJ[a][b] += w * o.jacobian[a] * o.jacobian[b];
    }
  }
  /*
   * The prior is d observed directly, with the prior's covariance: its
   * information matrix joins the readings' and its mean the right-hand side.
   * A singular covariance is refused rather than inverted.
   */
  if (prior) {
    const info = prior.covariance.map((row) => row.slice());
    const eye = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (__, b) => (a === b ? 1 : 0)));
    const inv = [];
    for (let c = 0; c < k; c++) {
      const col = eye.map((row) => row[c]);
      if (!solve(info.map((row) => row.slice()), col, 1e-300)) return none('the prior\'s covariance is singular');
      inv.push(col);
    }
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < k; b++) {
        JtJ[a][b] += inv[b][a];
        Jtr[a] += inv[b][a] * prior.d[b];
      }
    }
  }

  /*
   * Scaled to a unit diagonal before anything is solved, so that "singular"
   * is about the readings and not about units. An axis no reading responds to
   * has a zero diagonal, and is named.
   */
  const scale = JtJ.map((row, a) => Math.sqrt(row[a]));
  const blind = scale.findIndex((s) => !(s > 0));
  if (blind >= 0) return none(`no reading responds to axis ${blind}`);
  const scaled = () => JtJ.map((row, a) => row.map((x, b) => x / (scale[a] * scale[b])));

  const rhs = Jtr.map((x, a) => x / scale[a]);
  // 1e-6 on a unit diagonal: two readings whose mixtures differ by less than
  // a part in a thousand are, for this purpose, the same reading.
  if (!solve(scaled(), rhs, 1e-6)) return none('the readings do not separate the axes');
  const d = rhs.map((x, a) => x / scale[a]);

  const covariance = [];
  for (let a = 0; a < k; a++) {
    const e = new Array(k).fill(0); e[a] = 1;
    if (!solve(scaled(), e, 1e-6)) return none('the readings do not separate the axes');
    covariance.push(e.map((x, b) => x / (scale[a] * scale[b])));
  }
  const sigma = covariance.map((row, a) => Math.sqrt(row[a]));

  let sse = 0;
  for (const o of obs) {
    let r = o.measured - o.reference;
    for (let a = 0; a < k; a++) r -= o.jacobian[a] * d[a];
    sse += r * r;
  }
  return { determined: true, d, sigma, covariance, residualRms: n ? Math.sqrt(sse / n) : null, observations: n, reason: null };
}

/**
 * The same, for readings that bend at zero: `hinge[a]` adds hinge[a] *
 * min(d[a], 0) to an observation's model, a slope that applies on one side
 * only. A ledge does that -- slid back past flush, the still part's face
 * shows beside the moving edge, in the moving part's soft shadow, and moves
 * that edge; slid the other way there is no ledge (design-lab-model.md §5,
 * "A nineteenth").
 *
 * Piecewise linear, so it is solved exactly on a side: first ignoring the
 * hinges (or on the prior's side), then on the side each axis came out on,
 * until no axis changes side. Observations with no hinge give solvePosition's
 * answer unchanged.
 */
function solveHinged(observations, { prior = null, iterations = 10 } = {}) {
  if (!observations.some((o) => o.hinge?.some((h) => h !== 0))) return solvePosition(observations, { prior });
  let side = prior ? prior.d.map((v) => v < 0) : null;
  let s = null;
  for (let it = 0; it < iterations; it++) {
    const lin = observations.map((o) => (!o.hinge || !side ? o
      : { ...o, jacobian: o.jacobian.map((j, a) => j + (side[a] ? o.hinge[a] ?? 0 : 0)) }));
    s = solvePosition(lin, { prior });
    if (!s.determined) return s;
    const next = s.d.map((v) => v < 0);
    if (side && next.every((v, a) => v === side[a])) return s;
    side = next;
  }
  return s;
}

/**
 * The same, for readings whose slopes depend on the lift: `lift[a]` adds
 * lift[a] * d[liftAxis] * d[a] to an observation's model. Seen from above
 * and at an angle, a sideways move opens a gap by an amount that depends on
 * how high the part is, so a Jacobian measured at one lift is wrong at
 * another -- by 0.06 to 0.10 mm in x at 1 mm up, calibrated at 4
 * (design-lab-model.md §5, "A twenty-seventh").
 *
 * Bilinear, so solved by Gauss-Newton: at the current estimate d0 the lift
 * term is replaced by its tangent, q(d0) + grad q(d0) . (d - d0), which for a
 * bilinear q is grad q(d0) . d - q(d0); that is solved as solveHinged solves
 * it, and repeated until the estimate stops moving. The covariance is the
 * last tangent's. Observations with no lift give solveHinged's answer.
 *
 * `liftHinge[a]` adds liftHinge[a] * d[liftAxis] * min(d[a], 0): the hinge's
 * one-sided slope changing with the lift too. The ledge it describes is in
 * the moving part's soft shadow, and how much of it shows, and how dark,
 * depends on the height (the twenty-seventh).
 */
function solveLifted(observations, { prior = null, liftAxis = 1, iterations = 20 } = {}) {
  const any = (v) => v?.some((l) => l !== 0);
  if (!observations.some((o) => any(o.lift) || any(o.liftHinge))) return solveHinged(observations, { prior });
  let d0 = prior ? prior.d.slice() : null;
  let s = null;
  for (let it = 0; it < iterations; it++) {
    const tangent = observations.map((o) => {
      if ((!o.lift && !o.liftHinge) || !d0) return o;
      const y = d0[liftAxis];
      let q = 0;
      const grad = o.jacobian.map(() => 0);
      for (let a = 0; a < o.jacobian.length; a++) {
        const l = o.lift?.[a] ?? 0;
        if (l !== 0) {
          q += l * y * d0[a];
          grad[a] += l * y;
          grad[liftAxis] += l * d0[a];
        }
        // The hinge's own lift term: liftHinge[a] * y * min(d[a], 0).
        const lh = o.liftHinge?.[a] ?? 0;
        if (lh !== 0 && d0[a] < 0) {
          q += lh * y * d0[a];
          grad[a] += lh * y;
          grad[liftAxis] += lh * d0[a];
        }
      }
      return { ...o, jacobian: o.jacobian.map((j, a) => j + grad[a]), reference: o.reference - q };
    });
    s = solveHinged(tangent, { prior });
    if (!s.determined) return s;
    const moved = d0 ? Math.max(...s.d.map((v, a) => Math.abs(v - d0[a]))) : Infinity;
    d0 = s.d;
    if (moved < 1e-9) break;
  }
  // The residual against the model itself, not the last tangent.
  const obs = observations.filter((o) => Number.isFinite(o.measured) && Number.isFinite(o.reference));
  let sse = 0;
  for (const o of obs) {
    let m = o.reference;
    for (let a = 0; a < o.jacobian.length; a++) {
      m += o.jacobian[a] * d0[a] + (o.hinge?.[a] ?? 0) * Math.min(d0[a], 0) + (o.lift?.[a] ?? 0) * d0[liftAxis] * d0[a]
        + (o.liftHinge?.[a] ?? 0) * d0[liftAxis] * Math.min(d0[a], 0);
    }
    sse += (o.measured - m) ** 2;
  }
  return { ...s, residualRms: obs.length ? Math.sqrt(sse / obs.length) : null };
}

export { solvePosition, solveHinged, solveLifted };
