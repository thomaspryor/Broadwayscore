import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { buildCastLinkResolver } = createRequire(import.meta.url)('../lib/cast-link-slugs.js');

const shows = [{ id: 's1', category: 'broadway' }, { id: 's2', category: 'broadway' }];
const entry = (name, ibdbPersonId, showId = 's1', castType = 'current') => ({ showId, castType, name, ibdbPersonId, role: 'r' });

test('second identity with the same slug gets the -2 suffix, as on the site', () => {
  const r = buildCastLinkResolver([entry('Noel Coward', '1'), entry('Noël Coward', '2')], shows);
  assert.equal(r.slugFor('Noel Coward'), 'noel-coward');
  assert.equal(r.slugFor('Noël Coward'), 'noel-coward-2');
});

test('one name held by two identities is skipped, not guessed', () => {
  const r = buildCastLinkResolver([entry('Chris Evans', '1'), entry('Chris Evans', '2', 's2')], shows);
  assert.equal(r.slugFor('Chris Evans'), null);
});

test('unique name keeps its plain slug', () => {
  const r = buildCastLinkResolver([entry('José Quintero', '9')], shows);
  assert.equal(r.slugFor('José Quintero'), 'jose-quintero');
});

test('unknown spelling whose slug collides is skipped; otherwise plain slug', () => {
  const r = buildCastLinkResolver([entry('Noel Coward', '1'), entry('Noël Coward', '2')], shows);
  assert.equal(r.slugFor('NOEL COWARD'), null);
  assert.equal(r.slugFor('Someone New'), 'someone-new');
});

test('ignores cast of non-Broadway shows and empty input', () => {
  const r = buildCastLinkResolver([entry('A B', '1', 'gone')], shows);
  assert.equal(r.slugFor('A B'), 'a-b');
  assert.equal(buildCastLinkResolver(undefined, shows).slugFor('X Y'), 'x-y');
});

test('an older spelling of a renamed person counts toward ambiguity', () => {
  const r = buildCastLinkResolver([
    entry('Noel Coward', '1'),
    entry('Noel Coward', '2', 's2', 'obc'),
    entry('Noël Coward', '2', 's1', 'current'),
  ], shows);
  assert.equal(r.slugFor('Noel Coward'), null);
  assert.equal(r.slugFor('Noël Coward'), 'noel-coward-2');
});
