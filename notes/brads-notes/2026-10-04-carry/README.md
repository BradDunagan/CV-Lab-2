# Carrying values down an approach

Plain-node experiments for the "later still" section of `../2026-10-04.md`.
Each one reads a gap sweep's renders and features and fits again in
JavaScript, frame by frame down each view's approach (widest gap first), with
values carried from an earlier frame.

```bash
node notes/brads-notes/2026-10-04-carry/carry.js gap-grid-1 3     # the strip level only
node notes/brads-notes/2026-10-04-carry/track.js gap-grid-1       # line, level and aperture: trackPair
node notes/brads-notes/2026-10-04-carry/track.js stack-2g-approach
```

- `lib.js` rebuilds G, the pipeline's gray image, from the PNG: inflate and
  unfilter, the byte-to-linear table `native/addon_buffer.c` builds, and the
  luminance in `native/kernels.c`, both in float32. **This is not how the lab
  loads an image**: it borrows Chromium's decoder, deliberately, so that a
  batch path cannot drift from the app (`scripts/lab-cli.js`). Checked against
  the pipeline's own P records on two stack frames: the gaps agree to 1e-7 px.
  Good enough for an experiment, and the reason this lives in notes.
- `carry.js` holds the strip level (`strip=held`) in `fitPairs` and
  `findPairs`, carried from the last frame whose refit read the pair over
  `minPx` (default 2; 3 is better -- at 2.4 px the fitted level is itself
  still traded against width).
- `track.js` carries the still part's fitted edge, the strip level and the
  aperture from the widest frame that read each pair over 3 px, and calls
  `pairs.trackPair` in every frame after it. The tracked gap is read at the
  truth's measuring point, along the carried line's normal.

Both write `results/<run>/carry.json` or `track.json`, and print a table per
gap.

`stack-2g-approach` was rendered for this:

```bash
npm run gap-sweep -- --name stack-2g-approach --scene saved:stack-2 --moving Cube2 --target Cube \
    --axis 0,1,0 --gaps 5,2,1,0.5,0 --yaw 35,60 --elevation 20,50 --script pipelines/pairs.lab
```
