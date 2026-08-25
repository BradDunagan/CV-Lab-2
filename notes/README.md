# notes

Working notes. Distinct from `docs/`, and the distinction is the point.

| | Contents | Obligation |
|---|---|---|
| **`docs/`** | what a reader needs in order to use or extend the project | kept accurate |
| **`notes/`** | what was tried, what confused you, dead ends, questions, values that worked | **none** — never has to be updated |

Keeping them apart protects both. If notes lived in `docs/`, either the notes
would have to be kept tidy or the documentation would quietly lose its
authority, and neither is worth it.

## Convention

One file per day, per person, named by date:

```
notes/<person>/YYYY-MM-DD.md
```

Dated because a note is a **snapshot**, not a claim about the present. Someone
reading a note from before `merge` existed should be able to tell that at a
glance and read it accordingly — the same reason `electron-guide.md` says it
was written *after* doing the work and `design-lab-model.md` says it was
written *before*.

**A note is never wrong, only old.** Do not go back and correct one. If you
later learn something different, write it in a new entry and, if it matters,
link back. Editing yesterday's observation to match today's understanding
destroys the record of how you got here, which is often the useful part.

## What is worth writing down

The thing nobody records and everybody wishes they had: **dead ends, with
numbers**.

> Tried `minMag=0.02` on the cube — found only 6 of 9 edges. The default was
> tuned on synthetic steps with gradients near 0.5; a shaded render peaks at
> 0.0585 after thinning.

That is worth more in three months than "0.005 works". It says why, and it
stops the same experiment being run twice.

Also worth it: questions you could not answer yet, parameter values that
worked on a particular image, things that surprised you, and anything you
found yourself explaining to someone else.

## This repository is public

Anything committed here is visible to anyone who finds it, permanently, and
stays in history even if a file is later deleted. Fine for lab observations;
consider whether it is fine for everything else.

Notes you would rather keep local can go in `docs/*.txt`, which is gitignored.
