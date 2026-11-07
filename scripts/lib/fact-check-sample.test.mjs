import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fc = require('./fact-check-sample.js');

const rows = [];
for (let i = 0; i < 60; i++) {
  rows.push({ id: `we-${i}`, title: `Show ${i}`, discoverySource: 'we-historical:wos', season: fc.WE_SEASONS[i % 3], category: 'west-end' });
}
rows.push({ id: 'other', discoverySource: 'manual-user-request', season: '2019-2020' });
rows.push({ id: 'too-new', discoverySource: 'we-historical:wos', season: '2024-2025' });

test('drawSample is reproducible from the seed and ignores input order', () => {
  const a = fc.drawSample(rows, 'we-historical', 12, 5080);
  const b = fc.drawSample([...rows].reverse(), 'we-historical', 12, 5080);
  assert.deepEqual(a.ids, b.ids);
  assert.equal(a.n, 12);
  assert.equal(a.population, 60);
  const c = fc.drawSample(rows, 'we-historical', 12, 5081);
  assert.notDeepEqual(a.ids, c.ids);
});

test('drawSample keeps the cohort filter (no other sources, no seasons outside 2018-19..2023-24)', () => {
  const s = fc.drawSample(rows, 'we-historical', 100, 1);
  assert.equal(s.n, 60);
  assert.ok(!s.ids.some((r) => r.id === 'other' || r.id === 'too-new'));
});

test('stratified allocation is proportional and gives every stratum a row', () => {
  const skew = [...Array(90)].map((_, i) => ({ id: `a${i}`, s: 'big' })).concat([{ id: 'b0', s: 'small' }]);
  const out = fc.stratifiedSample(skew, (r) => r.s, 10, 3);
  assert.equal(out.length, 10);
  assert.equal(out.filter((r) => r.stratum === 'small').length, 1);
});

test('broadway cohort strata are decades and exclude West End rows', () => {
  const bw = [
    { id: 'x', category: 'broadway', tags: ['historical'], openingDate: '1975-03-01' },
    { id: 'y', category: 'broadway', tags: ['historical'], openingDate: '2004-03-01' },
    { id: 'z', category: 'west-end', tags: ['historical'], openingDate: '2004-03-01' },
    { id: 'w', category: 'broadway', tags: [], openingDate: '2004-03-01' },
  ];
  const s = fc.drawSample(bw, 'broadway-historical', 10, 1);
  assert.deepEqual(s.ids.map((r) => r.stratum).sort(), ['1970s', '2000s']);
});

test('the fact prompt carries identity only, never the stored answers', () => {
  const show = { title: 'Oedipus', season: '2024-2025', venue: "Wyndham's Theatre", openingDate: '2024-10-15', type: 'play', creativeTeam: [{ name: 'Robert Icke', role: 'Director' }] };
  const p = fc.buildFactPrompt(show, 'we-historical');
  assert.match(p, /"Oedipus"/);
  assert.match(p, /2024-25/);
  for (const leak of ['Wyndham', '2024-10-15', 'Icke']) assert.ok(!p.includes(leak), `prompt leaks ${leak}`);
});

test('pageSupports finds dates in the spellings pages use', () => {
  assert.ok(fc.pageSupports('Opens on 5 September 2019 at Trafalgar', '2019-09-05', 'date'));
  assert.ok(fc.pageSupports('Opening night: September 5th, 2019.', '2019-09-05', 'date'));
  assert.ok(!fc.pageSupports('Opens on 15 September 2019', '2019-09-05', 'date'));
  assert.ok(fc.pageSupports('Directed by Jack McNamara', 'Jack McNamara', 'person'));
  assert.ok(!fc.pageSupports('Directed by Jack Smith', 'Jack McNamara', 'person'));
  assert.ok(fc.pageSupports('at the Noël Coward Theatre', 'Noel Coward Theatre', 'venue'));
});

test('compareField: venue renames and studios count as the same house; a different house does not', () => {
  const show = { venue: 'Trafalgar Theatre' };
  assert.equal(fc.compareField('theatre', show, 'Trafalgar Studios 2', 'west-end'), 'agree');
  assert.equal(fc.compareField('theatre', { venue: 'Old Vic' }, 'Young Vic', 'west-end'), 'disagree');
  assert.equal(fc.compareField('theatre', { venue: 'Royal Court' }, 'Jerwood Theatre Downstairs, Royal Court Theatre', 'west-end'), 'agree');
  assert.equal(fc.compareField('theatre', { venue: 'Lyttelton Theatre' }, 'National Theatre (Lyttelton)', 'west-end'), 'agree');
  assert.equal(fc.compareField('theatre', { venue: 'Olivier Theatre' }, 'National Theatre - Olivier Theatre', 'west-end'), 'agree');
  assert.equal(fc.compareField('theatre', { venue: 'Apollo Theatre' }, 'Apollo Victoria Theatre', 'west-end'), 'disagree');
  assert.equal(fc.compareField('theatre', { venue: 'Apollo Theatre' }, 'Duchess Theatre', 'west-end'), 'disagree');
});

test('compareField: a famous director from another production is a disagreement', () => {
  const show = { creativeTeam: [{ name: 'Sam Mendes', role: 'Director' }, { name: 'Jez Butterworth', role: 'Playwright' }] };
  assert.equal(fc.compareField('directors', show, ['Jack McNamara'], 'west-end'), 'disagree');
  assert.equal(fc.compareField('writers', show, [{ name: 'Jez Butterworth', role: 'playwright' }], 'west-end'), 'agree');
  assert.equal(fc.compareField('directors', show, null, 'west-end'), 'no-answer');
  const team = { creativeTeam: [{ name: 'Moss Hart and George S. Kaufman', role: 'Playwright' }] };
  assert.equal(fc.compareField('writers', team, [{ name: 'Moss Hart' }, { name: 'George S. Kaufman' }], 'broadway'), 'agree');
  assert.equal(fc.compareField('writers', team, [{ name: 'Moss Hart' }], 'broadway'), 'disagree');
});

test('compareField: a play typed as musical disagrees', () => {
  assert.equal(fc.compareField('type', { type: 'musical' }, 'play', 'west-end'), 'disagree');
  assert.equal(fc.compareField('type', { type: 'play' }, 'Play (drama)', 'west-end'), 'agree');
});

test('storedCredits keeps directors and writers and drops designers', () => {
  const c = fc.storedCredits({ creativeTeam: [
    { name: 'A', role: 'Director' }, { name: 'B', role: 'Director & Choreographer' }, { name: 'C', role: 'Book' },
    { name: 'D', role: 'Music & Lyrics' }, { name: 'E', role: 'Scenic Design' }, { name: 'F', role: 'Music Direction' },
  ] });
  assert.deepEqual(c.directors, ['A', 'B']);
  assert.deepEqual(c.writers, ['C', 'D']);
});

test('triageField: a sourced disagreement goes to adjudication, an unsourced agreement does not count', () => {
  const show = { openingDate: '2019-09-03' };
  const mk = (checker, value, supported) => ({ checker, answer: { openingNight: { value, source: 'https://x' } }, support: { openingNight: supported } });
  assert.equal(fc.triageField('openingNight', show, [mk('g', '2019-09-05', true), mk('o', '2019-09-03', false)], 'west-end').status, 'adjudicate');
  assert.equal(fc.triageField('openingNight', show, [mk('g', '2019-09-03', true), mk('o', null, false)], 'west-end').status, 'ok');
  assert.equal(fc.triageField('openingNight', show, [mk('g', '2019-09-03', false), mk('o', '2019-09-03', false)], 'west-end').status, 'ok-cited');
  assert.equal(fc.triageField('openingNight', show, [mk('g', '2019-09-03', false), mk('o', null, false)], 'west-end').status, 'unsourced');
  assert.equal(fc.triageField('openingNight', {}, [mk('g', '2019-09-03', true)], 'west-end').status, 'not-stored');
});

test('errorTable rates wrong over checked with a Wilson interval', () => {
  const v = [...Array(98)].map(() => ({ field: 'type', verdict: 'correct' })).concat([{ field: 'type', verdict: 'wrong' }, { field: 'type', verdict: 'wrong' }, { field: 'type', verdict: 'unverifiable' }]);
  const t = fc.errorTable(v).type;
  assert.equal(t.checked, 100);
  assert.equal(t.rate, 0.02);
  assert.ok(t.ci95[0] > 0.004 && t.ci95[0] < 0.01);
  assert.ok(t.ci95[1] > 0.06 && t.ci95[1] < 0.08);
  assert.equal(t.unverifiable, 1);
});

test('a checker citing broadwayscorecard.com is never a source for our own value', () => {
  const show = { openingDate: '2018-11-23' };
  const c = [{ checker: 'o', answer: { openingNight: { value: '2018-11-23', source: 'https://broadwayscorecard.com/show/true-west-west-end-2018' } }, support: { openingNight: true } }];
  assert.equal(fc.triageField('openingNight', show, c, 'west-end').status, 'unsourced');
  assert.ok(fc.buildFactPrompt({ title: 'X', season: '2019-2020' }, 'we-historical').includes('Never use broadwayscorecard.com'));
});

test('a season key samples that season only, even outside WE_SEASONS', () => {
  const shows = [
    { id: 'a', discoverySource: 'we-historical:wos', season: '2024-2025' },
    { id: 'b', discoverySource: 'we-historical:wos', season: '2019-2020' },
    { id: 'c', discoverySource: 'manual-user-request', season: '2024-2025' },
    { id: 'd', discoverySource: 'we-historical:tr', season: '2024-2025' },
    { id: 'e', discoverySource: 'we-historical:tr', season: '2019-2020' },
  ];
  assert.deepEqual(fc.parseCohortKey('we-historical-2024-2025'), { base: 'we-historical', season: '2024-2025' });
  // Review-led TR rows are gated by the season audit, so the season sample draws them too (BRO-5851).
  assert.deepEqual(fc.drawSample(shows, 'we-historical-2024-2025', 10, 1).ids.map((r) => r.id).sort(), ['a', 'd']);
  assert.match(fc.drawSample(shows, 'we-historical-2024-2025', 10, 1).label, /2024-2025 \(we-historical:wos \+ we-historical:tr \+ we-historical:olt\)/);
  // The cross-season cohort is unchanged: WOS rows in WE_SEASONS only.
  assert.deepEqual(fc.cohortRows(shows, 'we-historical').map((r) => r.id), ['b']);
  assert.throws(() => fc.parseCohortKey('nope'));
  // Season keys resolve to their base cohort's market (the synopsis prompt crashed on them, BRO-5843).
  assert.equal(fc.cohortMarket('we-historical-2024-2025'), fc.COHORTS['we-historical'].market);
  assert.equal(fc.cohortMarket('we-historical'), fc.COHORTS['we-historical'].market);
});

test('the season audit carries the sourced sample as an advisory check', () => {
  const { auditSeason } = require('../audit-we-historical-season.js');
  const shows = [{ id: 'x-west-end-2019', title: 'X', discoverySource: 'we-historical:wos', season: '2019-2020', openingDate: '2019-10-01', closingDate: '2019-12-01' }];
  const verdicts = [
    { id: 'x-west-end-2019', field: 'openingNight', verdict: 'wrong', url: 'https://example.org', note: 'opening=first-preview' },
    { id: 'x-west-end-2019', field: 'type', verdict: 'correct' },
    { id: 'other', field: 'type', verdict: 'wrong' },
  ];
  const r = auditSeason({ shows, reviews: [], season: '2019-2020', factCheckVerdicts: verdicts });
  assert.equal(r.checks.factCheck.pass, null);
  assert.equal(r.checks.factCheck.sampled, 1);
  assert.equal(r.checks.factCheck.table.openingNight.wrong, 1);
  assert.equal(r.checks.factCheck.wrong.length, 1);
  assert.equal(auditSeason({ shows, reviews: [], season: '2019-2020' }).checks.factCheck.sampled, 0);
});

test('a day-month swap is not a supporting date (09/05/2019 is ambiguous)', () => {
  assert.ok(!fc.pageSupports('Booking period 09/05/2019 to 01/06/2019', '2019-09-05', 'date'));
  assert.ok(fc.pageSupports('Opening 25/09/2019', '2019-09-25', 'date'));
});

test('different auditoria of one house are different venues', () => {
  assert.equal(fc.sameVenue('Jerwood Theatre Upstairs, Royal Court Theatre', 'Jerwood Theatre Downstairs (Royal Court)'), false);
  assert.equal(fc.sameVenue('Trafalgar Studios 1', 'Trafalgar Studios 2'), false);
  assert.equal(fc.sameVenue('Royal Court', 'Jerwood Theatre Upstairs, Royal Court Theatre'), true);
});

test('bare-array and bare-string checker fields are kept, not dropped', () => {
  const a = fc.normalizeAnswer({ writers: [{ name: 'Sam Shepard', role: 'playwright', source: 'https://x' }], type: 'play' });
  assert.deepEqual(a.writers, { value: [{ name: 'Sam Shepard', role: 'playwright' }], source: 'https://x' });
  assert.deepEqual(a.type, { value: 'play', source: null });
  const show = { creativeTeam: [{ name: 'Sam Shepard', role: 'Playwright' }] };
  const t = fc.triageField('writers', show, [{ checker: 'g', answer: { writers: [{ name: 'Sam Shepard', source: 'https://x' }] }, support: { writers: true } }], 'west-end');
  assert.equal(t.status, 'ok');
});

test('seasonSummary counts a row sampled twice once', () => {
  const v = { id: 'a', field: 'type', verdict: 'wrong' };
  const s = fc.seasonSummary([v, v], ['a']);
  assert.equal(s.table.type.checked, 1);
});

test('a single bare person object and per-person sources are kept', () => {
  assert.deepEqual(fc.normalizeAnswer({ directors: { name: 'Ian Rickson', role: 'director', source: 'https://x' } }).directors,
    { value: [{ name: 'Ian Rickson', role: 'director' }], source: 'https://x' });
  const w = fc.normalizeAnswer({ writers: [{ name: 'A', source: 'https://a' }, { name: 'B', source: 'https://b' }] }).writers;
  assert.deepEqual(w.itemSources, ['https://a', 'https://b']);
});

test('a weaker season verdict never hides a definitive one; street numbers are not auditoria', () => {
  const s = fc.seasonSummary([{ id: 'a', field: 'openingNight', verdict: 'wrong' }, { id: 'a', field: 'openingNight', verdict: 'unverifiable' }], ['a']);
  assert.equal(s.table.openingNight.wrong, 1);
  assert.equal(fc.sameVenue('Garrick Theatre, 2 Charing Cross Road', 'Garrick Theatre'), true);
});

// BRO-6019: the Off-Broadway historical cohort matches the cross-model audit's ob-historical rows.
test('off-broadway-historical cohort selects historical Off-Broadway rows only', () => {
  const f = fc.COHORTS['off-broadway-historical'].filter;
  assert.equal(f({ market: 'broadway', category: 'off-broadway', tags: ['historical'] }), true);
  assert.equal(f({ market: 'broadway', category: 'off-broadway', tags: [] }), false);
  assert.equal(f({ market: 'broadway', category: 'broadway', tags: ['historical'] }), false);
  assert.equal(f({ market: 'west-end', category: 'off-west-end', tags: ['historical'] }), false);
});

// BRO-6019: a row with no season is identified by its start month, never "an unknown season".
test('productionTimePhrase falls back to the stored start month', () => {
  assert.match(fc.productionTimePhrase({ season: '2024-2025' }), /2024-25 theatre season/);
  assert.equal(fc.productionTimePhrase({ openingDate: '2023-11-20' }), 'the run that began around 2023');
  // Year only: no stored month or day leaks into the prompt.
  assert.doesNotMatch(fc.productionTimePhrase({ openingDate: '2023-11-20' }), /11/);
  assert.equal(fc.productionTimePhrase({ previewsStartDate: '2016-12-20', openingDate: '2017-01-10' }), 'the run that began around 2016');
  assert.equal(fc.productionTimePhrase({}), 'an unknown season');
  const p = fc.buildFactPrompt({ title: 'School Pictures', openingDate: '2023-11-20' }, 'off-broadway-historical');
  assert.doesNotMatch(p, /unknown season/);
});
