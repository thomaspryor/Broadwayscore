'use strict';
/**
 * BRO-7649 class guard: a Playwright screenshot baseline taken on a LIVE route
 * (production data: review counts, LLM Critics' Take, tallies) drifts whenever
 * the data does, turning main red with no code change. Every toHaveScreenshot
 * in a spec that visits a live route must be preceded, in the same test (or a
 * beforeEach), by freezeLiveShowData() from tests/e2e/helpers/freeze-live-data.ts.
 *
 * Specs that only visit mock/fixture pages (/test/*, ?mock=1, goToMock helpers)
 * render pinned data already and are exempt.
 */

const FREEZE_CALL = 'freezeLiveShowData(';

/** Route literals the spec navigates to: goto('/x'), goto(`/x...`), and *_URL = '/x' constants. */
function routeLiterals(source) {
  const out = [];
  const re = /(?:goto\(\s*|_URL\s*=\s*)(['"`])(\/[^'"`]*)\1?/g;
  let m;
  while ((m = re.exec(source))) out.push(m[2]);
  return out;
}

function isMockRoute(route) {
  return /^\/test(\/|$)/.test(route) || /[?&]mock=1/.test(route);
}

/** True when the spec visits at least one route that serves live production data. */
function visitsLiveRoute(source) {
  return routeLiterals(source).some((r) => !isMockRoute(r));
}

/** Index of the function body's `{` (after `=>`), skipping `({ page })` destructuring. */
function bodyOpen(source, from) {
  const arrow = source.indexOf('=>', from);
  return arrow < 0 ? -1 : source.indexOf('{', arrow);
}

/**
 * Split a spec into test() bodies. Returns [{ name, start, body }]. Brace
 * matching skips string/template contents well enough for spec files.
 */
function testBlocks(source) {
  const blocks = [];
  const re = /\btest(?:\.(?:only|skip|fixme))?\(\s*(['"`])([^'"`]*)\1\s*,/g;
  let m;
  while ((m = re.exec(source))) {
    const open = bodyOpen(source, m.index + m[0].length);
    if (open < 0) continue;
    let depth = 0;
    let i = open;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) break;
    }
    blocks.push({ name: m[2], start: m.index, body: source.slice(open, i + 1) });
  }
  return blocks;
}

function beforeEachBodies(source) {
  const bodies = [];
  const re = /test\.beforeEach\(/g;
  let m;
  while ((m = re.exec(source))) {
    const open = bodyOpen(source, m.index);
    if (open < 0) continue;
    let depth = 0;
    let i = open;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) break;
    }
    bodies.push(source.slice(open, i + 1));
  }
  return bodies;
}

/**
 * Returns the names of tests that screenshot a live route without first
 * freezing its data. Empty array = compliant (or not a live screenshot spec).
 */
function findUnfrozenLiveScreenshots(source) {
  if (!source.includes('toHaveScreenshot') || !visitsLiveRoute(source)) return [];
  const frozenInHook = beforeEachBodies(source).some((b) => b.includes(FREEZE_CALL));
  const offenders = [];
  for (const { name, body } of testBlocks(source)) {
    const shot = body.indexOf('toHaveScreenshot');
    if (shot < 0) continue;
    const freeze = body.indexOf(FREEZE_CALL);
    if (frozenInHook || (freeze >= 0 && freeze < shot)) continue;
    offenders.push(name);
  }
  return offenders;
}

module.exports = { findUnfrozenLiveScreenshots, visitsLiveRoute, routeLiterals, isMockRoute, FREEZE_CALL };
