/**
 * verify-bro8324-preview-reviews.test.mjs: the RECHECK-AFTER acceptance command for
 * BRO-8324 (owner decision 2026-11-25: reviews published during previews count).
 *
 * Asserts against LIVE data, not a fixture: after the rebuild that follows the landing,
 * (1) The Afronauts / Rolandcat review (Nov 17, previews from Nov 14) is no longer flagged
 * anticipatory and has its body back, and (2) no file is left flagged by the anticipatory
 * gate that the gate now accepts (a handful may stay flagged by the class-A veto).
 * A red run is the claim being disproven, not a code regression. Skips when the private
 * review texts are not checked out here. Top-level verify-* tests are default-excluded
 * from the unit run (unit-test-collection.js), so a stale-data red never blocks a land.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { isAnticipatoryPreviewPost } = require('./lib/content-filters.js');
const { shouldAutoClearAnticipatoryGrace } = require('./lib/wrong-production-autoclear.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEXTS = process.env.REVIEW_TEXTS_DIR || path.join(HERE, '..', 'data', 'review-texts');
const SHOWS = path.join(HERE, '..', 'data', 'shows.json');
const have = fs.existsSync(TEXTS) && fs.existsSync(SHOWS);
const MAX_VETOED_LEFT = 10;

test('Afronauts Rolandcat review is counted: not flagged, body restored', { skip: !have }, () => {
  const f = path.join(TEXTS, 'the-afronauts-west-end-2026', 'rolandcat--unknown.json');
  if (!fs.existsSync(f)) return;
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.notEqual(d.wrongProductionReason, 'anticipatory_pre_opening_post', 'stale anticipatory flag still set');
  assert.ok(!d.wrongProduction, 'wrongProduction still true');
  assert.ok(d.fullText && d.fullText.length > 300, 'body not restored from wrongFullText');
});

test(`corpus: at most ${MAX_VETOED_LEFT} anticipatory flags the gate now accepts remain`, { skip: !have }, () => {
  const raw = JSON.parse(fs.readFileSync(SHOWS, 'utf8'));
  const shows = new Map((raw.shows || raw).map(s => [s.id, s]));
  const stale = [];
  for (const sid of fs.readdirSync(TEXTS)) {
    const dir = path.join(TEXTS, sid);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    const show = shows.get(sid);
    if (!show || !show.openingDate) continue;
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const txt = fs.readFileSync(path.join(dir, f), 'utf8');
      if (!txt.includes('anticipatory_pre_opening_post')) continue;
      let d; try { d = JSON.parse(txt); } catch { continue; }
      if (!d.publishDate) continue;
      const v = isAnticipatoryPreviewPost(d.publishDate, show.openingDate, d.outletId || null, {
        category: show.category, previewsStartDate: show.previewsStartDate,
        humanReviewedEarlyPublish: d.humanReviewedEarlyPublish === true,
      });
      if (shouldAutoClearAnticipatoryGrace(d, { stillRejected: v.rejected })) stale.push(`${sid}/${f}`);
    }
  }
  assert.ok(stale.length <= MAX_VETOED_LEFT, `${stale.length} stale anticipatory flags remain, e.g. ${stale.slice(0, 5).join(', ')}`);
});
