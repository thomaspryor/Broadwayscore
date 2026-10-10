/**
 * BRO-4947: outlet-id migrations. Per CLAUDE.md rule 15 these require() the real rules
 * and run the real script against a temp review-texts tree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MIGRATIONS, planOutletMigration, hostOf, sameArticleUrl, chooseKeeper, keeperScore } = require('../../scripts/lib/outlet-id-migrations.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'migrate-outlet-ids.js');

const DCMETRO = { outletId: 'dctheatrescene', outlet: 'DC Theatre Scene', criticName: 'Richard Seff', url: 'https://dcmetrotheaterarts.com/2016/12/09/review-bronx-tale/', assignedScore: 80 };
const DCTS = { outletId: 'dctheatrescene', outlet: 'DC Theatre Scene', criticName: 'Jonathan Mandell', url: 'https://www.dctheatrescene.com/2016/12/09/bronx-tale/', assignedScore: 70 };

test('hostOf strips www and lowercases; junk gives empty string', () => {
  assert.equal(hostOf('https://www.DCMetroTheaterArts.com/x'), 'dcmetrotheaterarts.com');
  assert.equal(hostOf('not a url'), '');
  assert.equal(hostOf(undefined), '');
});

test('dctheatrescene rows split by site: dcmetrotheaterarts.com moves, dctheatrescene.com stays', () => {
  const moved = planOutletMigration(DCMETRO, 'dctheatrescene--richard-seff.json');
  assert.equal(moved.to, 'dc-theater-arts');
  assert.equal(moved.newFilename, 'dc-theater-arts--richard-seff.json');
  assert.equal(moved.newData.outletId, 'dc-theater-arts');
  assert.equal(moved.newData.outlet, 'DC Theater Arts');
  assert.equal(moved.newData.assignedScore, 80, 'everything else is preserved');
  assert.equal(planOutletMigration(DCTS, 'dctheatrescene--jonathan-mandell.json'), null);
  assert.equal(planOutletMigration({ ...DCTS, url: null }, 'dctheatrescene--unknown.json'), null, 'no url: needs a human');
});

test('a dctheatrescene row that is really Bob\'s Theater Blog moves there', () => {
  const r = planOutletMigration({ outletId: 'dctheatrescene', url: 'https://bobs-theater-blog.blogspot.com/2019/x.html' }, 'dctheatrescene--robert-sholiton.json');
  assert.equal(r.to, 'bobs-theater-blog');
  assert.equal(r.newFilename, 'bobs-theater-blog--robert-sholiton.json');
});

test('duplicate ids merge into the canonical one regardless of url', () => {
  const a = planOutletMigration({ outletId: 'dc-metro-theater-arts', url: 'https://dcmetrotheaterarts.com/x' }, 'dc-metro-theater-arts--deb-miller.json');
  assert.equal(a.newFilename, 'dc-theater-arts--deb-miller.json');
  const g = planOutletMigration({ outletId: 'gotham-playgoer', url: null }, 'gotham-playgoer--robert-sholiton.json');
  assert.equal(g.to, 'bobs-theater-blog');
  assert.equal(g.newData.outlet, "Bob's Theater Blog");
});

test('the filename prefix counts when the outletId field is missing, and unrelated outlets are untouched', () => {
  assert.equal(planOutletMigration({ url: null }, 'gotham-playgoer--x.json').to, 'bobs-theater-blog');
  assert.equal(planOutletMigration({ outletId: 'nytimes' }, 'nytimes--jesse-green.json'), null);
  assert.equal(planOutletMigration(null, 'x--y.json'), null);
  assert.equal(planOutletMigration({ outletId: 'gotham-playgoer' }, 'nodashes.json'), null);
});

test('every rule targets an id that is not one of its own sources', () => {
  for (const m of MIGRATIONS) assert.ok(!m.from.includes(m.to), m.id);
});

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oid-'));
  for (const [rel, rec] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(rec));
  }
  return dir;
}
function run(dir, ...args) {
  return execFileSync('node', [SCRIPT, ...args], { env: { ...process.env, REVIEW_TEXTS_DIR: dir }, encoding: 'utf8' });
}

test('script: dry run changes nothing; --apply renames, rewrites the record, and leaves conflicts alone', () => {
  const dir = tree({
    'a-bronx-tale-2007/dctheatrescene--richard-seff.json': { ...DCMETRO, showId: 'a-bronx-tale-2007' },
    'a-bronx-tale-2007/dctheatrescene--jonathan-mandell.json': { ...DCTS, showId: 'a-bronx-tale-2007' },
    'cats-2016/gotham-playgoer--robert-sholiton.json': { outletId: 'gotham-playgoer', criticName: 'Robert Sholiton', url: 'https://gotham-playgoer.blogspot.com/a', showId: 'cats-2016' },
    // destination already exists -> conflict, source untouched
    'hamilton-2015/dc-metro-theater-arts--deb-miller.json': { outletId: 'dc-metro-theater-arts', url: 'https://dcmetrotheaterarts.com/h', showId: 'hamilton-2015' },
    'hamilton-2015/dc-theater-arts--deb-miller.json': { outletId: 'dc-theater-arts', url: 'https://dctheaterarts.org/h', showId: 'hamilton-2015' },
  });
  const out = run(dir);
  assert.match(out, /DRY RUN/);
  assert.match(out, /matched 3, same-article duplicates 0, conflicts 1/);
  assert.ok(fs.existsSync(path.join(dir, 'a-bronx-tale-2007/dctheatrescene--richard-seff.json')), 'dry run keeps the file');

  const applied = run(dir, '--apply');
  assert.match(applied, /moved 2/);
  assert.ok(!fs.existsSync(path.join(dir, 'a-bronx-tale-2007/dctheatrescene--richard-seff.json')));
  const moved = JSON.parse(fs.readFileSync(path.join(dir, 'a-bronx-tale-2007/dc-theater-arts--richard-seff.json'), 'utf8'));
  assert.equal(moved.outletId, 'dc-theater-arts');
  assert.equal(moved.outlet, 'DC Theater Arts');
  assert.ok(fs.existsSync(path.join(dir, 'a-bronx-tale-2007/dctheatrescene--jonathan-mandell.json')), 'dctheatrescene.com row stays');
  assert.ok(fs.existsSync(path.join(dir, 'cats-2016/bobs-theater-blog--robert-sholiton.json')));
  assert.ok(fs.existsSync(path.join(dir, 'hamilton-2015/dc-metro-theater-arts--deb-miller.json')), 'conflicting source is left in place');
  assert.match(applied, /CONFLICT hamilton-2015\/dc-metro-theater-arts--deb-miller\.json/);
  assert.throws(() => run(dir, '--strict'), /./, '--strict exits non-zero while a conflict remains');
});

test('script: two sources that map to one destination in the same run conflict instead of overwriting', () => {
  const dir = tree({
    's-2020/dc-metro-theater-arts--x.json': { outletId: 'dc-metro-theater-arts', url: 'https://dcmetrotheaterarts.com/1', showId: 's-2020' },
    's-2020/dctheatrescene--x.json': { outletId: 'dctheatrescene', url: 'https://dcmetrotheaterarts.com/2', showId: 's-2020' },
  });
  const out = run(dir);
  assert.match(out, /matched 2, same-article duplicates 0, conflicts 1/);
});

test('sameArticleUrl ignores protocol, www, query, fragment and trailing slash; empty never matches', () => {
  assert.equal(sameArticleUrl('http://dcmetrotheaterarts.com/2015/a/', 'https://www.dcmetrotheaterarts.com/2015/a?x=1#y'), true);
  assert.equal(sameArticleUrl('https://a.com/1', 'https://a.com/2'), false);
  assert.equal(sameArticleUrl('', ''), false);
  assert.equal(sameArticleUrl(null, undefined), false);
});

test('chooseKeeper: an excluded copy loses, then scored beats unscored, then longer text, ties keep the destination', () => {
  const good = { assignedScore: 80, fullText: 'x'.repeat(5000) };
  assert.equal(chooseKeeper({ ...good, duplicateOf: 'a.json' }, good), 'incoming');
  assert.equal(chooseKeeper(good, { ...good, duplicateOf: 'a.json' }), 'destination');
  assert.equal(chooseKeeper({ fullText: 'x'.repeat(9000) }, { assignedScore: 70 }), 'incoming');
  assert.equal(chooseKeeper({ assignedScore: 70, fullText: 'x'.repeat(1000) }, { assignedScore: 70, fullText: 'x'.repeat(9000) }), 'incoming');
  assert.equal(chooseKeeper({ assignedScore: 70 }, { assignedScore: 70 }), 'destination');
  assert.ok(keeperScore({ wrongProduction: true, assignedScore: 90 }) < keeperScore({}));
});

test('script: the same article under both ids keeps the better copy and retargets duplicateOf pointers', () => {
  const dir = tree({
    // incoming (dc-metro) is the excluded duplicate; the dctheatrescene copy is the live one
    'waitress-2016/dc-metro-theater-arts--richard-seff.json': { outletId: 'dc-metro-theater-arts', url: 'http://dcmetrotheaterarts.com/w', duplicateOf: 'dctheatrescene--richard-seff.json', showId: 'waitress-2016' },
    'waitress-2016/dctheatrescene--richard-seff.json': { outletId: 'dctheatrescene', url: 'https://dcmetrotheaterarts.com/w', assignedScore: 77, fullText: 'x'.repeat(3000), showId: 'waitress-2016' },
    // a sibling that pointed at the file that will be replaced
    'waitress-2016/theatermania--someone.json': { outletId: 'theatermania', url: 'https://tm.com/w', duplicateOf: 'dctheatrescene--richard-seff.json', showId: 'waitress-2016' },
  });
  const out = run(dir, '--apply');
  assert.match(out, /same-article duplicates 1, conflicts 0/);
  const files = fs.readdirSync(path.join(dir, 'waitress-2016')).sort();
  assert.deepEqual(files, ['dc-theater-arts--richard-seff.json', 'theatermania--someone.json']);
  const kept = JSON.parse(fs.readFileSync(path.join(dir, 'waitress-2016/dc-theater-arts--richard-seff.json'), 'utf8'));
  assert.equal(kept.assignedScore, 77, 'the scored, non-duplicate copy is the one that stays');
  assert.equal(kept.outletId, 'dc-theater-arts');
  assert.equal(kept.duplicateOf, undefined);
  const sib = JSON.parse(fs.readFileSync(path.join(dir, 'waitress-2016/theatermania--someone.json'), 'utf8'));
  assert.equal(sib.duplicateOf, 'dc-theater-arts--richard-seff.json', 'sibling pointer follows the rename');
});

test('script: when the destination copy is the weaker one, the incoming copy replaces it', () => {
  const dir = tree({
    's-2019/dctheatrescene--deb-miller.json': { outletId: 'dctheatrescene', url: 'https://dcmetrotheaterarts.com/s', assignedScore: 66, fullText: 'x'.repeat(4000), showId: 's-2019' },
    's-2019/dc-theater-arts--deb-miller.json': { outletId: 'dc-theater-arts', url: 'https://dcmetrotheaterarts.com/s/', showId: 's-2019' },
  });
  const out = run(dir, '--apply');
  assert.match(out, /same-article duplicates 1, conflicts 0, moved 1/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 's-2019')), ['dc-theater-arts--deb-miller.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 's-2019/dc-theater-arts--deb-miller.json'), 'utf8')).assignedScore, 66);
});

test('script: dry run reports the same duplicates without touching anything', () => {
  const dir = tree({
    'w-2016/dc-metro-theater-arts--x.json': { outletId: 'dc-metro-theater-arts', url: 'http://dcmetrotheaterarts.com/w', duplicateOf: 'dctheatrescene--x.json', showId: 'w-2016' },
    'w-2016/dctheatrescene--x.json': { outletId: 'dctheatrescene', url: 'https://dcmetrotheaterarts.com/w', assignedScore: 77, showId: 'w-2016' },
  });
  assert.match(run(dir), /same-article duplicates 1, conflicts 0/);
  assert.equal(fs.readdirSync(path.join(dir, 'w-2016')).length, 2);
});
