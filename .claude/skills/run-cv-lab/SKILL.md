---
name: run-cv-lab
description: Launch the CV-Lab Electron app and drive it with real clicks and keystrokes over CDP — open panes from the menu, set paneless fields by their labels, run commands in the command bar, screenshot, read results. Use to confirm a change works in the running app (not just in tests), e.g. a new Generate pane control, a slot pane, or a menu command.
---

# Running and driving CV-Lab

The app is an Electron window whose controls are paneless SVG controls. A
test can pass while the control a person would use does nothing, so check a
UI change by **using** it: real input events (CDP `Input.dispatch*`), not a
`Runtime.evaluate` that sets a value. `cdp.mjs`, beside this file, does that.

Verified on macOS (Apple silicon, Retina). Both commands run from the repo root.

## 1. Node 22, and build what Electron loads

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"   # or: nvm use
node -v                         # must be 22.x; the shell default here was 18.17
npm run build:renderer          # ALWAYS: Electron loads dist-renderer/, never src/
npm run build:generate          # if anything under pt-lab/ or src/generate/ changed
```

- **There is no dev server.** A stale `dist-renderer/` means you are testing
  old code, and nothing will say so.
- **`build:generate` checks that every pt-lab method the pages call is
  defined.** Read its last line.
- **Rebuild after switching branches.** Both builds come from whatever is
  checked out, so a bundle left over from another branch tests the wrong
  code.
- **Node 18 fails inside Vite** with a `styleText` export error. That is the
  Node version, not the code.

## 2. Launch with both debug ports, in the background

```bash
npx electron . --remote-debugging-port=9333 --inspect=9334
```

Run it as a background command. Port 9333 is the renderer, the app window;
port 9334 is the main process's Node inspector. Then:

```bash
D=.claude/skills/run-cv-lab/cdp.mjs
node $D wait                    # prints "ready" once both answer and window.lab exists
```

## 3. Drive it

```bash
node $D menu generate           # Panes → Generate Images…
node $D set positions 1         # the editbox right of the label "positions"
node $D choose scene gap-1      # the dropdown right of "scene": open it, pick the item
node $D check ground truth      # a checkbox, by its own text
node $D press Generate          # a button, by prefix ("Generate 1" matches)
node $D command "A = pattern(kind=checker, width=64, height=64)"   # the command bar
node $D shot /tmp/x.png         # then LOOK at it (Read the PNG)
```

Menu ids, from `src/menu.js`: `open-image`, `save-session`, `reset-session`,
`new-slot-pane`, `new-log-pane`, `scene-editor`, `generate`,
`toggle-overlay`, `toggle-truth`, `reset-view`.

`menu <id>` sends exactly what the menu item's click sends,
`webContents.send('menu:command', id)` from the main process. A native macOS
menu cannot be clicked over CDP, and its accelerators (⌘G) do not fire from
synthetic keys.

Lower-level commands, for anything the label-based ones don't reach:

- `find <text>`: every visible element with that exact text, with its CSS
  centre and its paneless control type.
- `click <x> <y>`: a real click at CSS pixels.
- `click-text <text> [n]`: click the n-th element showing that text.
- `key Enter|Tab|Backspace|Escape` and `type <text>`.
- `eval <js>`: evaluate in the renderer.
- `main <js>`: evaluate in the main process. Use `process.mainModule.require`
  there, because bare `require` is not in the inspector's scope.

## 4. Check the result where the user would

- **The status bar:**
  `node $D eval "[...document.querySelectorAll('*')].map(e=>e.children.length?'':(e.textContent||'').trim()).find(t=>t.startsWith('Generated '))"`
- **The session:** `node $D eval "window.lab.sessionJSON().entries.map(e => e.text)"`
- **Files:** the Generate pane writes to `generated/` by default (dev runs).
  It **overwrites** `generated/p0-l0.png` and its `.gt.json`, so point `out`
  somewhere else, with `set out <dir>`, if those matter.
- **A screenshot.** Look at it. A control that reports success can still be
  unchanged.

## 5. Stop it

```bash
pkill -f "electron . --remote-debugging-port=9333"
```

The background command then exits with 144, which is expected.

## Traps, each one met while writing this

- **A screenshot is in device pixels; clicks are in CSS pixels.** On a Retina
  display, divide what you read off a screenshot by `devicePixelRatio` (2).
  Better still, use the label-based commands, which never need coordinates.
- **`sips --cropOffset` takes y, then x.** Swapping them crops the wrong place
  and sends you clicking somewhere that is not what you looked at.
- **A frame's edges are resize handles.** A `div.resize-edge` lies over the
  frame border and swallows clicks near it. `node $D eval
  "document.elementsFromPoint(x, y).map(e => e.className)"` shows what is
  really under a point.
- **A paneless checkbox toggles on its box, not its text.** `check` clicks
  the box. Clicking the words reports nothing and changes nothing.
- **Clicks need pacing.** Move, press and release sent back to back missed a
  dropdown item. `cdp.mjs` pauses between them.
- **The command bar's `A = pattern(...)` is a placeholder.** The input starts
  empty.
- **zsh does not split an unquoted `$VAR` into words.** A list of files held
  in a variable arrives as ONE argument. Pass globs directly, or use
  `${=VAR}`.
- **Other pages share port 9333.** The generator and the Scene Editor run
  their own pages; `cdp.mjs` picks the window whose URL contains
  `dist-renderer`.
