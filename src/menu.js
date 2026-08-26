'use strict';

/**
 * The application menu.
 *
 * The lab's global commands live here rather than in the interface, because
 * the window chrome already names the app twice on macOS -- title bar and
 * menu bar -- and paneless's own title-click menu is a third place with no
 * label on it. A native menu is the conventional home for these and shows
 * their state properly: the scaling modes are a radio group, the fits overlay
 * is a checkbox.
 *
 * TWO ROLES ARE LOAD-BEARING and easy to lose by accident. Until this file
 * existed, `Menu.setApplicationMenu` was never called, so Electron installed
 * its DEFAULT menu -- and that default is what provided:
 *
 *   - editMenu: Cmd/Ctrl+C, V, X, A in the command input. Without it, copy
 *     and paste stop working in a text field and nothing explains why.
 *   - viewMenu: Toggle Developer Tools, plus reload and zoom.
 *
 * The moment a custom template is installed both vanish unless they are
 * asked for. They are asked for below.
 */

const { Menu, app, shell } = require('electron');

/**
 * Menus are static once installed: Electron takes a snapshot of the template,
 * so a checkbox does not follow the renderer's state on its own. The renderer
 * reports state changes over IPC and the whole menu is rebuilt -- cheap, and
 * far simpler than trying to mutate individual items.
 */
function buildMenu({ state, send }) {
  const isMac = process.platform === 'darwin';

  const command = (id) => () => send(id);
  const scaling = (mode) => ({
    label: mode,
    type: 'radio',
    checked: state.scaling === mode,
    click: () => send(`scaling:${mode}`),
  });

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),

    {
      label: 'File',
      submenu: [
        { label: 'Open Image…', accelerator: 'CmdOrCtrl+O', click: command('open-image') },
        { type: 'separator' },
        { label: 'Save Session…', accelerator: 'CmdOrCtrl+S', click: command('save-session') },
        { label: 'Discard Session…', click: command('reset-session') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },

    // Not optional. This is where Cmd+C/V/X/A in the command input come from.
    { role: 'editMenu' },

    {
      label: 'View',
      submenu: [
        {
          label: 'Scaling',
          submenu: ['smooth', 'pixels', 'actual'].map(scaling),
        },
        {
          label: 'Draw fits over tiles',
          type: 'checkbox',
          checked: state.overlay,
          click: command('toggle-overlay'),
        },
        {
          label: 'Reset View',
          accelerator: 'CmdOrCtrl+0',
          enabled: !state.viewIsReset,
          click: command('reset-view'),
        },
        { type: 'separator' },
        // Reload is deliberately absent: this window loads a built bundle and
        // reloading it discards every buffer the preload owns, with no warning
        // and no way back. Developer tools stay.
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },

    {
      label: 'Panes',
      submenu: [
        { label: 'New Slot Pane', accelerator: 'CmdOrCtrl+N', click: command('new-slot-pane') },
        { label: 'New Log Pane', click: command('new-log-pane') },
      ],
    },

    { role: 'windowMenu' },
  ];

  return Menu.buildFromTemplate(template);
}

module.exports = { buildMenu };
