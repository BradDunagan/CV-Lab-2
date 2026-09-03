'use strict';

const { app, BrowserWindow, WebContentsView, Menu, ipcMain, dialog } = require('electron');
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
   * The generator does not run in the app's renderer — pt-lab is a GPU path
   * tracer with three.js and an OIDN WASM blob behind it, and bundling that
   * into the renderer would cost CI a checkout and the app a few megabytes
   * for a feature the interface does not otherwise have. It gets its own
   * webContents loading dist-generate/, and progress comes back over IPC.
   *
   * What changed is WHERE that webContents lives. It used to be a separate
   * window, hidden unless a checkbox was ticked; it is now a WebContentsView
   * laid over the Generate frame's right-hand pane, so watching it converge is
   * the default rather than an option. The renderer owns the geometry --
   * paneless moves and resizes that pane and the main process cannot see it --
   * so it reports the rectangle and this positions the view to match.
   */

  /**
   * The pane rectangle the render view should occupy, in window coordinates.
   *
   * Kept even when no view exists: a run can start before the pane has
   * reported, and reporting continues while the pane is dragged mid-run.
   */
  let renderBounds = null;
  let renderView = null;

  const applyRenderBounds = () => {
    if (!renderView || !renderBounds) return;
    const { x, y, width, height } = renderBounds;
    // A zero-sized view is not an error -- a collapsed or hidden pane reports
    // one -- but Electron treats it as garbage, so floor it at a pixel.
    renderView.setBounds({
      x: Math.round(x), y: Math.round(y),
      width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)),
    });
  };

  ipcMain.removeHandler('generate:view-bounds');
  ipcMain.handle('generate:view-bounds', (_event, bounds) => {
    renderBounds = bounds;
    applyRenderBounds();
  });

  /**
   * Render into the app window instead of a window of pt-lab's own.
   *
   * Matches the shape driver.js's windowHost returns. The view is added on top
   * of the renderer's own contents, so it covers whatever the pane was showing
   * for as long as the sweep runs and is removed when it ends.
   */
  const paneHost = () => {
    const view = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    renderView = view;
    win.contentView.addChildView(view);
    applyRenderBounds();
    return {
      webContents: view.webContents,
      loadURL: (url) => view.webContents.loadURL(url),
      destroy: () => {
        renderView = null;
        if (win.isDestroyed()) return;
        win.contentView.removeChildView(view);
        view.webContents.close();
      },
    };
  };
  ipcMain.removeHandler('generate:check');
  ipcMain.handle('generate:check', () => generator.checkPrerequisites());

  /*
   * Where images go by default.
   *
   * The main process decides, not the pane, because a relative path resolves
   * against a working directory a packaged app never chose -- `/` when
   * launched from Finder -- and the pane has no way to know that.
   */
  /*
   * Which scenes there are.
   *
   * Asked for rather than listed in the renderer, because a list retyped in
   * the pane is a list that drifts: the driver grew saved scenes and the pane
   * went on offering the two literals someone had typed into it, so a scene
   * that rendered perfectly from the CLI was invisible in the app.
   */
  /*
   * The pipeline the contact sheet runs, read from pipelines/ rather than
   * typed into the renderer.
   *
   * A copy in the renderer is a copy that drifts from the file the CLI runs,
   * and the whole claim of this project is that the GUI and a script cannot
   * diverge. Same file, same statements, one execution path.
   */
  ipcMain.removeHandler('lab:pipeline');
  ipcMain.handle('lab:pipeline', (_event, name) => {
    // Name only, never a path: this reads a file on the user's disk at the
    // renderer's request, and the renderer does not get to say where from.
    if (!/^[a-z0-9-]+$/i.test(String(name))) throw new Error(`bad pipeline name "${name}"`);
    const file = path.join(__dirname, '..', 'pipelines', `${name}.lab`);
    return fsSync.promises.readFile(file, 'utf8');
  });

  ipcMain.removeHandler('generate:scenes');
  ipcMain.handle('generate:scenes', () => generator.savedSceneNames());

  ipcMain.removeHandler('generate:defaults');
  ipcMain.handle('generate:defaults', () => ({ out: generator.defaultOutputDir() }));

  ipcMain.removeHandler('generate:run');
  ipcMain.handle('generate:run', async (_event, options) => {
    try {
      const { files, truth, errors } = await generator.generate(options, (progress) => {
        if (!win.isDestroyed()) win.webContents.send('generate:progress', progress);
      }, paneHost);
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
