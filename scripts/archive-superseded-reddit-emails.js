#!/usr/bin/env node
/**
 * archive-superseded-reddit-emails.js: archive the older Reddit draft emails
 * in the owner's Gmail inbox, keeping the newest per show and subreddit, and
 * every such email once it is more than 7 days old.
 * Logic and rationale: scripts/lib/reddit-email-archive.js.
 *
 *   node scripts/archive-superseded-reddit-emails.js            # archive them
 *   node scripts/archive-superseded-reddit-emails.js --dry-run  # list only, change nothing
 *   node scripts/archive-superseded-reddit-emails.js --expect-file=FILE
 *       FILE holds the subjects send-reddit-post-email.js just sent (one per line, from
 *       $SENT_SUBJECTS_FILE); wait up to 2 min for them to reach the inbox before archiving.
 *
 * Env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN. The token
 * must carry gmail.modify (renew it with gmail-reauth.yml). Exit 0 on success
 * (including "nothing to do"), 1 on any failure; the workflow step that runs
 * it is continue-on-error, so a failure never stops the draft email job.
 * Never prints a token.
 */

'use strict';

require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const { sweep, GmailScopeError } = require('./lib/reddit-email-archive');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const expectArg = process.argv.find((a) => a.startsWith('--expect-file='));
  let expectSubjects = [];
  if (expectArg) {
    try { expectSubjects = fs.readFileSync(expectArg.slice('--expect-file='.length), 'utf8').split('\n').map((x) => x.trim()).filter(Boolean); } catch { /* nothing was sent this run */ }
  }
  const r = await sweep({ dryRun, expectSubjects });
  console.log(dryRun ? `Dry run: would archive ${r.wouldArchive}, archived 0.` : `Archived ${r.archived} superseded Reddit draft email(s).`);
}

main().catch((e) => {
  console.error(`${e instanceof GmailScopeError ? '::error::' : '::warning::'}Reddit email archive did not run: ${e.message}`);
  process.exit(1);
});
