# The gap's own profile, from the render

Behind [`../2026-10-02.md`](../2026-10-02.md), kept so every number in that
note can be rerun. A snapshot like everything in `notes/`: it reads the two
linear gap sweeps as they were on 10-02 and `truthPair` from
`src/lab/gapsweep.js` as it was on that date. Under no obligation to keep
working once either changes.

Plain node, no addon, no Electron. It needs the renders and the lab's results
for them, both gitignored:

```
generated/gap-1-front-linear/     gap-*.png
generated/gap-1-front-linear-2/
results/gap-1-front-linear/       gap-*.features.json  (for the T slot only)
results/gap-1-front-linear-2/
```

`npm run gap-sweep -- --name <run> --scene saved:gap-1-front` makes a set, but a
render is a sample: a fresh one gives numbers near these, not these.

**None of this is proposed as an implementation.** It is seeded from ground
truth in three places: which pixels are in the band, where each edge starts,
and how the two edges converge along their length. It answers what the pixels
hold. The optimiser is a Nelder-Mead with restarts: slow, and nothing about it was
chosen with the determinism rules in mind.

## Running it

```bash
node 01-profile.js                                      # the note's tables; ~3 m 45 s
node 01-profile.js profile gap-1-front-linear gap-1mm   # one frame's raw profile
node 02-seeded.js                                       # fitPairs, seeded from truth
```

`02-seeded.js` belongs to the note's later section. It calls `fitPairs` from
`src/lab/pairs.js` as it was on 10-02, with the two truth edges standing in
for detections at 2, 1 and 0.5 mm, where the pipeline finds no pair of its
own below 2.

## What it prints

Per run, three blocks:

1. **Everything free.** Plateaus T (table front), S (strip), F (cube face),
   both edge positions and a Gaussian blur on top of the pixel footprint.
   `table` and `cube` are each edge's offset from its own truth, positive
   toward the Cube, as `gap-sweep`'s per-edge columns are.
2. **The gap error held** at −0.6 … +1.0 px and everything else refitted. Each
   cell is the fit's rms and the strip level it needed. A row whose rms does not
   move is a gap the pixels do not determine.
3. **S and the blur carried from the same run's 5 mm fit.** The reading a
   servo could make if it remembered the strip's brightness from when the gap
   was wide enough to see it.

`profile` prints the samples in 0.25 px bins. Samples above the middle of the
gap are shifted so the Cube's truth edge lands at the gap's mid-window value,
which keeps both steps sharp although the edges converge.

## Two things that will mislead

- **At 0 mm the truth pair's normal has no preferred sign**, and it comes out
  pointing the other way: the profile is mirrored, and a two-step fit of one
  step returns whatever it likes. The tables stop at 0.5 mm for that reason.
- **The pixel footprint is a box projected on the normal**, sampled 6 × 6.
  The fitted blur on top of it is 0.14–0.35 px, so whatever filter the tracer
  really uses, this is close; it is not known to be right.
