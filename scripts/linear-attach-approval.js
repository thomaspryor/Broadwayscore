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

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const linear = require('./lib/linear-client.js');
const { AWAITING_OWNER_LABEL } = require('./lib/owner-approval-channel.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `linear-attach-approval — attach visual-qa crops to a Linear issue as an
owner-approval ask (BRO-282).

Usage:
  node scripts/linear-attach-approval.js --issue=BRO-5 [--dir=path/to/crops]

  --issue   required. Linear identifier (e.g. BRO-5).
  --dir     optional. Defaults to .claude/visual-qa/<current git branch>/.
`;

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function currentBranch() {
  try {
    return execSync('git branch --show-current', { encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

// visual-qa.mjs nests output one directory per captured path
// (.claude/visual-qa/<branch>/<slug>/<width>__<selector>.png), so this walks
// recursively rather than assuming a flat directory. Prefers the
// "__"-named element crops (visual-qa.mjs's own full-resolution,
// tight-to-the-change captures) over the bare "<width>.png" full-page
// screenshots when both exist — same "read the crops, not the thumbnails"
// preference visual-qa.mjs's own AGENT INSTRUCTIONS output states.
function walkImages(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkImages(full));
    else if (/\.(png|jpe?g)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function findCrops(dir) {
  if (!fs.existsSync(dir)) return [];
  const all = walkImages(dir).sort();
  const elementCrops = all.filter((f) => path.basename(f).includes('__'));
  return elementCrops.length ? elementCrops : all;
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return;
  }
  const args = parseArgs(argv);
  if (!args.issue) {
    console.error(USAGE);
    process.exit(1);
  }

  const dir = args.dir || path.join('.claude', 'visual-qa', currentBranch());
  const crops = findCrops(dir);
  if (!crops.length) {
    console.error(`No crop images found in ${dir}`);
    process.exit(1);
  }

  const issue = await linear.getIssue(args.issue);
  if (!issue) {
    console.error(`Issue ${args.issue} not found`);
    process.exit(1);
  }

  // Label BEFORE uploading (ship-check finding, BRO-282): a crop upload can
  // fail partway through a multi-crop batch (flaky network, a big full-res
  // PNG). If the label were applied last, a partial failure would leave the
  // issue attached-but-unlabeled — invisible to the digest even though real
  // work is sitting on the issue waiting for a look. Labeling first means the
  // digest surfaces the issue the moment this script starts, not only if
  // every crop happens to succeed. addLabelToIssue reads the issue's current
  // labels itself right before writing (not from the `issue` fetched above),
  // so this doesn't rely on a snapshot that predates the whole call.
  const team = await linear.getTeam();
  const label = await linear.findOrCreateLabel(team.id, AWAITING_OWNER_LABEL);
  await linear.addLabelToIssue(issue.id, label.id);

  const uploaded = [];
  let uploadError = null;
  for (const file of crops) {
    const contentType = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
    try {
      const attachment = await linear.attachFileToIssue({
        issueId: issue.id,
        filePath: file,
        title: `${args.issue} — ${path.basename(file)}`,
        contentType,
      });
      uploaded.push(attachment);
      console.log(`Attached ${path.basename(file)} -> ${attachment.url}`);
    } catch (err) {
      uploadError = err;
      console.error(`Failed to attach ${path.basename(file)}: ${err.message}`);
      break; // keep whatever succeeded; don't retry mid-batch
    }
  }

  // Comment always runs, even on partial failure — a labeled-but-silent issue
  // (no comment explaining why only some crops are there) is worse than one
  // that says plainly what happened.
  await linear.createComment(
    issue.id,
    uploadError
      ? `Waiting on your approval: ${uploaded.length} of ${crops.length} visual-qa crop${crops.length === 1 ? '' : 's'} attached above before an upload failed (${uploadError.message}). ` +
        `Re-run \`node scripts/linear-attach-approval.js --issue=${args.issue} --dir=${dir}\` to retry — it will re-upload the crops already attached, so remove those first if you want a clean set. ` +
        `Reply here or remove the '${AWAITING_OWNER_LABEL}' label once you've reviewed.`
      : `Waiting on your approval: ${uploaded.length} visual-qa crop${uploaded.length === 1 ? '' : 's'} attached above. ` +
        `This UI change is finished but cannot ship until you look and confirm — the pre-push hook blocks it either way. ` +
        `Reply here or remove the '${AWAITING_OWNER_LABEL}' label once you've reviewed.`
  );

  if (uploadError) {
    console.error(`${args.issue} marked ${AWAITING_OWNER_LABEL} with ${uploaded.length}/${crops.length} attachment(s) — upload failed partway.`);
    process.exit(1);
  }
  console.log(`${args.issue} marked ${AWAITING_OWNER_LABEL} with ${uploaded.length} attachment(s).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { parseArgs, findCrops, currentBranch, main, USAGE };
