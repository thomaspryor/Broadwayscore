import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { refuseRearmWrite } = require('./card-rearm.js');

const notes = '## Problem\nBroken identity parsing.\n\n## Acceptance criteria\n\n`test -f scripts/lib/review-normalization.test.mjs`\n';
const card = { id: 'issue-uuid', identifier: 'BRO-2938', notes, tags: [] };
const entry = { id: card.id, identifier: card.identifier, action: 'llm-enriched', newNotes: notes };

function withLog(t, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-rearm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logPath = path.join(dir, 'enrichment.jsonl');
  fs.writeFileSync(logPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return { logPath };
}

test('unlabelled card can rearm when the latest logged draft matches its current acceptance section', t => {
  assert.equal(refuseRearmWrite(card, withLog(t, [entry])), null);
});

test('edits outside acceptance criteria do not invalidate draft provenance', t => {
  const edited = { ...card, notes: notes.replace('Broken identity parsing.', 'More context for the fix.') };
  assert.equal(refuseRearmWrite(edited, withLog(t, [entry])), null);
});

test('human edits to acceptance prose are protected even if the command is unchanged', t => {
  const edited = { ...card, notes: notes + 'Also audit every affected outlet.\n' };
  assert.ok(refuseRearmWrite(edited, withLog(t, [entry])));
});

test('human edits to the acceptance command are protected', t => {
  const edited = { ...card, notes: notes.replace('test -f', 'node --test') };
  assert.ok(refuseRearmWrite(edited, withLog(t, [entry])));
});

test('matching another issue identifier or UUID is insufficient', t => {
  for (const other of [{ ...entry, id: 'other-uuid' }, { ...entry, identifier: 'BRO-1' }]) {
    assert.ok(refuseRearmWrite(card, withLog(t, [other])));
  }
  assert.ok(refuseRearmWrite({ ...card, id: '' }, withLog(t, [{ ...entry, id: '' }])));
});

test('latest entry for an issue supersedes older matching drafts', t => {
  const later = { ...entry, newNotes: notes + 'New acceptance requirement.\n' };
  assert.ok(refuseRearmWrite(card, withLog(t, [entry, later])));
  assert.equal(refuseRearmWrite(card, withLog(t, [later, entry])), null);
});

test('owner-judgment entries do not prove the enricher authored acceptance criteria', t => {
  assert.ok(refuseRearmWrite(card, withLog(t, [entry, { ...entry, action: 'owner-judgment' }])));
});

test('absent acceptance sections cannot establish provenance', t => {
  assert.ok(refuseRearmWrite({ ...card, notes: 'No criteria' }, withLog(t, [{ ...entry, newNotes: 'No criteria' }])));
  assert.ok(refuseRearmWrite(card, withLog(t, [{ ...entry, newNotes: '' }])));
});

test('missing, malformed and unreadable logs fail closed', t => {
  const opts = withLog(t, []);
  assert.ok(refuseRearmWrite(card, opts));
  fs.writeFileSync(opts.logPath, JSON.stringify(entry) + '\n{incomplete');
  assert.ok(refuseRearmWrite(card, opts));
  fs.unlinkSync(opts.logPath);
  assert.ok(refuseRearmWrite(card, opts));
  fs.mkdirSync(opts.logPath);
  assert.ok(refuseRearmWrite(card, opts));
});

test('label and explicit override remain sufficient without a log', () => {
  const opts = { logPath: '/nonexistent/card-enrichment-log.jsonl' };
  assert.equal(refuseRearmWrite({ tags: ['Auto-Enriched'] }, opts), null);
  assert.equal(refuseRearmWrite(card, { ...opts, allowHumanWritten: true }), null);
});
