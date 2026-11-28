// BRO-8447: "the-dead-1904" is a title, not a year suffix. Requires the real function.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { stripProductionYearSuffix } = require('../../scripts/lib/slug-year.js');

describe('stripProductionYearSuffix', () => {
  it('keeps a year that is part of the title', () => {
    const show = { id: 'the-dead-1904-off-broadway-2026', slug: 'the-dead-1904', openingDate: '2026-11-24' };
    assert.equal(stripProductionYearSuffix(show), 'the-dead-1904');
  });
  it('strips the opening-year suffix', () => {
    assert.equal(stripProductionYearSuffix({ id: 'beetlejuice-2019', slug: 'beetlejuice-2019', openingDate: '2019-04-25' }), 'beetlejuice');
  });
  it('strips a suffix that matches the id year', () => {
    assert.equal(stripProductionYearSuffix({ id: 'art-2025', slug: 'art-2025' }), 'art');
  });
  it('leaves slugs without a year alone', () => {
    assert.equal(stripProductionYearSuffix({ id: 'hamilton-2015', slug: 'hamilton', openingDate: '2015-08-06' }), 'hamilton');
  });
});

describe('every slug year in shows.json is a production year or a known title year', () => {
  const p = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../data/shows.json');
  const have = fs.existsSync(p);
  it('lists the title-year slugs (guards new ones being stripped by accident)', { skip: !have && 'no shows.json' }, () => {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const list = d.shows || d;
    for (const s of list) {
      const kept = stripProductionYearSuffix(s) === s.slug && /-\d{4}$/.test(s.slug || '');
      if (kept) assert.equal(s.id, 'the-dead-1904-off-broadway-2026', `unexpected title-year slug ${s.slug}`);
    }
  });
});
