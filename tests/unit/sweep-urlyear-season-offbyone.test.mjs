// TESTS-VS-DERIVED-DATA-EXEMPT: asserts structural invariants (venue name present, URL years parse), not hardcoded facts that an audit would change
// BRO-3589: Playbill season-format URLs ("-2021-2022") must not be read as one opening year,
// and Roundabout shows must carry the real stage, not the parent org's admin name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { urlYears } = require('../../scripts/lib/venue-date-compare.js');

test('urlYears returns both halves of a season suffix', () => {
  assert.deepEqual(urlYears('https://playbill.com/production/six-the-musicallena-horne-theatre-2021-2022'), [2021, 2022]);
  assert.deepEqual(urlYears('https://playbill.com/production/hadestownwalter-kerr-theatre-2018-2019'), [2018, 2019]);
  assert.deepEqual(urlYears('https://playbill.com/production/some-show-studio-54-2024'), [2024]);
});

test('Roundabout Studio 54 shows are not recorded under the admin-org name', () => {
  const file = new URL('../../data/shows.json', import.meta.url);
  if (!fs.existsSync(file)) return; // core data not attached
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  for (const id of ['a-wonderful-world-the-louis-armstrong-musical-2024', 'pictures-from-home-2023', 'the-minutes-2022', 'the-sound-inside-2019']) {
    const s = shows.find((x) => x.id === id);
    if (!s) continue;
    assert.equal(s.venue, 'Studio 54', id);
  }
});
