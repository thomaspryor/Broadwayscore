/**
 * named-show-verdict.js — BRO-2821 suggestion 1.
 *
 * CLAUDE.md rule 3 tells an operator to cross-validate a provisional or manual
 * shows.json entry with `node scripts/validate-show-venue.js --show=<id>`
 * BEFORE committing it. That command used to exit 0 on every outcome except a
 * confirmed `mismatch` under `--fail-on-mismatch` — a flag the documented
 * operator command does not pass. So the bare form exited 0 in all three of
 * these cases:
 *
 *   1. the show was NEVER CHECKED (no Playbill page found, or the SERP/fetch
 *      failed, or the environment had no browser),
 *   2. the show was checked and Playbill DISAGREED about its venue or dates,
 *   3. the run stopped before reaching the show at all (time budget).
 *
 * A stub built from memory with the wrong year lands in case 1 or 2, so the
 * validator was silent on the exact population it exists to catch.
 *
 * The aggregate degraded-coverage warnings in validate-show-venue.js do not
 * cover this: `no-playbill-url` rows are deliberately removed from the
 * `answerable` denominator (roughly half the committed ledger is that class on
 * a full sweep, so counting them would warn on every healthy run). Excluding
 * them is right for a sweep and wrong for a single named show — when you name
 * ONE show, "that show has no Playbill page" is the whole answer, not a row
 * you can average away.
 *
 * The contract for a named run, and the reason the exit codes are distinct:
 *
 *   0  every named target produced `match`
 *   1  a named target produced `mismatch` — the entry IS wrong. Same code the
 *      existing --fail-on-mismatch gate uses, so the two paths agree.
 *   3  the question was not answered: an unresolved verdict, or the run never
 *      reached the show. NOT the same thing as "your show is wrong", so it
 *      does not reuse 1. (2 stays reserved for main()'s fatal catch.)
 *
 * Kept pure and separately testable so a change to that contract fails a test
 * rather than a production run.
 */

'use strict';

// The only two verdicts that mean the run ANSWERED. They are graded very
// differently below — `mismatch` is an answer, and a bad one.
const DEFINITIVE_RESULTS = new Set(['match', 'mismatch']);

const EXIT_MISMATCH = 1;
const EXIT_NOT_VALIDATED = 3;

// Why each non-definitive class is not a pass, and whether retrying the same
// command can plausibly change the outcome.
const NOT_VALIDATED_REASONS = {
  'no-playbill-url': {
    what: 'no Playbill production page was found for this show',
    why: 'a stub with a wrong year, wrong venue or a title that does not match Playbill produces exactly this result, and so does a search that simply failed to surface a page that exists — either way it is NOT evidence the entry is correct',
    retryable: false,
  },
  'serp-error': {
    what: 'every SERP query errored, so the Playbill page was never looked for',
    why: 'this is a provider outage, not evidence of a missing page',
    retryable: true,
  },
  'fetch-error': {
    what: 'the Playbill page was found but could not be fetched',
    why: 'the venue and dates on it were never read',
    retryable: true,
  },
  'short-response': {
    what: 'the Playbill page returned a body too short to parse',
    why: 'a block page or a truncated response reads as no mismatch, which is not the same as agreement',
    retryable: true,
  },
  'infra-unavailable': {
    what: 'this environment could not reach Playbill (Playwright browser missing)',
    why: 'BRO-2560 keeps this non-failing for a SWEEP, where it is one row among many; for a single named show it means zero coverage of the only show you asked about',
    retryable: true,
  },
  // Not a `result` value — synthesised below when the run stopped before
  // reaching a named target at all. `if (timeBudget.exceeded()) break;` in
  // validate-show-venue.js's loop is NOT gated on --all-provisional, so a
  // named run under a budget can produce zero rows and would otherwise have
  // read as a clean pass (adversarial review, Codex).
  'not-reached': {
    what: 'the run ended before checking this show (time budget, or the loop stopped early)',
    why: 'nothing about the entry was read at all',
    retryable: true,
  },
};

/**
 * Decide what an explicitly-named `--show=<id>` run actually established.
 *
 * Returns `{ validated: true, exitCode: 0 }` for any run that is not an
 * explicitly-named show (a sweep, a candidates file) — those keep their
 * existing aggregate warnings and their existing exit contract, untouched.
 *
 * @param {object} opts
 * @param {string|undefined} opts.showFilter  the raw `--show=` value, if any
 * @param {Array<{id: string, result: string}>} opts.results  rows this run produced
 * @param {number} [opts.targetCount]  how many shows the run INTENDED to check;
 *   when it exceeds results.length the missing ones were never reached
 * @returns {{validated: boolean, exitCode: number, result: string|null,
 *            retryable: boolean, message: string|null}}
 */
function classifyNamedShowRun({ showFilter, results, targetCount }) {
  const ok = { validated: true, exitCode: 0, result: null, retryable: false, message: null };
  if (!showFilter) return ok;
  const rows = Array.isArray(results) ? results : [];

  // A confirmed mismatch outranks everything else: it is the most actionable
  // thing this script can tell you, and it gets the same exit 1 the
  // --fail-on-mismatch gate uses so the flagged and bare forms agree. That
  // gate runs FIRST and exits before this function is reached whenever the
  // flag is passed, so in practice this branch serves the bare `--show=<id>`
  // form — the one CLAUDE.md rule 3 documents, which reported a wrong venue
  // or a wrong year and then exited 0.
  const mismatched = rows.filter(r => r && r.result === 'mismatch');
  if (mismatched.length) {
    const ids = mismatched.map(r => r.id || showFilter).join(', ');
    return {
      validated: false,
      exitCode: EXIT_MISMATCH,
      result: 'mismatch',
      retryable: false,
      message: `validate-show-venue: ${ids} MISMATCHES Playbill on the field(s) listed above. `
        + 'Do not commit this entry until the venue and dates agree, or until the difference is '
        + 'explained by a prior run (CLAUDE.md rule 3).',
    };
  }

  // Rows that are not an answer, plus targets the run never got to. A named
  // run resolves to at most one target today; do not assume it, because "every
  // intended target produced a verdict" stays the correct reading either way.
  const unanswered = rows.filter(r => !DEFINITIVE_RESULTS.has(r && r.result));
  const intended = Number.isInteger(targetCount) ? targetCount : rows.length;
  const notReached = Math.max(0, intended - rows.length);
  if (!unanswered.length && !notReached) return ok;

  // A row can be null or missing `result` entirely (a malformed row, a future
  // code path that forgets the field). That is still "not an answer", so it
  // must reach the fail-closed branch rather than throw — a throw would fall
  // into main()'s catch and exit 2, mislabelling a not-validated run as a
  // crash.
  // A row that EXISTS but carries no `result` was still checked — it must not
  // be relabelled 'not-reached', which would tell the operator "the run ended
  // before checking this show" about a show the run did reach (Claude review).
  // It falls through to the unrecognised-reason default below instead.
  // Branch on whether an unusable ROW EXISTS, not on whether it is null — a
  // null row is itself a row the run produced, so `first === null` would fold
  // it back into 'not-reached' and reintroduce the false explanation.
  const hasRow = unanswered.length > 0;
  const first = hasRow ? unanswered[0] : null;
  const firstResult = !hasRow
    ? 'not-reached'
    : (first && first.result !== undefined ? first.result : 'missing-result');
  const reason = NOT_VALIDATED_REASONS[firstResult] || {
    what: `the run produced no venue/date verdict (result: ${firstResult})`,
    why: 'an unrecognised non-definitive result is not evidence the entry is correct',
    retryable: false,
  };
  const ids = unanswered.length
    ? unanswered.map(r => (r && r.id) || showFilter).join(', ')
    : showFilter;
  const tail = notReached && !unanswered.length
    ? ` ${notReached} named target(s) were never reached by this run.`
    : '';
  return {
    validated: false,
    exitCode: EXIT_NOT_VALIDATED,
    result: firstResult,
    retryable: reason.retryable,
    message: `validate-show-venue: ${ids} was NOT validated — ${reason.what}. This is not a pass: ${reason.why}.`
      + (reason.retryable
        ? ' Retry once the provider or environment recovers; do not read this run as a clean cross-check.'
        : ' Confirm the title, venue and year against Playbill by hand before committing this entry (CLAUDE.md rule 3).')
      + tail,
  };
}

module.exports = {
  classifyNamedShowRun,
  DEFINITIVE_RESULTS,
  NOT_VALIDATED_REASONS,
  EXIT_MISMATCH,
  EXIT_NOT_VALIDATED,
};
