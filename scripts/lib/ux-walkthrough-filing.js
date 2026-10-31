'use strict';

/**
 * ux-walkthrough-filing.js — what the nightly UX walkthrough files on the
 * board, as a pure decision (BRO-3017 tail).
 *
 * WHY THIS IS ITS OWN FILE. scripts/ux-walkthrough.mjs shelled out to
 * `notion-brain.js create` for every agreed finding, and to `notion-brain.js
 * search` to dedup against issues already on the board. Notion went read-only
 * on 2026-08-30 and both commands have exited non-zero on every run since. The
 * failure was invisible from the outside because BOTH halves failed soft:
 *
 *   - the create path logged one line per finding and returned an empty
 *     `filed` list, which reads exactly like a clean night with nothing to
 *     report;
 *   - the dedup path caught its own failure and returned `[]`, i.e. "nothing
 *     on the board yet", i.e. dedup silently OFF.
 *
 * That second one is the trap. Repointing only the create path at Linear would
 * have turned a silent no-op into a nightly duplicate generator, filing every
 * historical finding again each night against a board already carrying 1,074
 * open issues at 3.3 filed per 1 closed. So the rule encoded here is: a dedup
 * read that FAILED is not an empty board. When the read fails, file nothing.
 *
 * A night of missed findings is recoverable — they are written to the run
 * directory either way. A night of duplicates is manual cleanup on the exact
 * backlog the owner asked to stop growing.
 *
 * Pure in, pure out — no fs, no network, no child processes. The .mjs keeps
 * the I/O (reading Linear, shelling out to the linear-brain chokepoint); this
 * decides, so CI can regression-test it. CommonJS because scripts/lib/*.js is,
 * and the .mjs reaches it through createRequire.
 */

// Linear priorities are numeric: 0 none, 1 urgent, 2 high, 3 normal, 4 low.
// Notion's vocabulary ("P1 Next" / "P2 Later") does not exist here, and
// passing those strings through is a silent no-op on the wrong field.
const { foldDiacritics } = require('./title-match.js');

const PRIORITY_NORMAL = 3;

// Two independent models agreeing is the bar for a model opinion. Findings
// from the deterministic detectors (dead control, structural probe, iOS quirk)
// are measurements, not opinions, and carry no agreement requirement.
const MIN_AGREEMENT = 2;

// Jaccard-ish overlap over words longer than 3 characters. Kept at the value
// the walkthrough has always used; it is a dedup heuristic, not a threshold
// anyone tuned.
const DUPE_SIMILARITY = 0.6;

// Per-run volume cap (BRO-6478). A filed card now costs a worker session, and about 17 of 18 findings were noise
// (BRO-340), so a bad night files a few. The rest are reported as skippedOverCap; a real defect shows up in the next night's run and files then.
const MAX_FILINGS_PER_RUN = 3;

// Each filing gets a unique key from the caller, so an earlier finding's resolution cannot close a recurrence.
const VERIFY_LINE = 'VERIFY: node scripts/lib/ux-walkthrough-resolution.js --key=';

/**
 * PURE. The card body. Worker instructions avoid the phrases headless-dispatchability.js reads as "needs the
 * owner" (the owner must decide / approval first), so the card stays pickable; the owner is asked later with a picture.
 */
function cardNotes(finding, respondingCount, resolutionKey) {
  if (!/^[a-f0-9]{32}$/.test(resolutionKey || '')) throw new Error('A unique 32-hex UX resolution key is required');
  const f = finding || {};
  const evidence = f.deterministic
    ? `Flagged by the automated ${(f.models && f.models[0]) || 'structural'} detector in the nightly signed-in UX walkthrough's interactive pass (deterministic, not a model opinion).`
    : `Flagged by ${f.agreementCount} of ${respondingCount} responding review models (${(f.models || []).join(', ')}) in the nightly signed-in UX walkthrough. About 17 in 18 such model findings were noise once (BRO-340), so check before building.`;
  return [
    '## Problem',
    f.summary || '',
    '',
    `Severity: ${f.severity || 'unrated'} (rated by the walkthrough; every UX card files at the same priority, BRO-340).`,
    '',
    '## Evidence',
    `${evidence} Seen at: ${f.screenshot || 'no screenshot label'} (a viewport and state label; the screenshots are in the walkthrough run's artifacts).`,
    '',
    '## What to do',
    '1. Reproduce the finding on demo.broadwayscorecard.com (signed in, grid and list, mobile and desktop). Do not trust the finding text alone.',
    '2. If it does not reproduce or is not a real problem, post a comment with a line starting UX-RESOLUTION: noise: followed by the reason (at least 20 characters: what you looked at and what you saw), then close this card. That is the expected outcome for most of these.',
    '3. If it is real, build the fix with the shared components and tokens (memory/design-system.md), run /visual-qa, commit, then ask the owner to look at the picture: `node scripts/visual-approval.js request --issue=<this card> --what="<plain words>"`. That emails before/after screenshots with an Approve button. Do not write a question for the owner in Linear.',
    '',
    '## Acceptance criteria',
    'The finding is closed as noise with a reason, or the fix is landed with the owner\'s Approve recorded, and the next nightly walkthrough does not repeat it.',
    `UX-FINDING: ${resolutionKey}`,
    `${VERIFY_LINE}${resolutionKey}`,
  ].join('\n');
}

// foldDiacritics BEFORE the ASCII class, never after. Stripping [^a-z0-9\s]
// from an unfolded string destroys accented letters outright — "Café" becomes
// "caf", "Lópezes" becomes "l pezes" — so two descriptions of the same defect
// fold to different word sets and dedup silently misses, refiling the finding
// every night. That is task #648's whole bug class, and the structural guard
// in tests/unit/sibling-matchers-diacritics.test.mjs exists to stop a NEW
// matcher reintroducing it. CI caught this file doing exactly that.
function normalizeWords(s) {
  return foldDiacritics(String(s == null ? '' : s))
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
}

function similarity(a, b) {
  const wa = new Set(normalizeWords(a));
  const wb = new Set(normalizeWords(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return overlap / Math.min(wa.size, wb.size);
}

function titleFor(finding) {
  return `UX audit: ${finding && finding.summary ? finding.summary : ''}`.slice(0, 120);
}

// Every walkthrough card is a "UX audit:" card filed as worker work (BRO-6478): the worker first checks the
// finding on the demo site and closes noise with the reason; a real one gets a fix and the owner's taste call
// arrives as a before/after picture (visual-approval.js), never as a Linear card. Filing high-severity ones at
// 2 made them P1: 18 piled up, 1 real (BRO-340). Priority 3 is the cloud worker's P2 fallback tier
// (cloud-worker-pick.js), which takes a dispatch-mode card after it has sat idle.
function priorityFor(_finding) {
  return PRIORITY_NORMAL;
}

/**
 * Decide what to file.
 *
 * @param {object}   args
 * @param {Array}    args.findings   merged model + deterministic findings
 * @param {object}   args.existing   {titles: string[], ok: boolean} from the
 *                                   board read. `ok:false` means the read
 *                                   FAILED — not that the board is empty.
 * @returns {{refused:boolean, reason:string|null, toFile:Array, skippedDuplicate:Array, skippedLowAgreement:Array}}
 */
function planFilings({ findings = [], existing = null } = {}) {
  if (!existing || existing.ok !== true) {
    return {
      refused: true,
      reason:
        'could not read the existing issues on the board, so every finding would be filed as new — refusing to file rather than duplicating the backlog',
      toFile: [],
      skippedDuplicate: [],
      skippedLowAgreement: [],
      skippedOverCap: [],
    };
  }

  const existingTitles = Array.isArray(existing.titles) ? existing.titles.filter(Boolean) : [];
  const toFile = [];
  const skippedDuplicate = [];
  const skippedLowAgreement = [];
  const skippedOverCap = [];

  for (const f of findings || []) {
    if (!f) continue;
    if (!f.deterministic && !(f.agreementCount >= MIN_AGREEMENT)) {
      skippedLowAgreement.push(titleFor(f));
      continue;
    }
    const title = titleFor(f);
    // Compare against titles ALREADY QUEUED this run as well as the board's.
    // Two detectors describing the same defect in near-identical words would
    // otherwise both be filed — the board read cannot know about a title
    // minted seconds ago.
    const priorTitles = existingTitles.concat(toFile.map((t) => t.title));
    if (priorTitles.some((t) => similarity(t, title) >= DUPE_SIMILARITY)) {
      skippedDuplicate.push(title);
      continue;
    }
    if (toFile.length >= MAX_FILINGS_PER_RUN) {
      skippedOverCap.push(title);
      continue;
    }
    toFile.push({ title, priority: priorityFor(f), finding: f });
  }

  return { refused: false, reason: null, toFile, skippedDuplicate, skippedLowAgreement, skippedOverCap };
}

module.exports = {
  PRIORITY_NORMAL,
  MIN_AGREEMENT,
  DUPE_SIMILARITY,
  MAX_FILINGS_PER_RUN,
  VERIFY_LINE,
  cardNotes,
  normalizeWords,
  similarity,
  titleFor,
  priorityFor,
  planFilings,
};
