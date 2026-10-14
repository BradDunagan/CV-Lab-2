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

/** The same box with each face an n x n grid: every edge in n collinear pieces, as a CAD export splits it. */
function gridBox([x0, y0, z0], [x1, y1, z1], n) {
  const lo = [x0, y0, z0], hi = [x1, y1, z1];
  const out = [];
  // Each face: the fixed axis and its side, and two axes across it, ordered so the quad is wound outward.
  for (const [axis, side, u, v] of [[0, 0, 2, 1], [0, 1, 1, 2], [1, 0, 0, 2], [1, 1, 2, 0], [2, 0, 1, 0], [2, 1, 0, 1]]) {
    const at = (i, j) => {
      const p = [0, 0, 0];
      p[axis] = side ? hi[axis] : lo[axis];
      p[u] = lo[u] + ((hi[u] - lo[u]) * i) / n;
      p[v] = lo[v] + ((hi[v] - lo[v]) * j) / n;
      return p;
    };
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
        out.push(...a, ...b, ...c, ...a, ...c, ...d);
      }
    }
  }
  return out;
}

/** An edge as a comparable record: its ends in either order, its cause and what it belongs to. */
const signature = (e) => {
  const [p, q] = [[e.x0, e.y0], [e.x1, e.y1]].sort((s, t) => s[0] - t[0] || s[1] - t[1]);
  return { p, q, cause: e.cause, objects: e.objects.join(','), visible: e.visible };
};
const sameEdges = (got, want, what) => {
  assert.equal(got.length, want.length, `${what}: ${got.length} edges against ${want.length}`);
  for (const w of want.map(signature)) {
    const g = got.map(signature).find((s) => s.cause === w.cause && s.objects === w.objects &&
      Math.abs(s.p[0] - w.p[0]) + Math.abs(s.p[1] - w.p[1]) + Math.abs(s.q[0] - w.q[0]) + Math.abs(s.q[1] - w.q[1]) < 1e-9);
    assert.ok(g, `${what}: no ${w.cause} from ${w.p} to ${w.q}`);
    assert.equal(g.visible, w.visible, `${what}: the ${w.cause} from ${w.p} sees ${g.visible} against ${w.visible}`);
  }
};

test('join: a box split into a grid is one edge per side again, the plain box\'s edges exactly', () => {
  const cube = [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]];
  const plain = predictEdges({ objects: [{ name: 'cube', triangles: box(...cube) }], camera: general, size: 256 });
  const grid = { name: 'cube', triangles: gridBox(...cube, 5) };
  // Apart, every side is its five pieces ...
  assert.equal(predictEdges({ objects: [grid], camera: general, size: 256 }).edges.length, 60);
  // ... joined, the same twelve lines as the plain box, with the same visibility.
  const joined = predictEdges({ objects: [grid], camera: general, size: 256, join: true });
  sameEdges(joined.edges, plain.edges, 'the grid box joined');
  // Joining the plain box changes nothing: its sides are already whole.
  sameEdges(predictEdges({ objects: [{ name: 'cube', triangles: box(...cube) }], camera: general, size: 256, join: true }).edges, plain.edges, 'the plain box joined');
  parseGroundTruth(joined, 'a joined cube');
});

test('join: a curve\'s chords stay chords, and two parts\' collinear sides stay two', () => {
  // A twelve-sided prism: its rims bend 30 degrees at every vertex.
  const n = 12, r = 0.5, h = 0.4, tri = [];
  const at = (k, y) => [r * Math.cos((2 * Math.PI * k) / n), y, -r * Math.sin((2 * Math.PI * k) / n)];
  for (let k = 0; k < n; k++) {
    const a0 = at(k, -h), a1 = at(k + 1, -h), b0 = at(k, h), b1 = at(k + 1, h);
    tri.push(...a0, ...a1, ...b1, ...a0, ...b1, ...b0, ...b0, ...b1, 0, h, 0, ...a1, ...a0, 0, -h, 0);
  }
  const prism = [{ name: 'prism', triangles: tri }];
  const apart = predictEdges({ objects: prism, camera: general, size: 256 });
  sameEdges(predictEdges({ objects: prism, camera: general, size: 256, join: true }).edges, apart.edges, 'the prism joined');
  // Two boxes end to end along x, a gap between: one line in space, two parts.
  const two = [{ name: 'a', triangles: box([-1, -0.2, -0.2], [-0.01, 0.2, 0.2]) }, { name: 'b', triangles: box([0.01, -0.2, -0.2], [1, 0.2, 0.2]) }];
  const both = predictEdges({ objects: two, camera: general, size: 256, join: true });
  for (const name of ['a', 'b']) assert.equal(both.edges.filter((e) => e.objects.join() === name).length, 12, `${name} keeps its twelve`);
});

/** A cross-section (x, y, anticlockwise) extruded along z from -half to half, capped, outward-wound. */
function extrude(section, half) {
  const out = [];
  const n = section.length;
  for (let k = 0; k < n; k++) {
    const [x0, y0] = section[k], [x1, y1] = section[(k + 1) % n];
    out.push(x0, y0, -half, x1, y1, -half, x1, y1, half, x0, y0, -half, x1, y1, half, x0, y0, half);
    out.push(0, 0, half, x0, y0, half, x1, y1, half, 0, 0, -half, x1, y1, -half, x0, y0, -half);
  }
  return out;
}

test('join: a filleted edge between two faces in view is one crease; one on the outline is not', () => {
  // A square bar 1 m across, its four long edges filleted at 2 cm in six 15-degree facets: each fold is soft.
  const h = 0.5, r = 0.02, section = [];
  for (const [cx, cy, start] of [[h - r, h - r, 0], [-(h - r), h - r, 90], [-(h - r), -(h - r), 180], [h - r, -(h - r), 270]]) {
    for (let s = 0; s <= 6; s++) {
      const t = ((start + 15 * s) * Math.PI) / 180;
      section.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
    }
  }
  const bar = [{ name: 'bar', triangles: extrude(section, 0.6) }];
  // From +x, +y, +z: the fillet between the +x and +y faces is between two faces in view.
  const longCreases = (doc) => doc.edges.filter((e) => e.cause === 'crease' && e.length > 50);
  const apart = predictEdges({ objects: bar, camera: general, size: 256 });
  const joined = predictEdges({ objects: bar, camera: general, size: 256, join: true });
  // The caps' rims are creases either way. Joined, two fillets are creases as a box's edges would be: the one
  // between the +x and +y faces, in view, and the one opposite, between faces turned away, hidden behind.
  assert.equal(longCreases(joined).length, longCreases(apart).length + 2, 'two more long creases joined');
  const rounded = joined.edges.filter((e) => e.rounded !== undefined && e.length > 50);
  assert.equal(rounded.length, 2, `rounded creases along the bar: ${rounded.length}`);
  assert.equal(rounded.filter((e) => e.visible > 0.95).length, 1, 'one in view');
  assert.equal(rounded.filter((e) => e.visible < 0.05).length, 1, 'one hidden');
  const crease = rounded.find((e) => e.visible > 0.95);
  assert.equal(crease.cause, 'crease');
  assert.ok(Math.abs(crease.dihedral - 90) < 1e-6, `its turn: ${crease.dihedral}`);
  assert.ok(crease.rounded > 0 && crease.rounded <= 6, `its width: ${crease.rounded} px`);
  assert.ok(crease.visible > 0.95, `seen: ${crease.visible}`);
  parseGroundTruth(joined, 'a filleted bar');
});

test('join: a smooth cylinder has no rounded crease, though its facets crowd toward its outline', () => {
  // 48 sides, 7.5-degree folds: soft, and near the limb several fall within a few pixels.
  const section = [];
  for (let k = 0; k < 48; k++) section.push([0.4 * Math.cos((2 * Math.PI * k) / 48), 0.4 * Math.sin((2 * Math.PI * k) / 48)]);
  const doc = predictEdges({ objects: [{ name: 'cylinder', triangles: extrude(section, 0.6) }], camera: general, size: 256, join: true });
  assert.equal(doc.edges.filter((e) => e.rounded !== undefined).length, 0);
});

test('only: the named part\'s edges exactly as without it, and what is unnamed still hides it', () => {
  // A box behind another: the front one hides part of the back one, and is not wanted.
  const objects = [
    { name: 'front', triangles: box([-0.3, -0.3, 0.6], [0.3, 0.3, 1.2]) },
    { name: 'back', triangles: box([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]) },
  ];
  for (const join of [false, true]) {
    const all = predictEdges({ objects, camera: general, size: 256, join });
    const back = all.edges.filter((e) => e.objects.join() === 'back');
    assert.ok(back.some((e) => e.visible > 0 && e.visible < 1), 'the front box hides some of the back box');
    const named = predictEdges({ objects, camera: general, size: 256, join, only: ['back'] });
    assert.ok(named.edges.every((e) => e.objects.join() === 'back'), 'no edge of the box not named');
    sameEdges(named.edges, back, `join ${join}`);
  }
  assert.throws(() => predictEdges({ objects, camera: general, size: 256, only: 'back' }), /only/);
});

test('join: the same document whatever order the triangles come in', () => {
  const tri = gridBox([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5], 4);
  const triangles = [];
  for (let i = 0; i < tri.length; i += 9) triangles.push(tri.slice(i, i + 9));
  const reversed = triangles.reverse().flat();
  const a = predictEdges({ objects: [{ name: 'cube', triangles: tri }], camera: general, size: 256, join: true });
  const b = predictEdges({ objects: [{ name: 'cube', triangles: reversed }], camera: general, size: 256, join: true });
  sameEdges(b.edges, a.edges, 'reversed');
  // And the same bits, run twice.
  assert.equal(JSON.stringify(predictEdges({ objects: [{ name: 'cube', triangles: tri }], camera: general, size: 256, join: true })), JSON.stringify(a));
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
