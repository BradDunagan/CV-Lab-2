'use strict';

/**
 * Reading a renderer's ground truth into the lab as features.
 *
 * `fit` and `corners` say what the pipeline THINKS is in an image. Nothing
 * until now said what is actually in it. pt-lab knows — it has the meshes and
 * the camera — and `npm run generate -- --truth` writes that out per image:
 * silhouette, crease and boundary edges projected into image space, each with
 * the fraction of it that is really visible, and the vertices they meet at.
 *
 * This is the loader. It does no matching and makes no judgements; it turns a
 * JSON document into `gt-edge` and `gt-vertex` feature records so that the
 * comparison can be an ordinary operation over ordinary features.
 *
 * Pure JavaScript, no Electron and no native dependency, like the rest of
 * src/lab/.
 *
 * WHY THE VALIDATION IS THIS THOROUGH
 *
 * design-lab-model.md §3 says every kernel treats its input as hostile, and a
 * session file or a ground-truth file from someone else is exactly the case it
 * had in mind. Nothing here reaches C, so a bad field cannot corrupt memory —
 * but a NaN propagating into a distance is a silently wrong measurement, which
 * is the failure this project cares most about. Refusing with a message that
 * names the field beats computing an answer nobody can trust.
 */

/** The fields each record kind must carry, and what a valid one looks like. */
const EDGE_NUMBERS = ['x0', 'y0', 'x1', 'y1', 'z0', 'z1', 'length', 'angle', 'dihedral', 'visible'];
const VERTEX_NUMBERS = ['x', 'y', 'z', 'angle'];
const CAUSES = new Set(['silhouette', 'crease', 'boundary']);

class GroundTruthError extends Error {}

function fail(where, message) {
  throw new GroundTruthError(`groundTruth: ${where} ${message}`);
}

function finiteNumber(value, where, field) {
  const n = value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    fail(where, `needs a finite number for "${field}" (got ${JSON.stringify(n)})`);
  }
  return n;
}

function positiveInt(value, where, field) {
  if (!Number.isInteger(value) || value < 0) {
    fail(where, `needs a non-negative integer for "${field}" (got ${JSON.stringify(value)})`);
  }
  return value;
}

function nameList(value, where) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    fail(where, `needs "objects" to be an array of strings`);
  }
  // Sorted so the record hashes the same however the writer ordered them.
  return [...value].sort();
}

/**
 * Turn a parsed ground-truth document into feature records.
 *
 * @param {object} doc   the parsed JSON
 * @param {string} where a label for error messages, normally the file path
 * @returns {{features: Array, width: number, height: number, meta: object}}
 */
function parseGroundTruth(doc, where = 'the ground-truth document') {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    fail(where, 'is not an object');
  }
  const size = doc.size;
  if (!Number.isInteger(size) || size < 1 || size > (1 << 20)) {
    fail(where, `needs an integer "size" between 1 and ${1 << 20} (got ${JSON.stringify(size)})`);
  }
  if (!Array.isArray(doc.edges)) fail(where, 'needs an "edges" array');
  if (!Array.isArray(doc.vertices)) fail(where, 'needs a "vertices" array');

  const features = [];

  doc.edges.forEach((raw, i) => {
    const at = `${where}: edges[${i}]`;
    if (!raw || typeof raw !== 'object') fail(at, 'is not an object');
    if (!CAUSES.has(raw.cause)) {
      fail(at, `needs "cause" to be one of ${[...CAUSES].join(', ')} (got ${JSON.stringify(raw.cause)})`);
    }
    const record = {
      // Namespaced, like every other feature type here: a future region or
      // flow ground truth must not collide with this one merely by both
      // wanting the word "edge".
      type: 'gt-edge',
      id: positiveInt(raw.id, at, 'id'),
      cause: raw.cause,
      objects: nameList(raw.objects, at),
      clipped: raw.clipped === true,
      v0: positiveInt(raw.v0 ?? 0, at, 'v0'),
      v1: positiveInt(raw.v1 ?? 0, at, 'v1'),
    };
    for (const field of EDGE_NUMBERS) record[field] = finiteNumber(raw[field], at, field);
    if (record.visible < 0 || record.visible > 1) {
      fail(at, `needs "visible" in [0, 1] (got ${record.visible})`);
    }
    features.push(record);
  });

  doc.vertices.forEach((raw, i) => {
    const at = `${where}: vertices[${i}]`;
    if (!raw || typeof raw !== 'object') fail(at, 'is not an object');
    const record = {
      type: 'gt-vertex',
      id: positiveInt(raw.id, at, 'id'),
      objects: nameList(raw.objects, at),
      degree: positiveInt(raw.degree, at, 'degree'),
      visibleDegree: positiveInt(raw.visibleDegree ?? 0, at, 'visibleDegree'),
      onFrame: raw.onFrame !== false,
      visible: raw.visible === true,
    };
    for (const field of VERTEX_NUMBERS) record[field] = finiteNumber(raw[field], at, field);
    features.push(record);
  });

  return {
    features,
    width: size,
    height: size,
    meta: {
      camera: doc.camera ?? null,
      maxDepth: typeof doc.maxDepth === 'number' ? doc.maxDepth : null,
      creaseAngle: typeof doc.creaseAngle === 'number' ? doc.creaseAngle : null,
      image: typeof doc.image === 'string' ? doc.image : null,
    },
  };
}

/** Parse from text, so the caller decides how the bytes arrived. */
function readGroundTruth(text, where) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    fail(where, `is not valid JSON — ${err.message}`);
  }
  return parseGroundTruth(doc, where);
}

module.exports = { parseGroundTruth, readGroundTruth, GroundTruthError };
