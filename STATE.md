# BRO-3577 state

Done: root-caused the em-20260916-012154 email escalation (see Linear comment
+ memory/email-broadcast-rules.md), fixed it (scripts/lib/test-send-marker.js
wired into send-btc-confirmation-emails.js + send-btc-results.js), tests
pass (12/12), merged latest origin/main into this branch cleanly, no
conflicts, tests re-verified green post-merge. PR open:
https://github.com/thomaspryor/Broadwayscore/pull/865. Adversarial code
review dispatched (background agent) to satisfy the ship-check gate.

Remaining: once the review comes back clean (or findings fixed), record the
verdict (`node scripts/lib/review-gate.mjs --query=record --reviewer=ship-check --result=pass`),
then land directly on main via `bash scripts/lib/push-with-retry.sh 7 main`
(per exit-status-gate hook instruction — direct push is the norm here, PR
merge is not required), verify `git log origin/main..HEAD` is empty, close
PR 865 as superseded-by-direct-push if still open, then report Done to
Linear via `node scripts/linear-session.js report --issue=BRO-3577 --status=done ...`
with PR-EVIDENCE.

Next command: check on the background review agent's result, act on it.
