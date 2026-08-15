'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#16161a',
    title: 'cv-lab-2',
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

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

// Small-payload IPC: the renderer asks for a native file dialog, gets a path
// back. Pixel data never travels this way.
ipcMain.handle('dialog:openImage', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open an image',
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return canceled || filePaths.length === 0 ? null : filePaths[0];
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
