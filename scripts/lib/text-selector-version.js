'use strict';

/**
 * BRO-7345 recurrence guard. rescore-flagging.js TEXT_SELECTOR_CHANGED_AT must be
 * bumped whenever the scorer's text selector (getBestTextForScoring) changes what it
 * picks, or complete reviews an older selector scored from an excerpt stay there
 * (the loop guard refuses to re-flag them). It was set 2026-11-10 and then went
 * unbumped through 24 selector commits (BRO-7171, BRO-7943, BRO-8012, BRO-8081...),
 * so files the newer selector reads as full text sat 'settled' on an excerpt score.
 *
 * A git-history check is unreliable in CI (shallow clones, rebases rewrite dates;
 * see 5edc7b42e87), so the selector sources are pinned by content hash instead:
 * tests/unit/rescore-flagging.test.mjs fails when these files change without
 * TEXT_SELECTOR_SOURCE_SHA256 (and the date) being bumped in rescore-flagging.js.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The selector-specific files whose edits change which text getBestTextForScoring
// picks. content-quality.js (TRUNCATION_SIGNALS) and text-cleaning.js also feed it but
// are left out on purpose: they are edited mostly for unrelated reasons (bylines,
// entity decoding), and pinning them would force a bump on nearly every edit.
const TEXT_SELECTOR_SOURCES = ['text-quality.js', 'trailer-signatures.js', 'page-furniture.js', 'excerpt-fields.js'];

function computeTextSelectorSourceHash(dir = __dirname, files = TEXT_SELECTOR_SOURCES) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    // Normalise line endings so a CRLF checkout cannot flip the hash.
    h.update(`${f}\0${fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n')}\0`);
  }
  return h.digest('hex');
}

module.exports = { TEXT_SELECTOR_SOURCES, computeTextSelectorSourceHash };
