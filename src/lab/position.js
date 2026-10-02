'use strict';

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

const { solve } = require('./pairs');

/**
 * @param {{jacobian: number[], reference: number, measured: number, weight?: number}[]} observations
 *   `jacobian` in px per mm along each axis; `reference` and `measured` in px;
 *   `weight` multiplies that observation's squared residual (default 1).
 * @returns {{determined: boolean, d: number[]|null, sigma: number[]|null,
 *            residualRms: number|null, observations: number, reason: string|null}}
 */
function solvePosition(observations) {
  const obs = observations.filter((o) => Number.isFinite(o.measured) && Number.isFinite(o.reference)
    && o.jacobian.every(Number.isFinite));
  const n = obs.length;
  const k = n > 0 ? obs[0].jacobian.length : 0;
  const none = (reason) => ({ determined: false, d: null, sigma: null, residualRms: null, observations: n, reason });
  if (n === 0) return none('no readings');
  if (n < k) return none(`${n} reading${n === 1 ? '' : 's'} for ${k} unknowns`);

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

  const sigma = [];
  for (let a = 0; a < k; a++) {
    const e = new Array(k).fill(0); e[a] = 1;
    if (!solve(scaled(), e, 1e-6)) return none('the readings do not separate the axes');
    sigma.push(Math.sqrt(e[a]) / scale[a]);
  }

  let sse = 0;
  for (const o of obs) {
    let r = o.measured - o.reference;
    for (let a = 0; a < k; a++) r -= o.jacobian[a] * d[a];
    sse += r * r;
  }
  return { determined: true, d, sigma, residualRms: Math.sqrt(sse / n), observations: n, reason: null };
}

module.exports = { solvePosition };
