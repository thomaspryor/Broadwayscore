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
const PRIORITY_HIGH = 2;
const PRIORITY_NORMAL = 3;

// Two independent models agreeing is the bar for a model opinion. Findings
// from the deterministic detectors (dead control, structural probe, iOS quirk)
// are measurements, not opinions, and carry no agreement requirement.
const MIN_AGREEMENT = 2;

// Jaccard-ish overlap over words longer than 3 characters. Kept at the value
// the walkthrough has always used; it is a dedup heuristic, not a threshold
// anyone tuned.
const DUPE_SIMILARITY = 0.6;

function normalizeWords(s) {
  return String(s == null ? '' : s)
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

function priorityFor(finding) {
  return finding && finding.severity === 'high' ? PRIORITY_HIGH : PRIORITY_NORMAL;
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
    };
  }

  const existingTitles = Array.isArray(existing.titles) ? existing.titles.filter(Boolean) : [];
  const toFile = [];
  const skippedDuplicate = [];
  const skippedLowAgreement = [];

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
    toFile.push({ title, priority: priorityFor(f), finding: f });
  }

  return { refused: false, reason: null, toFile, skippedDuplicate, skippedLowAgreement };
}

module.exports = {
  PRIORITY_HIGH,
  PRIORITY_NORMAL,
  MIN_AGREEMENT,
  DUPE_SIMILARITY,
  normalizeWords,
  similarity,
  titleFor,
  priorityFor,
  planFilings,
};
