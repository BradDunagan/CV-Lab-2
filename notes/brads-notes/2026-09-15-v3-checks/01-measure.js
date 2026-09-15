'use strict';

// Everything the v3 comparison needs, for every detected segment in a set:
// match's verdict and the kind of truth edge it paired with, explain's cause,
// explain's residual at offsets 1.25 / 2.5 / 5, v1's raw depth difference at
// offsets 1 and 8 (09-10's growth test), and the 09-12 jump fit.
//
//   node 01-measure.js [helmet-256|helmet-512|clutter ...]     out/<set>.json
//
// Also checks, first, that the loader reproduces every stored explain record
// for the set -- on a set it has never been run on, that is not a formality.

const { REPO, VIEWS, SETS, loadView, verdicts, jumpFit, write } = require('./lib');
const { explainFeature, explainFeatures } = require(`${REPO}/src/lab/explain`);

const sets = process.argv.length > 2 ? process.argv.slice(2) : SETS;
for (const set of sets) {
  const t0 = Date.now();
  const rows = [];
  let total = 0, mismatch = 0, worst = 0;
  for (const name of VIEWS) {
    const v = loadView(name, set);
    const F = v.slots.get('F');
    const { EF, MF } = verdicts(v);
    const again = explainFeatures(F, v.rasters);
    F.forEach((f, i) => {
      total++;
      const stored = EF.get(f.id);
      if (again[i].cause !== stored.cause) mismatch++;
      worst = Math.max(worst, Math.abs(again[i].depthExcess - stored.depthExcess));
    });
    for (const f of F) {
      const e = EF.get(f.id), m = MF.get(f.id);
      const ex = {};
      for (const o of [1.25, 2.5, 5]) ex[o] = explainFeature(f, v.rasters, { offset: o }).depthExcess;
      rows.push({
        view: name, id: f.id, x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1, angle: f.angle, length: f.length,
        role: m.role, truthCause: m.cause, cause: e.cause, normalStep: e.normalStep, albedoStep: e.albedoStep,
        matchDistance: m.distance, matchAngle: m.angleDiff,
        ex,
        raw1: explainFeature(f, v.rasters, { offset: 1 }).depthStep,
        raw8: explainFeature(f, v.rasters, { offset: 8 }).depthStep,
        ...jumpFit(f, v.rasters.depth),
      });
    }
  }
  console.log(`${set}: reproduced ${total} explain records, ${mismatch} cause mismatches, worst depthExcess difference ${worst} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  if (mismatch > 0 || worst > 0) {
    console.error(`${set}: the loader does not see what explain saw; not writing out/${set}.json`);
    process.exitCode = 1;
    continue;
  }
  write(`${set}.json`, rows);
}
