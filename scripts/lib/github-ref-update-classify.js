/**
 * github-ref-update-classify — pure decision function mapping a GitHub REST
 * response onto push-via-git-api.sh's EXISTING failure taxonomy.
 *
 * WHY THIS IS A SEPARATE, PURE MODULE (BRO-2951, CLAUDE.md §15):
 * push-via-git-api.sh already classifies a FAILED `git push` by grepping
 * git's stderr (see its race-text grep). A REST ref update reports the same
 * conditions as an HTTP status + JSON body instead, and the plan-review for
 * BRO-2951 flagged that hand-rolling a second mapping inline in bash would
 * fork one taxonomy into two implementations that silently drift — the
 * shell one is pinned by tests, the REST one would not be. Keeping the
 * mapping here, with no fetch / no fs / no timers, means every branch is a
 * unit-testable input->output decision (the pattern
 * github-rate-limit-retry.js already established in this directory) and the
 * bash side is reduced to dispatching on one word.
 *
 * WHY THE BUCKETS ARE WHAT THEY ARE — each one exists because mapping it
 * anywhere else was shown to be actively harmful:
 *
 *   race      the compare-and-swap genuinely lost; the remote tip moved.
 *             Retry immediately against the new tip. This is the ONLY
 *             condition that should retry fast.
 *
 *   throttled GitHub is rate-limiting us (primary or secondary). Retryable,
 *             but ONLY after backing off — GitHub's own guidance for
 *             secondary limits is to back off, not to retry immediately.
 *             This bucket exists because `PATCH /git/refs` is a
 *             content-mutating request and therefore subject to the
 *             secondary limit; at this repo's measured 841-1210 commits/day
 *             a 403 secondary limit is the error we are MOST likely to hit,
 *             and the reviewed plan originally routed it to `fatal`, which
 *             would abandon every remaining budgeted attempt on a purely
 *             transient condition.
 *
 *   timeout   transport-level: the request never produced a usable answer
 *             (socket timeout, abort, connection reset, 5xx). Retryable
 *             with backoff. Deliberately NOT merged into `throttled` —
 *             push-via-git-api.sh reports its exhaustion breakdown as
 *             "N timed out at the cap, N lost the ref race", and BRO-2951's
 *             whole diagnosis rests on that count meaning "we never got an
 *             answer". Folding rate-limiting into it would corrupt the one
 *             discriminator the card exists to sharpen.
 *
 *   fatal     a condition retrying cannot fix: bad credentials, missing
 *             repo/ref, a malformed sha, or a branch-protection/ruleset
 *             rejection. Fail loudly and name the status.
 *
 * A 422 is the sharpest trap here and the reason `status` alone is never
 * enough. GitHub returns 422 BOTH for the lost compare-and-swap
 * ("Update is not a fast forward" — verified live against this repo, which
 * left main unchanged) AND for validation failures, malformed refs, missing
 * objects, and protected-branch/ruleset rejections. Classifying every 422
 * as a race would turn an unfixable rejection into a hot retry loop that
 * burns the entire deadline and then reports "lost the ref race" — the
 * exact species of false signal BRO-2951's own logs were poisoned by. So a
 * 422 is a race ONLY when the body says so.
 */

'use strict';

/** Statuses that mean "no usable answer came back" rather than "no". */
const TRANSPORT_STATUSES = new Set([500, 502, 503, 504]);

/**
 * Body text that identifies a lost compare-and-swap. GitHub's wording for
 * the non-fast-forward rejection on PATCH /git/refs; `fast forward` covers
 * both the hyphenated and unhyphenated spellings.
 */
const RACE_BODY_RE = /not a fast[\s-]?forward|is at .* but expected|reference cannot be updated/i;

/**
 * Body text that identifies rate limiting rather than refusal. GitHub uses
 * 403 for BOTH secondary rate limits and genuine permission denials, so the
 * body (or a Retry-After header) is what separates "come back later" from
 * "never".
 */
const THROTTLE_BODY_RE = /secondary rate limit|rate limit exceeded|abuse detection|please retry your request again|too many requests/i;

/**
 * Error text that identifies a transport failure with no HTTP status at all
 * — gh-api-client.js's own abort message, plus the usual socket errors.
 */
const TRANSPORT_ERROR_RE = /timed out after|aborted|aborterror|socket hang up|econnreset|econnrefused|etimedout|enetunreach|eai_again|network|fetch failed/i;

/**
 * Classify one REST ref-update outcome.
 *
 * Every argument is optional so a caller can pass whatever it actually has:
 * a thrown gh-api-client error carries `status` + `body`, a transport
 * failure carries only `errorMessage`, and a success carries only `status`.
 *
 * @param {object} [input]
 * @param {number} [input.status]        HTTP status, if a response arrived.
 * @param {string} [input.body]          Raw response body, if any.
 * @param {string} [input.errorMessage]  Thrown error message, if any.
 * @param {string|number} [input.retryAfter] Retry-After header, if present.
 * @returns {{outcome: 'success'|'race'|'throttled'|'timeout'|'fatal', reason: string}}
 */
function classifyRefUpdate(input = {}) {
  const status = Number.isFinite(Number(input.status)) ? Number(input.status) : null;
  const body = typeof input.body === 'string' ? input.body : '';
  const errorMessage = typeof input.errorMessage === 'string' ? input.errorMessage : '';
  const retryAfter = input.retryAfter;

  // No status at all means the request never completed. Check this FIRST:
  // a transport failure has no status to dispatch on, and falling through
  // to the default would file it as fatal and abandon the retry budget.
  if (status === null) {
    if (errorMessage && TRANSPORT_ERROR_RE.test(errorMessage)) {
      return { outcome: 'timeout', reason: `transport failure: ${errorMessage}` };
    }
    return {
      outcome: 'fatal',
      reason: errorMessage
        ? `no HTTP status and unrecognized error: ${errorMessage}`
        : 'no HTTP status and no error message',
    };
  }

  if (status >= 200 && status < 300) {
    return { outcome: 'success', reason: `HTTP ${status}` };
  }

  // 429 is unambiguous, and a Retry-After on ANY 4xx is GitHub telling us
  // in a header exactly what the body sometimes says in prose.
  if (status === 429) {
    return { outcome: 'throttled', reason: 'HTTP 429 rate limited' };
  }
  if (status === 403) {
    if (THROTTLE_BODY_RE.test(body) || retryAfter) {
      return {
        outcome: 'throttled',
        reason: retryAfter
          ? `HTTP 403 rate limited (retry-after: ${retryAfter})`
          : 'HTTP 403 secondary rate limit',
      };
    }
    // A 403 with no rate-limit signal is a real refusal — most likely a
    // protected-branch or ruleset rejection, or a token without push rights.
    // Retrying cannot change either.
    return { outcome: 'fatal', reason: `HTTP 403 refused (not rate limiting): ${firstLine(body)}` };
  }

  // The 422 fork — a race ONLY when the body says the update was not a
  // fast-forward. Every other 422 is a rejection retrying cannot fix.
  if (status === 422) {
    if (RACE_BODY_RE.test(body)) {
      return { outcome: 'race', reason: 'HTTP 422 not a fast forward — compare-and-swap lost' };
    }
    return { outcome: 'fatal', reason: `HTTP 422 rejected (not a lost race): ${firstLine(body)}` };
  }

  // GitHub uses 409 for ref conflicts on some paths; that is the same
  // condition as a lost CAS, so it retries against the fresh tip.
  if (status === 409) {
    return { outcome: 'race', reason: 'HTTP 409 conflict — remote tip moved' };
  }

  if (TRANSPORT_STATUSES.has(status)) {
    return { outcome: 'timeout', reason: `HTTP ${status} server error` };
  }

  return { outcome: 'fatal', reason: `HTTP ${status}: ${firstLine(body)}` };
}

/** First non-empty line of a body, truncated — keeps log lines readable. */
function firstLine(body) {
  if (!body) return '(empty body)';
  const line = body.split('\n').map((s) => s.trim()).find(Boolean) || '(empty body)';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * Whether an outcome should consume another retry attempt rather than
 * aborting the run. Kept here (not at the call site) so the shell and any
 * future node caller cannot disagree about it.
 */
function isRetryable(outcome) {
  return outcome === 'race' || outcome === 'throttled' || outcome === 'timeout';
}

module.exports = { classifyRefUpdate, isRetryable };
