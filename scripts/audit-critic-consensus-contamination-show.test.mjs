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

test('audit({onlyShow}) excludes every other show (non-vacuous)', { skip: !haveTexts && 'needs data/review-texts (private repo)' }, () => {
  const all = audit();
  const consensusIds = Object.keys(JSON.parse(fs.readFileSync(new URL('../data/critic-consensus.json', import.meta.url), 'utf8')).shows);
  const otherId = consensusIds.find(id => !all.some(i => i.id === id)) || consensusIds[0];
  for (const issue of all) {
    // scoping to a different show must never surface this issue
    if (issue.id === otherId) continue;
    assert.ok(audit({ onlyShow: otherId }).every(i => i.id === otherId), 'scoped audit leaked another show');
    break;
  }
  if (all.length) {
    const scopedToIssue = audit({ onlyShow: all[0].id });
    assert.deepEqual(scopedToIssue.map(i => i.id), [all[0].id]);
  }
});

test('--show with an id that has no consensus entry exits 2, never passes', { skip: !haveTexts && 'needs data/review-texts (private repo)' }, () => {
  const r = spawnSync('node', [SCRIPT, '--show=__no-such-show__'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /no consensus entry/);
});
