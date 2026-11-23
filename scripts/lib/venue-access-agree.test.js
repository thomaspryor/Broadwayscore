'use strict';
// BRO-8112: the rules that decide when an access fact may be published for a venue.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { quoteInText, agreeAccess, htmlToText, accessLinks, titleNamesVenue } = require('./venue-access-agree');

const PAGE = {
  url: 'https://example.org/access',
  text: 'Our building is step-free from the street. We have two wheelchair spaces in the stalls. A hearing loop is installed in the auditorium. There is no lift to the circle.',
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
  const both = agreeAccess({ elevator: ans(false, 'There is no lift to the circle') }, { elevator: ans(false, 'no lift to the circle') }, [PAGE]);
  assert.equal(both.access.elevator, false);
  const one = agreeAccess({ elevator: ans(false, 'There is no lift to the circle') }, { elevator: ans(null, null) }, [PAGE]);
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
