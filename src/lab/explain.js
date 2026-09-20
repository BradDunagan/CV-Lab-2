'use strict';

/**
 * Why is this edge in the picture?
 *
 * A detector answers "there is an edge here". It cannot answer what put it
 * there, because the beauty render does not contain that information: a
 * shadow boundary and a silhouette are both a step in luminance and nothing
 * in the image distinguishes them. The renderer's auxiliary passes do —
 * see `glossary.md`, AOV.
 *
 * | depth step | normal step | albedo step | the edge is |
 * |---|---|---|---|
 * | yes | — | — | an OCCLUSION — one surface ending in front of another |
 * | no | yes | — | a CREASE — a fold, with no step |
 * | no | no | yes | TEXTURE — paint rather than shape |
 * | no | no | no | SHADING — a shadow boundary or specular terminator |
 *
 * **The depth test is a residual, not a difference, and v1 got that wrong.**
 * Sampling a fixed distance either side of an edge on a surface turned away
 * from the camera reads a large depth difference with nothing occluding
 * anything: the surface simply recedes. Measured over six helmet views, 241 of
 * the 282 detections v1 called `occlusion` were that — a single tangent plane
 * through the sample midpoint accounted for the difference to within 1%, where
 * across a genuine step the same plane accounts for 7% of it. So the depth
 * evidence here is what a locally flat surface at the measured orientation
 * does NOT explain, and `depthStep` (measured) and `planeStep` (explained) are
 * both recorded so a record says which it was.
 *
 * Note what this does not do: threshold on slant. Median slant is 64.0° under
 * the misread detections and 64.1° under the genuine steps — both live at a
 * silhouette, where a surface turns away AND where one surface ends in front
 * of another — so a slant threshold would be exactly as wrong as the raw depth
 * one. Only the residual separates them. See design-lab-model.md §11.
 *
 * That last row is the one this exists for. A shading edge is a real image
 * edge belonging to the LIGHT rather than to the object, so a detector is
 * right to find it and ground truth — which models only geometry — is right
 * to call it invented. Scoring them together as "not geometry" throws away
 * the distinction between a detector that is wrong and a detector that is
 * answering a question nobody asked it.
 *
 * Pure JavaScript, no pixels of its own: it is handed decoded rasters and
 * feature records, so every number here is arithmetic a test can check by
 * hand. The unpacking of pt-lab's fixed-point depth lives in the operation,
 * where the buffers are.
 */

/** The causes, in the order they are tested. First match wins. */
const CAUSES = ['occlusion', 'crease', 'texture', 'shading'];

/**
 * Where to sample, either side of an edge.
 *
 * Far enough out that blur and non-maximum suppression have not smeared the
 * two sides into each other — the same reasoning that puts `match`'s default
 * distance at three pixels — and no further, because a wider reach starts
 * reporting the NEXT feature along instead of this one.
 */
const DEFAULTS = {
  offset: 2.5,
  samples: 7,
  depthStep: 0.02,     // metres; an UNEXPLAINED step this size is another surface
  normalStep: 20,      // degrees between the two sides' normals
  albedoStep: 0.06,    // linear reflectance difference
};

/** Bilinear read of one channel, clamped at the edges. */
function sample(raster, x, y, channel) {
  const { width, height, channels, data } = raster;
  const cx = Math.min(width - 1, Math.max(0, x));
  const cy = Math.min(height - 1, Math.max(0, y));
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0, fy = cy - y0;
  const at = (px, py) => data[(py * width + px) * channels + channel];
  const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const bot = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return top * (1 - fy) + bot * fy;
}

const median = (xs) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Unit normal at a pixel, from a pass holding components packed into [0,1]. */
function normalAt(raster, x, y) {
  const n = [0, 1, 2].map((c) => sample(raster, x, y, c) * 2 - 1);
  const len = Math.hypot(n[0], n[1], n[2]);
  return len > 1e-6 ? n.map((v) => v / len) : [0, 0, 0];
}

function angleBetween(a, b) {
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  if (!Number.isFinite(dot)) return 0;
  return (Math.acos(dot) * 180) / Math.PI;
}

/**
 * Sample pairs across a circular arc, along its radius at each point.
 *
 * Inset from both ends for the same reason a segment's samples are: the
 * extreme samples are the ones most likely to have overshot the real extent.
 *
 * An arc narrower than the offset gets no pairs at all, so it comes back
 * `unknown` rather than measured. The inner sample of such an arc would sit
 * past the centre and read the FAR side of the same curve, which is a number
 * with nothing wrong with it and no relationship to the question.
 */
function arcCrossings(feature, { offset, samples }) {
  const pairs = [];
  const { cx, cy, r } = feature;
  if (!Number.isFinite(r) || !(r > offset)) return pairs;

  const a0 = (feature.angle0 * Math.PI) / 180;
  const sweep = (feature.sweep * Math.PI) / 180;
  for (let i = 0; i < samples; i++) {
    const t = (i + 1) / (samples + 1);
    const a = a0 + sweep * t;
    // The radial unit vector IS the arc's normal at this point.
    const nx = Math.cos(a), ny = Math.sin(a);
    const px = cx + r * nx, py = cy + r * ny;
    pairs.push([
      { x: px - nx * offset, y: py - ny * offset },
      { x: px + nx * offset, y: py + ny * offset },
    ]);
  }
  return pairs;
}

/**
 * The points to sample across one feature: pairs either side of it.
 *
 * A segment is crossed perpendicular at several places along its length, and
 * the results are combined with a MEDIAN rather than a mean. A fitted segment
 * routinely overshoots its real extent by a pixel or two, so a few of its
 * samples land past the end of whatever caused it and measure something else
 * entirely; a mean lets those decide the answer and a median does not.
 *
 * A corner is a point, so it is crossed along both axes instead.
 *
 * An arc is crossed RADIALLY — its normal turns with it, which is the only
 * thing that differs from a segment. Everything downstream of here works on
 * pairs of points and needs no notion of what shape produced them, so nothing
 * else in this file changes for a curve.
 */
function crossings(feature, { offset, samples }) {
  const pairs = [];

  if (feature.type === 'edge-arc') return arcCrossings(feature, { offset, samples });

  if (feature.type === 'edge-corner') {
    for (const [dx, dy] of [[1, 0], [0, 1], [0.707, 0.707], [0.707, -0.707]]) {
      pairs.push([
        { x: feature.x - dx * offset, y: feature.y - dy * offset },
        { x: feature.x + dx * offset, y: feature.y + dy * offset },
      ]);
    }
    return pairs;
  }

  const dx = feature.x1 - feature.x0;
  const dy = feature.y1 - feature.y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return pairs;
  const nx = -dy / len, ny = dx / len;

  for (let i = 0; i < samples; i++) {
    // Inset from both ends: the extreme samples are the ones most likely to
    // have overshot, and they are also where a corner puts a third surface
    // into the neighbourhood.
    const t = (i + 1) / (samples + 1);
    const px = feature.x0 + dx * t;
    const py = feature.y0 + dy * t;
    pairs.push([
      { x: px - nx * offset, y: py - ny * offset },
      { x: px + nx * offset, y: py + ny * offset },
    ]);
  }
  return pairs;
}

/**
 * What a locally flat surface accounts for, so the rest can be the evidence.
 *
 * The normal pass is in VIEW space — established by measurement, since nothing
 * documented it: fitting the prediction below against the depth pass gives
 * 0.99 with the normals as they are and 1.16 with them rotated out of world
 * space, and one pixel's normal stays +Z-dominant across three cameras 6 m
 * apart, which world-space normals of a convex object cannot do.
 *
 * That is why only the FIELD OF VIEW is needed and not where the camera is: a
 * view-space normal is already in the frame the depth pass is measured in, so
 * the focal length is the whole of the camera that matters here.
 */
function viewGeometry(camera, width, height) {
  const fov = camera?.fov;
  if (typeof fov !== 'number' || !(fov > 0) || !(fov < 180)) return null;
  return {
    f: (height / 2) / Math.tan((fov * Math.PI) / 360),
    cx: width / 2,
    cy: height / 2,
  };
}

/** The direction from the camera through a pixel, in view space: -Z forward. */
function viewRay(g, x, y) {
  return [(x - g.cx) / g.f, -(y - g.cy) / g.f, -1];
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * How far the depth on one side of a pair sits from where a continuous surface
 * would put it — the evidence that one surface ends in front of another.
 *
 * Each side's tangent plane is extended to the other side and asked what depth
 * it predicts there; the answer is compared with the depth actually recorded.
 * For a point at view-space depth `z` the position is `z * (ex, ey, -1)` — the
 * depth pass holds distance along the view axis, not radius — so the plane
 * `n·P = c` gives `z = c / (n·e)` at any other pixel. A surface that merely
 * recedes predicts its other side exactly and leaves nothing; a step is
 * precisely what extrapolation cannot reach.
 *
 * Two details, both of which a test had to find rather than reasoning reach:
 *
 * **Anchored on the samples, never on the midpoint between them.** The
 * midpoint of a pair straddling a real edge is the one place where neither
 * surface is — its normal is a blend of two and its depth the average of two —
 * and since the prediction scales with that depth, a 0.4 m step measured this
 * way accounted for a fifth of itself.
 *
 * **The LARGER of the two prediction errors, not the smaller.** A plane
 * anchored on the far side of a step is anchored deeper, and slant costs depth
 * in proportion to depth, so that side over-explains and hides the step it is
 * standing on. Taking the larger error asks whether the depth is reachable
 * from the nearer surface, which is the question.
 *
 * Returns null when it cannot be computed rather than guessing: no camera, no
 * normal pass, no normal recorded at either sample, or a plane so nearly
 * edge-on to the ray that the intersection runs away. A null leaves the raw
 * difference standing — v1's behaviour, reached honestly and visible in the
 * record as `planeStep: 0`.
 */
function surfaceResidual(g, normal, depth, a, b) {
  if (!g || !normal || !depth) return null;
  const oneSided = (from, to) => {
    const n = normalAt(normal, from.x, from.y);
    if (!n[0] && !n[1] && !n[2]) return null;
    const z = sample(depth, from.x, from.y, 0);
    const e = viewRay(g, from.x, from.y);
    const c = dot3(n, [e[0] * z, e[1] * z, -z]);
    const predicted = c / dot3(n, viewRay(g, to.x, to.y));
    if (!Number.isFinite(predicted)) return null;
    return Math.abs(sample(depth, to.x, to.y, 0) - predicted);
  };
  const ab = oneSided(a, b), ba = oneSided(b, a);
  if (ab === null && ba === null) return null;
  return Math.max(ab ?? 0, ba ?? 0);
}

/** How far the surface is turned from the line of sight, in degrees. */
function slantAt(g, normal, x, y) {
  if (!g || !normal) return 0;
  const n = normalAt(normal, x, y);
  if (!n[0] && !n[1] && !n[2]) return 0;
  const e = viewRay(g, x, y);
  const len = Math.hypot(e[0], e[1], e[2]);
  const cos = Math.min(1, Math.abs(dot3(n, e)) / len);
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Measure what changes across a feature, and say what that makes it.
 *
 * `depth` is in metres, already unpacked. `normal` holds components in [0,1],
 * in view space. `albedo` is linear reflectance. `camera` needs only a `fov`,
 * and without it the depth evidence cannot be corrected for slant — see
 * `planeAccountsFor`. Any of them may be null, in which case the test it
 * settles is skipped and the cause falls through — an honest `unknown` rather
 * than a confident `shading` reached by not looking.
 */
function explainFeature(feature, { depth, normal, albedo, camera }, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const pairs = crossings(feature, o);
  if (pairs.length === 0) {
    return { cause: 'unknown', depthStep: 0, planeStep: 0, depthExcess: 0,
             normalStep: 0, albedoStep: 0, slant: 0 };
  }

  const g = depth ? viewGeometry(camera, depth.width, depth.height) : null;
  const depths = [], planes = [], excesses = [], normals = [], albedos = [], slants = [];
  for (const [a, b] of pairs) {
    if (depth) {
      const measured = Math.abs(sample(depth, a.x, a.y, 0) - sample(depth, b.x, b.y, 0));
      const residual = surfaceResidual(g, normal, depth, a, b);
      // Capped at the measured difference, so `planeStep` is never negative:
      // nothing can be more unexplained than it was measured to be.
      const excess = residual === null ? measured : Math.min(measured, residual);
      depths.push(measured);
      planes.push(measured - excess);
      excesses.push(excess);
      slants.push(slantAt(g, normal, (a.x + b.x) / 2, (a.y + b.y) / 2));
    }
    if (normal) normals.push(angleBetween(normalAt(normal, a.x, a.y), normalAt(normal, b.x, b.y)));
    if (albedo) {
      let worst = 0;
      for (let c = 0; c < Math.min(3, albedo.channels); c++) {
        worst = Math.max(worst, Math.abs(sample(albedo, a.x, a.y, c) - sample(albedo, b.x, b.y, c)));
      }
      albedos.push(worst);
    }
  }

  /*
   * Each is the median over the pairs, INCLUDING the excess -- which is the
   * median of the per-pair residuals, not the difference of two medians. Those
   * are not the same number, and only the first one is a residual.
   */
  const evidence = {
    depthStep: median(depths),
    planeStep: median(planes),
    depthExcess: median(excesses),
    normalStep: median(normals),
    albedoStep: median(albedos),
    slant: median(slants),
  };

  /*
   * Order matters and is not arbitrary. An occluding edge has a normal step
   * too -- the two surfaces face different ways -- and usually an albedo step
   * as well, so testing depth first is what keeps a silhouette from being
   * reported as a crease. Each test is only meaningful once the ones above it
   * have failed.
   */
  let cause;
  if (!depth && !normal && !albedo) cause = 'unknown';
  else if (depth && evidence.depthExcess >= o.depthStep) cause = 'occlusion';
  else if (normal && evidence.normalStep >= o.normalStep) cause = 'crease';
  else if (albedo && evidence.albedoStep >= o.albedoStep) cause = 'texture';
  else if (depth && normal && albedo) cause = 'shading';
  else cause = 'unknown';

  return { cause, ...evidence };
}

/**
 * Explain every feature in a list.
 *
 * Returns new records rather than mutating: a features slot is content-hashed,
 * and a kernel that edited its input in place would make two slots share one
 * object and one hash describe both.
 */
function explainFeatures(features, rasters, opts = {}) {
  return features.map((f) => ({ ...f, ...explainFeature(f, rasters, opts) }));
}

module.exports = {
  explainFeatures, explainFeature, crossings, sample, normalAt, angleBetween, median,
  viewGeometry, viewRay, surfaceResidual, slantAt,
  CAUSES, DEFAULTS,
};
