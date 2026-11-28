---
name: feedback-worktree-data-symlink-git-corruption
description: Symlinking the whole data/ (or public/) dir inside a worktree to test scripts against real gitignored data corrupts git status for the git-tracked files in that dir — must rm + git checkout before committing
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 62a82f82-f48f-4d8f-9df3-0b0cb6580916
  modified: 2026-07-22T02:02:10.492Z
---

When testing a `scripts/` change against real local data inside a worktree (e.g. `scrape-mezzanine-audience.js` needs `data/shows.json`, which is gitignored and not checked out into a fresh worktree), do NOT `rm -rf data && ln -s <main-repo>/data data`. `data/` and `public/` contain a mix of gitignored files (shows.json, audience-buzz.json) AND git-tracked files (data/actor-images.json, data/audit/*.json, public/brand-tokens.json, etc.) — `rm -rf`ing the whole directory destroys the worktree's git-tracked copies too, and replacing it with a symlink makes every one of those tracked files show as deleted in `git status`, corrupting the diff you're about to commit.

**Why:** `.gitignore` excludes specific large filenames (`data/shows.json`, `data/audience-buzz.json`), not the whole `data/` tree — this isn't obvious from a quick `ls`.

**How to apply:** For live-data testing in a worktree, symlink only the specific gitignored files/dirs actually needed (`ln -s <main-repo>/data/shows.json data/shows.json`), not the parent directory. If the symlink-whole-dir shortcut was already taken, before `git add`/`git commit`: `rm -f data public/public <any stray symlinks>` then `git checkout -- data public` to restore the tracked originals, and re-check `git status --short` shows only the intended file(s) before committing. Hit this twice in one session (2026-07-21, card #313 Mezzanine overrides) — same recovery both times.
