---
name: phase-b-we-learnings-for-broadway
description: "Six concrete lessons from Phase B-WE soft-launch (shipped 2026-05-17) that apply directly to the post-Tonys Broadway anchored-bands rollout. Bake these in from Sprint W1, not as ship-check fixes."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: cced698e-d6d7-446c-8cda-f3901a14c13f
---

The Phase B-WE West End soft-launch (1,476 reviews, ~$43 actual cost, 3 hours runtime) shipped cleanly but surfaced 6 things to do differently for the Broadway rollout. BW is ~10x bigger (~15,000 reviews, projected $430-500, ~30 hours runtime); these lessons compound at that scale.

## 1. `--skip-already-anchored` flag from W1, not ship-check
**Why:** During Phase B-WE I built this flag mid-session after Claude QA flagged idempotence as a P0. Without it, a `--rescore` re-run after partial completion doubles cost.

**How to apply:** For BW, the flag exists in `scripts/llm-scoring/index.ts` already. Use it from the first W3 command — `--skip-already-anchored` is part of the canonical invocation. Don't omit it.

## 2. `--max-cost` budget cap from W1
**Why:** BW corpus is ~15k reviews. At Sprint 4 actuals ($0.0378/review), full rescore ~$570. Headroom needed for failed retries.

**How to apply:** Run BW with `--max-cost=600` (not 80). Verify the budget gate aborts cleanly via a `--limit=10` smoke test first.

## 3. "Push attempt failed" checkpoint noise misleads
**Why:** During W3, every checkpoint logged `Push attempt 1/2/3 failed` because the script `git push`es from `/Users/.../Broadwayscore/data/review-texts/` which is NOT a git repo. The writes ARE landing in main local; the alarming log is benign. A 4-hour BW run with hundreds of these lines will look broken to anyone glancing at it.

**How to apply:** Before BW W3, either (a) fix `gitCheckpoint()` in index.ts to write directly into `~/broadway-review-texts/` AND skip the push if `git -C $PWD rev-parse` fails, or (b) downgrade the "Push attempt failed" message to a single `::warning::` line that explains it's expected when the local checkout isn't a tracked repo. Reference [[feedback_data_repos_clobber_uncommitted]].

## 4. Cascade workflows auto-re-enable mid-rescore
**Why:** During Phase B-WE, 6 of the 8 cascade workflows I disabled in W0 had re-enabled themselves by W2-T2. "Opening Night Orchestrator" had re-enabled itself by W5-T4. The mechanism isn't fully understood — could be GitHub's API behavior on workflow_run events, could be other sessions toggling. Either way, the assumption "disabled stays disabled for 4 hours" is wrong.

**How to apply:** Add a workflow-status assertion to the rescore script: every 50 reviews, before the checkpoint, run `gh workflow list --all` and abort the run if any of `Rebuild Reviews Data | Rebuild Reviews (Fast) | Push Review Texts | Collect Review Texts | Bulk Collect Review Texts | Collect WE/OB Review Texts | Deploy to Vercel` is `active`. Pages the operator to re-disable + resume via `--skip-already-anchored`.

## 5. `--ours` vs `--theirs` is flipped in rebase mode
**Why:** During W5-T3, I lost my Phase B-WE reviews.json once by using `git checkout --ours reviews.json` during a rebase conflict resolution. In rebase: `--ours` = branch being rebased ONTO (upstream), `--theirs` = commits being replayed (my work). Took the wrong side; my fresh rebuild got discarded; had to redo.

**How to apply:** Two options:
- (a) Script the merge as `git merge --strategy-option=theirs` for reviews.json specifically (not rebase). Less ambiguous semantics.
- (b) Add a pre-push assertion: count `anchored-v6` / `llm-v6` entries in reviews.json BEFORE the push. If it's <100 (i.e., we lost our rescore), abort.

## 6. Apples-to-apples comparison from W4-T1
**Why:** During Phase B-WE I scared the user with "Book of Mormon -10pts" / "47 shows leaving Critical Gold" — both came from comparing snapshot-all-reviews (counts everything including wrongShow-flagged) vs rebuild-included-only (filters). The apples-to-apples truth was "Book of Mormon 0pts, 3 shows leaving Gold." The naive comparison nearly triggered a rollback.

**How to apply:** Bake apples-to-apples into the W4-T1 verification:
```python
common = set(pre_paths) & set(post_paths)  # only reviews scored in both
pre_avg = sum(pre[p] for p in common) / len(common)
post_avg = sum(post[p] for p in common) / len(common)
```
Surface BOTH numbers in the verification report so the operator can see if a "big drop" is real movement or just set-difference noise.

## Bonus learning: framing the corpus-wide effect honestly
**Why:** 104/127 WE shows moved <±2pts after W3. The system did targeted corrections on the ~20% of shows where V5 was clearly wrong; the rest barely budged. The big visible wins (Hamilton +1.3, Op Mincemeat +1.0) are real but small.

**How to apply:** For BW user-facing comms (post-Tonys explanation post): say "we made the system more correct on the shows where it was wrong, the rest stayed put" — don't oversell the change. Stuart and Dan's complaints ARE addressed but the visible delta is concentrated, not blanket.

## Quick references
- Phase B-WE umbrella: Notion `33f637c5-416f-81a9-9b38-dcb81339a364`
- Sprint plan template: `memory/sprint-plan-anchored-bands-WE.md`
- Snapshot artifact pattern: `~/Documents/claude-outputs/anchored-bands/preWE-rescore-snapshot.jsonl`
- Rollback script template: `scripts/llm-scoring/rollback-we-anchored.sh` (parametrize tag for BW)
