/**
 * headless-dispatchability.js — "can an UNATTENDED session actually FINISH
 * this card?", asked at SELECTION time.
 *
 * WHY THIS EXISTS (task #1004, 2026-08-04)
 *   The backlog drain went 0-for-4 on 2026-08-04 and the first postmortem
 *   blamed a red trunk. Reading ~/Library/Logs/bsc-jobs/ disproved that:
 *   neither failing session ever hit a push rejection. Both COMPLETED their
 *   work and then stopped at a gate that structurally requires a human.
 *
 *     30-msdaql3v ($9.34) — root-caused the bug, fixed it, 5/5 tests, tsc +
 *       lint clean, visual QA done, live-verified in Playwright, review gate
 *       PASS. Ended: "waiting on your visual-qa approval to push commits
 *       c2627bc0db0 + 04fcc4fa70b". The pre-push visual gate
 *       (.claude/hooks/pre-push-visual-gate.sh) blocks every push of a UI
 *       diff until the OWNER types a plain affirmative. An unattended run can
 *       never satisfy that — no owner is reading. #30 was a rage-click card,
 *       i.e. UI by construction; it should never have been picked.
 *     57-msdjb8do ($5.40) — work complete, ended "waiting on the Reddit
 *       re-scrape workflow (run 30839879048) to finish before final
 *       verification and merge". Nothing resumes a finished headless session.
 *
 *   Both were scored card-fail. $14.74 was charged as "zero completions" when
 *   two sessions had produced finished, verified work that merely could not
 *   land. bsc-next.js already refuses cards with no runnable verify command;
 *   this is the same refusal one class over — refuse the cards whose
 *   COMPLETION, not whose verification, needs a human.
 *
 * POLICY (the answer to "resume mechanism or don't start?"): don't start.
 *   A resume mechanism would have to re-enter a dead session's context hours
 *   later and re-derive why it stopped. Refusing at selection costs nothing,
 *   is checkable, and leaves the card for an attended cmux dispatch where the
 *   owner is present to clear the gate.
 *
 * USED BY
 *   - scripts/bsc-next.js       (the --headless dispatch gate)
 *   - scripts/backlog-drain.js  (candidate scan, before it spends anything)
 *
 * CLI
 *   node scripts/lib/headless-dispatchability.js --subject=... --notes=...
 *   Exits 0 when dispatchable, 1 when a human gate blocks it.
 */

'use strict';

const { evaluateVerifiability } = require('./verify-gate.js');
const { OWNER_JUDGMENT_RE } = require('./owner-judgment-marker.js');

const BLOCKERS = Object.freeze({
  PARKED_SENTINEL: 'PARKED_SENTINEL',
  VISUAL_QA_GATE: 'VISUAL_QA_GATE',
  ASYNC_WAIT_GATE: 'ASYNC_WAIT_GATE',
  OWNER_DECISION_GATE: 'OWNER_DECISION_GATE',
  NO_VERIFY_CMD: 'NO_VERIFY_CMD',
});

// The repo's own do-not-dispatch sentinel. `scripts/lib/linear-issue-create.js:141` writes
// it verbatim on every `--park`:
//     `PARKED: ${disposition.reason}\n\n${description || ''}`
// so this is an exact match on a generated marker, not a heuristic on prose.
//
// MULTILINE (/m) is load-bearing, not tidiness. Notion-mirrored issues carry two
// generated header lines — `[notion:<uuid>] …` and a bare URL — BEFORE the
// sentinel, so a string-anchored /^\s*PARKED\s*:/i misses them. Measured against
// all 432 live open P0/P1 issues on 2026-09-03:
//
//     contains PARKED anywhere :  211 total / 163 dispatchable
//     /^\s*PARKED\s*:/i        :  160 total / 127 dispatchable
//     /^\s*PARKED\s*:/im       :  200 total / 158 dispatchable   <- this
//     gained by /m             :   40 total /  31 dispatchable
//
// The 11 that even /m misses are correctly missed: they are prose mentions
// ("Auto-parked by bsc-reconcile", "linear-drain-parked.js", a `## Parked
// 2026-08-08` heading). Dropping the anchor entirely would catch those too and
// refuse cards nobody parked, so line-start is the right stopping point.
//
// Note `\s*` spans newlines, so a card that QUOTES `PARKED:` at a line start
// blocks itself — the same self-exclusion hazard owner-judgment-marker.js:38-44
// documents. For a default-deny gate that is the safe direction to fail.
const PARKED_SENTINEL_RE = /^\s*PARKED\s*:/im;

// Byte-identical to UI_PATTERN in .claude/hooks/pre-push-visual-gate.sh (the
// hook that actually blocks the push), modulo the shell-vs-JS escaping of the
// literal '/'. The test asserts the two stay in sync by parsing the hook —
// if the gate widens to a new extension and this doesn't, headless sessions
// silently start picking cards they can't land again.
const UI_PATH_RE = /^(src\/.*\.(tsx|jsx|css|scss|module\.css)$|tailwind\.config\.|postcss\.config\.|src\/app\/.*\.(tsx|jsx|ts|js)$)/;

// Path-ish tokens in free card text: `src/components/Foo.tsx`,
// "scripts/lib/bar.js", src/**/*.{tsx,css}, tailwind.config.ts.
// '*' is allowed inside a directory segment so the `src/**/*.tsx` form a card
// author actually writes is captured, not just concrete paths.
const PATH_TOKEN_RE = /(?:[\w.@*-]+\/)+[\w.*{},[\]-]+|(?:tailwind|postcss)\.config\.\w+/g;

// Card classes whose remit is UI by construction, so they trip the visual
// gate even when the card names no file. Both are machine-generated card
// families (PostHog rage-click cards, the mobile/desktop UX audit sweep), so
// matching the phrase is precise, not a keyword guess.
//
// Matched anywhere in the SUBJECT, not anchored to its start (ship-check
// finding, Codex 2026-08-04): an anchored version let pending #63 "Homepage
// rage clicks persist beyond known labeled issues" through — same card
// family, phrase just isn't first. Subject-scoped, never notes: a backend
// card that merely cites a rage-click card as context must stay dispatchable.
const UI_CARD_CLASS_RE = /(?:rage[- ]clicks?\b|\bux audit\s*:|\bvisual qa\b)/i;

// An explicit instruction to run the visual-QA ritual is the same gate.
const VISUAL_QA_MENTION_RE = /(?:^|[^\w-])(?:\/visual-qa\b|visual[- ]qa\b|VISUAL-OK\b)/i;

// Completion deliberately deferred past this session: a cron that hasn't run,
// a date that hasn't arrived, N clean runs that haven't accumulated. These are
// PAUSED-with-RECHECK-AFTER cards by CLAUDE.md's own rule — an unattended
// session can only sit on them until it dies.
const ASYNC_WAIT_RES = [
  /RECHECK[- ]AFTER\s*:/i,
  // /m so it fires on a deferral line anywhere in the notes, not only when it
  // opens the subject (ship-check finding: without /m, `^` anchored to the
  // very start of the joined subject+notes string).
  /^\s*after\s+\d{4}-\d{2}-\d{2}\b/im,
  /\bwait(?:s|ing)?\s+for\s+(?:the\s+)?(?:next\s+)?(?:cron|nightly|scheduled\s+run|workflow\s+run)\b/i,
  /\b(?:verify|confirm|prove|recheck)[^.\n]{0,80}\b(?:after|once)\b[^.\n]{0,80}\b(?:the\s+)?(?:next\s+)?(?:cron|nightly\s+run|next\s+run|tomorrow|overnight|next\s+opening\s+night)\b/i,
  /\b\d+\s+(?:consecutive\s+)?clean\s+(?:runs?|weeks?|days?|nights?)\b/i,
];

// The card itself says a human has to decide. VERIFY: owner-judgment is
// handled separately (it satisfies the verify gate but still needs an owner
// to judge the outcome, so it is a headless blocker here even though
// bsc-next's verify gate accepts it).
const OWNER_DECISION_RES = [
  /\bDECISION NEEDED\b/i,
  // Same regex object autonomous-eligibility.js and verify-gate.js use — it
  // was a third handwritten copy until task #1154 pulled it into a leaf module.
  OWNER_JUDGMENT_RE,
  /\bowner\s+(?:must|needs?\s+to|has\s+to|should)\s+(?:decide|choose|approve|pick|sign off)\b/i,
  /\b(?:needs?|requires?|awaiting)\s+(?:an?\s+)?owner\s+(?:decision|judgment|judgement|approval|call)\b/i,
];

// Expand a brace group once: src/**/*.{tsx,css} -> [src/**/*.tsx, src/**/*.css]
function expandBraces(token) {
  const m = /^(.*)\{([^{}]*)\}(.*)$/.exec(token);
  if (!m) return [token];
  return m[2].split(',').map(part => `${m[1]}${part.trim()}${m[3]}`);
}

// A glob can't be tested against a concrete-path regex, so substitute a
// placeholder segment for the wildcards: src/**/*.tsx -> src/x/x.tsx.
function concretize(token) {
  return token.replace(/\*\*\/?/g, 'x/').replace(/\*/g, 'x').replace(/\/{2,}/g, '/');
}

function looksLikeUiPath(rawToken) {
  const cleaned = String(rawToken || '').replace(/^[`'"(\[]+/, '').replace(/[`'"),.;:\]]+$/, '');
  if (!cleaned) return false;
  for (const variant of expandBraces(cleaned)) {
    if (UI_PATH_RE.test(concretize(variant))) return true;
  }
  return false;
}

function extractPathTokens(text) {
  return String(text || '').match(PATH_TOKEN_RE) || [];
}

function uiPathsIn(text) {
  const hits = [];
  for (const token of extractPathTokens(text)) {
    const cleaned = token.replace(/^[`'"(\[]+/, '').replace(/[`'"),.;:\]]+$/, '');
    if (looksLikeUiPath(cleaned) && !hits.includes(cleaned)) hits.push(cleaned);
  }
  return hits;
}

function firstMatch(res, text) {
  for (const re of res) {
    const m = re.exec(text);
    if (m) return m[0].trim().slice(0, 120);
  }
  return null;
}

/**
 * @param {object} card
 * @param {string} card.subject   card title (task-mirror subject / Notion name)
 * @param {string} [card.notes]   full card body; falls back to card.description
 * @param {object} [opts]
 * @param {string|null} [opts.verifyCmd]  verify command already extracted by the
 *   caller (bsc-next extracts it once at its dispatch gate). Omit to derive it
 *   from notes via the canonical verify-gate.
 * @param {boolean} [opts.requireVerifyCmd=true]  set false when the caller has
 *   its own reason to dispatch unarmed (--allow-unverifiable, truncated mirror).
 * @returns {{dispatchable: boolean, blockers: Array<{code: string, detail: string}>, reason: string|null}}
 */
function classifyHeadlessDispatchability(card = {}, opts = {}) {
  const subject = String(card.subject || '');
  const notes = String(card.notes != null ? card.notes : (card.description || ''));
  const text = `${subject}\n${notes}`;
  const blockers = [];

  // Checked against `notes`, NOT `text`. `text` is `subject + "\n" + notes`, and
  // the sentinel is only ever written into the DESCRIPTION — matching against
  // `text` would still work under /m but would also let a subject line that
  // merely starts "PARKED:" refuse a card nobody parked.
  if (PARKED_SENTINEL_RE.test(notes)) {
    blockers.push({
      code: BLOCKERS.PARKED_SENTINEL,
      detail: 'description carries the repo\'s PARKED: do-not-dispatch sentinel — an owner parked this deliberately; override with --force (the documented unpark) or --allow-human-gated',
    });
  }

  const uiPaths = uiPathsIn(text);
  if (uiPaths.length) {
    blockers.push({
      code: BLOCKERS.VISUAL_QA_GATE,
      detail: `touches UI path(s) ${uiPaths.slice(0, 3).join(', ')} — pre-push-visual-gate.sh blocks the push until the owner approves`,
    });
  } else if (UI_CARD_CLASS_RE.test(subject)) {
    blockers.push({
      code: BLOCKERS.VISUAL_QA_GATE,
      detail: 'rage-click / UX-audit card class — the fix is a UI change by construction, so the push needs owner visual-qa approval',
    });
  } else if (VISUAL_QA_MENTION_RE.test(text)) {
    blockers.push({
      code: BLOCKERS.VISUAL_QA_GATE,
      detail: 'card calls for the visual-qa ritual, which ends in an owner approval an unattended session cannot get',
    });
  }

  const asyncHit = firstMatch(ASYNC_WAIT_RES, text);
  if (asyncHit) {
    blockers.push({
      code: BLOCKERS.ASYNC_WAIT_GATE,
      detail: `completion is deferred past this session ("${asyncHit}") — nothing resumes a finished headless job`,
    });
  }

  const ownerHit = firstMatch(OWNER_DECISION_RES, text);
  if (ownerHit) {
    blockers.push({
      code: BLOCKERS.OWNER_DECISION_GATE,
      detail: `card defers to the owner ("${ownerHit}")`,
    });
  }

  const requireVerify = opts.requireVerifyCmd !== false;
  if (requireVerify) {
    const verifyCmd = opts.verifyCmd !== undefined ? opts.verifyCmd : evaluateVerifiability(notes).cmd;
    if (!verifyCmd) {
      blockers.push({
        code: BLOCKERS.NO_VERIFY_CMD,
        detail: 'no runnable verify command in the acceptance criteria — the nightly recheck would have nothing to re-run',
      });
    }
  }

  return {
    dispatchable: blockers.length === 0,
    blockers,
    reason: blockers.length
      ? blockers.map(b => `${b.code}: ${b.detail}`).join('; ')
      : null,
  };
}

function parseCliArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([\w-]+)(?:=([\s\S]*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

if (require.main === module) {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log('Usage: node scripts/lib/headless-dispatchability.js --subject="..." [--notes="..."]');
    console.log('Exits 0 if an unattended headless session could finish the card, 1 if a human gate blocks it.');
    process.exit(0);
  }
  const result = classifyHeadlessDispatchability({ subject: args.subject, notes: args.notes });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.dispatchable ? 0 : 1);
}

module.exports = {
  BLOCKERS,
  UI_PATH_RE,
  UI_CARD_CLASS_RE,
  // Exported so a test can assert this array holds the SHARED owner-judgment
  // regex object rather than a fourth handwritten copy (task #1154).
  OWNER_DECISION_RES,
  // Exported for the same reason as OWNER_DECISION_RES above, so the test can
  // assert the /m flag on the SHARED object rather than on a copy. Note the
  // test asserts the flags and, separately, that the regex and the classifier
  // AGREE on a table of inputs — it does not assert object identity, which the
  // classifier's use of a module-scope const already guarantees.
  PARKED_SENTINEL_RE,
  classifyHeadlessDispatchability,
  looksLikeUiPath,
  extractPathTokens,
  uiPathsIn,
};
