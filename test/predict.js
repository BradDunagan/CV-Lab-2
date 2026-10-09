'use strict';

/**
 * Edges predicted from geometry (packages/vision/src/predict.js): where a
 * scene's edges are from a pose, without a renderer.
 *
 * The hand-built cases have arithmetic answers. The last checks the one claim
 * that matters to identification: from pt-lab's own triangles and camera, the
 * predicted edges ARE pt-lab's -- the fixtures are a real stack-2 shot's
 * `.gt.json` and the scene's `geometry.json` (`generate --geometry`).
 *
 *   node test/predict.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { predictEdges, poseMatrix } = require('../packages/vision/src/predict.js');
const { parseGroundTruth } = require('../packages/vision/src/groundtruth.js');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

/** An axis-aligned box as 12 triangles, outward-wound, 9 numbers each. */
function box([x0, y0, z0], [x1, y1, z1]) {
  const v = (i) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const out = [];
  for (const [a, b, c, d] of quads) out.push(...v(a), ...v(b), ...v(c), ...v(a), ...v(c), ...v(d));
  return out;
}

const general = { position: [2.2, 1.7, 3.1], target: [0, 0, 0], fov: 40 };

console.log('cv-lab-2 predict tests');

test('a cube from a general view: six silhouettes, three creases in front, three hidden behind', () => {
  const doc = predictEdges({ objects: [{ name: 'cube', triangles: box([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]) }], camera: general, size: 256 });
  const edges = doc.edges;
  assert.equal(edges.length, 12, 'the diagonals of its faces are not edges');
  assert.equal(edges.filter((e) => e.cause === 'silhouette').length, 6);
  const creases = edges.filter((e) => e.cause === 'crease');
  assert.equal(creases.length, 6);
  for (const e of edges) assert.equal(e.dihedral, 90);
  // Visible: every silhouette and the three front creases, whole. Hidden: the
  // three behind, but for the sample at the end they share with a silhouette.
  const seen = edges.filter((e) => e.visible === 1);
  const hidden = edges.filter((e) => e.visible < 0.2);
  assert.equal(seen.length, 9, `visible: ${edges.map((e) => e.visible.toFixed(2))}`);
  assert.equal(hidden.length, 3);
  assert.equal(doc.vertices.length, 8);
  assert.equal(doc.vertices.filter((v) => v.visible).length, 7, 'one corner faces away');
  parseGroundTruth(doc, 'a predicted cube');
});

test('a corner lands where a pinhole puts it', () => {
  // Looking down -z from (0,0,5): a point at (x, y, 0) is at depth 5.
  const fov = 60, size = 400, x = 0.3, y = -0.2;
  const doc = predictEdges({
    objects: [{ name: 'tile', triangles: [x, y, 0, 1, y, 0, x, 1, 0] }],
    camera: { position: [0, 0, 5], target: [0, 0, 0], fov }, size,
  });
  const focal = 1 / Math.tan((fov * Math.PI) / 360);
  const corner = doc.vertices.find((v) => v.degree === 2 && Math.abs(v.z - 5) < 1e-12 && v.angle > 89);
  assert.ok(Math.abs(corner.x - (focal * x / 5 * 0.5 + 0.5) * size) < 1e-9);
  assert.ok(Math.abs(corner.y - (1 - (focal * y / 5 * 0.5 + 0.5)) * size) < 1e-9);
  assert.ok(doc.edges.every((e) => e.cause === 'boundary' && e.dihedral === 180));
});

test('a pose moves an object exactly as its triangles moved by hand would', () => {
  const pose = { position: [0.1, -0.2, 0.05], rotation: [10, -25, 40], scale: [1, 2, 0.5] };
  const local = box([-0.2, -0.2, -0.2], [0.2, 0.2, 0.2]);
  const m = poseMatrix(pose);
  const moved = [];
  for (let i = 0; i < local.length; i += 3) {
    const [x, y, z] = local.slice(i, i + 3);
    moved.push(m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]);
  }
  const a = predictEdges({ objects: [{ name: 'b', triangles: local, pose }], camera: general, size: 300 });
  const b = predictEdges({ objects: [{ name: 'b', triangles: moved }], camera: general, size: 300 });
  assert.deepEqual(a, b);
  // And the column-major matrix three.js would hold says the same.
  const column = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, m[3], m[7], m[11], 1];
  assert.deepEqual(predictEdges({ objects: [{ name: 'b', triangles: local, matrix: column }], camera: general, size: 300 }), a);
});

test('the rotation is three.js\'s XYZ Euler: turned 90 degrees about y, +x goes to -z', () => {
  const m = poseMatrix({ rotation: [0, 90, 0] });
  assert.ok(Math.abs(m[8] - -1) < 1e-15 && Math.abs(m[0]) < 1e-15 && Math.abs(m[2] - 1) < 1e-15);
});

test('one part in front of another hides it, and moved aside does not', () => {
  const big = { name: 'front', triangles: box([-1, -1, 0.5], [1, 1, 1]) };
  const small = (dx) => ({ name: 'behind', triangles: box([-0.2 + dx, -0.2, -1], [0.2 + dx, 0.2, -0.6]) });
  const camera = { position: [0, 0, 6], target: [0, 0, 0], fov: 45 };
  const hidden = predictEdges({ objects: [big, small(0)], camera, size: 256 });
  assert.ok(hidden.edges.filter((e) => e.objects[0] === 'behind').every((e) => e.visible === 0));
  const aside = predictEdges({ objects: [big, small(2.5)], camera, size: 256 });
  assert.ok(aside.edges.filter((e) => e.objects[0] === 'behind' && e.cause === 'silhouette').every((e) => e.visible === 1));
});

test('a margin sees an edge tucked just behind a silhouette, and not one well behind it', () => {
  // A wall in front at z = 0 whose top edge is at y = 0, and an edge behind
  // it at z = -1, a little below that top in the image.
  const camera = { position: [0, 0, 5], target: [0, 0, 0], fov: 40 };
  const size = 400;
  const wall = { name: 'wall', triangles: [-2, -2, 0, 2, -2, 0, 2, 0, 0, -2, -2, 0, 2, 0, 0, -2, 0, 0] };
  const focal = 1 / Math.tan((40 * Math.PI) / 360);
  const below = (px) => -(px * 2 * 6) / (focal * size);   // y at depth 6 that is px pixels down
  const behind = (px) => ({ name: 'behind', triangles: [-0.5, below(px), -1, 0.5, below(px), -1, 0, below(px) + 1, -1] });
  const bottom = (doc) => doc.edges.find((e) => e.objects[0] === 'behind' && Math.abs(e.y0 - e.y1) < 1e-9);
  for (const [px, margin, visible] of [[0.7, 0, 0], [0.7, 1.5, 1], [3, 1.5, 0]]) {
    const doc = predictEdges({ objects: [wall, behind(px)], camera, size, margin });
    assert.equal(bottom(doc).visible, visible, `${px} px behind, margin ${margin}`);
    assert.equal(doc.predicted.margin, margin);
  }
  assert.throws(() => predictEdges({ objects: [], camera, size, margin: -1 }), /margin/);
});

test('an edge behind the camera is clipped at the near plane, not projected through it', () => {
  // A long floor edge running from in front of the camera to behind it.
  const doc = predictEdges({
    objects: [{ name: 'floor', triangles: [-1, -1, -10, 1, -1, -10, 0, -1, 10] }],
    camera: { position: [0, 0, 0], target: [0, 0, -1], fov: 90 }, size: 200,
  });
  for (const e of doc.edges) for (const z of [e.z0, e.z1]) assert.ok(z >= 0.05 - 1e-12);
  assert.ok(doc.edges.some((e) => e.clipped));
});

test('refuses what it cannot predict from', () => {
  const tri = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  assert.throws(() => predictEdges({ objects: [], camera: general, size: 0 }), /size/);
  assert.throws(() => predictEdges({ objects: [], camera: { ...general, fov: 0 }, size: 64 }), /fov/);
  assert.throws(() => predictEdges({ objects: [{ name: 'x', triangles: tri.slice(1) }], camera: general, size: 64 }), /nine/);
  assert.throws(() => predictEdges({ objects: [], camera: { position: [0, 3, 0], target: [0, 0, 0], fov: 40 }, size: 64 }), /up vector/);
});

test('from pt-lab\'s triangles, a real shot\'s edges are pt-lab\'s own', () => {
  const fixtures = path.join(__dirname, 'fixtures');
  const geometry = JSON.parse(fs.readFileSync(path.join(fixtures, 'stack-2.geometry.json'), 'utf8'));
  const truth = JSON.parse(fs.readFileSync(path.join(fixtures, 'stack-2-y60-e50-gap-1mm.gt.json'), 'utf8'));
  // generated/stack-2g-x's shot y60-e50-gap-1mm: Cube2 a millimetre above the Cube.
  const transforms = { Cube2: { position: [-0.299, 0.904, 0.2] } };
  const objects = geometry.objects.map((o) => (o.key && transforms[o.key]
    ? { name: o.name, triangles: o.triangles, pose: { ...o.transform, ...transforms[o.key] } }
    : { name: o.name, triangles: o.triangles, matrix: o.matrix }));
  const doc = predictEdges({ objects, camera: { ...geometry.camera, ...truth.camera }, size: truth.size, creaseAngle: truth.creaseAngle });
  assert.equal(doc.edges.length, truth.edges.length);
  const ends = (e) => [e.x0, e.y0, e.x1, e.y1];
  for (const want of truth.edges) {
    const got = doc.edges.filter((e) => e.cause === want.cause && e.objects.join() === want.objects.join())
      .map((e) => ({ e, d: Math.max(...ends(e).map((v, k) => Math.abs(v - ends(want)[k]))) }))
      .sort((a, b) => a.d - b.d)[0];
    assert.ok(got && got.d < 1e-6, `${want.cause} of ${want.objects}: ${got?.d} px from pt-lab's`);
    // pt-lab's visibility is a depth raster, right to about a pixel; the cubes'
    // edges here are all far from that limit, and agree on which side of 0.5.
    if (want.objects.some((n) => n.startsWith('Cube'))) {
      assert.equal(got.e.visible >= 0.5, want.visible >= 0.5, `${want.cause} of ${want.objects}: ${got.e.visible} against ${want.visible}`);
    }
  }
});

console.log(failures === 0 ? '\nAll predict tests passed.' : `\n${failures} failing.`);
process.exit(failures === 0 ? 0 : 1);
