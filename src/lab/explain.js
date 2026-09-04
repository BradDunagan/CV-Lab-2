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
  depthStep: 0.02,     // metres; a step this size is a different surface
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
 * The points to sample across one feature: pairs either side of it.
 *
 * A segment is crossed perpendicular at several places along its length, and
 * the results are combined with a MEDIAN rather than a mean. A fitted segment
 * routinely overshoots its real extent by a pixel or two, so a few of its
 * samples land past the end of whatever caused it and measure something else
 * entirely; a mean lets those decide the answer and a median does not.
 *
 * A corner is a point, so it is crossed along both axes instead.
 */
function crossings(feature, { offset, samples }) {
  const pairs = [];

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
 * Measure what changes across a feature, and say what that makes it.
 *
 * `depth` is in metres, already unpacked. `normal` holds components in [0,1].
 * `albedo` is linear reflectance. Any of them may be null, in which case the
 * test it settles is skipped and the cause falls through — an honest
 * `unknown` rather than a confident `shading` reached by not looking.
 */
function explainFeature(feature, { depth, normal, albedo }, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const pairs = crossings(feature, o);
  if (pairs.length === 0) return { cause: 'unknown', depthStep: 0, normalStep: 0, albedoStep: 0 };

  const depths = [], normals = [], albedos = [];
  for (const [a, b] of pairs) {
    if (depth) depths.push(Math.abs(sample(depth, a.x, a.y, 0) - sample(depth, b.x, b.y, 0)));
    if (normal) normals.push(angleBetween(normalAt(normal, a.x, a.y), normalAt(normal, b.x, b.y)));
    if (albedo) {
      let worst = 0;
      for (let c = 0; c < Math.min(3, albedo.channels); c++) {
        worst = Math.max(worst, Math.abs(sample(albedo, a.x, a.y, c) - sample(albedo, b.x, b.y, c)));
      }
      albedos.push(worst);
    }
  }

  const evidence = {
    depthStep: median(depths),
    normalStep: median(normals),
    albedoStep: median(albedos),
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
  else if (depth && evidence.depthStep >= o.depthStep) cause = 'occlusion';
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
  CAUSES, DEFAULTS,
};
