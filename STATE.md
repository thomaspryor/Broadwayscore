# STATE — BRO-2275 crown session (headless, 2026-08-27)

## Done and verified
- **Acceptance PASS**: `node --test tests/unit/dispatch-stall-detection.test.mjs` → 19/19.
- **Fixed main-red**: `test.yml` had failed 4 consecutive push runs on main. Two real test
  failures fixed, one self-healed. Merge commit `f984da52ca7` on `origin/main`, verified by
  content (`git show 'origin/main:<file>'`), 0 unpushed, 0 conflicts.
  - `tests/unit/audit-same-job-breadcrumb-coverage.test.mjs` — exact-count 11 → floor `>= 11`.
    All 12 real sites enumerated, all fields allowlisted, no cross-attribution.
  - `tests/unit/email-capture-integrity.test.mjs` — added `src/app/api/feedback/route.ts` to
    KNOWN_FALLBACKS, then (post `/code-review`) tightened the exemption to require the
    violating LINE be a `process.env.X || ...` fallback. Negative control proved it catches a
    bare literal at `route.ts:146`.
  - `no [AUTO-FLAGGED] entries older than 30 days` — self-healed on main at 01:44:09Z.
- **Outcome comment posted on BRO-2275.**

## Open at hand-off
- **CI run `33032085979`** (on merge commit `f984da52c`) was still `in_progress` at session end.
  Confirm it went green:
  `gh run view 33032085979 --json status,conclusion --jq '"\(.status) \(.conclusion)"'`
  It should clear the `Unit Tests` job. The `Data Validation` job was ALSO failing before my
  change, on two steps I did NOT touch: `Audit outlet-registry gaps` and
  `Validate provisional show venue+dates against Playbill`. **Those are still open.**
- **BRO-714 is complete and live on prod but its card sits in "In Progress" with no completion
  comment.** Verified: prod serves 7 reviews incl. NYT @50 for
  `monte-cristo-the-york-theatre-company-off-broadway-2026`. Just needs closing.
- BRO-679, BRO-504 have unmerged remote branches. 31 unmerged job branches total.

## The finding to act on next
**Zero of the 13 open P1s are dispatchable** — 8 refused `NO_VERIFY_CMD`, 5 `ASYNC_WAIT_GATE`.
The funnel's 119 "ready" cards are 116 P2s, mostly auto-filed `BSC Daily:` health cards.
Fix by rewriting each P1's acceptance to put a safe-form command in **inline single backticks,
first in the body**. Several already NAME real commands that the extractor cannot see because
they are bare text, not backticked. Verified directly:
- `node scripts/audit-help-flag-safety.js` → exit 0
- `node scripts/audit-sibling-title-misroute.js --strict` → exit 0
- `node scripts/audit-stale-flag-after-url-correction.js --gate` → **exit 1, 120 files** — the
  #483 cluster (BRO-2050/2090/2093) is genuinely open. Remedy is a refetch, NEVER a flag-clear.

## Exact next command
```
gh run view 33032085979 --json status,conclusion --jq '"\(.status) \(.conclusion)"'
```
Then, if green, re-run the funnel: `node /tmp/funnel2.js` (recreate from BRO-2275 transcript if
gone) and start rewriting P1 acceptance blocks.

## Do not re-litigate
BRO-268 FAIL verdict — do not merge. BRO-2439 deliberately held. BRO-113/140/580 stale
ship-check verdicts. cmux still cannot attach a terminal — no tab successor crowned; needs an
owner-side cmux restart. Forbes call with Marc Hershberg still unscheduled (Nov 1 publish).
