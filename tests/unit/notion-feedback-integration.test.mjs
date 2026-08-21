/**
 * Unit tests for src/lib/notion-feedback-integration.js — the pure
 * mapping/validation functions src/app/api/feedback/route.ts uses to turn a
 * feedback form submission into a Notion page in the BWSC Roadmap database
 * (BRO-580). Network calls (src/lib/notion-api.ts) are intentionally
 * untested here — no NOTION_API_KEY required.
 *
 * Run: node --test tests/unit/notion-feedback-integration.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  categoryLabel,
  mapCategoryToType,
  isMalformedFeedbackPayload,
  buildFeedbackTitle,
  buildFeedbackNotes,
  buildFeedbackNotionProperties,
  truncate,
} = require('../../src/lib/notion-feedback-integration.js');

const VALID = {
  name: 'Ada',
  email: 'ada@example.com',
  category: 'bug',
  show: 'Hamilton',
  message: 'The score badge is missing on the Hamilton page.',
  submittedAt: '2026-08-21T12:00:00.000Z',
};

test('categoryLabel maps known categories to human labels', () => {
  assert.equal(categoryLabel('bug'), 'Bug Report');
  assert.equal(categoryLabel('feature'), 'Feature Request');
  assert.equal(categoryLabel('content-error'), 'Content Error');
  assert.equal(categoryLabel('praise'), 'Praise');
  assert.equal(categoryLabel('other'), 'Other');
});

test('categoryLabel falls back to "Feedback" for unknown/missing category', () => {
  assert.equal(categoryLabel('not-a-real-category'), 'Feedback');
  assert.equal(categoryLabel(undefined), 'Feedback');
});

test('mapCategoryToType maps actionable categories to Roadmap Type options', () => {
  assert.equal(mapCategoryToType('bug'), 'Fix');
  assert.equal(mapCategoryToType('feature'), 'New Feature');
  assert.equal(mapCategoryToType('content-error'), 'Data Quality');
});

test('mapCategoryToType returns null for non-actionable categories (Type property omitted)', () => {
  assert.equal(mapCategoryToType('praise'), null);
  assert.equal(mapCategoryToType('other'), null);
  assert.equal(mapCategoryToType('bogus'), null);
});

test('truncate leaves short strings untouched', () => {
  assert.equal(truncate('hello', 20), 'hello');
});

test('truncate cuts long strings and appends an ellipsis', () => {
  const result = truncate('a'.repeat(100), 20);
  assert.equal(result.length, 20);
  assert.ok(result.endsWith('…'));
});

test('truncate treats null/undefined as empty string', () => {
  assert.equal(truncate(null, 10), '');
  assert.equal(truncate(undefined, 10), '');
});

test('isMalformedFeedbackPayload rejects null, undefined, arrays, and primitives', () => {
  assert.equal(isMalformedFeedbackPayload(null), true);
  assert.equal(isMalformedFeedbackPayload(undefined), true);
  assert.equal(isMalformedFeedbackPayload([]), true);
  assert.equal(isMalformedFeedbackPayload('a string'), true);
  assert.equal(isMalformedFeedbackPayload(42), true);
});

test('isMalformedFeedbackPayload accepts a plain object', () => {
  assert.equal(isMalformedFeedbackPayload(VALID), false);
  assert.equal(isMalformedFeedbackPayload({}), false);
});

test('buildFeedbackTitle includes the category label and show name', () => {
  const title = buildFeedbackTitle(VALID);
  assert.match(title, /^\[Bug Report\]/);
  assert.match(title, /Hamilton/);
});

test('buildFeedbackTitle omits the show segment when show is blank', () => {
  const title = buildFeedbackTitle({ ...VALID, show: '' });
  assert.doesNotMatch(title, / — /);
});

test('buildFeedbackTitle stays within Notion-friendly length even for a long message', () => {
  const title = buildFeedbackTitle({ ...VALID, message: 'x'.repeat(500) });
  assert.ok(title.length <= 200);
});

test('buildFeedbackNotes includes message, name, email, and show when present', () => {
  const notes = buildFeedbackNotes(VALID);
  assert.match(notes, /The score badge is missing/);
  assert.match(notes, /Ada/);
  assert.match(notes, /ada@example.com/);
  assert.match(notes, /Hamilton/);
  assert.match(notes, /2026-08-21T12:00:00.000Z/);
});

test('buildFeedbackNotes omits optional sections when blank', () => {
  const notes = buildFeedbackNotes({ ...VALID, name: '', email: '', show: '' });
  assert.doesNotMatch(notes, /### Name/);
  assert.doesNotMatch(notes, /### Email/);
  assert.doesNotMatch(notes, /### Show/);
});

test('buildFeedbackNotionProperties sets Status, Category, Priority, and Tags', () => {
  const props = buildFeedbackNotionProperties(VALID);
  assert.equal(props.Status.status.name, 'Not started');
  assert.equal(props.Category.select.name, 'Product');
  assert.equal(props.Priority.select.name, 'P2 Later');
  assert.deepEqual(props.Tags.multi_select, [{ name: 'user-feedback' }]);
});

test('buildFeedbackNotionProperties sets Name title from buildFeedbackTitle', () => {
  const props = buildFeedbackNotionProperties(VALID);
  assert.equal(props.Name.title[0].text.content, buildFeedbackTitle(VALID));
});

test('buildFeedbackNotionProperties sets Type for bug/feature/content-error', () => {
  assert.equal(buildFeedbackNotionProperties({ ...VALID, category: 'bug' }).Type.select.name, 'Fix');
  assert.equal(buildFeedbackNotionProperties({ ...VALID, category: 'feature' }).Type.select.name, 'New Feature');
  assert.equal(buildFeedbackNotionProperties({ ...VALID, category: 'content-error' }).Type.select.name, 'Data Quality');
});

test('buildFeedbackNotionProperties omits Type for praise/other', () => {
  assert.equal(buildFeedbackNotionProperties({ ...VALID, category: 'praise' }).Type, undefined);
  assert.equal(buildFeedbackNotionProperties({ ...VALID, category: 'other' }).Type, undefined);
});

test('buildFeedbackNotionProperties truncates an overlong Notes body to Notion\'s 2000-char rich_text limit', () => {
  const props = buildFeedbackNotionProperties({ ...VALID, message: 'y'.repeat(5000) });
  assert.ok(props.Notes.rich_text[0].text.content.length <= 2000);
});
