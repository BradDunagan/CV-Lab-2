'use strict';

/**
 * Curved edges — `chain`, `fitArcs`, and the model selection between them.
 *
 * These assert PROPERTIES, not recorded output. The ones that matter most are
 * about what must NOT happen, because a circle has a parameter a line does not
 * and will spend it on noise -- so every failure here looks like a plausible
 * number rather than an error:
 *
 *   - a straight edge is never described as an arc, at any angle or length
 *   - two straight runs never chain, however close
 *   - a corner never chains, and two different circles never chain
 *
 * A test that recorded what `fitArcs` currently emits would pass just as
 * happily with the gates removed. Where a test passes for a reason that does
 * not generalise -- exactly collinear pixels make the fit singular, so no
 * parameter is ever consulted -- there is a second one beside it that puts the
 * parameter to work, and asserts the join HAPPENS once the gate is lowered.
 *
 *   npm run build:native && node test/arcs.js
 */

const assert = require('node:assert/strict');
const native = require('../native');
const { createRegistry } = require('../src/lab/ops');
const { crossings } = require('../src/lab/explain');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

const runtime = process.versions.electron
  ? `electron ${process.versions.electron}` : `node ${process.versions.node}`;
console.log(`cv-lab-2 arc tests (${runtime}, ${process.platform}/${process.arch})`);

const W = 160, H = 160;

/** A label map from a list of pixel sets, one label per set. */
function labelMap(sets, width = W, height = H) {
  const labels = new Int32Array(width * height);
  sets.forEach((pixels, i) => {
    for (const [x, y] of pixels) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      labels[y * width + x] = i + 1;
    }
  });
  const handle = native.createBuffer({ width, height, channels: 1, dtype: 'i32' });
  native.bufferWrite(handle, labels);
  return handle;
}

/** The pixels of a circular arc, deduplicated, in no particular order. */
function arcPixels(cx, cy, r, fromDeg, toDeg) {
  const seen = new Set();
  const out = [];
  const step = Math.min(0.25, 20 / r);
  for (let d = fromDeg; d <= toDeg + 1e-9; d += step) {
    const a = (d * Math.PI) / 180;
    const x = Math.round(cx + r * Math.cos(a));
    const y = Math.round(cy + r * Math.sin(a));
    const key = `${x},${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([x, y]);
  }
  return out;
}

/** The pixels of a straight run from one end to the other. */
function linePixels(x0, y0, x1, y1) {
  const seen = new Set();
  const out = [];
  const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    const y = Math.round(y0 + ((y1 - y0) * i) / steps);
    const key = `${x},${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([x, y]);
  }
  return out;
}

const chain = (handle, params) => native.runKernel('chain', [handle], params ?? {});
const labelCount = (handle) => {
  let max = 0;
  for (const v of native.bufferRead(handle)) if (v > max) max = v;
  return max;
};

const registry = createRegistry();
const fitArcsOp = registry.get('fitArcs');
/** `fitArcs` as the operation runs it: the native candidates, then the gates. */
function fitArcs(handle, params = {}) {
  const resolved = Object.fromEntries(fitArcsOp.params.map((p) => [p.name, p.default]));
  return fitArcsOp.kernel({
    inputs: [{ handle }],
    params: { ...resolved, ...params },
  }).features;
}

/* --- the fit itself ---------------------------------------------------- */

test('a circle is recovered from its own pixels', () => {
  // Quantising a circle onto the pixel grid moves each point by up to half a
  // pixel, so the fit cannot be exact -- but it must be better than the noise
  // it is averaging over, which is the whole claim of fitting at all.
  for (const [cx, cy, r] of [[80, 80, 50], [70, 90, 30], [80, 80, 12]]) {
    const [arc] = native.fitArcs(labelMap([arcPixels(cx, cy, r, 0, 359)]));
    assert.ok(Math.abs(arc.cx - cx) < 0.3, `cx ${arc.cx} vs ${cx} at r=${r}`);
    assert.ok(Math.abs(arc.cy - cy) < 0.3, `cy ${arc.cy} vs ${cy} at r=${r}`);
    assert.ok(Math.abs(arc.r - r) < 0.3, `r ${arc.r} vs ${r}`);
    assert.ok(arc.rms < 0.5, `rms ${arc.rms} is larger than the quantisation`);
  }
});

test('the endpoints lie on the fitted circle, not on the extreme pixels', () => {
  const [arc] = native.fitArcs(labelMap([arcPixels(80, 80, 40, 10, 100)]));
  for (const [x, y] of [[arc.x0, arc.y0], [arc.x1, arc.y1]]) {
    const d = Math.abs(Math.hypot(x - arc.cx, y - arc.cy) - arc.r);
    assert.ok(d < 1e-9, `endpoint sits ${d} from the circle it is reported on`);
  }
  // And they are sub-pixel: a projected endpoint landing on an integer for
  // both coordinates would mean the projection had not happened.
  const integral = [arc.x0, arc.y0, arc.x1, arc.y1].every((v) => Number.isInteger(v));
  assert.ok(!integral, 'endpoints are pixel centres, so nothing was projected');
});

test('sagitta is the bow off the chord, and saturates past the diameter', () => {
  // A quarter circle of radius 50: chord 50*sqrt(2), sagitta r - r/sqrt(2).
  const [arc] = native.fitArcs(labelMap([arcPixels(80, 80, 50, 0, 90)]));
  const expected = arc.r - arc.r / Math.SQRT2;
  assert.ok(Math.abs(arc.sagitta - expected) < 0.2,
    `sagitta ${arc.sagitta} against ${expected}`);
  /*
   * Past half a circle the chord starts SHRINKING again, so a nearly closed
   * arc has almost no chord at all and the minor-segment formula reports
   * almost no bow. Found on a filled disc, whose outline `chain` joins into
   * one 357-degree label: it came back with a sagitta of 0.01 px and was
   * refused as a straight line, at a radius of 30 and a gain of 60.
   *
   * The major arc's bow is 2r minus the minor one's, and these are the cases
   * either side of that.
   */
  for (const sweep of [200, 300, 357]) {
    const [wide] = native.fitArcs(labelMap([arcPixels(80, 80, 40, 0, sweep)]));
    assert.ok(wide.sagitta > wide.r,
      `a ${sweep}° arc bows ${wide.sagitta.toFixed(2)}, less than its own radius`);
    assert.ok(wide.sagitta <= 2 * wide.r + 1e-9, 'a bow larger than the diameter');
  }
  const [full] = native.fitArcs(labelMap([arcPixels(80, 80, 40, 0, 359)]));
  assert.ok(Math.abs(full.sagitta - 2 * full.r) < 1.0,
    `a closed circle should bow by its diameter, got ${full.sagitta.toFixed(2)}`);

  // ...and the gates must then accept it, which is the failure that mattered.
  const disc = labelMap([arcPixels(80, 80, 40, 0, 357)]);
  assert.equal(fitArcs(disc).length, 1, 'a nearly closed circle was refused as a line');
});

/* --- the branch cut ---------------------------------------------------- */

test('the angular extent is right at every rotation, including across ±180°', () => {
  /*
   * The bug this exists for: taking min and max of the member angles returns
   * the two ends of the EMPTY side for any arc straddling the cut at ±180°,
   * so a 90° arc there reports 270°. Nothing about the fit looks wrong when
   * it happens. Same class as the vector-sum-not-angle-average case in
   * k_segments.
   */
  const SWEEP = 90;
  for (let start = -180; start < 180; start += 15) {
    const [arc] = native.fitArcs(labelMap([arcPixels(80, 80, 45, start, start + SWEEP)]));
    assert.ok(Math.abs(arc.sweep - SWEEP) < 4,
      `sweep ${arc.sweep.toFixed(1)}° for an arc from ${start}° (want ${SWEEP}°)`);
    const wanted = ((start % 360) + 360) % 360;
    const off = Math.abs(((arc.angle0 - wanted + 540) % 360) - 180);
    assert.ok(off < 4, `angle0 ${arc.angle0.toFixed(1)}° for an arc from ${start}°`);
  }
});

test('angle0 plus sweep reaches angle1, and both name the reported endpoints', () => {
  for (const start of [-170, -40, 0, 80, 170]) {
    const [arc] = native.fitArcs(labelMap([arcPixels(80, 80, 40, start, start + 70)]));
    const end = ((arc.angle0 + arc.sweep) % 360 + 360) % 360;
    assert.ok(Math.abs(((end - arc.angle1 + 540) % 360) - 180) < 1e-6,
      `angle0+sweep=${end} but angle1=${arc.angle1}`);
    // The endpoints are the arc's own ends, in the order the angles name.
    const at = (deg) => [
      arc.cx + arc.r * Math.cos((deg * Math.PI) / 180),
      arc.cy + arc.r * Math.sin((deg * Math.PI) / 180),
    ];
    const [ex0, ey0] = at(arc.angle0), [ex1, ey1] = at(arc.angle1);
    assert.ok(Math.hypot(ex0 - arc.x0, ey0 - arc.y0) < 1e-6, 'angle0 is not x0,y0');
    assert.ok(Math.hypot(ex1 - arc.x1, ey1 - arc.y1) < 1e-6, 'angle1 is not x1,y1');
  }
});

/* --- model selection: the trap ----------------------------------------- */

test('a straight edge is never an arc, at any angle or length', () => {
  /*
   * The property that matters, asserted over the whole rotation rather than
   * on one convenient line.
   *
   * Worth knowing WHY it holds, because it is not the gates: on a clean
   * straight run the algebraic fit does not approximate the line with a huge
   * circle, it collapses to a small one, and the worst `gain` over this sweep
   * is 0.18 -- the circle fitting several times WORSE. The gates are for the
   * case that actually occurs, which is the next test: a noisy near-straight
   * label where the circle wins by a little.
   */
  for (let deg = 0; deg < 180; deg += 7.5) {
    for (const len of [12, 30, 60]) {
      const a = (deg * Math.PI) / 180;
      const x0 = 80 - (len / 2) * Math.cos(a), y0 = 80 - (len / 2) * Math.sin(a);
      const x1 = 80 + (len / 2) * Math.cos(a), y1 = 80 + (len / 2) * Math.sin(a);
      const arcs = fitArcs(labelMap([linePixels(x0, y0, x1, y1)]));
      assert.equal(arcs.length, 0,
        `a ${len}px line at ${deg}° came back as an arc `
        + `(r=${arcs[0]?.r.toFixed(1)}, gain=${(arcs[0]?.lineRms / arcs[0]?.rms).toFixed(2)})`);
    }
  }
});

test('a real arc is described, and its gates each refuse it alone', () => {
  const handle = labelMap([arcPixels(80, 80, 40, 0, 80)]);
  assert.equal(fitArcs(handle).length, 1, 'a 80° arc of radius 40 was not described');

  // Each gate, raised past what this arc offers, is enough to refuse it on its
  // own -- so none of the three is decoration.
  const [arc] = fitArcs(handle);
  assert.equal(fitArcs(handle, { minGain: arc.lineRms / arc.rms + 1 }).length, 0);
  assert.equal(fitArcs(handle, { minSweep: arc.sweep + 1 }).length, 0);
  assert.equal(fitArcs(handle, { minSagitta: arc.sagitta + 1 }).length, 0);
});

test('a label with no circle to report produces no record rather than a bad one', () => {
  // Two pixels cannot define a circle, and neither can a perfectly straight
  // run: the 2x2 is singular and the solve must decline rather than divide.
  const tiny = native.fitArcs(labelMap([[[10, 10], [11, 10]]]));
  assert.equal(tiny.length, 0);
  const exact = native.fitArcs(labelMap([linePixels(20, 40, 90, 40)]));
  for (const a of exact) {
    assert.ok(Number.isFinite(a.r) && Number.isFinite(a.cx) && Number.isFinite(a.cy),
      'a degenerate fit was reported with a non-finite value in it');
  }
});

/* --- chain ------------------------------------------------------------- */

test('pieces of one circle chain into one label', () => {
  // Four 20° pieces with 3° breaks: what `segments` leaves of a curve once
  // maxResidual and angleTol have each capped how long a piece can be.
  const pieces = [[0, 20], [23, 43], [46, 66], [69, 89]]
    .map(([a, b]) => arcPixels(80, 80, 40, a, b));
  const before = labelMap(pieces);
  assert.equal(labelCount(before), 4);
  assert.equal(labelCount(chain(before, {})), 1, 'four pieces of one circle stayed apart');
});

test('two collinear runs never chain, however close', () => {
  for (const gapPx of [1, 2, 3]) {
    const before = labelMap([
      linePixels(20, 80, 70, 80),
      linePixels(70 + gapPx, 80, 120, 80),
    ]);
    assert.equal(labelCount(chain(before, { gap: 8 })), 2,
      `two collinear runs ${gapPx}px apart were chained`);
  }
});

test('a turn below minTurn is what refuses a near-straight join', () => {
  /*
   * The test above passes for a reason that does not generalise: pixels
   * exactly in a row make the 2x2 singular, so the fit declines before any
   * parameter is consulted. Real edges are never exactly in a row.
   *
   * These two runs turn through 1 degree, which is enough to condition the
   * fit and not enough to be a curve. Without the floor they chain into an
   * arc of radius 2321 -- and, left alone, so does every straight edge in an
   * image, into one very flat circle.
   */
  const turned = (deg) => {
    const a = (deg * Math.PI) / 180;
    return labelMap([
      linePixels(20, 100, 100, 100),
      linePixels(103, 100, 103 + 80 * Math.cos(a), 100 + 80 * Math.sin(a)),
    ], 200, 200);
  };
  assert.equal(labelCount(chain(turned(1), { gap: 6, minTurn: 2 })), 2);
  assert.equal(labelCount(chain(turned(1), { gap: 6, minTurn: 0 })), 1,
    'with the floor removed this must chain, or the test proves nothing');
});

test('chain and fitArcs refuse different things, and both are needed', () => {
  /*
   * A 1-degree bend over 160 px gets through `chain` with the floor removed:
   * the joined pixels really do lie on one circle within a pixel, and the
   * quantisation noise bows the fit past minSagitta. What stops it being
   * REPORTED as a curve is the other end of the pipeline -- gain 0.83, well
   * under minGain. Neither stage is a substitute for the other.
   */
  const a = (1 * Math.PI) / 180;
  const before = labelMap([
    linePixels(20, 100, 100, 100),
    linePixels(103, 100, 103 + 80 * Math.cos(a), 100 + 80 * Math.sin(a)),
  ], 200, 200);
  const joined = chain(before, { gap: 6, minTurn: 0 });
  assert.equal(labelCount(joined), 1, 'chain was expected to accept this one');
  assert.equal(fitArcs(joined).length, 0, 'a 1-degree bend was described as an arc');
});

test('a corner never chains', () => {
  // A hexagon turns 60° at every vertex. Chaining across those walks a fitted
  // curve around the whole subject, which is what the first version of the
  // 2026-09-20 probe did before the turn and residual tests existed.
  for (const turn of [50, 60, 90]) {
    const a = (turn * Math.PI) / 180;
    const before = labelMap([
      linePixels(30, 80, 80, 80),
      linePixels(80, 80, 80 + 50 * Math.cos(a), 80 + 50 * Math.sin(a)),
    ]);
    assert.equal(labelCount(chain(before, {})), 2, `a ${turn}° corner was chained`);
  }
});

test('pieces of two different circles do not chain', () => {
  // Near endpoints and a plausible turn, but no one circle holds both. This
  // is the test `merge` calls "the claim", restated for a curve.
  const before = labelMap([
    arcPixels(60, 80, 30, -40, 0),
    arcPixels(115, 80, 30, 175, 215),
  ]);
  assert.equal(labelCount(chain(before, { gap: 6 })), 2);
});

test('maxResidual is what decides it', () => {
  const before = labelMap([
    arcPixels(80, 80, 40, 0, 20),
    arcPixels(80, 80, 40, 23, 43),
  ]);
  assert.equal(labelCount(chain(before, { maxResidual: 1.0 })), 1);
  // Tightened past the pixel grid's own quantisation, nothing can join.
  assert.equal(labelCount(chain(before, { maxResidual: 0.1 })), 2);
});

test('chain numbers its output by the image, not by the order joins happened', () => {
  /*
   * §5: two runs that find the SAME grouping must name it identically, or a
   * content hash reports a change that did not happen. The labels going in are
   * permuted; the map coming out must be identical.
   */
  const pieces = [[0, 20], [23, 43], [46, 66]].map(([a, b]) => arcPixels(80, 80, 40, a, b));
  const straight = native.bufferRead(chain(labelMap(pieces), {}));
  const permuted = native.bufferRead(chain(labelMap([pieces[2], pieces[0], pieces[1]]), {}));
  assert.deepEqual([...straight], [...permuted]);
});

test('chain leaves a map it can do nothing with exactly as it found it', () => {
  const before = labelMap([linePixels(20, 30, 90, 30)]);
  assert.deepEqual([...native.bufferRead(chain(before, {}))],
    [...native.bufferRead(before)]);
});

test('every value in a chained map is 0 or a label, whatever went in', () => {
  /*
   * The invariant must not depend on how many labels there were. With two or
   * more, the renumbering pass zeroes anything that is not a positive label;
   * with fewer, the operation has nothing to do and the short circuit has to
   * normalise rather than copy the input through.
   */
  const malformed = new Int32Array(16 * 16);
  malformed[2 * 16 + 2] = -5;                       // never produced; still handled
  malformed[3 * 16 + 3] = 1;
  const handle = native.createBuffer({ width: 16, height: 16, channels: 1, dtype: 'i32' });
  native.bufferWrite(handle, malformed);
  const out = native.bufferRead(chain(handle, {}));
  assert.ok([...out].every((v) => v >= 0), 'a negative label survived chain');
});

test('chain refuses a map that is not an i32 label map, and bad parameters', () => {
  const f32 = native.createBuffer({ width: 8, height: 8, channels: 1, dtype: 'f32' });
  assert.throws(() => chain(f32, {}), /dtype|i32/i);
  const ok = labelMap([linePixels(20, 30, 40, 30)]);
  // A turn window that is empty describes no join at all, so it is a mistake
  // rather than a way of switching the operation off.
  assert.throws(() => chain(ok, { minTurn: 50, maxTurn: 40 }), /param/i);
  assert.throws(() => chain(ok, { maxResidual: 0 }), /param/i);
});

/* --- what the rest of the lab does with one ---------------------------- */

test('explain crosses an arc along its radius, inset from both ends', () => {
  const feature = { type: 'edge-arc', cx: 80, cy: 80, r: 40, angle0: 0, sweep: 90 };
  const pairs = crossings(feature, { offset: 2.5, samples: 5 });
  assert.equal(pairs.length, 5);
  for (const [a, b] of pairs) {
    // Radial: the two samples and the centre are collinear, one either side.
    const da = Math.hypot(a.x - 80, a.y - 80), db = Math.hypot(b.x - 80, b.y - 80);
    assert.ok(Math.abs(da - 37.5) < 1e-9, `inner sample at ${da}`);
    assert.ok(Math.abs(db - 42.5) < 1e-9, `outer sample at ${db}`);
    // ...and on the arc's own sweep, never past its ends.
    const deg = ((Math.atan2(a.y - 80, a.x - 80) * 180) / Math.PI + 360) % 360;
    assert.ok(deg > 0 && deg < 90, `sample at ${deg}° is outside the arc`);
  }
});

test('an arc narrower than the offset is not measured at all', () => {
  // The inner sample would sit past the centre and read the FAR side of the
  // same curve: a number with nothing wrong with it and no bearing on the
  // question. `explain` reports `unknown` for these.
  const pairs = crossings(
    { type: 'edge-arc', cx: 80, cy: 80, r: 2, angle0: 0, sweep: 90 },
    { offset: 2.5, samples: 5 });
  assert.equal(pairs.length, 0);
});

test('an arc is a detection the overlay knows how to draw', async () => {
  const { overlayRole, isDetection, OVERLAY_KINDS } =
    await import('../src/renderer/overlay-features.mjs');
  assert.equal(overlayRole({ type: 'edge-arc' }), 'arc');
  assert.equal(isDetection({ type: 'edge-arc' }), true);
  assert.ok(OVERLAY_KINDS.some((k) => k.role === 'arc'), 'no checkbox offers arcs');
});

console.log(failures === 0
  ? '\nAll arc tests passed.'
  : `\n${failures} failing.`);
process.exit(failures === 0 ? 0 : 1);
