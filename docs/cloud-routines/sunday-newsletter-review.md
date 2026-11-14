# Sunday newsletter review (cloud), one firing

Read by the "Sunday newsletter review (cloud)" routine Sunday ~08:53 ET, before
the owner looks at this week's newsletter drafts. It replaces the Mac's
`scripts/newsletter/sunday-review-launch.sh` (launchd
`com.broadwayscore.newsletter-sunday-review`). The review itself is
`scripts/newsletter/sunday-review-prompt.md`; this doc says how to run it in a
cloud session.

No human is watching. Never send a newsletter broadcast and never call
`POST /broadcasts/{id}/send` (CLAUDE.md §17).

## 0. Setup

In /home/user/Broadwayscore: `git fetch origin main && git checkout -f -B sunday-base origin/main`
(retry with backoff), then `bash scripts/cloud-bootstrap-data.sh | tail -4` and
`npm ci --no-audit --no-fund | tail -2` if `node_modules` is missing.

## 1. Kill switch and cheap pre-check

If `data/newsletter-drafts/SUNDAY_REVIEW_DISABLED` exists, end with
`sunday review disabled`.

    node scripts/newsletter/check-drafts-status.mjs; echo "exit $?"

Exit 3 means every edition is already sent or scheduled: make no changes and end
with `both editions already sent, nothing to review`. Any other exit code
(including 1, the check itself failing) means run the review.

## 2. Run the review

Read `scripts/newsletter/sunday-review-prompt.md` and follow it, with these
cloud substitutions:

- The repo is /home/user/Broadwayscore, not `/Users/tompryor/Broadwayscore`.
- Code fixes go in a worktree made with
  `git worktree add -b <branch> .claude/worktrees/<name> origin/main` and land
  via `git push origin HEAD:refs/heads/land/<name>` followed by
  `node scripts/lib/wait-for-land.js` (.claude/CLOUD.md § Landing). Do not use
  `merge-worktree-to-main.sh` or push to main directly.
- The owner summary email in the prompt's last step is sent only if
  `RESEND_API_KEY` and `OWNER_EMAIL` are set, as one transactional
  `POST /emails` to `$OWNER_EMAIL`. If they are not set, post the same summary
  as a comment on a Linear issue titled "Sunday newsletter review <date>"
  (`node scripts/linear-brain.js create ... --source routine:sunday-newsletter-review --park "routine record"`) instead.
- Stop after 60 minutes of work: finish or card what you are on, then send the
  summary last, as the prompt says.

## Known cloud gaps (BRO-6258, checked 2026-10-26)

- `refresh-drafts.sh` now has a cloud mode (no `.env`, no pulls or pushes to
  main, output under `$TMPDIR/newsletter-mocks`), and the prompt's
  `set -a; source .env` line can be skipped: the keys are already in the
  environment.
- The refresh step still HARD-FAILS at `pre-send-check.mjs` in cloud: the
  most-read-pages section needs `GA4_PROPERTY_ID` and the GA service account,
  which cloud sessions do not have. The Resend draft is therefore not PATCHed,
  and nothing exists on disk to fall back to. The routine stays disabled until
  GA4 reaches the environment or the owner decides the issue may go out without
  that section (`NEWSLETTER_ALLOW_NO_ACCESS=1`).

## 3. Reply

Three plain-English lines: what you reviewed, what you fixed, how the owner was
told. End with `SAFE TO ARCHIVE`.
