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
