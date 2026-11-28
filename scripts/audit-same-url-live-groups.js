#!/usr/bin/env node
/**
 * audit-same-url-live-groups.js — list show folders holding 2+ live review
 * files with the same article url (BRO-5858). Advisory: exits 0 unless
 * --strict (CLAUDE.md s19).
 *
 * --probe-bylines fetches each group's url through fetchPage() and counts
 * every member critic's name on the live page, plus the page's own byline
 * (which may name none of them), so the plan author can decide who wrote it
 * from the page. Needs scraper keys: from cloud, run it through
 * cloud-run-script.js --review-texts.
 *
 * Usage:
 *   node scripts/audit-same-url-live-groups.js [--json] [--strict] [--probe-bylines] [--show=ID] [--limit=N]
 */
'use strict';
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { findSameUrlLiveGroups, findShowSameUrlLiveGroups, bylineMentions, SAME_URL_ALLOWLIST } = require('./lib/same-url-live-groups');

const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');

async function probe(groups) {
  const { fetchPage, cleanup } = require('./lib/scraper.js');
  const { extractByline, extractJsonLdAuthor } = require('./lib/byline-extraction.js');
  try {
    for (const g of groups) {
      const names = [...new Set(g.members.map((m) => m.criticName).filter(Boolean))];
      let res;
      try {
        const r = await fetchPage(g.members[0].url, {});
        const content = (r && typeof r.content === 'string') ? r.content : '';
        // The page's own byline too: the author may be none of the members.
        const by = (fn) => { try { return fn(content) || null; } catch { return null; } };
        res = {
          ok: content.length > 0, source: (r && r.source) || null, length: content.length,
          byline: by(extractByline), jsonLdAuthor: by(extractJsonLdAuthor),
          mentions: bylineMentions(content, names),
        };
      } catch (err) {
        res = { ok: false, error: String(err && err.message || err).slice(0, 120) };
      }
      g.probe = res;
      console.log(JSON.stringify({ showId: g.showId, key: g.key, files: g.members.map((m) => m.file), probe: res }));
    }
  } finally {
    if (typeof cleanup === 'function') await cleanup().catch(() => {});
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    console.log('Usage: node scripts/audit-same-url-live-groups.js [--json] [--strict] [--probe-bylines] [--show=ID] [--limit=N]');
    return 0;
  }
  const showArg = argv.find((a) => a.startsWith('--show='));
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  let result;
  if (showArg) {
    const all = findShowSameUrlLiveGroups(path.join(REVIEW_TEXTS_DIR, showArg.slice(7)));
    const allowed = (g) => Boolean(SAME_URL_ALLOWLIST[`${g.showId}|${g.key}`]);
    result = { groups: all.filter((g) => !allowed(g)), allowlisted: all.filter(allowed) };
  } else {
    result = findSameUrlLiveGroups(REVIEW_TEXTS_DIR);
  }
  let { groups } = result;
  if (limitArg) groups = groups.slice(0, Number(limitArg.slice(8)) || groups.length);

  if (argv.includes('--probe-bylines')) {
    await probe(groups);
  } else if (argv.includes('--json')) {
    console.log(JSON.stringify({ count: result.groups.length, allowlisted: result.allowlisted.length, groups }, null, 2));
  } else {
    for (const g of groups) {
      console.log(`${g.showId}  ${g.members.map((m) => `${m.file}{${m.criticName || '?'}}`).join('  ')}`);
    }
  }
  const shows = new Set(result.groups.map((g) => g.showId)).size;
  console.error(`same-url live groups: ${result.groups.length} across ${shows} shows (allowlisted: ${result.allowlisted.length})`);
  return argv.includes('--strict') && result.groups.length ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(2); });
