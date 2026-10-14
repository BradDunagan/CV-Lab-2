'use strict';

/**
 * Single-edge readings (packages/vision/src/edges.js): the moving part's lone
 * edges, each read against an anchor fixed in the image.
 *
 * The records are built by hand -- truth, matches, fitted edges -- so each
 * answer is arithmetic: an edge drawn 0.3 px past its anchor reads 0.3.
 *
 *   node test/edges.js
 */

const assert = require('node:assert/strict');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}
const near = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual}, expected ${expected} ± ${tol}`);

/** A visible truth edge of `part` from (x0, y0) to (x1, y1). */
function gt(id, part, x0, y0, x1, y1, cause = 'silhouette') {
  const dx = x1 - x0, dy = y1 - y0;
  const angle = (((Math.atan2(dy, dx) * 180) / Math.PI) % 180 + 180) % 180;
  return { type: 'gt-edge', id, cause, objects: [part], x0, y0, x1, y1, length: Math.hypot(dx, dy), angle, visible: 1 };
}
/** A fitted edge on segment `segment`, and the match that ties it to truth `truth`. */
const fitted = (segment, x0, y0, x1, y1) => ({ type: 'edge-line', segment, x0, y0, x1, y1, sigma: 0.01 });
const hit = (detected, truth) => ({ type: 'edge-match', role: 'hit', detected, truth });

(async () => {
  const { edgeRows, EDGE_BASE } = await import('../packages/vision/src/edges.js');
  const { frameReadings, pairAngles } = await import('../packages/vision/src/calibrate.js');
  console.log('cv-lab-2 edge tests');

  await test('an edge reads its distance from its anchor; a later frame reads against the same anchor', () => {
    const one = edgeRows({ truth: [gt(1, 'top', 100, 100, 200, 100)], matches: [hit(7, 1)], edges: [fitted(7, 102, 100.3, 198, 100.3)] }, 'top');
    assert.equal(one.rows.length, 1);
    const [r] = one.rows;
    assert.equal(r.pair, EDGE_BASE + 1);
    assert.equal(r.edge, true);
    near(r.refit.gapPx, 0.3, 1e-12, 'fitted, from the anchor the truth made');
    near(r.trueGapPx, 0, 1e-12, 'truth, from its own line');
    for (const e of r.refit.endsPx) near(e, 0.3, 1e-12, 'a sixth in from each end');
    assert.equal(one.anchors.length, 1);
    // Moved 1 px across, read 0.2 px beyond that: against the first frame's anchor, not its own.
    const two = edgeRows({ truth: [gt(4, 'top', 100, 101, 200, 101)], matches: [hit(9, 4)], edges: [fitted(9, 101, 101.2, 199, 101.2)] }, 'top', one.anchors);
    assert.equal(two.rows[0].pair, EDGE_BASE + 1);
    near(two.rows[0].refit.gapPx, 1.2, 1e-12, 'moved, fitted');
    near(two.rows[0].trueGapPx, 1, 1e-12, 'moved, truth');
    assert.equal(two.anchors.length, 1, 'no new anchor');
    assert.equal(one.anchors.length, 1, 'the anchors passed in are not changed');
  });

  await test('two parallel edges of one part keep their own numbers as they move', () => {
    const frame = (dy) => ({
      truth: [gt(1, 'top', 100, 100 + dy, 200, 100 + dy), gt(2, 'top', 100, 150 + dy, 200, 150 + dy)],
      matches: [hit(5, 1), hit(6, 2)],
      edges: [fitted(5, 100, 100 + dy, 200, 100 + dy), fitted(6, 100, 150 + dy, 200, 150 + dy)],
    });
    const first = edgeRows(frame(0), 'top');
    // The second frame lists them the other way round; each still finds its own anchor.
    const f = frame(2);
    const second = edgeRows({ ...f, truth: [...f.truth].reverse(), edges: [...f.edges].reverse() }, 'top', first.anchors);
    const byPair = new Map(second.rows.map((r) => [r.pair, r.refit.gapPx]));
    near(byPair.get(EDGE_BASE + 1), 2, 1e-12, 'the upper edge');
    near(byPair.get(EDGE_BASE + 2), 2, 1e-12, 'the lower edge');
    assert.equal(second.anchors.length, 2);
  });

  await test('an edge with another within 4 px beside it is one of a pair, and gives no row', () => {
    const top = gt(1, 'top', 100, 100, 200, 100);
    const input = (y) => ({ truth: [top, gt(2, 'base', 90, y, 210, y)], matches: [hit(5, 1)], edges: [fitted(5, 100, 100, 200, 100)] });
    assert.equal(edgeRows(input(103), 'top').rows.length, 0, '3 px away');
    assert.equal(edgeRows(input(110), 'top').rows.length, 1, '10 px away');
    // Nor one that is not the moving part's, nor one barely seen.
    assert.equal(edgeRows({ ...input(110), truth: [gt(1, 'base', 100, 100, 200, 100)] }, 'top').rows.length, 0);
    assert.equal(edgeRows({ ...input(110), truth: [{ ...top, visible: 0.5 }] }, 'top').rows.length, 0);
  });

  await test('a detection beside an edge crowds it too: a finger the truth was not asked for', () => {
    const input = (segments) => ({ truth: [gt(1, 'top', 100, 100, 200, 100)], matches: [hit(5, 1)], edges: [fitted(5, 100, 100, 200, 100)], segments });
    const seg = (id, y) => ({ type: 'edge-segment', id, x0: 105, y0: y, x1: 195, y1: y });
    assert.equal(edgeRows(input([seg(5, 100.1), seg(8, 102.5)]), 'top').rows.length, 0, 'a detection 2.5 px away, of nothing predicted');
    assert.equal(edgeRows(input([seg(5, 100.1), seg(8, 110)]), 'top').rows.length, 1, 'one 10 px away');
    assert.equal(edgeRows(input([seg(5, 100.1)]), 'top').rows.length, 1, 'its own detection does not crowd it');
  });

  await test('through frameReadings an edge keeps its own key, beside a gap pair at the same angle', () => {
    const view = { yaw: 35, elevation: 20 };
    const gap = { ...view, pair: 1, pairAngle: 0, refit: { gapPx: 3, endsPx: [3, 3], gapSigma: 0.02 } };
    const { rows: [edge] } = edgeRows({ truth: [gt(1, 'top', 100, 100, 200, 100)], matches: [hit(7, 1)], edges: [fitted(7, 100, 100.3, 200, 100.3)] }, 'top');
    const rows = [gap, { ...edge, ...view }];
    const got = frameReadings(rows, pairAngles(rows));
    assert.deepEqual(got.get('yaw 35, elev 20 / pair 1 / mid'), [3, 0.02]);
    near(got.get(`yaw 35, elev 20 / pair ${EDGE_BASE + 1} / mid`)[0], 0.3, 1e-12, 'the edge, under its own number');
    assert.ok(!pairAngles(rows).has(`yaw 35, elev 20 / pair ${EDGE_BASE + 1}`), 'no gap row can be matched to it by angle');
  });

  console.log(failures === 0 ? '\nAll edge tests passed.' : `\n${failures} failing.`);
  process.exit(failures === 0 ? 0 : 1);
})();
