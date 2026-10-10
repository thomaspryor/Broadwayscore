/**
 * Tests for scripts/lib/commercial-record-checks.js (BRO-4623): the per-record
 * commercial.json rules shared by validate-data.js and execute-approved-fix.js.
 * Run: node --test scripts/lib/commercial-record-checks.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { commercialRecordErrors, commercialRecordWarnings, commercialFileErrors, commercialFileWarnings, sanitizeForPublicRecord, stripInternalWording } = require('./commercial-record-checks.js');
const { buildTipRecord } = require('./commercial-tip-record.js');
const { undoAutoFizzleOnRunningShow } = require('./classify-stale-closure.js');

const shows = [
  { id: 'hamilton-2015', slug: 'hamilton', venue: 'Richard Rodgers Theatre' },
  { id: 'ragtime-2025', slug: 'ragtime', venue: 'Vivian Beaumont Theater' },
];
const ok = { designation: 'Miracle', recouped: true, recoupedDate: '2016-03', sources: [{ type: 'trade', url: 'https://x.y/a', date: '2016-06-12' }] };

test('a clean record and a clean file have no errors', () => {
  assert.deepEqual(commercialRecordErrors('hamilton', ok, { showRecord: shows[0] }), []);
  assert.deepEqual(commercialFileErrors({ shows: { hamilton: ok } }, shows), []);
});

test('outcome policy: win needs recouped=true, loss needs recouped=false, recouped needs a date', () => {
  const e = (rec) => commercialRecordErrors('k', rec, {});
  assert.equal(e({ designation: 'Windfall', recouped: null }).length, 1);
  assert.equal(e({ designation: 'Flop', recouped: null }).length, 1);
  assert.equal(e({ designation: 'TBD', recouped: true }).length, 1);
  assert.equal(e({ designation: 'TBD', recouped: true, recoupedDate: '2024/01' }).length, 1);
});

test('loss designation on a show that is not closed is a warning, never an error', () => {
  const rec = { designation: 'Flop', recouped: false };
  const w = (status) => commercialRecordWarnings('k', rec, { showRecord: { slug: 'k', status } }).length;
  assert.equal(w('open'), 1);
  assert.equal(w('previews'), 1);
  assert.equal(w('closed'), 0);
  assert.equal(commercialRecordWarnings('k', rec, {}).length, 0);
  assert.equal(commercialRecordWarnings('k', { designation: 'TBD', recouped: false }, { showRecord: { slug: 'k', status: 'open' } }).length, 0);
  // A status flip (update-show-status.js reopening a closed show) must not
  // turn into a validate-data error that blocks the daily status commit.
  assert.equal(commercialRecordErrors('k', rec, { showRecord: { slug: 'k', status: 'open' } }).length, 0);
  const file = { shows: { k: rec } };
  assert.deepEqual(commercialFileErrors(file, [{ slug: 'k', status: 'open' }]), []);
  assert.equal(commercialFileWarnings(file, [{ slug: 'k', status: 'open' }]).length, 1);
});

test('stale-closure Fizzle is undone when the show is running again, hand labels are not', () => {
  const auto = { designation: 'Fizzle', recouped: false, recoupedSource: 'Inferred: closed 40 days ago, no trade-press recoupment found', classifiedBy: 'classify-stale-closures', classifiedAt: 'x', classifiedReason: 'y', capitalization: 5e6 };
  const undone = undoAutoFizzleOnRunningShow(auto, { slug: 'k', status: 'open' });
  assert.equal(undone.designation, 'TBD');
  assert.equal(undone.recouped, null);
  assert.equal(undone.recoupedSource, null);
  assert.equal(undone.classifiedBy, undefined);
  assert.equal(undone.capitalization, 5e6);
  assert.deepEqual(commercialRecordWarnings('k', undone, { showRecord: { slug: 'k', status: 'open' } }), []);
  assert.equal(auto.designation, 'Fizzle', 'input is not mutated');
  assert.equal(undoAutoFizzleOnRunningShow(auto, { slug: 'k', status: 'closed' }), null);
  assert.equal(undoAutoFizzleOnRunningShow(auto, undefined), null);
  assert.equal(undoAutoFizzleOnRunningShow({ ...auto, humanReviewedDesignation: true }, { slug: 'k', status: 'open' }), null);
  assert.equal(undoAutoFizzleOnRunningShow({ designation: 'Fizzle', recouped: false }, { slug: 'k', status: 'open' }), null);
  // No source at all is still the classifier's own inference.
  assert.equal(undoAutoFizzleOnRunningShow({ ...auto, recoupedSource: null }, { slug: 'k', status: 'open' }).designation, 'TBD');
  // A person replaced the inferred source with a citation: leave it to them.
  assert.equal(undoAutoFizzleOnRunningShow({ ...auto, recoupedSource: 'Deadline (Jun 2026): will not recoup' }, { slug: 'k', status: 'open' }), null);
});

test('public text fields reject research-pipeline wording', () => {
  const e = (rec) => commercialRecordErrors('k', rec, {});
  assert.equal(e({ capitalizationSource: 'SEC filings (GPT Deep Research)' }).length, 1);
  assert.equal(e({ capitalizationSource: 'Trade press / deep research synthesis' }).length, 1);
  assert.equal(e({ notes: 'Auto-enrolled stub; awaiting model + curation.' }).length, 1);
  assert.equal(e({ recoupedSource: 'GPT DR Batch 3 consensus' }).length, 1);
  assert.equal(e({ notes: 'Auto-designated from model output.' }).length, 1);
  // Real citations and ordinary prose pass.
  assert.equal(e({ capitalizationSource: 'Broadway Journal (Sep 2023): $19.5M' }).length, 0);
  assert.equal(e({ notes: 'Researched by the cast; a synthesis of jazz and opera.' }).length, 0);
  assert.equal(e({ recoupedSource: 'Deadline (Aug 2023): recouped its $16.5M capitalization' }).length, 0);
  // weeklyRunningCostSource is filtered by the UI, not here.
  assert.equal(e({ weeklyRunningCostSource: 'GPT estimate' }).length, 0);
  // batch-commercial-research.js's reviewer prefix is internal too.
  assert.equal(e({ notes: '[PLAUSIBILITY WARNING: cap above $80M] Big musical.' }).length, 1);
  // Model names, but not a person called Claude.
  assert.equal(e({ capitalizationSource: 'o4-mini estimate' }).length, 1);
  assert.equal(e({ notes: 'Claude Sonnet synthesis of trade reports.' }).length, 1);
  assert.equal(e({ notes: 'AI-estimated running cost.' }).length, 1);
  // The weekly update's context sections (BRO-4666), but not a newspaper section.
  assert.equal(e({ recoupedSource: 'Section F: Deadline reports recoupment' }).length, 1);
  assert.equal(e({ notes: 'Sections C and D: strong word of mouth.' }).length, 1);
  assert.equal(e({ recoupedSource: 'The New York Times, Section C, p. 1' }).length, 0);
  assert.equal(e({ notes: 'See section a: the producers said so.' }).length, 0);
  assert.equal(e({ notes: 'Music by Claude-Michel Schönberg; produced by Cameron Mackintosh.' }).length, 0);
  assert.equal(e({ notes: 'ChatGPT summary of grosses.' }).length, 1);
  assert.equal(e({ capitalizationSource: 'Gemini 2.5 Pro estimate' }).length, 1);
  // Writers store article URLs as sources; a slug is not wording a reader sees.
  assert.equal(e({ recoupedSource: 'https://www.broadwayworld.com/article/gpt-musical-recoups-20260512' }).length, 0);
  assert.equal(e({ recoupedSource: 'GPT summary of https://example.com/a' }).length, 1);
});

test('public text fields reject hand-edit process notes and field names written as code (BRO-4669)', () => {
  const e = (rec) => commercialRecordErrors('k', rec, {});
  // The live wording these records carried before the BRO-4669 plan.
  assert.equal(e({ recoupedSource: 'No producer announcement. Kept recouped:true per owner review 2026-07-13.' }).length, 1);
  assert.equal(e({ recoupedSource: 'Closed after a limited run. recouped:null because no public citation.' }).length, 1);
  assert.equal(e({ notes: 'Total gross ~$15.2M. Per policy applied 2026-05-24: demoted from Flop.' }).length, 1);
  assert.equal(e({ notes: '548 performances. Per policy applied: designation=Nonprofit because no citation.' }).length, 1);
  // Prose with colons and capitals, and URL query strings, pass.
  assert.equal(e({ notes: 'Based on a True story: the 1990s case.' }).length, 0);
  assert.equal(e({ recoupedSource: 'Recouped: Deadline (Aug 2023)' }).length, 0);
  assert.equal(e({ capitalizationSource: 'SEC Form D: https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=D' }).length, 0);
  assert.equal(e({ recoupedSource: 'No recoupment outcome has been announced. The run was extended twice.' }).length, 0);
  // Writers clear the process sentence and keep the rest.
  assert.equal(stripInternalWording('Total gross ~$15.2M. Per policy applied 2026-05-24: recouped:null because no citation.'), 'Total gross ~$15.2M.');
});

test('stripInternalWording keeps the public part of a mixed citation', () => {
  assert.equal(stripInternalWording('SEC filings (GPT Deep Research)'), 'SEC filings');
  assert.equal(stripInternalWording('SEC Form D (Mar 2024): $29M. Previous $20M estimate from Deep Research was too low.'), 'SEC Form D (Mar 2024): $29M.');
  assert.equal(stripInternalWording('Trade press / deep research synthesis'), null);
  assert.equal(stripInternalWording('[PLAUSIBILITY WARNING: cap above $80M] Big musical.'), 'Big musical.');
  assert.equal(stripInternalWording('Deadline (Aug 2023): recouped'), 'Deadline (Aug 2023): recouped');
  assert.equal(stripInternalWording(null), null);
  // Abbreviations and initials do not end a sentence, so no half-citation is left.
  assert.equal(stripInternalWording('Per Jr. St. James approx. $1.5M per GPT.'), null);
  assert.equal(stripInternalWording('Mr. Smith said LLM-based est.'), null);
  assert.equal(stripInternalWording('Opened at the St. James Theatre. Running cost per GPT estimate.'), 'Opened at the St. James Theatre.');
  assert.equal(stripInternalWording('Produced by J. Smith. GPT figures.'), 'Produced by J. Smith.');
  // No dangling separator.
  assert.equal(stripInternalWording('Cap $12.5M [Broadway World, 2024]; GPT estimate of running cost'), 'Cap $12.5M [Broadway World, 2024]');
  // A URL is left as is.
  assert.equal(stripInternalWording('See https://example.com/gpt-review'), 'See https://example.com/gpt-review');
});

test('sanitizeForPublicRecord yields a record the rules accept, and says what it changed', () => {
  const open = { slug: 'k', status: 'open' };
  const raw = { designation: 'Flop', recouped: false, capitalizationSource: 'Trade press / deep research synthesis', notes: 'Limited run (GPT summary).', recoupedSource: 'Variety (May 2026)' };
  assert.ok(commercialRecordErrors('k', raw, { showRecord: open }).length >= 2);
  const { entry, changed, holdReason } = sanitizeForPublicRecord(raw, 'open');
  assert.equal(holdReason, null);
  assert.deepEqual(commercialRecordErrors('k', entry, { showRecord: open }), []);
  assert.deepEqual(commercialRecordWarnings('k', entry, { showRecord: open }), []);
  assert.deepEqual(changed, ['notes', 'capitalizationSource', 'designation']);
  assert.equal(entry.notes, 'Limited run.');
  assert.equal(entry.capitalizationSource, null);
  assert.equal(entry.designation, 'TBD');
  assert.equal(entry.recoupedSource, 'Variety (May 2026)');
  assert.equal(raw.designation, 'Flop', 'input is not mutated');
  // A closed show keeps its loss label; unknown status is left alone too.
  assert.equal(sanitizeForPublicRecord({ designation: 'Fizzle', recouped: false }, 'closed').entry.designation, 'Fizzle');
  assert.equal(sanitizeForPublicRecord({ designation: 'Fizzle', recouped: false }, undefined).entry.designation, 'Fizzle');
  assert.deepEqual(sanitizeForPublicRecord(ok, 'open').changed, []);
  // A citation carrying research wording is research output: cleared, never
  // trimmed to something that reads like a checked source.
  assert.equal(sanitizeForPublicRecord({ capitalizationSource: 'SEC filings (GPT Deep Research)' }, 'open').entry.capitalizationSource, null);
});

test('sanitizeForPublicRecord holds what cleaning would hide', () => {
  // A recoupment claim must keep a public citation.
  assert.match(sanitizeForPublicRecord({ recouped: true, recoupedDate: '2026-05', recoupedSource: 'GPT DR Batch 3 consensus' }, 'open').holdReason, /public source/);
  assert.match(sanitizeForPublicRecord({ recouped: true, recoupedDate: '2026-05', recoupedSource: 'Variety (May 2026) (GPT check)' }, 'open').holdReason, /public source/);
  assert.equal(sanitizeForPublicRecord({ recouped: true, recoupedDate: '2026-05', recoupedSource: 'Variety (May 2026)' }, 'open').holdReason, null);
  // A plausibility-flagged model answer waits for a person instead of landing with the flag erased.
  assert.match(sanitizeForPublicRecord({ notes: '[PLAUSIBILITY WARNING: cap above $80M] Big musical.' }, 'open').holdReason, /plausibility/);
});

test('buildTipRecord cleans a tip, refuses one the rules reject, never mutates', () => {
  const commercial = { shows: { k: { designation: 'TBD', recouped: null, notes: 'Running.' } } };
  const showList = [{ slug: 'k', status: 'open' }];
  const cleaned = buildTipRecord(commercial, showList, 'k', [{ field: 'capitalizationSource', newValue: 'Deadline (Jan 2026) (GPT)' }, { field: 'capitalization', newValue: 9e6, isEstimate: true }]);
  assert.equal(cleaned.refusedReason, null);
  assert.equal(cleaned.record.capitalizationSource, null);
  assert.deepEqual(cleaned.record.isEstimate, { capitalization: true });
  assert.equal(commercial.shows.k.capitalization, undefined, 'commercial.json is not mutated');
  // The changelog gets what was written, not what the model proposed.
  assert.deepEqual(cleaned.changes, [
    { field: 'capitalization', oldValue: null, newValue: 9e6 },
    { field: 'isEstimate', oldValue: null, newValue: { capitalization: true } },
  ]);
  const flop = buildTipRecord(commercial, showList, 'k', [{ field: 'designation', newValue: 'Flop' }, { field: 'recouped', newValue: false }]);
  assert.equal(flop.record.designation, 'TBD');
  assert.deepEqual(flop.changes, [{ field: 'recouped', oldValue: null, newValue: false }]);
  // Windfall without recouped=true breaks the outcome policy.
  assert.match(buildTipRecord(commercial, showList, 'k', [{ field: 'designation', newValue: 'Windfall' }]).refusedReason, /recouped/);
  assert.match(buildTipRecord(commercial, showList, 'missing', [{ field: 'notes', newValue: 'x' }]).refusedReason, /no commercial record/);
  assert.match(buildTipRecord(commercial, showList, 'k', [{ field: 'notes', newValue: 'Running.' }]).refusedReason, /nothing to change/);
});

test('nonprofitOrg is checked against the shows.json venue', () => {
  assert.equal(commercialRecordErrors('ragtime', { designation: 'Nonprofit', nonprofitOrg: 'Lincoln Center Theater' }, { showRecord: shows[1] }).length, 0);
  assert.equal(commercialRecordErrors('ragtime', { designation: 'Nonprofit', nonprofitOrg: 'Manhattan Theatre Club' }, { showRecord: shows[1] }).length, 1);
});

test('sources, costMethodology, productionType and originalProductionId shapes', () => {
  const e = (rec, ctx = {}) => commercialRecordErrors('k', rec, ctx);
  assert.equal(e({ sources: [{ type: 'other', url: 'https://x.y' }] }).length, 1);
  assert.equal(e({ costMethodology: 'guess' }).length, 1);
  assert.equal(e({ productionType: 'weird' }).length, 1);
  assert.equal(e({ originalProductionId: 'nope' }, { allRecords: {} }).length, 1);
  assert.equal(e({ originalProductionId: 'a' }, { allRecords: { a: {} } }).length, 0);
});
