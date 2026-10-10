---
name: Worktree scripts can't read main's data symlinks
description: "Scripts (and Codex's AGENTS.md data:check gate) crash without shows.json/review-texts + 6 more data files symlinked into the worktree."
type: feedback
originSessionId: 9d267f5d-b0d8-44f9-ad26-e0d3090bc86b
modified: 2026-08-26T05:16:22.912Z
---
**Rule:** When testing scripts that read data files from a worktree, either (a) run them from the main repo directory with an absolute script path, or (b) add temporary symlinks in the worktree's `data/` directory pointing back to main's copies. Remove the symlinks before committing — `data/` is gitignored so they never show up in `git status`, but leaving them around clutters the worktree.

**Why:**
- `data/shows.json`, `data/reviews.json` are symlinks to the private core-data repo; `data/review-texts/` is a real on-disk directory in main. None of these carry into a worktree — `path.join(__dirname, '..', 'data', ...)` resolves to the worktree's own (empty) `data/`.
- Running `cd /Users/tompryor/Broadwayscore && node <worktree>/scripts/foo.js` does NOT help — `__dirname` is module-relative, not cwd-relative.
- Tests of rebuild-all-reviews silently reported zero exclusions for hours during a verbose-logging session because the script crashed at the data-loading step, not at the new code.
- **2026-08-10 addition:** `npm run data:check` (which Codex's local CLI runs itself, per this repo's `AGENTS.md`, before doing anything else in a worktree) needs a WIDER set: shows.json, reviews.json, grosses.json, grosses-history.json, commercial.json, audience-buzz.json, critic-consensus.json, critic-registry.json. Missing any of these makes Codex self-block with "Blocked by repository instruction" and return zero review content — looks like a Codex CLI failure but is actually just missing symlinks, not a CODEX_EMPTY flake.
- **2026-08-26 correction:** the list above is missing `outlet-registry.json` — `data:check`'s actual MISSING list is 9 files, not 8. Confirmed via the literal error output: `❌ MISSING: shows.json, reviews.json, grosses.json, grosses-history.json, commercial.json, audience-buzz.json, critic-consensus.json, critic-registry.json, outlet-registry.json`. Any unit test or lib module that calls `isRegisteredOutlet`/`normalizeOutlet` (review-normalization.js) also needs this one symlinked even outside a Codex run.

**How to apply:**
- Before testing a worktree script, or before running a Codex adversarial review in a worktree, symlink the full set:
  ```bash
  ln -s /Users/tompryor/Broadwayscore/data/review-texts <worktree>/data/review-texts
  ln -s /Users/tompryor/Broadwayscore/data/shows.json <worktree>/data/shows.json
  ln -s /Users/tompryor/Broadwayscore/data/reviews.json <worktree>/data/reviews.json
  ln -s /Users/tompryor/Broadwayscore/data/grosses.json <worktree>/data/grosses.json
  ln -s /Users/tompryor/Broadwayscore/data/grosses-history.json <worktree>/data/grosses-history.json
  ln -s /Users/tompryor/Broadwayscore/data/commercial.json <worktree>/data/commercial.json
  ln -s /Users/tompryor/Broadwayscore/data/audience-buzz.json <worktree>/data/audience-buzz.json
  ln -s /Users/tompryor/Broadwayscore/data/critic-consensus.json <worktree>/data/critic-consensus.json
  ln -s /Users/tompryor/Broadwayscore/data/critic-registry.json <worktree>/data/critic-registry.json
  ln -s /Users/tompryor/Broadwayscore/data/outlet-registry.json <worktree>/data/outlet-registry.json
  ```
  Then verify with `npm run data:check` before trusting any worktree script output OR before invoking Codex.
- Always check the script's exit code AND tail the log — silent crashes look like "no exclusions" or "no output".
- Don't assume "0 lines emitted" means "feature doesn't trigger" — verify the script actually ran to completion.
- Remove the symlinks (`rm data/review-texts data/shows.json ...`) once done — `data/` is gitignored so this is cleanup hygiene, not a commit-safety requirement.
