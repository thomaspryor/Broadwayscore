#!/usr/bin/env node
/**
 * audit-url-critic-slug-filenames.js — acceptance check for BRO-2938 (armed by
 * BRO-5456): review-text files whose filename carries a URL where the critic
 * slug belongs, e.g. `chicago-sun-times--httpschicagosuntimescom...json`.
 *
 * Several call sites split the filename on '--' to read outlet and critic, so
 * a URL there can reach critic-identity logic. Exit 0 iff no file under
 * data/review-texts/<show>/ has a critic part starting with "http"; exit 1
 * lists them; exit 2 when data/review-texts is absent (cannot verify, never a
 * pass — run `./scripts/setup-local-data.sh`).
 *
 * Read-only: directory listings only, no file contents, writes, spawns or network.
 *
 * Usage: node scripts/audit-url-critic-slug-filenames.js [--json]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

/** PURE. Is this review-text filename's critic part (after the first '--') a URL? */
function hasUrlCriticSlug(filename) {
  const base = String(filename || '');
  if (!base.endsWith('.json')) return false;
  const i = base.indexOf('--');
  return i > 0 && /^https?/i.test(base.slice(i + 2));
}

function main(argv) {
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error('[audit-url-critic-slug-filenames] data/review-texts not found; cannot verify (run ./scripts/setup-local-data.sh)');
    return 2;
  }
  const bad = [];
  for (const show of fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })) {
    if (!show.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(REVIEW_TEXTS_DIR, show.name))) {
      if (hasUrlCriticSlug(f)) bad.push(`${show.name}/${f}`);
    }
  }
  if (argv.includes('--json')) console.log(JSON.stringify({ count: bad.length, files: bad }, null, 2));
  else if (bad.length) console.log(`[audit-url-critic-slug-filenames] FAIL: ${bad.length} file(s) carry a URL as the critic slug, e.g. ${bad.slice(0, 3).join(', ')}`);
  else console.log('[audit-url-critic-slug-filenames] PASS: no review-text filename carries a URL as the critic slug');
  return bad.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { hasUrlCriticSlug };
