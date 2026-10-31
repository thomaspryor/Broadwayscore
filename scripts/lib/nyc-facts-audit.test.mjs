import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nyc = require('./nyc-facts-audit.js');
const fc = require('./fact-check-sample.js');

const ob = (id, extra = {}) => ({ id, title: id, category: 'off-broadway', market: 'broadway', status: 'closed', previewsStartDate: '2024-01-10', openingDate: '2024-01-25', venue: 'Lucille Lortel Theatre', ...extra });

test('cohort: NYC rows since 2021-06-01 plus everything current; no West End, no older closed rows', () => {
  assert.equal(nyc.isNycFactsRow(ob('a')), true);
  assert.equal(nyc.isNycFactsRow(ob('old', { previewsStartDate: '2019-01-01', openingDate: '2019-02-01' })), false);
  assert.equal(nyc.isNycFactsRow(ob('ann', { status: 'announced', previewsStartDate: null, openingDate: null })), true);
  assert.equal(nyc.isNycFactsRow({ ...ob('we'), category: 'west-end' }), false);
  assert.ok(fc.COHORTS['nyc-facts'], 'registered on the harness');
});

test('strata: current first, then OB backfilled / recent, then Broadway', () => {
  assert.equal(nyc.nycStratum(ob('a', { status: 'open' })), 'current-upcoming');
  assert.equal(nyc.nycStratum(ob('b', { tags: ['historical'] })), 'ob-backfilled');
  assert.equal(nyc.nycStratum(ob('c')), 'ob-recent');
  assert.equal(nyc.nycStratum({ ...ob('d'), category: 'broadway' }), 'bway-recent');
});

test('equal allocation samples every stratum evenly; default allocation is unchanged', () => {
  const rows = [...Array(80)].map((_, i) => ob(`r${i}`)).concat([...Array(5)].map((_, i) => ob(`h${i}`, { tags: ['historical'] })), [...Array(30)].map((_, i) => ob(`o${i}`, { status: 'open' })));
  const s = fc.drawSample(rows, 'nyc-facts', 12, 6489);
  assert.equal(s.n, 12);
  assert.equal(s.strata['ob-backfilled'].sampled, 4);
  assert.equal(s.strata['ob-recent'].sampled, 4);
  assert.equal(s.strata['current-upcoming'].sampled, 4);
  const prop = fc.stratifiedSample(rows, nyc.nycStratum, 12, 1);
  assert.equal(prop.filter((r) => r.stratum === 'ob-recent').length, 8, 'proportional stays the default');
  assert.equal(fc.drawSample(rows, 'nyc-facts', 500, 6489).n, rows.length, 'n >= population takes every row (capped strata pass their quota on)');
  assert.equal(fc.drawSample(rows, 'nyc-facts', 60, 6489).strata['ob-backfilled'].sampled, 5);
});

test('prompt never shows the stored venue, category, dates, type or revival flag', () => {
  const show = ob('p', { title: 'Kenrex', venue: 'Lucille Lortel Theatre', type: 'play', isRevival: false });
  const p = nyc.buildNycFactPrompt(show, '2026-10-29');
  assert.match(p, /"Kenrex"/);
  assert.match(p, /around 2024/);
  for (const leak of ['Lucille Lortel', '2024-01-10', '2024-01-25']) assert.ok(!p.includes(leak), leak);
  assert.match(nyc.buildNycFactPrompt(ob('q', { previewsStartDate: null, openingDate: null, status: 'announced' }), '2026-10-29'), /currently announced or running/);
});

test('venue compare tells stages apart and accepts reordered or less specific names', () => {
  assert.equal(nyc.compareNycVenue('Atlantic Theater Company - Linda Gross Theater', 'Linda Gross Theater (Atlantic Theater Company)'), 'agree');
  assert.equal(nyc.compareNycVenue('Playwrights Horizons Mainstage', 'Peter Jay Sharp Theater at Playwrights Horizons'), 'disagree');
  assert.equal(nyc.compareNycVenue('Pershing Square Signature Center', 'The Irene Diamond Stage at the Pershing Square Signature Center'), 'less-specific');
  assert.equal(nyc.compareNycVenue('Irene Diamond Stage, Pershing Square Signature Center', 'Pershing Square Signature Center'), 'agree');
  assert.equal(nyc.compareNycVenue('Lucille Lortel Theatre', 'Minetta Lane Theatre'), 'disagree');
  // sameVenue's per-part match would call these the same room; the NYC compare must not.
  assert.equal(fc.sameVenue('Playwrights Horizons, Mainstage', 'Playwrights Horizons, Peter Jay Sharp Theater', 'broadway'), true);
  assert.equal(nyc.compareNycVenue('Playwrights Horizons, Mainstage', 'Playwrights Horizons, Peter Jay Sharp Theater'), 'disagree');
});

test('tier and revival compare against what the site shows', () => {
  const s = ob('t', { tags: ['revival'] });
  assert.equal(nyc.nycCompareField('tier', s, 'Off-Broadway'), 'agree');
  assert.equal(nyc.nycCompareField('tier', s, 'Broadway'), 'disagree');
  assert.equal(nyc.nycCompareField('tier', s, 'Off-Off-Broadway'), 'agree', 'OOB is filed under off-broadway by design (BRO-2485)');
  assert.equal(nyc.nycCompareField('revival', s, 'revival'), 'agree', 'tags revival counts, as in engine.ts');
  assert.equal(nyc.nycCompareField('revival', ob('n'), 'new'), 'agree');
  assert.equal(nyc.nycCompareField('openingNight', ob('d'), '2024-02-05'), 'disagree');
  assert.equal(nyc.nycCompareField('openingNight', ob('d'), '2024-01-25'), 'agree');
});

test('tier page support: an Off-Broadway page does not support a Broadway answer', () => {
  const obPage = 'The Off-Broadway premiere opens at the Lortel.';
  assert.equal(nyc.nycPageSupports(obPage, 'Off-Broadway', 'tier'), true);
  assert.equal(nyc.nycPageSupports(obPage, 'Broadway', 'tier'), false);
  assert.equal(nyc.nycPageSupports('Now on Broadway at the Hayes', 'Broadway', 'tier'), true);
  assert.equal(nyc.nycPageSupports('An Off-Off-Broadway show', 'Off-Broadway', 'tier'), false);
  assert.equal(nyc.nycPageSupports('the first major revival since 1998', 'revival', 'revival'), true);
  assert.equal(nyc.nycPageSupports('the world premiere of a new play', 'new', 'revival'), true);
  assert.equal(nyc.nycPageSupports('moved to the Minetta Lane Theatre', { theatre: 'Minetta Lane Theatre' }, 'run'), true);
});

test('triageField with the cohort impl uses NYC comparisons (stage mismatch -> adjudicate)', () => {
  const show = ob('s', { venue: 'Playwrights Horizons, Mainstage' });
  const checks = [{ checker: 'gemini', answer: { theatre: { value: 'Playwrights Horizons, Peter Jay Sharp Theater', source: 'https://x' } }, support: { theatre: true } }];
  assert.equal(fc.triageField('theatre', show, checks, 'broadway').status, 'ok', 'default impl is unchanged');
  assert.equal(fc.triageField('theatre', show, checks, 'broadway', nyc.NYC_COHORT).status, 'adjudicate');
});

test('other runs: a declared priorRun or a same-title sibling is present; anything else is missing', () => {
  const show = ob('kramer', { title: 'Kramer', venue: "St. Ann's Warehouse", priorRuns: [{ venue: 'NYU Skirball', openingDate: '2026-02-01' }] });
  const sib = ob('kramer-2', { title: 'Kramer', venue: 'Minetta Lane Theatre' });
  const mk = (theatre) => [{ checker: 'openai', answer: { otherRuns: { value: [{ theatre, began: '2026-02', relation: 'earlier run' }], source: 'https://x' } }, support: { otherRuns: true } }];
  assert.equal(nyc.otherRunsTriage(show, [show, sib], mk('NYU Skirball')).status, 'ok');
  assert.equal(nyc.otherRunsTriage(show, [show, sib], mk('Minetta Lane Theatre')).runs[0].siblingId, 'kramer-2');
  assert.equal(nyc.otherRunsTriage(show, [show, sib], mk('New York Theatre Workshop')).status, 'adjudicate');
  assert.equal(nyc.otherRunsTriage(show, [show], mk("St. Ann's Warehouse")).runs.length, 0, 'own theatre is the row itself');
});

test('consistency findings: free checks catch the classes the probe found', () => {
  const rows = [
    ob('same', { previewsStartDate: '2026-02-05', openingDate: '2026-02-05' }),
    { ...ob('bw'), category: 'broadway', venue: 'Lucille Lortel Theatre' },
    ob('obbw', { venue: 'Hayes Theater' }),
    ob('stale', { status: 'previews', previewsStartDate: '2026-09-01', openingDate: '2026-09-10', closingDate: '2026-10-01' }),
    ob('tba', { status: 'announced', venue: null, previewsStartDate: null, openingDate: null }),
  ];
  const cls = (id) => nyc.consistencyFindings(rows, '2026-10-29').filter((f) => f.id === id).map((f) => f.class);
  assert.deepEqual(cls('same'), ['preview-equals-opening']);
  assert.deepEqual(cls('bw'), ['broadway-not-registry']);
  assert.deepEqual(cls('obbw'), ['ob-at-broadway-house']);
  assert.deepEqual(cls('stale'), ['status-vs-dates']);
  assert.deepEqual(cls('tba'), ['venue-missing']);
});

test('type compare covers opera and special (the default fold calls opera a musical and has no special)', () => {
  assert.equal(nyc.nycCompareField('type', ob('o', { type: 'opera' }), 'opera'), 'agree');
  assert.equal(nyc.nycCompareField('type', ob('r', { type: 'musical' }), 'rock opera'), 'agree');
  assert.equal(nyc.nycCompareField('type', ob('s', { type: 'special' }), 'other'), 'agree');
  assert.equal(nyc.nycCompareField('type', ob('m', { type: 'special' }), 'magic show'), 'agree');
  assert.equal(nyc.nycCompareField('type', ob('p', { type: 'play' }), 'musical'), 'disagree');
  assert.match(nyc.buildNycFactPrompt(ob('q'), '2026-10-29'), /transferring from another theatre is new, not a revival/);
});

test('revival follows the row tier: an Off-Broadway premiere before Broadway is new on a Broadway row', () => {
  const bw = { ...ob('brc'), category: 'broadway', isRevival: false };
  assert.equal(nyc.nycCompareField('revival', bw, 'Off-Broadway revival'), 'agree');
  assert.equal(nyc.nycCompareField('revival', bw, 'Broadway revival'), 'disagree');
  assert.equal(nyc.nycCompareField('revival', ob('orl'), 'Off-Broadway revival'), 'disagree', 'OB rows count any earlier NYC staging');
  assert.equal(nyc.nycPageSupports('Common making his Broadway debut', 'new', 'revival'), false, 'an actor debut is not support');
  assert.equal(nyc.nycCompareField('type', ob('cm', { type: 'special' }), 'comedy magic show'), 'agree');
  assert.match(nyc.buildNycFactPrompt(ob('q'), '2026-10-29'), /Broadway revival = a new staging of a work that already had an earlier Broadway production/);
});

test('playbillVerdict: wrong only when Playbill and a checker agree on the other value', () => {
  const pb = (parsed, extra = {}) => ({ result: 'mismatch', venueCheck: 'match', playbillUrl: 'https://playbill.com/production/x', parsed, ...extra });
  const s = ob('d', { closingDate: '2024-03-01', type: 'play' });
  assert.equal(nyc.playbillVerdict('openingNight', s, ['2024-01-25'], pb({ dates: { openingDate: '2024-01-25' } })).verdict, 'correct');
  const w = nyc.playbillVerdict('openingNight', s, ['2024-02-01', null], pb({ dates: { openingDate: '2024-02-01' } }));
  assert.deepEqual([w.verdict, w.correctValue], ['wrong', '2024-02-01']);
  assert.equal(nyc.playbillVerdict('openingNight', s, ['2024-02-03'], pb({ dates: { openingDate: '2024-02-01' } })).verdict, 'unverifiable', 'Playbill alone is a conflict');
  assert.equal(nyc.playbillVerdict('openingNight', s, ['2024-02-01'], pb({ dates: { openingDate: '2024-02-01' } }, { venueCheck: 'mismatch' })), null, 'another production page settles nothing');
  assert.equal(nyc.playbillVerdict('closing', ob('o', { status: 'open', closingDate: '2026-12-01' }), ['2027-01-01'], pb({ dates: { closingDate: '2027-01-01' } })), null, 'a closing still to come');
  assert.equal(nyc.playbillVerdict('type', s, ['Musical'], pb({ tagLine: { showType: 'musical' } })).verdict, 'wrong');
  assert.equal(nyc.playbillVerdict('type', ob('sp', { type: 'special' }), ['play'], pb({ tagLine: { showType: 'play' } })), null, 'Playbill has no special label');
  assert.equal(nyc.playbillVerdict('revival', s, ['Off-Broadway revival'], pb({ tagLine: { revivalStatus: 'revival' } })).verdict, 'wrong');
  assert.equal(nyc.playbillVerdict('revival', ob('r', { isRevival: true }), ['new'], pb({ tagLine: { revivalStatus: 'original' } })), null, 'OB original does not follow the any-earlier-NYC rule');
  assert.equal(nyc.playbillVerdict('tier', s, ['Broadway'], pb({})), null);
});

test('pagesVerdict: two sites stating the same other value is wrong; an unsupported contrary answer leaves the row correct', () => {
  const s = ob('p');
  const D = (cmp, value, source, supported, checker = 'gemini') => ({ checker, cmp, value, source, supported });
  const w = nyc.pagesVerdict('openingNight', s, [D('disagree', '2024-02-01', 'https://www.playbill.com/a', true), D('disagree', '2024-02-01', 'https://theatermania.com/b', true, 'openai')]);
  assert.deepEqual([w.verdict, w.correctValue], ['wrong', '2024-02-01']);
  assert.equal(nyc.pagesVerdict('openingNight', s, [D('disagree', '2024-02-01', 'https://playbill.com/a', true), D('disagree', '2024-02-01', 'https://www.playbill.com/b', true, 'openai')]), null, 'one site is not two');
  assert.equal(nyc.pagesVerdict('openingNight', s, [D('disagree', '2024-02-01', 'https://a.com', true), D('disagree', '2024-02-02', 'https://b.com', true, 'openai')]), null);
  assert.equal(nyc.pagesVerdict('openingNight', s, [D('agree', '2024-01-25', 'https://a.com', true), D('disagree', '2024-02-02', 'https://b.com', false, 'openai')]).verdict, 'correct');
  assert.equal(nyc.pagesVerdict('openingNight', s, [D('agree', '2024-01-25', 'https://a.com', true), D('disagree', '2024-02-02', 'https://b.com', true, 'openai')]), null, 'two supported answers conflict');
  assert.equal(nyc.pagesVerdict('openingNight', s, [D('disagree', '2024-09-01', 'https://a.com', true), D('disagree', '2024-09-01', 'https://b.com', true, 'openai')]), null, 'months off is another production, not an auto-wrong');
  assert.equal(nyc.pagesVerdict('theatre', ob('t', { venue: 'Minskoff Theatre' }), [D('disagree', 'New Amsterdam Theatre', 'https://a.com', true), D('disagree', 'New Amsterdam Theatre', 'https://b.com', true, 'openai')]), null, 'venue never auto-wrong');
  assert.equal(nyc.pagesVerdict('type', ob('t', { type: 'play' }), [D('disagree', 'Musical', 'https://a.com', true), D('disagree', 'musical', 'https://b.com', true, 'openai')]).verdict, 'wrong');
});

test('playbillVerdict: never overrides a person, a future closing, another year or a months-off date', () => {
  const pb = (parsed, extra = {}) => ({ result: 'mismatch', venueCheck: 'match', playbillUrl: 'https://playbill.com/production/x', parsed, ...extra });
  const open = (d, extra) => pb({ dates: { openingDate: d }, ...extra });
  // Grey House: humanCorrectedOpeningDate pinned 05-30; the production page said 06-06
  const grey = ob('grey-house-2023', { openingDate: '2023-05-30', previewsStartDate: '2023-04-29', humanCorrectedOpeningDate: '2023-05-30', openingDateSource: 'human-correction' });
  assert.equal(nyc.playbillVerdict('openingNight', grey, ['2023-06-06'], open('2023-06-06')), null, 'human correction is pinned');
  assert.equal(nyc.playbillVerdict('openingNight', ob('m', { openingDateSource: 'manual' }), ['2024-01-24'], open('2024-01-24')), null, 'manual source is pinned');
  assert.equal(nyc.playbillVerdict('openingNight', ob('i', { openingDateSource: 'ibdb' }), ['2024-01-24'], open('2024-01-24')).verdict, 'wrong', 'a scraped source is not pinned');
  assert.equal(nyc.playbillVerdict('closing', ob('h', { closingDate: '2024-03-01', humanCorrectedClosingDate: '2024-03-01' }), ['2024-03-08'], pb({ dates: { closingDate: '2024-03-08' } })), null);
  // Triumph: closed row, Playbill closing still to come
  const tri = ob('triumph-off-broadway-2026', { closingDate: '2026-10-18', previewsStartDate: '2026-09-01', openingDate: '2026-09-20' });
  assert.equal(nyc.playbillVerdict('closing', tri, ['2026-11-03'], pb({ dates: { closingDate: '2026-11-03' } }), '2026-10-29'), null, 'future closing on a closed row');
  assert.equal(nyc.playbillVerdict('closing', tri, ['2026-10-25'], pb({ dates: { closingDate: '2026-10-25' } }), '2026-10-29').verdict, 'wrong');
  // Jerome: 2025 row against a 2026 production page
  const jer = ob('jerome-off-broadway-2025', { previewsStartDate: '2025-11-01', openingDate: '2025-11-20' });
  assert.equal(nyc.playbillVerdict('openingNight', jer, ['2025-11-19'], open('2025-11-19', { titleParse: { year: 2026 } })), null, 'another year is another production');
  assert.equal(nyc.playbillVerdict('openingNight', jer, ['2025-11-19'], open('2025-11-19', { titleParse: { year: 2025 } })).verdict, 'wrong');
  assert.equal(nyc.playbillVerdict('openingNight', ob('g'), ['2024-04-01'], open('2024-04-01')), null, 'over 60 days is another engagement');
  assert.equal(nyc.playbillVerdict('openingNight', ob('noyear', { previewsStartDate: null }), ['2024-01-24'], open('2024-01-24', { titleParse: { year: 2024 } })).verdict, 'wrong');
  assert.equal(nyc.playbillVerdict('previewsStart', ob('blank', { previewsStartDate: null, openingDate: null }), ['2024-01-09'], pb({ dates: { firstPreview: '2024-01-09' }, titleParse: { year: 2024 } })).verdict, 'wrong', 'no year signal on the row: guard does not apply');
  assert.equal(nyc.playbillVerdict('openingNight', ob('g'), ['2024-03-25'], open('2024-03-25')).verdict, 'wrong', '60 days is still a date fix');
});

test('buildPlaybillFixActions: only playbill-auto wrong verdicts, revival to a boolean, holds skipped', () => {
  const shows = new Map([['a', ob('a', { isRevival: false })], ['b', ob('b')], ['c', ob('c', { category: 'broadway', isRevival: true })]]);
  const adj = {
    'a|revival': { verdict: 'wrong', correctValue: 'revival', by: 'playbill-auto', url: 'u' },
    'b|openingNight': { verdict: 'wrong', correctValue: '2024-01-24', by: 'pages-auto', url: 'u' },
    'b|closing': { verdict: 'correct', correctValue: null, by: 'playbill-auto', url: 'u' },
    'c|revival': { verdict: 'wrong', correctValue: 'new', by: 'playbill-auto', url: 'u' },
    'b|previewsStart': { verdict: 'wrong', correctValue: '2024-01-09', by: 'playbill-auto', url: 'u' },
  };
  const { actions, held } = nyc.buildPlaybillFixActions(adj, shows, new Set(['b']));
  assert.deepEqual(actions.map((x) => [x.showId, x.field, x.oldValue, x.newValue]), [['a', 'isRevival', false, true], ['c', 'isRevival', true, false]]);
  assert.deepEqual(held, ['b|previewsStart']);
  assert.deepEqual(nyc.buildPlaybillFixActions({ 'a|revival': { verdict: 'wrong', correctValue: 'Revival!', by: 'playbill-auto' } }, shows).held, ['a|revival'], 'unknown revival value is held, not coerced');
});

test('pagesVerdict: 31 days is a date fix, 32 is not, a null stored date never is', () => {
  const D = (value, source, checker) => ({ checker, cmp: 'disagree', value, source, supported: true });
  const two = (v) => [D(v, 'https://a.com', 'gemini'), D(v, 'https://b.com', 'openai')];
  assert.equal(nyc.pagesVerdict('openingNight', ob('p'), two('2024-02-25')).verdict, 'wrong');
  assert.equal(nyc.pagesVerdict('openingNight', ob('p'), two('2024-02-26')), null);
  assert.equal(nyc.pagesVerdict('openingNight', ob('p', { openingDate: null }), two('2024-02-25')), null);
});
