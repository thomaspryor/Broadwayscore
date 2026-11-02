# BRO-6716 state (2026-11-02 ~22:25Z)

## Done (committed on job/linear-BRO-6716-mvzso4yj)
- Sister-site same-path reprints count as held (syndication-canonical + syndicated-reprint-match + gap audit).
- --show=all refused by verify-data-backfill/check-paths; slow-market-grade --opened-from/--opened-to/--check-gaps.
- UK regional shows pool with London (getShowMarketPool) in market-routing, prior-run-sibling, gap audit.
- fullTextWrongAuthor clear-only edit; move-plan-checks counts pre-move edits.
- junk-body: browser error page = junk (refetch replaces).
- Arts Desk byline: dateline + class=author link; prose "</a>by X" not a byline (67 files).
- Plans data/pending-fixes/bro-6716-g.json (planId a3eba157-40b8-4927-92f2-fca10afe5540) and bro-6716-h.json (planId bd432281-2874-48e3-a8b8-3d8b58d358ae).

## Remaining
1. Land branch on main (after /ship-check verdict).
2. gh workflow run execute-approved-fix.yml -f issue_number=bro-6716-g -f plan_id=a3eba157-40b8-4927-92f2-fca10afe5540 ; then bro-6716-h with bd432281-2874-48e3-a8b8-3d8b58d358ae
3. Gap-audit batches /tmp/batchB, /tmp/batchC (dispatched by /tmp/bro6716/chain.sh after batch A run 41532670452).
4. Check: node scripts/slow-market-grade.js --opened-from=2025-10-31 --opened-to=2026-10-31 --check-gaps
5. node scripts/linear-session.js report --issue=BRO-6716 ...
