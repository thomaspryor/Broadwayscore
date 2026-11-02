'use strict';

/**
 * Near-miss show ids in a verify-data-backfill acceptance command (BRO-6736).
 *
 * A card filed with `verify-data-backfill.js --show=laowang-off-broadway-2026`
 * when the show is laowang-a-chinatown-king-lear-off-broadway-2025 can never
 * pass: the probe prints "show missing" forever, stuck-card-closer bounces the
 * finished card back to Todo and a second worker is dispatched onto done work.
 * BRO-6736's filer guessed 5 of 15 ids this way (school-girls, laowang,
 * dinosaurs, monsters, marjorie-prime).
 *
 * An id that is simply absent is NOT a defect on its own: a card that adds a
 * show names the id it will create. So only a near miss is reported, an
 * unknown id whose title words begin a real show's title words (optionally
 * after "the"), opening within a year. A new production of an existing title
 * (same words, another year) stays allowed. An id with no "-YYYY" segment
 * (`cats`, `all`, `broadway`) is never a show id (every id carries its year),
 * so it is always reported, with same-title ids as suggestions.
 */

const fs = require('fs');
const path = require('path');

const FORM_RE = /^node scripts\/lib\/verify-data-backfill\.js --show=([a-z0-9,-]+)/;
const HAS_YEAR_RE = /-\d{4}(?:-|$)/;
const MARKET_SUFFIX_RE = /-(?:off-off-broadway|off-broadway|off-west-end|west-end|regional|tour|bway)$/;

/** { core: ['laowang'], year: 2026 } from an id; the year is null when absent. */
function idCore(id) {
  let s = String(id || '');
  let year = null;
  const y = /-(\d{4})$/.exec(s);
  if (y) { year = Number(y[1]); s = s.slice(0, -5); }
  for (let prev = null; prev !== s;) { prev = s; s = s.replace(MARKET_SUFFIX_RE, ''); }
  return { core: s.split('-').filter(Boolean), year };
}

function startsWithTokens(longer, prefix) {
  return prefix.length > 0 && prefix.length <= longer.length && prefix.every((t, i) => longer[i] === t);
}

/**
 * Real ids the unknown id most likely meant: a strictly longer title that
 * starts with its words, or the same words behind a leading "the".
 * @param {string} id unknown id
 * @param {string[]} knownIds
 */
function nearMissIds(id, knownIds) {
  const want = idCore(id);
  if (!want.core.length) return [];
  const bare = !HAS_YEAR_RE.test(String(id));
  const out = [];
  for (const k of knownIds) {
    const have = idCore(k);
    if (want.year && have.year && Math.abs(want.year - have.year) > 1) continue;
    const words = have.core[0] === 'the' && want.core[0] !== 'the' ? have.core.slice(1) : have.core;
    if (!bare && words.join('-') === want.core.join('-') && words.length === have.core.length) continue; // same title: new production
    if (startsWithTokens(words, want.core)) out.push(k);
  }
  return out.slice(0, 5);
}

/**
 * @param {string} cmd acceptance command
 * @param {{repoRoot?: string, showIds?: string[]}} [opts] showIds overrides shows.json (tests)
 * @returns {{reason: string, misses: Array<{id: string, suggestions: string[]}>}|null}
 *   null when the command is another form, every id exists, or shows.json is
 *   unreadable (fail open: a CI runner without the data repo).
 */
function backfillShowIdNearMisses(cmd, opts = {}) {
  const m = FORM_RE.exec(String(cmd || '').trim());
  if (!m) return null;
  let known = opts.showIds;
  if (!known) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(opts.repoRoot || path.join(__dirname, '..', '..'), 'data', 'shows.json'), 'utf8'));
      known = (Array.isArray(raw) ? raw : raw.shows || []).map((s) => s && s.id).filter(Boolean);
    } catch {
      return null;
    }
  }
  const knownSet = new Set(known);
  const misses = [];
  for (const id of new Set(m[1].split(',').filter(Boolean))) {
    if (knownSet.has(id)) continue;
    const suggestions = nearMissIds(id, known);
    if (suggestions.length || !HAS_YEAR_RE.test(id)) misses.push({ id, suggestions });
  }
  if (!misses.length) return null;
  return {
    misses,
    // Only a year-less id is certain to be wrong (no show id lacks its year).
    // A title-prefix near miss may be a new production of a classic title
    // (ship-check: 383 synthetic next-year/off-Broadway ids matched a
    // regional id), so it warns at filing and never refuses a dispatch.
    blocking: misses.some((x) => !HAS_YEAR_RE.test(x.id)),
    reason: `verify-data-backfill names show id(s) that do not exist: ${misses.map((x) => (x.suggestions.length ? `${x.id} (did you mean ${x.suggestions.join(' or ')}?)` : `${x.id} (not a show id: ids end in their year)`)).join('; ')}`,
  };
}

module.exports = { backfillShowIdNearMisses, nearMissIds, idCore };
