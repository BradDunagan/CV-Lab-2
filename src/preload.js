'use strict';

/**
 * The bridge, and the home of the lab itself.
 *
 * This file runs in the renderer process but in its own JavaScript context,
 * with Node available. Page script gets only what is listed in
 * exposeInMainWorld below — never require(), never fs, never ipcRenderer.
 *
 * The session and every buffer handle live HERE, not in page script. Pixels
 * are never sent across the bridge: `draw` reaches into the shared DOM for the
 * canvas and renders into it directly, exactly as the measurement in
 * electron-guide.md §1 recommends. What crosses is a canvas id and a small
 * result object.
 */

const { contextBridge, ipcRenderer } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const native = require('../native');
const { createRegistry } = require('./lab/ops');
const { readPngColour } = require('../scripts/png');
const { Session } = require('./lab/session');
const { quoteString } = require('./lab/parser');

/**
 * Decode an image using Chromium's decoder — the reason `load`'s kernel lives
 * in JavaScript rather than C. It handles every format the platform knows and
 * is already in the process, which is a large amount of native library and
 * build complexity avoided (electron-guide.md §5).
 *
 * Two options here are deliberate and easy to get wrong:
 *
 *   colorSpaceConversion: 'none'
 *     By default the browser applies any embedded ICC profile and converts to
 *     the display profile. For a lab that is silent, unrecorded processing —
 *     the same file could decode differently on a different monitor. We want
 *     the values that are actually in the file.
 *
 *   premultiplyAlpha: 'none'
 *     Premultiplication is lossy and would fold alpha into the colour channels
 *     before we drop it.
 *
 * The cost of borrowing Chromium: it returns 8 bits per channel. Higher
 * precision input (16-bit PNG, TIFF, raw) needs a native decode path, which is
 * still open in design-lab-model.md §11.
 */
async function decodeFile(filePath) {
  const bytes = await fs.readFile(filePath);

  /*
   * Read what the file says about its own encoding before decoding it.
   * Chromium is told not to colour-manage (below), so it will not tell us --
   * and the case that matters is a file holding LINEAR samples, which treated
   * as sRGB gets a curve applied that was never there.
   *
   * PNG only. JPEG carries this in EXIF/ICC and WebP in its own chunks; both
   * report `undeclared` here, which falls back to the sRGB convention.
   */
  const colour = readPngColour(bytes);
  const bitmap = await createImageBitmap(new Blob([bytes]), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
      width: bitmap.width,
      height: bitmap.height,
      pixels: image.data,
      declared: colour.declared,
      detail: colour.detail,
    };
  } finally {
    bitmap.close();
  }
}

const registry = createRegistry({ decodeFile });
const session = new Session({
  registry,
  environment: {
    app: require('../package.json').version,
    electron: process.versions.electron,
    platform: `${process.platform}/${process.arch}`,
  },
});

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function slotSummaries() {
  return [...session.slots.entries()].map(([name, binding]) => {
    const base = { name, version: binding.version, kind: binding.value.kind };
    if (binding.value.kind !== 'buffer') {
      // A feature list has no pixels, so no dtype, channels or colour space.
      const types = {};
      for (const f of binding.value.features) {
        const t = f.type ?? 'untyped';
        types[t] = (types[t] ?? 0) + 1;
      }
      return { ...base, width: binding.value.width, height: binding.value.height,
               count: binding.value.features.length, types };
    }
    return { ...base, ...native.bufferInfo(binding.value.handle) };
  });
}

function handleFor(slot) {
  const binding = session.slots.get(slot);
  if (!binding) throw new Error(`unknown slot "${slot}"`);
  if (binding.value.kind !== 'buffer') {
    throw new Error(`slot "${slot}" holds ${binding.value.kind}, not pixels`);
  }
  return binding.value.handle;
}

function entrySummary(entry) {
  return {
    n: entry.n,
    text: entry.text,
    source: entry.source,
    produced: entry.produced,
    output: entry.output,
  };
}

/**
 * Map a normalised viewport rect onto a specific slot's pixel grid.
 * Normalised so that slots of different sizes stay in step under one shared
 * pan and zoom.
 */
function sourceRect(info, viewport) {
  return {
    x: Math.floor(viewport.x * info.width),
    y: Math.floor(viewport.y * info.height),
    w: Math.max(1, Math.round(viewport.w * info.width)),
    h: Math.max(1, Math.round(viewport.h * info.height)),
  };
}

/* ------------------------------------------------------------------ */

contextBridge.exposeInMainWorld('lab', {
  /** Registry contents, for the operation menu and generated help. */
  ops: () =>
    registry.list().map((op) => ({
      name: op.name,
      summary: op.summary,
      implemented: op.implemented,
      inputs: op.inputs.map((i) => i.name),
      params: op.params.map((p) => ({
        name: p.name, type: p.type, values: p.values ?? null, default: p.default,
      })),
      help: registry.describe(op.name),
    })),

  /** Execute one command. Resolves to the log entry, or rejects with a message. */
  run: async (source) => {
    const entry = await session.execute(source);
    return entry ? entrySummary(entry) : null;
  },

  log: () => session.log.map(entrySummary),
  slots: () => slotSummaries(),

  /**
   * The text of a pipeline in pipelines/, by name.
   *
   * Read from the file the CLI runs rather than kept as a copy here, so the
   * two cannot say different things.
   */
  pipeline: (name) => ipcRenderer.invoke('lab:pipeline', name),

  /**
   * Draw a file into a canvas, scaled to fit, for a contact sheet.
   *
   * Not `load`: a thumbnail is not a slot. Loading six generated images to
   * look at them would put six buffers in the session and six entries in the
   * log, and the log is a record of what was COMPUTED -- browsing is not.
   *
   * Same rule as `draw`, for the same reason: the caller passes a canvas id
   * and the pixels stay here. A data URL would be a string rather than a
   * typed array and would technically cross, which is not the point -- the
   * point is that the preload owns the pixels.
   */
  thumbnail: async (canvasId, filePath) => {
    const canvas = document.getElementById(canvasId);
    if (!canvas) throw new Error(`no canvas "${canvasId}"`);

    const bytes = await fs.readFile(filePath);
    const bitmap = await createImageBitmap(new Blob([bytes]));
    try {
      const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Centred, aspect kept. A generated sweep is square today and need not
      // stay so; a squashed thumbnail is a lie about the image behind it.
      ctx.drawImage(bitmap, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    } finally {
      bitmap.close();
    }
    return { width: bitmap.width, height: bitmap.height };
  },

  /**
   * Render a slot into a canvas already in the document.
   *
   * contextIsolation separates the JS contexts but NOT the DOM, so the canvas
   * here is the same canvas page script sees. No pixel data crosses.
   */
  draw: (canvasId, slot, spec = {}) => {
    const canvas = document.getElementById(canvasId);
    if (!canvas) throw new Error(`no canvas "${canvasId}"`);
    const handle = handleFor(slot);
    const info = native.bufferInfo(handle);
    const rect = sourceRect(info, spec.viewport ?? { x: 0, y: 0, w: 1, h: 1 });

    const tile = native.renderTile(handle, {
      width: canvas.width,
      height: canvas.height,
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      range: spec.range ?? 'auto',
      lo: spec.lo ?? 0,
      hi: spec.hi ?? 1,
      percentile: spec.percentile ?? 2,
      curve: spec.curve ?? 'linear',
      colormap: spec.colormap ?? 'gray',
      channel: spec.channel ?? -1,
      interpolate: spec.interpolate !== false,
    });

    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(tile.pixels, tile.width, tile.height), 0, 0);
    return { lo: tile.lo, hi: tile.hi, info };
  },

  /** Bin counts are small, so these can cross without concern. */
  histogram: (slot, spec = {}) => {
    const h = native.histogram(handleFor(slot), {
      bins: spec.bins ?? 128,
      curve: spec.curve ?? 'linear',
      range: spec.range ?? 'auto',
      lo: spec.lo ?? 0, hi: spec.hi ?? 1,
      percentile: spec.percentile ?? 2,
      channel: spec.channel ?? -1,
      interpolate: spec.interpolate !== false,
    });
    return { counts: [...h.counts], lo: h.lo, hi: h.hi };
  },

  /**
   * One readout for EVERY slot at a normalised position — the multi-slot
   * probe §7 calls the most useful debugging affordance in a tool like this.
   * One call rather than one per slot, so it can run on every mouse move.
   */
  probeAll: (nx, ny) => {
    const out = {};
    for (const [name, binding] of session.slots.entries()) {
      if (binding.value.kind !== 'buffer') continue;   /* nothing to sample */
      const info = native.bufferInfo(binding.value.handle);
      const x = Math.floor(nx * info.width);
      const y = Math.floor(ny * info.height);
      out[name] = { x, y, values: native.samplePixel(binding.value.handle, x, y) };
    }
    return out;
  },

  /**
   * Throw everything away and start over. Frees buffer memory immediately
   * rather than waiting for GC.
   * @returns {{entries:number, slots:number}} what was discarded
   */
  reset: () => session.reset(),

  /** Ask the main process to confirm, since reset destroys the log. */
  confirmReset: (entries) => ipcRenderer.invoke('session:confirmReset', entries),

  /*
   * The application menu.
   *
   * Two small messages, and deliberately nothing more: a command id in, the
   * settings the menu displays out. `onMenuCommand` wraps the listener rather
   * than handing `ipcRenderer.on` across, so page script receives the id and
   * never the IpcRendererEvent -- which carries `sender`, and would be a way
   * back into the preload's world that nothing here needs.
   */
  onMenuCommand: (callback) => {
    const listener = (_event, id) => callback(id);
    ipcRenderer.on('menu:command', listener);
    return () => ipcRenderer.removeListener('menu:command', listener);
  },

  /** Tell the menu which scaling mode is current, and so on, so its radio and
   *  checkbox items reflect reality. */
  setMenuState: (state) => ipcRenderer.invoke('menu:state', state),

  /*
   * Image generation. Small messages only: options in, progress events and a
   * list of written paths out. No pixels — the renders are written to disk by
   * the main process and read back through `load` like any other file.
   */
  generate: {
    /** null if the generator can run, or a sentence saying what is missing. */
    check: () => ipcRenderer.invoke('generate:check'),
    defaults: () => ipcRenderer.invoke('generate:defaults'),
    /** The scenes in scenes/, by name. The pane offers exactly these. */
    scenes: () => ipcRenderer.invoke('generate:scenes'),
    run: (options) => ipcRenderer.invoke('generate:run', options),
    /*
     * Where to put the embedded render.
     *
     * The main process owns the WebContentsView but cannot see the pane it
     * belongs over -- paneless lays that out in the renderer -- so the pane
     * reports its own rectangle in window coordinates and main matches it.
     */
    setViewBounds: (bounds) => ipcRenderer.invoke('generate:view-bounds', bounds),
    onProgress: (callback) => {
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on('generate:progress', listener);
      return () => ipcRenderer.removeListener('generate:progress', listener);
    },
  },

  /**
   * Every feature list currently bound, with the coordinate space it belongs
   * to, so the renderer can draw them over a tile of matching size.
   */
  features: () => [...session.slots.entries()]
    .filter(([, b]) => b.value.kind === 'features')
    .map(([name, b]) => ({
      slot: name, width: b.value.width, height: b.value.height,
      features: b.value.features,
    })),

  /** The whole session, ready to write to disk. */
  sessionJSON: () => session.toJSON(),

  saveSession: () => ipcRenderer.invoke('session:save', session.toJSON()),

  /** Native open dialog. Returns a path, or null if cancelled. */
  openImage: () => ipcRenderer.invoke('dialog:openImage'),

  basename: (filePath) => path.basename(filePath),

  /** Quote a value for the command language. Required for filesystem paths. */
  quote: (value) => quoteString(value),

  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  },
});
