'use strict';

/**
 * The scene editor page's bridge to the main process.
 *
 * Sandboxed, unlike the app window's preload: this page runs three.js, a GPU
 * path tracer and a WASM denoiser, and needs nothing from Node but these three
 * messages. So it gets `electron`'s sandboxed subset and no more.
 *
 * Scenes are FILES, and this is the only way the page reaches them. pt-lab's
 * own editor keeps scenes in localStorage, per origin, where nothing else can
 * read them; here Save writes scenes/<name>.json -- the file the Generate pane
 * renders, the CLI takes as --scene saved:<name>, and git can see.
 *
 * Loaded by Electron as it is, never bundled: see NOT_BUNDLED in driver.js.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cvlab', {
  /** The scenes in scenes/, by name -- the same list the Generate pane offers. */
  scenes: () => ipcRenderer.invoke('editor:scenes'),

  /**
   * One scene: { name, file, local, shared, data, models }. `models` lists
   * each imported model it includes as { key, name, glb, sha256, url }, found
   * and hash-checked, with a gen://editor/models/… URL to fetch it from.
   */
  open: (name) => ipcRenderer.invoke('editor:open-scene', name),

  /**
   * Write a scene: { name, data, local, replace, models }, where `models`
   * maps a `glb` file name to the bytes of an import the page holds. Resolves
   * with { name, file, models }; rejects with every reason it was refused.
   */
  save: (request) => ipcRenderer.invoke('editor:save-scene', request),
});
