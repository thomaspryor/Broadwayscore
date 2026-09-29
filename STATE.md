# BRO-4265 state
- Done: tm-gap-links test made closure-proof (scripts/tests/tm-gap-links.test.mjs); land-gate routing fix (scripts/lib/autonomous-checks.js + test) so tsx-manifest .test.mjs runs under tsx. Both pass locally; second-opinion recorded.
- Main was already green for the TM test after 76ca8763edc; this change prevents recurrence.
- Remaining: land branch land/bro-4265-tm-gap-test-2 (first attempt failed colocated-tests under plain node = the bug fixed here; second run was cancelled by queue).
- Next: gh run list --branch land/bro-4265-tm-gap-test-2 ; confirm `git diff origin/main HEAD -- scripts/lib/autonomous-checks.js` is empty, then linear-session.js report --status=done.
