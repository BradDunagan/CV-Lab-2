# The 88: scripts and contact sheets

The analysis behind `../2026-09-12.md`, kept so every number in that note can
be rerun. Like everything in `notes/`, it is a snapshot: it reads
`results/helmet-256/` and `generated/helmet-256/` as they were on 09-12, with
`explain` at version 2, and is under no obligation to keep working after either
changes.

Plain node, no addon, no Electron. Needs both of those directories on disk;
they are gitignored, and remade by the commands in 09-11 §4 and §5.

## Running it

From this directory, in order: each script reads what the earlier ones wrote
to `out/` (gitignored).

```bash
node 01-the-88.js          # the 88, and proof the loader reproduces all 983 explain records
node 02-along.js           # the first reading: close to truth, failing on angle
node 03-control.js         # dead end 1: rotated copies are just as close
node 04-aligned-first.js   # dead end 1b: a looser matcher matches rotated copies too
node 05-jump.js gap        # dead end 2a: reads folds as steps
node 05-jump.js fixed      # the depth-pass instrument the note uses
node 05-jump.js wide       # dead end 2b: moving windows miss the step
node 06-tiers.js           # the four tiers, and the lighting-pair count
node 07-exponent.js        # how explain's residual scales with its offset
node 08-occluders.js       # match's rule against occluding truth only
node 09-junction.js        # the junction proxies, and their base rates
node 10-crops.js           # sheets/*.png and sheets/INDEX.md
```

About 25 seconds altogether, from an empty `out/`. Each prints the table the
note quotes. `01` exits non-zero if the loader stops reproducing the stored
`explain` records, because once it does, nothing after it means anything.

`10-crops.js` regenerated the committed sheets **byte-identical** to the ones
the note was written from, so the pictures and the scripts agree.

## The contact sheets

`sheets/<tier>-<n>.png`, one row per detection, three panels: the picture with
truth and explain's sample points, the normal pass, and a depth-step map.
`sheets/INDEX.md` says which detection is on which row. The colour key is at
the top of the index.

## The by-eye reading

The one step here no script makes. Recorded against the sheet rows so it can
be checked, and disagreed with.

**A1: step under the detection (23).**

| reading | n | detections |
|---|---|---|
| a junction of two occluding contours | 13 | p0-l1 #11 (the least clear), p1-l0 #83 #113 #130, p1-l1 #73 #115 #119, p2-l0 #77 #116, p2-l1 #89 #122 #127 #142 |
| cuts the corner of a single contour | 4 | p0-l1 #128 #141, p1-l1 #114, p2-l1 #158 |
| along a contour, failing match's 20° limit | 3 | p0-l1 #40, p2-l0 #29, p2-l1 #107 |
| not a step under the line after all | 3 | p1-l0 #26, p1-l1 #32 (a shading diagonal across a panel lip), p2-l0 #143 (a floor shadow touching the chin's contour) |

p2-l0 #143 and p2-l1 #158 are the same detection under the two light levels
and were read differently, which is the size of the uncertainty here.

**A2: step beside the detection (12).**

| reading | n | detections |
|---|---|---|
| a panel edge or bolt-ring rim 2-3 px from a silhouette | 10 | p0-l0 #120 #121, p0-l1 #48 #125, p1-l0 #74 #77 #119, p1-l1 #81, p2-l0 #74, p2-l1 #85 |
| at a junction | 2 | p1-l1 #136, p2-l1 #78 |

**B marginal (16)** and **C no step (37)** were looked at to confirm the tier,
not split further. C is smooth crown and rounded side parts with no break in
the normal pass. B is mostly bolt rings and panel edges.
