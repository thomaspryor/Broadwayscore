// tests/unit/notion-corpus.test.mjs — Sprint 2 of the Notion→Linear cutover.
//
// The export runs once, against a board that is then deleted. Every failure
// mode here is silent by nature: the run reports the right number of cards and
// exits 0 while having dropped the text that made those cards worth keeping.
// So these tests are all shaped as "prove content is NOT lost", not "prove the
// happy path returns something".
//
// reassembleField is the same function notion-brain.js uses to READ overflowed
// fields (it requires this module), so a break here breaks the live CLI too —
// which is exactly the coupling that keeps writer and reader from drifting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const corpus = require(path.join(REPO, 'scripts/lib/notion-corpus.js'));
const { OVERFLOW_NOTE, OVERFLOW_MARKER_SUBSTR } = require(path.join(REPO, 'scripts/lib/overflow-marker.js'));

const heading = (text) => ({ type: 'heading_2', heading_2: { rich_text: [{ plain_text: text }] } });
const para = (text) => ({ type: 'paragraph', paragraph: { rich_text: [{ plain_text: text }] } });

test('an un-overflowed property is returned untouched', () => {
  assert.equal(corpus.reassembleField('short notes', [], 'notes'), 'short notes');
  assert.equal(corpus.reassembleField('', [], 'notes'), '');
  assert.equal(corpus.reassembleField(null, [], 'notes'), '');
});

test('an overflowed property is replaced by the body section, not concatenated with it', () => {
  // This is the bug that put a wrong number in the Sprint 0 findings: the body
  // section holds the COMPLETE original text (notion-brain.js
  // buildRichTextWithOverflow returns bodyText: s, the whole string), so
  // property + body double-counts the preview.
  const full = 'AAAA BBBB CCCC DDDD';
  const preview = `AAAA BBBB${OVERFLOW_NOTE}`;
  const blocks = [heading('[auto:notes] full content'), para(full)];
  const got = corpus.reassembleField(preview, blocks, 'notes');
  assert.equal(got, full);
  assert.ok(!got.includes(OVERFLOW_MARKER_SUBSTR), 'the marker must not survive reassembly');
  assert.ok(!got.includes('AAAA BBBB AAAA'), 'the preview must not appear twice');
});

test('a multi-chunk body section is rejoined in order', () => {
  // notion-brain.js chunks long bodies at BODY_CHUNK=1900 into consecutive
  // paragraphs. Losing or reordering one is invisible in a character count of
  // the wrong kind, so assert the exact join.
  const blocks = [
    heading('[auto:notes] full content'),
    para('chunk-one'),
    para('chunk-two'),
    para('chunk-three'),
  ];
  assert.equal(
    corpus.reassembleField(`x${OVERFLOW_NOTE}`, blocks, 'notes'),
    'chunk-one\nchunk-two\nchunk-three'
  );
});

test('a field stops at the next auto heading and never bleeds into another field', () => {
  // Cards routinely have BOTH notes and outcome in the body. Reading past the
  // boundary would silently graft one field onto another — and the totals
  // would still look healthy.
  const blocks = [
    heading('[auto:notes] full content'),
    para('the notes'),
    heading('[auto:outcome] full content'),
    para('the outcome'),
  ];
  assert.equal(corpus.reassembleField(`n${OVERFLOW_NOTE}`, blocks, 'notes'), 'the notes');
  assert.equal(corpus.reassembleField(`o${OVERFLOW_NOTE}`, blocks, 'outcome'), 'the outcome');
});

test('a marked property with NO matching body section falls back to the preview', () => {
  // Better a visibly-truncated preview than an empty string: an empty value
  // reads as "this card had no notes", which is unrecoverable after Notion is
  // gone, while a preview still carries 1,800 chars and its own marker.
  const preview = `only the preview${OVERFLOW_NOTE}`;
  assert.equal(corpus.reassembleField(preview, [para('unrelated')], 'notes'), preview);
});

test('the section keys match what notion-brain.js actually WRITES', () => {
  // THE test in this file. The section key is the only thing that makes an
  // overflowed body section findable again, and the first version of
  // notion-corpus.js got `keyFiles` wrong — notion-brain.js writes
  // `overflow['key-files']`, so `[auto:keyFiles] full content` matched nothing
  // and every card with overflowed Key Files would have been archived
  // truncated. The old version of this test hand-built `[auto:keyFiles]` and
  // therefore CERTIFIED the bug.
  //
  // So this reads the writer's own source instead of restating it. If someone
  // renames an overflow key in notion-brain.js, this fails — which is the only
  // mechanism that makes writer/reader drift visible before the archive is
  // taken and Notion is deleted.
  const src = readFileSync(path.join(REPO, 'scripts/notion-brain.js'), 'utf8');
  const written = new Set(
    [...src.matchAll(/overflow(?:\.([A-Za-z0-9_]+)|\['([^']+)'\])\s*=/g)].map((m) => m[1] || m[2])
  );
  assert.ok(written.size >= 3, `expected to find notion-brain's overflow writes, found ${[...written]}`);
  const declared = new Set(corpus.OVERFLOWABLE.map((o) => o.sectionKey));
  assert.deepEqual(
    [...declared].sort(),
    [...written].sort(),
    'notion-corpus.js section keys have drifted from the keys notion-brain.js writes'
  );
});

test('an overflowed Key Files section is reassembled, not left truncated', () => {
  // Regression test for the P0. The heading is built from the table, so it
  // cannot silently agree with a wrong implementation.
  const key = corpus.FIELD_TO_SECTION_KEY.keyFiles;
  assert.equal(key, 'key-files');
  const page = {
    id: 'p1',
    properties: { 'Key Files': { type: 'rich_text', rich_text: [{ plain_text: `a.js${OVERFLOW_NOTE}` }] } },
  };
  const blocks = [heading(corpus.bodyHeadingText(key)), para('a.js\nb.js\nc.js')];
  const rec = corpus.buildRecord(page, blocks, []);
  assert.equal(rec.fields.keyFiles, 'a.js\nb.js\nc.js');
  assert.ok(!rec.fields.keyFiles.includes(OVERFLOW_MARKER_SUBSTR));
  assert.equal(corpus.charVolume([rec]).withOverflowMarker, 0);
  assert.equal(corpus.FIELD_TO_PROPERTY.keyFiles, 'Key Files');
});

test('block text extraction covers every rich_text-bearing type it claims to', () => {
  for (const type of corpus.RICH_TEXT_BLOCK_TYPES) {
    const block = { type, [type]: { rich_text: [{ plain_text: 'payload' }] } };
    assert.equal(corpus.blockPlainText(block), 'payload', `${type} contributed no text`);
  }
});

test('nested children are descended, counted and measured', () => {
  const blocks = [
    { ...para('top'), _children: [{ ...para('mid'), _children: [para('deep')] }] },
    para('sibling'),
  ];
  assert.equal(corpus.blocksPlainText(blocks), 'top\nmid\ndeep\nsibling');
  assert.equal(corpus.countBlocks(blocks), 4);
  assert.equal(corpus.maxBlockDepth(blocks), 2);
  assert.equal(corpus.maxBlockDepth([]), 0);
  assert.equal(corpus.maxBlockDepth([para('flat')]), 0);
});

test('an unrecognised block type is reported, never silently skipped', () => {
  // A block type nobody enumerated contributes zero characters, and a silent
  // zero is indistinguishable from "that card was empty".
  const unknown = corpus.collectUnknownBlockTypes([
    para('fine'),
    { type: 'some_future_block', some_future_block: {} },
    { ...para('outer'), _children: [{ type: 'another_new_one', another_new_one: {} }] },
  ]);
  assert.deepEqual([...unknown].sort(), ['another_new_one', 'some_future_block']);
  assert.equal(corpus.collectUnknownBlockTypes([para('x'), { type: 'divider', divider: {} }]).size, 0);
});

test('every property type on the brain board extracts to text', () => {
  // The 13 live property types, read off the board 2026-08-17. A type that
  // falls through to '' would quietly zero a column of the archive.
  const page = {
    id: 'p1',
    properties: {
      Name: { type: 'title', title: [{ plain_text: 'A card' }] },
      Notes: { type: 'rich_text', rich_text: [{ plain_text: 'note text' }] },
      Outcome: { type: 'rich_text', rich_text: [{ plain_text: 'outcome text' }] },
      'Key Files': { type: 'rich_text', rich_text: [{ plain_text: 'a.js' }] },
      Status: { type: 'status', status: { name: 'In progress' } },
      Priority: { type: 'select', select: { name: 'P1 Next' } },
      Category: { type: 'select', select: null },
      Type: { type: 'select', select: { name: 'Bug' } },
      Auto: { type: 'select', select: null },
      Action: { type: 'select', select: { name: 'Fix' } },
      Tags: { type: 'multi_select', multi_select: [{ name: 'infra' }, { name: 'linear' }] },
      'Completed Date': { type: 'date', date: { start: '2026-08-17' } },
      'Due Date': { type: 'date', date: null },
    },
  };
  const text = corpus.propertiesPlainText(page);
  assert.equal(text.Name, 'A card');
  assert.equal(text.Status, 'In progress');
  assert.equal(text.Priority, 'P1 Next');
  assert.equal(text.Tags, 'infra, linear');
  assert.equal(text['Completed Date'], '2026-08-17');
  assert.equal(text.Category, '', 'an empty select is empty, not undefined');
  assert.equal(text['Due Date'], '');
  for (const k of Object.keys(page.properties)) {
    assert.ok(k in text, `property ${k} vanished from the extraction`);
  }
});

test('a record is deterministic — no timestamps, stable key order', () => {
  // S2-T6 requires two independent runs to diff byte-clean. One Date.now()
  // anywhere in buildRecord makes that impossible, and the failure would only
  // show up after the second hour-long run.
  const page = {
    id: 'p1',
    url: 'https://notion.so/p1',
    created_time: '2026-01-01T00:00:00.000Z',
    last_edited_time: '2026-02-01T00:00:00.000Z',
    properties: {
      Zeta: { type: 'rich_text', rich_text: [{ plain_text: 'z' }] },
      Alpha: { type: 'rich_text', rich_text: [{ plain_text: 'a' }] },
      Notes: { type: 'rich_text', rich_text: [{ plain_text: `p${OVERFLOW_NOTE}` }] },
    },
  };
  const blocks = [heading('[auto:notes] full content'), para('body notes')];
  const a = JSON.stringify(corpus.buildRecord(page, blocks, []));
  const b = JSON.stringify(corpus.buildRecord(page, blocks, []));
  assert.equal(a, b);
  assert.ok(!/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d\d\dZ/.test(a.replace(/"(created|lastEdited)Time":"[^"]*"/g, '')),
    'the only ISO timestamps in a record may be the page\'s own created/lastEdited');
  assert.deepEqual(Object.keys(corpus.buildRecord(page, blocks, []).properties), ['Alpha', 'Notes', 'Zeta']);
});

test('a record keeps the raw property objects as the recovery path', () => {
  const page = {
    id: 'p1',
    properties: { Notes: { type: 'rich_text', rich_text: [{ plain_text: `preview${OVERFLOW_NOTE}` }] } },
  };
  const rec = corpus.buildRecord(page, [heading('[auto:notes] full content'), para('the real notes')], []);
  assert.equal(rec.fields.notes, 'the real notes');
  // The raw property STILL carries the marker — that is what is on the board,
  // and keeping it is deliberate. Any acceptance criterion asserting "no record
  // contains the marker" must be scoped to `fields`.
  assert.ok(rec.properties.Notes.includes(OVERFLOW_MARKER_SUBSTR));
  assert.equal(rec.propertiesRaw.Notes.type, 'rich_text');
});

// --- truncation detection ---------------------------------------------------

test('a card that QUOTES the overflow marker is not treated as truncated', () => {
  // Found on the real 4,985-page export: a `contains` test flagged 14 fields,
  // 4 of which were complete cards that merely discuss the overflow mechanism
  // and quote the marker mid-prose. Failing a correct export over those is the
  // cry-wolf that teaches the next reader to skip the verifier.
  const quoting =
    'We check for the string [Full content in page body below ↓] to detect truncation.\n' +
    'Observed 1-char variance on 5000-char round-trip is acceptable.';
  assert.equal(corpus.isStillTruncated(quoting), false);

  const truncated = `the first 1800 chars${OVERFLOW_NOTE}`;
  assert.equal(corpus.isStillTruncated(truncated), true);
  // Trailing whitespace must not defeat it.
  assert.equal(corpus.isStillTruncated(`${truncated}\n\n  `), true);
  assert.equal(corpus.isStillTruncated(''), false);
  assert.equal(corpus.isStillTruncated(null), false);
});

test('truncation is classified as our bug only when the body section exists', () => {
  const page = {
    id: 'p1',
    properties: { Notes: { type: 'rich_text', rich_text: [{ plain_text: `pre${OVERFLOW_NOTE}` }] } },
  };

  // Body has the section but the field came back truncated ⇒ the exporter
  // failed to stitch it. Our fault; must fail the run.
  const ourBug = corpus.buildRecord(page, [heading('[auto:notes] full content'), para('real text')], []);
  ourBug.fields.notes = `pre${OVERFLOW_NOTE}`; // simulate a stitch failure
  assert.equal(corpus.classifyTruncation(ourBug, 'notes'), 'export-bug');

  // No section on the page at all ⇒ notion-brain's body write never landed and
  // the text is not on the board. Confirmed live on real pages: one had a
  // completely empty body, another carried only the OTHER field's section.
  assert.equal(corpus.classifyTruncation(corpus.buildRecord(page, [], []), 'notes'), 'source-missing');
  assert.equal(
    corpus.classifyTruncation(corpus.buildRecord(page, [heading('[auto:outcome] full content'), para('x')], []), 'notes'),
    'source-missing'
  );

  // A healthy field classifies as neither.
  const fine = corpus.buildRecord(page, [heading('[auto:notes] full content'), para('the whole thing')], []);
  assert.equal(corpus.classifyTruncation(fine, 'notes'), null);
});

test('verifyCorpus fails an exporter truncation but only REPORTS a board-side one', () => {
  const page = {
    id: 'p1',
    properties: { Notes: { type: 'rich_text', rich_text: [{ plain_text: `pre${OVERFLOW_NOTE}` }] } },
  };
  const boardLoss = corpus.buildRecord(page, [], []); // no section to recover from
  const rBoard = corpus.verifyCorpus({ records: [boardLoss], manifest: cleanManifest(1) });
  assert.ok(
    rBoard.checks.find((c) => c.name === 'no field was left truncated by the exporter' && c.ok),
    'a loss that predates the export must not make the corpus permanently unverifiable'
  );
  const listed = rBoard.checks.find((c) => c.name === 'unrecoverable-at-source fields are listed, not hidden');
  assert.ok(listed.detail.includes('p1/notes'), 'but it must be named, not hidden');

  const ourBug = corpus.buildRecord(page, [heading('[auto:notes] full content'), para('real text')], []);
  ourBug.fields.notes = `pre${OVERFLOW_NOTE}`;
  const rBug = corpus.verifyCorpus({ records: [ourBug], manifest: cleanManifest(1) });
  assert.ok(rBug.checks.find((c) => c.name === 'no field was left truncated by the exporter' && !c.ok));
});

// --- verifyCorpus (S2-T5) ---------------------------------------------------

function makeRecord(id, notesLen, { stitched = true } = {}) {
  const page = {
    id,
    properties: { Notes: { type: 'rich_text', rich_text: [{ plain_text: `pre${OVERFLOW_NOTE}` }] } },
  };
  const blocks = stitched ? [heading('[auto:notes] full content'), para('x'.repeat(notesLen))] : [];
  return corpus.buildRecord(page, blocks, []);
}

const cleanManifest = (n) => ({ pagesExported: n, partial: false, errorCount: 0, unknownBlockTypes: [] });

test('verifyCorpus passes a complete export', () => {
  const records = [makeRecord('a', 5000), makeRecord('b', 5000)];
  const baseline = { records: 2, totals: corpus.charVolume(records).totals };
  const r = corpus.verifyCorpus({ records, manifest: cleanManifest(2), baseline });
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok), null, 1));
});

test('truncating one large card fails the verifier — the S2-T5 acceptance case', () => {
  // This is the scenario the whole sprint is defending against: same number of
  // records, same ids, same everything except that one big card lost its body.
  const good = [makeRecord('a', 200_000), makeRecord('b', 5000)];
  const baseline = { records: 2, totals: corpus.charVolume(good).totals };

  const truncated = [makeRecord('a', 1000), makeRecord('b', 5000)];
  assert.equal(truncated.length, good.length, 'record COUNT is unchanged — that is the point');

  const r = corpus.verifyCorpus({ records: truncated, manifest: cleanManifest(2), baseline });
  assert.equal(r.ok, false);
  const volumeCheck = r.checks.find((c) => c.name === 'volume notes >= baseline');
  assert.ok(volumeCheck && !volumeCheck.ok, 'the notes volume check must be the one that fires');
});

test('verifyCorpus tolerates growth above baseline but not a drop past tolerance', () => {
  const baseRecords = [makeRecord('a', 100_000)];
  const baseline = { records: 1, totals: corpus.charVolume(baseRecords).totals };

  // The board gains cards continuously, so ABOVE baseline must never fail.
  const grown = [makeRecord('a', 100_000), makeRecord('b', 50_000)];
  assert.equal(corpus.verifyCorpus({ records: grown, manifest: cleanManifest(2), baseline }).ok, true);

  // 1% under a 2% tolerance passes; 5% under does not.
  const barelyUnder = [makeRecord('a', 99_000)];
  assert.equal(corpus.verifyCorpus({ records: barelyUnder, manifest: cleanManifest(1), baseline }).ok, true);
  const wellUnder = [makeRecord('a', 95_000)];
  assert.equal(corpus.verifyCorpus({ records: wellUnder, manifest: cleanManifest(1), baseline }).ok, false);
});

test('verifyCorpus fails a partial run, a non-empty error manifest, and unknown block types', () => {
  const records = [makeRecord('a', 5000)];
  const baseline = { records: 1, totals: corpus.charVolume(records).totals };
  const failing = (patch) =>
    corpus.verifyCorpus({ records, manifest: { ...cleanManifest(1), ...patch }, baseline });

  assert.equal(failing({ partial: true }).ok, false, 'a --limit run must never verify');
  assert.equal(failing({ errorCount: 1 }).ok, false, 'a 429 recorded in the manifest must fail the verify');
  assert.equal(failing({ unknownBlockTypes: ['some_future_block'] }).ok, false);
  assert.equal(failing({ pagesExported: 99 }).ok, false, 'manifest and file must agree');
});

test('verifyCorpus catches a board-side truncation, a duplicate id and a live-count mismatch', () => {
  // makeRecord(..., {stitched:false}) builds a record with no body blocks, so
  // this is board-side loss: listed, not failed (see the dedicated test above).
  const unstitched = [makeRecord('a', 0, { stitched: false })];
  const r1 = corpus.verifyCorpus({ records: unstitched, manifest: cleanManifest(1) });
  const listed = r1.checks.find((c) => c.name === 'unrecoverable-at-source fields are listed, not hidden');
  assert.ok(listed && listed.detail.includes('a/notes'));

  const dupes = [makeRecord('a', 10), makeRecord('a', 10)];
  const r2 = corpus.verifyCorpus({ records: dupes, manifest: cleanManifest(2) });
  assert.ok(r2.checks.find((c) => c.name === 'no duplicate page ids' && !c.ok));

  // Live containment: a page in the corpus that no longer exists on the board
  // means the export invented or misread it — that fails.
  const r3 = corpus.verifyCorpus({
    records: [makeRecord('a', 10)],
    manifest: cleanManifest(1),
    livePageIds: ['someone-else', 'another'],
  });
  assert.ok(r3.checks.find((c) => c.name === 'every exported page still exists on the board' && !c.ok));

  // But cards CREATED during the ~60-minute export must not fail it — five
  // appeared during the real run, four of them filed by the exporting session.
  const r4 = corpus.verifyCorpus({
    records: [makeRecord('a', 10)],
    manifest: cleanManifest(1),
    baseline: { records: 1, totals: corpus.charVolume([makeRecord('a', 10)]).totals },
    livePageIds: ['a', 'brand-new-1', 'brand-new-2'],
  });
  assert.equal(r4.ok, true, JSON.stringify(r4.checks.filter((c) => !c.ok), null, 1));
  assert.ok(
    r4.checks.find((c) => c.name === 'cards created after the export are reported, not failed' && c.detail.includes('2'))
  );
});

test('charVolume measures the stitched fields, not the previews', () => {
  // The whole point of the volume assertion: an export that keeps only the
  // 1,800-char previews has the right record count and a much smaller volume.
  const stitched = corpus.buildRecord(
    { id: 'p1', properties: { Notes: { type: 'rich_text', rich_text: [{ plain_text: `pre${OVERFLOW_NOTE}` }] } } },
    [heading('[auto:notes] full content'), para('x'.repeat(5000))],
    []
  );
  const truncated = corpus.buildRecord(
    { id: 'p2', properties: { Notes: { type: 'rich_text', rich_text: [{ plain_text: `pre${OVERFLOW_NOTE}` }] } } },
    [],
    []
  );
  const v = corpus.charVolume([stitched, truncated]);
  assert.equal(v.records, 2);
  assert.equal(v.totals.notes, 5000 + `pre${OVERFLOW_NOTE}`.length);
  // The un-stitched card here has NO body blocks at all, so its truncation is
  // board-side loss, not an export bug — counted separately and not fatal.
  assert.equal(v.withOverflowMarker, 0, 'nothing here is the exporter\'s fault');
  assert.deepEqual(v.sourceMissing, [{ id: 'p2', field: 'notes' }]);
  assert.deepEqual(v.exportBugs, []);
});
