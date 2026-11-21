'use strict';
/**
 * Shape and copy rules for structuredTips.seating.sections (BRO-8018). Pure.
 * Shared by tests/unit/seating-data-coverage.test.mjs and the quarterly merge
 * (scripts/lib/theater-tips-validators.js validateMergedMetadata), so a section
 * that loses its sources or picks up an em dash fails in both places.
 */

const { VERDICTS, PRICE_TIERS, SHOW_TAGS, HAZARD_TYPES, copyProblems, theaterKeepProblems } = require('./seat-adjudication');

/**
 * @param {string} theater
 * @param {object[]} sections
 * @param {{forbiddenTitles?: string[]}} opts  Broadway show titles that are NOT current tenants here.
 * @returns {string[]} problems, empty when the sections are fine
 */
function validateSeatingSections(theater, sections, { forbiddenTitles = [] } = {}) {
  const p = [];
  if (!Array.isArray(sections)) return [`${theater}: sections is not an array`];
  for (const k of theaterKeepProblems(sections)) p.push(`${theater}: ${k}`);
  sections.forEach((s, i) => {
    const at = `${theater} / ${s && s.name ? s.name : `section[${i}]`}`;
    if (!s || typeof s.name !== 'string' || !s.name.trim()) p.push(`${at}: missing name`);
    if (!VERDICTS.has(s.verdict)) p.push(`${at}: bad verdict ${s.verdict}`);
    if (typeof s.verdictLabel !== 'string' || !s.verdictLabel.trim()) p.push(`${at}: missing verdictLabel`);
    if (s.priceTier !== undefined && !PRICE_TIERS.has(s.priceTier)) p.push(`${at}: bad priceTier ${s.priceTier}`);
    if (s.bestRow && !s.rowRange) p.push(`${at}: bestRow without rowRange`);
    for (const k of ['bestFor', 'worstFor']) for (const t of s[k] || []) if (!SHOW_TAGS.has(t)) p.push(`${at}: bad ${k} tag ${t}`);
    for (const h of s.hazards || []) if (!h || !HAZARD_TYPES.has(h.type) || !String(h.note || '').trim()) p.push(`${at}: bad hazard ${JSON.stringify(h)}`);
    const urls = Array.isArray(s.evidenceUrls) ? s.evidenceUrls.filter((u) => /^https?:\/\//.test(u)) : [];
    if (!urls.length) p.push(`${at}: no evidence URLs (unsourced)`);
    if (s.dataPoints !== undefined && s.dataPoints !== new Set(urls).size) p.push(`${at}: dataPoints ${s.dataPoints} != ${new Set(urls).size} evidence URLs`);
    const copy = [s.name, s.verdictLabel, s.rationale, ...(s.hazards || []).map((h) => h && h.note)].filter(Boolean).join(' \n ');
    for (const c of copyProblems(copy, { forbiddenTitles })) p.push(`${at}: ${c}`);
  });
  return p;
}

module.exports = { validateSeatingSections };
