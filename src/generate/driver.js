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
    // pt-lab's default model and environment URLs are ./assets/…, so those come
    // from its own checkout; everything else is the built page.
    const file = rel.startsWith('assets/')
      ? path.join(PT_ASSETS, rel.slice('assets/'.length))
      : path.join(PAGE, rel || 'index.html');
    return net.fetch(pathToFileURL(file).toString());
  });
  handlerInstalled = true;
}

/** What is missing, if anything, phrased as something a person can act on. */
function checkPrerequisites() {
  if (!fs.existsSync(PAGE)) {
    return `No generator build at ${PAGE}\nRun: npm run build:generate`;
  }
  if (!fs.existsSync(PT_ASSETS)) {
    return `pt-lab's assets are missing:\n  ${PT_ASSETS}\n` +
      `The generator needs the sibling pt-lab-workspace checkout.`;
  }
  return null;
}

const DEFAULTS = {
  out: null, size: 512, samples: 96, positions: 3, lighting: 2,
  room: 'room', show: false, dryRun: false,
};

/*
 * Radius and height match the scene's default camera (2.2, 1.3, 2.6 looking at
 * 0, 0.7, 0), so the framing stays sane all the way round.
 */
const RADIUS = 3.4;
const HEIGHT = 1.3;

/**
 * One entry per image, computed up front.
 *
 * Position is varied by moving the CAMERA, not the object: setObjectTransform
 * and exportRotationSeries both need an id from pt-lab's library, and the base
 * model arrives through `modelUrl` and is not in it. Orbiting gives what the
 * pipeline cares about anyway — a different pose, and by nudging the look-at
 * target, a subject that is not always dead centre.
 */
function plan({ positions, lighting }) {
  const shots = [];
  for (let p = 0; p < positions; p++) {
    const yaw = (p / positions) * Math.PI * 2;
    const offset = positions === 1 ? 0 : ((p % 3) - 1) * 0.22;
    for (let l = 0; l < lighting; l++) {
      const intensity = lighting === 1 ? 1 : 0.5 * 2 ** l;
      shots.push({
        name: `p${p}-l${l}.png`,
        yaw,
        offset,
        intensity,
        camera: [Math.sin(yaw) * RADIUS, HEIGHT, Math.cos(yaw) * RADIUS],
        target: [offset, 0.7, 0],
      });
    }
  }
  return shots;
}

/**
 * Render a sweep of beauty images.
 *
 * @param {object} options            merged over DEFAULTS
 * @param {(event: object) => void} [onProgress]  'ready' | 'shot' | 'done'
 * @returns {Promise<{files: string[], errors: string[]}>}
 */
async function generate(options = {}, onProgress = () => {}) {
  const opts = { ...DEFAULTS, ...options };
  const problem = checkPrerequisites();
  if (problem) throw new Error(problem);
  if (!opts.out) throw new Error('generate() needs an output directory');

  installHandler();
  fs.mkdirSync(opts.out, { recursive: true });

  const shots = plan(opts);
  if (opts.dryRun) {
    for (const shot of shots) onProgress({ type: 'shot', dryRun: true, ...shot });
    return { files: [], errors: [] };
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

  let pending = null;
  const onWillDownload = (_event, item) => {
    item.setSavePath(path.join(opts.out, item.getFilename()));
    pending = new Promise((resolve, reject) => {
      item.once('done', (_e, state) =>
        state === 'completed' ? resolve(item.getSavePath()) : reject(new Error(`download ${state}`)));
    });
  };
  session.defaultSession.on('will-download', onWillDownload);

  /**
   * Wait for the download an export should produce.
   *
   * Not a check taken the instant render() resolves: exportPNG opens with
   * `if (!this.ready || this.exporting) return;` and returns undefined either
   * way, so the download is the only evidence it ran, and it lands
   * asynchronously.
   */
  const awaitDownload = async (name, timeoutMs = 300000) => {
    const started = Date.now();
    while (!pending) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`${name}: pt-lab produced no download within ${timeoutMs / 1000}s`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return pending;
  };

  const files = [];
  const started = Date.now();
  try {
    const call = (expr) => win.webContents.executeJavaScript(`__gen.${expr}`);
    await win.loadURL(`${SCHEME}://lab/index.html`);

    const info = await call(`init(${JSON.stringify({
      width: opts.size, height: opts.size, room: opts.room,
    })})`);
    onProgress({ type: 'ready', elapsedMs: Date.now() - started, status: info.status, total: shots.length });

    await call(`quality(${JSON.stringify({ samples: opts.samples })})`);

    for (const [index, shot] of shots.entries()) {
      await call(`camera(${JSON.stringify(shot.camera)}, ${JSON.stringify(shot.target)})`);
      await call(`lighting(${JSON.stringify({ intensity: shot.intensity })})`);

      const at = Date.now();
      pending = null;
      await call(`render(${opts.size}, ${JSON.stringify(shot.name)})`);
      const file = await awaitDownload(shot.name);
      files.push(file);
      onProgress({
        type: 'shot', index, total: shots.length, file, elapsedMs: Date.now() - at, ...shot,
      });
    }
  } finally {
    session.defaultSession.removeListener('will-download', onWillDownload);
    if (!win.isDestroyed()) win.destroy();
  }

  onProgress({ type: 'done', files, errors, elapsedMs: Date.now() - started });
  return { files, errors };
}

module.exports = { generate, plan, registerScheme, checkPrerequisites, DEFAULTS, PAGE, PT_ASSETS };
