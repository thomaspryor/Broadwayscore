#!/usr/bin/env node
/**
 * visual-approval.js (BRO-6241) — a worker asks the owner "does this look right?"
 * after running /visual-qa, without the owner in the session.
 *
 *   node scripts/visual-approval.js request --issue=BRO-N --what="the show page header" [--dir=<crops dir>] [--dry-run]
 *
 * Needs: the change committed on the current branch, a fresh verdict from
 * `node scripts/visual-qa.mjs` (.claude/visual-qa/<branch>/verdict.json).
 * Pushes the commits to visual-hold/bro-n and the screenshots to
 * visual-evidence/bro-n (neither ever lands), then writes ONE DECISION NEEDED
 * block on the card. The owner sees it on the decision list and in the daily
 * email; Approve lets visual-approval-land.yml ship the held change.
 * Exit: 0 asked, 1 refused (message says why), 2 usage.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const va = require('./lib/visual-approval.js');
const link = require('../src/lib/owner-decision-link.js');

const USAGE = 'Usage: node scripts/visual-approval.js status --issue=BRO-N | request --issue=BRO-N --what="<plain words>" [--dir=<crops dir>] [--summary="..."] [--dry-run]';

function arg(argv, name) { const a = argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : ''; }

async function request(argv) {
  const issueId = arg(argv, 'issue');
  const what = arg(argv, 'what');
  const dryRun = argv.includes('--dry-run');
  if (!/^BRO-\d+$/.test(issueId) || !what) { console.error(USAGE); return 2; }
  const cwd = process.cwd();
  const branch = va.git(['branch', '--show-current'], { cwd }) || 'detached';
  const dir = arg(argv, 'dir') || path.join('.claude', 'visual-qa', branch);

  if (va.git(['status', '--porcelain'], { cwd })) { console.error('Refused: uncommitted changes. Commit first so the owner approves exactly what is saved.'); return 1; }
  let verdict;
  try { verdict = JSON.parse(fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8')); } catch { console.error(`Refused: no verdict.json in ${dir}. Run node scripts/visual-qa.mjs first.`); return 1; }
  if (!verdict.contentHash) { console.error('Refused: verdict.json has no contentHash.'); return 1; }
  if (verdict.overallPass !== true) { console.error('Refused: the visual check did not pass. Fix the findings, re-run visual-qa, then ask.'); return 1; }
  if (verdict.headSha && verdict.headSha !== va.git(['rev-parse', 'HEAD'], { cwd })) { console.error('Refused: the verdict was made on a different commit than HEAD. Re-run node scripts/visual-qa.mjs.'); return 1; }

  va.git(['fetch', 'origin', 'main', '--quiet'], { cwd });
  const patch = va.patchId('origin/main', 'HEAD', cwd);
  if (!patch) { console.error('Refused: no difference from origin/main.'); return 1; }
  const crops = va.pickCrops(dir);
  if (!crops.length) { console.error(`Refused: no screenshots in ${dir}; the owner needs something to look at.`); return 1; }

  const linear = require('./lib/linear-client.js');
  const open = va.openVisualRequests(await linear.listOpenIssuesWithDescriptions());
  const mine = open.find((i) => i.identifier === issueId);
  if (!mine && open.length >= va.MAX_OPEN) { console.error(`Refused: ${open.length} visual approvals are already waiting on the owner (cap ${va.MAX_OPEN}). Leave this change committed and try again later.`); return 1; }

  const hold = va.holdBranch(issueId);
  const evBranch = va.evidenceBranch(issueId);
  const files = crops.map((abs) => ({ abs, name: va.flatName(dir, abs) }));
  files.push({ abs: path.join(dir, 'verdict.json'), name: 'verdict.json' });
  // Screenshot URLs name the evidence COMMIT, not the branch: a branch can be force-pushed after the owner was emailed.
  const ev = va.buildEvidenceCommit(files, cwd, `Visual evidence for ${issueId}`);
  const evidence = files.filter((f) => !f.name.endsWith('.json')).map((f) => ({ label: va.labelFor(f.name), url: va.rawUrl(ev, f.name) }));
  const block = va.buildBlock({ what, patch, verdict: verdict.contentHash, hold, evidence, summary: arg(argv, 'summary') });

  if (dryRun) { console.log(`[dry-run] would push HEAD -> ${hold} and ${files.length} files -> ${evBranch}\n\n${block}`); return 0; }

  va.git(['push', '--force', 'origin', `HEAD:refs/heads/${hold}`], { cwd });
  va.git(['push', '--force', 'origin', `${ev}:refs/heads/${evBranch}`], { cwd });

  const issue = await linear.getIssue(issueId);
  if (!issue) { console.error(`Issue ${issueId} not found`); return 1; }
  // Replace an earlier ask on the same card instead of stacking blocks.
  const old = String(issue.description || '');
  const STRIP_RE = /^\s*(DECISION NEEDED:|Why this is your call:|Option [A-E]\s*[—–:-]|My recommendation:|Default:|Evidence:|VISUAL-APPROVAL:|ANSWERED by the owner)/i;
  const kept = link.parseVisualApproval(old) ? old.split('\n').filter((l) => !STRIP_RE.test(l)) : old.split('\n');
  await linear.updateIssue(issue.id, { description: `${kept.join('\n').trimEnd()}\n\n${block}\n` });
  const team = await linear.getTeam();
  const label = await linear.findOrCreateLabel(team.id, link.AWAITING_OWNER_LABEL);
  await linear.addLabelToIssue(issue.id, label.id);
  await linear.createComment(issue.id, `Asked the owner to look at ${files.length - 1} screenshot(s). Held change: ${hold} (patch ${patch.slice(0, 12)}). It ships by itself after Approve; Reject returns the card with the owner's note.`);
  console.log(`Asked the owner on ${issueId}. Held on ${hold}; screenshots on ${evBranch}. The decision list and the next email will show it. Stop work on this card now: end the session, do not wait or poll for the answer (the lander ships it).`);
  console.log(va.showInlineHint(crops, cwd));
  return 0;
}

/** Where the owner's answer stands, read from the card itself (the Owner decision comment and the lander's markers). Never infer "still waiting" from memory. */
async function status(argv) {
  const issueId = arg(argv, 'issue');
  if (!/^BRO-\d+$/.test(issueId)) { console.error(STATUS_USAGE); return 2; }
  const linear = require('./lib/linear-client.js');
  const issue = await linear.getIssue(issueId);
  if (!issue) { console.error(`${issueId} not found`); return 1; }
  const comments = (await linear.listIssueComments([issueId])).get(issueId) || [];
  const state = va.classifyStatus(issue.description, comments);
  console.log(`${issueId}: ${state}${STATUS_TEXT[state] ? ` (${STATUS_TEXT[state]})` : ''}`);
  return 0;
}
const STATUS_USAGE = 'Usage: node scripts/visual-approval.js status --issue=BRO-N';
const STATUS_TEXT = {
  waiting: 'the owner has not answered yet',
  approved: 'the owner tapped Approve; the lander ships it on its next run',
  landed: 'pushed to a land ref; follow the Land run and prod',
  rejected: 'the owner said no; read their note on the card and rework',
  void: 'approved, but the held branch no longer matches; restore it or ask again',
  unverified: 'approved, but the evidence check did not pass; ask again',
  expired: 'nobody answered in 14 days; redo and ask again',
  none: 'no visual approval request on this card',
};

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  if (argv[0] === 'status') return status(argv.slice(1));
  if (argv[0] === 'request') return request(argv.slice(1));
  console.error(USAGE);
  return 2;
}

if (require.main === module) {
  main().then((c) => { process.exitCode = c; }, (e) => { console.error(`[visual-approval] ${e.stack || e.message}`); process.exitCode = 1; });
}
module.exports = { main };
