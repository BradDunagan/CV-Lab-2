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

const { app } = require('electron');
const { generate, registerScheme, checkPrerequisites, DEFAULTS } =
  require('../src/generate/driver');

/* ------------------------------------------------------------------ */

const USAGE = `
CV-Lab image generator — beauty renders from pt-lab

  npm run generate -- --out <dir> [options]

  --out <dir>        where to write the PNGs (required)
  --size <px>        square render size                (default 512)
  --samples <n>      path-tracing samples per image    (default 96)
  --positions <n>    object rotations to step through  (default 3)
  --lighting <n>     environment intensities           (default 2)
  --room <kind>      room | room-emissive | room-arealight | none
                     (default room — see below)
  --show             show the render window and watch it converge
  --dry-run          set everything up, render nothing

--room none uses pt-lab's default scene, which lights the subject with a
photographic HDR environment. It looks better and is a poor CV fixture: the
blurred background and textured tabletop dominate the edge count. A room
isolates the subject, which is why it is the default here.

Each image is named <position>-<lighting>.png and tagged sRGB by pt-lab, so
\`npm run lab\` can confirm its encoding rather than assume it.
`.trim();

function parseArgs(argv) {
  const opts = { out: null, size: 512, samples: 96, positions: 3, lighting: 2,
                 room: 'room', show: false, dryRun: false };
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
      case '--room': {
        const kind = argv[++i];
        // `none` is this CLI's word for "leave pt-lab's default scene alone",
        // which is the HDR environment. pt-lab has no such room kind.
        opts.room = kind === 'none' ? null : kind;
        break;
      }
      case '--show': opts.show = true; break;
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
 * Must happen before the app is ready, which is why it is called at module
 * scope rather than inside whenReady.
 */
registerScheme();

/*
 * Arguments and prerequisites are settled BEFORE the app starts. None of it
 * needs Electron, and every early exit from inside it was a chance to fault on
 * shutdown -- see bail() above.
 */
let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  bail(process.stderr, `${err.message}\n\n${USAGE}`, 2);
}

if (opts && (opts.help || !opts.out)) {
  bail(process.stdout, USAGE, opts.help ? 0 : 2);
} else if (opts) {
  const problem = checkPrerequisites();
  if (problem) bail(process.stderr, problem, 2);
}

app.whenReady().then(async () => {
  console.log('Initialising the path tracer (loads a model and builds a BVH)…');

  const { files, errors } = await generate(opts, (event) => {
    if (event.type === 'ready') {
      console.log(`  ready in ${(event.elapsedMs / 1000).toFixed(1)}s — ` +
        `${event.status.mode}, ${event.total} image(s) to render`);
    } else if (event.type === 'shot' && event.dryRun) {
      console.log(`  (dry run) ${event.name}  yaw=${event.yaw.toFixed(2)} ` +
        `offset=${event.offset.toFixed(2)} intensity=${event.intensity}`);
    } else if (event.type === 'shot') {
      console.log(`  ok   ${event.name}  yaw=${event.yaw.toFixed(2)} ` +
        `offset=${event.offset.toFixed(2)} intensity=${event.intensity}  ` +
        `${(event.elapsedMs / 1000).toFixed(1)}s`);
    }
  });

  if (errors.length > 0) console.error(`\npage errors:\n  ${errors.slice(0, 5).join('\n  ')}`);
  writeThenExit(process.stdout,
    `\n${files.length} image(s) -> ${opts.out}`,
    errors.length > 0 ? 1 : 0);
}).catch((err) => {
  writeThenExit(process.stderr,
    `generator failed:\n${(err && (err.stack || err.message)) || err}`, 1);
});
