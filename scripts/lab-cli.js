#!/usr/bin/env electron
'use strict';

/**
 * Run the lab over images without opening the app.
 *
 * design-lab-model.md §5 makes a session replayable and every result content-
 * hashed; until now there was no way to exercise that except by hand, in the
 * interface. This is the entry point that was missing.
 *
 *   npm run lab -- --script pipeline.lab --image assets/cube-1-256x256.png
 *   npm run lab -- --script pipeline.lab --images 'assets/*.png' --out out/
 *
 * WHY THIS RUNS UNDER ELECTRON, not plain node.
 *
 * `load` borrows Chromium's image decoder, because it handles every format the
 * platform knows and is already in the process (§11). That decoder exists only
 * in a renderer, so a batch runner needs one — there is no headless-under-node
 * route that can open a PNG. The window is never shown.
 *
 * It drives `window.lab`, the same contextBridge surface the interface uses,
 * rather than reaching for Session directly. That is deliberate: a batch path
 * with its own way in would be free to drift from what the app does, and then
 * "reproducible" would mean two different things. Everything here is
 * expressible by typing.
 *
 * WHAT IT DOES NOT DO: loop, branch, or substitute variables inside the
 * command language. §4 is explicit that the language stays tiny and that a
 * real scripting engine gets embedded rather than grown. So the iteration
 * lives out here in JavaScript, and each image gets a fresh session running
 * the same fixed script.
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------------ */
/* arguments                                                           */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { images: [], script: null, out: null, from: 'srgb', as: 'srgb', slot: 'A', quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case '--script': opts.script = next(); break;
      case '--image': opts.images.push(next()); break;
      case '--out': opts.out = next(); break;
      // What the FILE holds, and what the buffer should hold. Both matter and
      // neither is guessable: an untagged PNG carrying linear samples — a
      // renderer's depth or position pass, say — decodes wrongly under the
      // sRGB convention, silently. §11.
      case '--from': opts.from = next(); break;
      case '--as': opts.as = next(); break;
      case '--slot': opts.slot = next(); break;
      case '--quiet': opts.quiet = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
        opts.images.push(arg);
    }
  }
  return opts;
}

const USAGE = `
cv-lab-2 batch runner

  npm run lab -- --script <file> [--image <png> ...] [options]

  --script <file>   commands to run against each image, one per line
  --image <png>     an image to run over; repeatable, or list them bare
  --out <dir>       write one <name>.session.json and <name>.features.json
                    per image (default: report to stdout only)
  --from srgb|linear   what the file's samples MEAN      (default srgb)
  --as   srgb|linear   what the buffer should hold       (default srgb)
  --slot <name>     slot the image loads into            (default A)
  --quiet           only report failures

The script is the command language, unchanged — no variables, no loops. Each
image gets a fresh session that starts with

  <slot> = load("<image>", from=<from>, as=<as>)

and then runs your script, so write it against <slot>.
`.trim();

/* ------------------------------------------------------------------ */

async function runOne(win, { image, script, opts }) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const call = (expr) => js(`window.lab.${expr}`);

  // A fresh session per image: slot names are reused across runs, and a
  // leftover binding would silently feed one image's buffer into the next
  // image's pipeline.
  await call('reset()');

  const quoted = await call(`quote(${JSON.stringify(image)})`);
  const load = `${opts.slot} = load(${quoted}, from=${opts.from}, as=${opts.as})`;

  const commands = [load, ...script];
  for (const command of commands) {
    // One statement at a time, so a failure names the line that failed
    // rather than the whole script.
    try {
      await call(`run(${JSON.stringify(command)})`);
    } catch (err) {
      // executeJavaScript rejects with the page's value, which is
      // Error-shaped but may carry no stack.
      const message = (err && (err.message || err.stack)) || String(err);
      return { image, ok: false, failed: command, error: message.replace(/^Error:\s*/, '') };
    }
  }

  const session = await call('sessionJSON()');
  const features = await call('features()');
  const slots = await call('slots()');
  return { image, ok: true, session, features, slots };
}

/* ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    app.exit(2);
    return;
  }

  if (opts.help || (!opts.script && opts.images.length === 0)) {
    console.log(USAGE);
    app.exit(opts.help ? 0 : 2);
    return;
  }

  const missing = opts.images.filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    console.error(`no such image:\n  ${missing.join('\n  ')}`);
    app.exit(2);
    return;
  }
  if (opts.script && !fs.existsSync(opts.script)) {
    console.error(`no such script: ${opts.script}`);
    app.exit(2);
    return;
  }

  const script = opts.script
    ? fs.readFileSync(opts.script, 'utf8').split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('//'))
    : [];

  if (opts.out) fs.mkdirSync(opts.out, { recursive: true });

  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const pageErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) pageErrors.push(message);
  });

  /*
   * A blank page is enough: nothing here draws. The preload is what carries
   * the session, and it needs a document to exist, not a UI.
   *
   * It still gets a Content-Security-Policy. `sandbox: false` above is
   * conditional on this window only ever loading local, first-party content
   * (electron-guide.md §1), and that condition does not lapse because the
   * window is invisible -- this one loads a data: URL and runs a preload with
   * Node and the whole session in it. Without the policy Electron warns, and
   * it is right to.
   */
  const BLANK_PAGE = [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" ',
    'content="default-src \'none\'; img-src \'self\' data: blob:">',
    '<title>cv-lab batch</title>',
  ].join('');
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(BLANK_PAGE)}`);

  const started = Date.now();
  const results = [];
  let failures = 0;

  for (const image of opts.images) {
    const result = await runOne(win, { image, script, opts });
    results.push(result);

    const name = path.basename(image).replace(/\.[^.]+$/, '');
    if (result.ok) {
      const features = result.features.reduce((n, f) => n + f.features.length, 0);
      if (!opts.quiet) {
        console.log(`  ok   ${name}  ${result.session.entries.length} entries, ${features} features`);
      }
      if (opts.out) {
        fs.writeFileSync(path.join(opts.out, `${name}.session.json`),
          JSON.stringify(result.session, null, 2));
        fs.writeFileSync(path.join(opts.out, `${name}.features.json`),
          JSON.stringify(result.features, null, 2));
      }
    } else {
      failures++;
      console.error(`  FAIL ${name}\n       ${result.failed}\n       ${result.error}`);
    }
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${results.length - failures}/${results.length} in ${seconds}s` +
    (opts.out ? `, written to ${opts.out}` : ''));
  if (pageErrors.length > 0) {
    console.error(`\npage errors:\n  ${pageErrors.slice(0, 5).join('\n  ')}`);
  }

  app.exit(failures === 0 && pageErrors.length === 0 ? 0 : 1);
}).catch((err) => {
  console.error(`batch runner could not start:\n${(err && (err.stack || err.message)) || err}`);
  app.exit(1);
});
