'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const { buildMenu } = require('./menu');
const generator = require('./generate/driver');

/*
 * Must happen before the app is ready. Harmless when generation is never used:
 * it registers a scheme, it does not start anything.
 */
generator.registerScheme();

/*
 * The name the operating system shows, which is not the package name.
 *
 * package.json says "cv-lab-2" because npm names are lowercase identifiers,
 * and app.name defaults to it -- so without this the menu bar, the About panel
 * and every "Quit …" item would read "cv-lab-2", or "Electron" when running
 * unpackaged, since Electron falls back to its own bundle.
 *
 * Must be set BEFORE the app is ready: role: 'appMenu' bakes the name into
 * "About X", "Hide X" and "Quit X" when the template is built.
 *
 * Note it also decides app.getPath('userData'), so changing it starts a fresh
 * directory. Nothing but paneless's sidebar-collapsed flag lives there.
 */
app.setName('CV-Lab');

/**
 * What the menu needs to know about the renderer, mirrored here.
 *
 * The renderer owns this state; the menu only reflects it. It is kept in the
 * main process because a menu template is a snapshot -- Electron does not
 * re-read it -- so the menu has to be rebuilt when any of this changes.
 */
const menuState = { scaling: 'smooth', overlay: true, viewIsReset: true };

function installMenu(win) {
  Menu.setApplicationMenu(
    buildMenu({
      state: menuState,
      send: (id) => win?.webContents.send('menu:command', id),
    })
  );
}

function createWindow() {
  const win = new BrowserWindow({
    /*
     * Wide enough for two slot frames side by side now that each one is a
     * controls column plus an image, rather than an image alone: two of them
     * want about 1010px of the slot area, which this leaves after the log.
     * Below that the tiling drops to a single column by itself -- see
     * slotGrid() in App.svelte -- so a smaller window degrades rather than
     * pushing frames off the edge.
     */
    width: 1680,
    height: 900,
    minWidth: 720,
    minHeight: 520,
    // Matches app.css's body background, so the first paint before the
    // renderer loads is not a flash of a different colour.
    backgroundColor: '#e0e0e0',
    title: 'CV-Lab',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),

      // Keep these two as they are. contextIsolation puts the preload in its
      // own JS context; nodeIntegration off means page script never sees
      // require(). Together they are what makes the preload bridge safe.
      contextIsolation: true,
      nodeIntegration: false,

      // Deliberate trade-off, documented in docs/electron-guide.md:
      //
      // With sandbox: true (the default) the preload only gets a polyfilled
      // subset of Node and cannot require() a real .node binary. Turning the
      // sandbox off lets the native addon live in the renderer process, so
      // pixel buffers never cross a *process* boundary. It also lets the
      // preload own the whole pixel pipeline, which keeps them from crossing
      // the contextBridge either -- see docs/electron-guide.md for the numbers.
      //
      // The cost is that this renderer is no longer inside Chromium's OS
      // sandbox, so it must only ever load local, first-party content. Never
      // point this window at a remote URL.
      sandbox: false,
    },
  });

  /*
   * The BUILT renderer, not the source. src/renderer/ is Svelte and needs
   * Vite; dist-renderer/ is what Vite produces.
   *
   * A file:// URL, always -- there is no dev server, deliberately. The
   * `sandbox: false` trade-off below is conditional on this window only ever
   * loading local, first-party content, and pointing it at http://localhost
   * during development would make that a habit rather than a guarantee.
   * `npm run dev` rebuilds on change instead.
   */
  const page = path.join(__dirname, '..', 'dist-renderer', 'index.html');
  if (!fsSync.existsSync(page)) {
    dialog.showErrorBox(
      'The renderer has not been built',
      `Expected ${page}\n\nRun: npm run build:renderer`
    );
    app.quit();
    return win;
  }
  win.loadFile(page);
  installMenu(win);

  /*
   * The renderer tells the main process when a setting it owns changes, so
   * the menu's radio and checkbox items stay truthful. One-way and small:
   * no pixels, no handles, just which scaling mode is current.
   */
  /*
   * Image generation, driven from the Generate frame.
   *
   * The generator runs in its OWN window loading dist-generate/, not in the
   * app's renderer — pt-lab is a GPU path tracer with three.js and an OIDN
   * WASM blob behind it, and bundling that into the app would cost CI a
   * checkout and the app a few megabytes for a feature the interface does not
   * otherwise have. So progress comes back over IPC instead, and the app shows
   * it rather than hosting it.
   */
  ipcMain.removeHandler('generate:check');
  ipcMain.handle('generate:check', () => generator.checkPrerequisites());

  /*
   * Where images go by default.
   *
   * The main process decides, not the pane, because a relative path resolves
   * against a working directory a packaged app never chose -- `/` when
   * launched from Finder -- and the pane has no way to know that.
   */
  ipcMain.removeHandler('generate:defaults');
  ipcMain.handle('generate:defaults', () => ({ out: generator.defaultOutputDir() }));

  ipcMain.removeHandler('generate:run');
  ipcMain.handle('generate:run', async (_event, options) => {
    try {
      const { files, truth, errors } = await generator.generate(options, (progress) => {
        if (!win.isDestroyed()) win.webContents.send('generate:progress', progress);
      });
      return { ok: true, files, truth, errors };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.removeHandler('menu:state');
  ipcMain.handle('menu:state', (_event, next) => {
    Object.assign(menuState, next);
    installMenu(win);
  });

  return win;
}

// Small-payload IPC only. Pixel data never travels this way: it stays in C,
// owned by the preload context (design-lab-model.md §8).
ipcMain.handle('session:save', async (event, sessionJson) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save session',
    defaultPath: 'session.cvlab.json',
    filters: [{ name: 'cv-lab session', extensions: ['json'] }],
  });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, JSON.stringify(sessionJson, null, 2), 'utf8');
  return filePath;
});

ipcMain.handle('dialog:openImage', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open an image',
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return canceled || filePaths.length === 0 ? null : filePaths[0];
});

ipcMain.handle('session:confirmReset', async (event, entries) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    message: 'Discard the session?',
    detail: `${entries} log ${entries === 1 ? 'entry' : 'entries'} and every slot will be ` +
      `thrown away. The log is the record of how these results were produced — ` +
      `once discarded it cannot be recovered.`,
    buttons: ['Cancel', 'Save first…', 'Discard'],
    defaultId: 0,
    cancelId: 0,
  });
  return ['cancel', 'save', 'discard'][response];
});

app.whenReady().then(() => {
  // macOS shows this panel from the app menu; without it the name comes from
  // the Electron bundle rather than from setName above.
  app.setAboutPanelOptions({
    applicationName: 'CV-Lab',
    applicationVersion: require('../package.json').version,
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
