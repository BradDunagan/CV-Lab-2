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

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { encodePNG } = require('../scripts/png');
const zlibCrc = require('node:zlib');
const { parseStatement } = require('../src/lab/parser');

const ROOT = path.join(__dirname, '..');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

/** Build a PNG that declares gAMA 1.0, i.e. linear samples. */
function writeLinearDeclaringPng(dir) {
  const CRC = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const data = Buffer.alloc(4);
  data.writeUInt32BE(100000);
  const gAMA = Buffer.alloc(16);
  gAMA.writeUInt32BE(4, 0);
  gAMA.write('gAMA', 4, 'ascii');
  data.copy(gAMA, 8);
  gAMA.writeUInt32BE(crc32(gAMA.subarray(4, 12)), 12);

  const base = encodePNG(1, 1, Buffer.from([128, 128, 128, 255]));
  const file = path.join(dir, 'linear.png');
  fs.writeFileSync(file, Buffer.concat([base.subarray(0, 33), gAMA, base.subarray(33)]));
  return file;
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

async function collect(win, swatch, linearPng) {
  // Everything the page can tell us, gathered in one round trip. Assertions
  // happen out here, where failures report properly.
  return win.webContents.executeJavaScript(`(async () => {
    const r = {};
    const swatch = ${JSON.stringify(swatch)};
    const linearPng = ${JSON.stringify(linearPng)};

    /*
     * Drive the real UI rather than calling lab.run() directly. Since the
     * paneless port that means a Svelte-bound input: assigning .value is not
     * enough on its own, because the binding reads the element on an 'input'
     * event and would otherwise never see the change.
     */
    const bar = () => document.getElementById('command');
    const runButton = () => document.getElementById('run');
    const status = () => document.getElementById('status');
    // Svelte appends a scoping class, so the element's className is
    // "error svelte-1la1gos" rather than "error". Ask the classList.
    const statusKind = () =>
      status().classList.contains('error') ? 'error'
      : status().classList.contains('ok') ? 'ok' : '';
    const sleep = (ms) => new Promise(res => setTimeout(res, ms));

    const ui = async (command) => {
      const el = bar();
      el.value = command;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      runButton().click();
      await sleep(0);
      let guard = 0;
      while (runButton().disabled && guard++ < 2000) await sleep(5);
      await sleep(20);   // let the panes redraw
      return status().textContent;
    };
    const hashOf = (slot) => {
      const entries = window.lab.log().filter(e => e.produced && e.produced.slot === slot);
      return entries.length ? entries[entries.length - 1].output.hash : null;
    };

    /*
     * Panes are user-arranged now, so a test that wants to look at a
     * particular slot has to ask for a pane showing it. __cvlab is the page's
     * own test surface -- not the contextBridge, which stays exactly as narrow
     * as it was.
     */
    const lab2 = () => window.__cvlab;
    const showSlot = async (name) => {
      const ids = lab2().slotPaneIds();
      const already = ids.find(id => lab2().paneStore.getPane(id)?.name === name);
      if (already) { await sleep(30); return already; }
      const free = ids.find(id => !lab2().paneStore.getPane(id)?.name);
      const id = free ?? lab2().newSlotPane(null);
      lab2().bindSlotPane(id, name);
      await sleep(60);
      return id;
    };
    const paneFor = (name) => document.querySelector('.slot-pane[data-slot="' + name + '"]');
    const canvasFor = (name) => paneFor(name)?.querySelector('canvas');
    const readoutFor = (name) => paneFor(name)?.querySelector('.readout')?.textContent ?? '(no pane)';
    const zoomFor = (name) => parseFloat(paneFor(name)?.querySelector('.zoom')?.textContent ?? 'NaN');
    const menuItem = (id) => lab2().appMenu().find(i => i.id === id);
    const ink = (c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] * 3 + d[i + 2] * 7;
      return sum;
    };

    r.quotedPath = window.lab.quote(swatch);
    r.swatchPath = swatch;
    r.bridge = Object.keys(window.lab).sort();
    r.nodeLeaked = typeof window.require !== 'undefined' || typeof window.process !== 'undefined';
    r.loadImplemented = window.lab.ops().find(o => o.name === 'load').implemented;

    // The layout the app opens with.
    r.initialPanes = {
      slot: lab2().slotPaneIds().length,
      command: !!bar(),
      log: !!document.querySelector('.log-pane'),
    };

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

    // --- a file that declares linear samples ---
    r.linearDeclared = await ui('D = load(' + window.lab.quote(linearPng) + ')');
    r.linearRefused = statusKind() === 'error';
    r.linearAccepted = (await ui(
      'D = load(' + window.lab.quote(linearPng) + ', from=linear)')).startsWith('#');

    // --- declared colour space is enforced ---
    r.grayOnSrgb = await ui('BAD = gray(S)');
    r.statusAfterRefusal = statusKind();
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
    await ui('W = pattern(kind=ramp, width=320, height=80)');
    await ui('B = gaussian(P, sigma=2)');
    await ui('E = sobel(B, axis=x)');
    await ui('M = threshold(E, t=0.02)');

    // --- a new slot fills a pane by itself, up to the limit ---
    r.autoBound = lab2().slotPaneIds()
      .map(id => lab2().paneStore.getPane(id)?.name)
      .filter(Boolean);

    // Aspect ratio: the canvas must match the buffer, or the image is stretched.
    r.aspects = {};
    for (const name of ['P', 'W', 'S']) {
      await showSlot(name);
      const info = window.lab.slots().find(s => s.name === name);
      const c = canvasFor(name);
      r.aspects[name] = { source: info.width / info.height, canvas: c.width / c.height };
    }

    // --- every pane actually draws ---
    r.drawn = {};
    for (const name of ['P', 'W', 'S', 'E', 'M']) {
      await showSlot(name);
      const c = canvasFor(name);
      r.drawn[name] = c ? ink(c) > 0 : false;
    }

    // --- display defaults follow the data kind ---
    await showSlot('E'); r.readoutE = readoutFor('E');
    await showSlot('M'); r.readoutM = readoutFor('M');
    await showSlot('P'); r.readoutP = readoutFor('P');

    // --- shared pan and zoom ---
    // The readout is screen-pixels-per-image-pixel, which differs per slot
    // because slots differ in size. What must be shared is the FACTOR by which
    // one wheel event changes them.
    const watched = ['P', 'W', 'E'];
    for (const name of watched) await showSlot(name);
    const readZooms = () => Object.fromEntries(watched.map(n => [n, zoomFor(n)]));
    r.zoomBefore = readZooms();
    const cv = canvasFor('P');
    const box = cv.getBoundingClientRect();
    cv.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true,
      clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }));
    await sleep(60);
    r.zoomAfter = readZooms();

    /*
     * The toolbar. Every control here is also in the app menu, but the menu
     * opens by clicking the title text -- so a control that exists ONLY there
     * is a control nobody finds. That is not hypothetical: it shipped that way
     * for one commit. These assertions are about being reachable, not about
     * existing.
     */
    const visible = (el) => {
      if (!el) return false;
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    r.toolbar = {
      scaling: visible(document.getElementById('scaling')),
      overlay: visible(document.getElementById('overlay')),
      resetView: visible(document.getElementById('reset-view')),
      discard: visible(document.getElementById('reset')),
      run: visible(document.getElementById('run')),
      command: visible(document.getElementById('command')),
    };
    // and the menu still carries them, for when the command pane is closed
    r.menuAlsoHas = ['reset-view', 'overlay', 'scaling', 'save-session', 'reset-session']
      .every((id) => !!menuItem(id));

    // --- reset view, through the toolbar button ---
    const resetViewButton = () => document.getElementById('reset-view');
    r.resetEnabledWhenZoomed = !resetViewButton().disabled;
    resetViewButton().click();
    await sleep(60);
    r.resetDisabledAfterwards = resetViewButton().disabled;
    r.zoomAfterReset = readZooms();

    // --- scaling modes ---
    const setScaling = async (mode) => {
      const sel = document.getElementById('scaling');
      sel.value = mode;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(90);
    };
    await ui('T = pattern(kind=checker, width=64, height=64)');
    await showSlot('T');
    const sizeOf = (name) => { const c = canvasFor(name); return [c.width, c.height]; };
    await setScaling('smooth'); r.sizeSmooth = sizeOf('T'); r.zoomSmooth = zoomFor('T');
    await setScaling('actual'); r.sizeActual = sizeOf('T'); r.zoomActual = zoomFor('T');
    await setScaling('smooth');

    // --- histogram view, through the pane's own control ---
    await showSlot('P');
    const typeSelect = paneFor('P').querySelector('select[title="view"]');
    typeSelect.value = 'histogram';
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(80);
    r.histogram = readoutFor('P');
    typeSelect.value = 'image';
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(60);

    // --- the features output kind ---
    await ui('PB = gaussian(P, sigma=1.2)');
    await ui('PGx = sobel(PB, axis=x)');
    await ui('PGy = sobel(PB, axis=y)');
    await ui('PM = sobel(PB, axis=mag)');
    await ui('PN = nms(PM, PGx, PGy)');
    await ui('PS = segments(PN, PGx, PGy, minPixels=5)');
    await ui('PR = merge(PS)');
    const fitEntry = await ui('PF = fit(PR)');
    r.fitStatus = fitEntry;
    await ui('PC = corners(PF)');
    const featureLists = window.lab.features();
    r.featureSlots = featureLists.map((f) => f.slot);
    r.featureCount = featureLists[0] ? featureLists[0].features.length : 0;
    r.featureSample = featureLists[0] ? featureLists[0].features[0] : null;
    r.featureSlotSummary = window.lab.slots().find((s) => s.name === 'PF');
    r.probeSkipsFeatures = !('PF' in window.lab.probeAll(0.5, 0.5));
    r.featureTypes = Object.fromEntries(
      window.lab.slots().filter((s) => s.kind === 'features').map((s) => [s.name, s.types]));

    // A feature list is not offered as something a slot pane can show, because
    // it has no pixels and belongs drawn OVER the image it describes.
    r.slotPaneOffersOnlyBuffers = lab2().paneMenu(lab2().slotPaneIds()[0])
      .find(i => i.id === 'slot').items.every(i => !i.label.includes('PF'));

    // Does the overlay actually draw? Compare a tile with it on and off.
    await showSlot('PB');
    const snapshot = () => ink(canvasFor('PB'));
    const overlayBox = () => document.getElementById('overlay');
    const toggleOverlay = async () => {
      overlayBox().click();
      await sleep(80);
    };
    await toggleOverlay();                 // off
    r.withoutOverlay = snapshot();
    await toggleOverlay();                 // on again
    r.withOverlay = snapshot();

    try { window.lab.draw(canvasFor('PB').id, 'PF', {}); r.drawOnFeatures = 'accepted'; }
    catch (e) { r.drawOnFeatures = e.message; }

    r.sessionEntries = window.lab.sessionJSON().entries.length;
    r.slotsAtEnd = window.lab.slots().length;

    // --- reset, driven through the app menu ---
    r.beforeReset = {
      slots: window.lab.slots().length,
      boundPanes: lab2().slotPaneIds().filter(id => lab2().paneStore.getPane(id)?.name).length,
    };
    document.getElementById('reset').click();
    await sleep(250);
    r.afterReset = {
      slots: window.lab.slots().length,
      boundPanes: lab2().slotPaneIds().filter(id => lab2().paneStore.getPane(id)?.name).length,
      logLines: document.querySelectorAll('.log-pane .line').length,
    };

    // and the lab still works afterwards
    await ui('A = pattern(kind=ramp, width=32, height=32)');
    r.afterResetEntry = window.lab.log().length;
    r.afterResetShown = !!canvasFor('A');
    return r;
  })()`);
}

app.whenReady().then(async () => {
  const runtime = `electron ${process.versions.electron}`;
  console.log(`cv-lab-2 renderer tests (${runtime}, ${process.platform}/${process.arch})`);

  const swatch = writeSwatch();
  const linearPng = writeLinearDeclaringPng(path.dirname(swatch));

  /*
   * This harness runs its own main process, so src/main.js's IPC handlers are
   * absent. Reset's confirmation is a native modal that would block forever
   * with nobody to click it, so it is stubbed to answer "discard". The real
   * dialog lives in src/main.js and is the one thing here that cannot be
   * exercised headlessly.
   */
  ipcMain.handle('session:confirmReset', () => 'discard');

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

  await win.loadFile(path.join(ROOT, 'dist-renderer', 'index.html'));
  const r = await collect(win, swatch, linearPng);

  const close = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol;

  /* --- the bridge --------------------------------------------------- */

  test('the bridge exposes only the lab API', () => {
    assert.deepEqual(r.bridge, ['basename', 'confirmReset', 'draw', 'features',
      'histogram', 'log', 'openImage', 'ops', 'probeAll', 'quote', 'reset', 'run',
      'saveSession', 'sessionJSON', 'slots', 'versions']);
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
    //
    // Parsing the log line rather than pattern-matching it also asserts the
    // stronger property: what the log displays is something the parser accepts.
    const reparsed = parseStatement(`X = ${r.loadText}`);
    assert.equal(reparsed.named.path.value, r.swatchPath,
      'the recorded path is not the path that was asked for');
  });

  test('load decodes to a 3-channel f32 buffer tagged srgb', () => {
    assert.deepEqual(r.loadShape, [2, 2, 3, 'f32', 'srgb']);
    // params sort alphabetically in the canonical form: as, from, path
    assert.match(r.loadText, /^load\(as=srgb, from=srgb, path=/);
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

  test('a PNG declaring gAMA 1.0 is refused under the sRGB default', () => {
    assert.equal(r.linearRefused, true, 'a linear-declaring file was accepted as sRGB');
    assert.match(r.linearDeclared, /declares linear samples.*gamma 1\.0.*Pass from=linear/);
  });

  test('the same file loads once from=linear is stated', () => {
    assert.equal(r.linearAccepted, true, `from=linear was not accepted: ${r.linearDeclared}`);
  });

  test('gray refuses an srgb input and names the fix', () => {
    assert.ok(r.grayOnSrgb, 'gray accepted sRGB input');
    assert.match(r.grayOnSrgb, /needs linear input, but S#1 is srgb/);
    assert.match(r.grayOnSrgb, /toLinear\(S\)/);
  });

  test('a refused command appends nothing to the log', () => {
    // S, L, and D-with-from=linear. The two refusals -- the linear-declaring
    // file under the sRGB default, and gray on an sRGB input -- recorded nothing.
    assert.equal(r.logAfterRefusal, 3, 'a refused command must leave no trace');
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

  test('every global control is visible, not only in the app menu', () => {
    // The regression this exists for: scaling and discard-session were moved
    // into paneless's app menu, which opens by clicking the title text. No
    // label, no affordance, and two of the most-used controls in the lab
    // invisible behind it. Reachability is the property, so the check is
    // getBoundingClientRect rather than mere presence in the DOM.
    for (const [name, shown] of Object.entries(r.toolbar)) {
      assert.ok(shown, `${name} is not visible in the interface`);
    }
    assert.ok(r.menuAlsoHas, 'the app menu should keep a copy of every global control');
  });

  test('the app opens with a command pane, a log pane and a slot pane', () => {
    assert.equal(r.initialPanes.command, true, 'no command input');
    assert.equal(r.initialPanes.log, true, 'no log pane');
    assert.equal(r.initialPanes.slot, 1, 'expected exactly one slot pane at startup');
  });

  test('a new slot fills a slot pane without being asked', () => {
    // The old UI rebuilt a grid of every slot after every command. Panes are
    // user-arranged, so the reflex is deliberate now: fill an empty pane, then
    // open panes up to a limit, then stop rather than bury the layout.
    assert.ok(r.autoBound.length >= 1, 'no slot was bound automatically');
    assert.ok(r.autoBound.length <= 4, `auto-opened too many panes: ${r.autoBound}`);
    assert.equal(new Set(r.autoBound).size, r.autoBound.length,
      `two panes bound to the same slot: ${r.autoBound}`);
  });

  test('every pane draws its slot', () => {
    for (const [slot, drew] of Object.entries(r.drawn)) {
      assert.ok(drew, `pane showing ${slot} rendered blank`);
    }
  });

  test('each canvas takes its aspect ratio from its slot', () => {
    // A canvas simply stretched to the pane squashes the image: renderTile
    // maps the source rect onto whatever destination it is handed.
    for (const [slot, a] of Object.entries(r.aspects)) {
      assert.ok(Math.abs(a.canvas - a.source) / a.source < 0.02,
        `${slot}: canvas aspect ${a.canvas.toFixed(3)} vs source ${a.source.toFixed(3)}`);
    }
    const values = Object.values(r.aspects).map((a) => a.source);
    assert.ok(values.some((v) => Math.abs(v - 1) < 0.01), 'no square slot tested');
    assert.ok(values.some((v) => v > 2), 'no wide slot tested');
  });

  test('display defaults follow the data kind', () => {
    assert.match(r.readoutE, /diverging/, 'a signed gradient should default to diverging');
    assert.match(r.readoutM, /categorical/, 'a label map should default to categorical');
    assert.match(r.readoutP, /gray/, 'plain intensity should default to gray');
  });

  test('one wheel event changes every pane by the same factor', () => {
    // §7's synchronised pan and zoom. Since the port this falls out of every
    // pane reading the same `viewport` state rather than a redrawAll() loop —
    // so it is worth checking it still actually happens.
    const names = Object.keys(r.zoomBefore);
    assert.ok(names.length > 1, 'need several panes to compare');
    const factors = names.map((s) => r.zoomAfter[s] / r.zoomBefore[s]);
    assert.ok(factors.every((f) => f > 1.01), `the wheel event had no effect: ${factors}`);
    const spread = Math.max(...factors) / Math.min(...factors);
    assert.ok(spread < 1.02, `panes zoomed by different factors: ${factors}`);
  });

  test('Reset view restores the whole image, and knows when it is a no-op', () => {
    assert.equal(r.resetEnabledWhenZoomed, true, 'should be enabled while zoomed in');
    assert.equal(r.resetDisabledAfterwards, true, 'should disable once the view is reset');
    for (const [slot, before] of Object.entries(r.zoomBefore)) {
      assert.ok(Math.abs(r.zoomAfterReset[slot] - before) < 0.01,
        `${slot} did not return to its unzoomed scale`);
    }
  });

  test('the zoom readout is screen pixels per image pixel', () => {
    assert.ok(r.zoomSmooth > 3, `expected magnification, got ${r.zoomSmooth}`);
    assert.ok(Math.abs(r.zoomActual - 1) < 0.01, `actual size should be 1x, got ${r.zoomActual}`);
  });

  test('actual size never magnifies', () => {
    assert.deepEqual(r.sizeActual, [64, 64], 'a 64x64 slot should render at 64x64');
    assert.ok(r.sizeSmooth[0] > 64, `fit should magnify, got ${r.sizeSmooth}`);
  });

  test('the histogram view renders', () => {
    assert.equal(r.histogram, 'histogram');
  });

  test('a bad command reports an error without throwing into the page', () => {
    assert.equal(r.statusAfterRefusal, 'error');
  });

  test('the session is complete and saveable', () => {
    assert.equal(r.sessionEntries, r.slotsAtEnd, 'one entry per slot produced');
  });

  test('discarding the session clears the slots, the panes and the log', () => {
    assert.ok(r.beforeReset.slots > 0 && r.beforeReset.boundPanes > 0, 'nothing to reset');
    assert.deepEqual(r.afterReset, { slots: 0, boundPanes: 0, logLines: 0 });
  });

  test('the lab works again after a reset', () => {
    assert.equal(r.afterResetEntry, 1, 'the log should restart at one entry');
    assert.equal(r.afterResetShown, true, 'the first slot after a reset should get a pane');
  });

  test('a features slot binds, hashes and reports a count', () => {
    assert.match(r.fitStatus, /^#\d+ in/, `fit failed: ${r.fitStatus}`);
    assert.deepEqual(r.featureSlots, ['PF', 'PC']);
    assert.ok(r.featureCount > 0, 'no features produced');
    assert.equal(r.featureSlotSummary.kind, 'features');
    assert.equal(r.featureSlotSummary.count, r.featureCount);
  });

  test('a feature carries geometry, not pixels', () => {
    const f = r.featureSample;
    for (const key of ['id', 'pixels', 'x0', 'y0', 'x1', 'y1', 'length', 'angle',
                       'residual', 'cx', 'cy']) {
      assert.ok(typeof f[key] === 'number', `missing ${key}`);
    }
    assert.ok(f.angle >= 0 && f.angle < 180, `angle ${f.angle} outside [0,180)`);
    assert.ok(f.residual >= 0, 'residual must be non-negative');
    assert.ok(f.length > 0, 'length must be positive');
  });

  test('a features slot cannot be shown in a slot pane, and has no pixels to probe', () => {
    assert.equal(r.slotPaneOffersOnlyBuffers, true,
      'a feature list was offered as something a slot pane could display');
    assert.equal(r.probeSkipsFeatures, true, 'the probe should skip a slot with no pixels');
    assert.match(r.drawOnFeatures, /holds features, not pixels/);
  });

  test('feature slots report what kind of features they hold', () => {
    assert.deepEqual(r.featureTypes.PF && Object.keys(r.featureTypes.PF), ['edge-segment']);
    assert.deepEqual(r.featureTypes.PC && Object.keys(r.featureTypes.PC), ['edge-corner']);
  });

  test('the overlay actually changes the tile', () => {
    // Corners were previously drawn with a line segment's fields, giving NaN
    // coordinates that canvas silently discards -- computed, logged, invisible.
    assert.notEqual(r.withOverlay, r.withoutOverlay, 'the overlay drew nothing');
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
