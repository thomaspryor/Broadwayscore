/**
 * Tests for scripts/lib/commercial-record-checks.js (BRO-4623): the per-record
 * commercial.json rules shared by validate-data.js and execute-approved-fix.js.
 * Run: node --test scripts/lib/commercial-record-checks.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { commercialRecordErrors, commercialRecordWarnings, commercialFileErrors, touchedRecordProblems, commercialFileWarnings, sanitizeForPublicRecord, stripInternalWording } = require('./commercial-record-checks.js');
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

test('a Fizzle or Flop that contradicts the record\'s own returned estimate is a warning (BRO-5602)', () => {
  const closed = { showRecord: { slug: 'k', status: 'closed' } };
  const w = (rec) => commercialRecordWarnings('k', { recouped: false, designationBasis: 'reported-loss', ...rec }, closed)
    .filter((m) => m.includes('% returned (Fizzle is')).length;
  assert.equal(w({ designation: 'Fizzle', estimatedRecoupmentPct: [0, 10] }), 1); // suffs
  assert.equal(w({ designation: 'Fizzle', estimatedRecoupmentPct: [20, 30] }), 1); // call-me-izzy: 25% is under 30
  assert.equal(w({ designation: 'Flop', estimatedRecoupmentPct: [0, 10] }), 0);
  assert.equal(w({ designation: 'Flop', analystRecoupPct: [20, 40] }), 1); // 30% is a Fizzle
  assert.equal(w({ designation: 'Fizzle', analystRecoupPct: [20, 40], estimatedRecoupmentPct: [0, 10] }), 0); // the analyst's range wins
  assert.equal(w({ designation: 'Flop', estimatedRecoupmentPct: 45 }), 1);
  assert.equal(w({ designation: 'Fizzle' }), 0); // no estimate on the record: nothing to contradict
  // Our model counts when its inputs are decent (BRO-5623); thin inputs do not.
  assert.equal(w({ designation: 'Fizzle', modelDataQuality: 'medium', modelReturnedExCreditPct: [-29, -6.2, 15.2] }), 1);
  assert.equal(w({ designation: 'Flop', modelDataQuality: 'medium', modelReturnedExCreditPct: [-29, -6.2, 15.2] }), 0);
  assert.equal(w({ designation: 'Fizzle', modelDataQuality: 'low', modelReturnedExCreditPct: [-29, -6.2, 15.2] }), 0);
  assert.equal(w({ designation: 'Easy Winner', recouped: true, estimatedRecoupmentPct: [0, 10] }), 0);
  assert.equal(commercialRecordErrors('k', { designation: 'Fizzle', recouped: false, designationBasis: 'reported-loss', estimatedRecoupmentPct: [0, 10] }, closed).length, 0);
});

test('a loss label with no estimate is Did Not Recoup, and a Did Not Recoup with one takes its size (BRO-5636)', () => {
  const closed = { showRecord: { slug: 'k', status: 'closed' } };
  const w = (rec) => commercialRecordWarnings('k', { recouped: false, designationBasis: 'reported-loss', ...rec }, closed);
  const noEstimate = (rec) => w(rec).filter((m) => m.includes('has no estimate of how much came back')).length;
  const sized = (rec) => w(rec).filter((m) => m.includes('% returned (Fizzle is')).length;
  assert.equal(noEstimate({ designation: 'Fizzle' }), 1);
  assert.equal(noEstimate({ designation: 'Flop', modelDataQuality: 'low', modelReturnedExCreditPct: [-29, -6.2, 15.2] }), 1); // thin inputs size nothing
  assert.equal(noEstimate({ designation: 'Did Not Recoup' }), 0);
  assert.equal(sized({ designation: 'Did Not Recoup' }), 0);
  assert.equal(sized({ designation: 'Did Not Recoup', estimatedRecoupmentPct: [0, 0] }), 1);
  assert.equal(sized({ designation: 'Did Not Recoup', modelDataQuality: 'medium', modelReturnedExCreditPct: [-29, -6.2, 15.2] }), 1);
  assert.deepEqual(w({ designation: 'Did Not Recoup' }), []);
});

test('Did Not Recoup follows every loss-label rule', () => {
  const closed = { showRecord: { slug: 'k', status: 'closed' } };
  const e = (rec) => commercialRecordErrors('k', rec, closed);
  assert.equal(e({ designation: 'Did Not Recoup', recouped: null }).length, 1, 'needs recouped=false');
  assert.equal(e({ designation: 'Did Not Recoup', recouped: false, designationBasis: 'no-recoupment-announced' }).length, 0);
  const w = (rec, ctx) => commercialRecordWarnings('k', { recouped: false, ...rec }, ctx);
  assert.equal(w({ designation: 'Did Not Recoup' }, closed).filter((m) => /no designationBasis/.test(m)).length, 1);
  assert.equal(w({ designation: 'Did Not Recoup', designationBasis: 'reported-loss' }, { showRecord: { slug: 'k', status: 'open' } })
    .filter((m) => /loss designations are for closed runs/.test(m)).length, 1);
});

test('a field a data plan cleared (null) is absent, not a malformed value (BRO-5602)', () => {
  const rec = { designation: 'Flop', recouped: false, designationBasis: 'reported-loss' };
  const errs = (extra) => commercialRecordErrors('k', { ...rec, ...extra }, { allRecords: { k: rec } });
  assert.deepEqual(errs({ estimatedRecoupmentDate: null, estimatedRecoupmentPct: null, estimatedRecoupmentSource: null }), []);
  assert.deepEqual(errs({ originalProductionId: null }), []);
  assert.equal(errs({ estimatedRecoupmentDate: '2026/02/03' }).length, 1);
  assert.equal(errs({ originalProductionId: 'missing-show' }).length, 1);
});

test('loss designation on a show that is not closed is a warning, never an error', () => {
  const rec = { designation: 'Flop', recouped: false, designationBasis: 'reported-loss', estimatedRecoupmentPct: [0, 10] };
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

test('a source link listed twice is a warning (BRO-5562)', () => {
  const src = (url) => ({ type: 'trade', url, date: '2022-08-23' });
  const repeats = (sources) => commercialRecordWarnings('k', { designation: 'TBD', sources }, {}).filter((m) => m.includes('already listed'));
  assert.equal(repeats([src('https://www.broadwayjournal.com/p/a'), src('https://www.broadwayjournal.com/p/a')]).length, 1);
  assert.match(repeats([src('https://x.test/a'), src('https://x.test/b'), src('https://x.test/a')])[0], /sources\[2\]/);
  assert.equal(repeats([src('https://x.test/a'), src('https://x.test/b')]).length, 0);
  assert.equal(repeats([{ type: 'manual', url: null }, { type: 'manual', url: null }]).length, 0);
  // http/https and a trailing slash are the same link.
  assert.equal(repeats([src('https://x.test/a/'), src('http://x.test/a')]).length, 1);
  // So are www. and utm_ tracking tags; a different query, port or #fragment, or a non-web link, is not.
  assert.equal(repeats([src('https://x.test/a'), src('https://www.x.test/a?utm_source=chatgpt.com')]).length, 1);
  assert.equal(repeats([src('https://x.test/a?id=1&utm_medium=x'), src('https://x.test/a?id=1')]).length, 1);
  assert.equal(repeats([src('https://x.test/a?id=1'), src('https://x.test/a?id=2')]).length, 0);
  assert.equal(repeats([src('https://x.test/#/page1'), src('https://x.test/#/page2')]).length, 0);
  assert.equal(repeats([src('https://x.test:8080/a'), src('https://x.test/a')]).length, 0);
  assert.equal(repeats([src('mailto:press@x.test'), src('https://x.test')]).length, 0);
  // A repeat the record already had does not refuse an unrelated write; a new one does.
  const prior = { designation: 'TBD', sources: [src('https://x.test/a'), src('https://x.test/a')] };
  const warn = (rec) => commercialRecordWarnings('k', rec, { priorRecord: prior }).filter((m) => m.includes('already listed')).length;
  assert.equal(warn({ ...prior, notes: 'new note' }), 0);
  assert.equal(warn({ ...prior, sources: [...prior.sources, src('https://x.test/b'), src('https://x.test/b')] }), 1);
  // A third copy of a link the record already had twice is a new repeat.
  assert.equal(warn({ ...prior, sources: [...prior.sources, src('https://x.test/a')] }), 1);
});

test('an unannounced-recoupment flag needs a source that says so (BRO-5562)', () => {
  const flagWarn = (rec, ctx = {}) => commercialRecordWarnings('k', { designation: 'Windfall', recouped: true, recoupedDate: '2023-11', ...rec }, ctx)
    .filter((m) => m.includes('Not publicly announced')).length;
  const reported = 'BroadwayWorld (Aug 1, 2025): "They recouped their $14.5 million capitalization in November, 2023." https://www.broadwayworld.com/a/';
  // The sweeney-todd-2023 shape: a reported recoupment still flagged.
  assert.equal(flagWarn({ isEstimate: { recouped: true }, recoupedSource: reported }), 1);
  // A source that says why, or no flag, is fine (phantom-of-the-opera-1988, appropriate).
  assert.equal(flagWarn({ isEstimate: { recouped: true }, recoupedSource: 'No public announcement found.' }), 0);
  assert.equal(flagWarn({ isEstimate: { recouped: true }, recoupedSource: 'Counted as recouped as an editorial judgment.' }), 0);
  // The data's own wording for an unannounced recoupment must not refuse a flagged write.
  assert.equal(flagWarn({ isEstimate: { recouped: true }, recoupedSource: 'No recoupment was announced. Inferred from grosses.' }), 0);
  // A newspaper's editorial is not our editorial judgment.
  assert.equal(flagWarn({ isEstimate: { recouped: true }, recoupedSource: 'Variety editorial (Jan 2024): the show recouped.' }), 1);
  assert.equal(flagWarn({ isEstimate: {}, recoupedSource: reported }), 0);
  assert.equal(flagWarn({ recouped: false, isEstimate: { recouped: true }, recoupedSource: reported }), 0);
  // A write that leaves an old flagged source alone does not warn; one that
  // changes the source, or sets the flag, does.
  const prior = { designation: 'Windfall', recouped: true, recoupedDate: '2023-11', isEstimate: { recouped: true }, recoupedSource: 'Trade listing.' };
  assert.equal(flagWarn({ ...prior, notes: 'new note' }, { priorRecord: prior }), 0);
  assert.equal(flagWarn({ ...prior, recoupedSource: reported }, { priorRecord: prior }), 1);
  assert.equal(flagWarn({ ...prior, recoupedSource: 'The producers did not announce it.' }, { priorRecord: prior }), 0);
  assert.equal(flagWarn({ ...prior }, { priorRecord: { ...prior, isEstimate: {} } }), 1);
});

test('a title quoted inside a quote with double marks is a warning (BRO-5549)', () => {
  const doubled = (field, text) => commercialRecordWarnings('k', { designation: 'TBD', [field]: text }, {})
    .filter((m) => m.includes('doubled quotation marks')).length;
  // The printed shapes from the-bands-visit-2017 and the-anarchist-2012.
  assert.equal(doubled('recoupedSource', 'Broadway News (Sep 10, 2018): "“The Band’s Visit” has recouped its $8.75 million capitalization." https://www.broadwaynews.com/a/'), 1);
  assert.equal(doubled('recoupedSource', 'Variety (Dec 19, 2012): "losses sustained from the flop of "The Anarchist,"" https://variety.com/b/'), 1);
  assert.equal(doubled('capitalizationSource', 'a "“b”" c'), 1);
  assert.equal(doubled('weeklyRunningCostSource', 'a "“b”" c'), 1);
  assert.equal(doubled('notes', 'a "“b”" c'), 1);
  assert.equal(doubled('notes', 'an empty curly pair “” here'), 1);
  // A quote ending on a quoted title is the same defect at the other edge.
  assert.equal(doubled('recoupedSource', 'Playbill: "the musical “Six.”" https://playbill.com/c/'), 1);
  // A write is judged on the text it changes: an old value it leaves alone does not refuse it.
  const old = { designation: 'TBD', recoupedSource: 'a "“b”" c' };
  const flagged = (rec, prior) => commercialRecordWarnings('k', rec, { priorRecord: prior }).some((m) => m.includes('doubled quotation marks'));
  assert.equal(flagged({ ...old, notes: 'new note' }, old), false);
  assert.equal(flagged({ ...old, recoupedSource: 'x "“y”" z' }, old), true);
  assert.equal(doubled('recoupedSource', 'Broadway News (Sep 10, 2018): "‘The Band’s Visit’ has recouped its $8.75 million capitalization." https://www.broadwaynews.com/a/'), 0);
  assert.equal(doubled('recoupedSource', 'BroadwayWorld forum (May 24, 2025): the "official" capitalization is $4.9 million'), 0);
  assert.equal(commercialRecordErrors('k', { designation: 'TBD', recoupedSource: 'a "“b”" c' }, {}).filter((m) => m.includes('quotation')).length, 0);
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
  const { entry, changed, holdReason } = sanitizeForPublicRecord(raw, { status: 'open' });
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
  assert.equal(sanitizeForPublicRecord({ designation: 'Fizzle', recouped: false }, { status: 'closed' }).entry.designation, 'Fizzle');
  assert.equal(sanitizeForPublicRecord({ designation: 'Fizzle', recouped: false }, undefined).entry.designation, 'Fizzle');
  assert.deepEqual(sanitizeForPublicRecord(ok, { status: 'open' }).changed, []);
  // A citation carrying research wording is research output: cleared, never
  // trimmed to something that reads like a checked source.
  assert.equal(sanitizeForPublicRecord({ capitalizationSource: 'SEC filings (GPT Deep Research)' }, { status: 'open' }).entry.capitalizationSource, null);
});

test('sanitizeForPublicRecord holds what cleaning would hide', () => {
  // A recoupment claim must keep a public citation.
  assert.match(sanitizeForPublicRecord({ recouped: true, recoupedDate: '2026-05', recoupedSource: 'GPT DR Batch 3 consensus' }, { status: 'open' }).holdReason, /public source/);
  assert.match(sanitizeForPublicRecord({ recouped: true, recoupedDate: '2026-05', recoupedSource: 'Variety (May 2026) (GPT check)' }, { status: 'open' }).holdReason, /public source/);
  assert.equal(sanitizeForPublicRecord({ recouped: true, recoupedDate: '2026-05', recoupedSource: 'Variety (May 2026)' }, { status: 'open' }).holdReason, null);
  // A plausibility-flagged model answer waits for a person instead of landing with the flag erased.
  assert.match(sanitizeForPublicRecord({ notes: '[PLAUSIBILITY WARNING: cap above $80M] Big musical.' }, { status: 'open' }).holdReason, /plausibility/);
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
  // null is how a plan clears it (BRO-5520); a Tour Stop still needs a real type.
  assert.equal(e({ productionType: null }).length, 0);
  assert.equal(e({ designation: 'Tour Stop', productionType: null }).filter((m) => /productionType/.test(m)).length, 1);
  assert.equal(e({ originalProductionId: 'nope' }, { allRecords: {} }).length, 1);
  assert.equal(e({ originalProductionId: 'a' }, { allRecords: { a: {} } }).length, 0);
});

test('a reader tip that sets a loss label gets a designationBasis (BRO-5020 policy B)', () => {
  const commercial = { shows: { k: { designation: 'TBD', recouped: null } } };
  const showList = [{ slug: 'k', status: 'closed', closingDate: '2020-01-05' }];
  const r = buildTipRecord(commercial, showList, 'k', [{ field: 'designation', newValue: 'Did Not Recoup' }, { field: 'recouped', newValue: false }]);
  assert.equal(r.refusedReason, null);
  assert.equal(r.record.designationBasis, 'no-recoupment-announced');
  const r2 = buildTipRecord(commercial, showList, 'k', [{ field: 'designation', newValue: 'Flop' }, { field: 'recouped', newValue: false }, { field: 'estimatedRecoupmentPct', newValue: [0, 10] }, { field: 'designationBasis', newValue: 'reported-loss' }]);
  assert.equal(r2.refusedReason, null);
  assert.equal(r2.record.designationBasis, 'reported-loss');
  // A size with nothing behind it becomes Did Not Recoup (owner 2026-10-18, BRO-5636).
  const r3 = buildTipRecord(commercial, showList, 'k', [{ field: 'designation', newValue: 'Fizzle' }, { field: 'recouped', newValue: false }]);
  assert.equal(r3.refusedReason, null);
  assert.equal(r3.record.designation, 'Did Not Recoup');
});

test('the size check counts only when the write changed the label or the estimate (BRO-5636)', () => {
  const closed = { slug: 'k', status: 'closed' };
  const fizzle = { designation: 'Fizzle', recouped: false, designationBasis: 'reported-loss', modelDataQuality: 'medium', modelReturnedExCreditPct: [20, 40, 60] };
  const drifted = { ...fizzle, modelDataQuality: 'low' };
  const sized = (rec, prior) => commercialRecordWarnings('k', rec, { showRecord: closed, priorRecord: prior }).filter((m) => /no estimate of how much came back|% returned \(Fizzle is/.test(m)).length;
  assert.equal(sized(drifted, undefined), 1, 'validate-data (no prior record) still reports it');
  assert.equal(sized({ ...drifted, notes: 'edited' }, drifted), 0, 'an unrelated edit after the model drifted is not blocked');
  assert.equal(sized({ ...drifted, designation: 'Flop' }, drifted), 1, 'a write that changes the label is checked');
  assert.equal(sized({ ...fizzle, modelDataQuality: 'low' }, fizzle), 1, 'a write that drops the estimate is checked');
});

test('a loss label on silence or an estimate is published as is, however recently the show closed (BRO-6158)', () => {
  const days = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  for (const designationBasis of ['no-recoupment-announced', 'model-estimate', 'reported-loss']) {
    const row = { designation: 'Flop', designationBasis, recouped: false };
    for (const age of [10, 140, 400]) {
      const r = sanitizeForPublicRecord(row, { status: 'closed', closingDate: days(age) });
      assert.equal(r.entry.designation, 'Flop', `${designationBasis} ${age}d`);
      assert.equal(r.entry.designationBasis, designationBasis);
      assert.equal(r.entry.needsLossEvidence, undefined);
      assert.ok(!r.changed.includes('designation'));
    }
  }
  // A loss label on a show that is not closed still becomes TBD.
  assert.equal(sanitizeForPublicRecord({ designation: 'Flop', designationBasis: 'model-estimate' }, { status: 'open' }).entry.designation, 'TBD');
  // A bare status string is refused.
  assert.throws(() => sanitizeForPublicRecord({ designation: 'Flop' }, 'closed'), /shows.json record/);
});

test('a model-estimate designation is our estimate: no recouped flag needed, sized by the model at any quality (BRO-6158)', () => {
  const model = (pct) => ({ modelDataQuality: 'low', modelReturnedExCreditPct: [pct - 5, pct, pct + 5] });
  const rec = (designation, pct, extra = {}) => ({ designation, designationBasis: 'model-estimate', recouped: null, ...model(pct), ...extra });
  const errs = (r) => commercialRecordErrors('x', r);
  const warns = (r) => commercialRecordWarnings('x', r, { showRecord: { status: 'closed' } });
  const bad = (list) => list.filter((m) => /recouped=|designationBasis|returned/.test(m));
  for (const [d, pct] of [['Flop', 10], ['Fizzle', 60], ['Trickle', 110], ['Windfall', 190]]) {
    assert.deepEqual(bad(errs(rec(d, pct))), [], `${d} errors`);
    assert.deepEqual(bad(warns(rec(d, pct))), [], `${d} warnings`);
  }
  // The same rows without the basis keep the old rules.
  assert.ok(errs({ ...rec('Windfall', 190), designationBasis: undefined }).some((m) => /recouped=null/.test(m)));
  assert.ok(errs({ ...rec('Flop', 10), designationBasis: undefined }).some((m) => /recouped=null/.test(m)));
  // An estimate that disagrees with its own figure is still caught, and the basis stays off other tiers.
  assert.ok(warns(rec('Fizzle', 10)).some((m) => /returned/.test(m)));
  assert.ok(warns(rec('Miracle', 190)).some((m) => /non-loss designation/.test(m)));
});

test('a homepage source URL warns; an article or filing URL does not (BRO-5264)', () => {
  const rec = (url) => ({ designation: 'TBD', sources: [{ type: 'trade', url, date: '2026-01-18' }] });
  for (const url of ['https://www.amny.com', 'https://www.sec.gov/', 'http://broadwaynews.com']) {
    assert.ok(commercialRecordWarnings('x', rec(url)).some((m) => /sources\[0\]\.url .* is a homepage/.test(m)), url);
  }
  for (const url of ['https://www.amny.com/entertainment/theater/broadway-hells-kitchen-to-close/', 'https://www.sec.gov/Archives/edgar/data/1730694/000173069418000001/0001730694-18-000001-index.htm', 'https://deadline.com/?p=1236684055']) {
    assert.ok(!commercialRecordWarnings('x', rec(url)).some((m) => /homepage/.test(m)), url);
  }
  assert.ok(commercialRecordWarnings('x', rec('https://broadwayscorecard.com/show/hells-kitchen')).some((m) => /this site/.test(m)));
  // The bare site gets the own-site message, not the homepage one.
  assert.ok(commercialRecordWarnings('x', rec('https://broadwayscorecard.com')).some((m) => /this site/.test(m)));
  // A writer passes the record as it stood: a link already there does not block the write.
  const old = rec('https://www.amny.com');
  assert.ok(!commercialRecordWarnings('x', { ...old, notes: 'edited' }, { priorRecord: old }).some((m) => /homepage/.test(m)));
  const added = { ...old, sources: [...old.sources, { type: 'trade', url: 'https://playbill.com', date: '2026-01-01' }] };
  assert.deepEqual(commercialRecordWarnings('x', added, { priorRecord: old }).filter((m) => /homepage/.test(m)).map((m) => m.match(/sources\[(\d)\]/)[1]), ['1']);
});

test('a Wikipedia source URL warns, only when the write adds it (BRO-5268)', () => {
  const rec = (url) => ({ designation: 'TBD', sources: [{ type: 'trade', url, date: '2026-01-02' }] });
  for (const url of ['https://en.wikipedia.org/wiki/I_Need_That', 'http://en.m.wikipedia.org/wiki/Liberation_(play)', 'https://wikipedia.org']) {
    assert.ok(commercialRecordWarnings('x', rec(url)).some((m) => /sources\[0\]\.url .* is Wikipedia/.test(m)), url);
  }
  // A page that only mentions Wikipedia in its path is not Wikipedia.
  assert.ok(!commercialRecordWarnings('x', rec('https://www.broadwayjournal.com/p/wikipedia-and-broadway')).some((m) => /Wikipedia/.test(m)));
  const old = rec('https://en.wikipedia.org/wiki/I_Need_That');
  assert.ok(!commercialRecordWarnings('x', { ...old, notes: 'edited' }, { priorRecord: old }).some((m) => /Wikipedia/.test(m)));
});

test('a tip on a record with an old homepage link is not refused for it; a tip adding one is (BRO-5264)', () => {
  const commercial = { shows: { k: { designation: 'TBD', recouped: null, notes: 'Running.', sources: [{ type: 'trade', url: 'https://broadwaynews.com', date: '2021-12-01' }] } } };
  const showList = [{ slug: 'k', status: 'open' }];
  assert.equal(buildTipRecord(commercial, showList, 'k', [{ field: 'capitalization', newValue: 9e6 }]).refusedReason, null);
  const adds = buildTipRecord(commercial, showList, 'k', [{ field: 'sources', newValue: [...commercial.shows.k.sources, { type: 'trade', url: 'https://playbill.com/', date: '2026-01-01' }] }]);
  assert.match(adds.refusedReason || '', /homepage/);
});

// BRO-5264 retro-review (BRO-5261)
test('placeholder links: subdomains of this site, homepage variants, Wikipedia mirrors and ports', () => {
  const rec = (url) => ({ designation: 'TBD', sources: [{ type: 'trade', url, date: '2026-01-18' }] });
  const kind = (url) => commercialRecordWarnings('x', rec(url)).join(' ');
  assert.match(kind('https://beta.broadwayscorecard.com/show/x'), /this site/);
  for (const url of ['https://www.playbill.com/?', 'https://www.sec.gov/#', 'https://www.playbill.com/index.html']) assert.match(kind(url), /homepage/, url);
  for (const url of ['https://en.wikipedia.org:443/wiki/X', 'https://www.wikiwand.com/en/articles/X']) assert.match(kind(url), /Wikipedia/, url);
  assert.doesNotMatch(kind('https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=1730694'), /homepage/);
});

test('prior links: whitespace changes do not warn, a second entry on an old placeholder does', () => {
  const old = { designation: 'TBD', sources: [{ type: 'trade', url: 'https://www.amny.com ', date: '2026-01-18' }] };
  const trimmed = { ...old, sources: [{ ...old.sources[0], url: 'https://www.amny.com' }] };
  assert.ok(!commercialRecordWarnings('x', trimmed, { priorRecord: old }).some((m) => /homepage/.test(m)));
  const reused = { ...old, sources: [...old.sources, { type: 'trade', url: 'https://www.amny.com', date: '2026-10-12', excerpt: 'investors got back 55%' }] };
  assert.deepEqual(commercialRecordWarnings('x', reused, { priorRecord: old }).filter((m) => /homepage/.test(m)).map((m) => m.match(/sources\[(\d)\]/)[1]), ['1']);
});

// BRO-5517: "Old Friends Broadway LP" (Merrily We Roll Along's offering) was cited as the Sondheim revue's capitalization.
test('a Nonprofit record citing an SEC filing warns; a commercial one or a non-SEC host does not', () => {
  const rec = (designation, url) => ({ designation, recouped: null, sources: [{ type: 'sec', url, date: '2024-06-18' }] });
  const nonprofitSec = (r) => commercialRecordWarnings('x', r).filter((m) => /Nonprofit but cites an SEC filing/.test(m));
  assert.equal(nonprofitSec(rec('Nonprofit', 'https://www.sec.gov/Archives/edgar/data/1977214/000197721424000001/xslFormDX01/primary_doc.xml')).length, 1);
  assert.equal(nonprofitSec(rec('Nonprofit', 'https://efts.sec.gov/LATEST/search-index?q=x')).length, 1);
  assert.equal(nonprofitSec(rec('TBD', 'https://www.sec.gov/Archives/edgar/data/1/2/primary_doc.xml')).length, 0);
  assert.equal(nonprofitSec(rec('Nonprofit', 'https://www.notsec.gov/x')).length, 0);
  assert.equal(nonprofitSec({ designation: 'Nonprofit' }).length, 0);
});

test('an estimated recoupment date needs the flag, and the flag needs a source that says so (BRO-5568)', () => {
  const warn = (rec, ctx = {}) => commercialRecordWarnings('k', { designation: 'Miracle', recouped: true, recoupedDate: '1997-03', ...rec }, ctx)
    .filter((m) => m.includes('isEstimate.recoupedDate')).length;
  const chicago = 'New York Theatre Guide: Chicago earned back its $2.5 million cost. No public report gives the date; March 1997 is our estimate.';
  const lion = 'Reported by Broadway Journal; the 1999 date is an estimate.';
  const reported = 'Playbill (Mar 19, 2024) reported the revival "recouped its original investment," per the producers announcement.';
  // The chicago and the-lion-king shapes: source says estimate, flag missing.
  assert.equal(warn({ recoupedSource: chicago }), 1);
  assert.equal(warn({ recoupedDate: '1999', recoupedSource: lion }), 1);
  // The appropriate shape: dated by our editorial judgment.
  assert.equal(warn({ recoupedDate: '2024-06', recoupedSource: 'No recoupment was announced. Counted as recouped as an editorial judgment, dated to the commercial run final month.' }), 1);
  // Flagged and says so, or reported with no flag: fine.
  assert.equal(warn({ recoupedSource: chicago, isEstimate: { recoupedDate: true } }), 0);
  assert.equal(warn({ recoupedSource: reported }), 0);
  // Flag on a reported date.
  assert.equal(warn({ recoupedSource: reported, isEstimate: { recoupedDate: true } }), 1);
  // A write that leaves an old unflagged record alone does not warn; one that changes the source does.
  const prior = { designation: 'Miracle', recouped: true, recoupedDate: '1997-03', recoupedSource: chicago };
  assert.equal(warn({ ...prior, notes: 'new note' }, { priorRecord: prior }), 0);
  assert.equal(warn({ ...prior, recoupedSource: chicago + ' Also in Variety.' }, { priorRecord: prior }), 1);
});

test('a reported-methodology weekly cost needs a weeklyRunningCostSource (BRO-5838)', () => {
  const warn = (rec) => commercialRecordWarnings('k', { designation: 'Miracle', recouped: true, recoupedDate: '2016-03', weeklyRunningCost: 600000, ...rec })
    .filter((m) => m.includes('no weeklyRunningCostSource')).length;
  for (const m of ['trade-reported', 'sec-filing', 'producer-confirmed']) assert.equal(warn({ costMethodology: m }), 1);
  assert.equal(warn({ costMethodology: 'trade-reported', weeklyRunningCostSource: '  ' }), 1);
  assert.equal(warn({ costMethodology: 'trade-reported', weeklyRunningCostSource: 'Broadway Journal (Mar 2024): "$600K a week"' }), 0);
  assert.equal(warn({ costMethodology: 'industry-estimate' }), 0);
  assert.equal(warn({ costMethodology: 'reddit-standard' }), 0);
  assert.equal(warn({ costMethodology: 'trade-reported', weeklyRunningCost: undefined }), 0);
});

test('a stored record with no designation, or a non-canonical one, is a file error (BRO-5824)', () => {
  const { designation, ...noLabel } = ok;
  assert.ok(commercialFileErrors({ shows: { hamilton: noLabel } }, shows).some(e => /invalid designation "missing"/.test(e)));
  assert.ok(commercialFileErrors({ shows: { hamilton: { ...ok, designation: 'Hit' } } }, shows).some(e => /invalid designation "Hit"/.test(e)));
  assert.deepEqual(commercialFileErrors({ shows: { hamilton: { ...noLabel, designation: 'TBD', recouped: null } } }, shows).filter(e => /designation/.test(e)), []);
});

test('a plan that writes a record with no designation fails its touched-record check (BRO-5824 review)', () => {
  const { designation, ...noLabel } = ok;
  assert.ok(touchedRecordProblems({ shows: { hamilton: { ...noLabel, designation: null } } }, shows, ['hamilton'], {}).some(e => /invalid designation "missing"/.test(e)));
  assert.ok(!touchedRecordProblems({ shows: { hamilton: ok } }, shows, ['hamilton'], {}).some(e => /invalid designation/.test(e)));
});

test('ourEstimateRangePct: shape, rounding to 5 and no use on a recouped show (BRO-6245)', () => {
  const e = (rec) => commercialRecordErrors('k', { designation: 'Fizzle', recouped: false, designationBasis: 'reported-loss', ...rec }, {})
    .filter((m) => m.includes('ourEstimateRangePct')).length;
  assert.equal(e({ ourEstimateRangePct: [10, 30] }), 0);
  assert.equal(e({ ourEstimateRangePct: [10] }), 1);
  assert.equal(e({ ourEstimateRangePct: [30, 10] }), 1);
  assert.equal(e({ ourEstimateRangePct: [12, 30] }), 1);
  assert.equal(e({ ourEstimateRangePct: [10, 30], analystRecoupPct: [10, 20] }), 1);
  assert.equal(e({ ourEstimateRangePct: [10, 30], estimatedRecoupmentPct: [10, 20] }), 1);
  assert.equal(e({ designation: 'Windfall', recouped: true, recoupedDate: '2024-01', ourEstimateRangePct: [100, 120] }), 1);
});

test('ourEstimateRangePct sizes a model-estimate Fizzle/Flop like the analyst range (BRO-6245)', () => {
  const closed = { showRecord: { slug: 'k', status: 'closed' } };
  const w = (rec) => commercialRecordWarnings('k', { recouped: false, designationBasis: 'model-estimate', ...rec }, closed)
    .filter((m) => m.includes('% returned (Fizzle is')).length;
  assert.equal(w({ designation: 'Flop', ourEstimateRangePct: [30, 50] }), 1);
  assert.equal(w({ designation: 'Fizzle', ourEstimateRangePct: [30, 50] }), 0);
});
