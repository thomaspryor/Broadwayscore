#!/usr/bin/env node
/**
 * dedupe-commercial-id-keys.js
 *
 * Delete commercial.json entries keyed by show ID that duplicate a
 * slug-keyed sibling entry. This is the fix command named by
 * audit-commercial-data.js's `duplicate-key-pair` error (--strict gate).
 *
 * Why this exists: the Jul 19 2026 dedup (task #160) was clobbered 17
 * minutes later by the opening-night-poller whole-file overwrite (task
 * #268), resurrecting 13 ID-keyed duplicates that double-counted shows in
 * every commercial audit metric for 13 days. The writer-side bugs are
 * fixed; this script + the strict gate handle resurrection of old state.
 *
 * Usage:
 *   node scripts/dedupe-commercial-id-keys.js                # dry-run report
 *   node scripts/dedupe-commercial-id-keys.js --apply        # delete pairs whose
 *                                                            # ID entry holds no
 *                                                            # unique non-model data
 *   node scripts/dedupe-commercial-id-keys.js --apply --prefer-slug
 *     # ALSO delete conflicting pairs, discarding the ID entry's differing
 *     # fields. Correct for clobber-resurrection: the slug entry carries the
 *     # later human adjudication, the ID entry is pre-merge stale state.
 *     # Every discarded field is printed — read the output.
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');

if (hasHelpFlag(process.argv)) {
  const lines = fs.readFileSync(__filename, 'utf8').split('\n');
  const end = lines.findIndex((l) => /^\s*\*\//.test(l));
  console.log(lines.slice(2, end).join('\n').replace(/^ \* ?/gm, ''));
  process.exit(0);
}

const KNOWN_FLAGS = new Set(['--apply', '--prefer-slug']);
const unknown = process.argv.slice(2).filter((a) => a.startsWith('-') && !KNOWN_FLAGS.has(a));
if (unknown.length > 0) {
  console.error(`Unknown flag(s): ${unknown.join(', ')} — valid: --apply, --prefer-slug, --help`);
  process.exit(2);
}

const { loadCommercial, saveCommercial } = require('./lib/commercial-write-guard');
const { findDuplicateKeyPairs, conflictingFields } = require('./lib/commercial-key-duplicates');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');

const apply = process.argv.includes('--apply');
const preferSlug = process.argv.includes('--prefer-slug');

const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
const showList = showsData.shows || showsData;
const showBySlug = {};
const showById = {};
for (const show of showList) {
  showBySlug[show.slug] = show;
  showById[show.id] = show;
}

const commercial = loadCommercial();
const pairs = findDuplicateKeyPairs(commercial.shows, showBySlug, showById);

if (pairs.length === 0) {
  console.log('No ID-keyed duplicate pairs found. Nothing to do.');
  process.exit(0);
}

console.log(`Found ${pairs.length} ID-keyed duplicate pair(s):\n`);

let deleted = 0;
let refused = 0;
for (const { idKey, slugKey } of pairs) {
  const conflicts = conflictingFields(commercial.shows[idKey], commercial.shows[slugKey]);
  const clean = conflicts.length === 0;
  const willDelete = apply && (clean || preferSlug);

  if (clean) {
    console.log(`  ${idKey} -> ${slugKey}: ID entry fully contained in slug entry ${willDelete ? '[DELETING]' : '[would delete]'}`);
  } else if (preferSlug) {
    console.log(`  ${idKey} -> ${slugKey}: DISCARDING ID-entry fields that differ (slug entry wins): ${conflicts.join(', ')} ${willDelete ? '[DELETING]' : '[would delete]'}`);
    for (const f of conflicts) {
      console.log(`      ${f}: id=${JSON.stringify(commercial.shows[idKey][f])} | slug=${JSON.stringify(commercial.shows[slugKey][f])}`);
    }
  } else {
    console.log(`  ${idKey} -> ${slugKey}: REFUSED — ID entry has non-model fields not contained in slug entry: ${conflicts.join(', ')}`);
    console.log('      Merge manually or re-run with --prefer-slug if the slug entry is the later adjudication (clobber-resurrection).');
    refused++;
    continue;
  }

  if (willDelete) {
    delete commercial.shows[idKey];
    deleted++;
  }
}

if (!apply) {
  console.log(`\nDry run — no changes written. Re-run with --apply${refused > 0 ? ' (and --prefer-slug for the refused pairs, after reading the diffs)' : ''}.`);
  process.exit(0);
}

if (deleted > 0) {
  saveCommercial(commercial, { allowShrink: true });
  console.log(`\nDeleted ${deleted} ID-keyed duplicate entr${deleted === 1 ? 'y' : 'ies'}; ${Object.keys(commercial.shows).length} entries remain.`);
}
if (refused > 0) {
  console.log(`${refused} pair(s) refused (unique data in ID entry) — resolve manually.`);
  process.exit(1);
}
