import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const lib = require('./lib/scoring-delta-data-inputs.js');

const reg = (o) => ({ outlets: o });
const base = reg({ nyt: { tier: 1, aliases: ['NYT'] }, blog: { tier: 3 } });

test('tier change on an outlet with reviews is significant', () => {
  const work = reg({ nyt: { tier: 2, aliases: ['NYT'] }, blog: { tier: 3 } });
  const r = lib.compareOutletRegistry(base, work, { nyt: 40 });
  assert.equal(r.status, 'changed');
  assert.equal(r.significant, true);
  assert.equal(r.changes[0].fields[0].field, 'tier');
});

test('cvStyle restore is detected (BRO-2776 shape)', () => {
  const work = reg({ nyt: { tier: 1, aliases: ['NYT'], cvStyle: 'x' }, blog: { tier: 3 } });
  assert.equal(lib.compareOutletRegistry(base, work, { nyt: 1 }).significant, true);
});

test('field change on a zero-review outlet is changed but not significant', () => {
  const work = reg({ nyt: { tier: 1, aliases: ['NYT'] }, blog: { tier: 2 } });
  const r = lib.compareOutletRegistry(base, work, {});
  assert.equal(r.status, 'changed');
  assert.equal(r.significant, false);
});

test('alias change is significant even with zero reviews (resolution drift)', () => {
  const work = reg({ nyt: { tier: 1, aliases: ['NYT', 'Times NY'] }, blog: { tier: 3 } });
  assert.equal(lib.compareOutletRegistry(base, work, {}).significant, true);
});

test('removed outlet is significant; added outlet alone is not', () => {
  assert.equal(lib.compareOutletRegistry(base, reg({ nyt: base.outlets.nyt }), {}).significant, true);
  const added = lib.compareOutletRegistry(base, reg({ ...base.outlets, fresh: { tier: 3 } }), {});
  assert.equal(added.status, 'changed');
  assert.equal(added.significant, false);
});

test('displayName change and alias takeover by an added outlet are significant', () => {
  const dn = reg({ nyt: { tier: 1, aliases: ['NYT'], displayName: 'X' }, blog: { tier: 3 } });
  assert.equal(lib.compareOutletRegistry(base, dn, {}).significant, true);
  const take = reg({ ...base.outlets, usurper: { tier: 3, aliases: ['nyt'] } });
  const r = lib.compareOutletRegistry(base, take, {});
  assert.deepEqual(r.takeovers, ['usurper']);
  assert.equal(r.significant, true);
});

test('automation metadata is ignored', () => {
  const work = reg({ nyt: { tier: 1, aliases: ['NYT'], regionInferredAt: 'now' }, blog: { tier: 3 } });
  assert.equal(lib.compareOutletRegistry(base, work, { nyt: 5 }).status, 'unchanged');
});

test('unreadable side is unobservable, never unchanged', () => {
  assert.equal(lib.compareOutletRegistry(null, base, {}).status, 'unobservable');
  assert.equal(lib.compareOutletRegistry(base, null, {}).status, 'unobservable');
  assert.equal(lib.compareHashedInput(null, Buffer.from('a')).status, 'unobservable');
  assert.equal(lib.compareHashedInput(Buffer.from('a'), Buffer.from('b')).significant, true);
  assert.equal(lib.compareHashedInput(Buffer.from('a'), Buffer.from('a')).status, 'unchanged');
});

test('describeCoverage names uninspected inputs', () => {
  const rep = { inputs: [{ name: 'A', status: 'unchanged' }, { name: 'B', status: 'unobservable' }], unobservable: ['B'], significant: false };
  assert.match(lib.describeCoverage(rep), /NOT inspected: B/);
});

// End to end: a registry edit in a temp git repo must not reach the green line.
test('inspectDataInputs sees an uncommitted registry edit vs HEAD', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-inputs-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data/outlet-registry.json'), JSON.stringify(base));
  fs.writeFileSync(path.join(dir, 'data/reviews.json'), JSON.stringify({ reviews: [{ outletId: 'nyt' }] }));
  git('init', '-q'); git('add', '-A'); git('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'x');
  const none = lib.inspectDataInputs({ repoRoot: dir, baseRef: 'HEAD', coreDataDir: path.join(dir, 'nope') });
  assert.equal(none.significant, false);
  assert.deepEqual(none.unobservable, ['data/critic-registry.json (vs private core-data HEAD)']);
  fs.writeFileSync(path.join(dir, 'data/outlet-registry.json'), JSON.stringify(reg({ nyt: { tier: 3, aliases: ['NYT'] }, blog: { tier: 3 } })));
  const edited = lib.inspectDataInputs({ repoRoot: dir, baseRef: 'HEAD', coreDataDir: path.join(dir, 'nope') });
  assert.equal(edited.significant, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scoring-delta.js wires the guard before both green exits', () => {
  const src = fs.readFileSync(new URL('./scoring-delta.js', import.meta.url), 'utf8');
  assert.match(src, /dataInputDrift/);
  const greens = [...src.matchAll(/✅ (No changes to inclusion|Nothing meaningful to replay)/g)];
  assert.equal(greens.length, 2);
  for (const g of greens) {
    const before = src.slice(Math.max(0, g.index - 900), g.index);
    assert.match(before, /if \(dataInputDrift\)/, 'green exit lacks the data-input guard');
  }
});
