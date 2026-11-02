# BRO-6716 state (2026-11-02 ~23:05Z)

## Done
- Code (sister-site reprints, --show=all refusal + slow-market-grade window gate, UK regional = London pool,
  wrong-author clear, edit-then-move advisory, browser-error junk body, Arts Desk byline) committed and
  pushed to land/job/linear-BRO-6716-mvzso4yj (land run 41541670759). Reviewed by review-panelist + codex.
- Gap-audit batches A (41532670452), B (41536527744), C (41539135036) dispatched for the 43 never-audited shows.

## Status 23:35Z
- LANDED on main (79f32c3d0de, land run 41541670759 success). Plans g/h dispatched: runs 41546272942, 41546311046.
- Grade on main now: PASS 104, STALE 945, FAIL 12, NO-AUDIT 0 (was PASS 62 / STALE 944 / FAIL 12 / NO-AUDIT 43).
- FAIL left: 9 fixed by plans g/h + code but not re-audited yet; the-monsters (BRO-6736); NEW: ceilidh-the-musical-off-west-end-2026,
  parsifal-off-west-end-2026 (found by the new audits, not yet looked at).

## Remaining (exact next commands, from ~/Broadwayscore on up-to-date main)
1. scripts/lib/wait-for-run.sh 41541670759 30   # land must be green; if red, read the Checks job log
2. gh workflow run execute-approved-fix.yml -f issue_number=bro-6716-g -f plan_id=a3eba157-40b8-4927-92f2-fca10afe5540
3. gh workflow run execute-approved-fix.yml -f issue_number=bro-6716-h -f plan_id=bd432281-2874-48e3-a8b8-3d8b58d358ae
4. After the plans + a rebuild: gh workflow run audit-aggregator-gap.yml -f show_ids="$(cat /tmp/batchD)"
   (batch D = the 12 FAIL shows minus harold-fry/high-noon; ids in the Linear outcome comment)
5. node scripts/slow-market-grade.js --opened-from=2025-10-31 --opened-to=2026-10-31 --check-gaps
6. node scripts/linear-session.js report --issue=BRO-6716 --status=done|in-review ...
