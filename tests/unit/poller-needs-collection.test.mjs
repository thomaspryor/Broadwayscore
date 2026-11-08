// BRO-7160: a targeted opening-night-poller run (the post-lane sweep) collects text for reviews already on disk whose
// full text was never fetched, even when the poll itself wrote nothing new.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { reviewNeedsCollection, showNeedsCollection, FULL_TEXT_MIN } = require('../../scripts/lib/poller-needs-collection.js');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const URL_ = 'https://www.nytimes.com/2026/11/09/theater/wanted-review.html';
const long = 'x'.repeat(FULL_TEXT_MIN + 10);

test('reviews with missing, excerpt, stub or truncated text need collection', () => {
  assert.equal(reviewNeedsCollection({ url: URL_ }), true, 'no text at all');
  assert.equal(reviewNeedsCollection({ url: URL_, fullText: 'A short excerpt.' }), true);
  assert.equal(reviewNeedsCollection({ url: URL_, contentTier: 'excerpt', fullText: long }), true);
  assert.equal(reviewNeedsCollection({ url: URL_, contentTier: 'stub' }), true);
  assert.equal(reviewNeedsCollection({ url: URL_, textQuality: 'truncated', fullText: long }), true);
});

test('complete, excluded, non-review, duplicate and URL-less files do not', () => {
  assert.equal(reviewNeedsCollection({ url: URL_, fullText: long }), false, 'long text');
  assert.equal(reviewNeedsCollection({ url: URL_, contentTier: 'complete', fullText: 'short' }), false);
  assert.equal(reviewNeedsCollection({ url: URL_, isFullReview: true }), false);
  for (const flag of ['wrongProduction', 'wrongShow', 'isRoundupArticle']) assert.equal(reviewNeedsCollection({ url: URL_, [flag]: true }), false, flag);
  assert.equal(reviewNeedsCollection({ url: URL_, rejectionReason: 'not_a_review' }), false);
  assert.equal(reviewNeedsCollection({ url: '' }), false);
  const sib = new Map([['nyt--a.json', { url: URL_, fullText: long }]]);
  assert.equal(reviewNeedsCollection({ url: URL_, duplicateOf: 'nyt--a.json' }, sib), false, 'duplicate pointing at a canonical');
  assert.equal(reviewNeedsCollection({ url: URL_, duplicateOf: 'missing.json' }, sib), true, 'dangling duplicate still needs text');
});

test('a show folder: counts review files only, the CLI prints the count the workflow reads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnc-'));
  const dir = path.join(root, 'wanted-2022');
  fs.mkdirSync(dir);
  const w = (n, o) => fs.writeFileSync(path.join(dir, n), typeof o === 'string' ? o : JSON.stringify(o));
  w('nytimes--jesse-green.json', { url: URL_, contentTier: 'excerpt' });
  w('vulture--sara-holdren.json', { url: 'https://www.vulture.com/x', fullText: long });
  w('_meta.json', { url: URL_ });
  w('broken.json', '{not json');
  w('notes.txt', 'ignore');
  assert.deepEqual(showNeedsCollection(dir), ['nytimes--jesse-green.json']);
  assert.deepEqual(showNeedsCollection(path.join(root, 'no-such-show')), []);
  const out = execFileSync('node', ['scripts/lib/poller-needs-collection.js', 'wanted-2022', `--dir=${root}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(out.trim(), '1');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the poller wires needs_collection into every post-collect gate (targeted runs only)', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/opening-night-poller.yml'), 'utf8');
  const stepIf = (name) => {
    const i = yml.indexOf(`- name: ${name}`);
    assert.ok(i >= 0, `step ${name}`);
    return yml.slice(i, yml.indexOf('\n      - name:', i + 1));
  };
  for (const name of ['Collect full text inline', 'Commit collected texts', 'Flag combined (joint) reviews', 'Commit combined-review flags']) {
    assert.match(stepIf(name), /if:[^\n]*steps\.poll\.outputs\.any_collect == 'true'/, name);
  }
  assert.match(stepIf('Collect full text inline'), /SHOW_FILTER: \$\{\{ steps\.poll\.outputs\.any_new == 'true' && steps\.find\.outputs\.shows \|\| steps\.poll\.outputs\.collect_shows \}\}/);
  assert.match(yml, /COLLECT_ATTEMPTED_RAW: \$\{\{ steps\.poll\.outputs\.any_collect \}\}/);
  // Only a run that asks for it (the post-lane sweep), never every targeted run: the orchestrator's press-night loop
  // dispatches targeted runs too, and an unfetchable excerpt would make each of them collect, rebuild and deploy.
  assert.match(yml, /if \[ -n "\$INPUT_SHOW_ID" \] && \[ "\$INPUT_COLLECT_EXISTING" = "true" \]; then\n\s+NEED_COLLECT=\$\(node scripts\/lib\/poller-needs-collection\.js "\$SHOW_ID"/);
  assert.match(yml, /INPUT_COLLECT_EXISTING: \$\{\{ inputs\.collect_existing \}\}/);
  const orch = fs.readFileSync(new URL('../../.github/workflows/opening-night-orchestrator.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(orch, /collect_existing/, 'the orchestrator loop must not opt in');
  assert.match(yml, /\|\| \[ "\$NEEDS_COLLECTION" = "true" \]; then ANY_ACTION=true; fi/, 'scoring/rebuild/deploy follow a collection');
  assert.match(yml, /echo "any_collect=\$ANY_COLLECT" >> \$GITHUB_OUTPUT/);
  assert.match(yml, /INPUT_SHOW_ID: \$\{\{ inputs\.show_id \}\}/);
});
