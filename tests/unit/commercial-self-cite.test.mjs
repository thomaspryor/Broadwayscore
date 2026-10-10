// Unit tests for scripts/lib/commercial-self-cite.js (BRO-4990).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { isSelfUrl, findSelfReferences } = require('../../scripts/lib/commercial-self-cite');

describe('isSelfUrl', () => {
  it('matches our site, its subdomains and llms.txt, not look-alikes', () => {
    assert.equal(isSelfUrl('https://broadwayscorecard.com/biz/six'), true);
    assert.equal(isSelfUrl('https://www.broadwayscorecard.com/llms.txt'), true);
    assert.equal(isSelfUrl('https://notbroadwayscorecard.com.evil.io/x'), false);
    assert.equal(isSelfUrl('https://www.broadwaynews.com/six-recoups'), false);
  });
});

describe('findSelfReferences', () => {
  it('finds self urls in opened pages, search sources and answer citations', () => {
    const output = [
      { type: 'web_search_call', action: { type: 'search', query: 'six broadway recoup', sources: [{ url: 'https://broadwayscorecard.com/show/six' }] } },
      { type: 'web_search_call', action: { type: 'open_page', url: 'https://www.broadwayscorecard.com/llms.txt' } },
      { type: 'web_search_call', action: { type: 'open_page', url: 'https://playbill.com/article/six' } },
      { type: 'message', content: [{ type: 'output_text', text: '{}', annotations: [
        { type: 'url_citation', url: 'https://broadwayscorecard.com/show/six' },
        { type: 'url_citation', url: 'https://variety.com/six' },
      ] }] },
    ];
    assert.deepEqual(findSelfReferences(output), [
      'https://broadwayscorecard.com/show/six',
      'https://www.broadwayscorecard.com/llms.txt',
    ]);
  });

  it('returns nothing for a clean answer or missing output', () => {
    assert.deepEqual(findSelfReferences([{ type: 'web_search_call', action: { type: 'search' } }]), []);
    assert.deepEqual(findSelfReferences(undefined), []);
  });
});
