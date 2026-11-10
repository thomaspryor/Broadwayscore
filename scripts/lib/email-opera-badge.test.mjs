import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { metadataPills, rowMarketLabel } = require('../send-opening-digest.js');

// BRO-7311: ENO Iphigenie en Tauride (type opera, category west-end) rendered
// OPERA + WEST END pills in the digest; the site suppresses the market pill.
test('opera rows never carry a market pill in the digest', () => {
  for (const market of ['west-end', 'off-west-end', 'off-broadway']) {
    const html = metadataPills({ type: 'opera', market, isRevival: false });
    assert.match(html, /OPERA/i);
    assert.doesNotMatch(html, /WEST END|Off-WE|OFF-BROADWAY/);
  }
});

test('non-opera rows keep their market pill', () => {
  assert.match(metadataPills({ type: 'musical', market: 'west-end', isRevival: false }), /WEST END/);
  assert.match(metadataPills({ type: 'play', market: 'off-broadway', isRevival: true }), /OFF-BROADWAY/);
});

test('compact-row label says Opera for opera shows, market for the rest', () => {
  assert.equal(rowMarketLabel({ type: 'opera' }, 'west-end'), 'Opera');
  assert.equal(rowMarketLabel({ type: 'musical' }, 'west-end'), 'West End');
});
