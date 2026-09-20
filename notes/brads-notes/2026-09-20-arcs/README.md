# Curved edges on the nut: the probe and its overlays

Behind [`../2026-09-20.md`](../2026-09-20.md), kept so every number in that
note can be rerun. A snapshot like everything in `notes/`: it reads
`assets/nut-1-10x-256x256.png` as it was on 09-20 and runs `segments` and
`merge` at the defaults `ops.js` declared on that date. Under no obligation to
keep working once either changes.

Plain node — it calls the addon, but not Electron. Needs `npm run build:native`
and nothing else; `assets/` is gitignored and this is the one image it wants.

**None of this is proposed as an implementation.** It is the cheapest thing
that answers one question — do the nut's curves survive detection as coherent
regions — written in JS so that no C had to be committed to before knowing.
`lib.js` marks the places a real fitter would differ, and there are three that
matter: the circle fit is Kåsa (biased small on short arcs, where Pratt or
Taubin are not), the conic fixes `f = 1` and is unconstrained, and the
largest-gap sweep is untested at rotations near the branch cut.

## Running it

```bash
node 01-arcs.js         # the note's numbers, and sheets/nut-arcs.png
node 01-arcs.js naive   # the dead end: chaining without the circle test
node 02-minmag.js       # the threshold sweep; takes values, e.g. 0.003 0.05
```

`01-arcs.js` is about a second. Both write into `sheets/`; `out/` is
gitignored and holds nothing either script needs.

## The sheets

Each is the subject dimmed to 45%, with every labelled pixel drawn over it —
**blue** stays straight, **yellow** prefers an arc, **red** belongs to a chain
— and each chain's fitted arc in **green**, drawn only between its own
endpoints. A `-3x.png` copy sits beside each one, because at 256 px the marks
are a single pixel wide and nothing about them is legible.

- `nut-arcs.png` — what the note reports. The green follows the rim, the
  threads and both shadow boundaries.
- `nut-arcs-naive.png` — the dead end, and the reason the circle test is not
  optional. Chaining on endpoint distance and turn angle alone produces a
  5-piece, 134.5° chain and a 5-piece, **326.9°** one, and the picture shows
  what they are: a curve swept around the hexagon, which presents exactly that
  signature at every vertex. The tables say it too, once you look at the right
  column — `circMax` of 3.7 and 10.3 px against a 1.0 px tolerance — but the
  run where this was found printed `circRMS` and not `circMax`, and 1.4 px RMS
  did not look obviously wrong. The overlay did.

Drawing the whole fitted circle rather than the arc hid it for a run before
that: three hundred pixels of curve that no evidence supports, laid over
everything.

## What each script prints

`01-arcs.js`, in order:

1. the label counts, and that **`merge` joins nothing at all** here (74 in,
   74 out) — pieces of a curve are not collinear, so it has nothing to do
2. how many labels prefer an arc to a line under the three gates — **2 of 74**,
   which is the note's finding
3. the twelve largest of each class, so the gates can be second-guessed; note
   three straight labels already sit at gain 1.07–1.21 on noise alone
4. the chains, with a mean thinned magnitude per chain. No AOVs ship with
   `assets/`, so `explain` cannot run and nothing here can *say* a chain is a
   shadow; contrast is evidence, not a verdict
5. piece length against the two ceilings — `√(12·r·maxRes)` from the
   straightness test and `r·angleTol` from the direction test — and which one
   binds. **Angle in 9 of 12**, which was the surprise
