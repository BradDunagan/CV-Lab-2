'use strict';

/**
 * The batch runner — scripts/lab-cli.js.
 *
 * Runs it as a subprocess, the way a person or a Makefile would, rather than
 * importing its internals: the thing worth testing about an entry point is
 * that invoking it works, including the exit codes something downstream will
 * branch on.
 *
 * Needs Electron on PATH but is itself a plain node script — it spawns the
 * runner rather than being one, so it can sit with the other node suites.
 *
 *   node test/cli.js
 */

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'lab-cli.js');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

console.log('cv-lab-2 batch runner tests');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvlab-cli-'));

/**
 * A source that needs no file on disk.
 *
 * The runner always begins with a load, so a fixture image is required. The
 * repository's assets/ is gitignored, so one is drawn here instead — a black
 * square with a white one inside it, which has four unambiguous corners and
 * therefore exercises the whole pipeline rather than just its plumbing.
 */
function writeSquare(file, size = 96) {
  const { encodePNG } = require('../scripts/png');
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = x > size * 0.25 && x < size * 0.75 && y > size * 0.25 && y < size * 0.75;
      const v = inside ? 255 : 0;
      const i = (y * size + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  fs.writeFileSync(file, encodePNG(size, size, rgba));
  return file;
}

/**
 * A horizontal ramp.
 *
 * The square above is pure black and white, and BOTH transfer functions map
 * 0 to 0 and 1 to 1 exactly — so a colour-space test using it compares two
 * identical buffers and passes with the conversion deleted. That is the second
 * fixture in this project to hide a transfer function that way; the
 * determinism suite's checkerboard did it first. Anything testing srgb against
 * linear needs values in between.
 */
function writeRamp(file, width = 64, height = 16) {
  const { encodePNG } = require('../scripts/png');
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round((x / (width - 1)) * 255);
      const i = (y * width + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  fs.writeFileSync(file, encodePNG(width, height, rgba));
  return file;
}

const image = writeSquare(path.join(tmp, 'square.png'));
const ramp = writeRamp(path.join(tmp, 'ramp.png'));

function run(args) {
  const result = spawnSync(ELECTRON, [CLI, ...args], { encoding: 'utf8', cwd: ROOT });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function writeScript(name, lines) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

/* --- usage --------------------------------------------------------- */

test('--help explains itself and exits 0', () => {
  const { code, out } = run(['--help']);
  assert.equal(code, 0);
  assert.match(out, /--script/);
  assert.match(out, /--from srgb\|linear/);
});

test('a missing image is a usage error, not a crash', () => {
  const { code, out } = run(['--image', path.join(tmp, 'absent.png')]);
  assert.equal(code, 2, 'expected exit 2 for bad arguments');
  assert.match(out, /no such image/);
});

test('an unknown option is refused', () => {
  const { code, out } = run(['--wat']);
  assert.equal(code, 2);
  assert.match(out, /unknown option --wat/);
});

/* --- running ------------------------------------------------------- */

const pipeline = writeScript('pipeline.lab', [
  '// comments and blank lines are skipped',
  '',
  'L  = toLinear(A)',
  'G  = gray(L)',
  'B  = gaussian(G, sigma=1.4)',
  'Gx = sobel(B, axis=x)',
  'Gy = sobel(B, axis=y)',
  'M  = sobel(B, axis=mag)',
  'N  = nms(M, Gx, Gy)',
  'S  = segments(N, Gx, Gy)',
  'R  = merge(S)',
  'F  = fit(R)',
  'C  = corners(F)',
]);

const out = path.join(tmp, 'out');
const full = run(['--script', pipeline, '--image', image, '--out', out]);

test('the whole pipeline runs over an image, headless', () => {
  assert.equal(full.code, 0, full.out);
  assert.match(full.out, /ok\s+square/);
});

test('it writes a replayable session and the features beside it', () => {
  const session = JSON.parse(fs.readFileSync(path.join(out, 'square.session.json'), 'utf8'));
  assert.equal(session.format, 'cv-lab-2/session');
  // load, plus one per line of the script.
  assert.equal(session.entries.length, 12);
  assert.ok(session.environment.electron, 'the session should record its environment');
  for (const entry of session.entries) {
    assert.match(entry.output.hash, /^[0-9a-f]{64}$/, `${entry.text} has no content hash`);
  }
});

test('a square yields four corners', () => {
  // Not plumbing: the fixture has four unambiguous right angles, so anything
  // less means the pipeline ran without actually finding the geometry.
  const lists = JSON.parse(fs.readFileSync(path.join(out, 'square.features.json'), 'utf8'));
  const segments = lists.find((l) => l.slot === 'F');
  const corners = lists.find((l) => l.slot === 'C');
  assert.ok(segments && segments.features.length >= 4,
    `expected at least 4 edges, got ${segments?.features.length}`);
  assert.ok(corners && corners.features.length >= 4,
    `expected at least 4 corners, got ${corners?.features.length}`);
  for (const f of corners.features) assert.equal(f.type, 'edge-corner');
});

test('features carry the dimensions of the image they were measured in', () => {
  // They have none of their own (§1), which is what lets a viewer draw them
  // over the right tile — and what a downstream consumer needs to place them.
  const lists = JSON.parse(fs.readFileSync(path.join(out, 'square.features.json'), 'utf8'));
  for (const list of lists) {
    assert.equal(list.width, 96);
    assert.equal(list.height, 96);
  }
});

/* --- failure ------------------------------------------------------- */

test('a refused command fails the run and names the line', () => {
  // gray on an srgb buffer: §2's refusal, reaching the batch path intact.
  const script = writeScript('bad.lab', ['G = gray(A)']);
  const { code, out: text } = run(['--script', script, '--image', image]);
  assert.equal(code, 1, 'a failed pipeline should exit 1');
  assert.match(text, /FAIL\s+square/);
  assert.match(text, /G = gray\(A\)/, 'the failing command should be named');
  assert.match(text, /needs linear input/, 'and the reason kept');
});

/* --- colour space -------------------------------------------------- */

test('--from and --as reach the load, and change the result', () => {
  /*
   * The trap this exists for: an untagged PNG holding LINEAR samples — a
   * renderer's depth or object-position pass — decodes wrongly under the sRGB
   * convention, silently and nonlinearly. Nothing can detect it, so the only
   * defence is that stating it works and demonstrably changes the numbers.
   */
  const script = writeScript('stats.lab', ['stats(A)']);
  const outs = ['srgb', 'linear'].map((from) => {
    const dir = path.join(tmp, `as-${from}`);
    const r = run(['--script', script, '--image', ramp, '--from', from, '--as', 'linear',
                   '--out', dir]);
    assert.equal(r.code, 0, r.out);
    const session = JSON.parse(fs.readFileSync(path.join(dir, 'ramp.session.json'), 'utf8'));
    return session.entries[0];
  });

  assert.match(outs[0].text, /from=srgb/);
  assert.match(outs[1].text, /from=linear/);
  assert.notEqual(outs[0].output.hash, outs[1].output.hash,
    'reading the same bytes as srgb and as linear must not produce the same buffer');
});

test('--curve reaches the load, recorded, and changes the result', () => {
  // A measured response curve (npm run response) in place of --from.
  const script = writeScript('stats-curve.lab', ['stats(A)']);
  const curve = path.join(tmp, 'cube.json');
  fs.writeFileSync(curve, JSON.stringify({ linear: Array.from({ length: 256 }, (_, u) => (u / 255) ** 3) }));
  const outs = [[], ['--curve', curve]].map((extra, i) => {
    const dir = path.join(tmp, `curve-${i}`);
    const r = run(['--script', script, '--image', ramp, '--as', 'linear', ...extra, '--out', dir]);
    assert.equal(r.code, 0, r.out);
    return JSON.parse(fs.readFileSync(path.join(dir, 'ramp.session.json'), 'utf8')).entries[0];
  });
  assert.match(outs[0].text, /curve=""/);
  assert.match(outs[1].text, /curve="[^"]*cube\.json"/);
  assert.notEqual(outs[0].output.hash, outs[1].output.hash);
});

/* --- batching ------------------------------------------------------ */

test('several images each get a fresh session', () => {
  /*
   * Slot names repeat across runs. Without a reset between images the second
   * image would inherit the first image's bindings, and a pipeline could
   * quietly measure the wrong picture.
   */
  const second = writeSquare(path.join(tmp, 'square2.png'), 64);
  const dir = path.join(tmp, 'many');
  const { code, out: text } = run(['--script', pipeline, '--out', dir, image, second]);
  assert.equal(code, 0, text);

  const a = JSON.parse(fs.readFileSync(path.join(dir, 'square.session.json'), 'utf8'));
  const b = JSON.parse(fs.readFileSync(path.join(dir, 'square2.session.json'), 'utf8'));
  assert.equal(a.entries.length, b.entries.length, 'both ran the same script');
  assert.equal(a.entries[0].record.inputs.length, 0, 'each starts from its own load');
  assert.notEqual(a.entries[0].output.hash, b.entries[0].output.hash,
    'two different images must not load to the same buffer');
});

test('--extra runs an image\'s own commands after the script, in its log', () => {
  const second = writeSquare(path.join(tmp, 'square3.png'), 64);
  const extra = path.join(tmp, 'extra.json');
  fs.writeFileSync(extra, JSON.stringify({ square: ['X = toLinear(A)'] }));
  const dir = path.join(tmp, 'extra');
  const { code, out: text } = run(['--script', pipeline, '--out', dir, '--extra', extra, image, second]);
  assert.equal(code, 0, text);
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'square.session.json'), 'utf8'));
  const b = JSON.parse(fs.readFileSync(path.join(dir, 'square3.session.json'), 'utf8'));
  assert.equal(a.entries.at(-1).target, 'X', 'the named image ran it, last');
  assert.equal(a.entries.at(-1).record.op, 'toLinear');
  assert.equal(a.entries.length, b.entries.length + 1, 'the other ran the script alone');
});

test('an --extra file that is not lists of commands is refused before anything runs', () => {
  const extra = path.join(tmp, 'bad-extra.json');
  fs.writeFileSync(extra, JSON.stringify({ square: 'X = gaussian(A)' }));
  const { code, out: text } = run(['--script', pipeline, '--extra', extra, image]);
  assert.equal(code, 2, text);
  assert.match(text, /"square" is not a list of commands/);
});

/* --- ground truth --------------------------------------------------- */

/*
 * The fixture is a white square from 25 to 71 inside a black 96x96 frame, so
 * its four edges and four corners are known exactly rather than measured. The
 * boundary falls between the last black pixel and the first white one, which
 * puts it at 24.5 and 71.5.
 *
 * Written by hand rather than rendered: this suite tests the RUNNER, and
 * pulling in a GPU path tracer to produce a fixture whose answer is already
 * arithmetic would be a slower way to learn less.
 */
const truthDir = path.join(tmp, 'truth');
fs.mkdirSync(truthDir, { recursive: true });
{
  const lo = 24.5;
  const hi = 71.5;
  const corner = (id, x, y) => ({
    id, x, y, z: 1, degree: 2, visibleDegree: 2,
    onFrame: true, visible: true, angle: 90, objects: ['Square'],
  });
  const edge = (id, x0, y0, x1, y1) => ({
    id, cause: 'silhouette', objects: ['Square'],
    x0, y0, x1, y1, z0: 1, z1: 1,
    length: Math.hypot(x1 - x0, y1 - y0),
    angle: ((Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI) % 180 + 180) % 180,
    dihedral: 90, visible: 1, clipped: false, v0: 0, v1: 0,
  });
  fs.writeFileSync(path.join(truthDir, 'square.gt.json'), JSON.stringify({
    size: 96,
    edges: [
      edge(1, lo, lo, hi, lo), edge(2, hi, lo, hi, hi),
      edge(3, hi, hi, lo, hi), edge(4, lo, hi, lo, lo),
    ],
    vertices: [corner(1, lo, lo), corner(2, hi, lo), corner(3, hi, hi), corner(4, lo, hi)],
  }));
}

const scored = writeScript('scored.lab', [
  'L  = toLinear(A)',
  'G  = gray(L)',
  'B  = gaussian(G, sigma=1.4)',
  'Gx = sobel(B, axis=x)',
  'Gy = sobel(B, axis=y)',
  'M  = sobel(B, axis=mag)',
  'N  = nms(M, Gx, Gy)',
  'S  = segments(N, Gx, Gy)',
  'R  = merge(S)',
  'F  = fit(R)',
  'C  = corners(F)',
  'MF = match(F, T)',
  'MC = match(C, T)',
]);
const scoredOut = path.join(tmp, 'scored');
const scoredRun = run(['--script', scored, '--image', image, '--truth', truthDir,
                       '--out', scoredOut]);

test('--truth prepends a ground-truth load, so a script can score itself', () => {
  assert.equal(scoredRun.code, 0, scoredRun.out);
  const session = JSON.parse(fs.readFileSync(path.join(scoredOut, 'square.session.json'), 'utf8'));
  // load, groundTruth, and one per line of the script.
  assert.equal(session.entries.length, 15);
  const entry = session.entries[1];
  // The log holds the RESOLVED record, not the line that was typed — defaults
  // filled in and parameters in canonical order (§3). So `kind=both` is there
  // even though nobody wrote it, and the slot lives beside the text.
  assert.equal(entry.target, 'T');
  assert.match(entry.text, /^groundTruth\(kind=both, path=/, entry.text);
  assert.match(entry.text, /square\.gt\.json/);
});

test('the square\'s four corners are all found, and located', () => {
  /*
   * Not plumbing. The fixture has four right angles in known places, so this
   * asserts the pipeline finds every one of them and puts them where they
   * actually are -- which is the whole claim ground truth exists to check.
   */
  const lists = JSON.parse(fs.readFileSync(path.join(scoredOut, 'square.features.json'), 'utf8'));
  const matches = lists.find((l) => l.slot === 'MC').features;
  const hits = matches.filter((r) => r.role === 'hit');
  assert.equal(hits.length, 4, `expected all four corners found, got ${hits.length}`);
  assert.equal(matches.filter((r) => r.role === 'miss').length, 0);
  for (const hit of hits) {
    assert.ok(hit.distance <= 3, `corner ${hit.detected} landed ${hit.distance} px out`);
  }
});

test('every edge of the square is matched to real geometry', () => {
  const lists = JSON.parse(fs.readFileSync(path.join(scoredOut, 'square.features.json'), 'utf8'));
  const matches = lists.find((l) => l.slot === 'MF').features;
  assert.equal(matches.filter((r) => r.role === 'miss').length, 0,
    'all four sides should be found');
  for (const hit of matches.filter((r) => r.role === 'hit')) {
    assert.equal(hit.cause, 'silhouette');
  }
});

test('a missing ground-truth file fails that image and says which', () => {
  // One image without truth must not take the whole run down silently.
  const { code, out: text } = run(['--script', scored, '--image', image,
                                   '--truth', path.join(tmp, 'absent'), '--out',
                                   path.join(tmp, 'no-truth')]);
  assert.equal(code, 1, 'a pipeline that cannot load its truth should exit 1');
  assert.match(text, /FAIL\s+square/);
  assert.match(text, /square\.gt\.json/, 'the missing file should be named');
});

/* ------------------------------------------------------------------- */

test('every script under scripts/ is syntactically valid', () => {
  /*
   * generate-cli.js needs Electron to RUN, so no suite invokes it and a syntax
   * error in it survives the whole suite and all three CI jobs -- which is how
   * the same mistake landed three times: a backtick written inside the USAGE
   * template literal, which ends the literal and turns the rest of the help
   * text into code. Parsing needs neither Electron nor a GPU, so the guard
   * costs nothing and covers every entry point rather than the two that
   * happen to be runnable here.
   *
   * vm.Script compiles without executing: no require runs, no window opens.
   */
  const vm = require('node:vm');
  const dir = path.join(ROOT, 'scripts');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  assert.ok(files.length > 5, `only found ${files.length} scripts -- wrong directory?`);

  for (const file of files) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    try {
      new vm.Script(src, { filename: file });
    } catch (err) {
      assert.fail(`scripts/${file} does not parse: ${err.message}`);
    }
  }
});

test('every suite under test/ is syntactically valid', () => {
  /*
   * The same guard, for the same reason, one directory over -- and it has now
   * been paid for twice.
   *
   * test/renderer.js hands a large block of page script to executeJavaScript
   * as a TEMPLATE LITERAL, so a backtick anywhere inside it ends the literal
   * and turns the rest of the file into something that does not parse. Written
   * in a COMMENT inside that block, around a colormap name, it looks entirely
   * harmless. Electron then reports it as an "Uncaught Exception" DIALOG from
   * the main process, which no runner reads and which hangs the suite waiting
   * for someone to click OK -- rather than as a failing test.
   *
   * Parsing needs no Electron and no display, so this is the cheap version of
   * that discovery.
   */
  const vm = require('node:vm');
  const dir = __dirname;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  assert.ok(files.length > 10, `only found ${files.length} suites -- wrong directory?`);

  for (const file of files) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    try {
      new vm.Script(src, { filename: file });
    } catch (err) {
      assert.fail(`test/${file} does not parse: ${err.message}`);
    }
  }
});

/* ---- npm run degrade ------------------------------------------------ */

/*
 * scripts/degrade.js run as a person would, on a two-file "generated run" it
 * can recognise: shots.json, one image, its truth and an AOV pass.
 */
{
  const { encodePNG, decodePNG } = require('../scripts/png');
  const DEGRADE = path.join(ROOT, 'scripts', 'degrade.js');
  const toLinear = (u) => { const v = u / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const run = (src, dst, ...args) => spawnSync(process.execPath, [DEGRADE, src, dst, ...args], { encoding: 'utf8' });
  /** A w x w run whose red channel is `value(x, y)` (0-255), with a truth edge and a depth pass. */
  const makeRun = (dir, w, value) => {
    fs.mkdirSync(path.join(dir, 'aov'), { recursive: true });
    const px = Buffer.alloc(w * w * 4);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
      const v = value(x, y);
      px.set([v, v, v, 255], (y * w + x) * 4);
    }
    fs.writeFileSync(path.join(dir, 'a.png'), encodePNG(w, w, px));
    fs.writeFileSync(path.join(dir, 'aov', 'a-depth.png'), encodePNG(w, w, px));
    fs.writeFileSync(path.join(dir, 'shots.json'), '[]\n');
    fs.writeFileSync(path.join(dir, 'a.gt.json'), JSON.stringify({ size: w,
      edges: [{ id: 1, x0: 2, y0: 4, x1: 10, y1: 12, length: Math.hypot(8, 8) }], vertices: [{ id: 1, x: 6, y: 8 }] }));
  };

  test('degrade --downsample 2 is the 2x2 mean in linear light, with the truth and the passes made to match', () => {
    const src = path.join(tmp, 'deg-src'), dst = path.join(tmp, 'deg-ds');
    const value = (x, y) => (x * 37 + y * 11) % 256;
    makeRun(src, 16, value);
    const r = run(src, dst, '--downsample', '2');
    assert.equal(r.status, 0, r.stderr);
    const out = decodePNG(fs.readFileSync(path.join(dst, 'a.png')));
    assert.equal(out.width, 8);
    for (const [x, y] of [[0, 0], [3, 5], [7, 7]]) {
      const mean = [0, 1].flatMap((j) => [0, 1].map((i) => toLinear(value(2 * x + i, 2 * y + j)))).reduce((a, b) => a + b) / 4;
      assert.ok(Math.abs(toLinear(out.data[(y * 8 + x) * out.channels]) - mean) < 0.004, `pixel ${x},${y}`);
    }
    const truth = JSON.parse(fs.readFileSync(path.join(dst, 'a.gt.json'), 'utf8'));
    assert.equal(truth.size, 8);
    assert.deepEqual([truth.edges[0].x0, truth.edges[0].y1, truth.vertices[0].x], [1, 6, 3]);
    // A depth pass is packed fixed-point and is sampled, not averaged.
    const depth = decodePNG(fs.readFileSync(path.join(dst, 'aov', 'a-depth.png')));
    assert.equal(depth.width, 8);
    assert.equal(depth.data[(3 * 8 + 2) * depth.channels], value(5, 7));
  });

  test('degrade --scurve leaves black, mid-grey and white and steepens the middle, monotonically', () => {
    const src = path.join(tmp, 'deg-s'), dst = path.join(tmp, 'deg-s3');
    makeRun(src, 16, (x, y) => (y * 16 + x));
    const r = run(src, dst, '--scurve', '3');
    assert.equal(r.status, 0, r.stderr);
    const a = decodePNG(fs.readFileSync(path.join(src, 'a.png'))), b = decodePNG(fs.readFileSync(path.join(dst, 'a.png')));
    const at = (img, v) => img.data[v * img.channels];
    for (const v of [0, 255]) assert.equal(at(b, v), v);
    assert.ok(Math.abs(at(b, 128) - 128) <= 1, `mid-grey ${at(b, 128)}`);
    for (let v = 1; v < 256; v++) assert.ok(at(b, v) >= at(b, v - 1), `monotonic at ${v}`);
    // Steeper in the middle by about 3 / (2 tanh 1.5) = 1.66, flatter near the ends.
    const slope = (img, v) => (at(img, v + 8) - at(img, v - 8)) / 16;
    assert.ok(Math.abs(slope(b, 128) - 1.66) < 0.1, `middle slope ${slope(b, 128)}`);
    assert.ok(slope(b, 20) < 0.6, `end slope ${slope(b, 20)}`);
    assert.equal(at(a, 77), 77);
  });

  test('npm run response recovers degrade --scurve from a degrade --exposure bracket, up to scale', () => {
    // A ramp of lights over two and a half decades, bracketed two stops
    // either side; the curve that made the codes is the one to come back.
    const src = path.join(tmp, 'resp-src'), w = 64, k = 3;
    makeRun(src, w, (x, y) => Math.round(255 * (0.02 * 40 ** ((y * w + x) / (w * w - 1))) ** (1 / 2.2)));
    const shots = [0.25, 0.5, 1, 2, 4].map((t) => {
      const dst = path.join(tmp, `resp-${t}`);
      const r = run(src, dst, '--exposure', String(t), '--scurve', String(k));
      assert.equal(r.status, 0, r.stderr);
      return `${path.join(dst, 'a.png')}@${t}`;
    });
    const out = path.join(tmp, 'curve.json');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'response.js'), '--out', out, ...shots], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const { linear, shots: recorded } = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(recorded.length, 5);
    assert.equal(linear[255], 1);
    assert.equal(linear[0], 0, 'code 0 is black');
    for (let z = 1; z < 256; z++) assert.ok(linear[z] >= linear[z - 1], `non-decreasing at ${z}`);
    const toLin = (e) => (e <= 0.04045 ? e / 12.92 : ((e + 0.055) / 1.055) ** 2.4);
    const truth = (z) => toLin(0.5 + Math.atanh((2 * z / 255 - 1) * Math.tanh(k / 2)) / k);
    // Scale is not measurable; compare log ratios about their mean, over the
    // codes the bracket reaches well.
    const codes = [];
    for (let z = 16; z < 240; z++) codes.push(z);
    const lr = codes.map((z) => Math.log(linear[z] / truth(z)));
    const mean = lr.reduce((a, b) => a + b) / lr.length;
    for (let i = 0; i < codes.length; i++) assert.ok(Math.abs(lr[i] - mean) < 0.03, `code ${codes[i]}: ${(lr[i] - mean).toFixed(4)}`);
    // A bracket of fewer than three is refused, not fitted.
    const two = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'response.js'), '--out', out, ...shots.slice(0, 2)], { encoding: 'utf8' });
    assert.equal(two.status, 2);
    assert.match(two.stderr, /three shots or more/);
  });

  test('degrade --interp cubic carries a ramp through a distortion as a ramp; the pixels move, they do not blur', () => {
    const src = path.join(tmp, 'deg-ramp'), dst = path.join(tmp, 'deg-ramp-k');
    const w = 64, ramp = (x) => 0.1 + 0.6 * (x / (w - 1));
    // Written in sRGB so that it is a straight line in linear light.
    const toSrgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
    makeRun(src, w, (x) => Math.round(toSrgb(ramp(x)) * 255));
    const r = run(src, dst, '--k1', '-0.05', '--interp', 'cubic');
    assert.equal(r.status, 0, r.stderr);
    const out = decodePNG(fs.readFileSync(path.join(dst, 'a.png')));
    const c = (w - 1) / 2, s = w / 2;
    for (const [x, y] of [[10, 10], [40, 20], [50, 50]]) {
      const nx = (x - c) / s, ny = (y - c) / s, sx = c + nx * (1 + -0.05 * (nx * nx + ny * ny)) * s;
      assert.ok(Math.abs(toLinear(out.data[(y * w + x) * out.channels]) - ramp(sx)) < 0.006, `pixel ${x},${y}`);
    }
  });
}

/* --- npm run bench ----------------------------------------------------- */

test('bench times a float frame on both Node backends, and they agree', () => {
  const w = 96, data = new Float32Array(w * w * 3);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const inside = x > 30.4 && x < 70.2 && y > 25.7 && y < 66.1;
    for (let c = 0; c < 3; c++) data[(y * w + x) * 3 + c] = inside ? 0.8 : 0.05;
  }
  const frame = path.join(tmp, 'square.pfm');
  // PFM by hand -- little-endian, rows bottom-up, which this square does not mind.
  fs.writeFileSync(frame, Buffer.concat([Buffer.from(`PF\n${w} ${w}\n-1.0\n`), Buffer.from(data.buffer)]));
  const json = path.join(tmp, 'bench.json');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'bench.js'), frame, '--reps', '1', '--out', json],
    { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /the same hashes on every backend/);
  const runs = JSON.parse(fs.readFileSync(json, 'utf8')).runs;
  assert.deepEqual(runs.map((x) => x.name.split(' ')[0]), ['native', 'wasm']);
  assert.ok(runs.every((x) => x.results[0].totals.length === 1 && x.results[0].totals[0] > 0));
});

/* ------------------------------------------------------------------- */

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll batch runner tests passed.' : `\n${failures} failing.`);
process.exit(failures === 0 ? 0 : 1);
