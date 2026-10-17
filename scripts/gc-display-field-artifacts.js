#!/usr/bin/env node
/**
 * gc-display-field-artifacts.js
 *
 * Garbage-collect two display-field artifacts in review-text files:
 *   • undecoded HTML entities (&eacute; &amp; &ldquo; &#8217; …) in
 *     criticName / outlet / pullQuote / excerpt  → decode in place.
 *   • JSON-LD / structured-data markup in pullQuote / excerpt
 *     (@type, @context, schema.org, reviewBody …)  → drop the field.
 *
 * Mirrors the save-time guard now in review-file-writer.js (sanitizeDisplayFields)
 * and the validate-data [html-entity]/[jsonld-artifact] detectors — this sweep
 * cleans files that predate the guard. Shares the predicates + decoder via
 * scripts/lib/text-cleaning.js so the gate, the guard, and this sweep can't drift.
 *
 * FIELD-ONLY by design: a plain fs.writeFileSync, NOT safeWriteReview and NEVER a
 * rename. safeWriteReview runs url-collision detection that can stamp a dangling
 * duplicateOf; renames trip it (see feedback_rename_via_safewrite_dangles_duplicateof).
 * The gates read the FIELD values, so changing fields in place is sufficient.
 *
 * Usage:
 *   node scripts/gc-display-field-artifacts.js          # report only
 *   node scripts/gc-display-field-artifacts.js --fix    # apply
 *   node scripts/gc-display-field-artifacts.js --json   # machine-readable (CI)
 *
 * Exit codes: 0 = clean (or --fix applied), 1 = matches found in report mode.
 */

const fs = require('fs');
const path = require('path');
const { decodeHtmlEntities, hasUndecodedHtmlEntities, hasJsonLdArtifact } = require('./lib/text-cleaning');

const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const JSON_OUT = args.includes('--json');

const ENTITY_FIELDS = ['criticName', 'outlet', 'pullQuote', 'excerpt'];
const JSONLD_FIELDS = ['pullQuote', 'excerpt'];

function walkShowDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
}

function main() {
  const matches = [];
  let entityFixed = 0, jsonldDropped = 0;

  for (const showId of walkShowDirs(REVIEW_TEXTS_DIR)) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    for (const file of files) {
      const filePath = path.join(showDir, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { continue; }

      const entityFields = ENTITY_FIELDS.filter(f => hasUndecodedHtmlEntities(data[f]));
      const jsonldFields = JSONLD_FIELDS.filter(f => hasJsonLdArtifact(data[f]));
      if (!entityFields.length && !jsonldFields.length) continue;

      matches.push({ showId, file, entityFields, jsonldFields });

      if (FIX) {
        for (const f of entityFields) { data[f] = decodeHtmlEntities(data[f]); entityFixed++; }
        for (const f of jsonldFields) { delete data[f]; jsonldDropped++; }
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      }
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ count: matches.length, matches }, null, 2));
    process.exit(matches.length === 0 || FIX ? 0 : 1);
  }

  if (matches.length === 0) {
    console.log('OK: no display-field artifacts found');
    process.exit(0);
  }

  console.log(`Found ${matches.length} file(s) with display-field artifacts:\n`);
  for (const m of matches) {
    const parts = [];
    if (m.entityFields.length) parts.push(`html-entity: ${m.entityFields.join(', ')}`);
    if (m.jsonldFields.length) parts.push(`jsonld: ${m.jsonldFields.join(', ')}`);
    console.log(`  ${m.showId}/${m.file} — ${parts.join(' | ')}`);
  }

  if (FIX) {
    console.log(`\nApplied: ${entityFixed} entity field(s) decoded, ${jsonldDropped} JSON-LD field(s) dropped. Re-run rebuild.`);
    process.exit(0);
  }
  console.log('\nRun with --fix to clean.');
  process.exit(1);
}

main();
