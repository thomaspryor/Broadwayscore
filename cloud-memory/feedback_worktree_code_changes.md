---
name: Worktrees are mandatory for code changes, not just data files
description: "src/, scripts/, .github/workflows/, CLAUDE.md need a worktree before edits."
type: feedback
originSessionId: c7e55600-9e8d-468b-9f85-de2eda90226d
---
**Rule:** If your session will edit any tracked code file in this repo — `src/**`, `scripts/**`, `.github/workflows/**`, `next.config.js`, `tsconfig.json`, `package.json` — **call EnterWorktree BEFORE the first edit.** Don't do it after. Don't think "it's just a quick fix." Enter a worktree first.

**Why:**

`feedback_worktree_data_races.md` documents the same race for data files (shows.json, reviews.json). The same race applies equally to code files — confirmed 2026-04-11 when a parallel session in this project lost uncommitted edits to `page.tsx` and `index.ts` because an automated git hook (`pull --rebase` + `checkout main`) reverted the working tree mid-session. The new untracked files survived; tracked-file edits were silently dropped. The session only caught it because Claude Code's system-reminder flagged that `index.ts` had been modified — by luck, not by design.

Paraphrasing the session that was burned:

> "The repo race conditions are bad enough that worktrees should be mandatory for code changes. Memory feedback_worktree_data_races.md already says this for data files; today proves it applies equally to scripts. I should have entered a worktree at the start of this session."

**Root causes (not just CI pushes):**
1. **Local git hooks** — pull --rebase, checkout main, prepare-commit-msg, post-checkout — can modify or reset the working tree between turns.
2. **Parallel Claude Code sessions** — another session editing the same branch/files pulls changes that your session hasn't accounted for.
3. **CI pushes to main** — every ~30 min for data files, less often for code, but still real.
4. **GitHub bot commits** — Dependabot, CodeQL, and similar push to main without warning.

Worktrees isolate your session to its own branch with its own working tree. None of the above can touch it.

**Scope — what needs a worktree:**
- `src/**` — Next.js app code, components, types
- `scripts/**` — data pipelines, one-off fixes, CLI tools
- `.github/workflows/**` — CI workflow definitions
- `next.config.js`, `tsconfig.json`, `package.json`, `package-lock.json` — build/deps config
- Anything tracked where losing 30 minutes of edits would be painful

**Scope — what DOESN'T need a worktree:**
- `data/**` — has its own rule (pull before every edit, see `feedback_worktree_data_races.md`)
- `memory/**` (Claude Code auto-memory, under `~/.claude/projects/.../memory/`)
- `CLAUDE.md` (less frequent edits; covered by `feedback_worktree_data_races.md` style pull)
- Repo-root markdown (READMEs, notes) — low race risk
- `.claude/` directory contents (skills, commands) — not part of this repo anyway

**How to apply:**
1. **At session start, BEFORE the first edit:** call `EnterWorktree` with a descriptive name. The harness creates `.claude/worktrees/<name>/` with its own branch.
2. **Do all code work inside that worktree.**
3. **When done:** merge the worktree branch to main, push, `ExitWorktree` to clean up. See CLAUDE.md §1.
4. **Editing multiple repos in one session?** Call `EnterWorktree` for each.

**Enforcement layers (2026-04-11, all 3 active):**

1. **Advisory at session start** — `session-start.sh` prints a prominent reminder at session start if `cwd` is the main repo root, telling you to call EnterWorktree before any code edits.
2. **Advisory after edit** — `script-edit-check.sh` PostToolUse hook prints a warning whenever you edit `src/**`, `scripts/**`, or `.github/workflows/**` outside a worktree.
3. **HARD BLOCK before edit (added after incident #2, Bash coverage added 2026-04-12)** — `worktree-enforce.sh` PreToolUse hook on `Edit|Write|NotebookEdit|Bash` exits with code 2 (blocks the tool call) when:
   - **Edit/Write/NotebookEdit:** The file is in `/Users/tompryor/Broadwayscore/{src,scripts,.github/workflows}/**` OR is `CLAUDE.md`/`next.config.{js,ts,mjs}`/`tsconfig.json`/`package{,-lock}.json`
   - **Bash:** The command contains a redirect operator (`>`, `>>`, `tee`, `cp`, `mv`, `sed -i`) targeting a protected path. Uses adjacent-operator regex to avoid false positives on string args mentioning paths.
   - AND `cwd` does NOT contain `/.claude/worktrees/`
   - AND the file path is not already inside a worktree
   No bypass. If you genuinely need to edit one of these files without a worktree, comment out the hook in `~/.claude/settings.json`, make the edit, and re-enable.

**What's allowed (hook stays out of the way):**
- Edits inside `.claude/worktrees/<name>/` — fully allowed
- Edits to `data/**` (data files have their own pull-before-edit rule, see `feedback_worktree_data_races.md`)
- Edits to `README.md`, screenshot PNGs, image assets, anything not in the scope list
- Edits to files outside the Broadwayscore repo (e.g., `~/.claude/hooks/*.sh` — this very memory file's enforcement scripts)
- `Read`, `Glob`, `Grep` — all unaffected
- `Bash` read-only commands (grep, cat, ls, etc.) — unaffected

**Verified 2026-04-12 with real tool calls (not just simulated JSON):**
- Edit/Write to src/, scripts/ on main → blocked (exit 2)
- Bash `echo >` to src/ on main → blocked (exit 2)
- Bash `cp` to scripts/ on main → blocked (exit 2)
- Bash `sed -i` to src/ on main → blocked (exit 2)
- Bash reads (grep, ls) of src/ → allowed
- Bash commands with paths in string args (notion-brain.js --notes) → allowed
- Edit/Write in worktree → allowed
- Edit data/ on main → allowed
- 10 allowing cases (worktree edits, data files, README, images, files outside repo, Read tool, Bash, NotebookEdit on src/, empty file_path → exit 0)

**History of escalation:**
- **2026-04-11 morning (incident #1):** Parallel session lost `page.tsx` + `index.ts` to a local git hook (`pull --rebase` + `checkout main`) silently reverting uncommitted edits. Caught via Claude Code's built-in modified-file system-reminder, by luck.
- **2026-04-11 morning fix:** Added advisory hooks (#1 and #2 above). Updated `CLAUDE.md` §1 to mandate worktrees for code. Documented this rule.
- **2026-04-11 afternoon (incident #2):** Different parallel session lost a `scripts/rebuild-all-reviews.js` edit. The session ran `git add scripts/rebuild-all-reviews.js`, but the file's diff had already been silently reverted by another concurrent session before `git add` resolved. The commit (`aa80a9d531`) shipped only leftover staged files from the parallel session — including a 236k-line `data/shows.json` deletion — and zero of the actual code change. Caught the next morning via integrity audit.
- **2026-04-11 afternoon fix:** Advisory was insufficient. Added the **hard PreToolUse block** (#3 above). Two incidents in one day = the soft path doesn't work.
- **2026-04-11 PM session note:** This very session saw a `CLAUDE.md` edit get silently reverted between Edit and inspection, recovered via re-edit + atomic commit. Third confirmation in one day that the race is real and the hard block is justified.

**2026-07-14 gap found: the hard block trusts cwd, not the file's actual worktree membership.** `worktree-enforce.sh` only checks "cwd contains /.claude/worktrees/" — it does NOT check that the target file path is inside *that specific* worktree. After `EnterWorktree`, cwd satisfies the check, so Edit/Write calls using a bare `/Users/tompryor/Broadwayscore/scripts/...` path (the MAIN repo, not `.claude/worktrees/<name>/scripts/...`) are silently ALLOWED and land on main — exactly the incident this memory exists to prevent, just via a different door. Caught only because two edits later `git status` showed identical paths modified in both trees. **Fix for future sessions: after EnterWorktree, always prefix Edit/Write/Read file_path with the full worktree path — never reuse a bare absolute main-repo path from before entering, even though it "looks" like it should resolve relative to cwd (Edit/Write take literal absolute paths, they don't rebase on cwd).** If a stray main-repo edit is caught, `cp` the correct content into the worktree copy, then `git checkout --` the main-repo file to revert it before continuing.

**2026-04-11 PM update (incident #2 — same day):**
A second session (this one) lost a `scripts/rebuild-all-reviews.js` edit the same way: edit was in the working tree, ran `git add scripts/rebuild-all-reviews.js`, but the diff had already been silently reverted by a parallel session/hook before the `git add` resolved. The commit (`aa80a9d531`) shipped only leftover staged files from the parallel session — including a 236k-line `data/shows.json` deletion — and zero of my actual code change. Caught the next morning when integrity check showed the same 10 contaminations. Re-applied the edit, this time grep-verifying the new content was on disk BEFORE `git add`, and the second commit (`5cbf272d59`) succeeded. **Two incidents in one day means the advisory hook isn't enough.** Add the PreToolUse block now — the cost of being wedged on a quick edit is far smaller than losing a fix and only catching it via a downstream audit.
