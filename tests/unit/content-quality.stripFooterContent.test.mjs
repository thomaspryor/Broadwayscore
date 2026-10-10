// BRO-2860: isGarbageContent exempts ad-blocker / paywall / legal / newsletter chrome
// that is trailing (newsletter also leading) on a real review, on the promise that it
// is stripped later. stripExemptedChrome() is that cleanup; collect-review-texts.js
// calls it after cleanText(). stripFooterContent (dead, lossy) was removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const cq = require('../../scripts/lib/content-quality.js');

const PARA = 'The musical theatre production opens with a stirring ensemble number; the cast, the director and the orchestra deliver a performance of real stage craft, and the show earns its ovation at the Broadway theater.';
const body = Array.from({ length: 8 }, (_, i) => `${PARA} Paragraph ${i + 1}.`).join('\n\n');
const CLOSING = 'Who cares if the men hang? The final scene is the best of the night.';

const CHROME = {
  adBlocker: 'We noticed you\'re using an ad blocker. Please disable your ad blocker to read this review.',
  paywall: 'Subscribe to continue reading this article.',
  legal: '© 2026 New Statesman Media Group. All rights reserved.',
  newsletter: 'Sign up for our newsletter to get the latest updates.',
};

test('stripFooterContent is gone and stripExemptedChrome is exported', () => {
  assert.equal(cq.stripFooterContent, undefined);
  assert.equal(typeof cq.stripExemptedChrome, 'function');
});

for (const [name, chrome] of Object.entries(CHROME)) {
  test(`trailing ${name} chrome is removed, closing paragraph kept`, () => {
    const text = `${body}\n\n${CLOSING}\n\n${chrome}`;
    // Precondition: the exemption applies (otherwise this test proves nothing)
    assert.equal(cq.isGarbageContent(text).isGarbage, false, 'exemption should apply');
    const out = cq.stripExemptedChrome(text);
    assert.ok(out.includes(CLOSING), 'closing paragraph must survive');
    assert.ok(!out.includes(chrome), `${name} chrome must be gone`);
    assert.ok(out.length > text.length * 0.9);
  });
}

test('leading newsletter header is removed', () => {
  const text = `Thanks for subscribing!\n\n${body}\n\n${CLOSING}`;
  assert.equal(cq.isGarbageContent(text).isGarbage, false);
  const out = cq.stripExemptedChrome(text);
  assert.ok(!/thanks for subscribing/i.test(out));
  assert.ok(out.includes(CLOSING));
});

test('review text with no chrome is returned unchanged', () => {
  const text = `${body}\n\n${CLOSING}`;
  assert.equal(cq.stripExemptedChrome(text), text);
});

test('long prose line mentioning a trigger phrase is not deleted', () => {
  const prose = `${PARA} ${PARA} ${PARA} The critic notes the production would make you subscribe to continue buying tickets.`;
  const text = `${body}\n\n${prose}`;
  assert.equal(cq.stripExemptedChrome(text), text);
});

test('short or single-line text is untouched', () => {
  assert.equal(cq.stripExemptedChrome('short'), 'short');
  const one = `${PARA} ${CHROME.paywall}`.repeat(4);
  assert.equal(cq.stripExemptedChrome(one), one);
});

test('collect-review-texts.js wires stripExemptedChrome after cleanText', () => {
  const src = fs.readFileSync(new URL('../../scripts/collect-review-texts.js', import.meta.url), 'utf8');
  assert.match(src, /stripExemptedChrome\(cleanText\(text\)/);
});

test('exemption comments no longer promise cleanText()', () => {
  const src = fs.readFileSync(new URL('../../scripts/lib/content-quality.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /let cleanText\(\) strip it/);
  assert.doesNotMatch(src, /stripFooterContent removes/);
});

test('each chrome fixture is actually detected (exemption precondition is real)', () => {
  assert.ok(cq.detectAdBlocker(CHROME.adBlocker).detected);
  assert.ok(cq.detectPaywall(CHROME.paywall).detected);
  assert.ok(cq.detectLegalPage(CHROME.legal).detected);
  assert.ok(cq.detectNewsletter(CHROME.newsletter).detected);
});

test('short closing prose line containing a paywall-ish phrase is kept', () => {
  const closing = 'The finale, set in a speakeasy for members only, lands with real force and a standing ovation.';
  const text = `${body}\n\n${closing}`;
  assert.equal(cq.stripExemptedChrome(text), text);
});

test('strip that would flip the text to garbage is abandoned', () => {
  const text = `${body}\n\nThe lounge is for members only, a nice touch for the theater crowd.\n\n${CLOSING}\n\n${CHROME.paywall}`;
  const before = cq.isGarbageContent(text).isGarbage;
  const out = cq.stripExemptedChrome(text);
  assert.equal(cq.isGarbageContent(out).isGarbage, before === false ? false : cq.isGarbageContent(out).isGarbage);
  if (!before) assert.equal(cq.isGarbageContent(out).isGarbage, false);
});

test('one-sentence closing prose with a paywall-ish phrase is kept (repro from review)', () => {
  for (const closing of [
    'Already a member of the EGOT club, she earns every ovation here.',
    'Premium content, indeed: this is the best Broadway show of the season.',
    'Become a member of the club, she sings the finale with real abandon.',
  ]) {
    const text = `${body}\n\n${closing}`;
    assert.ok(cq.stripExemptedChrome(text).includes(closing.slice(0, 20)), closing);
  }
});
