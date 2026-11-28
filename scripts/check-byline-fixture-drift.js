#!/usr/bin/env node
/**
 * BRO-7780: monthly byline drift check. For each outlet in tests/fixtures/byline-outlets/manifest.json,
 * fetch one live page (the fixture's own url) and read its byline with the shared reader
 * (page-byline.js). When an outlet's live page no longer yields the critic the fixture says it
 * prints, the outlet changed its template: the readers may now credit a poster, a house account or
 * nobody. That routes one owner alert (digest tier) naming the outlets, and the fixtures are
 * refreshed from the new pages (scripts/build-byline-fixtures.js).
 *
 *   node scripts/check-byline-fixture-drift.js --dry-run            (print, no alert)
 *   node scripts/check-byline-fixture-drift.js --outlets=theatermania,variety --dry-run
 *
 * A page that can't be fetched is "unreachable", not drift (paywalls and bot walls come and go);
 * drift is a page that WAS read and named someone else or nobody. Writes data/audit/byline-fixture-drift.json.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'tests', 'fixtures', 'byline-outlets', 'manifest.json');
const OUT = path.join(ROOT, 'data', 'audit', 'byline-fixture-drift.json');

/**
 * Classify one outlet's live read against its fixture. Pure.
 * @param {{expected: string}} fixture
 * @param {{error?: string, criticName?: string|null}} live
 * @returns {'same'|'drift'|'unreachable'}
 */
function classifyDrift(fixture, live) {
  const { sameCriticName } = require('./lib/byline-from-text');
  if (!live || live.error) return 'unreachable';
  // No name AND no article text: the fetch got an interstitial (captcha, bot wall, consent page),
  // not the article, so the page was not read. Only a page we read and found nobody on is drift.
  if (!live.criticName && !require('./lib/page-byline').articleWasRead(live.textLength)) return 'unreachable';
  if (!live.criticName) return 'drift';
  // Same key the record writer uses (aliases: "Zach Stewart" is zachary-stewart).
  const { normalizeCritic } = require('./lib/review-normalization');
  const same = sameCriticName(live.criticName, fixture.expected)
    || normalizeCritic(live.criticName) === normalizeCritic(fixture.expected);
  return same ? 'same' : 'drift';
}

async function main() {
  if (require('./lib/cli-help').hasHelpFlag(process.argv.slice(2))) { require('./lib/cli-help').exitOnHelp(module); return; }
  const args = new Set(process.argv.slice(2));
  const only = (process.argv.find((a) => a.startsWith('--outlets=')) || '').slice('--outlets='.length).split(',').filter(Boolean);
  const dryRun = args.has('--dry-run');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const fixtures = manifest.fixtures.filter((f) => !only.length || only.includes(f.outletId));
  const { fetchPage } = require('./lib/scraper');
  const { readPageByline } = require('./lib/page-byline');
  const { extractArticleTextFromUrl } = require('./lib/article-extractor');
  const results = [];
  for (const f of fixtures) {
    const live = {};
    const log = console.log;
    try {
      console.log = () => {};
      const page = await fetchPage(f.url, { directOnly: !process.env.BYLINE_DRIFT_PAID });
      const html = page && (page.content || page.html);
      if (!html) throw new Error((page && page.error) || 'no html');
      let text = '';
      try { text = extractArticleTextFromUrl(html, f.url) || ''; } catch { text = ''; }
      live.textLength = text.length;
      live.criticName = readPageByline({ html, text, url: f.url, outletId: f.outletId }).criticName || null;
    } catch (e) {
      live.error = String((e && e.message) || e).slice(0, 120);
    } finally { console.log = log; }
    const verdict = classifyDrift(f, live);
    results.push({ outletId: f.outletId, url: f.url, expected: f.expected, live: live.criticName || null, error: live.error || null, verdict });
    console.log(`${verdict.padEnd(11)} ${f.outletId.padEnd(26)} expected "${f.expected}" live ${live.error ? `(${live.error})` : `"${live.criticName}"`}`);
  }
  const drift = results.filter((r) => r.verdict === 'drift');
  const summary = { checkedAt: new Date().toISOString(), checked: results.length, same: results.filter((r) => r.verdict === 'same').length, drift: drift.length, unreachable: results.filter((r) => r.verdict === 'unreachable').length };
  console.log(JSON.stringify(summary));
  if (dryRun) return;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ ...summary, results }, null, 2) + '\n');
  if (drift.length) {
    const { routeAlert } = require('./lib/owner-alert-router');
    await routeAlert({
      conditionKey: 'byline:fixture-drift',
      title: `Byline drift: ${drift.length} outlet page(s) no longer name their critic the way the fixtures expect`,
      description: 'check-byline-fixture-drift.js read each outlet\'s fixture page live with the shared byline reader:\n'
        + drift.map((r) => `- ${r.outletId}: expected "${r.expected}", live read "${r.live || 'nobody'}" (${r.url})`).join('\n')
        + '\n\nThe outlet changed its template; new reviews from it may be credited to a poster, a house account or nobody. Replay: node scripts/check-byline-fixture-drift.js --outlets=<id> --dry-run',
      hint: 'Save the new page (sweep-stored-bylines.js --outlets=<id> --per-outlet=3 --save-html=<dir>), fix the reader in byline-extraction.js / content-quality.js outletBylineOverride, then rebuild the fixture with build-byline-fixtures.js.',
    });
  }
}

module.exports = { classifyDrift };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
