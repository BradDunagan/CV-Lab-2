'use strict';

// The 88: invented segments that explain v2 calls occlusion.
//
// First proves the loader is the same apparatus -- every stored explain record
// recomputed, cause and depthExcess compared -- then pulls the 88 out with
// what match and explain said about each, and prints the first reading: most
// of them are close to truth and fail match on angle.
//
//   out/the88.json

const { REPO, VIEWS, loadView, verdicts, quantile, write } = require('./load');
const { explainFeatures } = require(`${REPO}/src/lab/explain`);

const the88 = [];
let total = 0, causeMismatch = 0, worst = 0;
for (const name of VIEWS) {
  const v = loadView(name);
  const F = v.slots.get('F'), EF = v.slots.get('EF');
  const again = explainFeatures(F, v.rasters);
  for (let i = 0; i < EF.length; i++) {
    total++;
    if (again[i].cause !== EF[i].cause) causeMismatch++;
    worst = Math.max(worst, Math.abs(again[i].depthExcess - EF[i].depthExcess));
  }
  const { MF } = verdicts(v);
  for (const e of EF) {
    const m = MF.get(e.id);
    if (m.role !== 'false-positive' || e.cause !== 'occlusion') continue;
    the88.push({ view: name, id: e.id, length: e.length, x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1, angle: e.angle,
      depthStep: e.depthStep, planeStep: e.planeStep, depthExcess: e.depthExcess, slant: e.slant,
      normalStep: e.normalStep, albedoStep: e.albedoStep, matchDistance: m.distance, matchAngle: m.angleDiff });
  }
}
console.log(`reproduced ${total} explain records: ${causeMismatch} cause mismatches, worst depthExcess difference ${worst}`);
if (causeMismatch > 0 || worst > 0) {
  console.error('the loader no longer sees what explain saw -- results/ or src/lab/explain.js has changed since 09-12; nothing downstream means anything');
  process.exit(1);
}
write('the88.json', the88);
console.log(`the 88: ${the88.length}`);
console.log('\n                p10     p25     p50     p75     p90');
for (const k of ['length', 'depthStep', 'depthExcess', 'planeStep', 'slant', 'normalStep', 'matchDistance', 'matchAngle']) {
  console.log(k.padEnd(14), [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => quantile(the88.map((r) => r[k]), p).toFixed(3).padStart(7)).join(' '));
}
const near = the88.filter((r) => r.matchDistance <= 3);
console.log(`\nwithin 3 px of visible truth, so failed on angle: ${near.length}   further than 3 px: ${the88.length - near.length}`);
