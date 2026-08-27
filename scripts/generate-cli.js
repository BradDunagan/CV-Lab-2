#!/usr/bin/env electron
'use strict';

/**
 * Generate beauty renders with pt-lab, varying object position and lighting.
 *
 *   npm run generate -- --out generated/ --positions 3 --lighting 2
 *
 * The images this writes are the input to `npm run lab`, which runs the
 * pipeline over them. Two separate tools on purpose: generating needs a GPU
 * and takes seconds per image, and running the pipeline needs neither.
 *
 * WHY A CUSTOM PROTOCOL rather than file://
 *
 * pt-lab loads an HDR environment and a glTF model through three.js's
 * loaders, which use fetch() -- and Chromium refuses fetch() on file:// URLs.
 * The first attempt failed with a bare "Failed to fetch". A registered scheme
 * gives a real origin where fetch works, in-process, with no TCP port and
 * nothing listening. `gen://lab/…` serves the built page, and `gen://lab/
 * assets/…` serves pt-lab's own assets from the sibling checkout, which is
 * where its default model and environment URLs already point.
 *
 * WHY THE DOWNLOAD INTERCEPT
 *
 * pt-lab delivers an export by triggering a browser download. That is worth
 * keeping rather than reading the canvas here, because exportPNG also
 * converges to the sample target, denoises, downscales, and tags the PNG as
 * sRGB. That tag is why cv-lab-2 can CONFIRM the encoding on load instead of
 * falling back to the convention.
 */

const { app, BrowserWindow, protocol, net, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'dist-generate');
const PT_ASSETS = path.join(ROOT, '..', 'pt-lab-workspace', 'packages', 'demo', 'public', 'assets');

/* ------------------------------------------------------------------ */

const USAGE = `
CV-Lab image generator — beauty renders from pt-lab

  npm run generate -- --out <dir> [options]

  --out <dir>        where to write the PNGs (required)
  --size <px>        square render size                (default 512)
  --samples <n>      path-tracing samples per image    (default 96)
  --positions <n>    object rotations to step through  (default 3)
  --lighting <n>     environment intensities           (default 2)
  --room <kind>      room | room-emissive | room-arealight
  --dry-run          set everything up, render nothing

Each image is named <position>-<lighting>.png and tagged sRGB by pt-lab, so
\`npm run lab\` can confirm its encoding rather than assume it.
`.trim();

function parseArgs(argv) {
  const opts = { out: null, size: 512, samples: 96, positions: 3, lighting: 2, room: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const num = () => {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v)) throw new Error(`${arg} needs a number`);
      return v;
    };
    switch (arg) {
      case '--out': opts.out = argv[++i]; break;
      case '--size': opts.size = num(); break;
      case '--samples': opts.samples = num(); break;
      case '--positions': opts.positions = num(); break;
      case '--lighting': opts.lighting = num(); break;
      case '--room': opts.room = argv[++i]; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error(`unknown option ${arg}`);
    }
  }
  return opts;
}

/** app.exit() does not flush stdout; a pending write to a pipe faults on
 *  Windows. Same lesson as scripts/lab-cli.js. */
/**
 * Report a usage problem and stop, BEFORE Electron starts.
 *
 * Argument parsing needs nothing from Electron, and exiting from inside it is
 * where the trouble was: app.exit() terminates immediately and on Windows
 * intermittently faults with 0xC0000005 -- exit code 3221225477 -- while
 * Electron's threads are still unwinding. Both cases that failed on the
 * windows runner were usage paths, `--help` and an unknown option, and neither
 * had any reason to have started an app at all.
 *
 * app.quit() is not the answer either: it ignores process.exitCode and always
 * exits 0, which is useless for a CLI.
 *
 * The write callback still matters -- process.exit() does not flush a pending
 * write to a pipe any more than app.exit() does.
 */
function bail(stream, text, code) {
  stream.write(text.endsWith('\n') ? text : `${text}\n`, () => process.exit(code));
}

/**
 * Finish a run that actually did work, once a window exists.
 *
 * app.exit() is unavoidable here -- it is the only way to choose the exit
 * code -- so flush first and keep the window of exposure small.
 */
function writeThenExit(stream, text, code) {
  stream.write(text.endsWith('\n') ? text : `${text}\n`, () => app.exit(code));
}

/*
 * Must be registered before the app is ready, and must say supportFetchAPI --
 * that is the whole reason this scheme exists.
 */
protocol.registerSchemesAsPrivileged([{
  scheme: 'gen',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

/* ------------------------------------------------------------------ */

/*
 * Settled before the app starts -- none of it needs Electron, and every early
 * exit from inside it was a chance to fault on shutdown. See bail() above.
 */
let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  bail(process.stderr, `${err.message}\n\n${USAGE}`, 2);
}

if (opts && (opts.help || !opts.out)) {
  bail(process.stdout, USAGE, opts.help ? 0 : 2);
} else if (opts && !fs.existsSync(PAGE)) {
  bail(process.stderr, `no generator build at ${PAGE}\nRun: npm run build:generate`, 2);
} else if (opts && !fs.existsSync(PT_ASSETS)) {
  bail(process.stderr,
    `pt-lab's assets are missing:\n  ${PT_ASSETS}\n` +
    `The generator needs the sibling pt-lab-workspace checkout.`, 2);
}

app.whenReady().then(async () => {
  fs.mkdirSync(opts.out, { recursive: true });

  protocol.handle('gen', (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    // pt-lab's default model and environment URLs are ./assets/…, so those
    // come from its own checkout; everything else is the built page.
    const file = rel.startsWith('assets/')
      ? path.join(PT_ASSETS, rel.slice('assets/'.length))
      : path.join(PAGE, rel || 'index.html');
    return net.fetch(pathToFileURL(file).toString());
  });

  const win = new BrowserWindow({ show: false, width: opts.size, height: opts.size });

  const pageErrors = [];
  /*
   * Errors only.
   *
   * The positional (event, level, message) signature is deprecated in Electron
   * 43, and its `level` is a NUMBER where 2 is a warning and 3 an error -- so
   * the obvious `level >= 2` quietly promotes every warning to an error. That
   * is how a Content-Security-Policy warning came to fail this run and print
   * itself as a blank line. The event object reports level as a string.
   */
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' && event.message.trim()) {
      pageErrors.push(event.message.trim().slice(0, 300));
    }
  });

  /*
   * Where a download lands. pt-lab picks the filename; the directory is ours,
   * and setSavePath stops Electron asking.
   */
  let pending = null;
  session.defaultSession.on('will-download', (_event, item) => {
    const target = path.join(opts.out, item.getFilename());
    item.setSavePath(target);
    pending = new Promise((resolve, reject) => {
      item.once('done', (_e, state) =>
        state === 'completed' ? resolve(target) : reject(new Error(`download ${state}`)));
    });
  });

  /**
   * Wait for the download an export should produce.
   *
   * Not a check taken the instant render() resolves: exportPNG returns
   * undefined whether it exported or silently declined, so the download is the
   * only evidence either way, and it lands asynchronously. Waiting with a
   * timeout turns a silent no-op into a sentence.
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

  const js = (code) => win.webContents.executeJavaScript(code);
  const call = (expr) => js(`__gen.${expr}`);

  await win.loadURL('gen://lab/index.html');

  const started = Date.now();
  console.log(`Initialising the path tracer (loads a model and builds a BVH)…`);
  const info = await call(`init(${JSON.stringify({ width: opts.size, height: opts.size, room: opts.room })})`);
  console.log(`  ready in ${((Date.now() - started) / 1000).toFixed(1)}s — ${info.status.mode}`);

  await call(`quality(${JSON.stringify({ samples: opts.samples })})`);

  /*
   * Position is varied by moving the CAMERA, not the object.
   *
   * setObjectTransform only reaches objects in pt-lab's library -- imported
   * ones, plus anything added to the scene. The base model arrives through
   * `modelUrl` and is not among them, so listObjects() is empty on the default
   * scene and there is nothing to transform. exportRotationSeries has the same
   * requirement.
   *
   * Orbiting gives the same two things the pipeline actually cares about, and
   * arguably more directly: a different pose, so different edges are visible
   * and meet at different angles; and, by nudging the look-at target, a
   * subject that is not always dead centre -- which is what exercises edges
   * away from the middle of the frame rather than only through it.
   *
   * Radius and height match the scene's default camera (2.2, 1.3, 2.6 looking
   * at 0, 0.7, 0), so the framing stays sane as it goes round.
   */
  const RADIUS = 3.4;
  const HEIGHT = 1.3;

  const written = [];
  for (let p = 0; p < opts.positions; p++) {
    // A full turn split evenly, so the series covers distinct silhouettes
    // rather than clustering near one view.
    const yaw = (p / opts.positions) * Math.PI * 2;
    const offset = opts.positions === 1 ? 0 : ((p % 3) - 1) * 0.22;
    await call(`camera(${JSON.stringify([Math.sin(yaw) * RADIUS, HEIGHT, Math.cos(yaw) * RADIUS])}, ` +
      `${JSON.stringify([offset, 0.7, 0])})`);

    for (let l = 0; l < opts.lighting; l++) {
      // Doubling steps, so the difference is visible rather than marginal.
      const intensity = opts.lighting === 1 ? 1 : 0.5 * 2 ** l;
      await call(`lighting(${JSON.stringify({ intensity })})`);

      const name = `p${p}-l${l}.png`;
      if (opts.dryRun) { console.log(`  (dry run) ${name}  yaw=${yaw.toFixed(2)} intensity=${intensity}`); continue; }

      const at = Date.now();
      pending = null;
      await call(`render(${opts.size}, ${JSON.stringify(name)})`);
      const file = await awaitDownload(name);
      written.push(file);
      console.log(`  ok   ${name}  yaw=${yaw.toFixed(2)} offset=${offset.toFixed(2)} ` +
        `intensity=${intensity}  ${((Date.now() - at) / 1000).toFixed(1)}s`);
    }
  }

  if (pageErrors.length > 0) {
    console.error(`\npage errors:\n  ${pageErrors.slice(0, 5).join('\n  ')}`);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  writeThenExit(process.stdout,
    `\n${written.length} image(s) in ${seconds}s -> ${opts.out}`,
    pageErrors.length > 0 ? 1 : 0);
}).catch((err) => {
  writeThenExit(process.stderr,
    `generator failed:\n${(err && (err.stack || err.message)) || err}`, 1);
});
