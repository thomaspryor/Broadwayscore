// Unit tests for scripts/lib/commercial-citation-guards.js.
// Regression coverage for the 2026-07-20 finding: isUnsourcedRecouped() only
// checked that recoupedSource was truthy, so plain text with no URL (e.g.
// "Broadway News / Playbill") counted as a valid citation. hadestown shipped
// live with recouped=true, recoupedSource as unclickable plain text, and an
// empty sources[] — --strict never flagged it.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { isRealUrl, isUnsourcedRecouped } = require('../../scripts/lib/commercial-citation-guards');

describe('isRealUrl', () => {
  it('accepts http and https URLs', () => {
    assert.equal(isRealUrl('https://example.com/article'), true);
    assert.equal(isRealUrl('http://example.com/article'), true);
  });

  it('rejects plain text, even if non-empty', () => {
    assert.equal(isRealUrl('Broadway News / Playbill'), false);
  });

  it('rejects empty string, null, undefined', () => {
    assert.equal(isRealUrl(''), false);
    assert.equal(isRealUrl(null), false);
    assert.equal(isRealUrl(undefined), false);
  });

  it('rejects non-string values', () => {
    assert.equal(isRealUrl(12345), false);
    assert.equal(isRealUrl({ url: 'https://example.com' }), false);
  });
});

describe('isUnsourcedRecouped', () => {
  it('regression: plain-text recoupedSource with no sources[] is now flagged as unsourced', () => {
    // This is the exact shape hadestown shipped with live.
    const data = {
      recouped: true,
      recoupedSource: 'Broadway News / Playbill',
      sources: [],
    };
    assert.equal(isUnsourcedRecouped(data), true);
  });

  it('a real URL in recoupedSource counts as sourced', () => {
    const data = {
      recouped: true,
      recoupedSource: 'https://deadline.com/2019/11/hadestown-recoup-investment-broadway-1202782727/',
      sources: [],
    };
    assert.equal(isUnsourcedRecouped(data), false);
  });

  it('a real URL in sources[] counts as sourced even if recoupedSource is missing', () => {
    const data = {
      recouped: true,
      recoupedSource: undefined,
      sources: [{ type: 'trade', url: 'https://example.com/article', date: '2020-01-01' }],
    };
    assert.equal(isUnsourcedRecouped(data), false);
  });

  it('a sources[] entry with a non-URL string url does not count as sourced', () => {
    const data = {
      recouped: true,
      recoupedSource: null,
      sources: [{ type: 'trade', url: 'Playbill', date: null }],
    };
    assert.equal(isUnsourcedRecouped(data), true);
  });

  it('recouped=false is never flagged regardless of sourcing', () => {
    assert.equal(isUnsourcedRecouped({ recouped: false, recoupedSource: null, sources: [] }), false);
  });

  it('handles missing/malformed input without throwing', () => {
    assert.equal(isUnsourcedRecouped(null), false);
    assert.equal(isUnsourcedRecouped(undefined), false);
    assert.equal(isUnsourcedRecouped({}), false);
  });
});
