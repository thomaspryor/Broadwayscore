// Regression guard for a leading raw <img> tag artifact found while recovering
// BRO-4154 punctuation-nulled reviews: Theatre Weekly's Dog Man review started
// with a full star-rating <img srcset="..."> tag before any review prose.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stripLeadingHtmlArtifacts, cleanText } = require('./text-cleaning.js');

const REAL_LEAKED_IMG_TAG = '<img decoding="async" class="alignnone size-medium wp-image-1170" title="" '
  + 'src="https://eghcszbxego.exactdn.com/wp-content/uploads/2015/10/New-3star-350x71.png?strip=all" '
  + 'alt="" width="350" height="71" srcset="https://eghcszbxego.exactdn.com/wp-content/uploads/2015/10/New-3star-350x71.png?strip=all '
  + '350w" sizes="(max-width: 350px) 100vw, 350px" data-eio="l" />';

test('stripLeadingHtmlArtifacts removes a leading <img> tag with a long srcset', () => {
  const text = `${REAL_LEAKED_IMG_TAG}Dog Man the Musical lands in London with a whimper rather than a woof.`;
  const out = stripLeadingHtmlArtifacts(text);
  assert.equal(out, 'Dog Man the Musical lands in London with a whimper rather than a woof.');
});

test('stripLeadingHtmlArtifacts strips multiple leading void tags (picture > source > img)', () => {
  const text = '<picture><source srcset="a.webp"/><img src="a.png"/></picture>Real review text starts here.';
  const out = stripLeadingHtmlArtifacts(text);
  assert.equal(out, 'Real review text starts here.');
});

test('stripLeadingHtmlArtifacts leaves prose with no leading tag untouched', () => {
  const text = 'A perfectly normal review with no HTML leakage at all.';
  assert.equal(stripLeadingHtmlArtifacts(text), text);
});

test('stripLeadingHtmlArtifacts does not touch a non-void tag it cannot safely unwrap', () => {
  // <div>/<p> etc. could wrap real content we don't want to discard silently —
  // only void/self-closing image-ish tags are stripped.
  const text = '<div class="review-body">Some review text.</div>';
  assert.equal(stripLeadingHtmlArtifacts(text), text);
});

test('cleanText integration: leaked <img> tag removed, real Dog Man review body intact', () => {
  const text = `${REAL_LEAKED_IMG_TAG}Dog Man the Musical, based on the graphic novel series, lands in London with a whimper rather than a woof.`;
  const cleaned = cleanText(text);
  assert.ok(!cleaned.includes('<img'), 'leaked <img> tag should be stripped');
  assert.ok(cleaned.startsWith('Dog Man the Musical'), `expected clean start, got: ${cleaned.slice(0, 60)}`);
});
