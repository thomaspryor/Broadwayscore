'use strict';
/**
 * Pure helpers for the Anthropic and Gemini shutdown drift checks (BRO-7342).
 *
 * Same gap BRO-7339 closed for OpenAI: research-cost.js MODEL_SHUTDOWNS is hand
 * maintained, so a provider retiring a model we pin (models.js COPY_FALLBACK_SONNET,
 * CLAUDE_HAIKU, GEMINI_FLASH and inline uses) was invisible. These parsers turn each
 * provider's own page into the row shape openai-deprecations.js driftReport() takes,
 * so one report function serves all three.
 *
 * Anthropic: https://platform.claude.com/docs/en/about-claude/model-deprecations
 *   HTML tables. (a) "API model name | Current state | Deprecated | Tentative retirement
 *   date": only rows whose state is Deprecated and whose date is a real date count (an
 *   Active row's "Not sooner than ..." is a floor, not a schedule). (b) "Retirement date |
 *   Deprecated model | Recommended replacement": already-retired or dated retirements.
 * Gemini: https://ai.google.dev/gemini-api/docs/deprecations (served as Markdoc
 *   `{% table %}` blocks with `* cell` bullets and `---` row separators). Columns are
 *   found by header name; "No shutdown date announced" and "N/A" rows are not dated.
 */
const { parseShutdownDate, driftReport } = require('./openai-deprecations');

const stripTags = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Anthropic dated snapshot suffix: claude-sonnet-4-5-20250929 -> claude-sonnet-4-5. */
function anthropicBaseId(id) {
  return String(id || '').replace(/-\d{8}$/, '');
}

/** Gemini ids carry no dated-snapshot suffix to fold ("-preview-09-2025" is part of the id). */
function geminiBaseId(id) {
  return String(id || '');
}

const CLAUDE_ID = /\bclaude-[a-z0-9][a-z0-9.-]*[a-z0-9]/g;

function anthropicRowIds(cellHtml) {
  const labelled = [...String(cellHtml).matchAll(/aria-label="Copy model ID ([^"]+)"/g)].map((m) => m[1].trim());
  const ids = labelled.length ? labelled : (stripTags(cellHtml).match(CLAUDE_ID) || []);
  return [...new Set(ids)];
}

/** @returns {{shutdown:string, ids:string[], replacement:string|null}[]} */
function parseAnthropicDeprecations(html) {
  const rows = [];
  for (const tr of String(html).match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length < 3) continue;
    const dateFirst = parseShutdownDate(stripTags(cells[0]));
    if (dateFirst) { // "Retirement date | Deprecated model | Recommended replacement"
      const ids = anthropicRowIds(cells[1]);
      if (!ids.length) continue;
      rows.push({ shutdown: dateFirst, ids, replacement: anthropicRowIds(cells[2])[0] || null });
    } else if (cells.length >= 4 && /^deprecated$/i.test(stripTags(cells[1]))) { // "name | state | deprecated | tentative retirement"
      const shutdown = parseShutdownDate(stripTags(cells[3]).replace(/^not sooner than\s+/i, ''));
      const ids = anthropicRowIds(cells[0]);
      if (shutdown && ids.length) rows.push({ shutdown, ids, replacement: null });
    }
  }
  return rows;
}

/** Rows that name a claude-* model in a retirement-style table: the parser's denominator. */
function countAnthropicModelRows(html) {
  let n = 0;
  for (const tr of String(html).match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length < 3) continue;
    if (parseShutdownDate(stripTags(cells[0])) && anthropicRowIds(cells[1]).length) n++;
    else if (cells.length >= 4 && /^deprecated$/i.test(stripTags(cells[1])) && anthropicRowIds(cells[0]).length) n++;
  }
  return n;
}

/** Markdoc tables -> arrays of rows (each an array of cell strings); the first row of a table is its header. */
function geminiTables(text) {
  const tables = [];
  for (const block of String(text).match(/\{% table %\}[\s\S]*?\{% \/table %\}/g) || []) {
    const body = block.replace(/\{% \/?table %\}/g, '');
    const rows = body.split(/^\s*---\s*$/m).map((chunk) => chunk.split('\n')
      .map((l) => l.match(/^\s*\* ?(.*)$/)).filter(Boolean).map((m) => m[1].trim()));
    tables.push(rows.filter((r) => r.length));
  }
  return tables;
}

const backticked = (cell) => [...String(cell || '').matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());

/** @returns {{shutdown:string, ids:string[], replacement:string|null}[]} */
function parseGeminiDeprecations(text) {
  const rows = [];
  for (const table of geminiTables(text)) {
    const [header, ...data] = table;
    const iModel = header.findIndex((h) => /^model/i.test(h));
    const iShut = header.findIndex((h) => /shutdown/i.test(h));
    const iRep = header.findIndex((h) => /replacement/i.test(h));
    if (iModel < 0 || iShut < 0) continue;
    for (const r of data) {
      const shutdown = parseShutdownDate(r[iShut]);
      const ids = backticked(r[iModel]);
      if (shutdown && ids.length) rows.push({ shutdown, ids: [...new Set(ids)], replacement: backticked(r[iRep])[0] || null });
    }
  }
  return rows;
}

/** Gemini table rows that name a model whose shutdown cell holds a date-like value (the denominator). */
function countGeminiModelRows(text) {
  let n = 0;
  for (const [header, ...data] of geminiTables(text)) {
    const iModel = header.findIndex((h) => /^model/i.test(h));
    const iShut = header.findIndex((h) => /shutdown/i.test(h));
    if (iModel < 0 || iShut < 0) continue;
    for (const r of data) if (backticked(r[iModel]).length && /\d{4}/.test(r[iShut] || '')) n++;
  }
  return n;
}

/** Quoted claude-* ids in a source file, folded to the base alias. */
function referencedAnthropicIds(source) {
  const out = new Set();
  for (const m of String(source).matchAll(/['"`](claude-[a-z0-9][a-z0-9.-]*[a-z0-9])['"`]/g)) out.add(anthropicBaseId(m[1]));
  return out;
}

/** Quoted gemini-* ids in a source file. */
function referencedGeminiIds(source) {
  const out = new Set();
  for (const m of String(source).matchAll(/['"`](gemini-[a-z0-9][a-z0-9.-]*[a-z0-9])['"`]/g)) out.add(m[1]);
  return out;
}

/** Everything audit-provider-retirements.js needs per provider, in one place so the test covers the wiring. */
const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    url: 'https://platform.claude.com/docs/en/about-claude/model-deprecations',
    parse: parseAnthropicDeprecations,
    count: countAnthropicModelRows,
    referenced: referencedAnthropicIds,
    baseIdFn: anthropicBaseId,
    minRows: 10,
  },
  gemini: {
    name: 'Gemini',
    url: 'https://ai.google.dev/gemini-api/docs/deprecations',
    parse: parseGeminiDeprecations,
    count: countGeminiModelRows,
    referenced: referencedGeminiIds,
    baseIdFn: geminiBaseId,
    minRows: 3,
  },
};

/**
 * @param {'anthropic'|'gemini'} provider
 * @param {string} pageText
 * @returns {{page:object[], modelRows:number, inputMissing:boolean}}
 *   inputMissing: too few rows parsed (block page, layout change), judged against the
 *   provider's minimum and against the rows that name a model at all.
 */
function readProviderPage(provider, pageText) {
  const p = PROVIDERS[provider];
  const page = p.parse(pageText);
  const modelRows = p.count(pageText);
  return { page, modelRows, inputMissing: page.length < p.minRows || page.length < 0.8 * modelRows };
}

module.exports = {
  PROVIDERS, readProviderPage, anthropicBaseId, geminiBaseId,
  parseAnthropicDeprecations, countAnthropicModelRows, parseGeminiDeprecations, countGeminiModelRows,
  referencedAnthropicIds, referencedGeminiIds, driftReport,
};
