#!/usr/bin/env node
// scripts/lib/notion-corpus.js — pure text-extraction and reassembly for the
// Notion corpus export (Sprint 2 of sprint-plan-notion-linear-cutover.md).
//
// No fetch, no fs, no Notion client: everything here takes already-fetched
// Notion objects and returns plain data, so the parts that can silently lose
// content are testable against fixtures instead of against the live board.
//
// WHAT THIS IS DEFENDING AGAINST
// notion-brain.js caps a rich_text property at PROP_CHUNK (1800 chars), leaves
// a preview ending in the overflow marker, and writes the real text into the
// page body under an `[auto:<field>] full content` heading. 2,183 of ~4,981
// cards carry that marker, and on the one card measured by hand 73% of its
// notes existed ONLY in the body (4,573 body chars vs 1,712 in the property).
// An export that reads properties alone looks complete, exports the right
// number of cards, and quietly drops most of the corpus. Everything below
// exists so that cannot happen without a test failing.
//
// The heading vocabulary is shared with notion-brain.js, which requires this
// file rather than keeping a second copy (CLAUDE.md rule 15): if the writer
// ever changes the heading shape, the reader changes with it.

'use strict';

const { OVERFLOW_MARKER_SUBSTR } = require('./overflow-marker');

const BODY_HEADING_PREFIX = '[auto:';
const BODY_HEADING_SUFFIX = '] full content';

// The three long-text fields notion-brain.js can push into the page body.
//
// `sectionKey` is NOT decorative and NOT free choice: it is the exact string
// notion-brain.js puts inside `[auto:<key>] full content` when it WRITES the
// body section, so it is the only thing that makes the section findable again.
// The writer is scripts/notion-brain.js's `overflow` object — `overflow.notes`
// (:620, :946), `overflow.outcome` (:975) and, note the hyphen,
// `overflow['key-files']` (:981) — and its own reader passes the same
// `'key-files'` at :1338.
//
// This is exactly where the first version of this file was WRONG. It used
// `keyFiles` as the section key, so `[auto:keyFiles] full content` never
// matched the `[auto:key-files] full content` heading actually on the page, and
// `reassembleField` fell back to the truncated property preview. Every card
// whose Key Files overflowed would have been archived truncated — the precise
// silent-data-loss failure this whole sprint exists to prevent — and the unit
// test hand-built the wrong heading, so it certified the bug as correct.
// tests/unit/notion-corpus.test.mjs now derives its headings from this table
// AND asserts the table against notion-brain.js's source.
const OVERFLOWABLE = [
  { field: 'notes', sectionKey: 'notes', property: 'Notes' },
  { field: 'outcome', sectionKey: 'outcome', property: 'Outcome' },
  { field: 'keyFiles', sectionKey: 'key-files', property: 'Key Files' },
];

const OVERFLOWABLE_FIELDS = OVERFLOWABLE.map((o) => o.field);
const FIELD_TO_PROPERTY = Object.fromEntries(OVERFLOWABLE.map((o) => [o.field, o.property]));
const FIELD_TO_SECTION_KEY = Object.fromEntries(OVERFLOWABLE.map((o) => [o.field, o.sectionKey]));
// The inverse. notion-brain.js keys its in-flight `overflow` object by SECTION
// key and has to write the result back onto a card keyed by FIELD name; it had
// two separate hand-written versions of this mapping (an explicit map on the
// update path, an implicit identity on the create path that is only correct
// because create can currently overflow Notes alone). Both now come from here,
// so there is one table and the same drift cannot happen a third time.
const SECTION_KEY_TO_FIELD = Object.fromEntries(OVERFLOWABLE.map((o) => [o.sectionKey, o.field]));

function bodyHeadingText(field) {
  return `${BODY_HEADING_PREFIX}${field}${BODY_HEADING_SUFFIX}`;
}

function getHeadingText(block) {
  if (!block || block.type !== 'heading_2') return null;
  const rt = (block.heading_2 && block.heading_2.rich_text) || [];
  return rt.map((t) => t.plain_text).join('');
}

function isAutoHeading(block) {
  const t = getHeadingText(block);
  return !!(t && t.startsWith(BODY_HEADING_PREFIX) && t.endsWith(BODY_HEADING_SUFFIX));
}

/**
 * The pure half of notion-brain.js's readFieldWithOverflow: given the property
 * text and the page's already-fetched top-level children, return the full
 * value. Identical semantics — property text is returned unchanged when there
 * is no marker, or when the matching auto section is missing.
 */
function reassembleField(propertyText, children, field) {
  const s = String(propertyText || '');
  if (!s.includes(OVERFLOW_MARKER_SUBSTR)) return s;
  const list = Array.isArray(children) ? children : [];
  const targetHeading = bodyHeadingText(field);
  const startIdx = list.findIndex((b) => getHeadingText(b) === targetHeading);
  if (startIdx === -1) return s;
  const parts = [];
  for (let i = startIdx + 1; i < list.length; i++) {
    const b = list[i];
    if (isAutoHeading(b)) break;
    // EVERY text-bearing block, not just `paragraph`.
    //
    // notion-brain.js writes these sections as paragraphs, so paragraph-only
    // matched what it produces — but the real board disagrees. On the 4,985-page
    // export, cards edited in the Notion UI (or written before the current
    // chunker) carry heading_2 / heading_3 / bulleted_list_item /
    // numbered_list_item inside an auto section. e.g.
    // 34b637c5-416f-81b7-9f44-fa620825d128's [auto:notes] section is one 1,870-char
    // heading_2 plus a 956-char bulleted_list_item and NOT ONE paragraph — so the
    // paragraph-only pass collected nothing, fell back to the truncated preview,
    // and the archive silently lost the whole section.
    //
    // blockPlainText also descends nothing here on purpose: children are handled
    // by the caller's tree, and an auto section is flat in practice.
    const text = blockPlainText(b);
    if (text) parts.push(text);
  }
  return parts.length ? parts.join('\n') : s;
}

// Every Notion block type whose payload can carry rich_text. Enumerated rather
// than duck-typed on purpose: a block type NOT listed here would contribute
// zero characters to the volume assertions, and a silent zero is exactly the
// failure mode Sprint 2 exists to prevent — so unknown types are reported by
// collectUnknownBlockTypes() instead of being quietly skipped.
const RICH_TEXT_BLOCK_TYPES = new Set([
  'paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item',
  'numbered_list_item', 'to_do', 'toggle', 'quote', 'callout', 'code',
  'template', 'bookmark', 'equation',
]);

// Block types that legitimately carry no text (dividers, images, embeds…).
// Listed so collectUnknownBlockTypes can stay quiet about them.
const KNOWN_TEXTLESS_BLOCK_TYPES = new Set([
  'divider', 'image', 'video', 'file', 'pdf', 'embed', 'breadcrumb',
  'table_of_contents', 'column_list', 'column', 'link_preview',
  'child_page', 'child_database', 'synced_block', 'table', 'table_row',
  'audio', 'unsupported',
]);

function blockPlainText(block) {
  if (!block || !block.type) return '';
  const payload = block[block.type];
  if (!payload) return '';
  const parts = [];
  if (Array.isArray(payload.rich_text)) {
    parts.push(payload.rich_text.map((t) => t.plain_text || '').join(''));
  }
  // table_row holds an array of rich_text arrays rather than one.
  if (Array.isArray(payload.cells)) {
    for (const cell of payload.cells) {
      if (Array.isArray(cell)) parts.push(cell.map((t) => t.plain_text || '').join(''));
    }
  }
  if (typeof payload.title === 'string') parts.push(payload.title);
  if (typeof payload.expression === 'string') parts.push(payload.expression);
  if (payload.caption && Array.isArray(payload.caption)) {
    parts.push(payload.caption.map((t) => t.plain_text || '').join(''));
  }
  return parts.filter(Boolean).join('\n');
}

/** Depth-first plain text over a block tree whose children are on `_children`. */
/**
 * The page body text that is NOT one of the `[auto:<field>] full content`
 * sections — i.e. what a human actually typed on the page, as opposed to the
 * overflow notion-brain.js wrote there on their behalf.
 *
 * WHY THIS IS NEEDED. reassembleField() already recovers the auto sections into
 * `record.fields`, so a consumer that renders `fields` has the long text. But a
 * FREE-FORM page — one where someone wrote into the page body instead of the
 * Notes property — has no auto section at all, so it has empty `fields` and all
 * of its content sits here. Measured on the Sprint 2 corpus: 67 un-Done pages
 * have >500 characters of body text and nothing in notes/outcome/keyFiles, and
 * a consumer reading only `fields` renders them as an empty stub. That is
 * 86,388 characters of real work, and after Notion is deleted there is nowhere
 * to get it back.
 *
 * Returning ONLY the non-auto part is what makes this safe to concatenate with
 * `fields`: the auto sections would otherwise be rendered twice, which is the
 * double-count that inflated Sprint 0's volume baseline.
 */
function nonAutoBodyText(body) {
  const blocks = (body && body.blocks) || [];
  const out = [];
  let inAuto = false;
  for (const b of blocks) {
    const heading = getHeadingText(b);
    if (heading !== null) {
      // Any heading ends the previous auto section; an auto heading starts a
      // new one. A human heading is real content and is kept.
      inAuto = isAutoHeading(b);
      if (inAuto) continue;
    }
    if (inAuto) continue;
    const t = blockPlainText(b);
    if (t) out.push(t);
    if (Array.isArray(b && b._children) && b._children.length) {
      const child = blocksPlainText(b._children);
      if (child) out.push(child);
    }
  }
  return out.join('\n').trim();
}

function blocksPlainText(blocks) {
  const out = [];
  const walk = (list) => {
    for (const b of Array.isArray(list) ? list : []) {
      const t = blockPlainText(b);
      if (t) out.push(t);
      if (Array.isArray(b && b._children) && b._children.length) walk(b._children);
    }
  };
  walk(blocks);
  return out.join('\n');
}

/** Block types seen in the tree that this file has no opinion about. */
function collectUnknownBlockTypes(blocks, into = new Set()) {
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b && b.type && !RICH_TEXT_BLOCK_TYPES.has(b.type) && !KNOWN_TEXTLESS_BLOCK_TYPES.has(b.type)) {
      into.add(b.type);
    }
    if (b && Array.isArray(b._children)) collectUnknownBlockTypes(b._children, into);
  }
  return into;
}

/** Max nesting depth actually present (0 = no children anywhere). */
function maxBlockDepth(blocks, depth = 0) {
  let max = depth === 0 && (!Array.isArray(blocks) || !blocks.length) ? 0 : depth;
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b && Array.isArray(b._children) && b._children.length) {
      max = Math.max(max, maxBlockDepth(b._children, depth + 1));
    }
  }
  return max;
}

// --- property extraction ----------------------------------------------------

function propertyPlainText(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'title':
      return (prop.title || []).map((t) => t.plain_text || '').join('');
    case 'rich_text':
      return (prop.rich_text || []).map((t) => t.plain_text || '').join('');
    case 'select':
      return prop.select ? prop.select.name || '' : '';
    case 'status':
      return prop.status ? prop.status.name || '' : '';
    case 'multi_select':
      return (prop.multi_select || []).map((s) => s.name).join(', ');
    case 'date':
      return prop.date ? prop.date.start || '' : '';
    case 'number':
      return prop.number === null || prop.number === undefined ? '' : String(prop.number);
    case 'checkbox':
      return prop.checkbox ? 'true' : 'false';
    case 'url':
    case 'email':
    case 'phone_number':
      return prop[prop.type] || '';
    default:
      return '';
  }
}

/** Every property, name -> plain text. Property values only, no body. */
function propertiesPlainText(page) {
  const out = {};
  for (const [name, prop] of Object.entries((page && page.properties) || {})) {
    out[name] = propertyPlainText(prop);
  }
  return out;
}

/**
 * The exported record for one page. `blocks` is the fetched body tree
 * (children on `_children`); `comments` is whatever comments.list returned.
 *
 * DETERMINISTIC BY CONSTRUCTION — no timestamps, no run ids, fixed key order,
 * property names sorted. S2-T6 requires two independent runs to diff clean,
 * and a single Date.now() anywhere in here would make that impossible.
 * Run metadata belongs in the manifest file, never in a record.
 *
 * The raw `properties` object is kept verbatim alongside the derived text.
 * The derived views are what the volume assertions measure, but if any
 * extraction rule here is ever wrong, the raw object is what makes that
 * recoverable rather than a permanent silent loss.
 */
function buildRecord(page, blocks, comments) {
  // Before anything reads them: strip the per-fetch S3 signatures, or two runs
  // of an unchanged page can never agree.
  const fileStats = { count: 0 };
  blocks = normalizeExpiringFileUrls(blocks, fileStats);
  const propText = propertiesPlainText(page);
  const sortedProps = {};
  for (const k of Object.keys(propText).sort()) sortedProps[k] = propText[k];

  const fields = {};
  for (const { field, sectionKey, property } of OVERFLOWABLE) {
    // sectionKey, not field: `keyFiles` is how the record names it, but
    // `key-files` is what notion-brain.js wrote into the page heading.
    fields[field] = reassembleField(propText[property] || '', blocks, sectionKey);
  }

  return {
    id: page.id,
    url: page.url || null,
    createdTime: page.created_time || null,
    lastEditedTime: page.last_edited_time || null,
    archived: !!page.archived,
    // Full-fidelity values: property text stitched with the page body.
    fields,
    // Property values alone, every property on the board.
    properties: sortedProps,
    // The raw Notion property objects — the recovery path if any rule above
    // turns out to be wrong after Notion is gone.
    propertiesRaw: page.properties || {},
    body: {
      blockCount: countBlocks(blocks),
      maxDepth: maxBlockDepth(blocks),
      text: blocksPlainText(blocks),
      // Non-zero means this page references uploaded files the archive does
      // NOT contain — see normalizeExpiringFileUrls.
      expiringFileBlocks: fileStats.count,
      blocks: blocks || [],
    },
    comments: {
      count: Array.isArray(comments) ? comments.length : 0,
      items: Array.isArray(comments) ? comments : [],
    },
  };
}

/**
 * Notion serves uploaded files (image/file/pdf/video blocks) as PRE-SIGNED S3
 * URLs that carry an AWS signature and an `expiry_time` about an hour out. Two
 * consequences, both discovered by diffing two real full exports:
 *
 *   1. The signature differs on EVERY fetch, so a record containing one can
 *      never be byte-identical across runs. Five pages in the real corpus
 *      diverged for this reason alone, with identical content.
 *   2. More seriously, storing the signed URL in an archive is a lie of
 *      omission. It looks like the archive references the image; the link is
 *      dead within the hour, and the bare S3 path is not publicly fetchable.
 *
 * So the signature is stripped (keeping the stable path, which at least
 * identifies the object) and the expiry is dropped, with a breadcrumb on the
 * block. The COUNT is surfaced in the manifest so "this archive does not
 * contain the images" is a recorded fact rather than something a future reader
 * has to rediscover. Deep-clones: the caller's blocks are not mutated.
 */
function normalizeExpiringFileUrls(blocks, stats = { count: 0 }) {
  const out = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || typeof b !== 'object') {
      out.push(b);
      continue;
    }
    const copy = { ...b };
    const payload = copy[copy.type];
    if (payload && payload.file && typeof payload.file.url === 'string') {
      stats.count++;
      const { url } = payload.file;
      copy[copy.type] = {
        ...payload,
        file: {
          ...payload.file,
          url: url.split('?')[0],
          expiry_time: undefined,
          _signatureStripped: true,
          _note: 'Notion pre-signed S3 URL; signature removed (expires ~1h). The image is NOT in this archive.',
        },
      };
    }
    if (Array.isArray(b._children)) copy._children = normalizeExpiringFileUrls(b._children, stats);
    out.push(copy);
  }
  return out;
}

function countBlocks(blocks) {
  let n = 0;
  for (const b of Array.isArray(blocks) ? blocks : []) {
    n++;
    if (b && Array.isArray(b._children)) n += countBlocks(b._children);
  }
  return n;
}

/**
 * Per-field character totals across records. This is the assertion that
 * actually catches a broken export: a run that truncates the longest cards
 * still exports the right NUMBER of cards, and only the character volume
 * moves. Counts the stitched `fields` values, not the property previews.
 */
/**
 * Is this value STILL a truncated preview?
 *
 * ENDS-with, not contains. notion-brain.js appends OVERFLOW_NOTE to the end of
 * the preview, so a truncated value always terminates in it — while a fully
 * reassembled value can legitimately CONTAIN the string anywhere, because this
 * board has cards that discuss the overflow mechanism itself and quote the
 * marker in their prose. Measured on the real 4,985-page export: a `contains`
 * test flagged 14 fields, of which 4 were complete cards ending in ordinary
 * sentences. Those 4 false alarms would have failed a correct export — the
 * kind of cry-wolf that teaches the next reader to wave the verifier through.
 */
function isStillTruncated(text) {
  const s = String(text || '').trimEnd();
  if (!s) return false;
  const at = s.lastIndexOf(OVERFLOW_MARKER_SUBSTR);
  if (at === -1) return false;
  // Nothing but the marker's own closing bracket may follow it.
  return /^[^\]]*\]?$/.test(s.slice(at + OVERFLOW_MARKER_SUBSTR.length));
}

/**
 * Why is a field still truncated?
 *
 *   'export-bug'     — the page body HAS the matching `[auto:<key>] full
 *                      content` section and we failed to stitch it. Our fault,
 *                      recoverable, must fail the run.
 *   'source-missing' — no such section exists on the page. notion-brain wrote
 *                      the preview+marker into the property and its body write
 *                      never landed, so the full text is not on the board at
 *                      all. No exporter can recover it; failing the run over it
 *                      would make the export permanently unverifiable.
 *
 * Confirmed against the live board: of the 10 genuinely-truncated fields in the
 * real export, some pages have an entirely empty body and others carry only the
 * OTHER field's section.
 */
function classifyTruncation(record, field) {
  const stored = (record.fields || {})[field];
  if (!isStillTruncated(stored)) return null;
  const sectionKey = FIELD_TO_SECTION_KEY[field];
  const blocks = (record.body && record.body.blocks) || [];

  // The precise question is not "does a section heading exist" — a section can
  // exist and its own content can itself be a marked, truncated value (a
  // prepend cycle that read a preview and wrote it back). The question is
  // whether ANY better text is recoverable from the blocks we archived. If
  // re-deriving from the record's own raw body produces something that is no
  // longer truncated, we stored the wrong thing and that is our bug. If it does
  // not, the board's own copy is truncated and no exporter can do better.
  const rederived = reassembleField(stored, blocks, sectionKey);
  return isStillTruncated(rederived) ? 'source-missing' : 'export-bug';
}

function charVolume(records) {
  const totals = { notes: 0, outcome: 0, keyFiles: 0, body: 0, properties: 0 };
  const exportBugs = [];
  const sourceMissing = [];
  let expiringFileBlocks = 0;
  for (const r of records) {
    expiringFileBlocks += ((r.body || {}).expiringFileBlocks) || 0;
    for (const f of OVERFLOWABLE_FIELDS) {
      totals[f] += ((r.fields || {})[f] || '').length;
      const why = classifyTruncation(r, f);
      if (why === 'export-bug') exportBugs.push({ id: r.id, field: f });
      else if (why === 'source-missing') sourceMissing.push({ id: r.id, field: f });
    }
    totals.body += (((r.body || {}).text) || '').length;
    for (const v of Object.values(r.properties || {})) totals.properties += String(v || '').length;
  }
  return {
    totals,
    records: records.length,
    // Kept as the headline number, but it now counts only genuine truncation we
    // could have prevented.
    withOverflowMarker: exportBugs.length,
    exportBugs,
    sourceMissing,
    // Uploaded files this archive references but does not contain.
    expiringFileBlocks,
  };
}

// --- verification -----------------------------------------------------------

/**
 * The pure half of scripts/verify-notion-corpus.js (S2-T5).
 *
 * Character VOLUME is the assertion that matters. An export that truncated the
 * longest, most valuable cards still exports the right NUMBER of records and
 * still exits 0 — record count is exactly the metric that cannot detect the
 * documented failure mode. Volume can.
 *
 * The baseline is one-sided on purpose: the corpus grows continuously (cards
 * are created every hour) so ABOVE baseline is normal and only reported, while
 * BELOW baseline by more than `tolerance` is a failure. A two-sided band would
 * go red every day for the healthiest possible reason.
 *
 * @returns {{ok: boolean, checks: Array<{name, ok, detail}>, volume: object}}
 */
function verifyCorpus({ records, manifest = null, baseline = null, tolerance = 0.02, livePageIds = null }) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const volume = charVolume(records);

  const ids = new Set();
  let dupes = 0;
  let missingId = 0;
  for (const r of records) {
    if (!r || !r.id) { missingId++; continue; }
    if (ids.has(r.id)) dupes++;
    ids.add(r.id);
  }
  add('every record has an id', missingId === 0, `${missingId} without one`);
  add('no duplicate page ids', dupes === 0, `${dupes} duplicate(s)`);

  // Scoped to `fields` deliberately: the raw property of an overflowed card
  // contains the marker by definition, and keeping the raw values is the
  // recovery path if any extraction rule here turns out to be wrong.
  add(
    'no field was left truncated by the exporter',
    volume.exportBugs.length === 0,
    volume.exportBugs.length
      ? `${volume.exportBugs.length}: ${volume.exportBugs.slice(0, 5).map((e) => `${e.id}/${e.field}`).join(', ')}`
      : 'none — every page with a body section had it stitched'
  );
  // Reported, never failed. These are fields whose overflow text is not on the
  // Notion board at all (the property carries the marker but no matching body
  // section exists), so no export can recover them and failing here would make
  // the corpus permanently unverifiable for a loss that predates it. The
  // operator still needs the list: it is the definitive record of what Notion
  // itself lost before being retired.
  add(
    'unrecoverable-at-source fields are listed, not hidden',
    true,
    volume.sourceMissing.length
      ? `${volume.sourceMissing.length} field(s) truncated on the BOARD with no body section to recover from: ` +
        volume.sourceMissing.map((e) => `${e.id}/${e.field}`).join(', ')
      : 'none'
  );

  if (manifest) {
    add(
      'record count matches the manifest',
      manifest.pagesExported === records.length,
      `manifest ${manifest.pagesExported} vs file ${records.length}`
    );
    add('the run was not partial', !manifest.partial, manifest.partial ? '--limit was set' : 'full run');
    add('the error manifest was empty', (manifest.errorCount || 0) === 0, `${manifest.errorCount} error(s)`);
    add(
      'no unknown block types were seen',
      !(manifest.unknownBlockTypes || []).length,
      (manifest.unknownBlockTypes || []).join(', ') || 'none'
    );
  }

  if (livePageIds !== null) {
    // `livePageIds` may be plain ids or {id, createdTime} — the latter turns a
    // weak containment check into a real completeness check, see below.
    // Set containment, NOT equality. The export takes ~60 minutes against a
    // board that gains cards continuously (5 appeared during the real run, four
    // of them filed by the session doing the export), so `live === exported`
    // can never hold and asserting it would make the corpus permanently
    // unverifiable. What actually matters is that nothing the export CLAIMED
    // has since vanished — a page in the corpus that no longer exists live
    // would mean the export invented or misread it.
    const liveRows = livePageIds.map((x) => (typeof x === 'string' ? { id: x, createdTime: null } : x));
    const live = new Set(liveRows.map((r) => r.id));
    const missing = records.map((r) => r.id).filter((id) => !live.has(id));
    add(
      'every exported page still exists on the board',
      missing.length === 0,
      missing.length ? `${missing.length} exported id(s) not found live: ${missing.slice(0, 5).join(', ')}` : 'all present'
    );

    // Containment alone is a WEAK signal — it proves nothing was invented, but
    // not that nothing was MISSED, which is the failure that actually matters
    // for a one-shot archive. Closed here: every live page absent from the
    // export must have been CREATED AFTER the export started. One that predates
    // the run and is not in the corpus was skipped, and that is a hole in the
    // archive. Needs createdTime, so it only runs when the caller supplied it.
    const exported = new Set(records.map((r) => r.id));
    // startedAt, or derived exactly from the two fields every manifest has
    // already carried (end minus duration). Without the fallback this check
    // would silently do nothing against any export taken before the field
    // existed — a check that quietly no-ops is worse than no check, because it
    // reports a ✅.
    const startedAt = manifest
      ? manifest.startedAt
        ? Date.parse(manifest.startedAt)
        : manifest.generatedAt && Number.isFinite(manifest.durationSec)
          ? Date.parse(manifest.generatedAt) - manifest.durationSec * 1000
          : null
      : null;
    const datedRows = liveRows.filter((r) => r.createdTime);
    if (startedAt && datedRows.length && !(manifest && manifest.partial)) {
      const skipped = datedRows.filter((r) => !exported.has(r.id) && Date.parse(r.createdTime) < startedAt);
      add(
        'no page that predates the export is missing from it',
        skipped.length === 0,
        skipped.length
          ? `${skipped.length} page(s) existed before the run and were never exported: ${skipped.slice(0, 5).map((r) => r.id).join(', ')}`
          : 'the export is a complete snapshot of the board as it was at start'
      );
    }
    // Reported, never failed — but named accurately. On a FULL run these are
    // cards created during the ~60-minute export (five appeared during the real
    // one). On a --limit run they are simply everything the run never reached.
    // Calling both "created since" would misdescribe a smoke test by 4,980.
    add(
      'live cards absent from this export are reported, not failed',
      true,
      `${live.size - records.filter((r) => live.has(r.id)).length} live card(s) not in this export` +
        (manifest && manifest.partial ? ' (expected — partial run)' : ' (created during the export)')
    );
  }

  if (baseline && baseline.totals) {
    for (const [field, base] of Object.entries(baseline.totals)) {
      const got = volume.totals[field];
      if (got === undefined) continue;
      const floor = Math.floor(base * (1 - tolerance));
      add(
        `volume ${field} >= baseline`,
        got >= floor,
        `${got.toLocaleString()} vs baseline ${base.toLocaleString()} (floor ${floor.toLocaleString()}, ` +
          `${base ? (((got - base) / base) * 100).toFixed(2) : '0.00'}%)`
      );
    }
    const baseFloor = Math.floor((baseline.records || 0) * (1 - tolerance));
    add(
      'record count >= baseline',
      records.length >= baseFloor,
      `${records.length} vs baseline ${baseline.records} (floor ${baseFloor})`
    );
  }

  return { ok: checks.every((c) => c.ok), checks, volume };
}

module.exports = {
  verifyCorpus,
  isStillTruncated,
  classifyTruncation,
  normalizeExpiringFileUrls,
  BODY_HEADING_PREFIX,
  BODY_HEADING_SUFFIX,
  OVERFLOWABLE,
  OVERFLOWABLE_FIELDS,
  FIELD_TO_PROPERTY,
  FIELD_TO_SECTION_KEY,
  SECTION_KEY_TO_FIELD,
  RICH_TEXT_BLOCK_TYPES,
  KNOWN_TEXTLESS_BLOCK_TYPES,
  bodyHeadingText,
  getHeadingText,
  isAutoHeading,
  reassembleField,
  blockPlainText,
  blocksPlainText,
  nonAutoBodyText,
  collectUnknownBlockTypes,
  maxBlockDepth,
  countBlocks,
  propertyPlainText,
  propertiesPlainText,
  buildRecord,
  charVolume,
};
