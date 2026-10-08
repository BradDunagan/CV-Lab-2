/**
 * The first slice of operations — design-lab-model.md §10.
 *
 * Schemas only for now: `kernel` is filled in as each is implemented, and
 * `implemented` reflects that. Declaring them up front is deliberate — the
 * command parser, the dropdowns and the generated docs all read from here, so
 * an operation can be designed, argued about and validated before a line of C
 * exists for it.
 */

import { Registry, defineOp } from './registry.js';
import { findCorners } from './corners.js';
import { readGroundTruth } from './groundtruth.js';
import { matchFeatures } from './match.js';
import { explainFeatures } from './explain.js';
import { fitPairs, findPairs, trackPair } from './pairs.js';

/**
 * Bind a declared operation to its C kernel.
 *
 * `backend` is a getter for the compute backend the registry was given --
 * the Node-API addon, or the WebAssembly module (`./wasm.js`) -- so this
 * module, and the registry tests, load without either. Only running a kernel
 * needs one.
 *
 * There is no per-operation code here: the kernels share a C signature, so
 * dispatch is one call whatever the op.
 */
function nativeKernel(backend, name, { scalars = false } = {}) {
  return ({ inputs, params }) => {
    const native = backend();
    const result = native.runKernel(name, inputs.map((v) => v.handle), params);
    return scalars ? { kind: 'scalars', values: result } : { kind: 'buffer', handle: result };
  };
}

/**
 * `load` is the one operation whose kernel cannot live in C.
 *
 * Chromium's image decoder is excellent, handles every format the platform
 * knows, and is already in the process — but it only exists in a renderer.
 * So the decoder is injected: the preload supplies one, and under plain node
 * there is none, which is why `load` correctly reports itself unimplemented
 * outside the app rather than throwing when called.
 *
 * The 8-bit-to-f32 conversion still happens in C. Only the decode is borrowed.
 */
function loadKernel(backend, decodeFile, readTextFile) {
  return async ({ params }) => {
    if (!params.path) throw new Error('load: path is required');
    const native = backend();
    const { width, height, pixels, declared, detail } = await decodeFile(params.path);

    /*
     * A camera's response curve, measured (`npm run response`): what each
     * stored code means in linear light. It replaces `from` -- the file's own
     * declaration is about the encoding a viewer should assume, not about
     * what the sensor saw -- and is applied as an exact 256-entry table into
     * f32, so no light the code distinguishes is rounded away again. A
     * contrast curve left in costs four to nine times the gap error; undone,
     * nothing (design-lab-model.md §5, "A thirty-sixth").
     */
    if (params.curve) {
      const table = readCurve(await readTextFile(params.curve), params.curve);
      const values = new Float32Array(width * height * 3);
      for (let i = 0; i < width * height; i++) {
        for (let c = 0; c < 3; c++) values[i * 3 + c] = table[pixels[i * 4 + c]];
      }
      const linear = native.createBuffer({ width, height, channels: 3, dtype: 'f32', space: 'linear' });
      native.bufferWrite(linear, values);
      if (params.as === 'linear') return { kind: 'buffer', handle: linear };
      // The same kernel `toSrgb` runs, so the two routes to an encoded value agree (§5).
      try {
        return { kind: 'buffer', handle: native.runKernel('toSrgb', [linear], {}) };
      } finally {
        native.bufferRelease(linear);
      }
    }

    /*
     * `from` says what the stored bytes mean. Most files declare nothing and
     * the convention -- which every decoder follows -- is sRGB, so that is the
     * default. When a file DOES declare, and disagrees, refuse rather than
     * quietly applying a curve that was never there. Same rule as the colour
     * space check in the session: an explicit correction beats a silent guess.
     */
    if ((declared === 'srgb' || declared === 'linear') && declared !== params.from) {
      throw new Error(
        `load: the file declares ${declared} samples (${detail}), but from=${params.from}. ` +
          `Pass from=${declared}.`
      );
    }

    return {
      kind: 'buffer',
      handle: native.bufferFromRGBA8(pixels, width, height,
        { from: params.from, as: params.as }),
    };
  };
}

/**
 * A response-curve file's table: 256 linear values, one per 8-bit code,
 * finite, non-negative and non-decreasing. Anything else is refused by name
 * rather than applied -- a curve that folds back maps two lights to one.
 */
function readCurve(text, where) {
  let doc;
  try { doc = JSON.parse(text); } catch (err) { throw new Error(`load: ${where} is not JSON (${err.message})`); }
  const t = doc && doc.linear;
  if (!Array.isArray(t) || t.length !== 256) throw new Error(`load: ${where} needs "linear", 256 values, one per 8-bit code`);
  for (let u = 0; u < 256; u++) {
    if (!(Number.isFinite(t[u]) && t[u] >= 0)) throw new Error(`load: ${where}: linear[${u}] is not a non-negative number`);
    if (u > 0 && t[u] < t[u - 1]) throw new Error(`load: ${where}: linear[${u}] < linear[${u - 1}]; a response curve does not decrease`);
  }
  return Float64Array.from(t);
}

/**
 * `groundTruth`'s kernel: a JSON file in, feature records out.
 *
 * Injected the same way `load`'s decoder is, though for a different reason.
 * `load` HAS to borrow Chromium's decoder, which exists only in a renderer;
 * reading a JSON file is plain Node and works everywhere, so this defaults to
 * a real read and the injection point exists for tests rather than for
 * capability. That is why, unlike `load`, this operation is never unimplemented.
 */
function groundTruthKernel(readTextFile) {
  return async ({ params }) => {
    if (!params.path) throw new Error('groundTruth: path is required');
    const text = await readTextFile(params.path);
    const { features, width, height, meta } = readGroundTruth(text, params.path);
    const wanted = params.kind;
    return {
      kind: 'features',
      features: wanted === 'both'
        ? features
        : features.filter((f) => f.type === (wanted === 'edges' ? 'gt-edge' : 'gt-vertex')),
      // Ground truth has the dimensions of the image it was measured in, the
      // same as any other feature list -- and `match` checks them, because
      // scoring a 512-pixel run against 256-pixel truth would otherwise
      // produce numbers rather than an error.
      width,
      height,
      /*
       * What the file says about the SCENE rather than about any one feature.
       *
       * `maxDepth` is the reason this is carried at all: it is the metre scale
       * pt-lab packed the depth pass against, it exists nowhere else -- the
       * passes are written with no colour chunks at all -- and `explain` needs
       * it to read that pass in metres. Parsed all along and dropped here,
       * which left the one number needed to read a depth pass unreachable from
       * inside the lab.
       */
      meta,
    };
  };
}

/**
 * The kernel fitPairs and findPairs share: features and the gray image they
 * were detected in, checked against each other, then handed to `run`.
 */
function pairKernel(backend, name, run, inputs, params) {
  const native = backend();
  const [src, image] = inputs;
  const info = native.bufferInfo(image.handle);
  /*
   * Declared in the registry and checked here: nothing between it and
   * a JavaScript kernel enforces `channels`, and a colour image would
   * be fitted on its red channel without a word.
   */
  if (info.channels !== 1) {
    throw new Error(
      `${name}: image has ${info.channels} channels and needs 1. ` +
        `Pass the gray image, before gaussian: G = gray(A)`
    );
  }
  if (info.width !== src.width || info.height !== src.height) {
    throw new Error(
      `${name}: image is ${info.width}x${info.height} but the features were ` +
        `measured in ${src.width}x${src.height}. Their coordinates do not mean ` +
        `the same thing.`
    );
  }
  return {
    kind: 'features',
    features: run(
      src.features,
      { width: info.width, height: info.height, channels: info.channels,
        data: native.bufferRead(image.handle) },
      params
    ),
    width: src.width,
    height: src.height,
  };
}

/**
 * trackPair's kernel: the gray image alone, and what an earlier frame measured
 * as parameters. One `edge-track` record, or none.
 */
function trackKernel(backend, inputs, params) {
  const native = backend();
  const [image] = inputs;
  const info = native.bufferInfo(image.handle);
  if (info.channels !== 1) {
    throw new Error(
      `trackPair: image has ${info.channels} channels and needs 1. ` +
        `Pass the gray image, before gaussian: G = gray(A)`
    );
  }
  if (!(Math.hypot(params.x1 - params.x0, params.y1 - params.y0) > 0)) {
    throw new Error('trackPair: the carried line has no length; give x0, y0, x1, y1');
  }
  const raster = { width: info.width, height: info.height, channels: 1, data: native.bufferRead(image.handle) };
  const record = trackPair(raster, {
    line: { x0: params.x0, y0: params.y0, x1: params.x1, y1: params.y1 },
    toward: [params.towardX, params.towardY],
    stripLevel: params.stripLevel,
    aperture: params.aperture,
  }, {
    guess: params.guess, pad: params.pad, levelSlope: params.levelSlope, strip: params.strip, profile: params.profile, wideEnd: params.wideEnd,
    ledge: params.ledge === 'fit' ? 'fit'
      : params.ledge === 'held' ? { offset: params.ledgeOffset, width: params.ledgeWidth } : null,
    movingBelow: params.moving === 'below',
  });
  return { kind: 'features', features: record ? [record] : [], width: info.width, height: info.height };
}

/*
 * The host's, always: this package reads no files and loads no addon of its
 * own, so it runs where neither exists. cv-lab's host is src/lab-host.js.
 */
function missing(what, how) {
  return () => { throw new Error(`no ${what}: ${how}`); };
}

/** @param {import('./types.js').HostOptions} [options] */
function buildOps({ backend: given, decodeFile, readTextFile } = {}) {
  const backend = given ? () => given
    : missing('compute backend', 'pass createRegistry({ backend }), the addon or the WebAssembly module');
  readTextFile ??= missing('file reader', 'pass createRegistry({ readTextFile })');
  return [
    defineOp({
      name: 'load',
      version: 2,
      summary: 'Decode an image file into a new buffer.',
      inputs: [],
      params: [
        { name: 'path', type: 'string', default: '' },
        // Decoding yields sRGB-encoded values (§2). Whether the lab converts to
        // linear on load is the open policy question in §11; until it is
        // settled, the caller states what it wants and the record says which
        // happened, so no session is ambiguous in retrospect.
        // What the stored bytes mean. PNG can declare this (gAMA, sRGB, iCCP,
        // cICP) but most files declare nothing, in which case sRGB is the
        // universal convention.
        { name: 'from', type: 'enum', values: ['srgb', 'linear'], default: 'srgb' },
        // What the buffer should hold.
        { name: 'as', type: 'enum', values: ['srgb', 'linear'], default: 'srgb' },
        // A measured response curve (`npm run response`), in place of `from`:
        // a JSON file whose "linear" holds the light each 8-bit code stands for.
        { name: 'curve', type: 'string', default: '' },
      ],
      output: { channels: 3, dtype: 'f32' },
      cancellable: false,
      kernel: decodeFile ? loadKernel(backend, decodeFile, readTextFile) : null,
    }),

    defineOp({
      name: 'pattern',
      version: 1,
      summary: 'Generate a synthetic test image. Needs no file.',
      inputs: [],
      params: [
        { name: 'kind', type: 'enum', values: ['ramp', 'checker', 'impulse', 'constant'], default: 'ramp' },
        { name: 'width', type: 'int', default: 64, min: 1, max: 1 << 20 },
        { name: 'height', type: 'int', default: 64, min: 1, max: 1 << 20 },
        { name: 'channels', type: 'int', default: 1, min: 1, max: 4 },
        { name: 'value', type: 'number', default: 0.5 },
      ],
      output: { channels: 'same', dtype: 'f32', space: 'linear' },
      kernel: nativeKernel(backend, 'pattern'),
    }),

    defineOp({
      name: 'toLinear',
      version: 1,
      summary: 'Undo the sRGB transfer function, so values become proportional to light.',
      inputs: [{ name: 'src', space: 'srgb' }],
      params: [],
      output: { channels: 'same', dtype: 'f32', space: 'linear' },
      kernel: nativeKernel(backend, 'toLinear'),
    }),

    defineOp({
      name: 'toSrgb',
      version: 1,
      summary: 'Apply the sRGB transfer function, for display or for saving.',
      inputs: [{ name: 'src', space: 'linear' }],
      params: [],
      output: { channels: 'same', dtype: 'f32', space: 'srgb' },
      kernel: nativeKernel(backend, 'toSrgb'),
    }),

    defineOp({
      name: 'gray',
      version: 1,
      summary: 'Convert to single-channel luminance.',
      // Luminance coefficients are only valid on linear values (§2), so this is
      // the first operation where the colour policy actually bites. Declaring
      // `linear` means the runtime converts or refuses, rather than quietly
      // computing luma and calling it luminance.
      inputs: [{ name: 'src', channels: [3], space: 'linear' }],
      params: [],
      output: { channels: 1, dtype: 'f32', space: 'linear' },
      kernel: nativeKernel(backend, 'gray'),
    }),

    defineOp({
      name: 'gaussian',
      version: 1,
      summary: 'Separable Gaussian blur.',
      // Blur mixes pixels, so it models light and needs linear values (§2).
      inputs: [{ name: 'src', channels: [1, 3], space: 'linear' }],
      params: [
        { name: 'sigma', type: 'number', default: 1.4, min: 0.1, max: 100 },
        // Preview quality changes speed, not the result, so it is excluded from
        // the record and from any cache key.
        { name: 'preview', type: 'bool', default: false, semantic: false },
      ],
      output: { channels: 'same', dtype: 'f32', space: 'same' },
      kernel: nativeKernel(backend, 'gaussian'),
    }),

    defineOp({
      name: 'sobel',
      version: 1,
      summary: 'First-derivative edge response. Output is signed for x and y.',
      // A gradient on sRGB values is a different measurement, not a wrong one
      // (§2) — so this accepts either, and the record says which it was.
      inputs: [{ name: 'src', channels: [1], space: 'any' }],
      params: [
        { name: 'axis', type: 'enum', values: ['x', 'y', 'mag'], default: 'mag' },
      ],
      output: { channels: 1, dtype: 'f32', space: 'none' },
      kernel: nativeKernel(backend, 'sobel'),
    }),

    defineOp({
      name: 'orient',
      version: 1,
      summary: 'Gradient direction in radians. Perpendicular to the edge.',
      // Two inputs, because a direction needs both components. Magnitude is
      // deliberately not consumed: where the gradient is ~0 the angle is
      // meaningless, and masking that off is the caller's decision, not this
      // operation's (§3, on not fusing stages).
      inputs: [
        { name: 'gx', channels: [1], space: 'any' },
        { name: 'gy', channels: [1], space: 'any' },
      ],
      params: [
        // signed keeps the full turn, so a dark-to-bright edge and a
        // bright-to-dark one stay 180 degrees apart -- two sides of a thin
        // line are two edges. unsigned folds them together. signed is the
        // default because unsigned is derivable from it and not the reverse.
        { name: 'range', type: 'enum', values: ['signed', 'unsigned'], default: 'signed' },
      ],
      output: { channels: 1, dtype: 'f32', space: 'none' },
      kernel: nativeKernel(backend, 'orient'),
    }),

    defineOp({
      name: 'nms',
      version: 1,
      summary: 'Non-maximum suppression: thin gradient ridges to one pixel.',
      // Canny stage 3. Takes the magnitude and both signed derivatives,
      // because thinning has to happen ALONG the gradient direction.
      inputs: [
        { name: 'mag', channels: [1], space: 'any' },
        { name: 'gx', channels: [1], space: 'any' },
        { name: 'gy', channels: [1], space: 'any' },
      ],
      params: [],
      output: { channels: 1, dtype: 'f32', space: 'none' },
      kernel: nativeKernel(backend, 'nms'),
    }),

    defineOp({
      name: 'hysteresis',
      version: 1,
      summary: 'Double-threshold edge tracking: keep weak edges joined to strong ones.',
      inputs: [{ name: 'src', channels: [1], space: 'any' }],
      params: [
        { name: 'low', type: 'number', default: 0.05, min: 0 },
        { name: 'high', type: 'number', default: 0.15, min: 0 },
      ],
      output: { channels: 1, dtype: 'i32', space: 'none' },
      kernel: nativeKernel(backend, 'hysteresis'),
    }),

    defineOp({
      name: 'segments',
      // v2: the TLS fit and the angle tolerance stopped going through libm.
      // Same algorithm, different last bits -- and on a pixel sitting exactly
      // at maxResidual, potentially a different segment. See kernels.h.
      version: 2,
      summary: 'Grow straight edges from the gradient field, one label per segment.',
      // Expects a THINNED magnitude -- nms output, not raw. A raw gradient
      // ridge is several pixels wide, and no line fits a wide band within a
      // one-pixel tolerance, so the regions fragment.
      inputs: [
        { name: 'mag', channels: [1], space: 'any' },
        { name: 'gx', channels: [1], space: 'any' },
        { name: 'gy', channels: [1], space: 'any' },
      ],
      params: [
        { name: 'angleTol', type: 'number', default: 22.5, min: 1, max: 90 },
        // 0.005, not 0.02. Tuned against a real render rather than synthetic
        // shapes: a hard 0->1 step gives gradient magnitudes near 0.5, but a
        // shaded cube peaks at 0.0585 after thinning -- an order of magnitude
        // weaker. Run `stats` on the thinned input to choose it for an image.
        { name: 'minMag', type: 'number', default: 0.005, min: 0 },
        { name: 'maxResidual', type: 'number', default: 1.0, min: 0.1 },
        { name: 'minPixels', type: 'int', default: 8, min: 2 },
        // Whether a gradient pointing the opposite way is the same edge seen
        // from its other side. Mirrors orient's `range`.
        { name: 'polarity', type: 'enum', values: ['signed', 'unsigned'], default: 'signed' },
      ],
      output: { channels: 1, dtype: 'i32', space: 'none' },
      kernel: nativeKernel(backend, 'segments'),
    }),

    defineOp({
      name: 'merge',
      // v2: same reason as segments -- cv_tls_line and the angle tolerance are
      // no longer libm calls, so results moved in the last bits.
      version: 2,
      summary: 'Join segments that are collinear and nearly touching.',
      // A separate operation rather than a flag on segments, so you can see
      // what it joined by comparing the two label maps (§3).
      inputs: [{ name: 'src', channels: [1], space: 'any' }],
      params: [
        { name: 'gap', type: 'number', default: 6.0, min: 0 },
        { name: 'maxResidual', type: 'number', default: 1.0, min: 0.1 },
        { name: 'angleTol', type: 'number', default: 15.0, min: 1, max: 90 },
      ],
      output: { channels: 1, dtype: 'i32', space: 'none' },
      kernel: nativeKernel(backend, 'merge'),
    }),

    defineOp({
      name: 'chain',
      version: 1,
      summary: 'Join segments that lie on one circle, so a curve is one label.',
      // `merge` asks whether two pieces are the same line. This asks whether
      // they are the same circle. Separate from `merge` for the reason `merge`
      // is separate from `segments`: comparing the two label maps shows what
      // was joined (§3).
      //
      // It exists because `segments` cannot produce a long curved piece --
      // maxResidual and angleTol each cap the length an arc can reach, and on
      // the nut that left 72 of 74 labels too short to prefer a circle to a
      // line. The curves are in the image; they arrive in pieces.
      inputs: [{ name: 'src', channels: [1], space: 'any' }],
      params: [
        // Tighter than merge's 6.0: pieces of one curve abut, where the
        // collinear runs merge joins can be separated by a real occlusion.
        { name: 'gap', type: 'number', default: 4.0, min: 0 },
        { name: 'maxResidual', type: 'number', default: 1.0, min: 0.1 },
        // Below minTurn the two pieces are collinear, which is `merge`'s
        // question: without a floor, one very large circle holds every
        // straight edge in the image and they all chain together.
        { name: 'minTurn', type: 'number', default: 2.0, min: 0, max: 90 },
        // Above maxTurn they meet at a corner. A hexagon turns 60° at every
        // vertex, and chaining across those walks a curve round the whole nut.
        { name: 'maxTurn', type: 'number', default: 40.0, min: 1, max: 90 },
        // The scale-free half of the same question: how far the joined curve
        // bows off its own chord. A radius cap would need a number that means
        // something different at every image size; a sagitta does not.
        { name: 'minSagitta', type: 'number', default: 1.0, min: 0 },
      ],
      output: { channels: 1, dtype: 'i32', space: 'none' },
      kernel: nativeKernel(backend, 'chain'),
    }),

    defineOp({
      name: 'fit',
      // v2: the whole record moved. cv_tls_line is algebraic now, and `angle`
      // and `length` come from cv_atan2 and cv_len2 rather than libm -- which
      // is what makes a feature list compare equal across platforms at all.
      version: 2,
      summary: 'Describe each segment: endpoints, angle, length, straightness.',
      // The first operation whose result is not pixels. A label map says which
      // edge a pixel belongs to; this says what each edge IS.
      inputs: [{ name: 'src', channels: [1], space: 'any' }],
      params: [],
      output: { kind: 'features' },
      kernel: ({ inputs }) => {
        const native = backend();
        const info = native.bufferInfo(inputs[0].handle);
        return {
          kind: 'features',
          features: native.fitSegments(inputs[0].handle),
          // A feature list has no dimensions of its own -- it lives in the
          // coordinate space of the image it came from. Carrying that here is
          // what lets a viewer draw it over the right tile.
          width: info.width,
          height: info.height,
        };
      },
    }),

    defineOp({
      name: 'fitArcs',
      version: 1,
      summary: 'Describe each segment as a circular arc — where it earns it.',
      // `fit` describes a label as a line and always can. This describes one
      // as an arc and often should not.
      //
      // THE TRAP THESE PARAMETERS EXIST FOR. A circle has a parameter a line
      // does not, and on a real edge it spends it on noise: three of the
      // twelve largest STRAIGHT labels on the nut fit their own circle 7-21%
      // better than their own line (2026-09-20). Nothing about those fits
      // looks wrong one at a time -- a slightly better residual and a radius
      // in the hundreds -- so selecting on residual alone would reclassify a
      // third of the straight edges in an image and report it as an
      // improvement. The three gates are what turn a comparison into a test:
      // the fit must be better by a MARGIN that pays for the extra parameter,
      // over an extent long enough to see, and by enough of a bend to be worth
      // describing as one.
      //
      // The algebraic fit helps here by failing loudly rather than quietly: on
      // a CLEAN straight run it collapses to a small circle rather than
      // approximating the line, so `minGain` is not what catches those. It is
      // the noisy near-straight labels it is for, which are the ones that
      // occur.
      //
      // A label that fails them is not an error and produces no record. It is
      // a line, and `fit` on the same map already says so.
      inputs: [{ name: 'src', channels: [1], space: 'any' }],
      params: [
        { name: 'minGain', type: 'number', default: 1.5, min: 1 },
        { name: 'minSweep', type: 'number', default: 8, min: 0, max: 360 },
        // The same number `chain` gates a join on, for the same reason, so a
        // chain this accepted is a chain this will describe.
        { name: 'minSagitta', type: 'number', default: 1.0, min: 0 },
      ],
      output: { kind: 'features' },
      kernel: ({ inputs, params }) => {
        const native = backend();
        const info = native.bufferInfo(inputs[0].handle);
        const candidates = native.fitArcs(inputs[0].handle);
        return {
          kind: 'features',
          features: candidates.filter((a) => (
            // A degenerate line fit makes the ratio meaningless rather than
            // infinite: a label whose pixels are exactly collinear has
            // lineRms 0, and no circle improves on that.
            a.lineRms > 0 &&
            a.rms > 0 &&
            a.lineRms / a.rms >= params.minGain &&
            a.sweep >= params.minSweep &&
            a.sagitta >= params.minSagitta
          )),
          width: info.width,
          height: info.height,
        };
      },
    }),

    defineOp({
      name: 'corners',
      version: 1,
      summary: 'Where fitted segments would meet, with how far each had to reach.',
      // Features in, features out -- the first operation to consume the kind
      // rather than only produce it.
      inputs: [{ name: 'src', kind: 'features' }],
      params: [
        // Near-parallel lines intersect far away and wrongly: error goes as
        // 1/sin(angle between).
        { name: 'minAngle', type: 'number', default: 15, min: 1, max: 89 },
        // Scale-free rather than a pixel count: reaching 5px off a 60px
        // segment is cheap, off a 7px segment is not.
        { name: 'maxReachRatio', type: 'number', default: 2, min: 0 },
        { name: 'cluster', type: 'number', default: 3, min: 0 },
      ],
      output: { kind: 'features' },
      kernel: ({ inputs, params }) => ({
        kind: 'features',
        features: findCorners(inputs[0].features, params),
        width: inputs[0].width,
        height: inputs[0].height,
      }),
    }),

    defineOp({
      name: 'fitPairs',
      // v2: the aperture is the MEDIAN of the lone segments', not their lower
      // quartile. Over sixteen frames from one renderer the quartile ranged
      // 1.06 to 1.31 and the median 1.31 to 1.39; see pairs.js.
      // v3: each level may change along the pair (`levelSlope`), which stops
      // a face's shading turning the two edges opposite ways.
      // v4: `ledge`, whether a shadow ramp lies inside the strip.
      version: 4,
      summary: 'Place two close parallel segments again, jointly, against the unblurred image.',
      /*
       * Features in, features out, with the image alongside -- the shape
       * `explain` has, for the opposite reason. `explain` asks the renderer
       * what an edge is; this asks the PIXELS where two edges are, because the
       * blurred image they were detected in cannot say.
       *
       * `image` must be the gray image BEFORE `gaussian`. Nothing can check
       * that: a blurred buffer has the same shape, and fitting it returns the
       * blurred answer with a small residual. It must also be linear. A pixel
       * across an edge holds a mix of two surfaces in proportion to area, and
       * that is only true of light -- the tone-curve defect of 2026-10-01 was
       * exactly this proportion being bent (design-lab-model.md §5).
       */
      inputs: [
        { name: 'src', kind: 'features' },
        { name: 'image', channels: [1], space: 'linear' },
      ],
      params: [
        // About three sigma of the default blur, and a little: the measured
        // displacement was +1.2 px at 2.3 px apart, +0.1 at 5.8 and nothing
        // at 11.7.
        { name: 'maxGap', type: 'number', default: 6, min: 0 },
        { name: 'maxAngle', type: 'number', default: 5, min: 0, max: 45 },
        { name: 'minOverlap', type: 'number', default: 10, min: 1 },
        // Plateau taken either side. Enough to fix each level; little enough
        // that the next feature along is not in the band.
        { name: 'pad', type: 'number', default: 4, min: 1, max: 32 },
        { name: 'inset', type: 'number', default: 2, min: 0 },
        /*
         * Under a pixel wide, a strip's width and its level trade off and
         * the image stops determining the gap. `held` supplies the level --
         * measured while the gap was wider -- and the record says it was
         * supplied. Fitted, it costs the gap its certainty, and `gapSigma`
         * says how much.
         */
        { name: 'strip', type: 'enum', values: ['fit', 'held'], default: 'fit' },
        { name: 'stripLevel', type: 'number', default: 0 },
        /*
         * The side of the square a pixel gathers light over, in px. It is
         * the camera's, not the pair's, and fitting it per pair turns one
         * soft edge into two sharp ones half a pixel apart. `fit` measures
         * it on this image's LONE segments and holds it for every pair;
         * pt-lab's 512 px renders come out at 1.3 to 1.4. `apertureWidth` is the
         * value held, and the fallback when no segment can say.
         */
        { name: 'aperture', type: 'enum', values: ['fit', 'held'], default: 'fit' },
        { name: 'apertureWidth', type: 'number', default: 1, min: 0.25, max: 8 },
        /*
         * The shape of one step through that aperture. `box`: the projected
         * square. `smooth`: a unit square blurred by a Gaussian-like kernel
         * of the same total spread, which is what a lens does. Right on a
         * synthetic blurred edge and no better on the stack's blurred
         * renders, where what blur costs is a ledge in shadow
         * (design-lab-model.md §5, "A twenty-fifth").
         */
        { name: 'profile', type: 'enum', values: ['box', 'smooth'], default: 'box' },
        // A gap the fit cannot tell from none is one edge found twice, or
        // two parts in contact. This cannot say which, and reports neither.
        { name: 'minSigmas', type: 'number', default: 3, min: 0 },
        /*
         * A face is brighter at one end of a pair than the other, and one
         * flat level per face turns the two edges opposite ways: 0.3 px of
         * gap end to end on the stack's renders. `fit` gives each level a
         * slope along the pair; `none` is the fit as it was.
         */
        { name: 'levelSlope', type: 'enum', values: ['fit', 'none'], default: 'fit' },
        /*
         * Whether the strip holds a ledge in soft shadow: a ramp from one
         * edge into the strip, which the two-edge fit cannot describe and
         * misplaces that edge for, by up to half a pixel. `detect` adds
         * `ledge: {gain, edge}` to each record; it does not move the edges.
         */
        { name: 'ledge', type: 'enum', values: ['detect', 'none'], default: 'detect' },
      ],
      output: { kind: 'features' },
      kernel: ({ inputs, params }) => pairKernel(backend, 'fitPairs', fitPairs, inputs, params),
    }),

    defineOp({
      name: 'findPairs',
      version: 1,
      summary: 'Find two edges the detector reported as one segment: a strip hidden inside it.',
      /*
       * fitPairs places two segments the detector FOUND. Closer than about a
       * pixel and a half it finds one, and there is nothing to place: the gap
       * sweep's Cube at 1 mm over the Table is a single 512 px segment along
       * the table's edge. This walks every segment that is in no pair, a
       * window at a time, and asks the unblurred pixels whether that stretch
       * is one step or two.
       *
       * A separate operation rather than a flag on fitPairs, for the reason
       * merge is separate from segments (§3): the two lists say different
       * things. fitPairs moves edges that were detected. This asserts an edge
       * nothing detected, which is a stronger claim and gets its own gates.
       *
       * The same `edge-pair` records, with both edges naming one segment.
       */
      inputs: [
        { name: 'src', kind: 'features' },
        { name: 'image', channels: [1], space: 'linear' },
      ],
      params: [
        // How far along a segment is tested at a time. Shorter finds a
        // shorter strip and decides on fewer pixels.
        { name: 'window', type: 'number', default: 24, min: 8 },
        // How far to one side the second edge may be. Wider than this the
        // detector finds both, and they are fitPairs's.
        { name: 'reach', type: 'number', default: 2.4, min: 0.5, max: 8 },
        // Two steps always fit a little better than one: 1.00 to 1.05 where
        // nothing is hidden, 1.35 and up over a 1.16 px gap. This is the
        // margin between; see pairs.js for how little it was calibrated on.
        { name: 'minGain', type: 'number', default: 1.3, min: 1 },
        { name: 'minSigmas', type: 'number', default: 3, min: 0 },
        { name: 'pad', type: 'number', default: 4, min: 1, max: 32 },
        { name: 'inset', type: 'number', default: 2, min: 0 },
        { name: 'strip', type: 'enum', values: ['fit', 'held'], default: 'fit' },
        { name: 'stripLevel', type: 'number', default: 0 },
        { name: 'aperture', type: 'enum', values: ['fit', 'held'], default: 'fit' },
        { name: 'apertureWidth', type: 'number', default: 1, min: 0.25, max: 8 },
        { name: 'profile', type: 'enum', values: ['box', 'smooth'], default: 'box' },
        // Which segments are already a pair, and so not searched: fitPairs's
        // own three, at fitPairs's defaults, so the two agree on who is lone
        // and measure the aperture on the same segments.
        { name: 'maxGap', type: 'number', default: 6, min: 0 },
        { name: 'maxAngle', type: 'number', default: 5, min: 0, max: 45 },
        { name: 'minOverlap', type: 'number', default: 10, min: 1 },
      ],
      output: { kind: 'features' },
      kernel: ({ inputs, params }) => pairKernel(backend, 'findPairs', findPairs, inputs, params),
    }),

    defineOp({
      name: 'trackPair',
      // v2: a held ledge whose lit ledge is no brighter than its strip is
      // refused (a sharp shadow can pass for the moving edge).
      // v3: ambiguous with the strip level held, and wide at one end, the level
      // is fitted instead (`wideEnd`).
      // v4: `moving=below`; a ledge whose moving edge leaves the band is refused.
      version: 4,
      summary: 'Read a pair again beside a line carried from an earlier frame: one edge fitted, nothing detected.',
      /*
       * Under about a pixel a gap is not in one image: width and strip level
       * trade, and the detector reports one segment or none. In an approach
       * only one part moves, so the other's edge -- and the strip's level and
       * the aperture, measured while the gap was wide -- are carried in from
       * that frame and held, and only the moving edge is fitted.
       *
       * No features input: what an earlier frame measured comes in as
       * PARAMETERS, numbers in the command, so that it is in this frame's log
       * and the frame replays without the other. The command language has no
       * variables (§4); whoever drives the frames writes them in -- gap-sweep
       * --carry does.
       *
       * Contact is not refused in every view (a few return 0.02 to 0.10 px),
       * so the record reports the gap and leaves contact to the caller.
       */
      inputs: [{ name: 'image', channels: [1], space: 'linear' }],
      params: [
        // The still part's edge, as the earlier frame fitted it, over the
        // stretch the pair shared. Held: see pairs.js for what an error in
        // it does above and below a pixel.
        { name: 'x0', type: 'number', default: 0 },
        { name: 'y0', type: 'number', default: 0 },
        { name: 'x1', type: 'number', default: 0 },
        { name: 'y1', type: 'number', default: 0 },
        // Any point on the moving part's side of that line.
        { name: 'towardX', type: 'number', default: 0 },
        { name: 'towardY', type: 'number', default: 0 },
        { name: 'stripLevel', type: 'number', default: 0 },
        { name: 'aperture', type: 'number', default: 1, min: 0.25, max: 8 },
        // As the record carried from had it.
        { name: 'profile', type: 'enum', values: ['box', 'smooth'], default: 'box' },
        // Where the fit starts, px; it also starts at 0.25, 0.5, 1 and 2.
        { name: 'guess', type: 'number', default: 1, min: 0 },
        { name: 'pad', type: 'number', default: 4, min: 1, max: 32 },
        { name: 'levelSlope', type: 'enum', values: ['fit', 'none'], default: 'fit' },
        // `held`: the strip level carried in, for a strip too narrow to show
        // its own. `fit`: only the line is carried -- a wide strip, read
        // beside an edge a ledge would otherwise hide.
        { name: 'strip', type: 'enum', values: ['held', 'fit'], default: 'held' },
        // Held and ambiguous, yet this many px open at one end -- a turned
        // pair -- the strip's level is fitted after all; 0: never.
        { name: 'wideEnd', type: 'number', default: 3, min: 0 },
        // A ledge inside the strip: the still part's top face, uncovered as
        // the moving part slides back, lit up to the moving part's shadow
        // (design-lab-model.md §5, "A thirty-second"). `held`: the shadow's
        // middle ledgeOffset px from the moving edge toward the still one,
        // ledgeWidth px wide; one more level is fitted, and a ledge the
        // offset puts behind the still edge is not in the model at all.
        // `fit`: the shadow placed freely -- to measure it, not to read a gap.
        { name: 'ledge', type: 'enum', values: ['none', 'held', 'fit'], default: 'none' },
        { name: 'ledgeOffset', type: 'number', default: 0 },
        { name: 'ledgeWidth', type: 'number', default: 0, min: 0, max: 8 },
        // Which part is the upper one. `above`: the moving part, in front
        // where the edges cross, a ledge the still part's top face. `below`:
        // the still part is in front, a ledge is the moving part's own top
        // face in the still part's shadow, and an overhang is not seen.
        { name: 'moving', type: 'enum', values: ['above', 'below'], default: 'above' },
      ],
      output: { kind: 'features' },
      kernel: ({ inputs, params }) => trackKernel(backend, inputs, params),
    }),

    defineOp({
      name: 'groundTruth',
      // 2: coordinates move by -0.5 into the lab's pixel-centre convention
      // (src/lab/groundtruth.js). Same file, different features.
      version: 2,
      summary: 'Read a renderer\'s ground truth: where the edges really are.',
      // A source, like load and pattern -- it takes no slot, it takes a file.
      inputs: [],
      params: [
        { name: 'path', type: 'string', default: '' },
        // Edges and vertices answer different questions and go to different
        // comparisons, so which you want is stated rather than assumed.
        { name: 'kind', type: 'enum', values: ['edges', 'vertices', 'both'], default: 'both' },
      ],
      output: { kind: 'features' },
      cancellable: false,
      kernel: groundTruthKernel(readTextFile),
    }),

    defineOp({
      name: 'match',
      version: 1,
      summary: 'Score detected features against ground truth: hits, misses, inventions.',
      // Two feature lists in, one out. The first operation to consume the kind
      // twice, and the reason feature types are namespaced: which ground truth
      // applies is decided by what the detected records SAY they are.
      inputs: [
        { name: 'src', kind: 'features' },
        { name: 'truth', kind: 'features' },
      ],
      params: [
        // Three pixels is about what blur plus non-maximum suppression moves an
        // edge by, so it is the scale at which "the same edge" stops being a
        // judgement call. Run it wider and watch precision to see if it matters.
        { name: 'maxDistance', type: 'number', default: 3, min: 0 },
        { name: 'maxAngle', type: 'number', default: 20, min: 0, max: 90 },
        // Which ground-truth edges a detector is answerable for. An edge hidden
        // behind its own object exists and cannot be seen, and marking a
        // detector down for missing it would be nonsense.
        { name: 'minVisible', type: 'number', default: 0.5, min: 0, max: 1 },
        // Which ground-truth vertices count as CORNERS rather than bends. A
        // sphere's silhouette is a polyline whose interior points are vertices
        // of degree two that run almost straight through; a cube's sit near 90.
        { name: 'minAngle', type: 'number', default: 30, min: 0, max: 90 },
      ],
      output: { kind: 'features' },
      kernel: ({ inputs, params }) => {
        const [src, truth] = inputs;
        if (src.width !== truth.width || src.height !== truth.height) {
          throw new Error(
            `match: the two feature lists were measured in different images — ` +
              `${src.width}x${src.height} against ${truth.width}x${truth.height}. ` +
              `Their coordinates do not mean the same thing.`
          );
        }
        return {
          kind: 'features',
          features: matchFeatures(src.features, truth.features, params),
          width: src.width,
          height: src.height,
        };
      },
    }),

    defineOp({
      name: 'explain',
      // v2: the depth test is a residual. v1 compared the raw difference
      // across an edge against a fixed threshold, which reads a surface turned
      // away from the camera as a step -- 241 of 282 `occlusion` calls on the
      // helmet were that, measured. What slant accounts for is subtracted
      // first; see explain.js and design-lab-model.md §11.
      // v3: view rays through the optical centre in the lab's pixel
      // convention, (w-1)/2 rather than w/2 -- half a pixel, ~0.05 deg.
      version: 3,
      summary: 'Say what put each detected feature in the picture, from the renderer\'s AOV passes.',
      /*
       * Features in, features out, with three auxiliary passes alongside.
       *
       * The passes are what make the question answerable at all: a shadow
       * boundary and a silhouette are the same step in luminance, and nothing
       * in the beauty render tells them apart. See glossary.md, AOV.
       *
       * Detections rather than match records, deliberately. A match record
       * keeps only a midpoint, and sampling ACROSS an edge needs its
       * direction -- but more than that, what a detector responds to is worth
       * knowing whether or not it happened to match something.
       */
      inputs: [
        { name: 'src', kind: 'features' },
        { name: 'depth', channels: [3, 4], space: 'any' },
        { name: 'normal', channels: [3, 4], space: 'any' },
        { name: 'albedo', channels: [3, 4], space: 'any' },
        /*
         * Ground truth, for its `maxDepth` and its camera.
         *
         * Not scoring -- this operation never looks at the truth's features.
         * It is here because the metre scale the depth pass was packed against
         * exists ONLY in the .gt.json: the passes carry no colour chunks and
         * therefore no metadata, so without the truth there is no way to read
         * a depth pass in metres at all. Taking it as a number instead would
         * be a parameter nobody could fill in correctly from inside a script,
         * since it changes per image.
         */
        { name: 'truth', kind: 'features' },
      ],
      params: [
        // How far either side of the edge to look. Three pixels is about what
        // blur and non-maximum suppression move an edge by, so the two sides
        // stop being the same surface a little before that.
        { name: 'offset', type: 'number', default: 2.5, min: 0.5, max: 16 },
        { name: 'samples', type: 'number', default: 7, min: 1, max: 64 },
        { name: 'depthStep', type: 'number', default: 0.02, min: 0 },
        { name: 'normalStep', type: 'number', default: 20, min: 0, max: 180 },
        { name: 'albedoStep', type: 'number', default: 0.06, min: 0 },
      ],
      output: { kind: 'features' },
      kernel: ({ inputs, params }) => {
        const native = backend();
        const [src, depth, normal, albedo, truth] = inputs;

        const maxDepth = truth?.meta?.maxDepth;
        if (typeof maxDepth !== 'number' || !(maxDepth > 0)) {
          throw new Error(
            'explain: the ground truth carries no maxDepth, so the depth pass ' +
            'cannot be read in metres. It is written by `npm run generate -- --truth`; ' +
            'a hand-written .gt.json needs a numeric "maxDepth".'
          );
        }

        /*
         * And the field of view, which is what turns a pixel offset into a
         * direction. Without it the depth test cannot tell a step from a
         * surface receding, which is the defect v2 exists to fix -- so this
         * refuses rather than quietly computing v1's answer under v2's number.
         */
        const camera = truth?.meta?.camera;
        if (typeof camera?.fov !== 'number' || !(camera.fov > 0) || !(camera.fov < 180)) {
          throw new Error(
            'explain: the ground truth carries no camera fov, so a depth difference ' +
            'cannot be separated from a surface turned away from the camera. It is ' +
            'written by `npm run generate -- --truth`; a hand-written .gt.json needs ' +
            '"camera": { "fov": <degrees> }.'
          );
        }

        /*
         * A buffer input is a handle, not a shape -- its dimensions come from
         * bufferInfo. Reading src.width off one gives undefined, which then
         * compares unequal to everything and reports a confusing size.
         */
        const raster = (buf) => {
          const info = native.bufferInfo(buf.handle);
          return {
            width: info.width, height: info.height, channels: info.channels,
            data: native.bufferRead(buf.handle),
          };
        };

        const rasters = {
          depth: raster(depth), normal: raster(normal), albedo: raster(albedo),
        };
        for (const [name, r] of Object.entries(rasters)) {
          if (r.width !== src.width || r.height !== src.height) {
            throw new Error(
              `explain: ${name} is ${r.width}x${r.height} but the features were ` +
                `measured in ${src.width}x${src.height}. Their coordinates do not mean ` +
                `the same thing.`
            );
          }
        }

        /*
         * Depth is a 24-bit fixed-point value packed across R, G and B, which
         * is why the pass looks like fine rainbow stripes rather than a ramp.
         * Loaded as floats in [0,1] the byte-wise decode reduces to this.
         */
        const packed = rasters.depth;
        const metres = new Float32Array(packed.width * packed.height);
        for (let i = 0, p = 0; i < metres.length; i++, p += packed.channels) {
          metres[i] = (packed.data[p] + packed.data[p + 1] / 255 + packed.data[p + 2] / 65025)
            * maxDepth;
        }

        return {
          kind: 'features',
          features: explainFeatures(
            src.features,
            {
              depth: { width: packed.width, height: packed.height, channels: 1, data: metres },
              normal: rasters.normal,
              albedo: rasters.albedo,
              camera,
            },
            params
          ),
          width: src.width,
          height: src.height,
        };
      },
    }),

    defineOp({
      name: 'threshold',
      version: 1,
      summary: 'Binary mask: 1 where the input exceeds t, else 0.',
      // Thresholding depends only on ordering, which a monotonic transfer
      // function preserves — so colour space genuinely does not matter here.
      inputs: [{ name: 'src', channels: [1], space: 'any' }],
      params: [
        { name: 't', type: 'number', default: 0.5 },
        { name: 'invert', type: 'bool', default: false },
      ],
      // A mask is an identity, not a measurement: i32, and no colour space.
      output: { channels: 1, dtype: 'i32', space: 'none' },
      kernel: nativeKernel(backend, 'threshold'),
    }),

    defineOp({
      name: 'stats',
      version: 1,
      summary: 'Min, max, mean and standard deviation. Produces no buffer.',
      inputs: [{ name: 'src', channels: [1, 3], space: 'any' }],
      params: [],
      // Reductions must use a fixed summation order (§5): float addition is not
      // associative, so a thread-parallel sum would vary between runs.
      output: { kind: 'scalars' },
      kernel: nativeKernel(backend, 'stats', { scalars: true }),
    }),
  ];
}

/**
 * Every operation, bound to the host's backend, decoder and reader.
 * @param {import('./types.js').HostOptions} [options]
 * @returns {import('./registry.js').Registry & {backend: import('./types.js').Backend | null}}
 */
function createRegistry(options = {}) {
  const registry = new Registry();
  for (const op of buildOps(options)) registry.register(op);
  // The session hashes and releases buffers through the same backend.
  registry.backend = options.backend ?? null;
  return registry;
}

export { createRegistry, buildOps };
