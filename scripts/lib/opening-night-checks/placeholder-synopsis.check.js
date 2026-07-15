'use strict';

const { isPlaceholderSynopsis, MIN_SYNOPSIS_LENGTH } = require('../opening-night-completeness.js');

const name = 'placeholder-synopsis';
const description = 'Synopsis is empty, matches a known LLM-template placeholder phrase, or is too thin to be useful';

const SKIP_STATUSES = new Set(['closed']);

/**
 * @param {Object} show
 * @param {import('./types').CheckContext} context
 * @returns {import('./types').CheckResult}
 */
function run(show, context) {
  if (SKIP_STATUSES.has(show.status)) {
    return { ok: true, severity: 'ok', message: `Status is ${show.status} — synopsis completeness not checked` };
  }

  if (!isPlaceholderSynopsis(show.synopsis)) {
    return { ok: true, severity: 'ok', message: `Synopsis present (${show.synopsis.trim().length} chars)` };
  }

  const text = (show.synopsis || '').trim();
  const reason = !text
    ? 'empty'
    : text.length < MIN_SYNOPSIS_LENGTH
      ? `too thin (${text.length} chars, min ${MIN_SYNOPSIS_LENGTH})`
      : 'matches a known placeholder phrase';

  return {
    ok: false,
    severity: 'warning',
    message: `synopsis for ${show.id} is ${reason} — write a specific 2-3 sentence synopsis from the show's press materials`,
    details: { showId: show.id, synopsis: show.synopsis || null, reason },
  };
}

module.exports = { name, description, run };
