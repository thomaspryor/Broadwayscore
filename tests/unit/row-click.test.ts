import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowClickAction, type RowClickInput } from '../../src/lib/row-click';

const base: RowClickInput = { insideSkip: false, detail: 1, hasSelection: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false };

test('a plain left click on a row opens the show', () => {
  assert.equal(rowClickAction(base), 'open');
});

test('clicks on controls or help notes, double-clicks and selections are left alone', () => {
  assert.equal(rowClickAction({ ...base, insideSkip: true }), 'ignore');
  assert.equal(rowClickAction({ ...base, detail: 2 }), 'ignore');
  assert.equal(rowClickAction({ ...base, hasSelection: true }), 'ignore');
});

test('middle, cmd, ctrl and shift clicks open a new tab; other buttons do nothing', () => {
  assert.equal(rowClickAction({ ...base, button: 1 }), 'new-tab');
  assert.equal(rowClickAction({ ...base, metaKey: true }), 'new-tab');
  assert.equal(rowClickAction({ ...base, ctrlKey: true }), 'new-tab');
  assert.equal(rowClickAction({ ...base, shiftKey: true }), 'new-tab');
  assert.equal(rowClickAction({ ...base, button: 2 }), 'ignore');
});
