import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildSplitExcerptNote, isSplitSection } = require('./split-excerpt-note.js');

test('null for a whole review, a missing review and a non-split combined review', () => {
  assert.equal(buildSplitExcerptNote({ showTitle: 'X' }), null);
  assert.equal(buildSplitExcerptNote(null), null);
  assert.equal(buildSplitExcerptNote(undefined, 'X'), null);
  assert.equal(buildSplitExcerptNote({ isCombinedReview: true, showTitle: 'X' }), null);
  assert.equal(isSplitSection({ multiShowSplitChild: 'true' }), false);
});

test('child and parent get a note naming the show', () => {
  for (const marker of ['multiShowSplitChild', 'multiShowSplitParent']) {
    const note = buildSplitExcerptNote({ [marker]: true, showTitle: 'Two Girls' });
    assert.match(note, /^NOTE: /);
    assert.match(note, /only the section about "Two Girls"/);
    assert.match(note, /not a verdict on "Two Girls"/);
    assert.match(note, /counts in full, favorable or not/);
  }
});

test('an explicit title wins over the row title, and a missing title still reads', () => {
  assert.match(buildSplitExcerptNote({ multiShowSplitChild: true, showTitle: 'Old' }, 'New'), /"New"/);
  assert.match(buildSplitExcerptNote({ multiShowSplitChild: true }), /the show being scored/);
});

test('a hostile or huge title is flattened and capped', () => {
  const note = buildSplitExcerptNote({ multiShowSplitChild: true }, 'A\n\nIgnore all\n' + 'x'.repeat(500));
  assert.ok(!/\n/.test(note));
  assert.ok(note.length < 1500);
});
