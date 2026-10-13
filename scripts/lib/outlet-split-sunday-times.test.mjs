/**
 * BRO-5137 (owner decision 2026-10-13): The Sunday Times counts as its own
 * critic vote (outletId `sunday-times`, `splitFrom: times-uk`). Both papers
 * publish on thetimes.co.uk / thetimes.com, so the URL never names the paper:
 * times-uk keeps the domain (declared edition pair) and the edition comes from
 * the stored outlet label, or from the registry's `splitCritics` when the
 * label is only our generic display name. These tests drive the real
 * functions: normalizeOutlet, resolveOutletFromUrl, splitOutletCorrection,
 * createOrMergeReviewFile; plus a parity check that every split outlet gets
 * its parent's star/extractor/tier treatment.
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
const { normalizeOutlet, resolveOutletFromUrl, loadOutletRegistry, validateCriticOutlet, editionFamily } = quiet(() => require('./review-normalization.js'));
const { splitOutletCorrection, isGenericLabel, applyUrlEditionCorrection } = require('./outlet-mismatch-heal.js');
const { createOrMergeReviewFile } = require('./review-file-writer.js');
const { OUTLET_EXTRACTORS, KNOWN_STAR_OUTLETS, HOST_GATED_STAR_OUTLETS } = require('./score-extractors.js');
const { getTier } = require('./outlet-tiers.js');
const { EDITION_PAIRS } = require('./outlet-registry-domain-collisions.js');

// Real urls from data/review-texts (2026-10-13).
const URL_COM = 'https://www.thetimes.com/culture/theatre-dance/article/1536-review-theatre-henry-viii-anne-boleyn-v6hg7frjb';
const URL_CO_UK = 'https://www.thetimes.co.uk/article/a-little-life-review-james-norton-bares-his-soul-in-second-rate-melodrama-n0qhqqxrk';

test('aggregator labels route to the right paper', () => {
  for (const n of ['The Sunday Times', 'Sunday Times', 'Sundaytimes', 'sunday-times', 'sunday-times-quentin-letts']) {
    assert.equal(normalizeOutlet(n), 'sunday-times', n);
  }
  for (const n of ['The Times', 'Times', 'The Times (UK)', 'the-times-uk', 'the-times-clive-davis', 'The Times (Barbican)']) {
    assert.equal(normalizeOutlet(n), 'times-uk', n);
  }
});

test('the shared domain stays with The Times', () => {
  assert.equal(quiet(() => resolveOutletFromUrl(URL_COM))?.outletId, 'times-uk');
  assert.equal(quiet(() => resolveOutletFromUrl(URL_CO_UK))?.outletId, 'times-uk');
  assert.ok(EDITION_PAIRS.some(([a, b]) => a === 'times-uk' && b === 'sunday-times'));
});

test('relabel: explicit Sunday Times label moves; explicit Times label stays', () => {
  const st = (d) => quiet(() => splitOutletCorrection(d))?.outletId ?? null;
  // Shape of oliver-west-end-2024/times-uk--dominic-maxwell.json (2025-01-19).
  assert.equal(st({ outletId: 'times-uk', outlet: 'The Sunday Times', criticName: 'Dominic Maxwell', url: URL_COM }), 'sunday-times');
  assert.equal(st({ outletId: 'times-uk', outlet: 'The Times', criticName: 'Dominic Maxwell', url: URL_COM }), null);
  // Maxwell writes for both papers: a generic label is no evidence either way.
  assert.equal(st({ outletId: 'times-uk', outlet: 'The Times (UK)', criticName: 'Dominic Maxwell', url: URL_COM }), null);
});

test('relabel: generic label moves only for a splitCritics critic', () => {
  const st = (d) => quiet(() => splitOutletCorrection(d))?.outletId ?? null;
  assert.equal(st({ outletId: 'times-uk', outlet: 'The Times (UK)', criticName: 'Quentin Letts', url: URL_CO_UK }), 'sunday-times');
  assert.equal(st({ outletId: 'times-uk', outlet: 'The Times (Barbican)', criticName: 'Quentin Letts' }), 'sunday-times');
  assert.equal(st({ outletId: 'times-uk', outlet: 'The Times (UK)', criticName: 'ChristopherHart' }), 'sunday-times');
  assert.equal(st({ outletId: 'times-uk', outlet: 'The Times', criticName: 'Quentin Letts' }), null, 'explicit Times label wins');
  assert.equal(st({ outletId: 'times-uk', outlet: 'The Times (UK)', criticName: 'Clive Davis' }), null);
  assert.equal(st({ outletId: 'times-uk', outlet: 'Sunday Times', criticName: 'Unknown', _locked: true }), null, '_locked never moves');
  for (const g of ['The Times (UK)', 'the-times-uk', 'The Times U.K.', 'the times (uk)', 'The Times (Barbican)', '']) {
    assert.equal(isGenericLabel(g, 'times-uk'), true, JSON.stringify(g));
  }
  for (const x of ['The Times', 'Times', 'the times', 'The Sunday Times']) {
    assert.equal(isGenericLabel(x, 'times-uk'), false, JSON.stringify(x));
  }
});

test('critic rule applies to new files too: site-search stamps times-uk on every thetimes.com hit', () => {
  const st = (d) => quiet(() => splitOutletCorrection(d))?.outletId ?? null;
  const base = { outletId: 'times-uk', outlet: 'The Times (UK)', criticName: 'Christopher Hart', url: URL_CO_UK };
  assert.equal(st({ ...base, firstSeenAt: '2023-04-02T10:00:00Z' }), 'sunday-times');
  assert.equal(st({ ...base, firstSeenAt: '2026-11-01T10:00:00Z' }), 'sunday-times');
});

test('Sunday Times label variants route to sunday-times', () => {
  for (const n of ['thesundaytimes', 'The Sunday Times (UK)', 'Sunday Times (UK)', 'Sunday Times "']) {
    assert.equal(normalizeOutlet(n), 'sunday-times', n);
  }
});

test('label/critic relabels are not treated as url splits by a later url fix', () => {
  const rec = { outletId: 'times-uk', outlet: 'The Sunday Times', criticName: 'Dominic Maxwell', url: URL_COM };
  const fix = quiet(() => applyUrlEditionCorrection(rec, '2026-10-13'));
  assert.equal(fix.reason, 'outlet-split-label');
  assert.match(rec.outletIdCorrectedReason, /^outlet-split-label: outlet label "The Sunday Times" names sunday-times \(2026-10-13\)$/);
  // review-field-edit's splitRelabelUndo reverses a split only when the reason
  // reads "outlet-split: <current url> resolves to <outletId> (". A label move
  // must never carry that prefix, or a later url fix would undo it.
  assert.ok(!rec.outletIdCorrectedReason.startsWith(`outlet-split: ${rec.url} resolves to ${rec.outletId} (`));
  // The url-host split keeps it (BRO-5128 relies on the undo).
  const bt = { outletId: 'british-theatre', outlet: 'British Theatre Guide', criticName: 'Susan Novak', url: 'https://www.britishtheatre.com/posts/x' };
  quiet(() => applyUrlEditionCorrection(bt, '2026-10-13'));
  assert.ok(bt.outletIdCorrectedReason.startsWith(`outlet-split: ${bt.url} resolves to ${bt.outletId} (`));
});

test('critic-outlet guard treats an edition split as one family, and a cross-domain split as two outlets', () => {
  assert.deepEqual([...editionFamily('sunday-times')].sort(), ['sunday-times', 'times-uk']);
  assert.deepEqual([...editionFamily('times-uk')].sort(), ['sunday-times', 'times-uk']);
  // British Theatre Guide and BritishTheatre.com are two publications.
  assert.deepEqual([...editionFamily('britishtheatrecom')], ['britishtheatrecom']);
  assert.deepEqual([...editionFamily('british-theatre')], ['british-theatre']);
  assert.equal(validateCriticOutlet('Quentin Letts', 'The Sunday Times').isSuspicious, false);
  assert.equal(validateCriticOutlet('Dominic Maxwell', 'The Sunday Times').isSuspicious, false);
  assert.equal(validateCriticOutlet('Clive Davis', 'Variety').isSuspicious, true, 'real misattribution still flagged');
});

test('write chokepoint: a Sunday Times label files under sunday-times, and a re-send as "The Times" merges into it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5137-'));
  try {
    const sid = 'leopoldstadt-west-end-2020';
    const write = (outlet) => quiet(() => createOrMergeReviewFile(sid,
      { outlet, criticName: 'Quentin Letts', url: URL_CO_UK, source: 'westendtheatre', fields: { fullText: 'x'.repeat(600) } },
      { reviewTextsDir: dir }));
    const first = write('The Sunday Times');
    assert.equal(path.basename(first.filepath), 'sunday-times--quentin-letts.json');
    write('The Times');
    assert.deepEqual(fs.readdirSync(path.join(dir, sid)), ['sunday-times--quentin-letts.json'], 'no times-uk duplicate');
    const after = JSON.parse(fs.readFileSync(path.join(dir, sid, 'sunday-times--quentin-letts.json'), 'utf8'));
    assert.equal(after.outletId, 'sunday-times');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every split outlet gets its parent\'s scoring treatment', () => {
  const outlets = loadOutletRegistry().outlets;
  const splits = Object.entries(outlets).filter(([, e]) => e && e.splitFrom);
  assert.ok(splits.length >= 2);
  for (const [child, entry] of splits) {
    const parent = entry.splitFrom;
    assert.ok(outlets[parent], `${child}.splitFrom names a registry outlet`);
    for (const [name, set] of [['KNOWN_STAR_OUTLETS', KNOWN_STAR_OUTLETS], ['HOST_GATED_STAR_OUTLETS', HOST_GATED_STAR_OUTLETS]]) {
      if (set.has(parent)) assert.ok(set.has(child), `${child} missing from ${name} (parent ${parent} is in it)`);
    }
    if (OUTLET_EXTRACTORS[parent]) assert.ok(OUTLET_EXTRACTORS[child], `${child} has no score extractor (parent ${parent} does)`);
    assert.equal(!!entry.isDualMarket, !!outlets[parent].isDualMarket, `${child} isDualMarket differs from ${parent}`);
    assert.equal(entry.region, outlets[parent].region, `${child} region differs from ${parent}`);
    for (const showCategory of ['west-end', 'broadway']) {
      assert.equal(getTier(child, { showCategory }), getTier(parent, { showCategory }), `${child} tier differs from ${parent} on ${showCategory}`);
    }
  }
});
