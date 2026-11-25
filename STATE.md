# BRO-8282 state
Done: scripts/lib/owner-decision-session-link.js (+email link in buildDecisionEmail/buildRoundupEmail, wired in send-owner-decision-emails.js), tests pass (39/39 incl. visual-approval-email).
Pushed to origin/land/job/linear-BRO-8282-mwvfppda (tip 4f39918ece); land.yml run 45529426259 was still queued.
Remaining: confirm it landed, then report done.
Next: git fetch origin main && git merge-base --is-ancestor 4f39918ece origin/main && node --test scripts/lib/owner-decision-email.test.mjs
