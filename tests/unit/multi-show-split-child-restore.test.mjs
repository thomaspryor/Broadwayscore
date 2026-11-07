import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyMultiShowFanoutToFile, planMultiShowFanout } = require('../../scripts/lib/multi-show-review-fanout.js');
const shows = [
  { id: 'delirium-off-broadway-2026', title: 'Delirium', category: 'off-broadway', openingDate: '2026-09-24' },
  { id: 'the-cherry-orchard-park-avenue-armory-off-broadway-2026', title: 'The Cherry Orchard', category: 'off-broadway', openingDate: '2026-09-17' },
];
// Invented prose with the shape of an introductory two-show column.
const filler = topic => Array.from({ length: 12 }, (_, i) =>
  `The ${topic} passage ${i + 1} unfolds at a measured pace, giving the actors room to develop their characters and hold the audience.`).join(' ');
const article = `Igor Golyak's “Delirium” is a compelling evening of theater. ${filler('Delirium')}\n\nSimon Stone's “The Cherry Orchard” moves the estate to modern Seoul. ${filler('The Cherry Orchard')}`;

function fixture(t, { catalogue = shows, text = article } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-7052-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parentPath = path.join(root, catalogue[0].id, 'example--critic.json');
  const childPath = path.join(root, catalogue[1].id, 'example--critic.json');
  fs.mkdirSync(path.dirname(parentPath), { recursive: true });
  fs.writeFileSync(parentPath, JSON.stringify({
    showId: catalogue[0].id, outletId: 'example', criticName: 'Critic',
    url: 'https://example.com/review', publishDate: '2026-09-29', contentTier: 'complete', fullText: text,
  }));
  const opts = { shows: catalogue, reviewTextsDir: root };
  assert.equal(applyMultiShowFanoutToFile(parentPath, opts).parentRewritten, true);
  const parentBytes = fs.readFileSync(parentPath, 'utf8');
  const child = JSON.parse(fs.readFileSync(childPath, 'utf8'));
  const restore = (over = {}) => fs.writeFileSync(childPath, JSON.stringify({
    ...child, fullText: text, llmScore: 77, ensembleData: { stale: true }, needsRescore: false, ...over,
  }));
  return { opts, parentPath, childPath, parentBytes, child, restore };
}

test('restoring only a split child re-trims it while the parent stays byte-for-byte unchanged', t => {
  const f = fixture(t);
  const parent = JSON.parse(f.parentBytes);
  assert.equal(parent.fullText.length, parent.multiShowSplitTextLength);
  assert.equal(planMultiShowFanout(parent, shows), null, 'unchanged parent does not re-plan on its own');
  f.restore();
  const result = applyMultiShowFanoutToFile(f.childPath, f.opts);
  const after = JSON.parse(fs.readFileSync(f.childPath, 'utf8'));
  assert.equal(after.fullText, f.child.fullText, 'child must lose the other show section');
  assert.equal(after.multiShowSplitChild, true);
  assert.equal(after.multiShowSplitParentShowId, shows[0].id);
  assert.equal(after.multiShowSplitParent, undefined);
  assert.equal(after.multiShowSplitChildShowIds, undefined);
  assert.equal(after.multiShowWholeArticleText, article);
  assert.equal(after.needsRescore, true);
  assert.equal(after.llmScore, undefined);
  assert.equal(after.ensembleData, undefined);
  assert.equal(after.textWordCount, after.fullText.split(/\s+/).length);
  assert.equal(result.applied, true);
  assert.equal(result.parentRewritten, false);
  assert.equal(fs.readFileSync(f.parentPath, 'utf8'), f.parentBytes);
  const once = fs.readFileSync(f.childPath, 'utf8');
  assert.equal(applyMultiShowFanoutToFile(f.childPath, f.opts).applied, false);
  assert.equal(fs.readFileSync(f.childPath, 'utf8'), once, 'second call is idempotent');
});

test('dry run detects a restored child without writing either file', t => {
  const f = fixture(t);
  f.restore();
  const before = fs.readFileSync(f.childPath, 'utf8');
  assert.equal(applyMultiShowFanoutToFile(f.childPath, { ...f.opts, dryRun: true }).applied, true);
  assert.equal(fs.readFileSync(f.childPath, 'utf8'), before);
  assert.equal(fs.readFileSync(f.parentPath, 'utf8'), f.parentBytes);
});

test('a child with a manual production clear still re-trims and keeps the clear', t => {
  const f = fixture(t);
  f.restore({ wrongProductionManualClear: true });
  applyMultiShowFanoutToFile(f.childPath, f.opts);
  const after = JSON.parse(fs.readFileSync(f.childPath, 'utf8'));
  assert.equal(after.fullText, f.child.fullText);
  assert.equal(after.wrongProductionManualClear, true);
});

test('a joint child uses the parent strategy even when new joint splits are disabled', t => {
  const text = [
    'Two new shows play games with time: “Delirium,” a sprawling quest, and “The Cherry Orchard,” a family fable.',
    `The more ambitious is the sprawling “Delirium,” which follows a traveler through a city of dreams. ${filler('dream')} By its last scene “Delirium” has earned its length.`,
    `Sadly, no amount of time could turn “The Cherry Orchard” into my sort of evening. ${filler('estate')} Fans of the story may feel otherwise.`,
    'Delirium Through Jan. 3 at the Daryl Roth Theater, Manhattan. Running time: 2 hours 40 minutes.',
    'The Cherry Orchard Through Dec. 6 at the Public Theater, Manhattan. Running time: 2 hours.',
  ].join(' ');
  const f = fixture(t, { text });
  assert.equal(JSON.parse(f.parentBytes).multiShowSplitAnchorKind, 'joint');
  f.restore();
  assert.equal(applyMultiShowFanoutToFile(f.childPath, { ...f.opts, joint: false }).applied, true);
  assert.equal(JSON.parse(fs.readFileSync(f.childPath, 'utf8')).fullText, f.child.fullText);
  assert.equal(fs.readFileSync(f.parentPath, 'utf8'), f.parentBytes);
});

test('restoring one child in a three-show article leaves the other child unchanged', t => {
  const third = { id: 'pre-existing-condition-off-broadway-2026', title: 'Pre-Existing Condition', category: 'off-broadway', openingDate: '2026-09-10' };
  const text = article + `\n\n“Pre-Existing Condition” brings an intimate story to the stage. ${filler('Pre-Existing Condition')}`;
  const f = fixture(t, { catalogue: [...shows, third], text });
  const siblingPath = path.join(f.opts.reviewTextsDir, third.id, path.basename(f.childPath));
  const siblingBytes = fs.readFileSync(siblingPath, 'utf8');
  f.restore();
  assert.equal(applyMultiShowFanoutToFile(f.childPath, f.opts).applied, true);
  assert.equal(JSON.parse(fs.readFileSync(f.childPath, 'utf8')).fullText, f.child.fullText);
  assert.equal(fs.readFileSync(f.parentPath, 'utf8'), f.parentBytes);
  assert.equal(fs.readFileSync(siblingPath, 'utf8'), siblingBytes);
});

test('an operator-blocked child stays untouched', t => {
  const f = fixture(t);
  f.restore();
  fs.writeFileSync(path.join(path.dirname(f.childPath), '_blocklist.json'), JSON.stringify({ urls: [f.child.url] }));
  const before = fs.readFileSync(f.childPath, 'utf8');
  assert.equal(applyMultiShowFanoutToFile(f.childPath, f.opts).applied, false);
  assert.equal(fs.readFileSync(f.childPath, 'utf8'), before);
});

test('a parent that no longer owns the split cannot trim the child', t => {
  const f = fixture(t);
  f.restore();
  fs.writeFileSync(f.parentPath, JSON.stringify({ ...JSON.parse(f.parentBytes), multiShowSplitChildShowIds: [] }));
  const before = fs.readFileSync(f.childPath, 'utf8');
  assert.equal(applyMultiShowFanoutToFile(f.childPath, f.opts).applied, false);
  assert.equal(fs.readFileSync(f.childPath, 'utf8'), before);
});

for (const [name, fields] of Object.entries({
  lock: { _locked: true }, handScore: { humanReviewScore: 80 },
  manualTier: { manualContentTier: 'complete' }, humanReject: { rejectedBy: 'owner' },
  undone: { multiShowUnsplitAt: '2026-10-01' },
  differentArticle: { url: 'https://example.com/different-review' },
  missingParent: { multiShowSplitParentShowId: 'missing-show' },
})) {
  test(`restored child respects ${name}`, t => {
    const f = fixture(t);
    f.restore(fields);
    const before = fs.readFileSync(f.childPath, 'utf8');
    assert.equal(applyMultiShowFanoutToFile(f.childPath, f.opts).applied, false);
    assert.equal(fs.readFileSync(f.childPath, 'utf8'), before);
    assert.equal(fs.readFileSync(f.parentPath, 'utf8'), f.parentBytes);
  });
}
