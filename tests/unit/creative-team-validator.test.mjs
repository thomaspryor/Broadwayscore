import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { isValidCreativeTeamName } = require('../../scripts/lib/ibdb-dates');

describe('isValidCreativeTeamName — legitimate names (regression guard)', () => {
  const legitimate = [
    'Tony Kushner',
    'Oscar Hammerstein II',
    'Oscar Wilde',
    'Tony Taccone',
    'Tony Meola',
    'Tony Walton',
    'dots',
    'The Avett Brothers',
    'The Rescues',
    'The Legendary Motown Catalog',
    'Stephen Sondheim',
    'Andrew Lloyd Webber',
    'Lin-Manuel Miranda',
    'Beyoncé',
    'Jerry Herman',
    'Jeanine Tesori',
    'Will Butler',
    'Will Van Dyke',
    'Will Aronson',
    'Will Frears',
    'Will Pickens',
    'Or Matias',
    'SCK Sound Design, Walter Trarbach and Andrew Keister',
    'David Cumming, Felix Hagan, Natasha Hodgson & Zoë Roberts',
  ];
  for (const name of legitimate) {
    test(`accepts ${JSON.stringify(name)}`, () => {
      assert.equal(isValidCreativeTeamName(name), true);
    });
  }
});

describe('isValidCreativeTeamName — junk from TodayTix regex bug', () => {
  const junk = [
    'Tony Award',
    'Tony Winner',
    'Tony Nominee',
    'Tony Award winner Alex Timbers',
    'Tony winner Harvey Fierstein',
    'Oscar Winner',
    'Grammy Award',
    'Pulitzer Prize winner',
    'Lifetime Achievement',
    'Tony-winning director',
    'of Disney',
    'and musical supervision',
    'based on the novel by Gregory Maguire',
    'Franklin Shepard and his two lifelong friends',
    'Andy Blankenbuehler and musical supervision and orchestrations by Alex Lacamoire',
    'of the company',
  ];
  for (const name of junk) {
    test(`rejects ${JSON.stringify(name)}`, () => {
      assert.equal(isValidCreativeTeamName(name), false);
    });
  }
});

describe('isValidCreativeTeamName — edge cases', () => {
  test('rejects null', () => assert.equal(isValidCreativeTeamName(null), false));
  test('rejects empty string', () => assert.equal(isValidCreativeTeamName(''), false));
  test('rejects non-string', () => assert.equal(isValidCreativeTeamName(42), false));
  test('rejects name > 70 chars', () => assert.equal(
    isValidCreativeTeamName('A'.repeat(71)), false
  ));
  test('rejects names with digits', () => assert.equal(
    isValidCreativeTeamName('John Doe 3rd'), false
  ));
});
