/**
 * displayCriticName rule 6: one displayed spelling per person.
 *
 * The same critic was shown with different spellings across shows (20
 * outlet-critic groups, 227 reviews on 2026 pages): "Juan A Ramírez" /
 * "Juan A Ramirez" / "Juan A. Ramirez", "Liam O’Dell" / "Liam O'Dell",
 * "Paul T Davies" / "Paul T. Davies", "Rafer Guzman" / "Rafer Guzmán",
 * "R Scott Reedy" / "R. Scott Reedy". critic-display-name.js loaded
 * critic-registry.json only for a person-shape check and never mapped a
 * spelling variant to the registry displayName. The fixture registry below
 * carries the real registry spellings (data/critic-registry.json is private
 * core data, so the test does not depend on it). The helper is required
 * (§15), never re-implemented here.
 *
 * Run: node --test tests/unit/critic-display-name-registry-spelling.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  displayCriticName,
  foldPersonName,
  registrySpelling,
  _useCriticRegistry,
} = require('../../scripts/lib/critic-display-name.js');

const REGISTRY = {
  critics: {
    'juan-a-ramirez': { displayName: 'Juan A. Ramirez', knownOutlets: ['nytimes', 'guardian', 'vogue'] },
    'liam-o-dell': { displayName: 'Liam O’Dell', knownOutlets: ['liamodell'] },
    'holly-o-mahony': { displayName: "Holly O'Mahony", knownOutlets: ['thestage', 'timeout-london'] },
    'paul-t-davies': { displayName: 'Paul T. Davies', knownOutlets: ['britishtheatrecom'] },
    'daniel-d-addario': { displayName: "Daniel D'Addario", knownOutlets: ['variety'] },
    'rafer-guzman': { displayName: 'Rafer Guzmán', knownOutlets: ['newsday'] },
    'r-scott-reedy': { displayName: 'R. Scott Reedy', knownOutlets: ['broadwayworld'] },
    // capture artifacts in the registry's own spelling get tidied, not adopted raw
    'marilyn-stasio': { displayName: 'Marilyn Stasio.', knownOutlets: ['variety'] },
    'rob-weinert-kendt': { displayName: 'Rob Weinert- Kendt', knownOutlets: ['vulture'] },
    'laura-collins-hughes': { displayName: 'Laura Collins Hughes', knownOutlets: ['nytimes'] },
    'andrew': { displayName: 'andrew', knownOutlets: ['x'] },
    // two genuinely different registry people whose names fold together
    'chris-smith': { displayName: 'Chris Smith', knownOutlets: ['outlet-a'] },
    'chris-smith-2': { displayName: 'Chris-Smith', knownOutlets: ['outlet-b'] },
    // apostrophe-less registry spelling: adopting it would move /critics/kate-o-donnell
    'kate-odonnell': { displayName: 'Kate ODonnell', knownOutlets: ['outlet-c'] },
  },
};

_useCriticRegistry(REGISTRY);
after(() => _useCriticRegistry(null));

test('foldPersonName equates accents, case, apostrophe style, periods', () => {
  assert.equal(foldPersonName('Juan A. Ramírez'), 'juan a ramirez');
  assert.equal(foldPersonName('Juan A Ramirez'), 'juan a ramirez');
  assert.equal(foldPersonName('Liam O’Dell'), foldPersonName("Liam O'Dell"));
  assert.equal(foldPersonName('D.L. Groover'), foldPersonName('D. L. Groover'));
});

test('spelling variants collapse to the registry displayName', () => {
  const table = [
    ['Juan A Ramirez', 'The Guardian', 'Juan A. Ramirez'],
    // accents are never dropped (S7-T1 rule): punctuation from the registry, accents from the byline
    ['Juan A Ramírez', 'The Guardian', 'Juan A. Ramírez'],
    ['Juan A. Ramírez', 'The New York Times', 'Juan A. Ramírez'],
    ['Paul T Davies', 'BritishTheatre.com', 'Paul T. Davies'],
    ['Rafer Guzman', 'Newsday', 'Rafer Guzmán'],
    ['R Scott Reedy', 'BroadwayWorld', 'R. Scott Reedy'],
  ];
  for (const [raw, outlet, want] of table) {
    assert.equal(displayCriticName(raw, outlet), want, `${raw} @ ${outlet}`);
  }
});

test('apostrophes display in one style (ASCII, the registry majority)', () => {
  assert.equal(displayCriticName('Liam O’Dell', 'Liam O’Dell'), "Liam O'Dell");
  assert.equal(displayCriticName("Liam O'Dell", 'Liam O’Dell'), "Liam O'Dell");
  assert.equal(displayCriticName('Holly O’Mahony', 'The Stage'), "Holly O'Mahony");
  assert.equal(displayCriticName("Holly O'Mahony", 'The Stage'), "Holly O'Mahony");
  assert.equal(displayCriticName('Daniel D’Addario', 'Variety'), "Daniel D'Addario");
  // not in the registry: still one apostrophe style
  assert.equal(displayCriticName('Shaad D’Souza', 'The New York Times'), "Shaad D'Souza");
});

test('registry capture artifacts are tidied before adoption', () => {
  assert.equal(displayCriticName('Marilyn Stasio', 'Variety'), 'Marilyn Stasio');
  assert.equal(displayCriticName('Rob Weinert-Kendt', 'Vulture'), 'Rob Weinert-Kendt');
});

test('a registry spelling that drops a hyphen or is lowercase is never adopted', () => {
  assert.equal(displayCriticName('Laura Collins-Hughes', 'The New York Times'), 'Laura Collins-Hughes');
  assert.equal(registrySpelling('Andrew', null), 'Andrew');
});

test('the curated fixes table outranks the registry spelling', () => {
  _useCriticRegistry({ critics: { ...REGISTRY.critics, 'ad-amorosi': { displayName: 'A. D. Amorosi', knownOutlets: ['variety'] } } });
  try {
    assert.equal(displayCriticName('A.D. Amorosi', 'Variety'), 'A.D. Amorosi');
    assert.equal(displayCriticName('A. D. Amorosi', 'Variety'), 'A.D. Amorosi');
  } finally {
    _useCriticRegistry(REGISTRY);
  }
});

test('two different registry names that fold together are left alone', () => {
  assert.equal(registrySpelling('CHRIS SMITH', null), 'CHRIS SMITH');
  assert.equal(registrySpelling('chris smith', 'some-other-outlet'), 'chris smith');
  // scoped by outlet when exactly one of them writes there
  assert.equal(registrySpelling('chris smith', 'outlet-a'), 'Chris Smith');
});

test('edge punctuation from capture is trimmed, initials keep their period', () => {
  assert.equal(displayCriticName('. Charles Spencer', 'The Telegraph'), 'Charles Spencer');
  assert.equal(displayCriticName('Tara Whenray.', 'Theatre South East'), 'Tara Whenray');
  assert.equal(displayCriticName('Dave B.', 'Everything Theatre'), 'Dave B.');
});

test('a registry spelling that would change the critic page slug is never adopted', () => {
  assert.equal(displayCriticName("Kate O'Donnell", 'outlet-c'), "Kate O'Donnell");
});
