'use strict';

/**
 * The bridge. This file runs in the renderer process but in its own JS
 * context, with Node available. Page script gets only what is listed in
 * exposeInMainWorld below -- never require(), never fs, never ipcRenderer.
 *
 * Every function here is a deliberate hole in the wall. Keep the list short
 * and keep each one narrow.
 */

const { contextBridge, ipcRenderer } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const native = require('../native');

contextBridge.exposeInMainWorld('cvlab', {
  /** Show the native open dialog. Resolves to a path, or null if cancelled. */
  openImage: () => ipcRenderer.invoke('dialog:openImage'),

  /** Read a file the user picked. Returns raw bytes for the renderer to decode. */
  readFile: async (filePath) => {
    const buffer = await fs.readFile(filePath);
    return new Uint8Array(buffer);
  },

  basename: (filePath) => path.basename(filePath),

  /**
   * THE FAST PATH. Invert the pixels of a canvas already in the DOM.
   *
   * contextIsolation isolates the *JS context*, not the DOM -- preload and page
   * script see the same document object. So we can pull the canvas over here
   * and keep every pixel byte inside this context. Nothing but a small result
   * object crosses the bridge.
   *
   * This matters because contextBridge deep-copies typed arrays in both
   * directions (measured, not assumed -- see docs/electron-guide.md). Handing a
   * 48 MB ImageData across and back costs two memcpys of the whole image.
   */
  invertCanvas: async (canvasId, { sync = false } = {}) => {
    const canvas = document.getElementById(canvasId);
    if (!canvas) throw new Error(`no canvas with id "${canvasId}"`);

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const started = performance.now();
    if (sync) {
      native.invertSync(image.data);
    } else {
      await native.invert(image.data);
    }
    const ms = performance.now() - started;

    ctx.putImageData(image, 0, 0);
    return { ms, width: canvas.width, height: canvas.height };
  },

  /**
   * THE SLOW PATH, kept for comparison and for the verification script.
   *
   * Accepts pixels from page script. Correct, but the array is copied on the
   * way in and again on the way out, so it must return the result -- mutation
   * is not visible to the caller. Fine for small buffers; measurably wasteful
   * for whole images.
   */
  invert: async (pixels) => {
    await native.invert(pixels);
    return pixels;
  },

  /** Same kernel on the UI thread. Exposed only to demonstrate the freeze. */
  invertSync: (pixels) => {
    native.invertSync(pixels);
    return pixels;
  },

  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  },
});
