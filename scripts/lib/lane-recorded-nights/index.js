'use strict';
/**
 * The recorded rehearsal (BRO-5201 S4-T3): replay real opening nights through the production lane wiring, offline, and
 * grade each one like a press night. A pass here is what arms the lane (rehearsal.ARMING_REHEARSAL_KINDS).
 *
 * Each night's pages are links-and-structure fixtures rebuilt from that night (no article text). What makes the
 * rehearsal "recorded" rather than synthetic is the provenance check: every review the fixture says an aggregator
 * listed must appear in that aggregator's page as archived on the night (data/aggregator-archive, private repo). With
 * no archive the rehearsal reports skipped and never passes, so a fixture drifting from the real night cannot arm.
 */
const fs = require('fs');
const path = require('path');
const afgm = require('./a-few-good-men-2026');
const ii = require('./the-imaginary-invalid-2026');

const AGGREGATORS = ['show-score', 'playbill-verdict', 'dtli', 'bww-reviews', 'bww-roundups'];

/**
 * nights: the review URLs the fixture expects, and those that reach the lane only from a non-aggregator source (a
 * Talkin' Broadway named page, Google News, a Substack post) and so are not checked against the archive.
 */
const NIGHTS = [
  {
    show: afgm.SHOW.id,
    urls: () => Object.values(afgm.U),
    offAggregator: ['https://www.talkinbroadway.com/page/world/AFewGoodMen.html'],
    replay: () => afgm.replay({ site: true }),
  },
  {
    show: ii.SHOW.id,
    urls: () => Object.values(ii.EXPECTED),
    offAggregator: [ii.E.vulture, ii.E.talkinbroadway, ii.EXPECTED.singleticket],
    replay: () => ii.replayNight({ site: true }),
  },
];

/** Scheme, www., fragment and trailing slash do not tell two review links apart; the query string can, so it stays. */
const bare = (u) => u.trim().replace(/&amp;/g, '&').replace(/^https?:\/\/(www\.)?/i, '').replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();

/** Every link target on the pages, normalised. Exact matches only: a URL that is a prefix of a longer one, or that
 * appears only in page text, is not a link the aggregator listed. */
function pageLinks(html) {
  const links = new Set();
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) links.add(bare(m[1]));
  return links;
}

/** Fixture URLs that should be on an archived aggregator page and are not. null when the night has no archived page. */
function provenanceGaps(night, archiveDir) {
  const files = AGGREGATORS.map((a) => path.join(archiveDir, a, `${night.show}.html`)).filter((f) => fs.existsSync(f));
  if (!files.length) return null;
  const links = pageLinks(files.map((f) => fs.readFileSync(f, 'utf8')).join('\n'));
  const off = new Set(night.offAggregator.map(bare));
  return night.urls().filter((u) => !off.has(bare(u)) && !links.has(bare(u)));
}

/**
 * Run every recorded night. Returns {skipped: true, reason} when the archive is missing (never a pass), else
 * {pass, verdict: {checked, failures}, nights}. checked counts the reviews that went live across the nights.
 * @param {{archiveDir: string, nights?: object[]}} opts
 */
async function runRecordedRehearsal({ archiveDir, nights = NIGHTS } = {}) {
  if (!archiveDir || !fs.existsSync(archiveDir)) return { skipped: true, reason: `no aggregator archive at ${archiveDir}` };
  const failures = [];
  const out = [];
  let checked = 0;
  for (const night of nights) {
    const gaps = provenanceGaps(night, archiveDir);
    if (gaps === null) return { skipped: true, reason: `no archived aggregator page for ${night.show}` };
    if (gaps.length) failures.push({ show: night.show, check: 'provenance', detail: `not on the archived aggregator pages: ${gaps.join(', ')}` });
    const r = await night.replay();
    const g = r.graded;
    checked += r.live.length;
    if (g.sameNight.status !== 'pass') failures.push({ show: night.show, check: 'same-night-completeness', detail: g.sameNight.detail });
    for (const p of g.runProblems) failures.push({ show: night.show, check: 'lane-run', detail: p });
    out.push({ show: night.show, live: r.live.length, sameNight: g.sameNight.status, verdict: g.verdict, sourceErrors: g.sourceErrors.length });
  }
  return { pass: failures.length === 0 && checked > 0, verdict: { checked, failures }, nights: out };
}

module.exports = { NIGHTS, AGGREGATORS, pageLinks, provenanceGaps, runRecordedRehearsal };
