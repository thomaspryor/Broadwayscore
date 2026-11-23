'use strict';
// BRO-8112: the rules that decide when an access fact may be published for a venue.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { quoteInText, agreeAccess, htmlToText, accessLinks, titleNamesVenue } = require('./venue-access-agree');

const PAGE = {
  url: 'https://example.org/access',
  text: 'Our building is step-free from the street. We have two wheelchair spaces in the stalls. A hearing loop is installed in the auditorium. There is no lift to the circle. The building has no lift anywhere.',
};
const ans = (value, quote) => ({ value, quote });

test('quoteInText needs the words in order, ignores case and punctuation, rejects tiny quotes', () => {
  assert.ok(quoteInText('Two wheelchair spaces in the stalls', PAGE.text));
  assert.ok(quoteInText('a HEARING-LOOP is installed in the auditorium.', PAGE.text));
  assert.ok(!quoteInText('wheelchair spaces in the circle', PAGE.text));
  assert.ok(!quoteInText('step-free', PAGE.text), 'two words is not evidence');
});

test('both models agree with verbatim on-topic quotes: published, with the quote and its page', () => {
  const g = { wheelchair: ans(true, 'We have two wheelchair spaces in the stalls'), hearingLoop: ans(true, 'A hearing loop is installed in the auditorium'), note: 'Our building is step-free from the street.' };
  const o = { wheelchair: ans(true, 'two wheelchair spaces in the stalls'), hearingLoop: ans(true, 'hearing loop is installed in the auditorium'), note: 'Our building is step-free from the street.' };
  const r = agreeAccess(g, o, [PAGE]);
  assert.equal(r.access.wheelchair, true);
  assert.equal(r.access.hearingLoop, true);
  assert.equal(r.access.note, 'Our building is step-free from the street.');
  assert.equal(r.evidence.wheelchair.url, PAGE.url);
  assert.equal(r.evidence.wheelchair.quote, 'two wheelchair spaces in the stalls');
});

test('an explicit "no" is published only when both quote it', () => {
  const both = agreeAccess({ elevator: ans(false, 'The building has no lift anywhere') }, { elevator: ans(false, 'building has no lift anywhere') }, [PAGE]);
  assert.equal(both.access.elevator, false);
  const one = agreeAccess({ elevator: ans(false, 'The building has no lift anywhere') }, { elevator: ans(null, null) }, [PAGE]);
  assert.deepEqual(one.access, {});
});

test('models that disagree, or one that stays silent, publish nothing for that fact', () => {
  const r = agreeAccess({ wheelchair: ans(true, 'two wheelchair spaces in the stalls') }, { wheelchair: ans(false, 'two wheelchair spaces in the stalls') }, [PAGE]);
  assert.deepEqual(r.access, {});
  assert.equal(r.rejected[0].reason, 'models disagree');
  const silent = agreeAccess({ wheelchair: ans(true, 'two wheelchair spaces in the stalls') }, {}, [PAGE]);
  assert.deepEqual(silent.access, {});
});

test('a quote that is not on the official page is rejected (hallucinated evidence)', () => {
  const r = agreeAccess({ wheelchair: ans(true, 'Full wheelchair access throughout the building') }, { wheelchair: ans(true, 'Full wheelchair access throughout the building') }, [PAGE]);
  assert.deepEqual(r.access, {});
  assert.match(r.rejected[0].reason, /not found/);
});

test('a real quote used for the wrong fact is rejected as off topic', () => {
  const r = agreeAccess({ hearingLoop: ans(true, 'We have two wheelchair spaces in the stalls') }, { hearingLoop: ans(true, 'We have two wheelchair spaces in the stalls') }, [PAGE]);
  assert.deepEqual(r.access, {});
  assert.match(r.rejected[0].reason, /off topic/);
});

test('a note without any agreed fact, or one that is not verbatim, is dropped', () => {
  assert.deepEqual(agreeAccess({ note: 'Our building is step-free from the street.' }, { note: 'Our building is step-free from the street.' }, [PAGE]).access, {});
  const g = { wheelchair: ans(true, 'two wheelchair spaces in the stalls'), note: 'The venue is fully accessible.' };
  const r = agreeAccess(g, { ...g }, [PAGE]);
  assert.equal(r.access.wheelchair, true);
  assert.equal(r.access.note, undefined);
});

test('a model error means nothing is published', () => {
  assert.deepEqual(agreeAccess({ error: 'boom' }, { wheelchair: ans(true, 'x y z') }, [PAGE]).access, {});
  assert.deepEqual(agreeAccess(null, null, [PAGE]).access, {});
});

test('htmlToText drops scripts and tags; accessLinks finds same-site access pages only', () => {
  assert.equal(htmlToText('<p>Hello&nbsp;<b>world</b></p><script>x=1</script>'), 'Hello world .');
  const html = '<a href="/visit/access">Access</a><a href="/about">About</a><a href="https://other.com/access">Access</a><a href="/files/a.pdf">Access guide</a><a href="/plan-your-visit">Plan your visit</a>';
  assert.deepEqual(accessLinks(html, 'https://www.theatre.org/'), ['https://www.theatre.org/visit/access', 'https://www.theatre.org/plan-your-visit']);
});

test('seat-view page counts only when its title names the venue and is not an error or search page', () => {
  assert.ok(titleNamesVenue('Adelphi Theatre London Box Office | SeatPlan', 'Adelphi Theatre'));
  assert.ok(!titleNamesVenue('Not Found - SeatPlan', 'Adelphi Theatre'));
  assert.ok(!titleNamesVenue('Search results for adelphi - SeatPlan', 'Adelphi Theatre'));
  assert.ok(!titleNamesVenue('Quick security check - A View From My Seat', 'Adelphi Theatre'));
  assert.ok(!titleNamesVenue('Donmar Warehouse Seating Plan | SeatPlan', 'Adelphi Theatre'));
});

// ---- BRO-8112 ship-check findings: real quotes that used to publish wrong facts ----
const both = (f, v, q, text) => agreeAccess({ [f]: ans(v, q) }, { [f]: ans(v, q) }, [{ url: 'https://x.org/a', text }]);

test('a hearing-loop denial does not become "No assistive listening" (Charing Cross)', () => {
  const t = 'Please note that we do not currently have a hearing induction loop installed.';
  assert.deepEqual(both('assistiveListening', false, t, t).access, {});
  assert.equal(both('hearingLoop', false, t, t).access.hearingLoop, false);
});

test('a loop that exists only on request / personally is not a "No hearing loop" (Dorfman)', () => {
  const t = 'There is no installed loop, but you can request a personal neck-loop from the box office.';
  assert.deepEqual(both('hearingLoop', false, t, t).access, {});
});

test('a loop at the box office or foyer is not an auditorium hearing loop (Criterion, Almeida)', () => {
  const c = 'We have an induction loop system available in the foyer for the Box Office.';
  assert.deepEqual(both('hearingLoop', true, c, c).access, {});
  const ok = 'A hearing loop is installed in the auditorium and stalls.';
  assert.equal(both('hearingLoop', true, ok, ok).access.hearingLoop, true);
});

test('"no lift to the circle" is about one level, not "No elevator" (Almeida)', () => {
  const t = 'The theatre does not have a lift to the circle.';
  assert.deepEqual(both('elevator', false, t, t).access, {});
});

test('a yes quote cut from a negated sentence is rejected', () => {
  const t = 'There is no step free access to the stalls from the street.';
  const r = both('stepFree', true, 'step free access to the stalls', t);
  assert.deepEqual(r.access, {});
  assert.match(r.rejected[0].reason, /negation/);
});

test('"lift to floor 3" does not prove step-free; bare "accessible performances" does not prove wheelchair', () => {
  const a = 'Take the lift to floor 3 for the studio.';
  assert.deepEqual(both('stepFree', true, a, a).access, {});
  const b = 'We offer accessible performances throughout the season.';
  assert.deepEqual(both('wheelchair', true, b, b).access, {});
});

test('notes: slogans and seating descriptions are dropped, and a note cannot contradict a denied flag', () => {
  const page = { url: 'https://x.org/a', text: 'A black box studio space with unallocated seats on the 3rd floor. The venue aims to be as accessible as possible. Wheelchair users can sit in row A. There is no lift to every level. A lift serves the stalls bar.' };
  const mk = (note) => agreeAccess(
    { wheelchair: ans(true, 'Wheelchair users can sit in row A'), note },
    { wheelchair: ans(true, 'Wheelchair users can sit in row A'), note }, [page]);
  assert.equal(mk('A black box studio space with unallocated seats on the 3rd floor.').access.note, undefined);
  assert.equal(mk('The venue aims to be as accessible as possible.').access.note, undefined);
  assert.equal(mk('Wheelchair users can sit in row A.').access.note, 'Wheelchair users can sit in row A.');
  const denied = agreeAccess(
    { wheelchair: ans(true, 'Wheelchair users can sit in row A'), elevator: ans(false, 'There is no lift to every level'), note: 'A lift serves the stalls bar.' },
    { wheelchair: ans(true, 'Wheelchair users can sit in row A'), elevator: ans(false, 'There is no lift to every level'), note: 'A lift serves the stalls bar.' }, [page]);
  assert.equal(denied.access.note, undefined);
});

test('step-free / lift claims scoped to one area are dropped; whole-building claims stay (Codex review)', () => {
  const part = 'There is step free access to the main foyer, The Scratch Bar and ground floor public spaces.';
  assert.deepEqual(both('stepFree', true, part, part).access, {});
  const bar = 'Bar - Step-free access by lift from the foyer area.';
  assert.deepEqual(both('elevator', true, bar, bar).access, {});
  const row = 'Limited stairs or stair free access is in Row F of the Dress circle.';
  assert.deepEqual(both('stepFree', true, row, row).access, {});
  const whole = 'There is step-free access to all levels of the theatre.';
  assert.equal(both('stepFree', true, whole, whole).access.stepFree, true);
  const lift = 'There is lift access to each level of the theatre.';
  assert.equal(both('elevator', true, lift, lift).access.elevator, true);
});
