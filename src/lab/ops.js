'use strict';

/**
 * The first slice of operations — design-lab-model.md §10.
 *
 * Schemas only for now: `kernel` is filled in as each is implemented, and
 * `implemented` reflects that. Declaring them up front is deliberate — the
 * command parser, the dropdowns and the generated docs all read from here, so
 * an operation can be designed, argued about and validated before a line of C
 * exists for it.
 */

const { Registry, defineOp } = require('./registry');
const { findCorners } = require('./corners');

/**
 * Bind a declared operation to its C kernel.
 *
 * `native` is required lazily so this module — and therefore the registry
 * tests — load without the addon built. Only actually running a kernel needs
 * it.
 *
 * There is no per-operation code here: the kernels share a C signature, so
 * dispatch is one call whatever the op.
 */
function nativeKernel(name, { scalars = false } = {}) {
  return ({ inputs, params }) => {
    const native = require('../../native');
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
function loadKernel(decodeFile) {
  return async ({ params }) => {
    if (!params.path) throw new Error('load: path is required');
    const native = require('../../native');
    const { width, height, pixels, declared, detail } = await decodeFile(params.path);

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

function buildOps({ decodeFile } = {}) {
  return [
    defineOp({
      name: 'load',
      version: 1,
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
      ],
      output: { channels: 3, dtype: 'f32' },
      cancellable: false,
      kernel: decodeFile ? loadKernel(decodeFile) : null,
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
      kernel: nativeKernel('pattern'),
    }),

    defineOp({
      name: 'toLinear',
      version: 1,
      summary: 'Undo the sRGB transfer function, so values become proportional to light.',
      inputs: [{ name: 'src', space: 'srgb' }],
      params: [],
      output: { channels: 'same', dtype: 'f32', space: 'linear' },
      kernel: nativeKernel('toLinear'),
    }),

    defineOp({
      name: 'toSrgb',
      version: 1,
      summary: 'Apply the sRGB transfer function, for display or for saving.',
      inputs: [{ name: 'src', space: 'linear' }],
      params: [],
      output: { channels: 'same', dtype: 'f32', space: 'srgb' },
      kernel: nativeKernel('toSrgb'),
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
      kernel: nativeKernel('gray'),
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
      kernel: nativeKernel('gaussian'),
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
      kernel: nativeKernel('sobel'),
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
      kernel: nativeKernel('orient'),
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
      kernel: nativeKernel('nms'),
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
      kernel: nativeKernel('hysteresis'),
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
      kernel: nativeKernel('segments'),
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
      kernel: nativeKernel('merge'),
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
        const native = require('../../native');
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
      kernel: nativeKernel('threshold'),
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
      kernel: nativeKernel('stats', { scalars: true }),
    }),
  ];
}

/**
 * @param {{decodeFile?: (path: string) =>
 *   Promise<{width:number, height:number, pixels:Uint8ClampedArray}>}} [options]
 */
function createRegistry(options = {}) {
  const registry = new Registry();
  for (const op of buildOps(options)) registry.register(op);
  return registry;
}

module.exports = { createRegistry, buildOps };
