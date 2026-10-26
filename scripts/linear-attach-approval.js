#!/usr/bin/env node
/**
 * linear-attach-approval.js — BRO-282: attach visual-qa crops to a Linear
 * issue and mark it awaiting-owner, so the thing to approve lives WITH the
 * ask instead of on a local path on one machine (the original hole: a UI
 * change could finish, park behind the /visual-qa pre-push gate, and the
 * owner would never learn about it once the session closed).
 *
 * Usage:
 *   node scripts/linear-attach-approval.js --issue=BRO-5 [--dir=.claude/visual-qa/<branch>/]
 *
 * Uploads every PNG/JPG in --dir (default: .claude/visual-qa/<current
 * branch>/, visual-qa.mjs's own output dir) as a Linear attachment on the
 * issue, adds the 'awaiting-owner' label (creating it on the team if it
 * doesn't exist yet), and posts a summary comment. The digest picks up any
 * issue carrying that label the next time it runs (see
 * scripts/lib/owner-approval-channel.js + send-morning-digest.js).
 *
 * Re-running re-uploads — this is a manual/session-triggered step, not a
 * cron with dedupe logic, so avoid calling it twice for the same crop set.
 */
'use strict';

const approval = require('./lib/linear-attach-approval.js');

if (require.main === module) {
  approval.main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = approval;
