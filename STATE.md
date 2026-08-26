# BRO-318 — main test.yml STILL red — session state (interrupted, resumed, interrupted again)

## Root cause found
`data-validation` job in test.yml fails on every main push with:
"Found 1 NEW duplicate URL(s) within same show+outlet in reviews.json:
queen-versailles-2025: Vulture | .../theater-review-the-queen-of-versailles-broadway-... (Sara Holdren, David Fox)"

`data/reviews.json` (public repo, derived) contains TWO Vulture entries for queen-versailles-2025
(criticName "Sara Holdren" and criticName "David Fox"), both with `duplicateOf: null` — i.e. NOT
deduped.

But the private repo source of truth (`~/broadway-review-texts/queen-versailles-2025/`) already has
the correct flags, committed 2026-08-15 in `76b9ad9cf07` "fix: collapse 59 byline-explosion clusters
(task #1627)":
- `vulture--sara-holdren-and-jesse-david-fox.json` — canonical, `duplicateOf: null` (the keeper)
- `vulture--david-fox.json` — `duplicateOf: vulture--sara-holdren-and-jesse-david-fox.json`
- `vulture--sara-holdren.json` — `duplicateOf: ...`, `wrongProduction: true`
- `vulture--jackson-mchenry.json` — `duplicateOf: ...`

So `reviews.json` is simply STALE relative to the fixed source files — it was never rebuilt with the
post-8/15 state for this show. `rebuild-all-reviews.js`'s duplicateOf exclusion logic
(scripts/lib/review-guards.js ~L2880) looks correct on inspection; I did not find a code bug in the
20 min available — the leading theory is a stale rebuild, not broken dedup logic. **Needs
confirmation**: check whether rebuild-fast.yml/rebuild-reviews.yml runs since 2026-08-15 actually
touched queen-versailles-2025 (grep their run logs / commit diffs for the show), or whether they've
been silently no-op'ing / failing for this show specifically.

## Action taken this session
Dispatched `gh workflow run "Rebuild Reviews Data" -f reason="BRO-318: fix stale reviews.json..."`
→ run https://github.com/thomaspryor/Broadwayscore/actions/runs/32271630295

**NOT YET VERIFIED** — session was killed before the run could be checked. Also note: `gh run list
--workflow=test.yml --branch=main` returns STALE data (last entry 2026-08-05) — use
`gh api repos/thomaspryor/Broadwayscore/actions/workflows/227151982/runs?branch=main&event=push`
instead (workflow id 227151982 confirmed via `gh api .../actions/workflows`). This CLI staleness
bug is itself worth a quick look if it recurs (possibly a gh CLI cache issue, unconfirmed).

## Next steps (exact commands)
1. Check the rebuild run's outcome:
   `gh run view 32271630295 --json status,conclusion`
   (or `gh api repos/thomaspryor/Broadwayscore/actions/runs/32271630295`)
2. If it succeeded, re-check reviews.json for the duplicate:
   `git -C ~/broadway-scorecard-data pull && python3 -c "import json; d=json.load(open('/Users/tompryor/broadway-scorecard-data/reviews.json')); print([r for r in d['reviews'] if r.get('showId')=='queen-versailles-2025' and 'vulture' in json.dumps(r).lower()])"`
   Expect exactly ONE vulture entry now (criticName "Sara Holdren and Jesse David Fox"), not two.
3. If still duplicated after a successful rebuild → THAT is the real bug (dedup logic issue) —
   re-read `scripts/lib/review-guards.js` around `duplicateOfCircularTiebreak` (~L2906) and
   `rebuild-all-reviews.js` L1599/L1653 (cascade-clear before unlink) for why these 2 particular
   files aren't being excluded. Also check `data/audit/same-url-duplicate-baseline.json` — do NOT
   add this pair to the baseline (that's the wrong fix per the validator's own error message).
4. Once reviews.json is fixed and pushed, push a trivial commit to main (or wait for next
   scheduled push) to get a fresh main test.yml run, and confirm streak resolves:
   `node scripts/health-check.js` should no longer list "main test.yml STILL red — auto-dispatch
   did not resolve it".
5. Run acceptance check:
   `node scripts/check-health-row-absent.js --row-b64 bWFpbiB0ZXN0LnltbCBTVElMTCByZWQg4oCUIGF1dG8tZGlzcGF0Y2ggZGlkIG5vdCByZXNvbHZlIGl0`
6. Prevention (CLAUDE.md rule 4 — fix root cause + prevention): once confirmed root cause, consider
   whether rebuild-fast/rebuild-reviews needs a guard that fails loudly (not silently) if a show's
   review-text duplicateOf flags don't match its reviews.json state — i.e. a drift detector between
   source flags and derived output, so stale-rebuild bugs like this surface immediately instead of
   redenning main for 4+ days.
7. Comment on Linear BRO-318 with outcome, set state to "In Review" only once verified fixed and
   ship-check run. If still investigating, leave as "In Progress" and comment what's blocking.

## Not yet done
- No code changes made yet (investigation only).
- /ship-check not run (nothing to ship yet).
- Linear comment not yet posted for this final state — DO THIS FIRST on resume if not already done.
