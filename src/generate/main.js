/**
 * The image generator's page.
 *
 * Hosts a pt-lab PathTracerLab in a window that is never shown, and exposes a
 * small API for scripts/generate-cli.js to drive over executeJavaScript.
 * Nothing here decides WHAT to render — that is the CLI's job. This is the
 * part that has to live in a browser context, because path tracing is WebGL.
 */
import { PathTracerLab } from 'pt-lab';

/** @type {PathTracerLab|null} */
let lab = null;
let lastStatus = null;

/**
 * Resolve when the tracer reports it is ready.
 *
 * init() returns before the scene is usable: meshes load and a BVH is built
 * first, and the status callback is the only signal. Racing that produces a
 * black frame rather than an error, which is the worst kind of failure to
 * debug.
 */
function waitForStatus(predicate, label, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (lastStatus && predicate(lastStatus)) { resolve(lastStatus); return; }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}` +
          ` (last status: ${JSON.stringify(lastStatus)})`));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

const api = {
  /** Construct the tracer and wait until it can actually render. */
  async init({ width = 512, height = 512, room = null } = {}) {
    const canvas = document.getElementById('stage');
    const denoiseCanvas = document.getElementById('denoise');
    canvas.width = width;
    canvas.height = height;

    lab = new PathTracerLab(canvas, {
      onStatus: (status) => { lastStatus = status; },
      denoiseCanvas,
    });
    lab.resize(width, height);
    await lab.init();
    if (room) lab.setRoom(room);

    // 'loading' and 'building-bvh' both mean not yet renderable.
    await waitForStatus(
      (s) => s.mode !== 'loading' && s.mode !== 'building-bvh',
      'the scene to finish loading and building its BVH'
    );
    return { status: lastStatus, objects: lab.listObjects() };
  },

  status: () => lastStatus,
  objects: () => lab.listObjects(),

  /** Where the camera is, and what it looks at. */
  camera(position, target, fov) {
    if (position) lab.setCameraPosition(position[0], position[1], position[2]);
    if (target) lab.setCameraTarget(target[0], target[1], target[2]);
    if (typeof fov === 'number') lab.setCameraFov(fov);
  },

  /** Move or rotate one object. `t` is pt-lab's LabTransform. */
  transform(id, t) {
    const current = lab.getObjectTransform(id);
    if (!current) throw new Error(`no object "${id}"`);
    lab.setObjectTransform(id, { ...current, ...t });
  },

  /**
   * Replace the whole scene with a built-in one, by library key.
   *
   * pt-lab's default scene is a glTF model that arrives through `modelUrl` and
   * is NOT in the object library, so nothing can address it: no transform, no
   * per-object ground truth. `applyScene` rebuilds from the library instead —
   * floor, the objects named here, and a room — and every one of them comes
   * back with an id from `listObjects()`.
   *
   * That matters more than convenience. A helmet is a dense textured mesh with
   * almost no clean vertices; a cube has eight, in known places. Ground truth
   * needs a subject whose corners exist.
   */
  applyScene({ room = 'room-arealight', objects = [] } = {}) {
    lab.applyScene({
      version: 1,
      room,
      objects: objects.map((key) => ({ key, included: true })),
      camera: null,
    });
    return lab.listObjects();
  },

  /**
   * The auxiliary passes for the current camera: depth, normal, albedo.
   *
   * Raster-only, so the whole set costs a frame next to the ~20 s the beauty
   * render takes. They are written UNTAGGED, carrying linear code values, so
   * anything reading them has to say `from=linear` — the lab refuses to guess.
   */
  aovs(size, base, which) {
    return lab.exportAOVs(size, base, which);
  },

  /**
   * Where the edges of this view really are.
   *
   * Plain data, not pixels: the scene's own silhouette, crease and boundary
   * edges projected into image space, with visibility taken from the depth
   * pass, plus the vertices they meet at. This is the thing the whole exercise
   * is for — until now nothing checked whether the corners the pipeline finds
   * are the corners that exist.
   */
  groundTruth(size, opts) {
    return lab.groundTruthGeometry(size, opts);
  },

  /** The two levers the plan asks to vary lighting with. */
  lighting({ intensity, room } = {}) {
    if (typeof intensity === 'number') lab.setEnvironmentIntensity(intensity);
    if (room) lab.setRoom(room);
  },

  /**
   * Turn OIDN denoising on or off for subsequent exports.
   *
   * Off in pt-lab by default, which is worth knowing rather than assuming:
   * every image this generator has produced until now carried the raw
   * path-traced noise floor.
   */
  denoise(enabled) {
    return lab.setDenoiseEnabled(enabled);
  },

  quality({ samples, bounces, scale } = {}) {
    if (typeof samples === 'number') lab.setMaxSamples(samples);
    if (typeof bounces === 'number') lab.setBounces(bounces);
    if (typeof scale === 'number') lab.setRenderScale(scale);
  },

  /**
   * Render and export one beauty image.
   *
   * pt-lab's own exportPNG is used rather than reading the canvas here,
   * because it does the things that make the result correct and that would be
   * easy to get subtly wrong by hand: it converges to the sample target,
   * optionally denoises, downscales, and tags the PNG as sRGB (sRGB + gAMA +
   * cHRM chunks). That tagging is why cv-lab-2 can CONFIRM the encoding on
   * load rather than assume it.
   *
   * It delivers the file by triggering a browser download, which the CLI
   * intercepts and writes wherever it wants.
   */
  async render(size, filename) {
    /*
     * Wait until it is demonstrably rendering before asking for an export.
     *
     * exportPNG opens with `if (!this.ready || this.exporting) return;` -- it
     * returns undefined either way, so a no-op is indistinguishable from a
     * successful export from out here. That produced a flaky "produced no
     * download": usually fine, occasionally an instant silent return.
     *
     * A non-zero sample count is proof the tracer is past loading and
     * actually working, which is the condition exportPNG is really asking
     * about. Cheap, and it makes the silence impossible rather than unlikely.
     */
    await waitForStatus(
      (s) => s.mode === 'pathtracing' && s.samples > 0,
      'the tracer to start accumulating samples'
    );
    await lab.exportPNG(size, filename);
    return filename;
  },
};

globalThis.__gen = api;
globalThis.__genReady = true;
