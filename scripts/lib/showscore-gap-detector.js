/**
 * showscore-gap-detector.js (BRO-4359): an opened show whose Show Score URL is
 * cached in data/show-score-urls.json but has no Show Score audience source in
 * audience-buzz.json. School Girls opened 2026-09-28 in that state (dead cached
 * URL) and nothing alerted; BRO-4358 made the scraper self-heal, this is the
 * detector for the class.
 */

// 7 days: a clean scrape of a small show with no audience reviews yet also
// leaves showScore null (scrape-show-score-audience.js), so give it time.
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
// A scrape that ran cleanly (showScoreLastAttempted stamped) and found no score
// is usually a live page with no ratings yet: wait longer before alerting.
const STAMPED_GRACE_MS = 21 * 24 * 60 * 60 * 1000;
const CATEGORIES = new Set(['broadway', 'off-broadway']);
// BRO-7023: a transfer with no NYC Show Score page yet is served London's page at the NYC slug.
// The scraper refuses it on purpose and re-checks every run, so the gap is expected and clears
// itself when the NYC page appears. Quiet only while the scraper keeps confirming that state.
const UK_WAIT_FRESH_MS = 3 * 24 * 60 * 60 * 1000;

function waitingOnNycPage(rec, now) {
  if (!rec) return false;
  const fresh = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) && now - t <= UK_WAIT_FRESH_MS; };
  if (fresh(rec.showScoreUkPageAt)) return true;
  // Older records: the tombstone the scraper wrote when it cleared London's rating, plus a fresh attempt.
  const tomb = rec.sourcesRemoved && rec.sourcesRemoved.showScore;
  return typeof tomb === 'string' && /UK production page/.test(tomb) && fresh(rec.showScoreLastAttempted);
}

/**
 * @param {object[]} shows        shows.json `shows` array
 * @param {object} urls           show-score-urls.json `shows` map (id -> url)
 * @param {object} buzz           audience-buzz.json `shows` map (id -> { sources })
 * @param {number} [now]          epoch ms
 * @returns {{id:string,category:string,openingDate:string,url:string}[]}
 */
function findShowScoreGaps(shows, urls, buzz, now = Date.now()) {
  const hits = [];
  for (const s of shows || []) {
    if (s.status !== 'open' || !CATEGORIES.has(s.category) || !s.openingDate) continue;
    const opened = Date.parse(s.openingDate);
    if (!Number.isFinite(opened) || now - opened < GRACE_MS) continue;
    const stamped = buzz?.[s.id]?.showScoreLastAttempted;
    if (stamped && now - opened < STAMPED_GRACE_MS) continue;
    const url = urls?.[s.id];
    // The scraper rejects off-off-broadway pages by design (isValidShowScorePage).
    if (!url || url.includes('/off-off-broadway-shows/')) continue;
    if (buzz?.[s.id]?.sources?.showScore != null) continue;
    if (waitingOnNycPage(buzz?.[s.id], now)) continue;
    hits.push({ id: s.id, category: s.category, openingDate: s.openingDate, url });
  }
  return hits.sort((a, b) => a.openingDate.localeCompare(b.openingDate));
}

module.exports = { findShowScoreGaps };
