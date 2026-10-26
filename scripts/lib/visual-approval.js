/**
 * Visual approval helpers (BRO-6241). A worker that changed the website runs
 * /visual-qa, parks the change on visual-hold/<card>, and asks the owner "does
 * this look right?" as a normal DECISION NEEDED card. The CI lander
 * (scripts/visual-approval-land.js) ships it once the owner taps Approve.
 * Signing lives in src/lib/owner-decision-link.js (visualMac / hasVisualApproval).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const link = require('../../src/lib/owner-decision-link.js');

const REPO = 'thomaspryor/Broadwayscore';
const MAX_OPEN = 8;
const MAX_CROPS = 6;
const QUESTION_LABEL_MAX = 100;

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

/** Rebase-stable id of what `head` changes relative to `base`  (land squashes and rebases, so a commit sha would not survive). --verbatim, not --stable: --stable ignores whitespace inside lines, so a re-pushed hold branch with a changed string literal would still match. */
function patchId(base, head, cwd) {
  const diff = git(['diff', '--binary', `${base}...${head}`], { cwd });
  if (!diff) return null;
  const out = execFileSync('git', ['patch-id', '--verbatim'], { input: diff, encoding: 'utf8', cwd, maxBuffer: 256 * 1024 * 1024 }).trim();
  return out ? out.split(/\s+/)[0] : null;
}

const holdBranch = (id) => `visual-hold/${String(id).toLowerCase()}`;
const evidenceBranch = (id) => `visual-evidence/${String(id).toLowerCase()}`;
const rawUrl = (branch, file) => `https://raw.githubusercontent.com/${REPO}/${branch}/${file}`;

function walkImages(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkImages(full));
    else if (/\.(png|jpe?g)$/i.test(e.name)) out.push(full);
  }
  return out;
}

/** Element crops first (tight to the change), else full-page shots; capped. */
function pickCrops(dir) {
  if (!fs.existsSync(dir)) return [];
  const all = walkImages(dir).sort();
  const crops = all.filter((f) => path.basename(f).includes('__'));
  return (crops.length ? crops : all).slice(0, MAX_CROPS);
}

function flatName(dir, file) {
  return path.relative(dir, file).replace(/[\\/]+/g, '_').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120);
}

function labelFor(name) {
  return name.replace(/\.(png|jpe?g)$/i, '').replace(/__/g, ' ').replace(/[_-]+/g, ' ').replace(/\|/g, ' ').trim().slice(0, 80) || 'Screenshot';
}

function buildBlock({ what, patch, verdict, hold, evidence, summary }) {
  const clean = String(what || 'the website').replace(/[\r\n|()]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, QUESTION_LABEL_MAX);
  const tag = link.visualBinding(patch, verdict);
  return [
    `DECISION NEEDED: Does the change to ${clean} look right? (ref ${tag})`,
    'Why this is your call: It changes how the website looks, and only you can judge that. The automatic checks already ran.',
    'Option A — Approve: the change goes live by itself within about 20 minutes / nothing else for you to do',
    'Option B — Reject: the change is not shipped and goes back to be reworked / tell me what is wrong in your own words',
    `My recommendation: Approve, because ${String(summary || 'the automatic visual checks passed').replace(/[\r\n]+/g, ' ').slice(0, 160)}.`,
    'Default: Nothing ships; the change waits.',
    ...evidence.map((e) => `Evidence: ${e.label} | ${e.url}`),
    `VISUAL-APPROVAL: patch=${patch} verdict=${verdict} hold=${hold}`,
  ].join('\n');
}

/** Orphan commit holding the screenshots, built with plumbing so the working tree and index are untouched. */
function buildEvidenceCommit(files, cwd, message) {
  const entries = files.map(({ name, abs }) => `100644 blob ${git(['hash-object', '-w', abs], { cwd })}\t${name}`).join('\n');
  const tree = execFileSync('git', ['mktree'], { input: `${entries}\n`, encoding: 'utf8', cwd }).trim();
  return git(['-c', 'user.name=visual-approval', '-c', 'user.email=visual-approval@users.noreply.github.com', 'commit-tree', tree, '-m', message], { cwd });
}

function openVisualRequests(issues) {
  return issues.filter((i) => link.parseVisualApproval(i.description) && /DECISION NEEDED/i.test(i.description || '') && !/ANSWERED by the owner/.test(i.description || ''));
}

module.exports = { REPO, MAX_OPEN, git, patchId, holdBranch, evidenceBranch, rawUrl, pickCrops, flatName, labelFor, buildBlock, buildEvidenceCommit, openVisualRequests };
