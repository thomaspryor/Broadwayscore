import test from 'node:test';
import assert from 'node:assert/strict';
import { getBrowseSlug } from '../../src/lib/browse-slugs';

test('regional shows have no format browse page in either the US or UK', () => {
  for (const type of ['musical', 'play', 'opera', 'special'] as const) {
    assert.equal(getBrowseSlug('regional', type), null, `regional ${type}`);
  }
});

test('supported markets keep their musical and play browse pages', () => {
  const cases = [
    ['broadway', 'best-broadway-musicals', 'best-broadway-dramas'],
    [undefined, 'best-broadway-musicals', 'best-broadway-dramas'],
    ['west-end', 'best-west-end-musicals', 'best-west-end-plays'],
    ['off-west-end', 'best-off-west-end-musicals', 'best-off-west-end-plays'],
    ['off-broadway', 'best-off-broadway-musicals', 'best-off-broadway-plays'],
    ['tour', 'broadway-national-tours', 'broadway-national-tours'],
  ] as const;

  for (const [category, musicals, plays] of cases) {
    assert.equal(getBrowseSlug(category, 'musical'), musicals, `${category} musical`);
    assert.equal(getBrowseSlug(category, 'play'), plays, `${category} play`);
    assert.equal(getBrowseSlug(category, 'opera'), null, `${category} opera`);
    assert.equal(getBrowseSlug(category, 'special'), null, `${category} special`);
  }
});
