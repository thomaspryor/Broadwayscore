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
// The email shows 1 picture and at most 2 more links, so a card never needs more than 3 shots.
const MAX_CROPS = 3;
// Email thumbnails: Gmail's image proxy drops huge or oddly-typed images (BRO-7486: a 360 x 152,120 px, 13.7 MB PNG).
const THUMB_MAX_BYTES = 300 * 1024;
const THUMB_MAX_WIDTH = 600;
const THUMB_MAX_HEIGHT = 1200;
const THUMB_PREFIX = 'thumb_';
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

/**
 * Files in `range` that can change how the site looks: the push gate's UI path
 * pattern (kept in sync with the hook by headless-dispatchability's test), minus
 * code files whose diff is copy-only. Data, scraper, lib and script changes are
 * never visual, even when the page they feed looks different afterwards: the
 * existing components render the new data, so there is nothing for the owner to judge.
 * Fails closed: a diff error keeps the file.
 */
function scopedChangedFiles(cwd, re) {
  try {
    const gate = path.join(__dirname, 'review-gate.mjs');
    if (!fs.existsSync(gate)) return null;
    const out = JSON.parse(execFileSync('node', [gate, '--query=changed-files', `--repo=${cwd}`, '--ref=HEAD', `--pattern=${re.source}`], { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'ignore'] }));
    return Array.isArray(out.files) && !out.error ? out.files : null;
  } catch { return null; }
}

function visualSurfaceFiles(range, cwd) {
  const { UI_PATH_RE } = require('./headless-dispatchability.js'); // lazy: that module requires this one
  const { filterFiles } = require('./visual-text-only-diff.js');
  let files;
  try {
    // Same own-merge-scoped query the push gate uses, so on a shared local main another session's
    // already-merged .tsx commit does not count as this change's. Falls back to the plain diff.
    files = range === 'origin/main...HEAD' ? scopedChangedFiles(cwd, UI_PATH_RE) : null;
    if (!files) files = git(['diff', '--name-only', range], { cwd }).split('\n').filter((f) => UI_PATH_RE.test(f));
  } catch {
    return ['(could not diff against main)']; // fail closed: when unsure, the owner may be asked
  }
  return filterFiles(range, files, (r, f) => git(['diff', r, '--', f], { cwd }));
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

/** Element crops first (tight to the change), else full-page shots; capped. Phone-width shots lead (the owner reads on a phone). */
function pickCrops(dir) {
  if (!fs.existsSync(dir)) return [];
  const all = walkImages(dir).sort();
  const crops = all.filter((f) => path.basename(f).includes('__'));
  const list = crops.length ? crops : all;
  const phone = (f) => (/(^|[^0-9])(414|390|375|360)([^0-9]|$)/.test(path.basename(f)) ? 0 : 1);
  return [...list].sort((a, b) => phone(a) - phone(b)).slice(0, MAX_CROPS);
}

/**
 * The owner must be shown the UI that changed. Element crops (names contain "__") are taken of the
 * selectors the worker passed to visual-qa --elements; a request that only has whole-page shots shows
 * the owner a page where the change may not even be on screen (BRO-7486: the evidence was
 * /browse pages while the change lived in a panel that opens after a tap). Returns a reason string or null.
 */
function cropCoverageProblem(crops) {
  const list = Array.isArray(crops) ? crops : [];
  if (list.some((f) => path.basename(f).includes('__'))) return null;
  return 'no element crop of the changed UI. All screenshots are whole pages, which may not show what changed (a panel that opens after a tap, a sheet, a modal). Re-run node scripts/visual-qa.mjs with --elements "<selector of the changed component>" (open the panel first if it needs a tap), or pass --page-shots-ok="<why whole pages show the change>" if the change really is page-wide.';
}

const JARGON_RE = /\b(code[- ]?split\w*|lazy[- ]?load\w*|dynamic import\w*|hydrat\w*|bundle\w*|refactor\w*|tree[- ]?shak\w*|memoiz\w*|ssr|ssg|rsc|prop[- ]drill\w*|css[- ]in[- ]js|z-index|regex|typescript|tsx|jsx|webpack|next\.?js|a11y)\b/i;

/** --what becomes the owner's question ("Does the change to <what> look right?"): plain words describing what they will SEE, no jargon, one phrase. */
function whatProblem(what) {
  const w = String(what || '').trim();
  const words = w.split(/\s+/).filter(Boolean);
  if (words.length < 3) return 'too short. Say in a plain phrase what the owner will see, e.g. "the star rating panel on a show page".';
  if (/[;:]/.test(w)) return 'contains a semicolon or colon. Use one plain phrase for what the owner will see, not a list of reasons.';
  if (/\([^)]*\)|[\\`<>{}]|\bref\b/i.test(w)) return 'contains brackets, code characters or a ref. Plain words only.';
  const j = JARGON_RE.exec(w);
  if (j) return `uses a developer term ("${j[0]}"). Describe what the owner will see instead, e.g. "the rating panel that opens when you tap a show".`;
  if (/\bno visual change\b/i.test(w)) return 'says there is no visual change. If nothing looks different, say so in the summary and do not ask; otherwise describe what looks different.';
  return null;
}

/** Small JPEG for the email: top of the shot only (full-page shots can be 150,000 px tall), downscaled, under THUMB_MAX_BYTES. */
async function makeEmailThumb(srcAbs, outAbs) {
  const sharp = require('sharp');
  const meta = await sharp(srcAbs, { limitInputPixels: false }).metadata();
  const h = Math.min(meta.height, THUMB_MAX_HEIGHT);
  let width = Math.min(meta.width, THUMB_MAX_WIDTH);
  let buf;
  const startWidth = width;
  for (const q of [80, 70, 60, 50, 40]) {
    width = startWidth;
    for (; ; width = Math.round(width * 0.8)) {
      buf = await sharp(srcAbs, { limitInputPixels: false })
        .extract({ left: 0, top: 0, width: meta.width, height: h })
        .resize({ width, withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: q, mozjpeg: true })
        .toBuffer();
      if (buf.length <= THUMB_MAX_BYTES || width <= 200) break;
    }
    if (buf.length <= THUMB_MAX_BYTES) break;
  }
  fs.writeFileSync(outAbs, buf);
  return { bytes: buf.length, cropped: h < meta.height };
}

// thumb_<full file name>.jpg, so the full-size name is recoverable from the thumbnail URL without guessing the extension.
const thumbName = (fullName) => `${THUMB_PREFIX}${fullName}.jpg`;
/** The full-size screenshot a thumbnail URL stands for (the evidence commit holds both). Null when the URL is not a thumbnail. */
function fullUrlForThumb(url) {
  const m = /^(.*\/)thumb_(.+\.(?:png|jpe?g))\.jpg$/i.exec(String(url || ''));
  return m ? `${m[1]}${m[2]}` : null;
}

/** What the session must do next, printed after a request: the owner reads the chat, not the card, so the crops go inline (SendUserFile, display render) in the same reply. */
function showInlineHint(crops, cwd = process.cwd()) {
  const files = crops.map((f) => path.resolve(cwd, f));
  return `SHOW THEM NOW, in your next reply: SendUserFile files=${JSON.stringify(files)} display="render" status="normal" (one call). Saying "screenshots" without showing them is the failure. If the owner is in this chat, their plain "yes" / "Approved" is the approval: push land/<name> yourself instead of waiting for a tap.`;
}

function flatName(dir, file) {
  return (() => {
    const n = path.relative(dir, file).replace(/[\\/]+/g, '_').replace(/[^A-Za-z0-9._-]/g, '-');
    const ext = (/\.(png|jpe?g)$/i.exec(n) || [''])[0];
    // Keep the extension when cutting: the thumbnail URL has to map back to the full-size file.
    return n.length > 110 ? n.slice(0, 110 - ext.length) + ext : n;
  })();
}

function labelFor(name) {
  return name.replace(/^thumb_/, '').replace(/\.(png|jpe?g)(\.jpg)?$/i, '').replace(/__/g, ' ').replace(/[_-]+/g, ' ').replace(/\|/g, ' ').trim().slice(0, 80) || 'Screenshot';
}

/** The email needs one picture, not five: prefer a phone-width shot (the owner reads on a phone), else the first. */
function pickEmailImage(evidence) {
  const list = Array.isArray(evidence) ? evidence : [];
  return list.find((e) => /\b(414|390|375|360)\b/.test(String(e.label))) || list[0] || null;
}

function buildBlock({ what, patch, verdict, hold, evidence, summary }) {
  const clean = String(what || 'the website').replace(/[\r\n|()]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, QUESTION_LABEL_MAX);
  const tag = link.visualBinding(patch, verdict);
  const checked = String(summary || 'the automatic visual check passed at phone, tablet and desktop widths').replace(/[\r\n]+/g, ' ').slice(0, 160);
  return [
    `DECISION NEEDED: Does the change to ${clean} look right? (ref ${tag})`,
    'Why this is your call: It changes how the website looks, and only you can judge that. The automatic checks already ran.',
    'Option A — Approve: the change goes live by itself in about 20 minutes / if something looks off, it stays live until it is fixed',
    'Option B — Reject: nothing changes on the site / the fix waits until the work is redone',
    `My recommendation: Approve, because ${checked}.`,
    'Default: Nothing ships; the change waits.',
    ...evidence.slice(0, MAX_CROPS).map((e) => `Evidence: ${e.label} | ${e.url}`),
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

module.exports = { visualSurfaceFiles, pickEmailImage, MARK, STALE_APPROVAL_MS, evidenceSha, checkVerdict, classifyStatus, REPO, MAX_OPEN, git, patchId, holdSettled, holdBranch, evidenceBranch, rawUrl, pickCrops, cropCoverageProblem, whatProblem, makeEmailThumb, thumbName, fullUrlForThumb, THUMB_MAX_BYTES, THUMB_MAX_HEIGHT, MAX_CROPS, showInlineHint, flatName, labelFor, buildBlock, buildEvidenceCommit, openVisualRequests };
