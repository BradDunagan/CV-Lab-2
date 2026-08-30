'use strict';

/**
 * Driving pt-lab from the main process.
 *
 * Shared by `npm run generate` and the app's Generate frame, so the two cannot
 * drift — the same reason scripts/lab-cli.js drives `window.lab` rather than
 * reaching for Session directly.
 *
 * Everything Electron-shaped lives here: the custom scheme, the render window,
 * the download intercept and the parameter sweep. Callers supply an
 * `onProgress` and decide what to do with it — print it, or send it to a pane.
 */

const { BrowserWindow, protocol, net, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');
const PAGE = path.join(ROOT, 'dist-generate');
const PT_ASSETS = path.join(ROOT, '..', 'pt-lab-workspace', 'packages', 'demo', 'public', 'assets');
const BUNDLED_ASSETS = path.join(PAGE, 'assets');

/**
 * The two files `init()` fetches on every run, whatever the scene.
 *
 * The denoiser weights are deliberately not here: they are only fetched when
 * denoising is on, so a bundle without them is usable and refusing to start
 * over them would be wrong.
 */
const CORE_ASSETS = ['damaged-helmet.glb', 'royal_esplanade_1k.hdr'];

/**
 * Where pt-lab's assets are coming from this run — the bundle, or the sibling
 * checkout, or nowhere.
 *
 * `build:generate` copies them into the bundle, so a built generator is
 * self-contained and the checkout is a BUILD dependency rather than a runtime
 * one. The fallback keeps an older bundle, built before that copy existed,
 * working rather than failing on its first frame.
 *
 * One function so there is exactly one rule: the protocol handler and the
 * prerequisite check cannot disagree about where a file is meant to come from.
 */
function assetsDir() {
  for (const dir of [BUNDLED_ASSETS, PT_ASSETS]) {
    if (CORE_ASSETS.every((name) => fs.existsSync(path.join(dir, name)))) return dir;
  }
  return null;
}

const SCHEME = 'gen';

/**
 * Must be called before the app is ready, and must say supportFetchAPI.
 *
 * That is the whole reason the scheme exists: pt-lab loads an HDR environment
 * and a glTF model through three.js's loaders, which use fetch() -- and
 * Chromium refuses fetch() on file:// URLs. A registered scheme gives a real
 * origin in-process, with no TCP port and nothing listening.
 */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  }]);
}

let handlerInstalled = false;
function installHandler() {
  if (handlerInstalled) return;
  protocol.handle(SCHEME, (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
    // pt-lab's default model and environment URLs are ./assets/…, which the
    // build copies into the bundle; assetsDir() falls back to the checkout for
    // a bundle built before it did.
    const file = rel.startsWith('assets/')
      ? path.join(assetsDir() ?? BUNDLED_ASSETS, rel.slice('assets/'.length))
      : path.join(PAGE, rel || 'index.html');
    return net.fetch(pathToFileURL(file).toString());
  });
  handlerInstalled = true;
}

const PT_SRC = path.join(ROOT, '..', 'pt-lab-workspace', 'packages', 'pt-lab', 'src');

/**
 * Every file the bundle in dist-generate/ is built FROM.
 *
 * `src/generate/driver.js` is deliberately absent: Electron requires it
 * directly, so it is not bundled and editing it cannot make a build stale.
 * pt-lab's whole `src/` tree is here, .glb assets included, because
 * `bundled.ts` discovers those with import.meta.glob at build time and a new
 * one really does change the output.
 */
function buildInputs() {
  const inputs = [
    path.join(ROOT, 'vite.generate.config.mjs'),
    path.join(__dirname, 'main.js'),
    path.join(__dirname, 'index.html'),
  ];
  // pt-lab's demo assets are copied into the bundle, so they are a build input
  // now. Swapping the helmet used to take effect immediately and now needs a
  // rebuild -- which is the trade that makes a built generator self-contained.
  walkInto(PT_ASSETS, inputs);
  walkInto(PT_SRC, inputs);
  return inputs;
}

/** Every file under `dir`, appended to `into`. Missing directories are skipped. */
function walkInto(dir, into) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // the sibling checkout is missing; a different check reports that
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkInto(full, into);
    else into.push(full);
  }
}

/** The most recently modified of a list of files, or null if none exist. */
function newestOf(files) {
  let newest = null;
  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (newest === null || stat.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: stat.mtimeMs };
  }
  return newest;
}

/**
 * What is wrong, if anything, phrased as something a person can act on.
 *
 * The FIRST LINE is a headline and the rest is detail — the Generate pane
 * shows them differently, and "the generator is not built" and "the generator
 * build is stale" are not the same sentence.
 *
 * That third check exists because the failure it catches is silent. pt-lab is
 * a Vite ALIAS, resolved at build time, so editing pt-lab and re-running the
 * generator without rebuilding runs the old bundle and produces images that
 * look completely reasonable. The symptom is "my change did nothing", which
 * costs a sweep to notice and can cost several to diagnose.
 */
function checkPrerequisites() {
  if (!fs.existsSync(PAGE)) {
    return `The generator is not built.\n  Expected a bundle at ${PAGE}\n` +
      `Run: npm run build:generate`;
  }
  if (assetsDir() === null) {
    return `pt-lab's assets are missing.\n` +
      `  Not in the bundle: ${BUNDLED_ASSETS}\n` +
      `  Nor in the checkout: ${PT_ASSETS}\n` +
      `The build copies them into the bundle, so this usually means the sibling ` +
      `pt-lab-workspace checkout was absent when it ran.\nRun: npm run build:generate`;
  }

  // Compared against the NEWEST output rather than a named one: Vite rewrites
  // every output each build, so they share a timestamp, and taking the newest
  // means a stray file left by an older build cannot raise a false alarm.
  const built = newestOf([path.join(PAGE, 'generate.js'), path.join(PAGE, 'index.html')]);
  const source = newestOf(buildInputs());
  if (built && source && source.mtimeMs > built.mtimeMs) {
    return `The generator build is older than its sources.\n` +
      `  ${path.relative(ROOT, source.file)} changed after ${path.relative(ROOT, built.file)} was built.\n` +
      `Run: npm run build:generate`;
  }
  return null;
}

const DEFAULTS = {
  out: null, size: 512, samples: 96, positions: 3, lighting: 2,
  room: undefined, scene: 'helmet', aovs: false, truth: false,
  creaseAngle: 20, denoise: false, show: false, dryRun: false,
};

/*
 * Radius and height match the scene's default camera (2.2, 1.3, 2.6 looking at
 * 0, 0.7, 0), so the framing stays sane all the way round.
 */
const RADIUS = 3.4;
const HEIGHT = 1.3;

/** The lighting ladder, shared by every scene: 0.5, 1.0, 2.0, … */
function intensityFor(l, lighting) {
  return lighting === 1 ? 1 : 0.5 * 2 ** l;
}

/**
 * What each scene is, and how the camera moves around it.
 *
 * `objects` names library keys for `applyScene`; null means "leave pt-lab's
 * default scene alone", which is the glTF model arriving through `modelUrl`.
 * That model is NOT in the library, which is why only the null case exists for
 * it — nothing can address it by id.
 */
const SCENES = {
  /**
   * pt-lab's damaged helmet. What every number recorded so far was measured
   * on, and a poor subject for GROUND TRUTH: a dense textured mesh whose image
   * edges are overwhelmingly paint rather than geometry, with almost no clean
   * vertices anywhere.
   */
  helmet: {
    room: 'room',
    objects: null,
    /*
     * Kept exactly as it was, arithmetic included. Rewriting this as a
     * spherical orbit would give the same camera to three decimal places and
     * not the same floats, and every helmet number on record was measured
     * here.
     */
    shots({ positions, lighting }) {
      const shots = [];
      for (let p = 0; p < positions; p++) {
        const yaw = (p / positions) * Math.PI * 2;
        const offset = positions === 1 ? 0 : ((p % 3) - 1) * 0.22;
        for (let l = 0; l < lighting; l++) {
          shots.push({
            name: `p${p}-l${l}.png`,
            yaw,
            offset,
            intensity: intensityFor(l, lighting),
            camera: [Math.sin(yaw) * RADIUS, HEIGHT, Math.cos(yaw) * RADIUS],
            target: [offset, 0.7, 0],
          });
        }
      }
      return shots;
    },
  },

  /**
   * A 10 cm cube on a table, with a ball beside it. The subject ground truth
   * needs.
   *
   * A cube in general position shows three faces, nine of its twelve edges and
   * seven of its eight vertices — four where three edges meet and three where
   * two do. design-lab-model.md §5 asserts exactly that from ONE hand-read
   * image; here the renderer says it, per view, for as many views as you care
   * to run.
   *
   * The ball earns its place by having no hard edges at all: its silhouette is
   * a real, strong image edge that no crease test would ever find, which is
   * what keeps the ground truth honest about smooth objects.
   *
   * `room-arealight` rather than the `room` default. The baked-environment room
   * paints its walls into an equirect map, so the background carries hard
   * painted horizons with NO geometry behind them — false positives that are
   * not the detector's fault. Real walls put every strong edge in frame into
   * the ground truth, and the path tracer importance-samples an area light
   * rather than finding an emissive mesh by chance.
   */
  cube: {
    room: 'room-arealight',
    objects: ['Table', 'Cube', 'Ball'],
    /*
     * The cube is 10 cm at (-0.3, 0.8, 0), so the camera has to come in close:
     * at 0.45 m and a 50° field of view the frame spans 0.42 m, putting the
     * cube across about a quarter of it — roughly 60 px at 256², which is the
     * size the segments in assets/cube-1-256x256.png already run at.
     *
     * The elevation is not decoration. Looking level at a cube shows two faces
     * and four vertices; looking down at 25° shows three faces and seven, which
     * is the case the design doc's claim is about.
     */
    shots({ positions, lighting }) {
      const centre = [-0.3, 0.8, 0];
      const radius = 0.45;
      const elevation = (25 * Math.PI) / 180;
      const flat = radius * Math.cos(elevation);
      const shots = [];
      for (let p = 0; p < positions; p++) {
        // The 0.35 rad is not arbitrary and is not decoration. The cube is
        // axis-aligned, so a yaw that is a multiple of 90° looks straight at
        // one face: two faces visible, six vertices, four of them degenerate
        // pairs sharing an image position. The first run of this scene was
        // exactly that, and a degenerate view is a bad thing to measure a
        // corner detector on. 20° off the axis, nothing lands on one.
        const yaw = (p / positions) * Math.PI * 2 + CUBE_YAW_OFFSET;
        // Small next to a 10 cm subject: enough to move it off centre, not
        // enough to push it out of frame.
        const offset = positions === 1 ? 0 : ((p % 3) - 1) * 0.02;
        for (let l = 0; l < lighting; l++) {
          shots.push({
            name: `p${p}-l${l}.png`,
            yaw,
            offset,
            intensity: intensityFor(l, lighting),
            camera: [
              centre[0] + Math.sin(yaw) * flat,
              centre[1] + radius * Math.sin(elevation),
              centre[2] + Math.cos(yaw) * flat,
            ],
            target: [centre[0] + offset, centre[1], centre[2]],
          });
        }
      }
      return shots;
    },
  },
};

/** See the note in the cube scene's shot plan. */
const CUBE_YAW_OFFSET = 0.35;

/** One entry per image, computed up front. */
function plan(options) {
  const opts = { ...DEFAULTS, ...options };
  const scene = SCENES[opts.scene];
  if (!scene) {
    throw new Error(`unknown scene "${opts.scene}" (have: ${Object.keys(SCENES).join(', ')})`);
  }
  return scene.shots(opts);
}

/**
 * Render a sweep of images, and optionally what is really in them.
 *
 * @param {object} options            merged over DEFAULTS
 * @param {(event: object) => void} [onProgress]  'ready' | 'shot' | 'done'
 * @returns {Promise<{files: string[], truth: string[], errors: string[]}>}
 */
async function generate(options = {}, onProgress = () => {}) {
  const opts = { ...DEFAULTS, ...options };
  const scene = SCENES[opts.scene];
  if (!scene) {
    throw new Error(`unknown scene "${opts.scene}" (have: ${Object.keys(SCENES).join(', ')})`);
  }
  const problem = checkPrerequisites();
  if (problem) throw new Error(problem);
  if (!opts.out) throw new Error('generate() needs an output directory');

  /*
   * Three states, not two. `undefined` means the caller said nothing and the
   * scene's own room applies; `null` means the caller explicitly asked for
   * pt-lab's default scene to be left alone (the CLI's `--room none`); a string
   * is a room kind.
   */
  const room = opts.room === undefined ? scene.room : opts.room;

  installHandler();
  fs.mkdirSync(opts.out, { recursive: true });
  // AOV passes go one level down so that `generated/*.png` still matches only
  // the beauty renders. Feeding a depth pass to the pipeline as though it were
  // a photograph is a mistake worth making structurally impossible.
  const aovDir = path.join(opts.out, 'aov');
  if (opts.aovs) fs.mkdirSync(aovDir, { recursive: true });

  const shots = plan(opts);
  if (opts.dryRun) {
    for (const shot of shots) onProgress({ type: 'shot', dryRun: true, ...shot });
    return { files: [], truth: [], errors: [] };
  }

  /*
   * Hidden by default because a batch takes minutes and a window that steals
   * focus for that long is a nuisance. Nothing about the OUTPUT changes when
   * it is shown: exportPNG renders offscreen at the requested size either way.
   */
  const win = new BrowserWindow({
    show: opts.show,
    width: opts.size,
    height: opts.size,
    title: 'CV-Lab — generating',
  });

  const errors = [];
  win.webContents.on('console-message', (event) => {
    // Errors only. The positional signature's `level` is a NUMBER where 2 is a
    // warning, so `level >= 2` quietly promotes every warning to an error.
    if (event.level === 'error' && event.message.trim()) {
      errors.push(event.message.trim().slice(0, 300));
    }
  });

  /*
   * Downloads are collected BY NAME rather than into a single slot.
   *
   * One export used to mean one download, and a lone `pending` promise was
   * enough. An AOV set is three in a row from one call, and a single slot
   * would keep only the last of them — silently, with the other two written to
   * disk and unwaited. Keyed by filename, arrival order stops mattering.
   */
  const downloads = new Map();
  let saveDir = opts.out;
  const onWillDownload = (_event, item) => {
    const name = item.getFilename();
    item.setSavePath(path.join(saveDir, name));
    downloads.set(name, new Promise((resolve, reject) => {
      item.once('done', (_e, state) =>
        state === 'completed' ? resolve(item.getSavePath()) : reject(new Error(`download ${state}`)));
    }));
  };
  session.defaultSession.on('will-download', onWillDownload);

  /**
   * Wait for the download an export should produce.
   *
   * Not a check taken the instant the call resolves: pt-lab's exports open with
   * `if (!this.ready || this.exporting) return;` and return undefined either
   * way, so the download is the only evidence one ran, and it lands
   * asynchronously.
   */
  const awaitDownload = async (name, timeoutMs = 300000) => {
    const started = Date.now();
    while (!downloads.has(name)) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`${name}: pt-lab produced no download within ${timeoutMs / 1000}s`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return downloads.get(name);
  };

  const files = [];
  const truthFiles = [];
  const started = Date.now();
  try {
    const call = (expr) => win.webContents.executeJavaScript(`__gen.${expr}`);
    await win.loadURL(`${SCHEME}://lab/index.html`);

    /*
     * A scene with named objects is applied AFTER init rather than instead of
     * it: init is what loads the denoiser weights and gets a renderer onto the
     * canvas, and applyScene then throws away the model it built. Passing
     * room: null to init avoids building a room twice for no reason.
     */
    const info = await call(`init(${JSON.stringify({
      width: opts.size, height: opts.size, room: scene.objects ? null : room,
    })})`);
    let objects = info.objects;
    if (scene.objects) {
      objects = await call(`applyScene(${JSON.stringify({ room, objects: scene.objects })})`);
    }
    onProgress({
      type: 'ready', elapsedMs: Date.now() - started, status: info.status,
      total: shots.length, scene: opts.scene, room, objects,
    });

    await call(`quality(${JSON.stringify({ samples: opts.samples })})`);
    /*
     * Denoising is OFF in pt-lab by default, so every image generated here so
     * far has carried path-tracing noise -- and grain on a flat wall fires an
     * edge detector as readily as a real edge does. Left off by default all
     * the same, because it is a nonlinear filter that invents structure, and
     * because turning it on would silently move every number already recorded.
     * Turn it on deliberately, and say so when reporting.
     */
    if (opts.denoise) await call('denoise(true)');

    for (const [index, shot] of shots.entries()) {
      await call(`camera(${JSON.stringify(shot.camera)}, ${JSON.stringify(shot.target)})`);
      await call(`lighting(${JSON.stringify({ intensity: shot.intensity })})`);

      const at = Date.now();
      const base = shot.name.replace(/\.png$/, '');
      downloads.clear();

      saveDir = opts.out;
      await call(`render(${opts.size}, ${JSON.stringify(shot.name)})`);
      const file = await awaitDownload(shot.name);
      files.push(file);

      const extra = { aovs: [], truth: null };
      if (opts.aovs) {
        saveDir = aovDir;
        const { files: names } = await call(`aovs(${opts.size}, ${JSON.stringify(base)})`);
        for (const name of names) extra.aovs.push(await awaitDownload(name));
      }
      if (opts.truth) {
        /*
         * Returned, not downloaded. It is data rather than an image, and the
         * one number needed to read the depth pass -- maxDepth -- travels with
         * it, so nothing has to parse a float back out of a filename.
         */
        const gt = await call(`groundTruth(${opts.size}, ${JSON.stringify({
          creaseAngle: opts.creaseAngle,
        })})`);
        if (gt) {
          const gtFile = path.join(opts.out, `${base}.gt.json`);
          fs.writeFileSync(gtFile, JSON.stringify({ ...gt, image: shot.name }, null, 2));
          truthFiles.push(gtFile);
          extra.truth = {
            file: gtFile,
            edges: gt.edges.length,
            visibleEdges: gt.edges.filter((e) => e.visible > 0).length,
            vertices: gt.vertices.length,
            visibleVertices: gt.vertices.filter((v) => v.visible).length,
          };
        }
      }

      onProgress({
        type: 'shot', index, total: shots.length, file, elapsedMs: Date.now() - at,
        ...extra, ...shot,
      });
    }
  } finally {
    saveDir = opts.out;
    session.defaultSession.removeListener('will-download', onWillDownload);
    if (!win.isDestroyed()) win.destroy();
  }

  onProgress({ type: 'done', files, truth: truthFiles, errors, elapsedMs: Date.now() - started });
  return { files, truth: truthFiles, errors };
}

module.exports = {
  generate, plan, registerScheme, checkPrerequisites, buildInputs,
  DEFAULTS, SCENES, PAGE, PT_ASSETS, PT_SRC, BUNDLED_ASSETS, CORE_ASSETS, assetsDir,
};
