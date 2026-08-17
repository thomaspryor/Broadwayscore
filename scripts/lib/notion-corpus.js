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
    if (b && b.type === 'paragraph') {
      parts.push(((b.paragraph && b.paragraph.rich_text) || []).map((t) => t.plain_text).join(''));
    }
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
      blocks: blocks || [],
    },
    comments: {
      count: Array.isArray(comments) ? comments.length : 0,
      items: Array.isArray(comments) ? comments : [],
    },
  };
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
function charVolume(records) {
  const totals = { notes: 0, outcome: 0, keyFiles: 0, body: 0, properties: 0 };
  let withOverflowMarker = 0;
  for (const r of records) {
    for (const f of OVERFLOWABLE_FIELDS) totals[f] += ((r.fields || {})[f] || '').length;
    totals.body += (((r.body || {}).text) || '').length;
    for (const v of Object.values(r.properties || {})) totals.properties += String(v || '').length;
    if (OVERFLOWABLE_FIELDS.some((f) => String((r.fields || {})[f] || '').includes(OVERFLOW_MARKER_SUBSTR))) {
      withOverflowMarker++;
    }
  }
  return { totals, records: records.length, withOverflowMarker };
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
function verifyCorpus({ records, manifest = null, baseline = null, tolerance = 0.02, livePageCount = null }) {
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
    'no reassembled field is still a truncated preview',
    volume.withOverflowMarker === 0,
    `${volume.withOverflowMarker} record(s) still carry the overflow marker in fields`
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

  if (livePageCount !== null) {
    add(
      'record count matches a live re-count of the board',
      livePageCount === records.length,
      `live ${livePageCount} vs exported ${records.length}`
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
  collectUnknownBlockTypes,
  maxBlockDepth,
  countBlocks,
  propertyPlainText,
  propertiesPlainText,
  buildRecord,
  charVolume,
};
