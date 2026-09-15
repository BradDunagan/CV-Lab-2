# Two checks before an `explain` v3: scripts and contact sheets

Behind `../2026-09-15.md`. A snapshot like everything in `notes/`: it reads
`results/` and `generated/` for helmet-256, helmet-512 and clutter as they were
on 09-15, all three at `explain` v2.

Plain node. It uses 09-12's loader as committed
(`../2026-09-12-the-88/load.js`). The jump fit and the crop drawing are
*copied* from 09-12's scripts into `lib.js`, so that directory never has to
change for this one.

## Running it

```bash
node 01-measure.js     # every segment on all three sets -> out/<set>.json; exits non-zero
                       # if the loader stops reproducing the stored explain records
node 02-compare.js     # the rule comparison tables
node 03-crops.js       # sheets/*.png and sheets/INDEX.md
```

Each takes set names to restrict it (`node 02-compare.js helmet-512`).
`01-measure.js` takes a few seconds per set. `out/` is gitignored.

## The sheets

- `helmet-256-<n>.png`, `helmet-512-<n>.png`: matched v2 occlusions that the
  jump-fit rule reclassifies, where the truth edge they matched is a
  silhouette or boundary. 19 and 48.
- `helmet-512-lost-real-steps-0.png`: the two real steps (by 09-10's growth
  test) the jump-fit rule stops calling occlusion.

Same three panels as 09-12: picture + truth + explain's samples, normal pass,
depth-step map. `sheets/INDEX.md` gives every row's numbers.

The by-eye reading of the helmet-256 sheets is in the note, detection by
detection. At helmet-512 only sheets 0, 2, 4 and 6, plus the lost-real-steps
sheet, were looked at.
