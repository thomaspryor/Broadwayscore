// BRO-7579: --show=<id> scopes the consensus audit to one show, so a card's VERIFY
// tests its own show instead of the whole corpus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const SCRIPT = new URL('./audit-critic-consensus-contamination.js', import.meta.url).pathname;
const { audit } = require('./audit-critic-consensus-contamination.js');
const haveTexts = fs.existsSync(new URL('../data/review-texts', import.meta.url).pathname)
  && fs.existsSync(new URL('../data/critic-consensus.json', import.meta.url).pathname);

test('audit({onlyShow}) returns only that show and agrees with the full audit', { skip: !haveTexts && 'needs data/review-texts (private repo)' }, () => {
  const all = audit();
  const consensusIds = Object.keys(JSON.parse(fs.readFileSync(new URL('../data/critic-consensus.json', import.meta.url), 'utf8')).shows);
  const someId = (all[0] && all[0].id) || consensusIds[0];
  const scoped = audit({ onlyShow: someId });
  assert.deepEqual(scoped, all.filter(i => i.id === someId));
  assert.ok(scoped.every(i => i.id === someId));
});

test('--show with an id that has no consensus entry exits 2, never passes', { skip: !haveTexts && 'needs data/review-texts (private repo)' }, () => {
  const r = spawnSync('node', [SCRIPT, '--show=__no-such-show__'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /no consensus entry/);
});
