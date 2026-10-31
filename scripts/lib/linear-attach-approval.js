// Shared attachment implementation for the manual CLI and visual push gate.
'use strict';

const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { execSync } = require('child_process');
const linear = require('./linear-client.js');
const { AWAITING_OWNER_LABEL } = require('./owner-approval-channel.js');
const { hasHelpFlag } = require('./cli-help.js');
const { withFileLock } = require('./file-lock.js');

const USAGE = `linear-attach-approval - attach visual-qa crops to a Linear issue as an
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

function currentBranch(cwd = process.cwd()) {
  try {
    return execSync('git branch --show-current', { encoding: 'utf8', cwd }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

// visual-qa.mjs nests output one directory per captured path
// (.claude/visual-qa/<branch>/<slug>/<width>__<selector>.png), so this walks
// recursively rather than assuming a flat directory. Prefers the
// "__"-named element crops (visual-qa.mjs's own full-resolution,
// tight-to-the-change captures) over the bare "<width>.png" full-page
// screenshots when both exist - same "read the crops, not the thumbnails"
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

async function main(argv = process.argv.slice(2), { client = linear, logger = console, fingerprint = null } = {}) {
  if (hasHelpFlag(argv)) {
    logger.log(USAGE);
    return;
  }
  const args = parseArgs(argv);
  if (!args.issue) {
    throw new Error(USAGE);
  }

  const dir = args.dir || path.join('.claude', 'visual-qa', currentBranch());
  const crops = findCrops(dir);
  if (!crops.length) {
    throw new Error(`No crop images found in ${dir}`);
  }

  const issue = await client.getIssue(args.issue);
  if (!issue) {
    throw new Error(`Issue ${args.issue} not found`);
  }

  // Label BEFORE uploading (ship-check finding, BRO-282): a crop upload can
  // fail partway through a multi-crop batch (flaky network, a big full-res
  // PNG). If the label were applied last, a partial failure would leave the
  // issue attached-but-unlabeled - invisible to the digest even though real
  // work is sitting on the issue waiting for a look. Labeling first means the
  // digest surfaces the issue the moment this script starts, not only if
  // every crop happens to succeed. addLabelToIssue reads the issue's current
  // labels itself right before writing (not from the `issue` fetched above),
  // so this doesn't rely on a snapshot that predates the whole call.
  const team = await client.getTeam();
  const label = await client.findOrCreateLabel(team.id, AWAITING_OWNER_LABEL);
  await client.addLabelToIssue(issue.id, label.id);

  const uploaded = [];
  let uploadError = null;
  for (const file of crops) {
    const contentType = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
    try {
      const attachment = await client.attachFileToIssue({
        issueId: issue.id,
        filePath: file,
        title: `${args.issue} - ${path.basename(file)}`,
        contentType,
      });
      uploaded.push(attachment);
      logger.log(`Attached ${path.basename(file)} -> ${attachment.url}`);
    } catch (err) {
      uploadError = err;
      logger.error(`Failed to attach ${path.basename(file)}: ${err.message}`);
      break; // keep whatever succeeded; don't retry mid-batch
    }
  }

  // Comment always runs, even on partial failure - a labeled-but-silent issue
  // (no comment explaining why only some crops are there) is worse than one
  // that says plainly what happened.
  await client.createComment(
    issue.id,
    uploadError
      ? `Waiting on your approval: ${uploaded.length} of ${crops.length} visual-qa crop${crops.length === 1 ? '' : 's'} attached above before an upload failed (${uploadError.message}). ` +
        `Re-run \`node scripts/linear-attach-approval.js --issue=${args.issue} --dir=${dir}\` to retry - it will re-upload the crops already attached, so remove those first if you want a clean set. ` +
        `Reply here or remove the '${AWAITING_OWNER_LABEL}' label once you've reviewed.`
      : `Waiting on your approval: ${uploaded.length} visual-qa crop${uploaded.length === 1 ? '' : 's'} attached above. ` +
        `This UI change is finished but cannot ship until you look and confirm - the pre-push hook blocks it either way. ` +
        `Reply here or remove the '${AWAITING_OWNER_LABEL}' label once you've reviewed.` +
        (fingerprint ? `\n\n${fingerprintMarker(fingerprint)}` : '')
  );

  if (uploadError) {
    logger.error(`${args.issue} marked ${AWAITING_OWNER_LABEL} with ${uploaded.length}/${crops.length} attachment(s) - upload failed partway.`);
    throw uploadError;
  }
  logger.log(`${args.issue} marked ${AWAITING_OWNER_LABEL} with ${uploaded.length} attachment(s).`);
}


// BRO-6539: the local .linear-approval.json marker is per worktree and per
// checkout, so a fresh worktree or session re-posted "Waiting on your approval"
// 2.5h after the owner approved BRO-4303. The card is the shared memory.
const FINGERPRINT_RE = /Evidence fingerprint ([0-9a-f]{12})/;
function fingerprintMarker(fingerprint) { return `Evidence fingerprint ${String(fingerprint).slice(0, 12)}`; }

/** Why the card must not get another "Waiting on your approval", or null to go ahead. */
function cardAlreadySettled(comments, fingerprint) {
  const body = (c) => String(c.body || '');
  const fps = (comments || []).map((c) => (FINGERPRINT_RE.exec(body(c)) || [])[1]).filter(Boolean);
  if (fps.includes(String(fingerprint).slice(0, 12))) return 'this evidence is already on the card';
  // Asks that carry a fingerprint are matched exactly: an old approval says nothing about new crops.
  if (fps.length) return null;
  // Legacy card (no fingerprints yet): an old answer cannot vouch for this evidence, so post once; the posted comment carries the fingerprint and dedupes from then on.
  return null;
}

function issueFromContext(branch, repo) {
  const ids = (name) => [...new Set([...name.matchAll(/(?:^|[^a-z0-9])BRO-([1-9]\d*)(?=$|[^a-z0-9])/gi)]
    .map((match) => `BRO-${match[1]}`))];
  const branchIds = ids(branch);
  if (branchIds.length) return branchIds.length === 1 ? branchIds[0] : null;
  // An explicit push of another branch must never inherit this workspace's issue.
  if (branch !== currentBranch(repo)) return null;
  const workspaceIds = ids(path.basename(repo));
  return workspaceIds.length === 1 ? workspaceIds[0] : null;
}

async function notifyBlockedApproval({ branch, repo, dir }, dependencies = {}) {
  const issue = issueFromContext(branch, repo);
  if (!issue) return { status: 'skipped', reason: 'no unambiguous issue in branch/workspace' };
  const verdict = JSON.parse(fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8'));
  // Failed or incomplete QA needs repair before asking the owner to approve it.
  if (verdict.schemaVersion !== 2 || verdict.overallPass !== true || !verdict.contentHash) {
    return { status: 'skipped', reason: 'visual QA is not ready for approval' };
  }
  const crops = findCrops(dir);
  if (!crops.length) return { status: 'skipped', reason: 'no crop images' };
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  const fingerprint = digest(JSON.stringify({
    issue, contentHash: verdict.contentHash,
    crops: crops.map((file) => [path.relative(dir, file), digest(fs.readFileSync(file))]),
  }));
  const marker = path.join(dir, '.linear-approval.json');
  const lock = path.join(dir, '.linear-approval.lock');
  const owner = randomUUID();
  const guardOptions = { timeoutMs: 10, waitMs: 2, staleMs: 90_000, abandonedMs: 90_000 };
  // The auto CLI is killed after 45s. A longer lease recovers interrupted runs.
  // Serialize lease transitions with the existing synchronous lock primitive.
  // A naked stale stat+unlink can delete a different process's new live lock.
  const acquired = withFileLock(`${lock}.guard`, (held) => {
    if (!held) return false;
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs <= 90_000) return false;
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
    fs.writeFileSync(lock, JSON.stringify({ owner }));
    return true;
  }, guardOptions);
  if (!acquired) return { status: 'skipped', reason: 'upload already in progress' };
  try {
    let previous;
    try { previous = JSON.parse(fs.readFileSync(marker, 'utf8')); }
    catch (err) { if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err; }
    if (previous?.fingerprint === fingerprint) return { status: 'already-attached', issue };
    const client = dependencies.client || linear;
    // A failed read falls back to the old behavior (post once, marker-deduped) rather than hiding the ask.
    let comments = [];
    try { comments = (await client.listIssueComments([issue])).get(issue) || []; } catch { /* keep going */ }
    const settled = cardAlreadySettled(comments, fingerprint);
    if (settled) {
      fs.writeFileSync(marker, JSON.stringify({ issue, fingerprint }) + '\n');
      return { status: 'skipped', issue, reason: settled };
    }
    await main([`--issue=${issue}`, `--dir=${dir}`], { ...dependencies, fingerprint });
    fs.writeFileSync(marker, JSON.stringify({ issue, fingerprint }) + '\n');
    return { status: 'attached', issue, crops: crops.length };
  } finally {
    withFileLock(`${lock}.guard`, (held) => {
      if (!held) return;
      try {
        if (JSON.parse(fs.readFileSync(lock, 'utf8')).owner === owner) fs.unlinkSync(lock);
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }, guardOptions);
  }
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  // No detached background uploads: timeout or failure must leave the push blocked.
  const timer = setTimeout(() => {
    console.error('[visual-qa] Linear approval attachment timed out; push remains blocked.');
    process.exit(1);
  }, 45_000);
  notifyBlockedApproval(args, { logger: { log() {}, error() {} } }).then((result) => {
    console.error(`[visual-qa] owner channel: ${result.status}${result.issue ? ` (${result.issue})` : ''}${result.reason ? `: ${result.reason}` : ''}`);
  }).catch(() => {
    // API error bodies can contain credentials or uploaded asset URLs.
    console.error('[visual-qa] Could not attach approval evidence to Linear; push remains blocked. Retry after checking Linear access.');
    process.exitCode = 1;
  }).finally(() => clearTimeout(timer));
}

module.exports = { parseArgs, findCrops, currentBranch, main, USAGE, issueFromContext, notifyBlockedApproval, cardAlreadySettled, fingerprintMarker };
