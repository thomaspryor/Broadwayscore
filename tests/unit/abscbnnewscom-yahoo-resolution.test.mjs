// LIVE-DATA-LANE: reads data/pending-fixes/bro-4504.json (read by the test); data/pending-fixes/bro-4504-3.json (read by the test); data/shows.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { executeReviewFieldEditIn } = require('../../scripts/lib/review-field-edit.js');
const { moveReviewFile } = require('../../scripts/lib/review-file-move.js');
const { _setShowsCacheForTest } = require('../../scripts/lib/review-write-guard.js');
const { explainExclusion } = require('../../scripts/lib/review-guards.js');
const { resolveOutletFromUrl } = require('../../scripts/lib/review-normalization.js');
const plan = require('../../data/pending-fixes/bro-4504.json');
const filenamePlan = require('../../data/pending-fixes/bro-4504-3.json');
const root = path.resolve(import.meta.dirname, '../..');
const stamp = { fixId: plan.planId, at: '2026-10-25T00:00:00.000Z' };
const yahooFile = 'abscbnnewscom--mark-kennedy.json';
const apFile = 'ap--mark-kennedy.json';
const exeuntShow = 'the-saviors-off-broadway-2026';
const junkFile = 'exeunt-magazine--read-more-articles-by-lane-williamson.json';
const namedFile = 'exeunt-magazine--lane-williamson.json';
const phantom = 'the-phantom-of-the-opera-1988/abscbnnewscom--vladimir-bunoan.json';
const yahooUrls = [
  'https://news.yahoo.com/review-holland-taylors-ann-sweet-valentine-010858771.html',
  'https://news.yahoo.com/s/ap/20110420/ap_en_ot/us_theater_review_high_1',
];

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-4504-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); _setShowsCacheForTest(null); });
  return dir;
}

const read = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const write = (dir, file, data) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
};

function replay(dir, activePlan = plan) {
  for (const action of activePlan.plan.actions) {
    if (action.type === 'review-file-op') {
      if (action.operation === 'delete') fs.unlinkSync(path.join(dir, action.sourcePath));
      else {
        assert.equal(action.operation, 'rename');
        const result = moveReviewFile(dir, action.sourcePath, action.destPath);
        assert.equal(result.ok, true, result.reason);
      }
      continue;
    }
    assert.equal(action.type, 'review-field-edit');
    // An applied plan remains testable against the updated private snapshot.
    if (JSON.stringify(read(dir, action.file)[action.field]) === JSON.stringify(action.newValue)) continue;
    const result = executeReviewFieldEditIn(dir, action, stamp);
    assert.equal(result.ok, true, result.reason);
  }
}

test('BRO-4504: the Yahoo hosts stay unresolved after the existing BRO-4502 writer fix', () => {
  for (const url of yahooUrls) assert.equal(resolveOutletFromUrl(url), null, url);
});

test('BRO-4504: the plan uses only scoped field edits and never overrides scores or rejection flags', () => {
  assert.deepEqual(plan.plan.actions.map(({ type, file, field, newValue }) => ({ type, file, field, newValue })), [
    ...['ann-2013', 'high-2011'].flatMap(showId => [
      { type: 'review-field-edit', file: `${showId}/${yahooFile}`, field: 'duplicateReason',
        newValue: plan.plan.actions.find(a => a.file === `${showId}/${yahooFile}` && a.field === 'duplicateReason').newValue },
      { type: 'review-field-edit', file: `${showId}/${yahooFile}`, field: 'duplicateOf', newValue: apFile },
    ]),
    { type: 'review-field-edit', file: `${exeuntShow}/${junkFile}`, field: 'criticName', newValue: 'Lane Williamson' },
  ]);
  for (const action of plan.plan.actions.filter(a => a.field === 'duplicateReason')) {
    assert.match(action.newValue, /AP.*Mark Kennedy/);
  }
});

test('BRO-4504: real field writer links both AP twins and fixes Exeunt without losing its scoreable copy', t => {
  const dir = scratch(t);
  const shows = [
    { id: 'ann-2013', title: 'Ann', openingDate: '2013-03-07', category: 'broadway' },
    { id: 'high-2011', title: 'High', openingDate: '2011-04-19', category: 'broadway' },
    { id: exeuntShow, title: 'The Saviors', openingDate: '2026-07-27', category: 'off-broadway' },
  ];
  _setShowsCacheForTest(new Map(shows.map(s => [s.id, s])));
  for (const [i, show] of shows.slice(0, 2).entries()) {
    write(dir, `${show.id}/${yahooFile}`, {
      showId: show.id, outletId: 'abscbnnewscom', criticName: 'Mark Kennedy', url: yahooUrls[i],
      dtliThumb: 'Up', assignedScore: i === 0 ? 75 : null,
    });
    write(dir, `${show.id}/${apFile}`, {
      showId: show.id, outletId: 'ap', criticName: 'Mark Kennedy', assignedScore: i === 0 ? 45 : 78,
      dtliThumb: 'Up', isNonReview: i === 1,
      fullText: i === 0 ? 'Ann is a thoughtful stage production with excellent acting and direction. '.repeat(10) : 'Page not found. '.repeat(30),
    });
  }
  const exeunt = { showId: exeuntShow, outletId: 'exeunt-magazine', assignedScore: 91,
    fullText: 'The Saviors is a compelling play with excellent performances and stage design. '.repeat(10),
    url: 'https://exeuntnyc.com/reviews/review-the-saviors-at-atlantic-theater-company/' };
  write(dir, `${exeuntShow}/${junkFile}`, { ...exeunt, criticName: 'Read more articles by Lane Williamson' });
  write(dir, `${exeuntShow}/${namedFile}`, { ...exeunt, criticName: 'Lane Williamson', duplicateOf: junkFile });
  write(dir, phantom, { outletId: 'abscbnnewscom', criticName: 'Vladimir Bunoan', wrongProduction: true });
  const untouched = [phantom, 'ann-2013/' + apFile, 'high-2011/' + apFile, `${exeuntShow}/${namedFile}`];
  const before = untouched.map(f => read(dir, f));

  replay(dir);

  for (const show of shows.slice(0, 2)) {
    const file = `${show.id}/${yahooFile}`;
    assert.equal(read(dir, file).duplicateOf, apFile);
    assert.ok(explainExclusion(read(dir, file), show, path.join(dir, file)), `${file} must stay out of the scored dataset`);
    assert.equal(read(dir, `${show.id}/${apFile}`).outletId, 'ap');
  }
  assert.deepEqual(untouched.map(f => read(dir, f)), before, 'canonical AP copies, excluded Exeunt twin and unrelated ABS-CBN review are untouched');
  assert.equal(explainExclusion(read(dir, 'ann-2013/' + apFile), shows[0], path.join(dir, 'ann-2013', apFile)), null);
  assert.equal(read(dir, `${exeuntShow}/${junkFile}`).criticName, 'Lane Williamson');
  assert.equal(explainExclusion(read(dir, `${exeuntShow}/${junkFile}`), shows[2], path.join(dir, exeuntShow, junkFile)), null);
  assert.equal(read(dir, `${exeuntShow}/${junkFile}`).assignedScore, 91);
});

test('BRO-4504: replay on real data changes only the intended records', t => {
  const source = path.join(root, 'data/review-texts/');
  if (!fs.existsSync(path.join(root, 'data/shows.json')) || !fs.existsSync(path.join(source, 'ann-2013', yahooFile))) {
    t.skip('private data is optional; the real writer is also exercised with synthetic records');
    return;
  }
  const dir = scratch(t);
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'data/shows.json'), 'utf8'));
  const shows = new Map((raw.shows || raw).map(s => [s.id, s]));
  _setShowsCacheForTest(shows);
  // The filename repair may already be applied in a later private snapshot.
  const currentPlan = structuredClone(plan);
  for (const action of currentPlan.plan.actions) {
    const rename = filenamePlan.plan.actions.find(a => a.operation === 'rename' && a.sourcePath === action.file);
    if (rename && !fs.existsSync(path.join(source, action.file))) action.file = rename.destPath;
  }
  const allowed = new Set(currentPlan.plan.actions.map(a => a.file));
  const folders = [...new Set([...allowed].map(f => f.split('/')[0]).concat(phantom.split('/')[0], 'prince-of-broadway-2017'))];
  const before = new Map();
  for (const folder of folders) {
    fs.cpSync(path.join(source, folder), path.join(dir, folder), { recursive: true });
    for (const file of fs.readdirSync(path.join(dir, folder)).filter(f => f.endsWith('.json'))) {
      before.set(`${folder}/${file}`, fs.readFileSync(path.join(dir, folder, file), 'utf8'));
    }
  }
  replay(dir, currentPlan);
  const changed = [...before].filter(([f, bytes]) => fs.readFileSync(path.join(dir, f), 'utf8') !== bytes).map(([f]) => f);
  assert.ok(changed.every(f => allowed.has(f)), 'no unrelated review may change');
  for (const showId of ['ann-2013', 'high-2011']) {
    const file = `${showId}/${yahooFile}`;
    assert.equal(read(dir, file).duplicateOf, apFile);
    assert.ok(explainExclusion(read(dir, file), shows.get(showId), path.join(dir, file)));
  }
  const ann = 'ann-2013/' + apFile;
  assert.equal(explainExclusion(read(dir, ann), shows.get('ann-2013'), path.join(dir, ann)), null, 'Ann keeps its AP review');
  const exeunt = currentPlan.plan.actions.find(a => a.field === 'criticName').file;
  assert.equal(read(dir, exeunt).criticName, 'Lane Williamson');
  assert.equal(explainExclusion(read(dir, exeunt), shows.get(exeuntShow), path.join(dir, exeunt)), null, 'Exeunt keeps its scoreable review');
  const yahooBefore = [...before].filter(([file, bytes]) => {
    const r = JSON.parse(bytes);
    return r.outletId === 'abscbnnewscom' && r.url && new URL(r.url).hostname.endsWith('yahoo.com')
      && !explainExclusion(r, shows.get(file.split('/')[0]), path.join(source, file));
  });
  const yahooAfter = [...before.keys()].filter(file => {
    const r = read(dir, file);
    return r.outletId === 'abscbnnewscom' && r.url && new URL(r.url).hostname.endsWith('yahoo.com')
      && !explainExclusion(r, shows.get(file.split('/')[0]), path.join(dir, file));
  });
  assert.equal(yahooAfter.length, 0);
  t.diagnostic(`real-data replay: ${before.size} records checked; ${changed.length} changed; eligible ABS-CBN Yahoo reviews ${yahooBefore.length} -> ${yahooAfter.length}`);
  for (const file of allowed) {
    const fields = currentPlan.plan.actions.filter(a => a.file === file).map(a => a.field);
    t.diagnostic(`${file}: ${fields.map(f => `${f} ${JSON.stringify(JSON.parse(before.get(file))[f] ?? null)} -> ${JSON.stringify(read(dir, file)[f])}`).join('; ')}`);
  }
});

test('BRO-4504: filename plan deletes each excluded twin before renaming its scoreable source', () => {
  assert.deepEqual(filenamePlan.plan.actions.map(({ type, operation, sourcePath, destPath }) =>
    ({ type, operation, sourcePath, destPath })),
  [exeuntShow, 'prince-faggot-playwrights-horizons-off-broadway-2025'].flatMap(show => [
    { type: 'review-file-op', operation: 'delete', sourcePath: `${show}/${namedFile}`, destPath: undefined },
    { type: 'review-file-op', operation: 'rename', sourcePath: `${show}/${junkFile}`, destPath: `${show}/${namedFile}` },
  ]));
});

test('BRO-4504: filename plan preserves both real scoreable reviews and every neighboring record', t => {
  const source = path.join(root, 'data/review-texts');
  const targets = [exeuntShow, 'prince-faggot-playwrights-horizons-off-broadway-2025'];
  const folders = [...targets, 'prince-of-broadway-2017'];
  if (!fs.existsSync(path.join(root, 'data/shows.json')) || folders.some(f => !fs.existsSync(path.join(source, f)))) {
    t.skip('private data is optional');
    return;
  }
  const dir = scratch(t);
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'data/shows.json'), 'utf8'));
  const shows = new Map((raw.shows || raw).map(s => [s.id, s]));
  _setShowsCacheForTest(shows);
  for (const folder of folders) fs.cpSync(path.join(source, folder), path.join(dir, folder), { recursive: true });

  // Keep exercising the real mover after CI has applied the plan: reconstruct
  // only the old filename collision on scratch copies of the real review.
  for (const show of targets) {
    if (!fs.existsSync(path.join(dir, show, junkFile))) {
      const canonical = read(dir, `${show}/${namedFile}`);
      assert.equal(explainExclusion(canonical, shows.get(show), path.join(dir, show, namedFile)), null);
      write(dir, `${show}/${junkFile}`, canonical);
      write(dir, `${show}/${namedFile}`, { ...canonical, duplicateOf: junkFile });
      t.diagnostic(`${show}: plan already applied; reconstructed pre-repair collision in scratch only`);
    }
  }
  const before = new Map();
  for (const folder of folders) {
    for (const file of fs.readdirSync(path.join(dir, folder)).filter(f => f.endsWith('.json'))) {
      before.set(`${folder}/${file}`, fs.readFileSync(path.join(dir, folder, file), 'utf8'));
    }
  }
  for (const show of targets) {
    const primary = read(dir, `${show}/${junkFile}`);
    const twin = read(dir, `${show}/${namedFile}`);
    assert.equal(explainExclusion(primary, shows.get(show), path.join(dir, show, junkFile)), null);
    assert.equal(twin.duplicateOf, junkFile);
    assert.equal(explainExclusion(twin, shows.get(show), path.join(dir, show, namedFile)), 'duplicateOf');
    const pointers = [...before].filter(([file, bytes]) => file.startsWith(`${show}/`)
      && JSON.parse(bytes).duplicateOf === junkFile).map(([file]) => file);
    assert.deepEqual(pointers, [`${show}/${namedFile}`], 'no other review may retain a dangling duplicateOf');
    const blocked = moveReviewFile(dir, `${show}/${junkFile}`, `${show}/${namedFile}`);
    assert.equal(blocked.ok, false, 'the twin must be deleted before the rename');
    assert.match(blocked.reason, /Destination exists/);
  }

  replay(dir, filenamePlan);

  const allowed = new Set(filenamePlan.plan.actions.map(a => a.sourcePath));
  const changed = [...before].filter(([file, bytes]) => !fs.existsSync(path.join(dir, file))
    || fs.readFileSync(path.join(dir, file), 'utf8') !== bytes).map(([file]) => file);
  assert.deepEqual(changed.sort(), [...allowed].sort());
  const afterPaths = folders.flatMap(folder => fs.readdirSync(path.join(dir, folder))
    .filter(f => f.endsWith('.json')).map(file => `${folder}/${file}`));
  assert.equal(afterPaths.length, before.size - 2);
  assert.ok(afterPaths.every(file => before.has(file)), 'no unexpected review files created');
  for (const show of targets) {
    assert.deepEqual(fs.readdirSync(path.join(dir, show)).filter(f => f.startsWith('exeunt-magazine--') && f.endsWith('.json')), [namedFile]);
    const prior = JSON.parse(before.get(`${show}/${junkFile}`));
    const after = read(dir, `${show}/${namedFile}`);
    assert.equal(explainExclusion(after, shows.get(show), path.join(dir, show, namedFile)), null);
    assert.equal(after.assignedScore, prior.assignedScore);
    assert.equal(after.criticName, 'Lane Williamson');
    assert.equal(after._renamedFrom.file, `${show}/${junkFile}`);
    // A rename adds provenance; all review content, scores and flags survive.
    assert.deepEqual({ ...after, _renamedFrom: null }, { ...prior, _renamedFrom: null });
    t.diagnostic(`${show}: Exeunt files 2 -> 1; score ${prior.assignedScore} -> ${after.assignedScore}; exclusion null -> null`);
  }
  t.diagnostic(`filename replay: ${before.size} records across ${folders.length} folders; ${changed.length} paths changed (2 excluded twins removed, 2 primaries renamed); ${before.size - changed.length} neighbors byte-identical`);
});
