// scripts/lib/paywall-completeness.test.mjs — node:test
// Run: node --test scripts/lib/paywall-completeness.test.mjs
//
// BRO-4334 (School Girls NYT page-one capture). Per CLAUDE.md §15 — imports
// the real functions, no copied logic.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  HARD_PAYWALL_FLOORS,
  getHardPaywallDomain,
  stripTrailingByline,
  assessPaywallCompleteness,
  isBetterCandidate,
  decideTierResult,
  shouldKeepStoredText,
  escalateAfterPartial,
  needsPaywallRecheck,
  truncatedTierPatch,
} from './paywall-completeness.js';

const NYT = 'https://www.nytimes.com/2026/09/28/theater/school-girls-or-the-african-mean-girls-play-review.html';
const VARIETY = 'https://variety.com/2026/legit/reviews/school-girls-review-1236000000/';

// Prose of roughly `n` chars in paragraphs, ending with a full sentence.
// Each sentence is numbered: the assessment strips repeated paragraphs as page
// furniture (BRO-7171), so identical paragraphs would not count toward length.
function prose(n) {
  let out = '';
  let k = 0;
  while (out.length < n) {
    k++;
    out += `The ensemble in School Girls is sharp and funny in scene ${k}, and the direction keeps the comedy moving with real bite. ` + (out.length % 700 < 120 ? '\n\n' : '');
  }
  return out.trim();
}

// Shape of the real School Girls capture: page-one prose, then a bare byline.
const PAGE_ONE = `${prose(3200)} (The costume designer is mostly limited to school uniforms until one hilarious sequence.)\n\nHelen Shaw`;
// Shape of a whole modern NYT review: prose, info box, byline.
const WHOLE_SHORT = `${prose(3400)}\n\nSchool GirlsThrough Nov. 9 at the Samuel J. Friedman Theater, Manhattan; manhattantheatreclub.com. Running time: 1 hour 30 minutes.\n\nHelen Shaw`;

test('getHardPaywallDomain: exact host, subdomain, lookalike, garbage', () => {
  assert.equal(getHardPaywallDomain(NYT), 'nytimes.com');
  assert.equal(getHardPaywallDomain('https://cooking.nytimes.com/x'), 'nytimes.com');
  assert.equal(getHardPaywallDomain('https://www.washingtonpost.com/theater/x'), 'washingtonpost.com');
  assert.equal(getHardPaywallDomain('https://notnytimes.com/x'), null);
  assert.equal(getHardPaywallDomain(VARIETY), null);
  assert.equal(getHardPaywallDomain('not a url'), null);
  assert.equal(HARD_PAYWALL_FLOORS['nytimes.com'], 4500);
});

test('stripTrailingByline: critic name, bare Name line, no byline', () => {
  assert.deepEqual(stripTrailingByline('Great show.\n\nHelen Shaw', 'Helen Shaw'), { body: 'Great show.', bylineStripped: true });
  assert.deepEqual(stripTrailingByline('Great show.\n\nJesse Green', null), { body: 'Great show.', bylineStripped: true });
  assert.equal(stripTrailingByline('Running time: 2 hours. Jesse Green', 'Jesse Green').body, 'Running time: 2 hours.');
  // the critic's name as the tail of a longer word must not strip
  assert.equal(stripTrailingByline('They rode off in a rickshaw', 'Shaw').bylineStripped, false);
  assert.equal(stripTrailingByline('It ends properly.', 'Helen Shaw').bylineStripped, false);
});

test('School Girls page-one shape: truncated → continue', () => {
  const a = assessPaywallCompleteness(PAGE_ONE, NYT, { criticName: 'Helen Shaw' });
  assert.equal(a.hardPaywall, true);
  assert.equal(a.complete, false);
  assert.equal(a.bylineStripped, true);
  assert.equal(a.infoBoxEnding, false);
  assert.ok(a.reasons.some((r) => r.startsWith('below_floor:')), a.reasons.join());
  assert.ok(a.reasons.includes('trailing_byline_after_prose'));
  const d = decideTierResult({ best: null, candidate: { text: PAGE_ONE, method: 'scrapingbee' }, url: NYT, criticName: 'Helen Shaw' });
  assert.equal(d.action, 'continue');
  assert.equal(d.best.method, 'scrapingbee');
});

test('short but whole NYT review (info box ending) is complete despite the floor', () => {
  const a = assessPaywallCompleteness(WHOLE_SHORT, NYT, { criticName: 'Helen Shaw' });
  assert.ok(a.length < 4500);
  assert.equal(a.infoBoxEnding, true);
  assert.equal(a.complete, true, a.reasons.join());
});

test('long prose-only text ending in punctuation meets the floor → complete', () => {
  const a = assessPaywallCompleteness(prose(6000), NYT);
  assert.equal(a.complete, true, a.reasons.join());
});

test('mid-length text without info box is below the NYT floor', () => {
  const a = assessPaywallCompleteness(prose(4000), NYT);
  assert.equal(a.complete, false);
  assert.deepEqual(a.reasons.map((r) => r.split(':')[0]), ['below_floor']);
});

test('no ending punctuation: fatal on short text, tolerated as chrome on long text', () => {
  const short = assessPaywallCompleteness(`${prose(4800)} and then the second act`, NYT);
  assert.ok(short.reasons.includes('no_ending_punctuation'));
  const long = assessPaywallCompleteness(`${prose(8000)} Help Subscriptions Manage Privacy Preferences`, NYT);
  assert.equal(long.complete, true, long.reasons.join());
});

test('paywall prompt at the tail → incomplete even when long', () => {
  const a = assessPaywallCompleteness(`${prose(7000)} Subscribe now to continue reading this review.`, 'https://www.chicagotribune.com/x');
  assert.ok(a.reasons.includes('paywall_prompt'));
  assert.equal(a.complete, false);
});

test('non-hard-paywall URL: no opinion (accept)', () => {
  const a = assessPaywallCompleteness('short text', VARIETY);
  assert.equal(a.hardPaywall, false);
  assert.equal(a.complete, true);
  assert.equal(decideTierResult({ candidate: { text: 'short' }, url: VARIETY }).action, 'accept');
});

test('decideTierResult: keeps the better partial, accepts the first complete', () => {
  let best = null;
  let d = decideTierResult({ best, candidate: { text: PAGE_ONE, method: 'scrapingbee' }, url: NYT, criticName: 'Helen Shaw' });
  assert.equal(d.action, 'continue');
  best = d.best;
  d = decideTierResult({ best, candidate: { text: prose(2000), method: 'archive' }, url: NYT });
  assert.equal(d.action, 'continue');
  assert.equal(d.best.method, 'scrapingbee', 'shorter partial does not replace a longer one');
  best = d.best;
  d = decideTierResult({ best, candidate: { text: prose(4200), method: 'brightdata' }, url: NYT });
  assert.equal(d.best.method, 'brightdata', 'longer partial replaces');
  best = d.best;
  d = decideTierResult({ best, candidate: { text: WHOLE_SHORT, method: 'browserbase' }, url: NYT, criticName: 'Helen Shaw' });
  assert.equal(d.action, 'accept');
});

test('isBetterCandidate: complete beats a longer partial', () => {
  const complete = { assessment: { complete: true, length: 3000 } };
  const partial = { assessment: { complete: false, length: 9000 } };
  assert.equal(isBetterCandidate(complete, partial), true);
  assert.equal(isBetterCandidate(partial, complete), false);
  assert.equal(isBetterCandidate(partial, null), true);
});

test('shouldKeepStoredText: never overwrite a better stored text with a worse partial', () => {
  assert.equal(shouldKeepStoredText({ storedText: PAGE_ONE, newText: prose(2000), url: NYT, criticName: 'Helen Shaw' }), true);
  assert.equal(shouldKeepStoredText({ storedText: PAGE_ONE, newText: prose(4200), url: NYT, criticName: 'Helen Shaw' }), false);
  assert.equal(shouldKeepStoredText({ storedText: '', newText: prose(2000), url: NYT }), false);
  assert.equal(shouldKeepStoredText({ storedText: prose(5000), newText: prose(100), url: VARIETY }), false);
});

test('escalateAfterPartial: logged-in tiers next, rest keep relative order', () => {
  const ids = ['archive-cdx-final', 'archive-first', 'direct-cookies', 'archive-cdx', 'browserbase', 'brightdata'].map((id) => ({ id }));
  assert.deepEqual(escalateAfterPartial(ids).map((t) => t.id),
    ['browserbase', 'direct-cookies', 'archive-cdx-final', 'archive-first', 'archive-cdx', 'brightdata']);
  assert.deepEqual(escalateAfterPartial([{ id: 'brightdata' }]).map((t) => t.id), ['brightdata']);
});

test('needsPaywallRecheck: opening-window scraped partial only', () => {
  const now = Date.parse('2026-09-29T09:00:00Z');
  const base = { url: NYT, criticName: 'Helen Shaw', fullText: PAGE_ONE, contentTier: 'complete', sourceMethod: 'scrapingbee', firstSeenAt: '2026-09-29T01:40:32.544Z' };
  assert.equal(needsPaywallRecheck(base, now), true);
  assert.equal(needsPaywallRecheck({ ...base, firstSeenAt: '2026-09-01T00:00:00Z' }, now), false, 'outside window');
  assert.equal(needsPaywallRecheck({ ...base, sourceMethod: 'manual-entry' }, now), false, 'trusted source');
  assert.equal(needsPaywallRecheck({ ...base, contentTier: 'truncated' }, now), false, 'already truncated');
  assert.equal(needsPaywallRecheck({ ...base, fullText: WHOLE_SHORT }, now), false, 'whole text');
  assert.equal(needsPaywallRecheck({ ...base, url: VARIETY }, now), false, 'not hard paywall');
});

test('truncatedTierPatch: relabels a partial stored text, leaves whole text alone', () => {
  const base = { url: NYT, criticName: 'Helen Shaw', fullText: PAGE_ONE, contentTier: 'complete', sourceMethod: 'scrapingbee' };
  const patch = truncatedTierPatch(base);
  assert.equal(patch.contentTier, 'truncated');
  assert.equal(patch.isFullReview, false);
  assert.match(patch.tierReason, /Paywall truncation: .*nytimes\.com \(source: scrapingbee\)/);
  assert.equal(truncatedTierPatch({ ...base, fullText: WHOLE_SHORT }), null);
  assert.equal(truncatedTierPatch({ ...base, sourceMethod: 'url-ingest' }), null);
});

// ---- ship-check fixes ----
import { applyPaywallTierOverride } from './paywall-completeness.js';

test('needsPaywallRecheck: textFetchedAt alone never opens the window (reset on every write)', () => {
  const now = Date.parse('2026-09-29T09:00:00Z');
  const data = { url: NYT, fullText: PAGE_ONE, contentTier: 'complete', sourceMethod: 'scrapingbee', textFetchedAt: '2026-09-29T08:00:00Z' };
  assert.equal(needsPaywallRecheck(data, now), false);
  assert.equal(needsPaywallRecheck({ ...data, firstSeenAt: '2026-01-01T00:00:00Z' }, now), false);
});

test('applyPaywallTierOverride: rebuild keeps a collector paywall truncation', () => {
  const now = Date.parse('2026-12-01T00:00:00Z'); // long after the opening window
  const complete = { contentTier: 'complete', tierReason: 'Full review text', wordCount: 520 };
  const labelled = { url: NYT, criticName: 'Helen Shaw', fullText: PAGE_ONE, sourceMethod: 'scrapingbee',
    firstSeenAt: '2026-09-29T01:40:00Z', contentTierReason: 'Paywall truncation: below_floor:2909<4500 for nytimes.com (source: scrapingbee)' };
  const out = applyPaywallTierOverride(labelled, complete, now);
  assert.equal(out.contentTier, 'truncated');
  assert.equal(out.paywallOverride, true);
  assert.equal(out.wordCount, 520);
  assert.match(out.tierReason, /^Paywall truncation:/);
});

test('applyPaywallTierOverride: scoped — no mass reclassification of the historical corpus', () => {
  const now = Date.parse('2026-12-01T00:00:00Z');
  const complete = { contentTier: 'complete', tierReason: 'Full review text' };
  const old = { url: NYT, fullText: PAGE_ONE, sourceMethod: 'scrapingbee', firstSeenAt: '2025-01-01T00:00:00Z', contentTierReason: 'Full review text' };
  assert.equal(applyPaywallTierOverride(old, complete, now), complete, 'unlabelled, outside window');
  // in window → applies
  assert.equal(applyPaywallTierOverride({ ...old, firstSeenAt: '2026-11-30T00:00:00Z' }, complete, now).contentTier, 'truncated');
  // labelled but the text is now whole → no override
  assert.equal(applyPaywallTierOverride({ ...old, fullText: WHOLE_SHORT, contentTierReason: 'Paywall truncation: x' }, complete, now), complete);
  // trusted source, non-paywall URL, non-complete tier → untouched
  assert.equal(applyPaywallTierOverride({ ...old, sourceMethod: 'manual-entry', contentTierReason: 'Paywall truncation: x' }, complete, now), complete);
  assert.equal(applyPaywallTierOverride({ ...old, url: VARIETY, contentTierReason: 'Paywall truncation: x' }, complete, now), complete);
  const excerpt = { contentTier: 'excerpt' };
  assert.equal(applyPaywallTierOverride({ ...old, contentTierReason: 'Paywall truncation: x' }, excerpt, now), excerpt);
});

test('applyPaywallTierOverride: soft-paywall label kept only while text is still under the host minimum', async () => {
  const now = Date.parse('2026-10-20T00:00:00Z');
  const complete = { contentTier: 'complete', tierReason: 'ok' };
  const base = { fullText: 'x'.repeat(1800), url: 'https://www.vulture.com/article/some-review.html', sourceMethod: 'scrapingbee', contentTierReason: 'Paywall truncation: 1800 chars < 2500 min for vulture.com (source: scrapingbee)' };
  const out = applyPaywallTierOverride(base, complete, now);
  assert.equal(out.contentTier, 'truncated');
  // longer text (a later full fetch) is no longer held back by the old label
  assert.equal(applyPaywallTierOverride({ ...base, fullText: 'x'.repeat(3000) }, complete, now), complete);
  // unlabelled soft-paywall file: left alone (historical corpus untouched)
  assert.equal(applyPaywallTierOverride({ ...base, contentTierReason: 'ok' }, complete, now), complete);
});

// BRO-7171 hand check of the NYT / New Yorker rows labelled truncated.
test('Off-Broadway NYT floor: a whole 4,000-char review passes, a Broadway one still needs 4,500', () => {
  const body = prose(4000);
  assert.equal(assessPaywallCompleteness(body, NYT, { category: 'off-broadway' }).complete, true);
  const broadway = assessPaywallCompleteness(body, NYT, { category: 'broadway' });
  assert.equal(broadway.complete, false);
  assert.ok(broadway.reasons.some((r) => r.startsWith('below_floor')));
  // no category: the old all-NYT floor (conservative)
  assert.equal(assessPaywallCompleteness(body, NYT).complete, false);
  // page one of an Off-Broadway review is still caught
  assert.equal(assessPaywallCompleteness(prose(2400), NYT, { category: 'off-broadway' }).complete, false);
});

test('NYT recirculation module after the info box no longer hides the ending', () => {
  const text = `${prose(3600)}\n\nMerry MeThrough Nov. 19 at New York Theater Workshop, Manhattan; nytw.org. Running time: 1 hour 30 minutes.\n\n`
    + '14Share full article14More on N.Y.C. Theater, Music and Dance‘Oh, Mary!,’ a Visual Tour: Cole Escola stars as a deranged Mary Todd Lincoln in this Broadway comedy.\n\n'
    + 'A Soprano With Dyslexia: Elza van den Heever no longer sees dyslexia as a hindrance, just a different way of learning.\n\n'
    + 'How ‘Wicked’ Changed the Lives of Its Stars: Only the women who have played Elphaba and Glinda understand why the roles are so taxing.';
  const a = assessPaywallCompleteness(text, NYT, { category: 'off-broadway' });
  assert.equal(a.infoBoxEnding, true);
  assert.equal(a.complete, true);
});

test('an NYT staff-bio last line marks the end of a whole article', () => {
  const text = `${prose(2200)}\n\nMichael Paulson is the theater reporter for The Times.`;
  const a = assessPaywallCompleteness(text, NYT);
  assert.equal(a.infoBoxEnding, true);
  assert.equal(a.complete, true);
  // the bare page-one shape (prose + byline) is still partial
  assert.equal(assessPaywallCompleteness(PAGE_ONE, NYT).complete, false);
});

test('a New Yorker listing capsule is judged against the capsule floor, not the magazine one', () => {
  const NYER = 'https://www.newyorker.com/goings-on-about-town/theatre/grey-house-07-10-23';
  const capsule = 'The Theatre Grey House By Dan Stahl June 30, 2023 A married couple, wandering through the woods after getting in a car accident, come across a cabin. '
    + 'Nobody answers the door, so they let themselves in. Levi Holloway’s “Grey House” is as smart as it is scary, and Joe Mantello directs one hell of a show. '
    + 'The cabin turns out to be inhabited by the foulmouthed Raleigh, plus four oddball girls and a silent boy who might be her children. '
    + '(Lyceum; through Sept. 3.) Published in the print edition of the July 10 & 17, 2023 , issue.';
  assert.equal(assessPaywallCompleteness(capsule, NYER).complete, true);
  // A magazine review cut to the same length is still partial.
  const magazine = 'Will the musical make fetch happen? ' + prose(700);
  assert.equal(assessPaywallCompleteness(magazine, 'https://www.newyorker.com/magazine/2018/03/26/x').complete, false);
});
