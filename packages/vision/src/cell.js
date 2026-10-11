/**
 * A robot cell's calibration, from the frames it captures: the glue between
 * gap readings and calibrate.js that scripts/gap-sweep.js and
 * scripts/solve-position.js held, mixed with their files.
 *
 * A cell commands its own sweeps -- the moving part stepped along x, y and z
 * from a reference pose, and turned about the vertical -- and captures every
 * view at every step. From the frames' rows (gapRows, numbered per view
 * here), carryPlan reads each pair again with the still edge held, pooled
 * across the sweeps (`poolCandidates`); `sweepFrames` puts each frame at the
 * step it was commanded to; calibrateReadings fits each reading's model; and
 * each later frame is solved for where the part is (`posesFrom`, solvePose).
 * No truth is needed anywhere: the commanded steps are what the readings are
 * calibrated against.
 *
 * Rows here are gap-sweep's: gapRows' fields, plus the shot's view (`yaw`,
 * `elevation`) and, for a frame at a pose rather than a step, `pose`,
 * `poseMm`, `turnDeg`, `tipDeg`. design-lab-model.md §5 says why each step is.
 */

import { numberPairs } from './gapsweep.js';
import { ANGLES, POINTS, keyOf, readingsOf, calibrateReadings, solvePose, hingeFor } from './calibrate.js';

/** The translational unknowns, in millimetres, in this order. */
export const AXES = ['x', 'y', 'z'];

/**
 * A run's rows, each view's pairs numbered by the angle they run at
 * (gapsweep.js numberPairs), so that pair 1 is one pair down the run even
 * through the frames that lost the other. Rows keep their order.
 * @param {object[]} rows every frame's gapRows, with the view's `yaw` and `elevation`
 */
export function numberByView(rows) {
  const viewOf = (r) => `${r.yaw ?? ''},${r.elevation ?? ''}`;
  const numbered = new Map([...new Set(rows.map(viewOf))]
    .map((v) => [v, numberPairs(rows.filter((r) => viewOf(r) === v))]));
  const taken = new Map();
  return rows.map((r) => {
    const k = taken.get(viewOf(r)) ?? 0;
    taken.set(viewOf(r), k + 1);
    return numbered.get(viewOf(r))[k];
  });
}

/**
 * A row's two edges as fitPairs placed them: its record among the frame's
 * fitted pairs (the P slot), and which of the record's edges is the moving
 * part's and which the still one's. detectedPair is [moving, target]; the
 * record's edges name segments. Null when the frame has no such record.
 * @param {object} row a gapRows row whose refit came from a pair
 * @param {object[]} fitted the frame's fitPairs records
 */
export function fittedEdges(row, fitted) {
  const record = (fitted ?? []).find((p) => p.id === row.refit.pair);
  if (!record) return null;
  const [moving, still] = record.a.segment === row.detectedPair[1] ? [record.b, record.a] : [record.a, record.b];
  return { record, moving, still };
}

/** Whether carryPlan may carry from this row: a refit of two detected edges at least carryMin px apart, with no ledge. */
export const carriable = (row, { carryMin, ledgeMax }) => row?.refit?.from === 'pair' && row.refit.gapPx >= carryMin
  && !(row.refit.ledge?.gain >= ledgeMax);

/**
 * Another run's frames as candidates for carryPlan's `pooled`: each frame
 * whose refit can be carried from, with its edges placed. carryPlan then
 * matches them to its own pairs by view and the angle they run at.
 * @param {object[]} rows the other run's numbered rows
 * @param {(row: object) => {name: string, fitted: object[] | null} | null} frameOf
 *   the frame a row came from: its shot name and its fitPairs records
 * @param {{carryMin: number, ledgeMax: number}} opts
 * @param {string} run what the plan calls the other run in its sources
 */
export function poolCandidates(rows, frameOf, opts, run) {
  const out = [];
  for (const row of rows) {
    if (!carriable(row, opts)) continue;
    const frame = frameOf(row);
    if (!frame) continue;
    const edges = fittedEdges(row, frame.fitted);
    if (!edges) continue;
    const view = row.yaw === undefined ? null : { yaw: row.yaw, elevation: row.elevation };
    out.push({ view: `${row.yaw ?? ''},${row.elevation ?? ''}`, pairAngle: row.pairAngle,
      s: { name: frame.name, gapMm: row.gapMm, run, ...(view ? { view } : {}) },
      row, record: edges.record, moving: edges.moving, still: edges.still });
  }
  return out;
}

/* ---- from frames to a calibration ------------------------------------- */

/** A row's angle for one angular unknown, degrees. */
export const angleOf = (u, r) => (u === 'turn' ? r.turnDeg ?? 0 : r.tipDeg?.[u === 'tipx' ? 0 : 1] ?? 0);

/**
 * How far along its sweep a frame was commanded: the step along the sweep's
 * own axis, which may run either way (a part below the still one is swept
 * down, and slid along -x and -z to mirror one above), or its angle.
 * @param {string} u the unknown the sweep moved along
 * @param {object} r the frame's row
 * @param {number[]} [axis] the sweep's axis, mm per step
 */
export const sweepStep = (u, r, axis) => (ANGLES.includes(u) ? angleOf(u, r) : r.gapMm * (axis?.[AXES.indexOf(u)] ?? 1));

/** A run's rows that read a pair. */
export const pairRows = (rows) => rows.filter((r) => r.pair !== null && r.pair !== undefined);

/**
 * Every frame of every sweep, with the step it was commanded to, as
 * calibrateReadings takes them: sweep by sweep in `unknowns` order.
 * @param {Record<string, {rows: object[], axis?: number[]}>} sweeps by unknown
 * @param {string[]} unknowns
 */
export function sweepFrames(sweeps, unknowns) {
  return unknowns.flatMap((u) => pairRows(sweeps[u].rows).map((row) => ({ sweep: u, step: sweepStep(u, row, sweeps[u].axis), row })));
}

/**
 * Frames grouped into poses: one per pose (or, in a sweep, per step and
 * angle), every view's readings at each point keyed as the calibration keys
 * them, and the pose's displacement from the reference.
 * @param {object[]} rows
 * @param {(row: object) => number[]} displacementFor
 * @param {string[]} points POINTS[...]
 * @returns {{d: number[], label: null, readings: Map<string, object>}[]}
 */
export function posesFrom(rows, displacementFor, points) {
  const groups = new Map();
  for (const r of rows) {
    const id = r.pose ?? `${r.gapMm}/${r.turnDeg ?? 0}/${r.tipDeg ?? ''}`;
    if (!groups.has(id)) groups.set(id, { d: displacementFor(r), label: null, readings: new Map() });
    for (const p of points) groups.get(id).readings.set(keyOf(r, p), readingsOf(r)[p]);
  }
  return [...groups.values()];
}

/** The pair fit's reading, else the detections'. */
export const refitPick = (r) => r.refit ?? r.detected;
/** A --carry run's tracked reading first: the still edge held where a frame without a ledge read it (the fifteenth). */
export const carriedPick = (r) => r.tracked ?? r.refit ?? r.detected;

/**
 * A reading's gapSigma for weighing it, as the pick took it: the track's for
 * a tracked reading, the refit's for a refit one, none for a detection or the
 * truth.
 */
export const pickSigma = (pick, r) => (pick === carriedPick && r?.tracked != null ? r.trackedSigma
  : (pick === refitPick || pick === carriedPick) && r?.refit != null ? r.sigma : null);

/**
 * The median gapSigma of the calibration frames, tracked and refit together:
 * what a reading's weight is made absolute against, when it is weighed
 * against a prior. Null when there is none.
 * @param {object[]} rows every calibration frame's row
 */
export function medianGapSigma(rows) {
  const sigmas = rows.flatMap((r) => [r.tracked?.gapSigma, r.refit?.gapSigma]).filter((v) => v > 0).sort((a, b) => a - b);
  return sigmas.length ? sigmas[(sigmas.length - 1) >> 1] : null;
}

/* ---- a cell: calibrate once, then solve each frame -------------------- */

/**
 * A calibration from a cell's own sweeps, in the form solve-position's
 * --save-calibration writes and estimatePose reads: per reading, the carried
 * mode's reference and Jacobian (and hinges), fitted by `mode` -- joint or
 * hinged, from what was read, with no truth.
 *
 * @param {object} c
 * @param {Record<string, {rows: object[], axis?: number[]}>} c.sweeps each
 *   sweep's numbered rows, by the unknown it moved along: x, y and z, and
 *   optionally turn, tipx, tipz. Every frame of a sweep is at the reference
 *   pose but for that one unknown
 * @param {'joint' | 'hinged'} [c.mode] hinged by default
 * @param {'mid' | 'ends' | 'both'} [c.readings] where along each pair; both by default
 * @param {boolean} [c.movingBelow] the moving part is below the still one
 * @returns {{unknowns: string[], calibrate: string, readings: string, movingBelow?: true,
 *   medianSigma: number | null, calibrated: object[]}}
 */
export function calibrateCell({ sweeps, mode = 'hinged', readings = 'both', movingBelow = false }) {
  if (!AXES.every((a) => sweeps[a])) throw new Error('calibrateCell: an x, a y and a z sweep are needed');
  if (mode !== 'joint' && mode !== 'hinged') throw new Error(`calibrateCell: mode is joint or hinged, not ${mode}`);
  const unknowns = [...AXES, ...ANGLES.filter((u) => sweeps[u])];
  const frames = sweepFrames(sweeps, unknowns);
  const calibrated = calibrateReadings({ sweepFrames: frames, unknowns, mode, pick: carriedPick,
    points: POINTS[readings], hingeOf: hingeFor(movingBelow), liftAxis: unknowns.indexOf('y') });
  return {
    unknowns, calibrate: mode, readings,
    ...(movingBelow ? { movingBelow: true } : {}),
    medianSigma: medianGapSigma(unknowns.flatMap((u) => pairRows(sweeps[u].rows))),
    calibrated: [...calibrated.values()].map(({ key, view, jacobian, hinge, reference, calibration }) => ({
      key, view, jacobian, ...(hinge ? { hinge } : {}), reference, ...(calibration ? { calibration } : {}) })),
  };
}

/**
 * Where the part is in one frame -- every view captured at one pose -- from
 * a calibrateCell calibration: its displacement from the reference pose, one
 * value per unknown (mm, or degrees for an angle), or why it was refused.
 * Solved as solve-position solves a test pose: the carried readings, each
 * weighed by 1/gapSigma^2, refused when the readings barely separate the
 * unknowns (`maxSigma` mm or degrees per px of reading error) or disagree
 * with the solution by more than `maxResidual` px RMS.
 *
 * @param {ReturnType<typeof calibrateCell>} calibration
 * @param {object[]} rows the frame's rows, numbered with the calibration's frames
 *   so that its pairs are the calibration's
 * @param {{weights?: 'sigma' | 'none', maxSigma?: number, maxResidual?: number}} [o]
 * @returns {{d: number[] | null, sigma: number[] | null, residualRms: number | null,
 *   refused: null | 'undetermined' | 'geometry' | 'residual', readings: number}}
 */
export function solveCell(calibration, rows, { weights = 'sigma', maxSigma = 10, maxResidual = Infinity } = {}) {
  const [pose] = posesFrom(pairRows(rows).map((r) => ({ ...r, pose: 'this frame' })), () => null, POINTS[calibration.readings]);
  if (!pose) return { d: null, sigma: null, residualRms: null, refused: 'undetermined', readings: 0 };
  const { solution: s, refused } = solvePose(calibration.calibrated, pose.readings, {
    pick: carriedPick, sigmaOf: (r) => pickSigma(carriedPick, r), weights, maxSigma, maxResidual,
    medianSigma: calibration.medianSigma ?? 1, liftAxis: calibration.unknowns.indexOf('y'),
    hingeOf: hingeFor(calibration.movingBelow ?? false),
  });
  const used = calibration.calibrated.filter((p) => {
    const r = pose.readings.get(p.key);
    return r && Number.isFinite(carriedPick(r));
  }).length;
  return { d: s.determined ? s.d : null, sigma: s.determined ? s.sigma : null,
    residualRms: s.determined ? s.residualRms : null, refused, readings: used };
}
