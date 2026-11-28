#!/usr/bin/env node
/**
 * gc-display-field-artifacts.js
 *
 * Garbage-collect two display-field artifacts in review-text files:
 *   • undecoded HTML entities (&eacute; &amp; &ldquo; &#8217; …) in
 *     criticName / outlet / pullQuote / excerpt  → decode in place.
 *   • JSON-LD / structured-data markup in pullQuote / excerpt
 *     (@type, @context, schema.org, reviewBody …)  → drop the field.
 *   • video.js modal-dialog boilerplate ("Beginning of dialog window. Escape
 *     will cancel…") in fullText → re-run cleanText (BRO-4221). cleanText has
 *     stripped it at save time since 12676ae8; this sweep cleans texts saved
 *     before that, and ones whose forced refetch failed (paywall, mismatch).
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

const { isReviewTextFile } = require('./lib/review-text-sidecars');
const fs = require('fs');
const path = require('path');
const { decodeHtmlEntities, hasUndecodedHtmlEntities, hasJsonLdArtifact, cleanText } = require('./lib/text-cleaning');

const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const JSON_OUT = args.includes('--json');

const ENTITY_FIELDS = ['criticName', 'outlet', 'pullQuote', 'excerpt'];
const JSONLD_FIELDS = ['pullQuote', 'excerpt'];

// The strings cleanText's Step 3e removes. Kept to the modal itself so the sweep
// only touches texts that carry player markup.
const VIDEO_MODAL_RE = /Beginning of dialog window\. Escape will cancel|This modal can be closed by pressing the Escape key|\bEnd of dialog window\./i;

function hasVideoPlayerModal(text) {
  return typeof text === 'string' && VIDEO_MODAL_RE.test(text);
}

// cleanText to a fixed point: a modal string can sit between the review and a
// trailing-junk line, so one pass can leave a strippable tail.
function stripVideoPlayerModal(text) {
  let out = text;
  for (let i = 0; i < 5; i++) {
    const next = cleanText(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

function walkShowDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
}

function main() {
  const matches = [];
  let entityFixed = 0, jsonldDropped = 0, modalCleaned = 0;

  for (const showId of walkShowDirs(REVIEW_TEXTS_DIR)) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => isReviewTextFile(f));
    for (const file of files) {
      const filePath = path.join(showDir, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { continue; }

      const entityFields = ENTITY_FIELDS.filter(f => hasUndecodedHtmlEntities(data[f]));
      const jsonldFields = JSONLD_FIELDS.filter(f => hasJsonLdArtifact(data[f]));
      const videoModal = hasVideoPlayerModal(data.fullText);
      if (!entityFields.length && !jsonldFields.length && !videoModal) continue;

      matches.push({ showId, file, entityFields, jsonldFields, videoModal });

      if (FIX) {
        for (const f of entityFields) { data[f] = decodeHtmlEntities(data[f]); entityFixed++; }
        for (const f of jsonldFields) { delete data[f]; jsonldDropped++; }
        if (videoModal) {
          const cleaned = stripVideoPlayerModal(data.fullText);
          // Never let the sweep empty a text: leave it for a refetch instead.
          if (cleaned.length > 0 && cleaned !== data.fullText) { data.fullText = cleaned; modalCleaned++; }
        }
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
    if (m.videoModal) parts.push('video-modal: fullText');
    console.log(`  ${m.showId}/${m.file} — ${parts.join(' | ')}`);
  }

  if (FIX) {
    console.log(`\nApplied: ${entityFixed} entity field(s) decoded, ${jsonldDropped} JSON-LD field(s) dropped, ${modalCleaned} video-modal fullText(s) cleaned. Re-run rebuild.`);
    process.exit(0);
  }
  console.log('\nRun with --fix to clean.');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { hasVideoPlayerModal, stripVideoPlayerModal };
