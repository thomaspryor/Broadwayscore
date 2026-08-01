/**
 * Turn a content-addition feedback submission into concrete, dispatchable
 * actions instead of a parked GitHub issue.
 *
 * WHY THIS EXISTS (2026-08-01, "3 Summers of Lincoln" incident, GH #505):
 * Task #461 taught the categorizer to mark content requests
 * (`contentRequest: true`) so they'd stop being misfiled as Feature
 * Request/Other and silently vanishing. That fixed *disappearance* — it never
 * built a path to *action*. The post-#461 flow was:
 *
 *   contentRequest -> diagnosis: null            (process-feedback.js)
 *     -> issue labelled [feedback-digest, needs-review]   (process-feedback.yml)
 *       -> auto-fix-feedback-bug.yml gates on label 'bug-diagnosis'  -> never fires
 *
 * and nothing else in the repo queries `needs-review`/`feedback-digest`, while
 * process-feedback.yml deliberately DELETEs the owner's repo subscription. So a
 * content request reached a terminal, unnotified dead end by construction. The
 * owner's real request sat untouched from 14:15 until they resubmitted it as a
 * live test.
 *
 * This module is the missing routing layer. It is deliberately PURE and
 * deterministic (CLAUDE.md §15): no LLM call, no network, no fs. The LLM still
 * decides *whether* something is a content request; this decides *what to run*,
 * so the dispatch target is auditable and unit-testable against the real
 * message text rather than re-derived by a model on every run.
 *
 * Two properties the old path lacked and this one has:
 *  - ONE SUBMISSION CAN CARRY SEVERAL ASKS. The Lincoln message contained two
 *    (add a missing show + a missing image on a different, already-catalogued
 *    show). One-issue-per-submission structurally could not represent that;
 *    the second ask was invisible even to a human reading the issue title.
 *  - NOTHING FALLS OFF THE EDGE. Anything not confidently routable comes back
 *    as an `unroutable` action carrying a reason, so the caller still parks it
 *    for review. Silence is never an outcome.
 *
 * Colocated test: tests/unit/content-request-routing.test.mjs
 */

const { resolveShow, extractShowTitlesFromText } = require('./resolve-show.js');

/** Workflows this module is allowed to name. Keep in sync with .github/workflows/. */
const WORKFLOW_IMAGE = 'fetch-all-image-formats.yml';
const WORKFLOW_ADD_SHOW = 'add-requested-show.yml';

/**
 * "no picture", "there's no image for", "missing artwork", "needs a poster".
 * Scoped to a single sentence by the caller so the absence phrase and the show
 * title have to co-occur locally — a message that praises one show and reports
 * a missing image on another must not cross-wire the two.
 */
const IMAGE_ABSENCE_RE =
  /\b(?:no|missing|lacks?|lacking|without|needs?\s+(?:an?\s+)?|there'?s\s+no)\b[^.!?]{0,60}?\b(?:picture|image|photo|artwork|poster|key\s*art|thumbnail)\b/i;

/** Market/category parentheticals the feedback form appends to the show field. */
const MARKET_PARENTHETICAL_RE =
  /\s*\((?:regional|broadway|off[-\s]?broadway|west[-\s]?end|tryout|pre[-\s]?broadway)\)\s*$/i;

/**
 * Venue hints worth passing to the show-add lookup. Free-text venue extraction
 * is unreliable in general, so this only recognises phrasings that explicitly
 * mark a venue ("at X", "from its run at X").
 *
 * `.` is deliberately EXCLUDED from the token class. With it allowed, the
 * capture ran straight through the sentence terminator: "...at La Jolla. PS:
 * there's no picture..." yielded the hint "La Jolla. PS". Abbreviated venues
 * ("St. Ann's Warehouse") therefore truncate to "St" — an acceptable loss for
 * an advisory hint, and the caller still has the full message.
 */
const VENUE_HINT_RE = /\b(?:at|from its run at|during its run at)\s+([A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*){0,3})/;

/** Split on sentence terminators, keeping non-empty trimmed fragments. */
function splitSentences(message) {
  return String(message || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Strip the form's trailing market parenthetical: "X (Regional)" -> "X". */
function cleanRequestedTitle(raw) {
  return String(raw || '').replace(MARKET_PARENTHETICAL_RE, '').trim();
}

/**
 * Best-effort venue phrase from the message, or null. Never throws.
 * Runs per sentence so a hint can never absorb text from the next one.
 */
function extractVenueHint(message) {
  for (const sentence of splitSentences(message)) {
    const m = VENUE_HINT_RE.exec(sentence);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Plan dispatchable actions for one content-request submission.
 *
 * @param {object} opts
 * @param {string} opts.message        Raw submission message.
 * @param {string} [opts.show]         Raw form "show" field.
 * @param {Array}  opts.shows          shows.json entries (id/title/slug/...).
 * @param {Set<string>} [opts.showIdsMissingImages]
 *        Show IDs known to have no image directory. Passed in (not read from
 *        disk) to keep this pure. When omitted, a missing-image ask still
 *        routes — the image workflow is itself idempotent and re-fetches only
 *        what it needs — but `imageAbsenceVerified` is false so the caller can
 *        report that it took the user's word for it.
 * @returns {Array<object>} actions; each has `kind` plus, when dispatchable,
 *          `workflow` and `inputs`. Never empty: an unroutable request yields a
 *          single `{kind:'unroutable', reason}` so the caller parks it.
 */
function planContentRequestActions({ message, show, shows, showIdsMissingImages } = {}) {
  const actions = [];
  const allShows = Array.isArray(shows) ? shows : [];
  const missingImages = showIdsMissingImages instanceof Set ? showIdsMissingImages : null;

  // --- Ask 1: a missing image on a show we already carry -------------------
  // Sentence-scoped so the absence phrase and the title must co-occur.
  const seenImageShowIds = new Set();
  for (const sentence of splitSentences(message)) {
    if (!IMAGE_ABSENCE_RE.test(sentence)) continue;
    for (const title of extractShowTitlesFromText(sentence, allShows)) {
      const resolved = resolveShow(title, allShows);
      if (!resolved || seenImageShowIds.has(resolved.id)) continue;
      seenImageShowIds.add(resolved.id);
      actions.push({
        kind: 'missing-image',
        showId: resolved.id,
        showTitle: resolved.title,
        imageAbsenceVerified: missingImages ? missingImages.has(resolved.id) : null,
        workflow: WORKFLOW_IMAGE,
        inputs: {
          show_id: resolved.id,
          // The user says this specific show has no art, so don't let the
          // workflow's "only shows missing images" default skip it if a stale
          // or broken file exists on disk.
          only_missing: 'false',
        },
      });
    }
  }

  // --- Ask 2: a show that isn't in the catalog at all ----------------------
  // The form's `show` field is the primary signal: it is what the user typed
  // as the subject of the request. If it resolves to a catalog entry there is
  // nothing to add.
  const requestedTitle = cleanRequestedTitle(show);
  if (requestedTitle) {
    const existing = resolveShow(requestedTitle, allShows);
    if (!existing) {
      actions.push({
        kind: 'missing-show',
        title: requestedTitle,
        venueHint: extractVenueHint(message),
        workflow: WORKFLOW_ADD_SHOW,
        inputs: {
          title: requestedTitle,
          venue_hint: extractVenueHint(message) || '',
        },
      });
    } else if (!seenImageShowIds.has(existing.id)) {
      // Named a show we already have, and it wasn't an image complaint. Could
      // be "you're missing reviews for X" — real work, but not something this
      // module can safely pick a workflow for. Park it WITH the resolution so
      // a human (or a later kind) starts from a resolved show, not a string.
      actions.push({
        kind: 'unroutable',
        reason: `show "${requestedTitle}" already in catalog as ${existing.id}; ask is not a recognised image request`,
        showId: existing.id,
      });
    }
  }

  if (actions.length === 0) {
    actions.push({
      kind: 'unroutable',
      reason: 'no recognised content-request pattern (no missing-image phrasing, no unknown show named)',
    });
  }
  return actions;
}

module.exports = {
  planContentRequestActions,
  // exported for tests / reuse
  cleanRequestedTitle,
  extractVenueHint,
  splitSentences,
  IMAGE_ABSENCE_RE,
  WORKFLOW_IMAGE,
  WORKFLOW_ADD_SHOW,
};
