/**
 * The edges a scene shows from a camera, predicted from its geometry: no
 * renderer, no depth pass, no GPU.
 *
 * Which detected edge is which part, and where along a pair a gap is read,
 * need not come from a renderer's truth: they come from where the parts are
 * believed to be (design-lab-model.md §5, "A thirty-eighth"). pt-lab's
 * `groundTruthGeometry` computes that at about 20 s a shot, because it
 * renders a depth pass for the visibility. The edges themselves are geometry
 * -- a part's silhouette and creases, projected, with what is hidden taken
 * out -- and this computes them from the triangles alone, in milliseconds,
 * returning the document `groundTruth` reads (`parseGroundTruth`), so
 * anything that takes a `.gt.json` takes this.
 *
 * It follows `groundTruthGeometry` step for step (packages/pt-lab/src/lib/pathtracer.ts):
 * edges keyed by quantised position across the whole scene, a silhouette
 * where one face turns toward the eye and the other away, a crease past
 * `creaseAngle`, a boundary where an edge has one face, clipped at the near
 * plane and the frame, sampled along the image. One thing differs, on
 * purpose. pt-lab decides visibility against a rasterised depth pass, which
 * is right to about a pixel and has tolerances for it (`gtVisibleAt`); here a
 * sample is hidden when a triangle crosses the line from the eye to it before
 * the sample does -- exact, up to `OCCLUSION_EPS` of the distance. So an edge's
 * `visible` can differ from pt-lab's near a silhouette, where the raster test
 * deliberately leans one way; `margin` leans the same way on purpose.
 *
 * Built from `+ - * /`, `Math.sqrt` and the package's own math (math.js), so
 * the document is the same bits in every engine. Pure JavaScript, host-free.
 *
 * Square images only, as pt-lab renders them.
 */

import { acos, atan2, len2, cos, sin, tan, PI } from './math.js';

/** pt-lab's GT_QUANTUM: positions within 10 micrometres are one vertex. */
const QUANTUM = 1e5;

/**
 * How far before a sample, as a fraction of its distance from the eye, a
 * crossing must be to hide it. A triangle that CONTAINS the sample -- the two
 * faces of its own edge, a face it lies on -- is crossed at exactly 1 up to
 * rounding, and must not hide it; 1e-6 of a metre is a micrometre.
 */
const OCCLUSION_EPS = 1e-6;

/** A ray this close to a triangle's plane, by cosine, passes along it, not through it. */
const GRAZING = 1e-9;

/** Image cells per side for finding the triangles over a sample. */
const GRID = 32;

const DEG = PI / 180;

/**
 * A pose as a 3x4 row-major matrix: position, rotation in degrees about x,
 * then y, then z (three.js's default Euler order, which pt-lab's
 * `setObjectTransform` uses), then scale.
 *
 * @param {{position?: number[], rotation?: number[], scale?: number[]}} t
 * @returns {number[]} 12 numbers
 */
export function poseMatrix(t) {
  const [px, py, pz] = t.position ?? [0, 0, 0];
  const [rx, ry, rz] = t.rotation ?? [0, 0, 0];
  const [sx, sy, sz] = t.scale ?? [1, 1, 1];
  const a = cos(rx * DEG), b = sin(rx * DEG);
  const c = cos(ry * DEG), d = sin(ry * DEG);
  const e = cos(rz * DEG), f = sin(rz * DEG);
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  // Matrix4.makeRotationFromEuler, order 'XYZ', then compose's scale by column.
  return [
    c * e * sx, -c * f * sy, d * sz, px,
    (af + be * d) * sx, (ae - bf * d) * sy, -b * c * sz, py,
    (bf - ae * d) * sx, (be + af * d) * sy, a * c * sz, pz,
  ];
}

/** A three.js column-major 4x4 as the 3x4 row-major used here. */
function fromColumnMajor(m) {
  return [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14]];
}

function apply(m, x, y, z) {
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ];
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.sqrt(dot(a, a)); return [a[0] / l, a[1] / l, a[2] / l]; };
const key = (p) => `${Math.round(p[0] * QUANTUM)},${Math.round(p[1] * QUANTUM)},${Math.round(p[2] * QUANTUM)}`;

/**
 * The camera: world to camera space, three.js's `lookAt` -- the camera looks
 * down its -z, `up` is world +y unless given -- and camera space to pixels.
 */
function makeCamera({ position, target, up = [0, 1, 0], fov, near = 0.05 }, size) {
  const zAxis = norm(sub(position, target));
  let xAxis = cross(up, zAxis);
  if (dot(xAxis, xAxis) === 0) throw new Error('predictEdges: the camera looks along its up vector');
  xAxis = norm(xAxis);
  const yAxis = cross(zAxis, xAxis);
  const toCamera = (p) => {
    const v = sub(p, position);
    return [dot(v, xAxis), dot(v, yAxis), dot(v, zAxis)];
  };
  const focal = 1 / tan((fov * DEG) / 2);
  /** Camera space to pixels; forward depth is -z, and only valid at or past `near`. */
  /** How far one pixel is, sideways in camera space, at forward depth `depth`. */
  const pixelAt = (depth) => (2 * depth) / (focal * size);
  const toImage = (c) => {
    const depth = -c[2];
    return { x: ((focal * c[0]) / depth * 0.5 + 0.5) * size, y: (1 - ((focal * c[1]) / depth * 0.5 + 0.5)) * size };
  };
  return { toCamera, toImage, pixelAt, near, eye: position };
}

/** Clip a 2-D segment to [0,size]^2, Liang-Barsky, in parameter space: pt-lab's gtClipToFrame. */
function clipToFrame(x0, y0, x1, y1, size) {
  const dx = x1 - x0, dy = y1 - y0;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, x0], [dx, size - x0], [-dy, y0], [dy, size - y0]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [t0, t1];
}

/** Angle between two image directions, as LINES, in [0, 90] degrees: pt-lab's gtLineAngle. */
function lineAngle(ax, ay, bx, by) {
  const d = Math.abs(ax * bx + ay * by);
  const mag = len2(ax, ay) * len2(bx, by);
  if (mag < 1e-12) return 0;
  return (acos(Math.min(1, d / mag)) * 180) / PI;
}

/**
 * Every triangle that could hide something, in camera space, binned by where
 * it lands in the image. A triangle with a corner nearer than `near` cannot
 * be projected safely and is tested everywhere; one wholly behind the eye
 * can hide nothing in front of it.
 */
function occluders(triangles, camera, size) {
  const cell = size / GRID;
  const bins = Array.from({ length: GRID * GRID }, () => []);
  const everywhere = [];
  for (const t of triangles) {
    const c = [camera.toCamera(t[0]), camera.toCamera(t[1]), camera.toCamera(t[2])];
    const depths = c.map((v) => -v[2]);
    if (depths.every((z) => z <= 0)) continue;
    const e1 = sub(c[1], c[0]), e2 = sub(c[2], c[0]);
    const n = cross(e1, e2);
    if (dot(n, n) < 1e-24) continue;
    const tri = { v0: c[0], e1, e2, n };
    if (depths.some((z) => z < camera.near)) { everywhere.push(tri); continue; }
    const im = c.map(camera.toImage);
    const lo = (k) => Math.max(0, Math.floor(Math.min(im[0][k], im[1][k], im[2][k]) / cell));
    const hi = (k) => Math.min(GRID - 1, Math.floor(Math.max(im[0][k], im[1][k], im[2][k]) / cell));
    const x0 = lo('x'), x1 = hi('x'), y0 = lo('y'), y1 = hi('y');
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) bins[y * GRID + x].push(tri);
  }
  return { bins, everywhere, cell };
}

/** Does a triangle cross the line from the eye (the origin) to `p` before `p`? */
function hides(tri, p) {
  const along = dot(tri.n, p);
  if (Math.abs(along) <= GRAZING * Math.sqrt(dot(tri.n, tri.n) * dot(p, p))) return false;
  const t = dot(tri.n, tri.v0) / along;
  if (!(t > 0 && t < 1 - OCCLUSION_EPS)) return false;
  // Where it crosses, in the triangle's own coordinates; edges count as inside.
  const h = sub([p[0] * t, p[1] * t, p[2] * t], tri.v0);
  const d00 = dot(tri.e1, tri.e1), d01 = dot(tri.e1, tri.e2), d11 = dot(tri.e2, tri.e2);
  const d20 = dot(h, tri.e1), d21 = dot(h, tri.e2);
  const den = d00 * d11 - d01 * d01;
  const v = (d11 * d20 - d01 * d21) / den;
  const w = (d00 * d21 - d01 * d20) / den;
  return v >= 0 && w >= 0 && v + w <= 1;
}

/**
 * How nearly opposite two edges must leave a shared vertex to be one straight
 * line: 1 - cos, 1e-9, is about 0.003 degrees. A box's edge split into
 * pieces is straight to its coordinates' rounding (float32: ~1e-6 radians);
 * a curve's chords bend by whole degrees.
 */
const JOIN_COS = 1 - 1e-9;

/**
 * Kept edges joined into straight feature lines: each chain of edges of one
 * cause and one set of objects, continuing one another through vertices where
 * they are the only two such, in opposite directions. In the input's order, so
 * the document is the same every time; a joined line's dihedral is its pieces'
 * largest.
 */
function joinCollinear(lines) {
  const group = (l) => `${l.cause}|${[...l.objects].sort().join('|')}`;
  const at = new Map();
  lines.forEach((l, i) => {
    for (const p of [l.a, l.b]) {
      const k = `${key(p)}#${group(l)}`;
      let list = at.get(k);
      if (!list) at.set(k, (list = []));
      list.push(i);
    }
  });
  const far = (l, p) => (key(l.a) === key(p) ? l.b : l.a);
  /** The line going on straight from line i through its end p, or -1. */
  const onward = (i, p) => {
    const list = at.get(`${key(p)}#${group(lines[i])}`);
    if (!list || list.length !== 2) return -1;
    const j = list[0] === i ? list[1] : list[0];
    if (j === i) return -1;
    const u = norm(sub(far(lines[i], p), p)), v = norm(sub(far(lines[j], p), p));
    return dot(u, v) <= -JOIN_COS ? j : -1;
  };
  const used = new Uint8Array(lines.length);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let dihedral = lines[i].dihedral;
    const faces = lines[i].faces ? [...lines[i].faces] : undefined;
    const walk = (start) => {
      let p = start, cur = i;
      for (;;) {
        const j = onward(cur, p);
        if (j < 0 || used[j]) return p;
        used[j] = 1;
        if (lines[j].dihedral > dihedral) dihedral = lines[j].dihedral;
        if (faces) faces.push(...lines[j].faces);
        p = far(lines[j], p);
        cur = j;
      }
    };
    const a = walk(lines[i].a), b = walk(lines[i].b);
    out.push({ ...lines[i], a, b, dihedral, ...(faces ? { faces } : {}) });
  }
  return out;
}

/** Below this, in degrees, two faces are one plane: a quad's diagonal, not a fold. */
const SOFT_MIN = 0.01;
/**
 * How wide, in pixels, a band of soft folds may project and still be one edge.
 * A shading ramp this wide, blurred at the detector's sigma (1.4), still has
 * one gradient peak, at its middle; past about 4 sigma it is a plateau, the
 * turn read as shading, not as a step. 3 px was tried first: a 2 mm fillet on
 * the stack fixture's base cube projects 3.1-3.6 px on its near side.
 */
const ROUNDED_PX = 6;
/** Neighbouring lines of one band are this close in the image: a fillet's facets are a fraction of a pixel. */
const BAND_LINK_PX = 1;

/**
 * Rounded creases: a fillet, whose fold is spread over facets each softer
 * than `creaseAngle`, read as the one crease it shows in the image.
 *
 * `soft` are the soft folds, joined into straight lines with their faces;
 * `hard` the kept edges, joined. A band is soft lines of one object, parallel
 * and overlapping in space, each within BAND_LINK_PX of the next in the image.
 * It is a crease when its folds together exceed `creaseAngle`, it projects no
 * wider than ROUNDED_PX, and no silhouette of the object runs along it within
 * that width -- near an outline, as a cylinder's facets crowd toward its limb,
 * the outline is the edge. The crease is the band's middle line, which lies on
 * the surface; its dihedral is the band's whole turn, and `rounded` its width
 * in pixels.
 */
function roundedCreases(soft, hard, camera, creaseAngle) {
  /** A line in the image, or null if an end is behind the near plane. */
  const project = (l) => {
    const ca = camera.toCamera(l.a), cb = camera.toCamera(l.b);
    if (-ca[2] < camera.near || -cb[2] < camera.near) return null;
    const ia = camera.toImage(ca), ib = camera.toImage(cb);
    const dx = ib.x - ia.x, dy = ib.y - ia.y, len = len2(dx, dy);
    if (len < 1e-9) return null;
    return { ia, ib, mid: [(ia.x + ib.x) / 2, (ia.y + ib.y) / 2], n: [-dy / len, dx / len] };
  };
  const objectsOf = (l) => [...l.objects].sort().join('|');
  const along = (l) => norm(sub(l.b, l.a));
  const parallel = (l, m) => {
    const d = dot(along(l), along(m));
    return d >= JOIN_COS || d <= -JOIN_COS;
  };
  /**
   * How much of the shorter of two lines the other spans IN THE IMAGE, along
   * the first. Not in space: two parallel fillets on opposite sides of a part
   * can project onto one line in the picture, far apart along it, and taken as
   * one band they hid both creases.
   */
  const overlap = (l, m) => {
    const ux = l.ib.x - l.ia.x, uy = l.ib.y - l.ia.y, len = len2(ux, uy);
    const s = (p) => ((p.x - l.ia.x) * ux + (p.y - l.ia.y) * uy) / len;
    const [m0, m1] = [s(m.ia), s(m.ib)].sort((x, y) => x - y);
    const shared = Math.min(len, m1) - Math.max(0, m0);
    const shorter = Math.min(len, m1 - m0);
    return shorter > 0 ? shared / shorter : 0;
  };
  const lines = soft.map((l) => ({ l, at: project(l), objects: objectsOf(l) }));
  const outlines = hard.filter((l) => l.cause === 'silhouette').map((l) => ({ l, at: project(l), objects: objectsOf(l) }));
  const used = new Uint8Array(lines.length);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (used[i] || !lines[i].at) continue;
    const ref = lines[i];
    // Offsets across the reference line in the image, of every soft line that could share its band.
    const offset = (p) => (p[0] - ref.at.mid[0]) * ref.at.n[0] + (p[1] - ref.at.mid[1]) * ref.at.n[1];
    const near = [];
    for (let j = 0; j < lines.length; j++) {
      const c = lines[j];
      if (used[j] || !c.at || c.objects !== ref.objects || !parallel(ref.l, c.l) || overlap(ref.at, c.at) < 0.5) continue;
      const o = offset(c.at.mid);
      if (Math.abs(o) <= 2 * ROUNDED_PX) near.push({ j, o });
    }
    near.sort((x, y) => x.o - y.o || x.j - y.j);
    // The run of lines, each within BAND_LINK_PX of the next, that holds the reference.
    const k = near.findIndex((c) => c.j === i);
    let lo = k, hi = k;
    while (lo > 0 && near[lo].o - near[lo - 1].o <= BAND_LINK_PX) lo--;
    while (hi < near.length - 1 && near[hi + 1].o - near[hi].o <= BAND_LINK_PX) hi++;
    const band = near.slice(lo, hi + 1);
    for (const c of band) used[c.j] = 1;
    const width = band[band.length - 1].o - band[0].o;
    let turn = 0;
    for (const c of band) turn += lines[c.j].l.dihedral;
    if (turn <= creaseAngle || width > ROUNDED_PX) continue;
    // An outline along the band is the edge there.
    const beside = outlines.some((s) => s.at && s.objects === ref.objects && parallel(ref.l, s.l) && overlap(ref.at, s.at) >= 0.5 &&
      offset(s.at.mid) >= band[0].o - ROUNDED_PX && offset(s.at.mid) <= band[band.length - 1].o + ROUNDED_PX);
    if (beside) continue;
    const middle = (band[0].o + band[band.length - 1].o) / 2;
    let best = band[0];
    for (const c of band) if (Math.abs(c.o - middle) < Math.abs(best.o - middle)) best = c;
    const { a, b, objects } = lines[best.j].l;
    out.push({ a, b, cause: 'crease', dihedral: turn, objects, rounded: width });
  }
  return out;
}

/**
 * Predict the edges a scene shows from a camera.
 *
 * @param {object} o
 * @param {{name: string, triangles: ArrayLike<number>, pose?: object, matrix?: number[]}[]} o.objects
 *   each object's triangles, 9 numbers each in its own frame, and where it is:
 *   `pose` ({position, rotation in degrees, scale}) or `matrix` (16 numbers,
 *   column-major, three.js's). Neither: the triangles are already in the world.
 * @param {{position: number[], target: number[], up?: number[], fov: number, near?: number}} o.camera
 *   vertical `fov` in degrees; `near` 0.05 as pt-lab's
 * @param {number} o.size   the image's width and height, in pixels
 * @param {number} [o.creaseAngle=20]  degrees; sharper than this is a crease
 * @param {number} [o.margin=0]  pixels: a sample hidden by less than this --
 *   seen again with its image position moved this far, at its own depth, in
 *   any of eight directions -- counts as visible. For identifying edges from a
 *   belief, which is itself a fraction of a pixel off: an edge the belief
 *   tucks just behind a silhouette may be in plain view
 * @param {boolean} [o.join=false]  one edge for each straight feature line, not
 *   one for each triangle edge along it: a CAD export splits a box's edge into
 *   collinear pieces, and a rounded edge's silhouette runs the length of its
 *   fillet in pieces too. Two kept edges are joined where they are the only two
 *   of one cause and one set of objects at a vertex and leave it in exactly
 *   opposite directions (`JOIN_COS`); a curve's chords, which bend, are not.
 *   And a fillet -- a fold spread over facets each softer than `creaseAngle` --
 *   is one crease where it projects no wider than ROUNDED_PX
 *   (`roundedCreases`): the edge a rounded box shows between two faces
 * @param {string[]} [o.only]  the objects whose edges are wanted; every object
 *   still hides what is behind it. A robot arm's CAD meshes, 120,000
 *   triangles, gave 49,000 edges no gap reading uses, and took a minute a
 *   view; named, only the parts measured are worked out. An edge a named
 *   object shares with an unnamed one is classified from the named one's
 *   faces alone
 * @returns {{size: number, camera: object, creaseAngle: number, edges: object[], vertices: object[], skipped: string[], predicted: object}}
 *   the document `parseGroundTruth` reads, in pt-lab's pixel convention
 */
export function predictEdges({ objects, camera: cam, size, creaseAngle = 20, margin = 0, join = false, only }) {
  if (!Number.isInteger(size) || size < 1) throw new Error(`predictEdges: size must be a positive integer, not ${size}`);
  if (!(cam?.fov > 0 && cam.fov < 180)) throw new Error('predictEdges: the camera needs a vertical fov in degrees');
  if (!(margin >= 0 && margin <= 16)) throw new Error(`predictEdges: margin must be 0 to 16 pixels, not ${margin}`);
  if (only !== undefined && !(Array.isArray(only) && only.every((n) => typeof n === 'string'))) {
    throw new Error('predictEdges: only is a list of object names');
  }
  const wanted = only ? new Set(only) : null;
  const camera = makeCamera(cam, size);

  /* ---- 1. every edge of every object, in world space ---- */

  const edgeMap = new Map();
  const world = [];
  let faceId = 0;
  for (const object of objects) {
    const m = object.matrix ? fromColumnMajor(object.matrix) : object.pose ? poseMatrix(object.pose) : null;
    const tri = object.triangles;
    if (tri.length % 9 !== 0) throw new Error(`predictEdges: ${object.name}'s triangles are not nine numbers each`);
    for (let i = 0; i < tri.length; i += 9) {
      const p = [0, 3, 6].map((k) => (m ? apply(m, tri[i + k], tri[i + k + 1], tri[i + k + 2]) : [tri[i + k], tri[i + k + 1], tri[i + k + 2]]));
      world.push(p);
      const n = cross(sub(p[1], p[0]), sub(p[2], p[0]));
      if (dot(n, n) < 1e-24) continue;   // degenerate: no normal, no edges worth reporting
      // An object not wanted still hides what is behind it, above; it has no edges of its own.
      if (wanted && !wanted.has(object.name)) continue;
      const normal = norm(n);
      const id = ++faceId;
      const centroid = [(p[0][0] + p[1][0] + p[2][0]) / 3, (p[0][1] + p[1][1] + p[2][1]) / 3, (p[0][2] + p[1][2] + p[2][2]) / 3];
      for (let k = 0; k < 3; k++) {
        const a = p[k], b = p[(k + 1) % 3];
        const ka = key(a), kb = key(b);
        const edgeKey = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        let edge = edgeMap.get(edgeKey);
        if (!edge) edgeMap.set(edgeKey, (edge = { a, b, faces: [], objects: new Set() }));
        edge.faces.push({ normal, centroid, id });
        edge.objects.add(object.name);
      }
    }
  }
  const occ = occluders(world, camera, size);
  const seen = (x, y, p) => {
    const gx = Math.min(GRID - 1, Math.max(0, Math.floor(x / occ.cell)));
    const gy = Math.min(GRID - 1, Math.max(0, Math.floor(y / occ.cell)));
    for (const tri of occ.bins[gy * GRID + gx]) if (hides(tri, p)) return false;
    for (const tri of occ.everywhere) if (hides(tri, p)) return false;
    return true;
  };
  // Eight directions, a pixel long each: the axes and the diagonals.
  const D = Math.sqrt(0.5);
  const around = [[1, 0], [-1, 0], [0, 1], [0, -1], [D, D], [-D, D], [D, -D], [-D, -D]];
  const visibleAt = (x, y, p) => {
    if (!(x >= 0 && y >= 0 && x <= size && y <= size)) return false;
    if (seen(x, y, p)) return true;
    if (margin === 0) return false;
    const step = margin * camera.pixelAt(-p[2]);
    // Image y runs down, camera y up: a move of (dx, dy) pixels is (dx, -dy) in camera space.
    return around.some(([dx, dy]) => seen(x + dx * margin, y + dy * margin, [p[0] + dx * step, p[1] - dy * step, p[2]]));
  };

  /* ---- 2. the silhouettes, creases and boundaries ---- */

  const lines = [];
  const soft = [];
  for (const raw of edgeMap.values()) {
    let cause, dihedral;
    if (raw.faces.length < 2) {
      cause = 'boundary';
      dihedral = 180;
    } else {
      const [f0, f1] = raw.faces;
      dihedral = (acos(Math.min(1, Math.max(-1, dot(f0.normal, f1.normal)))) * 180) / PI;
      const front0 = dot(f0.normal, sub(f0.centroid, camera.eye)) < 0;
      const front1 = dot(f1.normal, sub(f1.centroid, camera.eye)) < 0;
      const silhouette = front0 !== front1;
      if (!silhouette && dihedral <= creaseAngle) {
        // A fold too soft to be an edge alone may be one of a fillet's: kept to be read as a band.
        if (join && raw.faces.length === 2 && dihedral > SOFT_MIN) {
          soft.push({ a: raw.a, b: raw.b, cause: 'soft', dihedral, objects: raw.objects, faces: raw.faces });
        }
        continue;
      }
      cause = silhouette ? 'silhouette' : 'crease';
    }
    lines.push({ a: raw.a, b: raw.b, cause, dihedral, objects: raw.objects });
  }
  let features = lines;
  if (join) {
    const hard = joinCollinear(lines);
    features = [...hard, ...roundedCreases(joinCollinear(soft), hard, camera, creaseAngle)];
  }

  const kept = [];
  const edges = [];
  for (const raw of features) {
    const { cause, dihedral } = raw;
    let ca = camera.toCamera(raw.a), cb = camera.toCamera(raw.b);
    let za = -ca[2], zb = -cb[2];
    const near = camera.near;
    if (za < near && zb < near) continue;
    let clipped = false;
    if (za < near) {
      const s = (near - za) / (zb - za);
      ca = [ca[0] + (cb[0] - ca[0]) * s, ca[1] + (cb[1] - ca[1]) * s, ca[2] + (cb[2] - ca[2]) * s];
      za = near;
      clipped = true;
    } else if (zb < near) {
      const s = (near - zb) / (za - zb);
      cb = [cb[0] + (ca[0] - cb[0]) * s, cb[1] + (ca[1] - cb[1]) * s, cb[2] + (ca[2] - cb[2]) * s];
      zb = near;
      clipped = true;
    }

    const ia = camera.toImage(ca), ib = camera.toImage(cb);
    const span = clipToFrame(ia.x, ia.y, ib.x, ib.y, size);
    if (!span) continue;
    const [t0, t1] = span;
    if (t0 > 0 || t1 < 1) clipped = true;
    const x0 = ia.x + (ib.x - ia.x) * t0, y0 = ia.y + (ib.y - ia.y) * t0;
    const x1 = ia.x + (ib.x - ia.x) * t1, y1 = ia.y + (ib.y - ia.y) * t1;
    // Depth is linear in INVERSE depth across the image; so is where along the edge.
    const zAt = (t) => 1 / ((1 - t) / za + t / zb);
    const pointAt = (t) => {
      const s = (t / zb) / ((1 - t) / za + t / zb);
      return [ca[0] + (cb[0] - ca[0]) * s, ca[1] + (cb[1] - ca[1]) * s, ca[2] + (cb[2] - ca[2]) * s];
    };

    const length = len2(x1 - x0, y1 - y0);
    const samples = Math.min(512, Math.max(8, Math.ceil(length) + 1));
    let seen = 0;
    for (let s = 0; s < samples; s++) {
      const u = s / (samples - 1);
      if (visibleAt(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, pointAt(t0 + (t1 - t0) * u))) seen++;
    }

    let angle = (atan2(y1 - y0, x1 - x0) * 180) / PI;
    angle = ((angle % 180) + 180) % 180;
    const edge = {
      id: edges.length + 1, cause, objects: [...raw.objects].sort(),
      x0, y0, x1, y1, z0: zAt(t0), z1: zAt(t1), length, angle, dihedral,
      visible: seen / samples, clipped, v0: 0, v1: 0,
      ...(raw.rounded !== undefined ? { rounded: raw.rounded } : {}),
    };
    edges.push(edge);
    kept.push({ edge, a: raw.a, b: raw.b });
  }

  /* ---- 3. the vertices those edges meet at ---- */

  const vertexMap = new Map();
  const register = (p, other, k) => {
    const id = key(p);
    let v = vertexMap.get(id);
    if (!v) vertexMap.set(id, (v = { p, incident: [], objects: new Set() }));
    v.incident.push({ edge: k.edge, other });
    for (const name of k.edge.objects) v.objects.add(name);
  };
  for (const k of kept) { register(k.a, k.b, k); register(k.b, k.a, k); }

  const vertices = [];
  for (const raw of vertexMap.values()) {
    const cv = camera.toCamera(raw.p);
    const z = -cv[2];
    if (z < camera.near) continue;
    const here = camera.toImage(cv);
    const directions = [];
    for (const inc of raw.incident) {
      let co = camera.toCamera(inc.other);
      const zo = -co[2];
      if (zo < camera.near) {
        const s = (camera.near - zo) / (z - zo);
        co = [co[0] + (cv[0] - co[0]) * s, co[1] + (cv[1] - co[1]) * s, co[2] + (cv[2] - co[2]) * s];
      }
      const there = camera.toImage(co);
      const dx = there.x - here.x, dy = there.y - here.y;
      if (len2(dx, dy) > 1e-9) directions.push([dx, dy]);
    }
    let widest = 0;
    for (let i = 0; i < directions.length; i++) {
      for (let j = i + 1; j < directions.length; j++) {
        const a = lineAngle(directions[i][0], directions[i][1], directions[j][0], directions[j][1]);
        if (a > widest) widest = a;
      }
    }
    const onFrame = here.x >= 0 && here.y >= 0 && here.x < size && here.y < size;
    const id = vertices.length + 1;
    for (const inc of raw.incident) {
      if (inc.edge.v0 === 0) inc.edge.v0 = id;
      else inc.edge.v1 = id;
    }
    vertices.push({
      id, x: here.x, y: here.y, z,
      degree: raw.incident.length,
      visibleDegree: raw.incident.filter((i) => i.edge.visible > 0).length,
      onFrame,
      visible: onFrame && visibleAt(here.x, here.y, cv),
      angle: widest,
      objects: [...raw.objects].sort(),
    });
  }

  return {
    size,
    camera: { position: [...cam.position], target: [...cam.target], fov: cam.fov, aspect: 1 },
    creaseAngle,
    edges,
    vertices,
    skipped: [],
    predicted: { from: 'geometry', visibility: 'exact', margin, near: camera.near, occlusionEps: OCCLUSION_EPS },
  };
}
