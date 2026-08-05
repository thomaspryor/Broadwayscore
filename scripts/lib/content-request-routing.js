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
 *    Scope of that support today: N missing-image asks (one per show named in
 *    an absence sentence) but at most ONE missing-show ask, because the
 *    add-show signal is the form's single `show` field. A message asking for
 *    two new shows at once yields only the one named in that field.
 *  - NOTHING FALLS OFF THE EDGE. Anything not confidently routable comes back
 *    as an `unroutable` action carrying a reason, so the caller still parks it
 *    for review. Silence is never an outcome.
 *
 * Colocated test: tests/unit/content-request-routing.test.mjs
 */

const { resolveShow, resolveShowMatches, extractShowTitlesFromText } = require('./resolve-show.js');

/** Workflows this module is allowed to name. Keep in sync with .github/workflows/. */
const WORKFLOW_IMAGE = 'fetch-all-image-formats.yml';
const WORKFLOW_ADD_SHOW = 'add-requested-show.yml';
const WORKFLOW_REVIEWS = 'gather-reviews.yml';

/**
 * Above this review count, "you're missing reviews for X" is not taken at face
 * value: the ask parks for a human instead of auto-dispatching a scrape.
 * gather-reviews spends Bright Data / ScrapingBee credits, so the one thing
 * this route must not become is a free "burn credits" button for anyone with
 * the feedback form open. A show already carrying this many reviews is far
 * more likely to be a taste disagreement ("you're missing the Times") than a
 * genuinely unfinished gather — and parking is no longer a dead end (the
 * caller now alerts the owner on every unroutable ask).
 */
const REVIEW_COUNT_AUTOGATHER_CEILING = 5;

/**
 * "no picture", "there's no image for", "missing artwork", "needs a poster".
 * Scoped to a single sentence by the caller so the absence phrase and the show
 * title have to co-occur locally — a message that praises one show and reports
 * a missing image on another must not cross-wire the two.
 */
const IMAGE_ABSENCE_RE =
  /\b(?:no|missing|lacks?|lacking|without|needs?\s+(?:an?\s+)?|there'?s\s+no)\b[^.!?]{0,60}?\b(?:picture|image|photo|artwork|poster|key\s*art|thumbnail)\b/i;

/**
 * "finish the reviews", "reviews are incomplete", "missing reviews", "only one
 * review". Sentence-scoped by the caller for the same cross-wiring reason as
 * IMAGE_ABSENCE_RE.
 *
 * Deliberately does NOT match bare "reviews" or positive mentions ("great
 * reviews", "I read the reviews here every day") — an absence/completion verb
 * has to be present. This only runs on submissions the categorizer already
 * marked contentRequest:true, so the residual false-positive risk is bounded,
 * and REVIEW_COUNT_AUTOGATHER_CEILING is the second line of defence.
 */
const REVIEW_ABSENCE_RE = new RegExp(
  [
    // verb/quantifier first: "finish the reviews", "no reviews", "only one review"
    /\b(?:finish|complete|update|missing|lacks?|lacking|without|incomplete|unfinished|needs?\s+(?:more\s+)?|there'?s\s+no|only\s+(?:one|two|1|2|a\s+few))\b[^.!?]{0,40}?\breviews?\b/.source,
    // noun first: "reviews are incomplete", "reviews aren't finished", "reviews missing"
    /\breviews?\b[^.!?]{0,30}?\b(?:missing|incomplete|unfinished|not\s+(?:yet\s+)?(?:done|finished|complete|up))\b/.source,
  ].join('|'),
  'i'
);

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
 * Market words the feedback form appends to a title, parenthesized or bare,
 * mapped to the `category` values used in shows.json.
 */
const MARKET_WORD_TO_CATEGORY = {
  regional: 'regional',
  tryout: 'regional',
  'pre-broadway': 'regional',
  'pre broadway': 'regional',
  broadway: 'broadway',
  'off-broadway': 'off-broadway',
  'off broadway': 'off-broadway',
  'west-end': 'west-end',
  'west end': 'west-end',
};

/**
 * Every "<title> <market>" pair in the form's show field, in order.
 *
 * WHY (2026-08-05, GH #542): the field is ONE free-text string and users put
 * more than one show in it — "The Outsiders (Regional) and Two Strangers (Carry
 * a Cake Across New York) Regional". Treating it as a single title fuzzy-matched
 * that whole string to `two-strangers-bway-2025` and dropped The Outsiders
 * entirely. The old code's own header called this out as a known limit ("at most
 * ONE missing-show ask"); it cost the owner a real request.
 *
 * Splitting on " and " is NOT safe — "Sense and Sensibility" is a title. The
 * market word is the reliable delimiter instead: the form appends one to every
 * title, so each match ends a segment. A field with no market word at all falls
 * back to the whole string as a single untyped title, which is the pre-existing
 * behaviour.
 */
const MARKET_TOKEN_RE =
  /\s*(?:\((regional|broadway|off[-\s]?broadway|west[-\s]?end|tryout|pre[-\s]?broadway)\)|\b(regional|broadway|off[-\s]?broadway|west[-\s]?end|pre[-\s]?broadway)\b)/gi;

function parseRequestedTitles(raw) {
  const field = String(raw || '').trim();
  if (!field) return [];

  const out = [];
  let cursor = 0;
  MARKET_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = MARKET_TOKEN_RE.exec(field)) !== null) {
    const marketWord = (m[1] || m[2] || '').toLowerCase().replace(/\s+/g, '-');
    const title = field
      .slice(cursor, m.index)
      // Drop the conjunction/punctuation that joined this segment to the last.
      .replace(/^\s*(?:and\b|&|,|;|\/)\s*/i, '')
      .trim();
    cursor = m.index + m[0].length;
    if (!title) continue;
    out.push({ title, market: MARKET_WORD_TO_CATEGORY[marketWord] || null });
  }

  // Trailing text after the last market word, or a field with no market at all.
  const tail = field.slice(cursor).replace(/^\s*(?:and\b|&|,|;|\/)\s*/i, '').trim();
  if (tail) out.push({ title: tail, market: null });

  return out.length ? out : [{ title: field, market: null }];
}

/**
 * Resolve a title WITHIN a requested market.
 *
 * resolveShow() deliberately ranks Broadway first — right for a user reporting a
 * bug on a show they can see now, wrong for a content request. "The Outsiders
 * (Regional)" asks for the La Jolla tryout; matching it to the Broadway
 * production and concluding "already in catalog" is how #542 was silently
 * refused. When a market is named, only productions in that market count; the
 * Broadway entry existing says nothing about whether the tryout does.
 */
function resolveShowInMarket(title, market, shows) {
  if (!market) return resolveShow(title, shows);
  const matches = resolveShowMatches(title, shows).filter((s) => s && s.category === market);
  if (matches.length === 0) return null;
  return [...matches].sort((a, b) =>
    String(b.openingDate || '').localeCompare(String(a.openingDate || ''))
  )[0];
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
 * The venue hint belonging to ONE title in a multi-show message.
 *
 * "…The Outsiders out of town at The Weiss at La Jolla and Two Strangers out of
 * town from A.R.T in Cambridge…" carries two venues. extractVenueHint() returns
 * the first for both, which would send Two Strangers to La Jolla — a wrong hint
 * is worse than none, because add-requested-show searches on it.
 *
 * So: find where this title is mentioned, and take only the first venue phrase
 * AFTER it and BEFORE the next title's mention. Falls back to null (not to the
 * message-wide hint) when the title isn't found — an unfounded hint is exactly
 * what this avoids.
 */
function extractVenueHintFor(title, message, otherTitles = []) {
  const text = String(message || '');
  const needle = String(title || '').trim();
  if (!needle) return null;

  const start = text.toLowerCase().indexOf(needle.toLowerCase());
  if (start === -1) return null;

  // Stop at whichever other requested title is mentioned next, so a hint can
  // never reach across into the following show's clause.
  let end = text.length;
  for (const other of otherTitles) {
    const o = String(other || '').trim();
    if (!o || o.toLowerCase() === needle.toLowerCase()) continue;
    const at = text.toLowerCase().indexOf(o.toLowerCase(), start + needle.length);
    if (at !== -1 && at < end) end = at;
  }

  const window = text.slice(start + needle.length, end);
  const m = new RegExp(VENUE_HINT_RE.source).exec(window);
  return m ? m[1].trim() : null;
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
 * @param {Map<string, number>|object} [opts.reviewCountsByShowId]
 *        Current review count per show ID. Passed in (not read from disk) to
 *        keep this pure. When omitted, a missing-reviews ask still routes and
 *        `reviewCountAtRequest` is null; when supplied, a show at or above
 *        REVIEW_COUNT_AUTOGATHER_CEILING parks instead of auto-dispatching.
 * @returns {Array<object>} actions; each has `kind` plus, when dispatchable,
 *          `workflow` and `inputs`. Never empty: an unroutable request yields a
 *          single `{kind:'unroutable', reason}` so the caller parks it.
 */
function planContentRequestActions({
  message,
  show,
  shows,
  showIdsMissingImages,
  reviewCountsByShowId,
} = {}) {
  const actions = [];
  const allShows = Array.isArray(shows) ? shows : [];
  const missingImages = showIdsMissingImages instanceof Set ? showIdsMissingImages : null;

  // Accept either a Map or a plain object; anything else means "unknown".
  const reviewCount = (showId) => {
    if (reviewCountsByShowId instanceof Map) {
      return reviewCountsByShowId.has(showId) ? reviewCountsByShowId.get(showId) : null;
    }
    if (reviewCountsByShowId && typeof reviewCountsByShowId === 'object') {
      return Object.prototype.hasOwnProperty.call(reviewCountsByShowId, showId)
        ? reviewCountsByShowId[showId]
        : null;
    }
    return null;
  };

  /**
   * Build the missing-reviews action for an already-catalogued show, or an
   * `unroutable` row explaining why it wasn't dispatched. Shared by the
   * sentence-scoped pass and the form-field fallback so the credit-spend gate
   * cannot be bypassed by whichever path happens to match first.
   */
  const planReviewGather = (resolved) => {
    const count = reviewCount(resolved.id);
    if (count !== null && count >= REVIEW_COUNT_AUTOGATHER_CEILING) {
      return {
        kind: 'unroutable',
        reason:
          `show "${resolved.title}" already has ${count} review(s) ` +
          `(>= ${REVIEW_COUNT_AUTOGATHER_CEILING}); not auto-gathering — needs a human to judge ` +
          `whether a specific outlet is genuinely missing`,
        showId: resolved.id,
      };
    }
    return {
      kind: 'missing-reviews',
      showId: resolved.id,
      showTitle: resolved.title,
      reviewCountAtRequest: count,
      workflow: WORKFLOW_REVIEWS,
      inputs: {
        // gather-reviews.js parses --shows= as show IDs (it matches on s.id),
        // NOT slugs, despite the workflow input's description. They diverge
        // for any show whose slug drops the year/market suffix.
        shows: resolved.id,
      },
    };
  };

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

  // --- Ask 1b: reviews never finished on a show we already carry -----------
  // Same sentence-scoping as the image pass. This is the ask that had NO route
  // before (2026-08-05, GH #543): "Please finish the reviews for 3 Summers of
  // Lincoln" resolved to a catalogued show, matched no image phrasing, and so
  // hit the unroutable branch below — a parked issue nothing consumed.
  const seenReviewShowIds = new Set();
  for (const sentence of splitSentences(message)) {
    if (!REVIEW_ABSENCE_RE.test(sentence)) continue;
    for (const title of extractShowTitlesFromText(sentence, allShows)) {
      const resolved = resolveShow(title, allShows);
      if (!resolved || seenReviewShowIds.has(resolved.id)) continue;
      seenReviewShowIds.add(resolved.id);
      actions.push(planReviewGather(resolved));
    }
  }

  // --- Ask 2: a show that isn't in the catalog at all ----------------------
  // The form's `show` field is the primary signal: it is what the user typed
  // as the subject of the request. If it resolves to a catalog entry there is
  // nothing to add.
  // EVERY title in the field gets its own action — the field routinely holds
  // more than one (GH #542), and one show's ask must not swallow the other's.
  const requested = parseRequestedTitles(show);
  const requestedTitles = requested.map((r) => r.title);
  for (const { title: requestedTitle, market } of requested) {
    if (!requestedTitle) continue;

    // Market-scoped: a Broadway entry does not satisfy a request for the
    // regional tryout of the same title. See resolveShowInMarket().
    const existing = resolveShowInMarket(requestedTitle, market, allShows);
    if (!existing) {
      const venueHint = extractVenueHintFor(requestedTitle, message, requestedTitles)
        // Only fall back to the message-wide hint for a single-title request,
        // where there is no other clause the hint could belong to.
        || (requested.length === 1 ? extractVenueHint(message) : null);
      actions.push({
        kind: 'missing-show',
        title: requestedTitle,
        market: market || null,
        venueHint,
        workflow: WORKFLOW_ADD_SHOW,
        inputs: {
          title: requestedTitle,
          venue_hint: venueHint || '',
        },
      });
    } else if (!seenImageShowIds.has(existing.id) && !seenReviewShowIds.has(existing.id)) {
      // Named a show we already have, and neither sentence-scoped pass claimed
      // it. The form's `show` field is itself a statement of subject, so a
      // review-absence phrase ANYWHERE in the message applies to it — this is
      // what catches "Please finish the reviews for X" when the title in the
      // sentence doesn't extract cleanly (punctuation, an abbreviation, a
      // market suffix the user didn't type).
      if (REVIEW_ABSENCE_RE.test(String(message || ''))) {
        seenReviewShowIds.add(existing.id);
        actions.push(planReviewGather(existing));
      } else {
        // Real work, but not something this module can safely pick a workflow
        // for. Park it WITH the resolution so a human (or a later kind) starts
        // from a resolved show, not a string.
        actions.push({
          kind: 'unroutable',
          reason:
            `show "${requestedTitle}"${market ? ` (${market})` : ''} already in catalog as ` +
            `${existing.id}; ask is not a recognised image or review-gap request`,
          showId: existing.id,
        });
      }
    }
  }

  if (actions.length === 0) {
    actions.push({
      kind: 'unroutable',
      reason:
        'no recognised content-request pattern (no missing-image or review-gap phrasing, no unknown show named)',
    });
  }
  return actions;
}

module.exports = {
  planContentRequestActions,
  // exported for tests / reuse
  cleanRequestedTitle,
  parseRequestedTitles,
  resolveShowInMarket,
  extractVenueHint,
  extractVenueHintFor,
  splitSentences,
  IMAGE_ABSENCE_RE,
  REVIEW_ABSENCE_RE,
  WORKFLOW_IMAGE,
  WORKFLOW_ADD_SHOW,
  WORKFLOW_REVIEWS,
  REVIEW_COUNT_AUTOGATHER_CEILING,
};
