/*
 * Fixture tests for verifyAggregatorUrl (S1-T4).
 *
 * Runs as `node --test tests/unit/show-match-verifier.test.mjs` (per
 * memory/feedback_test_format_node_not_jest.md).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifyAggregatorUrl } = require('../../scripts/lib/show-match-verifier.js');

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const STAGE_CUCKOO_URL =
  'https://www.thestage.co.uk/review-round-ups/one-flew-over-the-cuckoos-nest-at-the-old-vic';
const STAGE_CUCKOO_HTML =
  '<html><head><title>One Flew Over the Cuckoo&#x27;s Nest at the Old Vic — review round-up | The Stage</title></head></html>';

// --- Stage trap: must reject for any non-Cuckoo show -----------------------

test('Stage trap rejects for Hercules (probe)', () => {
  const result = verifyAggregatorUrl({
    url: STAGE_CUCKOO_URL,
    html: STAGE_CUCKOO_HTML,
    show: { id: 'hercules-west-end-2025', title: 'Hercules' },
  });
  assert.equal(result.isValid, false);
  assert.equal(result.rejectReason, 'page-title-mismatch');
});

test('Stage trap rejects for Inter Alia', () => {
  const result = verifyAggregatorUrl({
    url: STAGE_CUCKOO_URL,
    html: STAGE_CUCKOO_HTML,
    show: { id: 'inter-alia-west-end-2025', title: 'Inter Alia' },
  });
  assert.equal(result.isValid, false);
  assert.equal(result.rejectReason, 'page-title-mismatch');
});

test('Stage trap rejects for The Producers', () => {
  const result = verifyAggregatorUrl({
    url: STAGE_CUCKOO_URL,
    html: STAGE_CUCKOO_HTML,
    show: { id: 'the-producers-west-end-2025', title: 'The Producers' },
  });
  assert.equal(result.isValid, false);
  assert.equal(result.rejectReason, 'page-title-mismatch');
});

test('Stage roundup accepted when querying the actual Cuckoo production', () => {
  const result = verifyAggregatorUrl({
    url: STAGE_CUCKOO_URL,
    html: STAGE_CUCKOO_HTML,
    show: { id: 'one-flew-over-the-cuckoos-nest-west-end-2024', title: "One Flew Over the Cuckoo's Nest" },
  });
  assert.equal(result.isValid, true);
});

// --- Valid probe cases ------------------------------------------------------

test('WET evita slug exact match', () => {
  const result = verifyAggregatorUrl({
    url: 'https://www.westendtheatre.com/52805/shows/evita/',
    html: '<html><head><title>Evita — West End Theatre</title></head></html>',
    show: { id: 'evita-west-end-2025', title: 'Evita', venue: 'London Palladium', openingDate: '2025-07-01' },
  });
  assert.equal(result.isValid, true);
  assert.equal(result.confidence, 'high');
});

test('WET hercules slug variant (disneys-hercules-tickets)', () => {
  const result = verifyAggregatorUrl({
    url: 'https://www.westendtheatre.com/211537/shows/disneys-hercules-tickets/',
    html: '<html><head><title>Disney&#x27;s Hercules at the Theatre Royal Drury Lane</title></head></html>',
    show: { id: 'hercules-west-end-2025', title: 'Hercules', venue: 'Theatre Royal Drury Lane' },
  });
  assert.equal(result.isValid, true);
  assert.equal(result.confidence, 'high');
});

test('theatre.reviews evita URL', () => {
  const result = verifyAggregatorUrl({
    url: 'https://theatre.reviews/london/musicals/evita-london-palladium-2025/',
    html: '<html><head><title>Evita at the London Palladium</title></head></html>',
    show: { id: 'evita-west-end-2025', title: 'Evita', venue: 'London Palladium' },
  });
  assert.equal(result.isValid, true);
});

test('Stagedoor inter-alia URL', () => {
  const result = verifyAggregatorUrl({
    url: 'https://stagedoor.com/plays/18862-inter-alia',
    html: null,
    show: { id: 'inter-alia-west-end-2025', title: 'Inter Alia' },
  });
  assert.equal(result.isValid, true);
});

test('BWW UK roundup evita (westend path)', () => {
  const result = verifyAggregatorUrl({
    url: 'https://www.broadwayworld.com/westend/article/Review-Roundup-EVITA-at-London-Palladium-20250701',
    html: '<html><head><title>Review Roundup: EVITA at London Palladium - What Did the Critics Think? | BroadwayWorld</title></head></html>',
    show: { id: 'evita-west-end-2025', title: 'Evita', venue: 'London Palladium', openingDate: '2025-07-01' },
  });
  assert.equal(result.isValid, true);
  assert.equal(result.confidence, 'high');
});

// --- Date-window edge case --------------------------------------------------

test('BWW 2012 Broadway Evita rejected for 2025 WE Evita', () => {
  const result = verifyAggregatorUrl({
    url: 'https://www.broadwayworld.com/article/Review-Roundup-EVITA-on-Broadway-20120415',
    html: '<html><head><title>Review Roundup: EVITA on Broadway - All the Reviews! | BroadwayWorld</title></head></html>',
    show: { id: 'evita-west-end-2025', title: 'Evita', venue: 'London Palladium', openingDate: '2025-07-01' },
  });
  assert.equal(result.isValid, false);
  assert.equal(result.rejectReason, 'date-out-of-window');
});

// --- URL with no significant token match ------------------------------------

test('Random unrelated URL rejected', () => {
  const result = verifyAggregatorUrl({
    url: 'https://www.broadwayworld.com/westend/article/Review-Roundup-HAMILTON-Returns-20250101',
    html: null,
    show: { id: 'evita-west-end-2025', title: 'Evita' },
  });
  assert.equal(result.isValid, false);
  assert.equal(result.rejectReason, 'url-token-mismatch');
});

// --- Holdout validation (S1-T2 fixture) -------------------------------------
//
// Every TR-sourced row in the holdout must pass the verifier. We synthesise
// minimal html (<title>{title} — outlet</title>) since the holdout JSON does
// not store raw HTML. Goal: prevent the verifier from over-rejecting real
// reviews even when only the URL + a basic page-title hint is available.

const HOLDOUT_PATH = path.join(ROOT, 'data', 'audit', 'we-discovery-holdout.json');
const HOLDOUT_SHOW_META = {
  'operation-mincemeat-west-end-2024': {
    title: 'Operation Mincemeat',
    venue: 'Fortune Theatre',
    openingDate: '2023-05-09',
  },
  'hadestown-west-end-2024': {
    title: 'Hadestown',
    venue: 'Lyric Theatre',
    openingDate: '2024-02-22',
  },
};

if (fs.existsSync(HOLDOUT_PATH)) {
  const holdout = JSON.parse(fs.readFileSync(HOLDOUT_PATH, 'utf8'));
  for (const [showId, payload] of Object.entries(holdout.shows)) {
    const meta = HOLDOUT_SHOW_META[showId];
    if (!meta) continue;
    test(`holdout — ${showId} (${payload.reviews.length} reviews) all accept with confidence>=medium`, () => {
      let rejected = 0;
      const rejections = [];
      let lowConf = 0;
      for (const r of payload.reviews) {
        const html = `<html><head><title>${meta.title} review — ${r.outlet || 'outlet'}</title></head><body>Reviewed at ${meta.venue}.</body></html>`;
        const result = verifyAggregatorUrl({
          url: r.url,
          html,
          show: { id: showId, ...meta },
        });
        if (!result.isValid) {
          rejected++;
          rejections.push({ url: r.url, reason: result.rejectReason });
        } else if (result.confidence === 'low') {
          lowConf++;
        }
      }
      assert.equal(rejected, 0, `expected 0 rejections, got ${rejected}: ${JSON.stringify(rejections, null, 2)}`);
      assert.ok(lowConf === 0, `expected 0 low-confidence holdout matches, got ${lowConf}`);
    });
  }
}
