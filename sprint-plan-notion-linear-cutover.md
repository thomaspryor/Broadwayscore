# Sprint Plan: Notion → Linear cutover

## Overview
Finish retiring Notion and make Linear the sole board. The work is ordered around one hazard: the Claude Code
gate hooks block `git commit` and session-end unless a Notion card exists, and they only fail open when Notion is
*unreachable* — so a retired-but-alive Notion wedges every session. Everything else follows from getting that
sequence right. Source plan (with the six-reviewer critique):
`~/Documents/claude-outputs/notion-linear-cutover-plan-2026-08-15.md`.

**Size: L.** 9 sprints, 64 tasks, ~10+ files per sprint at peak. One sprint per session; ship and push before the
next session starts.

## Sprint Summary
| Sprint | Goal | Tasks | Complexity | Model |
|--------|------|-------|------------|-------|
| 0 | ✅ DONE — export assumptions tested by hand | 3 | 3S | Sonnet |
| 1 | Safety rails: backoff, probe, escape hatch, neutral marker | 5 | 3S, 2M | Opus |
| 2 | Complete, reproducible corpus export | 6 | 2S, 4M | Opus |
| 3 | 1,831 un-Done cards migrated or archived in Linear | 9 | 2S, 7M | Opus |
| 4 | Hooks rewritten once against a flippable board switch | 9 | 2S, 7M | Opus |
| 5 | Linear dispatch is as safe as Notion dispatch | 5 | 2S, 3M | Opus |
| 6 | New sessions stop creating Notion cards | 6 | 3S, 3M | Sonnet |
| 7 | Every consumer repointed; silent readers alarm | 12 | 5S, 7M | Opus |
| 8 | Notion retired; 30-day rollback window opens | 9 | 7S, 3M | Sonnet |

**Every sprint that touches `scripts/lib/**`, the dispatch layer, hooks, or `.github/workflows/**` must record its
own `node scripts/lib/review-gate.mjs --query=record-plan --reviewer=<X> --result=pass --session-id=$CLAUDE_SESSION_ID`
before its first edit (CLAUDE.md §18).** That applies to Sprints 1, 2, 4, 5, 6, 7, 8.

---

## Sprint 0: Two cards migrated by hand — ✅ COMPLETE 2026-08-17
**Findings:** `notion-cutover-edge-cases.md`. Three results changed later sprints: Linear normalises markdown so byte-identity is impossible (content is preserved — 0 of 173 tokens lost); the page body held 4,573 chars vs 1,712 in the property (73% of that card lives only in the body); and Notion comments were absent from 100 sampled pages, refuting the earlier "3 of 12" claim.
**Demo:** Two Notion cards — one with body-block overflow, one with comments — appear in Linear with content
provably identical to the source, diffed field by field.
**Risks:** If the hand run shows Notion's block API needs auth scopes we don't have, Sprint 2 is blocked and the
whole plan needs rethinking. Better to learn that now for free.
**MODEL: Sonnet** — manual API calls with clear expected output.

### Task S0-T1: Hand-migrate one card carrying body-block overflow
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** none (scratch script only, not committed)
- **Description:** Pick one of the 2,183 cards whose properties contain `[Full content in page body below ↓]`.
  Read it via properties + `blocks.children.list` (recursive), reassemble the full text, create the Linear issue by
  hand, and diff.
- **Acceptance criteria:**
  - VERIFY: the reassembled text contains no `[Full content in page body below ↓]` marker and is >1800 chars ✅
  - VERIFY: every distinct 6+-character token in the source is present in the Linear copy ✅ (173/173)
    `[CHANGED: was "a character-level diff reports zero differences" — impossible. Linear normalises markdown on
    ingest: it inserts a blank line after headings and adds code fences, so 6,251 chars became 6,233. Content is
    lossless; formatting is not. — source: Sprint 0 hand run]`

### Task S0-T2: Establish whether any card carries comments at all
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** none
- **Description:** `[CHANGED: originally "hand-migrate one card carrying comments". No such card could be found,
  which is itself the answer — source: Sprint 0 hand run]` Sampled 100 pages (40 in query order + the 60
  most-recently-edited) via `comments.list`: **0 with comments, 0 API errors**. At the previously-claimed 25%
  incidence, zero in 100 is statistically impossible, so that claim is refuted.
- **Acceptance criteria:**
  - VERIFY: a bounded sample of 100 pages returns zero comments ✅
  - VERIFY: the result is recorded in `notion-cutover-edge-cases.md` ✅

### Task S0-T3: Record the edge cases the two hand runs exposed
- **Complexity:** S
- **Depends on:** S0-T1, S0-T2
- **Parallel:** No
- **Files:** `notion-cutover-edge-cases.md` (new)
- **Description:** Write down every surprise: nesting depth needed, rate-limit behaviour observed, field mappings
  that had no clean Linear equivalent. Sprint 2 is built from this file.
- **Acceptance criteria:**
  - VERIFY: the file names the maximum block nesting depth actually observed
  - VERIFY: the file states the observed Notion request rate before the first 429

---

## Sprint 1: Safety rails
**Demo:** `linear-brain.js --probe` returns healthy; a simulated 429 is retried rather than thrown; the owner has
a one-file escape hatch documented in plain English.
**Risks:** Backoff added to the wrong layer would mask real errors. Keep it in the transport, not the CLI.
**MODEL: Opus** — shared infra, and the 429 semantics decide whether the fleet survives a rate limit.

### Task S1-T1: Add 429/5xx retry with exponential backoff to the Linear transport
- **Complexity:** M
- **Depends on:** None
- **Parallel:** No
- **Files:** `scripts/lib/linear-client.js` (modify)
- **Description:** Wrap the `graphql()` transport with bounded exponential backoff on 429 and 5xx. Every other
  Linear consumer inherits it. Nothing in this plan may drive Linear in bulk before this lands.
- **Acceptance criteria:**
  - VERIFY: `node --test tests/unit/linear-client-backoff.test.mjs` — a stubbed 429-then-200 resolves, and a
    persistent 429 throws after the bounded retry count
  - VERIFY: the error thrown after exhaustion names the status code

### Task S1-T2: Add a `--probe` mode to linear-brain.js
- **Complexity:** S
- **Depends on:** S1-T1
- **Parallel:** No
- **Files:** `scripts/linear-brain.js` (modify)
- **Description:** A read-only health check that distinguishes reachable-and-healthy, reachable-but-erroring, and
  unreachable. The gate hooks in Sprint 4 depend on this three-way answer.
- **Acceptance criteria:**
  - VERIFY: `node scripts/linear-brain.js --probe` exits 0 and prints a healthy verdict
  - VERIFY: with `LINEAR_API_KEY` set to garbage it exits non-zero and prints a distinguishable
    reachable-but-erroring verdict, NOT the unreachable one

### Task S1-T3: Ship the owner escape hatch
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `docs/board-gate-escape-hatch.md` (new)
- **Description:** Define `~/.claude/BOARD_GATE_DISABLED` as a file the gate hooks check first and honour
  unconditionally. Write the instructions for creating it in plain English, no terminal required (Finder → New
  File). This is handed to the owner before Sprint 4 touches a hook.
- **Acceptance criteria:**
  - VERIFY: the doc states the exact filename and path, and requires no command line
  - VERIFY: `test -f docs/board-gate-escape-hatch.md`

### Task S1-T4: Emit the neutral board marker from notion-brain.js
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `scripts/notion-brain.js` (modify)
- **Description:** Alongside the existing `__NOTION_CARD_ID__=` line (:633), also emit
  `__BOARD_CARD_ID__=<id>`. Additive only — the old marker stays until Sprint 8.
- **Acceptance criteria:**
  - VERIFY: a create run's stderr contains both `__NOTION_CARD_ID__=` and `__BOARD_CARD_ID__=` with the same id

### Task S1-T5: Emit the neutral board marker from linear-brain.js
- **Complexity:** M
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `scripts/linear-brain.js` (modify)
- **Description:** Alongside `ISSUE-FILED:` (:123), emit `__BOARD_CARD_ID__=<identifier>`. After this, one hook
  contract covers both boards and a third migration touches zero hooks.
- **Acceptance criteria:**
  - VERIFY: a create run's stderr contains `__BOARD_CARD_ID__=BRO-` followed by digits
  - VERIFY: `node --test tests/unit/board-card-marker.test.mjs` asserts both CLIs emit the same marker shape

---

## Sprint 2: Complete, reproducible corpus export
**Demo:** A byte-identical-on-rerun export of all 4,775 cards in the private data repo, verified by character
volume rather than card count.
**Risks:** The pre-mortem's secondary scenario is exactly this sprint failing silently — an export that looks
complete but truncated on the longest, most valuable cards. Volume assertions and the double-run diff are the
defence. Notion must be fully live throughout.
**MODEL: Opus** — silent data loss is the failure mode.

### Task S2-T1: Export skeleton — paginate every page with properties, checkpointing
- **Complexity:** M
- **Depends on:** S0-T3
- **Parallel:** No
- **Files:** `scripts/export-notion-corpus.js` (new)
- **Description:** Walk all pages, write NDJSON, checkpoint per page so a crash resumes rather than restarts.
  Named "corpus" not "archive" — "Archive" already means the Linear Archive project.
- **Acceptance criteria:**
  - VERIFY: a run exports exactly 4,775 page records
  - VERIFY: killing the run mid-way and restarting resumes from the checkpoint, not from zero

### Task S2-T2: Add unconditional recursive block descent
- **Complexity:** M
- **Depends on:** S2-T1
- **Parallel:** No
- **Files:** `scripts/export-notion-corpus.js` (modify)
- **Description:** Call `blocks.children.list` for every page regardless of `has_children` (which is false for all
  4,775 rows and is unreliable), and recurse to the depth S0-T3 recorded. Paginate block lists past 100.
- **Acceptance criteria:**
  - VERIFY: zero exported records contain the string `[Full content in page body below ↓]`
  - VERIFY: the export recovers block children for the card used in S0-T1, matching that hand run

### Task S2-T3: Best-effort comment sweep (downgraded)
- **Complexity:** S
- **Depends on:** S2-T1
- **Parallel:** Yes
- **Files:** `scripts/export-notion-corpus.js` (modify)
- **Description:** `[CHANGED: downgraded from required capture — S0-T2 found zero comments in 100 pages, so
  building comment→Linear-comment mapping is unjustified — source: Sprint 0 hand run]` Call `comments.list` per
  page, record any hits, and log the total. Do NOT block the export on it and do NOT map comments into Linear.
- **Acceptance criteria:**
  - VERIFY: the export reports a total comment count across all 4,775 pages
  - VERIFY: a non-zero count does not fail the run, but is surfaced in the summary

### Task S2-T4: Fail loudly on 429; write a durable error manifest
- **Complexity:** M
- **Depends on:** S2-T2, S2-T3
- **Parallel:** No
- **Files:** `scripts/export-notion-corpus.js` (modify)
- **Description:** Treat any 429 or non-2xx as fatal for that page and record it in an error manifest; the run
  fails if the manifest is non-empty. Silently treating a 429 as "no children" is the documented failure mode.
- **Acceptance criteria:**
  - VERIFY: injecting a simulated 429 produces a non-empty manifest and a non-zero exit
  - VERIFY: a clean run produces an empty manifest and exit 0

### Task S2-T5: Verify by character volume, not card count
- **Complexity:** M
- **Depends on:** S2-T4
- **Parallel:** No
- **Files:** `scripts/verify-notion-corpus.js` (new)
- **Description:** Assert exported per-field character totals against the measured baselines (Notes ≈5.26M,
  Outcome ≈2.92M, Key Files ≈271K) within a stated tolerance. Card counts pass on truncated bodies; volume does not.
- **Acceptance criteria:**
  - VERIFY: the verifier passes on the real export and reports the actual per-field totals
  - VERIFY: artificially truncating one large card's Notes makes the verifier fail

### Task S2-T6: Double-run diff, then commit to the private data repo with a hash manifest
- **Complexity:** S
- **Depends on:** S2-T5
- **Parallel:** No
- **Files:** private data repo (new corpus dir + `SHA256SUMS`)
- **Description:** Run the export twice and require a byte-identical diff before shipping. Store in the private
  data repo — NOT `~/Documents/claude-outputs/`, which is iCloud and evictable to dataless placeholders.
- **Acceptance criteria:**
  - VERIFY: `diff -r` between the two runs reports no differences
  - VERIFY: `shasum -c SHA256SUMS` passes from a fresh clone of the data repo

---

## Sprint 3: Migrate the backlog into Linear
**Demo:** 398 P0/P1-tier issues live in Linear, 1,255 P2/P3 present as Canceled + `notion-archive` (searchable,
not dispatchable), and an anti-join proving no un-Done Notion page is unaccounted for.
**Risks:** Exact-title dedupe collapsing the three near-identical "main red" P0s; a mid-run crash leaving a
half-migrated board; notification flood to the owner's phone.
**MODEL: Opus** — the ledger re-key and the anti-join are where silent loss hides.

### Task S3-T1: Add legacy priority spellings as an import-time mapping
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `scripts/lib/linear-import-rules.js` (modify)
- **Description:** Extend `PRIORITY_RE`/`PRIORITY_MAP` to cover `P1`, `P1 Now`, `P1 Soon`, `P0`, `P0 Urgent`,
  `High` etc. Import-time only — do NOT write normalised priorities back to Notion, which would both corrupt the
  Sprint 2 corpus and edit a system being deleted.
- **Acceptance criteria:**
  - VERIFY: `node --test scripts/lib/linear-import-rules.test.mjs` covers all 17 observed legacy spellings
  - VERIFY: the 79 P0/P1-tier legacy-spelling cards map to Linear Urgent/High

### Task S3-T2: Re-key the import ledger to pageId, append-only
- **Complexity:** M
- **Depends on:** None
- **Parallel:** No
- **Files:** `scripts/linear-import.js` (modify), `data/linear-import-mapping.jsonl` (new)
- **Description:** The current mapping is keyed by local mirror task id, so the 1,716 cards with no mirror record
  have no key at all. Re-key to Notion pageId and make it append-only JSONL so a multi-hour run interleaving with
  CI commits every ~30 min cannot lose entries. Migrate the existing 255 entries.
- **Acceptance criteria:**
  - VERIFY: all 255 pre-existing mappings survive the migration, checked by BRO identifier
  - VERIFY: two concurrent appends both land (no last-writer-wins)

### Task S3-T3: Remove the exact-title dedupe
- **Complexity:** S
- **Depends on:** S3-T2
- **Parallel:** No
- **Files:** `scripts/linear-import.js` (modify)
- **Description:** `:270` builds `byTitle` from exact titles; distinct cards legitimately share titles (three
  "main red" P0s). Dedupe on pageId only.
- **Acceptance criteria:**
  - VERIFY: a fixture with two distinct pageIds sharing one title produces two Linear issues, not one

### Task S3-T4: Add the Canceled + `notion-archive` path for P2/P3
- **Complexity:** M
- **Depends on:** S3-T2
- **Parallel:** No
- **Files:** `scripts/linear-import.js` (modify), `scripts/lib/linear-import-rules.js` (modify)
- **Description:** Import P2/P3-tier cards into Linear in Canceled state with a `notion-archive` label — searchable
  by the owner, invisible to `linear-next --list` (which reads open issues only). A file-based archive was rejected
  by three reviewers as recreating the invisible backlog.
- **Acceptance criteria:**
  - VERIFY: an imported P2 card is returned by a Linear label search and NOT by `linear-next.js --list`

### Task S3-T5: Pre-create the top ~30 tags as Linear labels
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `scripts/linear-import.js` (modify)
- **Description:** `[CHANGED: derive, don't guess — source: decomposition critique]` Do NOT hand-pick 30 labels.
  Derive the label set from the tags actually present on the 398 live-imported cards, so the vocabulary matches
  what is on the board. The full 1,099-tag vocabulary is already preserved in the Sprint 2 corpus.
- **Acceptance criteria:**
  - VERIFY: the 30 labels exist in Linear and an imported card carries its mapped labels

### Task S3-T6: Mute notifications, then dry-run the full import
- **Complexity:** M
- **Depends on:** S3-T1, S3-T3, S3-T4, S3-T5
- **Parallel:** No
- **Files:** `scripts/linear-import.js` (modify — `--dry-run` output)
- **Description:** **Owner prerequisite (not a commit): the owner mutes Linear notifications in the UI** — a
  398-issue import would otherwise flood his inbox and phone. Then dry-run and review the per-card disposition
  counts before writing anything. `[CHANGED: separated the owner action from the commit — source: critique]`
- **Acceptance criteria:**
  - VERIFY: dry-run prints `created + skipped-with-reason + archived == 1831` with a reason for every card
  - VERIFY: zero cards fall into an unlabelled "other" bucket

### Task S3-T7a: Build the migration verifier against dry-run output only
- **Complexity:** M
- **Depends on:** S3-T6, S2-T6
- **Parallel:** No
- **Files:** `scripts/verify-linear-migration.js` (new)
- **Description:** `[CHANGED: split out of the bulk write — source: decomposition critique]` Build and prove the
  anti-join tooling against dry-run output, before anything is written to the live board. It anti-joins the full
  Notion source (from the Sprint 2 corpus, not a live query) against the pageId ledger.
- **Acceptance criteria:**
  - VERIFY: run against dry-run output, it reports zero unaccounted un-Done pageIds and writes nothing to Linear
  - VERIFY: deleting one ledger line makes it report exactly that pageId as unaccounted

### Task S3-T7b: Add batching, an abort threshold, and a rollback mode to the importer
- **Complexity:** M
- **Depends on:** S3-T7a
- **Parallel:** No
- **Files:** `scripts/linear-import.js` (modify)
- **Description:** `[CHANGED: this is the riskiest single moment in the plan — one un-idempotent bulk write of
  1,831 cards into a live board that has NO bulk delete — source: decomposition critique]` Chunk into batches of
  ~100, abort on the first unexpected disposition rather than continuing, and add `--rollback` which Cancels and
  labels `import-rollback` every issue in the ledger.
- **Acceptance criteria:**
  - VERIFY: a fixture with one unexpected disposition aborts after its batch, leaving prior batches intact
  - VERIFY: `--rollback` against a 3-issue test ledger Cancels and labels exactly those 3

### Task S3-T7c: Execute the import and prove completeness
- **Complexity:** M
- **Depends on:** S3-T7b
- **Parallel:** No
- **Files:** none (execution + ledger)
- **Description:** Run the batched import, then the anti-join. Owner re-enables notifications afterwards.
- **Acceptance criteria:**
  - VERIFY: the anti-join reports zero un-Done pageIds without a ledger entry
  - VERIFY: `linear-next.js --list` count increased by exactly the number of live-imported issues
  - VERIFY: a spot-check of 5 imported cards shows full body text (no `[Full content in page body below ↓]`), verified by token-level presence rather than exact match — Linear normalises markdown `[CHANGED — source: Sprint 0 hand run]`

---

## Sprint 4: Rewrite the hooks once, against a flippable switch
**Demo:** Set `~/.claude/board=linear`, create a Linear issue, commit, end the session — all clean. Set it back to
`notion` and the old path still works. Rollback proven, not asserted.
**Risks:** This sprint edits the hooks that gate the session doing the editing. A half-applied change wedges the
owner out of committing. The escape hatch (S1-T3) must be in his hands before this starts.
**MODEL: Opus** — highest blast radius in the plan.

### Task S4-T1: Add `linear-brain.js update`
- **Complexity:** M
- **Depends on:** S1-T1
- **Parallel:** Yes
- **Files:** `scripts/linear-brain.js` (modify)
- **Description:** `update <BRO-N> --state <name> --comment <text>` wrapping `linear-client.js updateIssue`. Do
  NOT mirror notion-brain's `--status Done|Paused` vocabulary — the alert-router repoint deliberately refused to
  half-translate Notion semantics and this should too.
- **Acceptance criteria:**
  - VERIFY: `node scripts/linear-brain.js update BRO-<test> --state "Done"` moves the issue and exits 0
  - VERIFY: an unknown state name exits non-zero with the valid states listed

### Task S4-T2: Tag the hook state and rehearse the restore
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `~/.claude` repo (tag only)
- **Description:** Tag current hook state, then actually rehearse recovery — `git -C ~/.claude checkout <tag> -- hooks/`
  is a non-commit command, so it works even while the commit gate is blocking.
- **Acceptance criteria:**
  - VERIFY: `git -C ~/.claude tag | grep pre-board-cutover` returns the tag
  - VERIFY: a rehearsal — move a hook aside, run the restore command, then `git commit` succeeds
    `[CHANGED: tag-exists proved nothing; the restore path is what matters — source: decomposition critique]`

### Task S4-T3a: Add the escape-hatch check to all four hooks, alone, first
- **Complexity:** M
- **Depends on:** S1-T3, S4-T2
- **Parallel:** No
- **Files:** the four gate hooks (modify)
- **Description:** `[CHANGED: this split is the critique's headline finding — source: decomposition critique]`
  In v1 the escape hatch was implemented *inside* the big rewrite, so a half-applied rewrite could leave the hatch
  in the unapplied half — the hatch would not exist until the thing it protects was already finished. This commit
  does **nothing except** make all four hooks honour `~/.claude/BOARD_GATE_DISABLED` before any other logic.
  Nothing else in Sprint 4 may start until this is committed and proven.
- **Acceptance criteria:**
  - VERIFY: with the hatch file present, `git commit` succeeds and no board API call is made (check with a
    deliberately invalid key)
  - VERIFY: with the hatch absent, existing Notion behaviour is byte-for-byte unchanged

### Task S4-T3b: Make the gates fail open on any non-2xx
- **Complexity:** M
- **Depends on:** S1-T2, S4-T3a
- **Parallel:** No
- **Files:** the four gate hooks (modify)
- **Description:** Today "reachable but erroring" means *enforce*, which is what turns a rate-limit blip into a
  fleet-wide commit outage. Use the three-way verdict from `linear-brain.js --probe` (S1-T2).
- **Acceptance criteria:**
  - VERIFY: with a valid CLI but an invalid key, `git commit` succeeds (erroring ⇒ open)
  - VERIFY: with a healthy board and no card, `git commit` is still blocked (the gate still gates)

### Task S4-T3c: Switch the sentinel to the neutral `__BOARD_CARD_ID__` marker
- **Complexity:** M
- **Depends on:** S1-T4, S1-T5, S4-T1, S4-T3b
- **Parallel:** No
- **Files:** the four gate hooks (modify)
- **Description:** `notion-create-verify.sh` writes the sentinel and the commit/stop hooks read it, so writer and
  readers must change together in this one commit. `[CHANGED: added S4-T1 dep — the stop hook clears the sentinel
  on a close, and the Linear close verb comes from S4-T1 — source: decomposition critique]`
- **Acceptance criteria:**
  - VERIFY: a `linear-brain.js create` writes the sentinel and a following `git commit` succeeds
  - VERIFY: a `notion-brain.js create` still writes the sentinel (both markers accepted at this step)

### Task S4-T3d: Read the board switch, defaulting to notion when absent
- **Complexity:** S
- **Depends on:** S4-T3c
- **Parallel:** No
- **Files:** the four gate hooks (modify), `~/.claude/board` (new, created here not in S4-T6)
- **Description:** `[CHANGED: v1 left the switch file's creation to S4-T6, so every earlier step ran with the file
  absent and undefined behaviour — source: decomposition critique]` A missing `~/.claude/board` must mean
  `notion`, so the safe state is the pre-cutover one.
- **Acceptance criteria:**
  - VERIFY: with the file deleted, behaviour is identical to `board=notion`
  - VERIFY: `board=linear` routes to `linear-brain.js`; `board=notion` routes to `notion-brain.js`

### Task S4-T4: Apply the same rewrite to the repo-scoped cloud hooks
- **Complexity:** M
- **Depends on:** S4-T3d
- **Parallel:** No
- **Files:** `.claude/hooks/notion-create-block.sh`, `.claude/hooks/session-start.sh`, `.claude/CLOUD.md` (modify)
- **Description:** These self-activate when `~/.claude/hooks` is absent — i.e. for every cloud session — and were
  missed entirely by the original inventory. Must land in the same sprint or cloud sessions wedge.
- **Acceptance criteria:**
  - VERIFY: a cloud-shaped session (with `~/.claude/hooks` hidden) creates a Linear issue and commits cleanly
  - VERIFY: the repo hooks and `CLOUD.md` contain no instruction to run `notion-brain.js`, checked against an
    explicit allowlist file rather than a bare grep for "instructional" hits

### Task S4-T5: Add Linear fixtures to the hook test suite
- **Complexity:** M
- **Depends on:** S4-T3d
- **Parallel:** No
- **Files:** `~/.claude/hooks/tests/notion-card-required-stop/fixtures/*.jsonl` (new)
- **Description:** The existing fixtures encode the Notion-only closure regex, so after the rewrite they would pass
  while covering only the dead path.
- **Acceptance criteria:**
  - VERIFY: `~/.claude/hooks/tests/notion-card-required-stop/run.sh` passes with both Notion and Linear fixtures
  - VERIFY: reverting S4-T3c makes the new Linear fixture fail (the test actually tests the change)

### Task S4-T6: Flip to `board=linear` and run a full real session end to end
- **Complexity:** S
- **Depends on:** S4-T3d, S4-T4, S4-T5
- **Parallel:** No
- **Files:** none (switch file created in S4-T3d)
- **Description:** Not a unit test — one real session, from start to wrap-up, on the Linear board. This is the
  sprint's demo.
- **Acceptance criteria:**
  - VERIFY: a real session creates a Linear issue at start, commits mid-session, and reaches wrap-up cleanly
  - VERIFY: flipping back to `board=notion` still produces a working session (rollback proven end to end)

---

## Sprint 5: Bring Linear dispatch to parity on the guard that matters
**Demo:** Dispatching a Linear issue whose work branch already carries unlanded commits is refused with a clear
message.
**Risks:** Guard interfaces are Notion-shaped; wiring them naively means fabricating fake cards. The adapter comes
first.
**MODEL: Opus** — dispatch layer, §18 scope.

### Task S5-T1: Add issue→guard adapters to linear-dispatch.js
- **Complexity:** M
- **Depends on:** None
- **Parallel:** No
- **Files:** `scripts/lib/linear-dispatch.js` (modify)
- **Description:** `issueToGuardTask(issue)` / `issueToGuardCard(issue)`. `linear-next.js:208` already hand-rolls a
  `pseudoTask`; this makes that the shared seam rather than a one-off.
- **Acceptance criteria:**
  - VERIFY: `node --test tests/unit/linear-guard-adapter.test.mjs` covers both adapters
  - VERIFY: `linear-next.js` uses the adapter instead of its inline `pseudoTask`

### Task S5-T2: De-Notionify the shared guard refusal messages
- **Complexity:** S
- **Depends on:** S5-T1
- **Parallel:** No
- **Files:** `scripts/lib/dispatch-guards.js` (modify)
- **Description:** `staleOutcomeGuard`'s text hardcodes "no Notion card backing it" (:182), calls
  `notionIdOf(task)` (:192), and emits a `notion-brain.js update` remediation string (:196)
  `[CHANGED: :192 not :191, and :196 was missing from scope — source: decomposition critique]`. Make the wording
  board-neutral so a Linear refusal does not send the reader to Notion.
- **Acceptance criteria:**
  - VERIFY: `node --test tests/unit/guard-message-neutrality.test.mjs` — the returned refusal STRINGS match no
    `/Notion|notion-brain/`. `[CHANGED: the old grep VERIFY was impossible — the file has 46 notion mentions,
    mostly JSDoc, and grep cannot scope to returned strings — source: decomposition critique]`
  - VERIFY: existing bsc-next guard tests still pass

### Task S5-T3: Wire workBranchCollisionGuard into linear-next.js
- **Complexity:** M
- **Depends on:** S5-T1, S3-T7c  `[CHANGED: refusals cannot be verified against issues that do not exist yet — source: critique]`
- **Parallel:** No
- **Files:** `scripts/linear-next.js` (modify)
- **Description:** The one true blocker — the card #1281 class that fired 2026-08-12 when three windows ran the
  same handoff. `deadDispatchGuard` is already covered under `checkDeadDispatch` (imported :89, called :439 — :318 is a comment) and `findOverlappingCards`
  is non-blocking by design, so neither gates this sprint.
- **Acceptance criteria:**
  - VERIFY: dispatching an issue whose branch has unlanded commits is refused, and the refusal names the branch

### Task S5-T4: Behavioural refusal fixtures (not a symbol-parity test)
- **Complexity:** M
- **Depends on:** S5-T3
- **Parallel:** No
- **Files:** `tests/unit/linear-dispatch-refusals.test.mjs` (new)
- **Description:** Test refusal behaviour, not which symbols are imported. A parity test against `bsc-next.js`
  would encode the file we are deleting as the spec, fail on correct Linear-native substitutions, and pass on a
  guard that is imported but never reached.
- **Acceptance criteria:**
  - VERIFY: `node --test tests/unit/linear-dispatch-refusals.test.mjs` passes
  - VERIFY: the test is registered in `tests/unit-test-manifest.txt` (CI only runs listed files)

### Task S5-T5: Extend the infra-review scope and cloud-secrets to Linear
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `scripts/lib/infra-review-scope.js` (modify), `scripts/check-cloud-secrets.js` (modify)
- **Description:** The dispatch regex names `notion-tasks-sync` but no `linear-*`, so the §18 gate would stop
  covering the dispatch layer. TIER_1 secrets require `NOTION_API_KEY` and not `LINEAR_API_KEY`.
- **Acceptance criteria:**
  - VERIFY: `classifyPath('scripts/linear-next.js').tier === 'critical'`
  - VERIFY: `node scripts/check-cloud-secrets.js` reports `LINEAR_API_KEY` as required

---

## Sprint 6: Rewrite the rules so new sessions stop creating Notion cards
**Demo:** A brand-new session opens a Linear issue at start and never mentions Notion.
**Risks:** This is the reinfection vector — mirror tasks #1283–#1287 appeared *while* the last import was running.
Also: editing CLAUDE.md without `claude-md-anchors.json` throws a false corruption alarm every session afterwards.
**MODEL: Sonnet** — mostly prose edits with mechanical verification.

### Task S6-T1: Sweep the fleet and clear stale sentinels
- **Complexity:** S
- **Depends on:** None
- **Parallel:** No
- **Files:** none
- **Description:** Sessions loaded under the old rules keep filing Notion cards for hours. Drain or restart them
  before the flip, and clear `/tmp/notion-card-*` and `/tmp/notion-create-failed-*`.
- **Acceptance criteria:**
  - VERIFY: `cmux list-workspaces` shows no session started before the S4-T6 flip
  - VERIFY: `ls /tmp/notion-card-* /tmp/notion-create-failed-* 2>/dev/null | wc -l` returns 0

### Task S6-T2: Rewrite CLAUDE.md §6 and update the integrity anchors in the same commit
- **Complexity:** M
- **Depends on:** S6-T1
- **Parallel:** No
- **Files:** `CLAUDE.md` (modify), `scripts/lib/claude-md-anchors.json` (modify)
- **Description:** "Linear is the single source of truth"; replace the `notion-tasks-sync → bsc-next` chain with
  `linear-next`. The anchors file contains the literal "Notion Brain" — changing one without the other produces a
  persistent false startup-corruption warning.
- **Acceptance criteria:**
  - VERIFY: a fresh session start prints no CLAUDE.md integrity warning
  - VERIFY: `node scripts/lib/check-claude-md-anchors.js` (the check test.yml Lint Workflows runs) passes
    `[CHANGED: v1 named a JSON file as a runnable command — source: decomposition critique]`

### Task S6-T3: Rewrite the global rules and the session-start seed
- **Complexity:** S
- **Depends on:** S6-T2
- **Parallel:** No
- **Files:** `~/.claude/CLAUDE.md` (modify), `~/.claude/hooks/session-start.sh` (modify)
- **Description:** `:393` injects "NOTION: create card immediately" as rule #1 into every session, fleet-wide.
- **Acceptance criteria:**
  - VERIFY: a fresh session's seed text names `linear-brain.js create` and not `notion-brain.js create`

### Task S6-T4: Triage the 35 command files that reference Notion
- **Complexity:** M
- **Depends on:** S6-T3
- **Parallel:** No
- **Files:** `~/.claude/commands/*.md`, `.claude/commands/*.md` (modify)
- **Description:** 35 files match. Rewrite the instructional ones (`session-start`, `wrap-up`, `done`, `what-else`,
  `morning-briefing`, plus repo `ship-check`, `did-it-work`, `second-opinion`, `plan-review`, `plan-tasks`). Note
  the grep must cover `update`-based instructions, not just `create`.
- **Acceptance criteria:**
  - VERIFY: `grep -rn "notion-brain.js \(create\|update\)" ~/.claude/commands/ .claude/commands/` returns 0
    instructional hits

### Task S6-T5: Fix the warn-only and guidance hooks
- **Complexity:** S
- **Depends on:** S6-T3
- **Parallel:** Yes
- **Files:** `~/.claude/hooks/session-stop.sh`, `~/.claude/hooks/notion-mcp-block.sh` (modify)
- **Description:** `notion-mcp-block.sh`'s guidance text points at `notion-brain.js`. For `session-stop.sh:37-45`
  **invert the counter rather than deleting it** — it is the only thing counting Notion calls, and Sprint 9's
  "zero Notion cards created" metric depends on it. `[CHANGED: deleting it would destroy S9's own metric —
  source: decomposition critique]`
- **Acceptance criteria:**
  - VERIFY: a Linear-only session ends with no "NO NOTION UPDATE" warning
  - VERIFY: the inverted counter reports a Notion-call count of 0 for that session

### Task S6-T6: Retire or port /notion-feed-me and /notion-sweep
- **Complexity:** S
- **Depends on:** S6-T4
- **Parallel:** Yes
- **Files:** `~/.claude/commands/notion-feed-me.md`, `notion-sweep.md` (delete or rewrite)
- **Description:** Both are Notion-native end to end. Port to Linear or delete; leaving them is a trap.
- **Acceptance criteria:**
  - VERIFY: neither command references `notion-brain.js`, or both files are gone

---

## Sprint 7: Repoint every consumer, loud ones first
**Demo:** No workflow calls Notion; the digest's Needs-You rows carry live Linear links; every silent reader alarms
on an empty board instead of reporting all-clear.
**Risks:** The silent readers are the dangerous half — `autonomous-acceptance-recheck.js` is the RECHECK-AFTER
safety net and has no zero-row guard, so it would go quiet with no error.
**MODEL: Opus** — 15 workflows and the digest.

### Task S7-T0: Wire LINEAR_API_KEY into the env block of every workflow being repointed
- **Complexity:** S · **Depends on:** None · **Parallel:** Yes
- **Files:** ~15 files under `.github/workflows/` (modify)
- **Description:** `[CHANGED: new task — source: decomposition critique, with one correction: the SECRET already
  exists (gh secret list shows LINEAR_API_KEY added 2026-08-12) and is wired into only 6 workflows. The gap is the
  per-workflow `env:` block, not the secret.]` Every workflow repointed in this sprint needs the key in its step
  `env:`, per the project rule that NEXT_PUBLIC/secret values must be declared in the step's own env block.
- VERIFY: every workflow that invokes a repointed script lists `LINEAR_API_KEY` in that step's `env:`
- VERIFY: one repointed workflow completes green on a manual dispatch

### Task S7-T1: Repoint the direct `@notionhq/client` writers
- **Complexity:** M · **Depends on:** S6-T2 · **Parallel:** Yes
- **Files:** `scripts/posthog-friction-analyzer.js`, `scripts/auto-fix-friction-card.js` (modify)
- VERIFY: `grep -c "@notionhq/client"` returns 0 in both; `posthog-monday.yml` completes green
- VERIFY: filed cards land in Linear at P2 with a needs-owner-visual-QA label (closes BRO-340)

### Task S7-T2: Repoint the commercial sync scripts
- **Complexity:** M · **Depends on:** S4-T1 · **Parallel:** Yes
- **Files:** `scripts/sync-pending-review-to-notion.js`, `scripts/notify-pending-commercial-notion.js` (modify+rename)
- VERIFY: `commercial-pending-review-notify.yml` and `commercial-weekly.yml` complete green

### Task S7-T3: Repoint the date audits
- **Complexity:** S · **Depends on:** S4-T1 · **Parallel:** Yes
- **Files:** `scripts/audit-closing-dates.js`, `scripts/audit-opening-dates.js` (modify)
- VERIFY: both workflows green; the `if (!NOTION_API_KEY) skip` early-exit is gone

### Task S7-T4: Repoint the morning digest off the task mirror
- **Complexity:** M · **Depends on:** S3-T7c · **Parallel:** No
- **Files:** `scripts/send-morning-digest.js` (modify)
- **Description:** `:466` reads `bsc-next.loadTasks(TASKS_DIR)` inside a `try/catch` that degrades silently — the
  digest would keep sending with empty Needs-You rows and dead `app.notion.com` links.
- VERIFY: a locally-rendered digest shows non-empty Needs-You rows linking to `linear.app`
- VERIFY: the `try/catch` logs an error rather than degrading silently

### Task S7-T5: Repoint the acceptance-recheck safety net and give it a zero-row alarm
- **Complexity:** M · **Depends on:** S3-T7c · **Parallel:** No
- **Files:** `scripts/autonomous-acceptance-recheck.js` (modify)
- **Note:** absorbs the `.notion-map.json` half of the old S8-T2 — one file, one owner, one commit `[CHANGED — source: critique]`
- VERIFY: it reads Linear and reports a non-zero row count against the real board
- VERIFY: forcing zero rows produces an alarm, not a clean pass

### Task S7-T6a: Add zero-row alarms to the four silent audit readers
- **Complexity:** M · **Depends on:** S3-T7c · **Parallel:** Yes
- **Files:** `scripts/audit-close-time-verify.js`, `scripts/audit-card-verifiability.js`, `scripts/lib/stuck-work.js`,
  `scripts/autonomous-email.js` (modify)
- VERIFY: each returns non-zero rows against the real board, and forcing zero rows produces an alarm

### Task S7-T6b: Upgrade the health-check zero-row branch from warn to error
- **Complexity:** S · **Depends on:** S7-T6a · **Parallel:** No
- **Files:** `scripts/health-check.js` (modify)
- **Description:** `[CHANGED: split from T6 — different file, different failure mode — source: critique]`
- VERIFY: `health-check.js:2445` emits `error` (not `warn`) when the board returns 0 cards

### Task S7-T7: Fix Gate T in exit-status-gate.sh
- **Complexity:** M · **Depends on:** S3-T7c · **Parallel:** Yes
- **Files:** `~/.claude/hooks/exit-status-gate.sh` (modify)
- **Description:** It resolves task titles from the mirror (:157, :180) and its remediation says "run
  notion-tasks-sync.js pull" (:591). Its numeric namespace also never matches `BRO-9`.
- VERIFY: a wrap-up mentioning `BRO-343` resolves its title and is not blocked

### Task S7-T8: Decide and execute the intake-channel disposition
- **Complexity:** M · **Depends on:** S6-T3 · **Parallel:** No
- **Files:** `scripts/notion-action-poll.js`, `~/.claude-email-worker/poll.py` (modify or retire)
- **Description:** **Needs the owner's explicit sign-off on repoint-vs-retire.** Silently letting the Action-Queue
  chain die is the failure mode — the poller exits 1 into a launchd log nobody reads.
- VERIFY: either both read Linear, or both are unloaded from launchd and the owner has confirmed in writing

### Task S7-T9: Strip vestigial NOTION_API_KEY blocks from the workflows
- **Complexity:** S · **Depends on:** S7-T1, S7-T2, S7-T3 · **Parallel:** No
- **Files:** ~12 files under `.github/workflows/` (modify)
- VERIFY: `grep -rl "NOTION_API_KEY" .github/workflows/ | wc -l` drops to only workflows still legitimately using it

### Task S7-T10: Add a dead-Notion-path canary
- **Complexity:** M · **Depends on:** S7-T9 · **Parallel:** No
- **Files:** `scripts/lib/autofix-canary.js` (modify)
- **Description:** Today's canary asserts only the Linear path, which is why a dead Notion poller could go
  unnoticed. Assert the Notion path is dead AND the Linear path is alive. **Gate it in CI on every push**, or it
  merely re-asserts a state S7-T9 already made true `[CHANGED — source: decomposition critique]`.
- VERIFY: the canary fails if a Notion write path is reintroduced
- VERIFY: it runs in `test.yml` on push, not only on a schedule

---

## Sprint 8: Retire, with a 30-day rollback window
**Demo:** No loaded launchd job touches Notion; the mirror is frozen; `notion-brain.js` lives in `scripts/legacy/`
and the key stays valid for 30 days.
**Risks:** Deleting the CLI and revoking the key together removes the only rollback path — the pre-mortem's primary
scenario. Keep both for 30 days.
**MODEL: Sonnet** — mechanical, with clear verification.

### Task S8-T1: Repoint or retire the five Notion-writing launchd jobs
- **Complexity:** M · **Depends on:** S7-T8 · **Parallel:** No
- **Files:** `scripts/bsc-prune.js`, `scripts/bsc-reconcile.js`, `scripts/reconcile-dead-completions.js`,
  `~/Library/LaunchAgents/com.bwsc.weekly-retro.plist` (modify), plus `com.bwsc.action-dispatcher`
- VERIFY: `launchctl list | grep -E "bwsc|broadwayscore"` shows no job whose script greps `notion-brain.js`

### Task S8-T2: Migrate `.notion-map.json` and its two remaining consumers
- **Complexity:** M · **Depends on:** S8-T1 · **Parallel:** No
- **Files:** `scripts/autonomous-run.js`, `scripts/autonomous-triage.js` (modify)
- **Description:** 1,241 entries; the only taskId↔card join table. `autonomous-acceptance-recheck.js` is handled in
  S7-T5 `[CHANGED: was double-owned across two sprints — source: decomposition critique]`.
- VERIFY: both run clean against the Linear-keyed ledger

### Task S8-T2b: Retire notion-tasks-sync.js before the mirror is frozen
- **Complexity:** S · **Depends on:** S8-T2 · **Parallel:** No
- **Files:** `scripts/notion-tasks-sync.js` (retire), callers (modify)
- **Description:** `[CHANGED: new task — nothing retired the sync, so any surviving `pull` would break against a
  read-only mirror — source: decomposition critique]`
- VERIFY: `grep -rn "notion-tasks-sync" scripts/ .github/workflows/ ~/.claude/hooks/` returns no live invocation

### Task S8-T3: Freeze the task mirror
- **Complexity:** S · **Depends on:** S8-T2, S7-T4, S7-T7 · **Parallel:** No
- **Files:** `~/.claude/tasks/broadwayscore/` (chmod read-only)
- **Description:** Only after Gate T and the digest are repointed, or wrap-ups and the daily email break.
- VERIFY: a full session runs start-to-wrap-up with the mirror read-only

### Task S8-T4: Remove notion entries from test.yml in the same commit as any deletion
- **Complexity:** S · **Depends on:** S8-T3 · **Parallel:** No
- **Files:** `.github/workflows/test.yml` (modify), `tests/unit-test-manifest.txt` (modify)
- **Description:** The push path allow-list and unit-test lists gate CI on the notion scripts.
- VERIFY: test.yml passes on main after the change

### Task S8-T5: Move notion-brain.js to scripts/legacy/ and keep the key 30 days
- **Complexity:** S · **Depends on:** S8-T4 · **Parallel:** No
- **Files:** `scripts/notion-brain.js` → `scripts/legacy/notion-brain.js`
- **Description:** Moving rather than deleting preserves rollback; the key stays valid until day 30 and is revoked
  only after Sprint 9's watch is clean.
- VERIFY: `~/.claude/board=notion` still produces a working commit gate from the legacy path

### Task S8-T6: Delete the dead plists
- **Complexity:** S · **Depends on:** S8-T1 · **Parallel:** Yes
- **Files:** 2 `.bak-20260628` + 4 `.disabled-*` plists (delete)
- **Description:** `[CHANGED: iOS onboarding removed — the iOS repo has zero Notion coupling, so it is not cutover
  work — source: decomposition critique]`
- VERIFY: the plists are gone and `launchctl list` output is unchanged

### Task S8-T7: Update ~/.claude/settings.json if the hooks are renamed
- **Complexity:** S · **Depends on:** S8-T5 · **Parallel:** No
- **Files:** `~/.claude/settings.json` (modify)
- **Description:** `[CHANGED: new task — settings.json registers all five gate hooks BY PATH (lines 11, 38, 47,
  188, 226). Renaming `notion-*` to `board-*` without updating it silently disarms every gate — a missing hook is
  a no-op, not an error. Simplest safe option: do not rename. — source: decomposition critique]`
- VERIFY: after any rename, all five hooks still fire (deliberately trigger each and observe the block)

### Task S8-T8: Update the migration memory and close BRO-280
- **Complexity:** S · **Depends on:** S8-T7 · **Parallel:** Yes
- **Files:** `memory/project_linear_migration_decision.md` (modify)
- **Description:** `[CHANGED: new task — source: my own Phase 3 self-validation]` That memory still reads "awaits
  owner go", which would misinform every future session indefinitely. Update it to record the 2026-08-15 approval
  and the completed cutover, and close BRO-280 with the outcome.
- VERIFY: the memory file no longer contains "awaits owner go"
- VERIFY: BRO-280 state is Done with an outcome naming this plan

---

## Sprint 9: Prove it (one-week watch, no code)
**Demo:** Seven consecutive clean days, then the key is revoked.
- VERIFY: the 7:30am digest sends daily AND its Needs-You rows have content with live `linear.app` links
- VERIFY: `node scripts/check-linear-cap.js` green every day
- VERIFY: zero Notion cards created, read from the INVERTED `session-stop.sh` counter kept in S6-T5
  `[CHANGED: v1 relied on a counter S6-T5 would have deleted — source: decomposition critique]`
- VERIFY: `autonomous-acceptance-recheck` reports non-zero rows daily
- VERIFY: zero 429s in the Linear ledger
- **Then:** revoke `NOTION_API_KEY`, delete `scripts/legacy/`, remove the `~/.claude/board` switch's notion branch.

---

## Dependencies Graph
```
S0-T1,S0-T2 → S0-T3 → S2-T1 → S2-T2,S2-T3 → S2-T4 → S2-T5 → S2-T6 ─┐
S1-T1 → S1-T2 ─┐                                                    │
S1-T3 ─────────┼→ S4-T3a → S4-T3b → S4-T3c → S4-T3d → S4-T4,S4-T5 → S4-T6
S4-T2 ─────────┤          (S1-T4,S1-T5,S4-T1 feed S4-T3c)          │
S3-T1,S3-T5 ┐  │                                                    │
S3-T2 → S3-T3,S3-T4 ┴→ S3-T6 → S3-T7a → S3-T7b → S3-T7c ←───────────┘
S3-T7c → S5-T3 ; S5-T1 → S5-T2, S5-T3 → S5-T4 ; S5-T5 independent
S4-T6 → S6-T1 → S6-T2 → S6-T3 → S6-T4, S6-T5, S6-T6
S3-T7c → S7-T4,T5,T6a,T7 ; S6-T2 → S7-T1 ; S4-T1 → S7-T2,T3 ; S7-T0 first
S7-* → S8-T1 → S8-T2 → S8-T2b → S8-T3 → S8-T4 → S8-T5 → S8-T7 → S8-T8 → Sprint 9
```

**Critical path:** S0 → S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 = **9 sessions minimum**, one sprint each.
Sprint 9 is a watch, not a work session.

## Subagent Execution Map (within one /execute-plan session per sprint)
```
Sprint 1  track 1: S1-T1 → S1-T2      track 2: S1-T3      track 3: S1-T4 → S1-T5
          sync: ──── before Sprint 2 ────

Sprint 3  track 1: S3-T2 → S3-T3 → S3-T4    track 2: S3-T1    track 3: S3-T5
          sync: ──── all three before S3-T6; S3-T7a/b/c are strictly serial ────

Sprint 4  STRICTLY SERIAL — S4-T3a → T3b → T3c → T3d. No parallelism.
          (S4-T1 and S4-T2 may run ahead in parallel.)

Sprint 7  track 1: S7-T0 → S7-T1 → S7-T9    track 2: S7-T2 → S7-T3
          track 3: S7-T4 → S7-T5 → S7-T6a → S7-T6b    track 4: S7-T7
          sync: ──── before S7-T10 ────
```
**Parallel sprints:** Sprint 5 no longer qualifies — S5-T3 now depends on S3-T7c. Run sprints in order.
**Max subagent parallelism:** 4 (Sprint 7).
**Cross-session plan:** one sprint per session, in order, shipping and pushing before the next starts. Do NOT open
parallel Claude Code sessions for different sprints — they share a remote and will clobber each other.

## Known Edge Cases
- `has_children` is `false` for all 4,775 pages yet 5 of 12 sampled pages have children — never trust it.
- 2,183 cards store real content in page bodies behind `[Full content in page body below ↓]`.
- Notion comments are unreachable by all current tooling.
- Distinct cards legitimately share titles (three "main red" P0s) — pageId is the only safe key.
- 1,716 un-Done cards have no local task record at all.
- `~/Documents/claude-outputs/` is iCloud and evicts to dataless placeholders.
- CI only runs test files listed in `tests/unit-test-manifest.txt`.
- The commit gate's probe is 4 seconds and will flap under the export's own Notion load.
- `~/.claude/settings.json` registers all five gate hooks by path — a rename without a settings edit disarms them silently.
- Linear has **no bulk delete**, so the import needs its own `--rollback`.

## Changes from Critique
| Change | Reason | Source |
|--------|--------|--------|
| Split S4-T3 into T3a–T3d, escape-hatch check first and alone | The hatch was implemented inside the rewrite it protects; a half-applied rewrite left no hatch, and with `board` absent the 4s probe hits live Notion, returns 2xx, and hard-blocks commits with no bypass | decomposition critique |
| Create `~/.claude/board` in S4-T3d, defaulting to `notion` when absent | v1 created it in S4-T6, so every earlier step ran with undefined behaviour | decomposition critique |
| S4-T2 verify became a restore-then-commit rehearsal | Proving a tag exists proves nothing about recovery | decomposition critique |
| S3-T7 split into T7a/T7b/T7c, plus batching, abort threshold and `--rollback` | Riskiest moment in the plan: one un-idempotent bulk write of 1,831 cards into a board with no bulk delete | decomposition critique |
| Added S3-T7c → S5-T3 | Sprint 5 verified refusals against Linear issues that would not exist yet | decomposition critique |
| S5-T2 verify became a unit test on returned strings | `grep -c "Notion"` can never reach 0 — the file has 46 mentions, mostly JSDoc | decomposition critique |
| Added `dispatch-guards.js:196` to S5-T2 scope; corrected `:191`→`:192` and `checkDeadDispatch` `:318`→`:439` | Wrong line numbers would send an implementer to edit a comment | decomposition critique |
| S6-T5 inverts the session-stop counter instead of deleting it | Deleting it destroys the only metric Sprint 9 checks | decomposition critique |
| Fixed S6-T2 verify | v1 named a JSON file as a runnable command | decomposition critique |
| Added S7-T0 (per-workflow `env:` wiring) | ~15 repointed workflows need the key in their step env. **Correction to the critique:** the secret itself already exists (added 2026-08-12) | decomposition critique, corrected |
| Split S7-T6 into T6a/T6b; moved the recheck's map migration into S7-T5 | 5-file task; and `autonomous-acceptance-recheck.js` was owned by two sprints | decomposition critique |
| S7-T10 canary must be CI-gated on push | Otherwise it asserts a state S7-T9 already made true | decomposition critique |
| Added S8-T2b (retire `notion-tasks-sync.js` before the freeze) | Nothing retired it; a surviving `pull` breaks on a read-only mirror | decomposition critique |
| Added S8-T7 (`settings.json` if hooks are renamed) | All five gates are registered by path; renaming silently disarms them | decomposition critique |
| Dropped iOS onboarding from S8-T6 | The iOS repo has zero Notion coupling — not cutover work | decomposition critique |
| S3-T5 derives labels from imported cards instead of guessing 30 | The corpus already preserves all 1,099 tags | decomposition critique |
| Owner actions (notification mute, intake-channel decision) marked prerequisites, not commits | They are not commits and cannot be verified as such | decomposition critique |
| Added S8-T8 (update the migration memory, close BRO-280) | `memory/project_linear_migration_decision.md` still says "awaits owner go" and would misinform every future session | my Phase 3 self-validation |

## Phase 5 re-validation
- New dependency introduced by the S4 split? Yes, and it is strictly serial by design — recorded in the graph.
- Any task no longer atomic? No: every split reduced scope. Task count rose 48 → 58.
- Critical path unchanged at 9 sessions; Sprint 4 got longer in commits but not in sessions.
- VERIFYs: the three impossible ones (grep-for-0, `node <json>`, "instructional hits") are replaced with runnable checks.
- **Effort re-estimate:** +10 tasks, no extra sessions. The added rigor is concentrated in Sprints 4 and 3 —
  precisely the two that could brick the toolchain or half-write the board.

## Key Risks
1. **Fleet-wide commit outage.** Mitigated by the escape hatch landing first and alone (S4-T3a), fail-open on any
   non-2xx (S4-T3b), a rehearsed restore (S4-T2), the board switch defaulting to `notion` (S4-T3d), and keeping the
   Notion path alive 30 days (S8-T5).
2. **Silent data loss in the export.** Mitigated by volume assertions (S2-T5), fail-on-429 (S2-T4), and the
   double-run byte diff (S2-T6).
3. **Half-migrated board with no un-import path.** Mitigated by batching + abort threshold + `--rollback`
   (S3-T7b), the append-only pageId ledger (S3-T2), and the anti-join (S3-T7c).
