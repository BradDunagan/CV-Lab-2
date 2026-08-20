# Glossary

Terms used in `design-lab-model.md` and `electron-guide.md`, explained from
scratch. The prose in those documents deliberately uses the words practitioners
use — this is the lookup table, not a replacement for them.

Grows on request. If a term is missing, it belongs here.

---

## DAG — directed acyclic graph

**A set of things connected by one-way arrows, with no way to follow the arrows
in a circle.**

Taken a word at a time:

- **graph** — nodes (things) joined by edges (connections). Nothing to do with
  charts or plotting.
- **directed** — each edge has a direction. `A → B` is not the same as `B → A`.
- **acyclic** — no cycles. Start anywhere, follow arrows as long as you like,
  and you can never arrive back where you began.

**Why the shape matters here.** Provenance forms a DAG. Each log entry points
back at the entries that produced its inputs, so the arrow means *"was produced
from"*. It is acyclic because a result cannot be its own ancestor — time runs
one way.

It is a DAG rather than a **tree** because a node may have several parents, and
one node may be reached by more than one route. In §5's example:

```
#1 A ──► #2 B ──► #3 C ──► #4 D ──┐
   │                              ├──► #5 E
   └──────────────────────────────┘
```

`E` depends on `A#1` twice over — directly, and through the `B → C → D` chain.
A tree would require exactly one path to each node; here there are two. That is
the whole difference.

**Why "acyclic" is worth guaranteeing.** Because the graph has no cycles, you
can always find a valid order to evaluate things in (a *topological sort*), and
walking the ancestry always terminates. A cycle would mean a result that
depends on itself, which is both meaningless and an infinite loop.

**Other DAGs you have met**: git history (commits point at parents), build
dependencies in `make`, spreadsheet formula dependencies.

---

## Sidecar (sidecar file)

**A separate file stored next to a main file, holding information *about* it,
rather than putting that information inside the main file.**

Named after the passenger car bolted to the side of a motorcycle — it travels
alongside, but is not part of the bike.

```
exports/edges.png          ← the image
exports/edges.png.json     ← the sidecar: how that image was produced
```

**Why not just put it inside the file?** Sometimes you cannot: the format may
have nowhere to store arbitrary metadata. Sometimes you should not: writing to
the original changes its bytes, and therefore its content hash — which for this
project would undermine the very thing the metadata is recording.

**The cost:** the two can become separated. Copy the image somewhere and forget
the sidecar, and the provenance is gone. Nothing enforces the pairing except
the shared filename.

**In this project:** §5 proposes a sidecar on image export, carrying the
ancestry of just that slot, so an exported PNG can still answer "how was this
made?"

**Elsewhere you will meet them**: `.xmp` files beside camera raw images,
`.srt` subtitles beside a video, `.json` label files beside images in machine
learning datasets.
