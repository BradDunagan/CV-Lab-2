# git and GitHub, as this project uses them

Every change to this repository goes through the same handful of operations: a
branch, some commits, a push, a CI run on three machines, and a merge that keeps
the history in a straight line. This document explains those operations **in the
order you meet them**, using the actual commands and the actual output from this
repository rather than a generic tutorial's.

It is a reference, not a course. Read it once end to end, then come back to the
section you need. Where something is a genuine trap rather than a detail, it is
marked **Trap**.

Two things it assumes: `git` (2.50 here) and the GitHub CLI, `gh` (2.97 here),
already authenticated. `gh auth status` tells you if it is.

---

## 1. Why any of this, on a one-person project

Three of the four operations pay for themselves even with nobody else reading:

| | what it buys |
|---|---|
| **branch** | `main` always builds. Work in progress never sits on the branch that gets packaged. |
| **CI** | Linux and Windows compile the native addon and run the suite. Your laptop is macOS only, and the determinism test is meaningless on one platform. |
| **rebase merge** | history stays a straight line of readable commits instead of a thicket of merge bubbles. |

The fourth, **pull requests**, is the one that is optional here — see §8.

---

## 2. The shape of a change

Everything follows this, and only §7 varies:

```
main ──●──────────────────────────────●──  (fast-forwarded, never diverges)
        \                            /
         ●───●───●  branch, commits ─
              ↑
          CI runs here, before it lands
```

1. Branch off `main`
2. Commit, as many times as there are ideas
3. Push the branch
4. Get CI to run on it
5. When green, land it on `main`
6. Delete the branch

---

## 3. Vocabulary, in the order it bites

**commit** — a snapshot of the whole tree plus a message, identified by a hash
(`96f8bb0`). Not a diff, though git shows it as one.

**branch** — a movable label pointing at one commit. Creating one is free: it
writes 41 bytes. This is why branching per change costs nothing.

**HEAD** — where you are. `git status` says `On branch main` because HEAD points
at `main`.

**remote / `origin`** — the copy on GitHub. Here:
`https://github.com/BradDunagan/CV-Lab-2.git`.

**`origin/main`** — your *local record* of where `origin`'s `main` was **the
last time you fetched**. It is not live. This is why `git fetch` comes before
any comparison you intend to trust.

**upstream** — the remote branch a local branch tracks. `git push -u` sets it.
Until then a branch has none, which matters in §5.

**fast-forward** — moving a branch label forward along a line that already
exists, because nothing diverged. No merge commit, nothing to resolve.

---

## 4. The commands, in order

### Branch

```bash
git checkout -b contact-sheet
```

Creates and switches. The branch starts wherever you were, so **be on an
up-to-date `main` first**:

```bash
git checkout main && git pull --ff-only
git checkout -b contact-sheet
```

`--ff-only` refuses rather than creating a merge commit if things diverged. On a
one-person repo it should always succeed; the day it does not, you want to be
told, not accommodated.

### Commit

```bash
git add src/renderer/App.svelte test/renderer.js   # by name
git commit                                          # opens an editor
```

**Trap — `git add -A` and `git add .`.** They stage everything, including files
you have not looked at. This repository has a scar from it: a renderer build
once wrote 92 files into the project root and `git add -A` committed 83 of them
under a stat line reading *"105 files changed, 70315 insertions(+)"*. Both
`.gitignore` and `test/repo.js` now guard against it, but the habit that caused
it was `-A`. Stage by name.

Check before committing:

```bash
git status --short     # M = modified, A = added, ?? = untracked
git diff               # unstaged changes
git diff --staged      # what the commit will actually contain
```

### Push the branch

```bash
git push -u origin contact-sheet
```

`-u` sets the upstream so later pushes are a bare `git push`.

**Trap.** This runs **no CI**. See §6.

### Land it

```bash
git checkout main
git merge --ff-only contact-sheet     # moves the label; no merge commit
git push
git branch -d contact-sheet           # delete the local branch
git push origin --delete contact-sheet
```

---

## 5. Reading "ahead" and "behind"

The question is always: what does one branch have that the other does not?

```bash
git rev-list --count main..contact-sheet          # 3   — ahead
git rev-list --left-right --count main...contact-sheet
#   0    3
#   ↑    ↑
#  behind ahead
```

**The dots are the whole thing.**

- `main..branch` — **two** dots — commits reachable from `branch` but not from
  `main`. Reverse the names for the other direction.
- `main...branch` — **three** dots — the symmetric difference: everything unique
  to *either* side. With `--left-right --count` you get both numbers at once.

`0 3` means nothing on `main` that the branch lacks — a clean fast-forward.

To see *which* commits rather than how many, same two-dot range:

```bash
git log --oneline main..contact-sheet
```

**Trap — `git status` compares to the wrong thing.** It prints `[ahead 3]`, but
only against the branch's **upstream**, never against `main`. An unpushed branch
has no upstream, so it prints nothing at all:

```
## contact-sheet          ← no counts, and none coming
```

`git branch -v` has the same limitation. Use `rev-list` when the question is
"how does this compare to `main`".

**Trap — stale comparisons.** `origin/main` is a cached value. Always:

```bash
git fetch origin
git rev-list --left-right --count origin/main...my-branch
```

**Trap — `git branch -r` lists branches that no longer exist.** A plain `git
fetch` adds and updates remote-tracking refs and **never deletes** them. So a
branch removed on GitHub — which is what `gh pr merge --delete-branch` does, and
the web UI's button after a merge — leaves its `origin/<name>` behind locally,
forever, and `git branch -r` goes on printing it.

Five of them had accumulated here. Trying to clean them up is what said so:

```
$ git push origin --delete ci-deprecations contact-sheet explain-aovs \
                           explain-maxdepth paneless-ui saved-scenes
error: unable to delete 'ci-deprecations': remote ref does not exist
error: unable to delete 'contact-sheet': remote ref does not exist
error: unable to delete 'explain-aovs': remote ref does not exist
error: unable to delete 'explain-maxdepth': remote ref does not exist
error: unable to delete 'saved-scenes': remote ref does not exist
error: failed to push some refs
```

Only `paneless-ui` was real. Note what the last line means: **one push deleting
six refs deleted none of them.** Five bogus names took the real one down with
them, and `paneless-ui` was still on `origin` afterwards.

The authority on what is actually there is the remote itself, not your cache of
it:

```bash
git ls-remote --heads origin     # asks origin; no local refs involved
git fetch --prune                # drops every origin/* whose branch is gone
```

`--prune` is the same idea as the stale comparison above, one level up:
`origin/main` being a cached *value* is documented in §3, and the *set* of
`origin/*` refs is cached exactly as hard. Fetch updates the values and leaves
the set alone.

---

## 6. CI: what runs it, and what it does

The workflow is `.github/workflows/build.yml`. It triggers on:

```yaml
on:
  push:
    branches: [main]      # a push to main
    tags: ["v*"]
  pull_request:           # a PR opened or updated
  workflow_dispatch:      # run it by hand
```

**Trap, and the most important line in this document: pushing a branch runs
nothing.** `push` is limited to `main`. A branch push matches no trigger. To get
CI on a branch you need either a pull request or:

```bash
gh workflow run build.yml --ref contact-sheet
```

### What it actually does

Three machines — macOS, Ubuntu, Windows — each: check out this repo *and* the
sibling `paneless-workspace` and `pt-lab` repos, build the native addon twice
(Node ABI, then Electron ABI), run all fourteen suites, package the app, and
**launch the packaged artifact and ask whether it works**.

That last one exists because it had to. `verify:package` checked that the right
files were in the installer and passed on every release while the packaged app
was dead on launch — the preload required a file that was never packaged. Layout
is not behaviour. `smoke:package` starts the real thing.

The determinism suite is the reason all three machines matter: it asserts the
same input produces byte-identical output everywhere, which one machine cannot
tell you.

### Watching and reading a run

```bash
gh run list --limit 5
gh run watch <run-id> --exit-status     # blocks until it finishes
gh run view <run-id> --json status,conclusion,jobs \
  --jq '"\(.status)/\(.conclusion)", (.jobs[] | "  \(.name)\t\(.conclusion)")'
gh run view <run-id> --log-failed       # only the failing steps
gh run view <run-id> --log > /tmp/ci.log   # everything, for grepping
```

**Read the log for warnings, not only for the green tick.** That is how the
dead-on-launch packaging bug survived three green checkmarks. `grep -i warning`
over the full log is a thirty-second habit worth having.

---

## 7. Pull request, or just push?

For this repository, a PR buys **one** thing: CI runs *before* the code is on
`main` rather than after.

That is not hypothetical. PR #3 in this repo failed on all three platforms on
its first run — a test depended on the generator being built, which CI never
does. Pushed straight to `main`, that would have been a red default branch and a
fix-forward commit.

What a PR does **not** buy here:

- **Review** — there is no second reviewer.
- **A place for the reasoning** — the commit messages already carry it, and
  carry it better: they are in `git log` forever, they travel with a clone, and
  they surface in `git blame`. A PR body lives on GitHub and is rarely read
  twice.

It costs an extra CI run: once on the PR, once on `main` after the merge.

**The lean alternative, which keeps the only real benefit:**

```bash
git push -u origin my-branch
gh workflow run build.yml --ref my-branch    # CI on the branch, no PR
# ... wait for green ...
git checkout main && git merge --ff-only my-branch && git push
```

**Use a PR when** you want a durable URL and a rendered diff to come back to —
a visible feature, or a change you may need to explain in six months. **Skip it
for** docs, notes, dependency bumps, and anything whose diff you will never
browse again.

### Opening one

```bash
gh pr create --base main --head my-branch --title "..." --body "..."
gh pr view 4 --json state,mergeable,mergeStateStatus,statusCheckRollup
gh pr merge 4 --rebase --delete-branch
```

Before merging, `mergeStateStatus: CLEAN` and `mergeable: MERGEABLE` mean
GitHub agrees it will go in without conflict.

---

## 8. Why `--rebase`, and why the hashes change

`gh pr merge` offers three ways in:

| flag | result |
|---|---|
| `--merge` | a merge commit; history forks and rejoins |
| `--squash` | all commits flattened into one |
| `--rebase` | commits replayed onto `main`, one after another |

This project uses **`--rebase`**, for two reasons that both matter here.

**History stays linear.** `git log --oneline` reads as a sequence of decisions.

**The individual commit messages survive.** `--squash` would destroy them, and
in this repository that is the actual loss: the messages carry the reasoning,
including the places where a decision was made and later corrected. `git log` is
part of the record.

### The consequence to expect

**Rebasing rewrites the commits, so their hashes change.** The same content gets
new identity:

```
before merge:  af55776 test: the scene-list check ...
after merge:   eb1e5d4 test: the scene-list check ...
```

**Trap.** Your *local* branch still points at the old hashes, so git no longer
believes it was merged:

```bash
$ git branch -d saved-scenes
error: the branch 'saved-scenes' is not fully merged
```

It is merged; git is comparing hashes, not content. Confirm and force:

```bash
git diff --stat main saved-scenes    # empty output = identical content
git branch -D saved-scenes           # capital D
```

Always run the `diff` first. `-D` deletes without checking, and the check is
the only thing standing between you and losing work you forgot you had.

---

## 9. This repository's temperament

Conventions that are not git's, but are this project's.

### Commit messages carry the reasoning

Not "fix bug". The message says what was wrong, why the fix is that fix, and
what was tried and rejected — including corrections to earlier commits. Several
sections of `design-lab-model.md` were wrong until measurement said otherwise,
and both the claim and the correction are written down.

A subject line that reads as a sentence, then a body. `git log` is documentation
that cannot drift, because it describes a moment rather than the present.

### One idea per commit

If a change does two things, it is two commits. Splitting after the fact is
work, but a commit that does one thing can be read, reverted and explained on
its own.

### Notes are dated and never corrected

`notes/` is one file per day per person, `notes/<person>/YYYY-MM-DD.md`. **A
note is never wrong, only old.** Do not edit yesterday's to match today's
understanding — write a new entry. `docs/` is kept accurate; `notes/` never has
to be.

### The repository is public

Anything committed is visible permanently and stays in history even if deleted
later. This is why `scenes/*.local.json` is gitignored: a place for scenes a
working copy should have and the world should not.

### The sibling checkouts

`package.json` resolves paneless as `file:../paneless-workspace/packages/paneless`
— a *sibling directory*, not a registry package. So:

- Changing paneless is a commit in **a different repository**, with its own
  history and its own push.
- CI checks paneless out with **no `ref:`**, so it takes that repo's default
  branch. A paneless change must be **pushed first**, or cv-lab's CI builds
  against the old code.
- paneless is private, so CI needs a personal access token in the
  `PANELESS_TOKEN` secret. When it expires, `checkout` starts failing with
  nothing pointing at the reason — which is why `build.yml` validates the token
  in its own step and tells the three failure cases apart.

### Node versions differ per repo

`.nvmrc` pins `22` here and `24.11.0` in paneless. `nvm use` per directory. On
the wrong version Vite fails with a `styleText` export error from deep inside a
plugin, which looks like a broken dependency and is not — see
`notes/brads-notes/2026-09-03.md`.

---

## 10. When something goes wrong

**"I committed to `main` by mistake, not pushed yet."**
```bash
git branch my-work            # save the commit on a branch
git reset --hard origin/main  # put main back
git checkout my-work
```

**"I want to undo the last commit but keep the changes."**
```bash
git reset --soft HEAD~1       # commit undone, files still staged
```

**"I need to see what a commit actually changed."**
```bash
git show <hash>
git show <hash> --stat        # files only
```

**"CI failed and I cannot tell where."**
```bash
gh run view <run-id> --log-failed
```

**"Did my change actually land?"**
```bash
git fetch origin
git log --oneline -3 origin/main
```

**"What state is everything in?"**
```bash
git status --short --branch
git branch                    # local branches; * is current
gh pr list --state open
```

---

## 11. One page of commands

```bash
# start
git checkout main && git pull --ff-only
git checkout -b my-change

# work
git status --short
git diff
git add <files by name>
git diff --staged
git commit

# compare
git rev-list --left-right --count main...my-change    # behind  ahead
git log --oneline main..my-change

# get CI on it
git push -u origin my-change
gh workflow run build.yml --ref my-change             # ...or open a PR
gh pr create --base main --head my-change --title "..." --body "..."

# watch CI
gh run list --limit 3
gh run watch <run-id> --exit-status
gh run view <run-id> --log-failed

# land it
gh pr merge <n> --rebase --delete-branch              # ...or:
git checkout main && git merge --ff-only my-change && git push

# clean up
git diff --stat main my-change    # empty = identical content
git branch -D my-change
git push origin --delete my-change
git ls-remote --heads origin      # what is really on origin
git fetch --prune                 # drop origin/* refs whose branch is gone
```
