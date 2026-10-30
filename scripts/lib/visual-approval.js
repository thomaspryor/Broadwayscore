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

/** A hold is settled when its fetch failed or its diff against main is empty. */
function holdSettled({ fetchOk, patchIdValue }) {
  return !fetchOk || patchIdValue === null;
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

/** What the session must do next, printed after a request: the owner reads the chat, not the card, so the crops go inline (SendUserFile, display render) in the same reply. */
function showInlineHint(crops, cwd = process.cwd()) {
  const files = crops.map((f) => path.resolve(cwd, f));
  return `SHOW THEM NOW, in your next reply: SendUserFile files=${JSON.stringify(files)} display="render" status="normal" (one call). Saying "screenshots" without showing them is the failure. If the owner is in this chat, their plain "yes" / "Approved" is the approval: push land/<name> yourself instead of waiting for a tap.`;
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

// Comment markers the lander writes. The MAC-bearing suffix is added by the lander (it holds the secret);
// the status command below matches the prefixes only, so a worker without the secret can still read the state.
const MARK = {
  landed: 'Visual approval landed VQL',
  expired: 'Visual approval expired VQX',
  cleaned: 'Visual approval cleaned VQC',
  void: 'Visual approval void VQV',
  stale: 'Visual approval stale VQS',
  unverified: 'Visual approval unverified VQU',
  approved: 'Visual approval ref VQA',
};
const STALE_APPROVAL_MS = 45 * 60 * 1000;

/** The evidence commit sha the card's screenshot URLs name (the branch can be force-pushed after the owner was emailed). */
function evidenceSha(description) {
  // Only Evidence lines count (a URL elsewhere in the body is free text), and the last one wins (an older ask's lines stay above a newer block).
  const re = /raw\.githubusercontent\.com\/thomaspryor\/Broadwayscore\/([0-9a-f]{40})\//i;
  const shas = String(description || '').split('\n').filter((l) => /^\s*(?:[-*>]\s+)?\**Evidence\**\s*:/i.test(l)).map((l) => re.exec(l)).filter(Boolean);
  return shas.length ? shas[shas.length - 1][1].toLowerCase() : null;
}

/** The owner approved exactly this check only when it passed and is the very file the approval was bound to. */
function checkVerdict(raw, expectedHash) {
  let v;
  try { v = JSON.parse(raw); } catch { return { ok: false, why: 'verdict.json is missing or not valid JSON' }; }
  if (!v || v.overallPass !== true) return { ok: false, why: 'the visual check in verdict.json did not pass' };
  if (!v.contentHash || String(v.contentHash) !== String(expectedHash)) return { ok: false, why: 'verdict.json is not the check the owner approved (contentHash differs)' };
  return { ok: true };
}

/**
 * Where a visual request stands, from the card alone (no secret needed).
 * waiting | approved (tapped, lander has not pushed yet) | landed | rejected | void | unverified | expired | none
 */
function classifyStatus(description, comments) {
  if (!link.parseVisualApproval(description)) return 'none';
  // A card can be asked again after an expiry or a redo: only comments from the latest ask describe the current request.
  const all = comments || [];
  const askedAt = all.filter((c) => /^Asked the owner to look at/.test(link.unescapeMarkdown(c.body || '').trim())).map((c) => new Date(c.createdAt).getTime()).filter(Number.isFinite).sort((a, b) => b - a)[0];
  const current = askedAt ? all.filter((c) => !(new Date(c.createdAt).getTime() < askedAt)) : all;
  const texts = current.map((c) => link.unescapeMarkdown(c.body || ''));
  const has = (prefix) => texts.some((t) => t.includes(prefix));
  if (has(MARK.landed)) return 'landed';
  if (has(MARK.expired)) return 'expired';
  if (has(MARK.approved)) {
    if (has(MARK.unverified)) return 'unverified';
    if (has(MARK.void)) return 'void';
    return 'approved';
  }
  // A void closes the ask even when no Approve was ever tapped (the owner said yes in chat and the session shipped it).
  if (has(MARK.void)) return 'void';
  if (/ANSWERED by the owner/.test(description || '')) return 'rejected';
  return 'waiting';
}

function openVisualRequests(issues) {
  return issues.filter((i) => link.parseVisualApproval(i.description) && /DECISION NEEDED/i.test(i.description || '') && !/ANSWERED by the owner/.test(i.description || ''));
}

module.exports = { MARK, STALE_APPROVAL_MS, evidenceSha, checkVerdict, classifyStatus, REPO, MAX_OPEN, git, patchId, holdSettled, holdBranch, evidenceBranch, rawUrl, pickCrops, showInlineHint, flatName, labelFor, buildBlock, buildEvidenceCommit, openVisualRequests };
