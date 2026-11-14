// BRO-5887: the Sonnet judge's pure parts (scripts/lib/reddit-review-judge.js).
// Every edit the model can propose must survive verifyDecision(); these tests
// pin each way it can be refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const j = require('./reddit-review-judge.js');

const SHOW = {
  id: 'midnight-off-broadway-2026', title: 'Midnight', venue: 'Daryl Roth Theatre', openingDate: '2026-10-15', previewsStartDate: '2026-10-01', closingDate: '2026-12-20',
  cast: [{ name: 'Todrick Hall' }, { name: 'Kennedy Caughell' }], creativeTeam: [{ name: 'Lorin Latarro' }],
  priorRuns: [{ id: 'midnight-west-end-2025', venue: 'Prince Edward Theatre', openingDate: '2025-02-10' }],
};
const TODAY = '2026-10-22';
const facts = j.identityFacts(SHOW, TODAY);
const text = (head, body = '') => `${head} ${'The review goes on about the evening. '.repeat(20)}${body}`;

const item = (over = {}) => ({ id: 'a.json', asks: ['held'], outlet: 'Out in Jersey', outletId: 'outinjersey', url: 'https://oij.net/a', storedCritic: 'Unknown', storedDate: '', flags: ['wrongProduction'], text: text('Out in Jersey review. Todrick Hall is spectacular at the Daryl Roth Theatre, in Midnight.'), ...over });
const rec = (over = {}) => ({ criticName: 'Unknown', wrongProduction: true, publishDate: '2026-10-16', ...over });

// ── helpers ──────────────────────────────────────────────────────────────────

test('quoteInText ignores case, punctuation, accents and joins ellipsis fragments', () => {
  const t = 'By Jose Álvarez\n\nTodrick Hall — “spectacular”, at the Daryl Roth Theatre!';
  assert.ok(j.quoteInText('by jose alvarez', t));
  assert.ok(j.quoteInText('Todrick Hall ... Daryl Roth Theatre', t));
  assert.ok(!j.quoteInText('Todrick Hall ... Prince Edward Theatre', t), 'one missing fragment fails the quote');
  assert.ok(!j.quoteInText('', t));
  assert.ok(!j.quoteInText('not here at all', t));
});

test('datesIn reads ISO, day-month and month-day forms and drops impossible dates', () => {
  const d = j.datesIn('Published 16 October 2026; Oct. 3, 2026; 1st of Nov 2026; 2026-10-01; 31 Feb 2026; 13/14/2026');
  assert.deepEqual([...d].sort(), ['2026-10-01', '2026-10-03', '2026-10-16', '2026-11-01']);
});

test('identityFacts: window runs from three weeks before previews to two days past today; other venues are listed', () => {
  assert.equal(facts.windowFrom, '2026-09-10');
  assert.equal(facts.windowTo, '2026-10-24');
  assert.deepEqual(facts.priorVenues, ['Prince Edward Theatre']);
  assert.ok(facts.people.includes('Lorin Latarro') && facts.people.includes('Todrick Hall'));
  assert.equal(j.inWindow('2026-10-16', facts), true);
  assert.equal(j.inWindow('2025-02-12', facts), false, 'an earlier production\'s review date');
  assert.equal(j.inWindow('2026-11-30', facts), false, 'dated in the future');
  assert.equal(j.inWindow('nope', facts), false);
});

// ── what is asked ────────────────────────────────────────────────────────────

test('selectJudgeItems: held only for census-missing outlets; a name or date is asked about only when one is printed; held first; capped', () => {
  const pad = 'x'.repeat(400);
  const full = over => ({ outlet: 'O', outletId: 'o', criticName: 'Jane Doe', publishDate: '2026-10-16', url: 'https://o.com/a', fullText: pad, ...over });
  const records = new Map([
    ['held-listed.json', full({ outlet: 'Air Mail', outletId: 'air-mail', wrongProduction: true, url: 'https://airmail.news/x' })],
    ['held-unlisted.json', full({ outlet: 'Other', outletId: 'other', wrongProduction: true })],
    ['nocritic-byline.json', full({ criticName: 'Unknown', fullText: `Home Culture. By Kyle Torrence. ${pad}` })],
    ['nocritic-nobyline.json', full({ criticName: 'Unknown' })],
    ['outletcritic.json', full({ outlet: 'Edge', outletId: 'edge', criticName: 'Edge', fullText: `Review by Ada Lovelace. ${pad}` })],
    ['nodate-printed.json', full({ publishDate: '', fullText: `Home 18 October 2026 Midnight review. ${pad}` })],
    ['nodate-none.json', full({ publishDate: '' })],
    ['nodate-old.json', full({ publishDate: '', fullText: `Home 12 February 2025 review. ${pad}` })],
    ['short.json', full({ criticName: '', fullText: 'By Jane Doe, tiny' })],
    ['excluded-news.json', full({ criticName: 'Unknown', wrongShow: true, fullText: `Classical news. By Kyle Torrence. ${pad}` })],
    ['excluded-other.json', full({ outletId: 'other2', criticName: 'Unknown', wrongProduction: true, fullText: `Announcement. By Lily Brown. ${pad}` })],
    ['fine.json', full()],
  ]);
  const census = { verdict: 'incomplete', missing: [{ outletId: 'airmail', outlet: 'airmail', url: 'https://airmail.news/x' }] };
  const items = j.selectJudgeItems(records, census, facts);
  assert.deepEqual(items.map(i => i.id), ['held-listed.json', 'nocritic-byline.json', 'outletcritic.json', 'nodate-printed.json'], 'ranked held > critic > date; unprintable or out-of-window asks are skipped');
  assert.deepEqual(items[0].asks, ['held']);
  assert.deepEqual(j.selectJudgeItems(records, null, facts).map(i => i.asks[0]), ['critic', 'critic', 'date'], 'no census: nothing is judged as held');
  const many = new Map(Array.from({ length: 30 }, (_, i) => [`f${i}.json`, full({ criticName: 'Unknown', fullText: `By Jane Doe. ${pad}` })]));
  assert.equal(j.selectJudgeItems(many, null, facts).length, j.MAX_ITEMS);
});

test('bylineCandidates and dateCandidates read only what is printed near the top, and never the cast', () => {
  const credit = `Directed by Anne Smith. ${'x'.repeat(100)}`;
  assert.deepEqual(j.bylineCandidates(credit, facts), []);
  assert.deepEqual(j.bylineCandidates('Review. By Todrick Hall stars', facts), [], 'the cast is never the critic');
  assert.deepEqual(j.bylineCandidates('Culture. By Kyle Torrence Todrick Hall is spectacular', facts), ['Kyle Torrence'], 'greedy capitals are trimmed back to a person');
  assert.deepEqual(j.bylineCandidates(`${'filler '.repeat(150)} By Jane Roe`, facts), [], 'deep in the text does not count');
  assert.deepEqual(j.dateCandidates('Home 16 October 2026 Midnight', facts), ['2026-10-16']);
  assert.deepEqual(j.dateCandidates('Home 12 February 2025 Midnight', facts), [], 'outside the window');
  assert.deepEqual(j.dateCandidates(`${'filler '.repeat(200)} Published October 17, 2026.`, facts), ['2026-10-17'], 'a publication cue counts anywhere');
  assert.deepEqual(j.dateCandidates(`${'filler '.repeat(200)} opened on 15 October 2026.`, facts), [], 'an uncued date deep in the text does not');
});

test('buildPrompt carries the production facts, the checks and a capped text; the system prompt calls the text untrusted', () => {
  const big = item({ asks: ['held', 'date'], text: 'Z'.repeat(9000) });
  const { system, user } = j.buildPrompt(facts, [big]);
  assert.match(system, /untrusted data/);
  assert.match(system, /You have no tools/);
  assert.match(user, /Venue: Daryl Roth Theatre/);
  assert.match(user, /Todrick Hall, Kennedy Caughell/);
  assert.match(user, /Prince Edward Theatre.*NOT this production/);
  assert.match(user, /file id: a\.json/);
  assert.match(user, /Checks: held, date/);
  assert.ok(user.length < 9000, 'the text is capped');
});

test('parseReply tolerates prose around the JSON and drops unknown or repeated ids', () => {
  const items = [item(), item({ id: 'b.json' })];
  const ok = j.parseReply('Sure! {"decisions":[{"id":"a.json"},{"id":"zzz.json"},{"id":"a.json"},{"id":"b.json"},null,{"nope":1}]} done', items);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.decisions.map(d => d.id), ['a.json', 'b.json']);
  assert.equal(j.parseReply('no json here', items).ok, false);
  assert.equal(j.parseReply('{"decisions": 3}', items).ok, false);
  assert.equal(j.parseReply('{"decisions": [', items).ok, false);
});

// ── held: clear a wrong "another production" flag ────────────────────────────

const verify = (it, d, r = rec(), siblings = []) => j.verifyDecision(it, d, r, facts, siblings);

test('held: a quote that is in the text and names this venue or a cast member clears the flag', () => {
  const byVenue = verify(item(), { production: { verdict: 'this-production', quote: 'spectacular at the Daryl Roth Theatre, in Midnight' } });
  assert.deepEqual(byVenue.accepted, ['held']);
  assert.deepEqual(byVenue.edits, [
    { field: 'wrongProductionManualClear', oldValue: null, newValue: true },
    { field: 'wrongProduction', oldValue: true, newValue: false },
  ]);
  const byCast = verify(item({ text: text('Review. Kennedy Caughell sings beautifully in this Midnight.') }), { production: { verdict: 'this-production', quote: 'Kennedy Caughell sings beautifully in this Midnight' } });
  assert.deepEqual(byCast.accepted, ['held']);
});

test('held: every way the model can be wrong is refused', () => {
  const claim = q => ({ production: { verdict: 'this-production', quote: q } });
  const why = (it, d, r) => verify(it, d, r).rejected.map(x => x.why).join('|');
  assert.match(why(item(), claim('words that are nowhere in the stored review text')), /not in the stored text/);
  assert.match(why(item(), claim('The review goes on about the evening. The review goes')), /neither this venue nor anyone in the cast/);
  assert.match(why(item(), { production: { verdict: 'other-production', quote: 'x' } }), /another production/);
  assert.deepEqual(verify(item(), { production: { verdict: 'unsure', quote: 'x' } }).rejected, [], 'unsure: no edit, no complaint');
  const both = item({ text: text('Reviewed at the Daryl Roth Theatre, after the Prince Edward Theatre run, Midnight.') });
  assert.match(why(both, claim('the Daryl Roth Theatre, after the Prince Edward Theatre run')), /earlier production/);
  assert.match(why(item(), claim('spectacular at the Daryl Roth Theatre, in Midnight'), rec({ publishDate: '2025-02-12' })), /outside this production's window|not a review of this production/);
  assert.match(why(item(), claim('Todrick Hall'), rec()), /not in the stored text|neither/, 'a bare name is too short to count');
  assert.match(why(item(), claim('spectacular at the ... Daryl Roth Theatre, in Midnight')), /one unbroken passage/);
  assert.match(why(item({ text: text('Out in Jersey review. Todrick Hall is spectacular at the Daryl Roth Theatre, in Midnight.') }), claim('spectacular at the Daryl Roth Theatre, in Midnight'), rec({ publishDate: undefined })), /no date on the file/);
  assert.deepEqual(verify(item({ text: text('Out in Jersey 16 October 2026. Todrick Hall is spectacular at the Daryl Roth Theatre, in Midnight.') }), claim('spectacular at the Daryl Roth Theatre, in Midnight'), rec({ publishDate: undefined })).accepted, ['held'], 'a printed in-window date is enough when the file has none');
  // not asked about held: a decision about it is ignored
  assert.deepEqual(verify(item({ asks: ['date'] }), claim('spectacular at the Daryl Roth Theatre, in Midnight')).edits, []);
  assert.deepEqual(verify(item(), {}).edits, [], 'an empty decision proposes nothing');
});

// ── critic ───────────────────────────────────────────────────────────────────

test('critic: a printed byline near the top names the critic', () => {
  const it = item({ asks: ['critic'], flags: [], text: text('Home Culture Midnight review. By Kyle Torrence Todrick Hall is spectacular.') });
  const ok = verify(it, { critic: { name: 'Kyle Torrence', quote: 'By Kyle Torrence' } }, rec({ wrongProduction: false, criticName: 'Unknown' }));
  assert.deepEqual(ok.accepted, ['critic']);
  assert.deepEqual(ok.edits, [{ field: 'criticName', oldValue: 'Unknown', newValue: 'Kyle Torrence' }]);
  const empty = verify(it, { critic: { name: 'Kyle Torrence', quote: 'By Kyle Torrence' } }, { criticName: undefined });
  assert.deepEqual(empty.edits, [{ field: 'criticName', oldValue: null, newValue: 'Kyle Torrence' }]);
});

test('critic: show credits, cast, the outlet, duplicates and made-up bylines are refused', () => {
  const mk = body => item({ asks: ['critic'], flags: [], text: text('Midnight review.', body) });
  const why = (it, name, quote, siblings = []) => verify(it, { critic: { name, quote } }, rec({ wrongProduction: false }), siblings).rejected.map(x => x.why).join('|');
  assert.match(why(mk('Directed by Anne Smith, with book by Bo Burns.'), 'Anne Smith', 'Directed by Anne Smith'), /no printed "By <name>" byline/);
  assert.match(why(item({ asks: ['critic'], flags: [], text: text('Review. Todrick Hall stars. By Lorin Latarro') }), 'Lorin Latarro', 'By Lorin Latarro'), /cast or creative team/);
  assert.match(why(mk('x'), 'Out in Jersey', 'By Out in Jersey'), /the name is the outlet|not shaped/);
  assert.match(why(mk('x'), 'Jane Roe', 'By Jane Roe'), /not in the stored text/);
  assert.match(why(mk('x'), 'Staff Writer', 'By Staff Writer'), /not shaped like a person/);
  assert.match(why(mk('x'), 'Madonna', 'By Madonna'), /not shaped like a person/);
  const deep = item({ asks: ['critic'], flags: [], text: `${'filler words about the show. '.repeat(40)} By Jane Roe` });
  assert.match(why(deep, 'Jane Roe', 'By Jane Roe'), /near the top/);
  const dup = item({ asks: ['critic'], flags: [], text: text('Review. By Jane Roe') });
  assert.match(why(dup, 'Jane Roe', 'By Jane Roe', [{ file: 'other.json', outletId: 'outinjersey', criticName: 'Jane Roe' }]), /already has that critic/);
});

// ── date ─────────────────────────────────────────────────────────────────────

test('date: a publication date printed near the top, inside the production window, fills a missing date', () => {
  const it = item({ asks: ['date'], flags: [], text: text('Home Culture 16 October 2026 Midnight review') });
  const ok = verify(it, { date: { value: '2026-10-16', quote: '16 October 2026 Midnight review' } }, { publishDate: undefined, dateSource: undefined });
  assert.deepEqual(ok.accepted, ['date']);
  assert.deepEqual(ok.edits, [{ field: 'publishDate', oldValue: null, newValue: '2026-10-16' }, { field: 'dateSource', oldValue: null, newValue: 'text-regex' }]);
  const cue = item({ asks: ['date'], flags: [], text: `${'filler words about the show. '.repeat(40)} Published October 17, 2026` });
  assert.deepEqual(verify(cue, { date: { value: '2026-10-17', quote: 'Published October 17, 2026' } }, { publishDate: undefined }).accepted, ['date'], 'a publication cue allows a date further down');
});

test('date: an existing date, a date the quote does not spell, a stray window or a deep uncued date are refused', () => {
  const base = item({ asks: ['date'], flags: [], text: text('Home 16 October 2026 Midnight review') });
  const why = (it, d, r = { publishDate: undefined }) => verify(it, { date: d }, r).rejected.map(x => x.why).join('|');
  assert.match(why(base, { value: '2026-10-16', quote: '16 October 2026' }, { publishDate: '2026-10-15' }), /already has a date/);
  assert.match(why(base, { value: '2026-10-17', quote: '16 October 2026' }), /does not spell out that date/);
  assert.match(why(base, { value: '16/10/2026', quote: '16 October 2026' }), /not a YYYY-MM-DD/);
  assert.match(why(base, { value: '2026-10-16', quote: 'a quote nobody printed' }), /not in the stored text/);
  const old = item({ asks: ['date'], flags: [], text: text('Home 12 February 2025 Midnight review') });
  assert.match(why(old, { value: '2025-02-12', quote: '12 February 2025' }), /outside this production's window/);
  const deep = item({ asks: ['date'], flags: [], text: `${'filler words about the show. '.repeat(60)} the show opened on 15 October 2026 downtown` });
  assert.match(why(deep, { value: '2026-10-15', quote: '15 October 2026' }), /deep in the text/);
});

test('one decision can carry several accepted checks', () => {
  const it = item({ asks: ['held', 'critic', 'date'], text: text('Out in Jersey 16 October 2026. By Allen Neuner. Todrick Hall is spectacular at the Daryl Roth Theatre.') });
  const r = verify(it, {
    production: { verdict: 'this-production', quote: 'spectacular at the Daryl Roth Theatre' },
    critic: { name: 'Allen Neuner', quote: 'By Allen Neuner' },
    date: { value: '2026-10-16', quote: '16 October 2026' },
  }, { wrongProduction: true, criticName: 'Unknown', publishDate: undefined });
  assert.deepEqual(r.accepted, ['held', 'critic', 'date']);
  assert.deepEqual(r.edits.map(e => e.field), ['wrongProductionManualClear', 'wrongProduction', 'criticName', 'publishDate', 'dateSource']);
});

// ── regressions found by the ship-check review (BRO-5887) ────────────────────

test('photo, costume, edit and design credits are never a byline, even beside a real one', () => {
  const t = text('Culture. Photo by Joan Marcus Costumes by Jane Doe By Kyle Torrence Todrick Hall is spectacular. Edited by Ed Itor. Illustration by Ann Artist');
  assert.deepEqual(j.bylineCandidates(t, facts), ['Kyle Torrence'], 'the real byline survives the credits that precede it');
  for (const n of ['Joan Marcus', 'Jane Doe', 'Ed Itor', 'Ann Artist']) assert.equal(j.printedByline(t, n), false, `${n} is a credit`);
  const two = text('Photo by Joan Marcus. Review by Ada Lovelace. Words by Grace Hopper.');
  assert.deepEqual(j.bylineCandidates(two, facts), ['Ada Lovelace', 'Grace Hopper']);
  // verifyDecision: the credit never becomes the critic; neither does a second name when another is printed first
  const it = item({ asks: ['critic'], flags: [], text: t });
  const why = name => verify(it, { critic: { name, quote: `by ${name}` } }, rec({ wrongProduction: false })).rejected.map(x => x.why).join('|');
  assert.match(why('Joan Marcus'), /no printed "By <name>" byline|not in the stored text/);
  const twoItem = item({ asks: ['critic'], flags: [], text: two });
  assert.match(verify(twoItem, { critic: { name: 'Grace Hopper', quote: 'Words by Grace Hopper' } }, rec({ wrongProduction: false })).rejected.map(x => x.why).join('|'), /a different name is printed first/);
  assert.deepEqual(verify(twoItem, { critic: { name: 'Ada Lovelace', quote: 'Review by Ada Lovelace' } }, rec({ wrongProduction: false })).accepted, ['critic']);
});

test('the model may stop at a whole-word prefix of the greedy candidate, never go past it', () => {
  const it = item({ asks: ['critic'], flags: [], text: text('Review. By Jane Roe The review goes on.') });
  const ask = name => verify(it, { critic: { name, quote: `By ${name}` } }, rec({ wrongProduction: false }));
  assert.deepEqual(ask('Jane Roe').accepted, ['critic']);
  assert.match(ask('Jane Roe The Review').rejected.map(x => x.why).join('|'), /not in the stored text|a different name/);
});

test('a date quote that reads like a schedule is not a publication date', () => {
  const base = item({ asks: ['date'], flags: [], text: text('Home. Through October 20, 2026 at the Daryl Roth Theatre. Midnight review') });
  const r = verify(base, { date: { value: '2026-10-20', quote: 'Through October 20, 2026' } }, { publishDate: undefined });
  assert.match(r.rejected.map(x => x.why).join('|'), /performance or schedule date/);
  const ok = item({ asks: ['date'], flags: [], text: text('Home. October 20, 2026. Midnight review') });
  assert.deepEqual(verify(ok, { date: { value: '2026-10-20', quote: 'October 20, 2026' } }, { publishDate: undefined }).accepted, ['date']);
});

test('the production a show follows (originalProductionId) counts as another venue', () => {
  const original = { id: 'orig', title: 'Midnight', venue: 'Booth Theatre' };
  const f = j.identityFacts({ ...SHOW, priorRuns: [], originalProductionId: 'orig' }, TODAY, [original]);
  assert.deepEqual(f.priorVenues, ['Booth Theatre']);
  const it = item({ text: text('Out in Jersey review. Reviewed at the Daryl Roth Theatre after the Booth Theatre run. Midnight') });
  const r = j.verifyDecision(it, { production: { verdict: 'this-production', quote: 'Reviewed at the Daryl Roth Theatre after the Booth Theatre run' } }, rec(), f, []);
  assert.match(r.rejected.map(x => x.why).join('|'), /earlier production/);
});

test('review of BRO-5887 ship-check: a truncated critic name is refused, an overrun into ordinary words is not', () => {
  const full = item({ asks: ['critic'], flags: [], text: text('Review. By Mary Ann Smith The review goes on.', 'Smith appears elsewhere only capitalised.') });
  const ask = (it, name) => verify(it, { critic: { name, quote: `By ${name}` } }, rec({ wrongProduction: false }));
  assert.deepEqual(ask(full, 'Mary Ann Smith').accepted, ['critic']);
  assert.deepEqual(ask(full, 'Mary Ann').accepted, [], '"Mary Ann" drops a surname, which never appears in lower case');
  const overrun = item({ asks: ['critic'], flags: [], text: text('Review. By Jane Roe The review goes on.') });
  assert.deepEqual(ask(overrun, 'Jane Roe').accepted, ['critic'], '"the" is an ordinary word the capture ran on into');
});

test('review of BRO-5887 ship-check: an abbreviated month ("Oct.") does not end the publication-cue window, and "Updated" is not a publication date', () => {
  assert.deepEqual(j.dateCandidates(`${'filler '.repeat(200)} Published Oct. 20, 2026`, facts), ['2026-10-20']);
  assert.deepEqual(j.dateCandidates(`${'filler '.repeat(200)} Updated October 20, 2026`, facts), [], 'an edit stamp is not the date the review ran');
});
