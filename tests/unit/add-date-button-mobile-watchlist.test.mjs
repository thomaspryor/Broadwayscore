/** BRO-6447: The undated watchlist action must look tappable before hover. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = readFileSync(join(ROOT, 'src/app/my-shows/MyShowsClient.tsx'), 'utf8');
const PICKER = SOURCE.slice(SOURCE.indexOf('function DatePickerButton('), SOURCE.indexOf('function WatchlistListItem('));
const EMPTY_STATE = PICKER.match(/hasDate\s*\?\s*'[^']*'\s*:\s*'([^']*)'/)?.[1];

test('scans the date picker used by the watchlist Add date action', () => {
  assert.ok(EMPTY_STATE, 'must find the undated date-picker styling');
  const listItem = SOURCE.slice(SOURCE.indexOf('function WatchlistListItem('), SOURCE.indexOf('interface SearchShow'));
  assert.match(listItem, /<DatePickerButton\s/);
  assert.match(listItem, /label=\{formattedDate \|\| 'Add date'\}/);
  assert.match(PICKER, /<SharedDatePicker\s/);
});

test('Add date uses the shared secondary button resting and hover states', () => {
  assert.ok(EMPTY_STATE?.split(/\s+/).includes('btn-secondary'), 'use the design-system secondary action');
  assert.doesNotMatch(EMPTY_STATE, /(?:^|\s)(?:text-gray-\d+|bg-white\/\[0\.03\]|border-white\/\[0\.06\])(?:\s|$)/, 'faint gray styling makes the action look disabled');
});

test('Add date has the shared keyboard focus indicator', () => {
  assert.ok(EMPTY_STATE?.split(/\s+/).includes('focus-ring'), 'the date action needs a visible keyboard focus state');
});
