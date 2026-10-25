'use strict';

/**
 * Critic-slug alias registry (2026 data audit, Sprint 5 / S5-T9).
 *
 * Critic pages live at /critics/<slug>, and the slug is derived from the
 * byline (src/lib/data-reviews.ts, slugify()). When the derivation changes
 * (diacritic folding, S7-T3) or two spellings of one critic are merged, the
 * old URL stops resolving. The owner chose redirects over keeping the old
 * pages: this registry maps each retired slug to the canonical one.
 *
 * ONE file, core data (CLAUDE.md §11 — private repo, gitignored here,
 * resolved via data/ exactly like shows.json; synced by push-core-data's
 * CORE_FILES, restored by checkout-core-data's *.json copy, symlinked into a
 * local checkout by scripts/setup-local-data.sh):
 *   data/critic-slug-aliases.json — JSON object {"<old-slug>": "<canonical-slug>"}
 *     Keys starting with "_" are annotations (`_note`) and are ignored.
 *
 * Consumers:
 *   - scripts/build-slug-redirects.js (prebuild) folds every entry into
 *     data/slug-redirects-compact.json under CRITIC_REDIRECT_PREFIX, next to
 *     the /show/* entries. That compact map is what BOTH src/middleware.ts
 *     (301 /critics/<old> → /critics/<canonical>) and src/lib/data-reviews.ts
 *     getCriticBySlug() read, so the redirect and the page can never disagree.
 *   - Template + seed entries: tests/fixtures/critic-slug-aliases.seed.json.
 *
 * A MISSING file is an empty registry (the file did not exist before this
 * sprint, and a checkout without core data must still build). A MALFORMED
 * file is loud — silently treating it as empty is how every redirect would
 * vanish in one bad edit. Same contract as scripts/lib/retired-show-ids.js.
 *
 * Paths: the exported constant is the canonical repo location. Tests (and
 * only tests) point the loader elsewhere via the CRITIC_SLUG_ALIASES_PATH
 * environment variable or the per-call `aliasesPath` option.
 */

const fs = require('fs');
const path = require('path');
const { criticProfileKey } = require('./url-slug');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CRITIC_SLUG_ALIASES_PATH = path.join(REPO_ROOT, 'data', 'critic-slug-aliases.json');

// Key prefix that namespaces critic entries inside data/slug-redirects-compact.json.
// Show entries are bare slugs and slugify() never emits ":", so the two can
// never collide. Mirrored verbatim in src/lib/slug-redirects.ts
// (CRITIC_REDIRECT_PREFIX) for the edge middleware, which cannot require()
// this module; tests/unit/slug-redirects.test.ts asserts the two agree.
const CRITIC_REDIRECT_PREFIX = 'critic:';

function resolveAliasesPath(opts) {
  return (opts && opts.aliasesPath) || process.env.CRITIC_SLUG_ALIASES_PATH || CRITIC_SLUG_ALIASES_PATH;
}

function normalizeSlug(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Pure: turn the parsed registry object into a clean {old: canonical} map.
 * Keys/values are trimmed + lowercased (URLs are matched lowercase); "_"-prefixed
 * keys are annotations; anything that is not a non-empty string target is
 * reported in `skipped` rather than thrown, so one bad line cannot take the
 * other redirects down with it.
 * @param {unknown} parsed
 * @returns {{aliases: Record<string,string>, skipped: Array<{key:string, reason:string}>}}
 */
function normalizeCriticSlugAliases(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `critic-slug-aliases registry must be a JSON object of {"<old-slug>": "<canonical-slug>"}, got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}`
    );
  }
  const aliases = {};
  const skipped = [];
  for (const [rawKey, rawValue] of Object.entries(parsed)) {
    if (rawKey.startsWith('_')) continue; // _note / _meta style annotation
    const key = normalizeSlug(rawKey);
    const value = normalizeSlug(rawValue);
    if (!key) {
      skipped.push({ key: rawKey, reason: 'empty key' });
      continue;
    }
    if (!value) {
      skipped.push({ key: rawKey, reason: 'target must be a non-empty string' });
      continue;
    }
    if (aliases[key] !== undefined && aliases[key] !== value) {
      skipped.push({ key: rawKey, reason: `duplicate of "${key}" (case/whitespace variant) which already maps to "${aliases[key]}"` });
      continue;
    }
    aliases[key] = value;
  }
  return { aliases, skipped };
}

/**
 * Read the registry from disk (always fresh — no cache).
 * @returns {Record<string,string>} {old: canonical}; {} when the file does not
 *   exist or is empty. Throws when the file is present but not a JSON object.
 *   Skipped entries are reported on stderr (see normalizeCriticSlugAliases).
 */
function loadCriticSlugAliases(opts) {
  const filePath = resolveAliasesPath(opts);
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.trim() === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`critic-slug-aliases registry is not valid JSON (${filePath}): ${e.message}`);
  }
  let normalized;
  try {
    normalized = normalizeCriticSlugAliases(parsed);
  } catch (e) {
    throw new Error(`${e.message} (${filePath})`);
  }
  for (const s of normalized.skipped) {
    console.warn(`critic-slug-aliases: skipped "${s.key}" — ${s.reason} (${filePath})`);
  }
  return normalized.aliases;
}

/**
 * Pure: resolve alias chains so every entry points at a slug that is NOT
 * itself an alias (a → b, b → c becomes a → c, b → c). A self-map or a cycle
 * (a → b → a) has no canonical end and is dropped with a reason — emitting it
 * would make the middleware redirect in a loop.
 * @param {Record<string,string>} aliases
 * @returns {{aliases: Record<string,string>, dropped: Array<{slug:string, reason:string}>}}
 */
function flattenCriticSlugAliases(aliases) {
  const out = {};
  const dropped = [];
  for (const start of Object.keys(aliases)) {
    if (aliases[start] === start) {
      dropped.push({ slug: start, reason: 'maps to itself' });
      continue;
    }
    const seen = new Set([start]);
    let target = aliases[start];
    let cycle = false;
    while (Object.prototype.hasOwnProperty.call(aliases, target)) {
      if (seen.has(target)) {
        cycle = true;
        break;
      }
      seen.add(target);
      target = aliases[target];
    }
    if (cycle) {
      dropped.push({ slug: start, reason: `cycle (${[...seen].join(' → ')} → ${target})` });
      continue;
    }
    out[start] = target;
  }
  return { aliases: out, dropped };
}

/**
 * Pure: every critic-page slug the reviews could produce (criticProfileKey of
 * each byline). A SUPERSET of the live /critics pages: src/lib/data-reviews.ts
 * also leaves out reviews outside the profiled markets/categories, so an alias
 * whose canonical exists only there passes this check and still 404s.
 * @param {Array<{criticName?: unknown}>} reviews
 * @returns {Set<string>}
 */
function criticSlugsFromReviews(reviews) {
  const slugs = new Set();
  for (const r of reviews || []) {
    const key = criticProfileKey(r && r.criticName);
    if (key) slugs.add(key);
  }
  return slugs;
}

// More than this many dead canonicals in one build is a broken reviews.json
// (empty or truncated restore), not critics leaving: fail loudly instead of
// silently dropping every redirect, the same stance as a malformed registry.
const MAX_DEAD_CANONICAL_DROPS = 5;

/**
 * Drop aliases whose canonical slug no review byline produces. A critic page
 * exists only while some review carries that byline; when a rebuild removes a
 * critic's last review (BRO-5434: "John Peter"), the alias would 301 to a 404
 * and the alias test on main goes red until someone hand-edits the registry.
 * `liveSlugs` null (no reviews.json in this checkout) keeps every alias.
 * Throws when more than MAX_DEAD_CANONICAL_DROPS would go.
 * @param {Record<string,string>} flatAliases output of flattenCriticSlugAliases().aliases
 * @param {Set<string>|null} liveSlugs output of criticSlugsFromReviews()
 * @returns {{aliases: Record<string,string>, dropped: Array<{slug:string, reason:string}>}}
 */
function dropAliasesWithoutLiveCanonical(flatAliases, liveSlugs) {
  if (!liveSlugs) return { aliases: { ...flatAliases }, dropped: [] };
  const aliases = {};
  const dropped = [];
  for (const [oldSlug, canonical] of Object.entries(flatAliases)) {
    if (liveSlugs.has(canonical)) aliases[oldSlug] = canonical;
    else dropped.push({ slug: oldSlug, reason: `canonical "${canonical}" has no critic page (no review carries that byline)` });
  }
  if (dropped.length > MAX_DEAD_CANONICAL_DROPS) {
    throw new Error(
      `${dropped.length} of ${Object.keys(flatAliases).length} critic aliases point at critics no review carries (limit ${MAX_DEAD_CANONICAL_DROPS}); reviews.json has ${liveSlugs.size} critic bylines — refusing to drop them, check that reviews.json is complete`
    );
  }
  return { aliases, dropped };
}

/**
 * Pure: the compact-map entries for a flattened alias map —
 * { "critic:<old>": "<canonical>" }. Always permanent (301): an old critic
 * slug has exactly one successor, unlike a versionless show slug that may
 * name several productions.
 * @param {Record<string,string>} flatAliases output of flattenCriticSlugAliases().aliases
 * @returns {Record<string,string>}
 */
function buildCriticRedirectEntries(flatAliases) {
  const entries = {};
  for (const [oldSlug, canonical] of Object.entries(flatAliases)) {
    entries[CRITIC_REDIRECT_PREFIX + oldSlug] = canonical;
  }
  return entries;
}

module.exports = {
  CRITIC_SLUG_ALIASES_PATH,
  CRITIC_REDIRECT_PREFIX,
  normalizeCriticSlugAliases,
  loadCriticSlugAliases,
  flattenCriticSlugAliases,
  criticSlugsFromReviews,
  dropAliasesWithoutLiveCanonical,
  MAX_DEAD_CANONICAL_DROPS,
  buildCriticRedirectEntries,
};
