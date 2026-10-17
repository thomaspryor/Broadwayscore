#!/usr/bin/env node
'use strict';

/**
 * BRO-4454 CLI for process-review-submission.yml (kept out of
 * submitter-contact.js, which the Next.js route bundles):
 *   node scripts/lib/submitter-contact-cli.js extract <issue-body-file>
 * Prints the submitter's address or nothing, and never prints anything that
 * could carry the token or the address. Exit 0, except exit 3 when a sealed
 * token is present but does not decrypt with APPROVAL_HMAC_SECRET, so the
 * workflow can warn instead of skipping silently.
 */

const fs = require('fs');
const { extractSubmitterEmail, sealedContactUndecryptable } = require('./submitter-contact');

const [cmd, file] = process.argv.slice(2);
if (cmd !== 'extract' || !file) {
  process.stderr.write('usage: submitter-contact-cli.js extract <issue-body-file>\n');
  process.exit(2);
}
let body = '';
try {
  body = fs.readFileSync(file, 'utf8');
} catch {
  body = '';
}
const secret = process.env.APPROVAL_HMAC_SECRET;
const email = extractSubmitterEmail(body, secret);
if (email) process.stdout.write(email);
else if (sealedContactUndecryptable(body, secret)) process.exit(3);
