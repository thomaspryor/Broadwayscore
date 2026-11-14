# BRO-7156 state (session 2026-11-13/14)

Done:
- 5 of the card's 6 stubs were already typed by an earlier run (bro-7156.json etc).
- Standing On the Corner (Cherry Lane, previews 2026-12-17): NOT typable. Vivenu box office placeholder only
  (blank description, no image); the venue's own December calendar does not list it. Validator warns from
  2026-11-17 and errors from 2026-12-17 if still untyped. Recheck 2026-12-10.
- Found 4 same-run duplicate rows (one was a new untyped stub, honor-an-artist-lecture-off-broadway-2027).
- Step 1 commits (cb9f970, 61d2e28): isSameRunLeadingTitle + retire/retitle support + plan bro-7156-b. Land run 43534748155.

Remaining:
1. After step 1 lands on main: node scripts/cloud-dispatch.js execute-approved-fix.yml -f issue_number=bro-7156-b -f plan_id=698bcd04-e6ff-4bbd-947e-cb64070a399f -f mode=apply --wait
2. Step 2 (only after the plan applied): copy /tmp/bro7156/new/deduplication.js (Check 7d only) and the normaliser 1a' step
   (/tmp/bro7156/new/show-title-normalize.js) + test /tmp/bro7156/same-run-leading-title-dedup.test.mjs; validate-data must be 0 errors; land.
3. node scripts/linear-session.js report --issue=BRO-7156 ...
