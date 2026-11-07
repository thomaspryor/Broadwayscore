/**
 * BRO-5128: outletId `british-theatre` covered two publications, British
 * Theatre Guide (britishtheatreguide.info) and BritishTheatre.com
 * (britishtheatre.com), so Paul T Davies / Susan Novak / Mark Ludmon reviews
 * displayed as "British Theatre Guide". The registry now carries a separate
 * `britishtheatrecom` outlet (`splitFrom: british-theatre`). These tests drive
 * the real routing functions with real corpus URLs:
 *   - resolveOutletFromUrl / normalizeOutlet (registry routing)
 *   - createOrMergeReviewFile (the write chokepoint routes by URL host)
 *   - applyUrlEditionCorrection (the rebuild's relabel pass migrates old files,
 *     including flagged/overridden ones the generic publisher-domain pass skips)
 *   - isRoundupUrl (the site's locale-prefixed round-up posts)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const quiet = (fn) => {
  const { warn, log } = console;
  console.warn = () => {}; console.log = () => {};
  try { return fn(); } finally { console.warn = warn; console.log = log; }
};
const { resolveOutletFromUrl, normalizeOutlet, getOutletDisplayName } = quiet(() => require('./review-normalization.js'));
const { createOrMergeReviewFile } = require('./review-file-writer.js');
const { applyUrlEditionCorrection, splitOutletCorrection, misfileHealPlan } = require('./outlet-mismatch-heal.js');
const { isRoundupUrl } = require('./review-guards.js');
const { getTier } = require('./outlet-tiers.js');

// Real URLs from data/review-texts (2026-10-12).
const BTCOM_URLS = [
  'https://www.britishtheatre.com/posts/review-the-twilight-zone-ambassadors-theatre-london',
  'https://www.britishtheatre.com/es/posts/review-glass-kill-imp-royal-court-london',
  'https://www.britishtheatre.com/pt/posts/review-curtains-wyndhams-theatre-london',
  'http://britishtheatre.com/review-the-humans-roundabout-at-laura-pels-theatre-3stars/',
];
const BTG_URL = 'https://www.britishtheatreguide.info/reviews/the-story-royal-court-26003';

test('britishtheatre.com urls resolve to BritishTheatre.com, britishtheatreguide.info to British Theatre Guide', () => {
  for (const url of BTCOM_URLS) {
    assert.equal(quiet(() => resolveOutletFromUrl(url))?.outletId, 'britishtheatrecom', url);
  }
  assert.equal(quiet(() => resolveOutletFromUrl(BTG_URL))?.outletId, 'british-theatre');
  assert.equal(getOutletDisplayName('britishtheatrecom'), 'BritishTheatre.com');
  assert.equal(getOutletDisplayName('british-theatre'), 'British Theatre Guide');
});

test('names route to the right publication', () => {
  for (const name of ['BritishTheatre.com', 'britishtheatrecom', 'britishtheatre-com', 'British Theatre.com',
    'www.britishtheatre.com', 'britishtheatrecom-paul-t-davies']) {
    assert.equal(normalizeOutlet(name), 'britishtheatrecom', name);
  }
  // The bare "British Theatre" names stay on the Guide's id: giving them to
  // britishtheatrecom made 'british-theatre' an ambiguous prefix, so
  // outlet+critic labels fell through to junk ids. The url host decides at write.
  for (const name of ['British Theatre Guide', 'BTG', 'british-theatre', 'britishtheatreguide',
    'British Theatre', 'britishtheatre', 'British Theatre Paul Davies', 'British Theatre | Julian Eaves',
    'british-theatre-mark-ludmon']) {
    assert.equal(normalizeOutlet(name), 'british-theatre', name);
  }
});

test('the alias-collision guard sees no near-duplicate between the two outlets', () => {
  const { findOutletAliasCollisions } = require('./outlet-alias-collision.js');
  const registry = JSON.parse(fs.readFileSync(new URL('../../data/outlet-registry.json', import.meta.url), 'utf8'));
  const hits = findOutletAliasCollisions(registry.outlets, registry._aliasIndex)
    .filter((c) => c.outletIds.includes('britishtheatrecom'));
  assert.deepEqual(hits, []);
});

test('the split keeps the London tier both outlets were scored at', () => {
  assert.equal(getTier('britishtheatrecom', { showCategory: 'west-end' }), 2);
  assert.equal(getTier('british-theatre', { showCategory: 'west-end' }), 2);
});

test('write chokepoint files by url host whatever the outlet label says', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5128-'));
  try {
    const write = (input) => quiet(() => createOrMergeReviewFile(
      'avenue-q-west-end-2026',
      { source: 'serp-discovery', fields: { fullText: 'x'.repeat(500) }, ...input },
      { dryRun: true, reviewTextsDir: dir },
    ));
    const a = write({ outlet: 'British Theatre Guide', criticName: 'Susan Novak', url: BTCOM_URLS[0] });
    assert.equal(path.basename(a.filepath), 'britishtheatrecom--susan-novak.json');
    const b = write({ outlet: 'British Theatre', criticName: 'Howard Loxton', url: BTG_URL });
    assert.equal(path.basename(b.filepath), 'british-theatre--howard-loxton.json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rebuild relabel migrates an old british-theatre file on a britishtheatre.com url', () => {
  // Shape of the-twilight-zone-west-end-2019/british-theatre--mark-ludmon.json:
  // a wrongProduction false positive with an override. The generic
  // publisher-domain pass skips flagged/overridden files; a split must not.
  const data = {
    outletId: 'british-theatre', outlet: 'British Theatre Guide', criticName: 'Mark Ludmon',
    url: BTCOM_URLS[0], wrongProduction: true, wrongProductionOverride: true,
  };
  const fix = quiet(() => applyUrlEditionCorrection(data, '2026-10-12'));
  assert.equal(fix?.reason, 'outlet-split');
  assert.equal(data.outletId, 'britishtheatrecom');
  assert.equal(data.outlet, 'BritishTheatre.com');
  assert.equal(data.wrongProductionOverride, true, 'flags ride along');
});

test('a split file is never handed to the misfile pointer-dropping/folding paths', () => {
  const data = {
    outletId: 'british-theatre', criticName: 'Sophie Adnitt', url: BTCOM_URLS[0],
    duplicateOf: 'british-theatre--mark-ludmon.json',
  };
  const io = { exists: () => true, read: () => ({ url: BTCOM_URLS[0], wrongProduction: true }) };
  // Only the pointer target is excluded: the shape whose pointer the BRO-4411
  // drop-pointer path would strip, letting the duplicate score on its own.
  const explain = (_d, f) => (f === 'british-theatre--mark-ludmon.json' ? 'wrongProduction' : null);
  assert.equal(quiet(() => misfileHealPlan({ data, file: 'british-theatre--sophie-adnitt.json', io, explain })), null);
});

test('relabel leaves British Theatre Guide files, locked files and unsplit outlets alone', () => {
  assert.equal(quiet(() => splitOutletCorrection({ outletId: 'british-theatre', criticName: 'Howard Loxton', url: BTG_URL })), null);
  assert.equal(quiet(() => splitOutletCorrection({ outletId: 'british-theatre', url: BTCOM_URLS[1], _locked: true })), null);
  assert.equal(quiet(() => splitOutletCorrection({ outletId: 'britishtheatrecom', url: BTCOM_URLS[1] })), null);
  // guardian has no splitFrom: an Observer file on theguardian.com is not a split.
  assert.equal(quiet(() => splitOutletCorrection({ outletId: 'observer', url: 'https://www.theguardian.com/stage/2019/mar/10/x' })), null);
});

test('BritishTheatre.com round-up posts are round-ups under every locale prefix and slug spelling', () => {
  for (const url of [
    'https://www.britishtheatre.com/posts/jesus-christ-superstar-palladium-review-round-up',
    'https://www.britishtheatre.com/es/posts/waiting-for-godot-review-roundup',
    'https://www.britishtheatre.com/cs/posts/back-to-the-future-the-musical-review-round-up',
    'https://www.britishtheatre.com/de/posts/rent-tom-stoppard-theatre-reviews-roundup-2026',
  ]) {
    assert.equal(isRoundupUrl(url).isRoundup, true, url);
  }
  for (const url of BTCOM_URLS) assert.equal(isRoundupUrl(url).isRoundup, false, url);
});

test('BritishTheatre.com keeps its host-gated star reader under the new id', () => {
  const { OUTLET_EXTRACTORS, HOST_GATED_STAR_OUTLETS } = require('./score-extractors.js');
  assert.equal(OUTLET_EXTRACTORS.britishtheatrecom, OUTLET_EXTRACTORS['british-theatre']);
  assert.ok(HOST_GATED_STAR_OUTLETS.has('britishtheatrecom'));
});
