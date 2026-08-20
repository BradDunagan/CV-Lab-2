'use strict';

/**
 * Renderer tests — the parts no other suite can reach.
 *
 * Everything else runs under plain node. These need a real Electron renderer,
 * because two things only exist there:
 *
 *   - Chromium's image decoder, which is what `load` borrows
 *   - the DOM, and therefore the whole UI
 *
 * Run with `npx electron test/renderer.js` — NOT with ELECTRON_RUN_AS_NODE,
 * which gives Node globals but no DOM.
 *
 *   npm run test:renderer
 */

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { encodePNG } = require('../scripts/png');

const ROOT = path.join(__dirname, '..');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

/** A 2x2 image whose exact pixels we can assert on after decoding. */
function writeSwatch() {
  const colours = [
    [255, 0, 0], [0, 255, 0],
    [0, 0, 255], [128, 128, 128],
  ];
  const rgba = Buffer.alloc(2 * 2 * 4);
  colours.forEach((c, i) => {
    rgba[i * 4 + 0] = c[0];
    rgba[i * 4 + 1] = c[1];
    rgba[i * 4 + 2] = c[2];
    rgba[i * 4 + 3] = 255;
  });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cvlab-')), 'swatch.png');
  fs.writeFileSync(file, encodePNG(2, 2, rgba));
  return file;
}

async function collect(win, swatch) {
  // Everything the page can tell us, gathered in one round trip. Assertions
  // happen out here, where failures report properly.
  return win.webContents.executeJavaScript(`(async () => {
    const r = {};
    const swatch = ${JSON.stringify(swatch)};

    // Drive the real UI rather than calling lab.run() directly: clicking Run
    // is what refreshes the tiles, and a test that skips it would not be
    // testing the interface at all.
    const bar = document.getElementById('command');
    const runButton = document.getElementById('run');
    const status = document.getElementById('status');

    const ui = async (command) => {
      bar.value = command;
      runButton.click();
      await new Promise(res => setTimeout(res, 0));
      let guard = 0;
      while (runButton.disabled && guard++ < 2000) await new Promise(res => setTimeout(res, 5));
      await new Promise(res => setTimeout(res, 10));   // let the tiles redraw
      return status.textContent;
    };
    const hashOf = (slot) => {
      const entries = window.lab.log().filter(e => e.produced && e.produced.slot === slot);
      return entries.length ? entries[entries.length - 1].output.hash : null;
    };

    r.quotedPath = window.lab.quote(swatch);
    r.swatchPath = swatch;
    r.bridge = Object.keys(window.lab).sort();
    r.nodeLeaked = typeof window.require !== 'undefined' || typeof window.process !== 'undefined';
    r.loadImplemented = window.lab.ops().find(o => o.name === 'load').implemented;

    // --- load, through Chromium's decoder ---
    await ui('S = load(' + window.lab.quote(swatch) + ')');
    const loaded = window.lab.log()[0];
    r.loadText = loaded.text;
    r.loadShape = [loaded.output.width, loaded.output.height, loaded.output.channels,
                   loaded.output.dtype, loaded.output.space];
    r.srgb = {
      red:   window.lab.probeAll(0.0, 0.0).S.values,
      green: window.lab.probeAll(0.9, 0.0).S.values,
      blue:  window.lab.probeAll(0.0, 0.9).S.values,
      grey:  window.lab.probeAll(0.9, 0.9).S.values,
    };

    await ui('L = load(' + window.lab.quote(swatch) + ', as=linear)');
    r.linearSpace = window.lab.log()[1].output.space;
    r.linearGrey = window.lab.probeAll(0.9, 0.9).L.values[0];
    r.linearRed = window.lab.probeAll(0.0, 0.0).L.values;

    // --- declared colour space is enforced ---
    r.grayOnSrgb = await ui('BAD = gray(S)');
    r.statusAfterRefusal = status.className;
    r.logAfterRefusal = window.lab.log().length;

    await ui('G = gray(L)');
    const grayEntry = window.lab.log()[window.lab.log().length - 1];
    r.grayShape = [grayEntry.output.channels, grayEntry.output.space];
    r.grayRed = window.lab.probeAll(0.0, 0.0).G.values[0];

    // --- an explicit conversion reaches the same place ---
    await ui('C = toLinear(S)');
    await ui('G2 = gray(C)');
    r.convertedMatches = hashOf('G2') === hashOf('G');

    // --- the rest of the lab ---
    await ui('P = pattern(kind=checker, width=256, height=256)');
    await ui('B = gaussian(P, sigma=2)');
    await ui('E = sobel(B, axis=x)');
    await ui('M = threshold(E, t=0.02)');

    r.tiles = [...document.querySelectorAll('.tile')].map(t => t.dataset.slot);
    r.drawn = {};
    for (const c of document.querySelectorAll('.tile canvas')) {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4 * 617) if (d[i] || d[i+1] || d[i+2]) lit++;
      r.drawn[c.id.replace('tile-canvas-', '')] = lit > 0;
    }
    const scaleOf = (slot) => {
      const el = document.querySelector('.tile[data-slot="' + slot + '"] .scale');
      return el ? el.textContent : '(no tile)';
    };
    r.scaleE = scaleOf('E');
    r.scaleM = scaleOf('M');
    r.scaleP = scaleOf('P');

    // --- shared pan and zoom ---
    const cv = document.querySelector('.tile canvas');
    const box = cv.getBoundingClientRect();
    cv.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true,
      clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }));
    await new Promise(res => setTimeout(res, 50));
    r.zooms = [...document.querySelectorAll('.tile .zoom')].map(z => z.textContent);

    // --- histogram view ---
    const sel = document.querySelector('.tile[data-slot="P"] select');
    sel.value = 'histogram';
    sel.dispatchEvent(new Event('change'));
    await new Promise(res => setTimeout(res, 50));
    r.histogram = scaleOf('P');

    r.sessionEntries = window.lab.sessionJSON().entries.length;
    return r;
  })()`);
}

app.whenReady().then(async () => {
  const runtime = `electron ${process.versions.electron}`;
  console.log(`cv-lab-2 renderer tests (${runtime}, ${process.platform}/${process.arch})`);

  const swatch = writeSwatch();
  const win = new BrowserWindow({
    show: false,
    width: 1320,
    height: 900,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });
  win.webContents.on('preload-error', (_e, file, err) => {
    consoleErrors.push(`preload ${file}: ${err.message}`);
  });

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  const r = await collect(win, swatch);

  const close = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol;

  /* --- the bridge --------------------------------------------------- */

  test('the bridge exposes only the lab API', () => {
    assert.deepEqual(r.bridge, ['basename', 'draw', 'histogram', 'log', 'openImage',
      'ops', 'probeAll', 'quote', 'run', 'saveSession', 'sessionJSON', 'slots', 'versions']);
  });

  test('no Node globals leak into page script', () => {
    assert.equal(r.nodeLeaked, false);
  });

  /* --- load, which only works here ---------------------------------- */

  test('load is implemented once a decoder is injected', () => {
    assert.equal(r.loadImplemented, true);
  });

  test('a path with separators survives the command language', () => {
    // On Windows every backslash would otherwise be eaten as an escape, and
    // C:\\Users\\… would reach load() as C:Users…. Caught by CI, not by
    // reasoning: this passes trivially on macOS and Linux.
    const recorded = r.loadText.match(/path=(.*)\)$/)[1];
    assert.equal(recorded, r.swatchPath, 'the decoded path is not what was asked for');
  });

  test('load decodes to a 3-channel f32 buffer tagged srgb', () => {
    assert.deepEqual(r.loadShape, [2, 2, 3, 'f32', 'srgb']);
    assert.match(r.loadText, /^load\(as=srgb, path=/);
  });

  test('decoded values are exact', () => {
    assert.deepEqual(r.srgb.red, [1, 0, 0]);
    assert.deepEqual(r.srgb.green, [0, 1, 0]);
    assert.deepEqual(r.srgb.blue, [0, 0, 1]);
    assert.ok(close(r.srgb.grey[0], 128 / 255), `grey ${r.srgb.grey[0]}`);
  });

  test('as=linear applies the sRGB transfer function on decode', () => {
    const expected = Math.pow((128 / 255 + 0.055) / 1.055, 2.4);
    assert.equal(r.linearSpace, 'linear');
    assert.ok(close(r.linearGrey, expected), `${r.linearGrey} vs ${expected}`);
    assert.deepEqual(r.linearRed, [1, 0, 0], 'endpoints stay exact');
  });

  /* --- declared colour space is enforced ---------------------------- */

  test('gray refuses an srgb input and names the fix', () => {
    assert.ok(r.grayOnSrgb, 'gray accepted sRGB input');
    assert.match(r.grayOnSrgb, /needs linear input, but S#1 is srgb/);
    assert.match(r.grayOnSrgb, /toLinear\(S\)/);
  });

  test('a refused command appends nothing to the log', () => {
    assert.equal(r.logAfterRefusal, 2, 'only the two loads should be recorded');
  });

  test('gray on linear input produces 1-channel linear', () => {
    assert.deepEqual(r.grayShape, [1, 'linear']);
    assert.ok(close(r.grayRed, 0.2126), `Rec.709 red coefficient, got ${r.grayRed}`);
  });

  test('converting explicitly gives the same result as loading as linear', () => {
    // gray(toLinear(load srgb)) must equal gray(load as=linear), bit for bit.
    assert.equal(r.convertedMatches, true, 'hashes differ');
  });

  /* --- the UI ------------------------------------------------------- */

  test('every command produces a tile, and every tile draws', () => {
    assert.deepEqual(r.tiles, ['S', 'L', 'G', 'C', 'G2', 'P', 'B', 'E', 'M']);
    for (const [slot, drew] of Object.entries(r.drawn)) {
      assert.ok(drew, `tile ${slot} rendered blank`);
    }
  });

  test('display defaults follow the data kind', () => {
    assert.match(r.scaleE, /diverging/, 'a signed gradient should default to diverging');
    assert.match(r.scaleM, /categorical/, 'a label map should default to categorical');
    assert.match(r.scaleP, /gray/, 'plain intensity should default to gray');
  });

  test('zoom is shared across every tile', () => {
    assert.equal(new Set(r.zooms).size, 1, `tiles disagree: ${r.zooms.join(', ')}`);
    assert.notEqual(r.zooms[0], '1.0×', 'the wheel event had no effect');
  });

  test('the histogram view renders', () => {
    assert.equal(r.histogram, 'histogram');
  });

  test('a bad command reports an error without throwing into the page', () => {
    assert.equal(r.statusAfterRefusal, 'error');
  });

  test('the session is complete and saveable', () => {
    assert.equal(r.sessionEntries, r.tiles.length, 'one entry per slot produced');
  });

  test('the page logged no errors', () => {
    assert.deepEqual(consoleErrors, []);
  });

  console.log(failures === 0 ? '\nAll renderer tests passed.' : `\n${failures} failing.`);
  app.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error('renderer tests could not start:\n' + err.stack);
  app.exit(1);
});
