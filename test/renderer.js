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
const { buildMenu } = require('../src/menu');

/** Every item in a menu, submenus included. */
function flatten(items) {
  const out = [];
  for (const item of items) {
    out.push(item);
    if (item.submenu?.items) out.push(...flatten(item.submenu.items));
  }
  return out;
}
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

    /*
     * Wait for a condition rather than for a duration.
     *
     * The fixed sleeps below were tuned on a fast machine with a real display.
     * A pane's canvas only appears once its ResizeObserver has fired and the
     * effect has redrawn, and on a headless Linux runner under xvfb that takes
     * longer than any number picked by eye. Waiting on the predicate makes the
     * test independent of how fast the machine is, and fails with a sentence
     * rather than a null dereference three lines later.
     */
    const waitFor = async (label, predicate, timeout = 8000) => {
      const started = Date.now();
      for (;;) {
        let ok = false;
        try { ok = !!predicate(); } catch { ok = false; }
        if (ok) return;
        if (Date.now() - started > timeout) {
          // Concatenation, not a template literal: this whole script is
          // itself inside one, and a backtick here would close it early.
          throw new Error('timed out after ' + timeout + 'ms waiting for: ' + label);
        }
        await sleep(25);
      }
    };

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
      const id = already
        ?? (() => {
          const free = ids.find(i => !lab2().paneStore.getPane(i)?.name);
          const target = free ?? lab2().newSlotPane(null);
          lab2().bindSlotPane(target, name);
          return target;
        })();
      // The pane exists; its canvas appears a frame or two later, once the
      // ResizeObserver has reported a size and the draw effect has run.
      await waitFor('a drawn canvas for slot ' + name, () => {
        const c = paneFor(name)?.querySelector('canvas');
        return c && c.width > 0 && c.height > 0;
      });
      return id;
    };
    const paneFor = (name) => document.querySelector('.slot-pane[data-slot="' + name + '"]');
    const canvasFor = (name) => paneFor(name)?.querySelector('canvas');
    const readoutFor = (name) => paneFor(name)?.querySelector('.readout')?.textContent ?? '(no pane)';
    const zoomFor = (name) => parseFloat(paneFor(name)?.querySelector('.zoom')?.textContent ?? 'NaN');
    /*
     * Global commands live in the NATIVE application menu now, so there is no
     * DOM element to click. The renderer's half of that is its handler, which
     * is what __cvlab.menuCommand reaches; the menu template itself is
     * asserted in the main process, where it exists.
     */
    const menu = (id) => lab2().menuCommand(id);
    const ink = (c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] * 3 + d[i + 2] * 7;
      return sum;
    };

    // The app builds its layout in onMount; on a slow runner that has not
    // necessarily finished when this script starts.
    await waitFor('the initial layout', () =>
      lab2() && lab2().slotPaneIds().length > 0 && document.getElementById('command'));

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
    // The command bar is in the app header, not in a pane -- it is the primary
    // interaction and should not be closable or losable.
    r.commandBarInHeader = !!document.querySelector('.app-header #command');

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
    r.headerControls = {
      opMenu: visible(document.getElementById('op-menu')),
      command: visible(document.getElementById('command')),
      run: visible(document.getElementById('run')),
    };
    // The header hosts the command bar, so it must NOT also carry paneless's
    // app title -- that was the third copy of the app's name and the reason
    // for showTitle={false}.
    r.noAppTitle = !document.querySelector('.app-title');

    // --- reset view, through the menu command the menu item fires ---
    r.viewResetBeforeZoom = lab2().viewport.w === 1 && lab2().viewport.h === 1;
    menu('reset-view');
    await sleep(60);
    r.zoomAfterReset = readZooms();

    // --- scaling modes ---
    const setScaling = async (mode) => {
      menu('scaling:' + mode);
      await sleep(90);
    };
    await ui('T = pattern(kind=checker, width=64, height=64)');
    await showSlot('T');
    const sizeOf = (name) => { const c = canvasFor(name); return [c.width, c.height]; };
    await setScaling('smooth'); r.sizeSmooth = sizeOf('T'); r.zoomSmooth = zoomFor('T');
    await setScaling('actual'); r.sizeActual = sizeOf('T'); r.zoomActual = zoomFor('T');
    await setScaling('smooth');

    // --- histogram view, through the pane's own control ---
    /*
     * The controls are paneless controls now: SVG driven by controlStore, in a
     * pane of their own beside the image. So this drives the control the way
     * paneless's Dropdown does -- by emitting the event it emits -- rather
     * than clicking the rendered SVG, which would be testing paneless's
     * hit-testing rather than the wiring this app owns.
     */
    const controlsPaneFor = (name) => {
      const imageId = lab2().slotPaneIds()
        .find((id) => lab2().paneStore.getPane(id)?.name === name);
      const parent = lab2().paneStore.getPane(imageId)?.parentId;
      return lab2().paneStore.getPane(parent)?.leftChildId ?? null;
    };
    const controlNamed = (paneId, controlName) => {
      const data = lab2().controlStore.getPaneData(paneId);
      return Object.values(data?.byId ?? {}).find((c) => c.name === controlName) ?? null;
    };
    const setControl = async (name, controlName, itemId) => {
      const paneId = controlsPaneFor(name);
      const control = controlNamed(paneId, controlName);
      const item = control.items.find((i) => i.id === itemId);
      lab2().controlStore.updateControl(paneId, control.id, { selectedId: itemId });
      lab2().controlEvents.emit({
        type: 'controlValueChanged',
        paneId,
        controlId: control.id,
        value: { oldId: control.selectedId, newId: itemId, newValue: item?.label, item },
      });
      await sleep(90);
    };

    await showSlot('P');
    await setControl('P', 'type', 'histogram');
    r.histogram = readoutFor('P');
    await setControl('P', 'type', 'image');

    /*
     * Every control has to be reachable, which is not the same as present.
     * paneless reveals a hidden frame header on hover with a transparent
     * overlay across the top of the frame; a control drawn under it looks
     * clickable and is not, because the overlay takes the click. The slot
     * dropdown was the first row and was exactly there -- so it could not be
     * used at all, and nothing that only checked the control EXISTS would have
     * noticed. Asserted as a property: no control starts inside the band.
     */
    const HOVER_BAND = 22;   // Frame.svelte's .transient-header-overlay
    r.controlsUnderHoverBand = (() => {
      const paneId = controlsPaneFor('P');
      const data = lab2().controlStore.getPaneData(paneId);
      const root = data.rootPanelId;
      return Object.values(data.byId)
        .filter((c) => c.id !== root && c.y < HOVER_BAND)
        .map((c) => (c.name || c.type) + '@y=' + c.y);
    })();

    // The column reports the slot its sibling image pane is bound to, and
    // offers a channel per channel that slot actually has.
    r.controlsTrackTheSlot = (() => {
      const paneId = controlsPaneFor('P');
      return {
        slot: controlNamed(paneId, 'slot')?.selectedId,
        channels: controlNamed(paneId, 'channel')?.items.map((i) => i.label),
        colormap: controlNamed(paneId, 'colormap')?.selectedId,
      };
    })();

    // --- the Generate frame ---
    /*
     * Opened through the menu command, as the menu item does. Whether it can
     * actually RENDER is not testable here -- pt-lab needs a GPU and the
     * generator is never built in CI -- but everything up to that point is,
     * including the case that matters when it is absent.
     */
    menu('generate');
    await sleep(300);
    /*
     * The controls are a paneless control column in the pane next door now, so
     * "does it offer controls" is a question about the control store rather
     * than about this pane's DOM. The pane itself is the render host: it
     * reports its rectangle and the main process lays pt-lab's webContents
     * over it, which is not something this process can see.
     */
    const generatePane = () => document.querySelector('.generate-pane');
    const generateControlsPane = () => {
      const paneId = generatePane()?.dataset.pane;
      const parent = paneId ? lab2().paneStore.getPane(paneId)?.parentId : null;
      return parent ? lab2().paneStore.getPane(parent)?.leftChildId ?? null : null;
    };
    r.generate = {
      opened: !!generatePane(),
      // A second command must not open a second frame: two would race each
      // other over one output directory and one GPU.
      single: (menu('generate'), await sleep(200), document.querySelectorAll('.generate-pane').length),
      // Either it offers the controls, or it says why it cannot.
      usable: (() => {
        const paneId = generateControlsPane();
        if (!paneId) return false;
        const data = lab2().controlStore.getPaneData(paneId);
        return Object.values(data?.byId ?? {}).some((c) => c.name === 'run');
      })(),
      explains: (generatePane()?.querySelector('.unavailable')?.textContent ?? '').trim(),
      // What the scene dropdown offers, so it can be compared with what the
      // driver actually has. A list retyped in the renderer is a list that
      // drifts: the driver grew saved scenes and the pane went on offering two
      // literals, so a scene that rendered from the CLI was invisible here.
      scenes: (() => {
        const paneId = generateControlsPane();
        if (!paneId) return null;
        const data = lab2().controlStore.getPaneData(paneId);
        const control = Object.values(data?.byId ?? {}).find((c) => c.name === 'scene');
        return control ? control.items.map((i) => i.id) : null;
      })(),
      // A room control would only ever contradict the scene file, which
      // records the room it was composed in.
      hasRoomControl: (() => {
        const paneId = generateControlsPane();
        if (!paneId) return false;
        const data = lab2().controlStore.getPaneData(paneId);
        return Object.values(data?.byId ?? {}).some((c) => c.name === 'room');
      })(),
      // The render pane is the one paneless will hand to the main process, so
      // it has to be the RIGHT child of the split, not the whole frame.
      isRightChild: (() => {
        const paneId = generatePane()?.dataset.pane;
        const parent = paneId ? lab2().paneStore.getPane(paneId)?.parentId : null;
        return !!parent && lab2().paneStore.getPane(parent)?.rightChildId === paneId;
      })(),
    };

    /*
     * No control paints text outside itself.
     *
     * SVG does not clip to a group, so a caption longer than its control is
     * drawn straight over whatever is beside it -- paneless clipped its label
     * and nothing else, and an output path in an editbox ran through its own
     * border, under a dropdown's arrow, and out the far side.
     *
     * Asserted by forcing the failure rather than hoping some string is long
     * enough: every control is handed something too wide for it, measured,
     * and put back. cv-lab is where this shows and where it hurts, so the
     * check lives here even though the clipping is paneless's to implement.
     *
     * getBBox reports GEOMETRY and ignores clipping, so overflow alone proves
     * nothing -- a correctly clipped label overflows by that measure too. The
     * property is: text wider than its control must have a clip in effect.
     */
    r.unclippedControls = (() => {
      const cs = lab2().controlStore;
      const LONG = 'OVERFLOW'.repeat(6);
      const bad = [];
      for (const paneId of cs.getPaneIds()) {
        const data = cs.getPaneData(paneId);
        if (!data) continue;
        for (const control of Object.values(data.byId)) {
          if (control.type === 'panel') continue;

          const before = {};
          for (const key of ['text', 'value', 'items', 'selectedId']) {
            if (control[key] !== undefined) before[key] = control[key];
          }
          if (control.type === 'editbox') cs.updateControl(paneId, control.id, { value: LONG });
          else if (control.type === 'dropdown') {
            cs.updateControl(paneId, control.id, { items: [{ id: 'x', label: LONG }], selectedId: 'x' });
          } else cs.updateControl(paneId, control.id, { text: LONG });

          const g = document.querySelector('[data-control-id="' + control.id + '"]');
          for (const t of g ? g.querySelectorAll('text') : []) {
            const box = t.getBBox();
            if (box.x + box.width - control.width <= 1) continue;
            let clipped = false;
            for (let el = t; el && el !== g.parentNode; el = el.parentNode) {
              if (el.getAttribute && el.getAttribute('clip-path')) { clipped = true; break; }
            }
            if (!clipped) bad.push((control.name || '(unnamed)') + ':' + control.type);
          }
          if (Object.keys(before).length > 0) cs.updateControl(paneId, control.id, before);
        }
      }
      return bad;
    })();

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
    const toggleOverlay = async () => { menu('toggle-overlay'); await sleep(80); };
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
    menu('reset-session');
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
    /*
     * Clicking an image in the contact sheet: close what is open, run the
     * pipeline, show every stage.
     *
     * Driven through the action rather than the sheet, because building a
     * sheet needs a GPU-rendered sweep and CI has no GPU -- but the part worth
     * checking is what happens to the PANES, which does not.
     *
     * LAST in this function, deliberately. geometry.lab uses short slot names
     * and one of them, S, is already bound here -- so running it REBINDS
     * rather than creates, and the session's "one entry per slot" invariant
     * stops holding partway through. Measuring this after everything else
     * keeps the run from being an input to any other answer.
     */
    r.pipelineRun = await (async () => {
      // Something to close, so "closes what is open" is not vacuous.
      lab2().newSlotPane(null);
      lab2().newSlotPane(null);
      const before = lab2().slotPaneIds().length;

      await lab2().runPipelineOn(swatch, null);
      await sleep(120);

      const ids = lab2().slotPaneIds();
      const bound = ids.map((id) => lab2().paneStore.getPane(id)?.name).filter(Boolean);
      const buffers = window.lab.slots().filter((s) => s.kind === 'buffer').map((s) => s.name);
      return {
        before,
        panes: ids.length,
        bound: bound.sort(),
        buffers: buffers.sort(),
        // Every stage of the pipeline is in the log, hashed, like anything
        // else -- the sheet is not a second execution path.
        logged: window.lab.log().length,
        collapsed: ids.every((id) => {
          const parent = lab2().paneStore.getPane(id)?.parentId;
          const left = parent ? lab2().paneStore.getPane(parent)?.leftChildId : null;
          return left ? lab2().paneStore.getPane(left)?.isCollapsed === true : false;
        }),
      };
    })();

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

  /*
   * The renderer reports the settings the application menu displays. This
   * harness has no menu -- it never calls Menu.setApplicationMenu -- but it
   * still has to answer, or every state change leaves an unhandled rejection
   * in the page and "the page logged no errors" fails for a reason that has
   * nothing to do with the lab.
   */
  const menuState = [];
  ipcMain.handle('menu:state', (_event, state) => { menuState.push(state); });

  /*
   * The generator's two startup questions, answered here rather than left
   * unhandled so the Generate frame can be exercised. On a machine with no
   * dist-generate build -- a CI runner at this point in the job, since the
   * generator is not built until packaging -- the check reports what is
   * missing and the pane is expected to say so rather than offer a dead
   * button.
   *
   * Both are needed. An unhandled invoke rejects, and the pane calls these on
   * mount, so leaving one out surfaces as an uncaught rejection in the page --
   * which the "logged no errors" assertion below catches, exactly as it
   * should.
   */
  const { checkPrerequisites, defaultOutputDir, savedSceneNames } =
    require('../src/generate/driver');
  ipcMain.handle('generate:check', () => checkPrerequisites());
  ipcMain.handle('generate:defaults', () => ({ out: defaultOutputDir() }));
  /*
   * Counted, not just answered. Whether the dropdown's CONTENTS can be
   * compared depends on the generator being built -- CI never builds it, so
   * the pane shows its explanation and there is no control to read. Whether
   * the pane ASKED does not depend on that, and asking is the property that
   * stops the list being retyped in the renderer and drifting.
   */
  const sceneRequests = [];
  /*
   * The pipeline the contact sheet runs. Read from pipelines/ here exactly as
   * the app's main process reads it, so the test exercises the real file
   * rather than a copy that could disagree with it.
   */
  ipcMain.handle('lab:pipeline', (_event, name) =>
    fs.promises.readFile(path.join(ROOT, 'pipelines', `${name}.lab`), 'utf8'));

  ipcMain.handle('generate:scenes', () => {
    const names = savedSceneNames();
    sceneRequests.push(names);
    return names;
  });

  /*
   * Where the render goes. The app's main process lays pt-lab's webContents
   * over this rectangle; here it is only recorded, because there is no
   * WebContentsView in the test window and the geometry is the part this
   * process can actually check.
   */
  const viewBounds = [];
  ipcMain.handle('generate:view-bounds', (_event, bounds) => { viewBounds.push(bounds); });

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

  /*
   * The event-object signature, not the positional one.
   *
   * Electron deprecated the positional arguments, and lab-cli.js and the
   * generator driver moved off them already -- this was the last caller, and
   * the only reason CI still printed the deprecation notice.
   *
   * It also removes the trap those two files document: positionally, `level`
   * is a NUMBER where 2 is a warning and 3 an error, so the obvious `level >= 2`
   * silently treats every warning as an error. That is what this was doing.
   * The strictness is kept deliberately -- a warning out of the page is worth
   * failing on, and CLAUDE.md says as much -- but it is now stated rather than
   * arrived at by an off-by-one, and a failure names which kind it was.
   */
  const consoleErrors = [];
  win.webContents.on('console-message', (event) => {
    if (event.level === 'warning' || event.level === 'error') {
      consoleErrors.push(`${event.level}: ${event.message}`);
    }
  });
  win.webContents.on('preload-error', (_e, file, err) => {
    consoleErrors.push(`preload ${file}: ${err.message}`);
  });

  await win.loadFile(path.join(ROOT, 'dist-renderer', 'index.html'));
  const r = await collect(win, swatch, linearPng);

  const close = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol;

  /* --- the bridge --------------------------------------------------- */

  test('the bridge exposes only the lab API', () => {
    /*
     * Spelt out rather than counted, because the bridge is the security
     * boundary: this list is where a new member has to be looked at on
     * purpose instead of arriving with a feature. The two most recent are
     * `pipeline`, which reads a named file from pipelines/ and nothing else,
     * and `thumbnail`, which draws a file into a canvas the caller names --
     * neither hands page script a path it did not already have, and neither
     * returns pixels.
     */
    assert.deepEqual(r.bridge, ['basename', 'confirmReset', 'draw', 'features',
      'generate', 'histogram', 'log', 'onMenuCommand', 'openImage', 'ops',
      'pipeline', 'probeAll', 'quote', 'reset', 'run', 'saveSession',
      'sessionJSON', 'setMenuState', 'slots', 'thumbnail', 'versions']);
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

  /*
   * Reachability, which is what this group is really about.
   *
   * The history: the global commands were first put in paneless's app menu,
   * which opens by clicking the title text — no label, no affordance — and two
   * of the most-used controls in the lab became invisible. Then a toolbar. Now
   * a NATIVE menu, which is the conventional home and the one place a user
   * will look. Each move needs its own kind of check, because the controls are
   * no longer in the DOM at all: the renderer's handler is tested through
   * __cvlab.menuCommand, and the menu TEMPLATE is tested below in the main
   * process, where it actually exists.
   */
  test('the command bar is visible in the header, not buried in a pane', () => {
    for (const [name, shown] of Object.entries(r.headerControls)) {
      assert.ok(shown, `${name} is not visible in the interface`);
    }
    assert.equal(r.commandBarInHeader, true, 'the command bar should be in the app header');
    assert.equal(r.noAppTitle, true,
      'paneless\'s app title should be off — the OS chrome already names the app');
  });

  test('the application menu carries every global command', () => {
    /*
     * Built here rather than read from the live menu, because buildMenu is a
     * pure function of its state and that is the thing worth pinning.
     */
    const sent = [];
    const items = flatten(buildMenu({
      state: { scaling: 'pixels', overlay: false, viewIsReset: false },
      send: (id) => sent.push(id),
    }).items);

    const byLabel = (label) => items.find((i) => i.label === label);
    for (const label of ['Open Image…', 'Save Session…', 'Discard Session…',
                         'Reset View', 'New Slot Pane', 'New Log Pane']) {
      assert.ok(byLabel(label), `the menu has no "${label}" item`);
    }

    // Settings show their state — the thing paneless's menu never did.
    const scaling = items.filter((i) => i.type === 'radio' &&
      ['smooth', 'pixels', 'actual'].includes(i.label));
    assert.equal(scaling.length, 3, 'expected three scaling modes');
    assert.deepEqual(scaling.filter((i) => i.checked).map((i) => i.label), ['pixels'],
      'exactly the current scaling mode should be ticked');

    const overlay = byLabel('Draw fits over tiles');
    assert.equal(overlay.type, 'checkbox');
    assert.equal(overlay.checked, false, 'the checkbox should follow the state it was built with');

    assert.equal(byLabel('Reset View').enabled, true, 'enabled while the view is zoomed');
    const whole = flatten(buildMenu({
      state: { scaling: 'smooth', overlay: true, viewIsReset: true }, send: () => {},
    }).items);
    assert.equal(whole.find((i) => i.label === 'Reset View').enabled, false,
      'disabled once the view is whole again');
  });

  test('replacing the default menu keeps copy/paste and developer tools', () => {
    /*
     * The trap this guards. Until src/menu.js existed, Menu.setApplicationMenu
     * was never called and Electron installed its DEFAULT menu — which is what
     * provided Cmd/Ctrl+C, V, X, A inside the command input, and Toggle
     * Developer Tools. Installing any custom template drops both silently
     * unless they are asked for by role.
     */
    const roles = flatten(buildMenu({
      state: { scaling: 'smooth', overlay: true, viewIsReset: true }, send: () => {},
    }).items).map((i) => i.role).filter(Boolean);

    // Electron lower-cases roles when it expands a template, so these are
    // `selectall` and `toggledevtools`, not the camelCase spellings the docs
    // use for the input.
    for (const role of ['copy', 'paste', 'cut', 'selectall']) {
      assert.ok(roles.includes(role), `the Edit menu lost "${role}" — copy/paste will not work`);
    }
    assert.ok(roles.includes('toggledevtools'), 'Toggle Developer Tools is gone');
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

  test('Reset view restores the whole image', () => {
    // Whether the menu item is ENABLED is a property of the template and is
    // asserted where the template is built. This is the effect.
    assert.equal(r.viewResetBeforeZoom, false, 'the wheel event should have zoomed in');
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

  test('every slot control is clear of the frame\'s hover overlay', () => {
    // Not "does the control exist" -- does a click reach it. See the note at
    // the measurement: the overlay is transparent, so this fails invisibly.
    assert.deepEqual(r.controlsUnderHoverBand, [],
      `these controls are under the hover overlay and cannot be clicked: ${r.controlsUnderHoverBand}`);
  });

  test('the controls column tracks the slot its image pane shows', () => {
    const c = r.controlsTrackTheSlot;
    assert.equal(c.slot, 'P', 'the slot dropdown does not name the bound slot');
    assert.equal(c.colormap, 'gray', 'colormap does not reflect the view');
    // P is single-channel, so "all" and ch0 and nothing else.
    assert.deepEqual(c.channels, ['all', 'ch0'],
      `channel offered ${JSON.stringify(c.channels)} for a 1-channel slot`);
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

  test('the Generate frame opens once, and degrades honestly without a build', () => {
    assert.equal(r.generate.opened, true, 'the menu command should open a Generate frame');
    assert.equal(r.generate.single, 1, 'a second command should not open a second frame');
    // One or the other, never neither: a pane offering nothing and explaining
    // nothing is the failure worth catching.
    const offersControls = r.generate.usable;
    // "older than its sources" belongs here too. checkPrerequisites reports
    // three distinct problems and this listed two, so a STALE bundle -- the
    // pane explaining itself perfectly well -- was read as explaining nothing
    // and failed the run. The contract is "offers controls or says why not";
    // whether the bundle is fresh is build:generate's guard, not this one.
    const saysWhyNot = /not built|missing|checkout|older than/i.test(r.generate.explains);
    assert.ok(offersControls || saysWhyNot,
      `the frame neither offered controls nor explained why: ${JSON.stringify(r.generate)}`);
    // The controls go left and the render goes right. Reversed, the main
    // process would lay pt-lab's webContents over the controls.
    assert.equal(r.generate.isRightChild, true,
      'the render pane is not the right-hand child of the split');
  });

  test('no control paints its text outside itself', () => {
    // Every control kind, handed something too wide for it. paneless clipped
    // its label and nothing else: an editbox value ran through its own border,
    // a dropdown's text passed under the arrow and reappeared beyond it, and a
    // button's centred caption came out of both sides.
    assert.deepEqual(r.unclippedControls, [],
      'these controls paint text outside their own box: ' + JSON.stringify(r.unclippedControls));
  });

  test('the pane asks the main process which scenes there are', () => {
    /*
     * The anti-drift check, and the one that runs everywhere.
     *
     * The dropdown listed two literals typed into the renderer; the driver
     * grew saved scenes and the pane went on offering the literals, so a
     * scene that rendered from the CLI was invisible in the app. A pane that
     * ASKS cannot drift, and it asks whether or not the generator is built.
     */
    assert.ok(sceneRequests.length > 0,
      'the Generate pane never asked for the scene list, so it has one of its own');
  });

  test('the scene dropdown offers exactly the scenes the driver has', () => {
    const { savedSceneNames } = require('../src/generate/driver');
    const have = savedSceneNames();
    // scenes/cube-1.json is committed, so this is not vacuous.
    assert.ok(have.length > 0, 'no scenes in scenes/ -- the comparison proves nothing');

    if (r.generate.scenes === null) {
      /*
       * No controls column to read. That happens when the generator is not
       * built -- CI never builds it -- and the pane shows why instead. Not a
       * silent skip: it has to be THAT reason, or this passed for the wrong
       * one, which is how the whole class of bug in CLAUDE.md gets through.
       */
      assert.match(r.generate.explains, /not built|missing|checkout|older than/i,
        'no scene control, and no explanation for its absence either');
      return;
    }
    assert.deepEqual(r.generate.scenes, have.map((n) => `saved:${n}`),
      'the pane offers a different set of scenes than the driver can render');
  });

  test('the Generate pane has no room control', () => {
    // A scene records the room it was composed in, so the pane overriding it
    // could only contradict the file. --room still exists on the CLI.
    //
    // Absence passes trivially where there is no controls column at all, so
    // this only means anything alongside the comparison above.
    if (r.generate.scenes === null) return;
    assert.equal(r.generate.hasRoomControl, false);
  });

  test('running a pipeline over an image shows every stage it produces', () => {
    const p = r.pipelineRun;
    /*
     * One pane per BUFFER, and none for the feature lists. fit and corners
     * produce geometry rather than pixels, and a feature list has no tile of
     * its own -- it is drawn over any tile of matching size, which is why the
     * fits appear on all of them at once.
     */
    assert.deepEqual(p.bound, p.buffers,
      'the panes open do not match the slots that have pixels');
    assert.equal(p.panes, p.buffers.length);
    assert.ok(p.buffers.length > 4,
      `the pipeline should exceed the typing limit of 4, got ${p.buffers.length}`);
  });

  test('a pipeline run closes the panes from the last one', () => {
    // Otherwise the second image you click is measured beside the first one's
    // stages, which is a good way to read the wrong picture.
    assert.ok(r.pipelineRun.before > 0, 'nothing was open, so nothing was closed');
    assert.equal(r.pipelineRun.panes, r.pipelineRun.buffers.length,
      'panes accumulated across runs');
  });

  test('every stage of a pipeline run is logged like a typed command', () => {
    // The sheet composes command TEXT and runs it through the one execution
    // path (design-lab-model.md §4). If it did not, these would be missing.
    assert.ok(r.pipelineRun.logged >= r.pipelineRun.buffers.length,
      'the pipeline ran without appearing in the log');
  });

  test('a packed pipeline run collapses each pane\'s controls', () => {
    // Nine frames have no room for nine controls columns beside a usable
    // image. Collapsed, not removed: paneless keeps them on a tab.
    assert.equal(r.pipelineRun.collapsed, true);
  });

  test('the render pane reports where it is', () => {
    // The main process cannot see this rectangle -- paneless lays it out in
    // the renderer -- so a pane that never reports, or reports a degenerate
    // box, puts the render somewhere nobody can see. It looks exactly like a
    // generator that did not start.
    assert.ok(viewBounds.length > 0, 'the render pane never reported its bounds');
    const last = viewBounds[viewBounds.length - 1];
    assert.ok(last.width > 50 && last.height > 50,
      `reported a degenerate rectangle: ${JSON.stringify(last)}`);
    assert.ok(last.x >= 0 && last.y >= 0,
      `reported a rectangle outside the window: ${JSON.stringify(last)}`);
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
  /*
   * Print whatever arrived, not just err.stack.
   *
   * executeJavaScript rejects with the value the page threw, marshalled
   * across the boundary -- which can be Error-SHAPED without being an Error,
   * so `.stack` is undefined and the useful message is in `.message`. Printing
   * only the stack turned a real failure into the single word "undefined" and
   * cost a CI round trip to find out.
   */
  const detail = err && (err.stack || err.message)
    ? (err.stack || err.message)
    : `${typeof err}: ${JSON.stringify(err)}`;
  console.error(`renderer tests could not start:\n${detail}`);
  app.exit(1);
});
