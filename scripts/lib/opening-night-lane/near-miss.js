'use strict';
/**
 * Press-night near-misses and found-vs-live gaps (BRO-7748).
 *
 * Blue Man Group "A New Holiday Surprise", 2026-11-18: TheaterMania listed its review at 02:00Z. The lane read that
 * index entry, the strict matcher (titleMatchesShow / urlSlugMatchesShow) refused it because the headline lacked the
 * subtitle, and the candidate vanished. Nothing alerted; the owner found the review on Google an hour later.
 *
 * Two signals, both computed from what a discovery pass already fetched (no new fetches, no paid volume):
 *   near-miss  a review-like link from a KNOWN outlet that names part of tonight's show (its lead title words, most of
 *              its title words, corroborated by venue or cast) but fails the strict matcher. Never admitted: it is
 *              reported so a person can look at it and add it in one command.
 *   gap        a known-outlet review the night's sources vouch for (an aggregator roundup cites it, or the outlet's own
 *              feed / index / Google News site search lists it with a review signal) that is still not on disk or in
 *              the lane ledger GAP_AFTER_MS after the lane first saw it, and was not refused for a deliberate reason.
 *
 * Each URL alerts once per kind per night: the night's `<night>.press-signals.jsonl` beside the ledger remembers it.
 * Pure helpers apart from recordNew (CLAUDE.md rule 15); discovery.js and lane-runner.js call them.
 */
const fs = require('fs');
const path = require('path');
const { foldDiacritics } = require('../title-match');

const GAP_AFTER_MS = 15 * 60 * 1000;
// At most this many near-misses per adapter per pass: a feed that changes shape must not flood the queue.
const MAX_NEAR_MISSES_PER_ADAPTER = 5;
// Refusals that are the lane working as designed: an earlier production's review, a news or gallery page, a homepage, a
// redirect wrapper, an unknown host. A gap alert for these would be noise.
const INTENDED_REJECTIONS = new Set(['outside-night-window', 'non-review-path', 'non-review-slug', 'homepage', 'wrapped-url', 'unknown-outlet-host', 'unknown-source']);
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'at', 'on', 'to', 'for', 'with', 'from', 'by', 'or', 'is', 'new', 'musical', 'play', 'broadway', 'theatre', 'theater', 'show']);

function fold(t) {
  return ' ' + foldDiacritics(String(t || '')).toLowerCase()
    .replace(/[‘’ʼ']/g, '').replace(/&amp;/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
}

function slugText(url) {
  try { return decodeURIComponent(new URL(url).pathname).replace(/[-_/.]+/g, ' ').replace(/\b\d{3,}\b/g, ' '); } catch { return ''; }
}

const sig = (t) => fold(t).trim().split(' ').filter((w) => w.length > 1 && !STOP.has(w));

/**
 * The show title before its subtitle: a quoted subtitle, a colon, a dash or a parenthetical. Unlike rss-discovery's
 * mainTitleOf this splits colons too and does not need the lead to be unique among all shows: a near-miss is only
 * reported, never admitted. Null when the lead has fewer than 2 significant words ("Hamlet" alone is no evidence).
 */
function leadTitle(showTitle) {
  const t = String(showTitle || '');
  const cut = t.split(/\s*[“"‘]|\s*:\s+|\s+[-–—]\s+|\s*\(/)[0].trim();
  if (!cut || cut === t.trim()) return null;
  return sig(cut).length >= 2 ? cut : null;
}

function hasPhrase(hay, phrase) {
  const p = fold(phrase).trim();
  return !!p && (hay.includes(` ${p} `) || hay.includes(` ${p}s `));
}

/**
 * Why a link partly names the show, or [] when it does not. A base signal (lead title, most title words, or venue AND a
 * cast member together) is required; venue or one cast name alone only corroborates (star and venue news would spam).
 * @param {{title?: string, url: string}} item
 * @param {{title: string, venue?: string, cast?: Array<{name?: string}|string>}} show
 */
function nearMissSignals(item, show) {
  if (!item || !item.url || !show || !show.title) return [];
  const hay = fold(`${item.title || ''} ${slugText(item.url)}`);
  const words = new Set(hay.trim().split(' '));
  const base = [];
  const lead = leadTitle(show.title);
  if (lead && hasPhrase(hay, lead)) base.push(`lead-title:${lead}`);
  const tw = [...new Set(sig(show.title))];
  const hit = tw.filter((w) => words.has(w) || words.has(`${w}s`));
  if (tw.length >= 2 && hit.length >= 2 && hit.length / tw.length >= 0.6) base.push(`title-words:${hit.length}/${tw.length}`);
  const extra = [];
  const venue = String(show.venue || '').replace(/\b(theatre|theater)\b/gi, '').trim();
  if (sig(venue).length >= 1 && venue.length >= 5 && hasPhrase(hay, venue)) extra.push(`venue:${venue}`);
  for (const c of Array.isArray(show.cast) ? show.cast : []) {
    const name = typeof c === 'string' ? c : c && c.name;
    if (name && sig(name).length >= 2 && hasPhrase(hay, name)) { extra.push(`cast:${name}`); break; }
  }
  if (!base.length && extra.some((s) => s.startsWith('venue:')) && extra.some((s) => s.startsWith('cast:'))) base.push('venue+cast');
  return base.length ? [...base, ...extra] : [];
}

/**
 * Gap candidates among a pass's sightings. `firstSeen` (Map url -> ms) is the caller's, kept across passes; this
 * records first sightings in it. A sighting is eligible when it is from a known outlet, vouched for (aggregator citation,
 * or a vetted own-outlet listing with a review signal), not admitted and not refused for an intended reason.
 * @returns {Array<object>} sightings at least `afterMs` old
 */
function gapCandidates(sightings, { firstSeen, now, afterMs = GAP_AFTER_MS }) {
  const out = [];
  for (const s of sightings || []) {
    if (!s || !s.url || s.admitted || !s.knownOutlet) continue;
    if (!(s.aggregatorCited || (s.vettedOutlet && s.reviewLike))) continue;
    if (s.rejectedFor && INTENDED_REJECTIONS.has(s.rejectedFor)) continue;
    if (!firstSeen.has(s.url)) firstSeen.set(s.url, now);
    const age = now - firstSeen.get(s.url);
    if (age >= afterMs) out.push({ ...s, firstSeenAt: new Date(firstSeen.get(s.url)).toISOString(), ageMin: Math.round(age / 60000) });
  }
  return out;
}

function signalsPath(ledgerDir, showId, night) {
  return path.join(ledgerDir, showId, `${night}.press-signals.jsonl`);
}

/** Append the items not already recorded for this night (kind + url); returns only those new ones. */
function recordNew(ledgerDir, { showId, night, kind, items, now = Date.now() }) {
  if (!items || !items.length) return [];
  const file = signalsPath(ledgerDir, showId, night);
  const done = new Set();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); done.add(`${r.kind}|${r.url}`); } catch { /* a torn line is skipped */ }
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const fresh = [];
  for (const it of items) {
    const k = `${kind}|${it.url}`;
    if (done.has(k)) continue;
    done.add(k);
    fresh.push(it);
  }
  if (fresh.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, fresh.map((it) => JSON.stringify({ kind, url: it.url, at: new Date(now).toISOString(), outletId: it.outletId || null, adapter: it.adapter || null, signals: it.signals || undefined })).join('\n') + '\n');
  }
  return fresh;
}

/** The one command that puts a URL in front of the running lane (BRO-7741 inbox), plus the regular-path fallback. */
function ingestCommand(showId, item) {
  const outlet = item.outletId ? ` --outlet=${item.outletId}` : '';
  return {
    primary: `node scripts/opening-night-lane-inbox.js add --show=${showId} --url='${item.url}'${outlet}`,
    fallback: `gh workflow run ingest-urls.yml -f show_id=${showId} -f urls='${item.url}${item.outletId ? ` ${item.outletId}` : ''}'`,
  };
}

/** Alert text for new near-misses and gaps (one message per pass). Null when there is nothing new. */
function formatPressSignals(show, night, { nearMisses = [], gaps = [] }) {
  if (!nearMisses.length && !gaps.length) return null;
  const lines = [];
  for (const n of nearMisses) {
    const c = ingestCommand(show.id, n);
    lines.push(`NEAR-MISS (${n.outletId || 'known outlet'}, via ${n.adapter}): ${n.url}`, `  headline: ${n.title || '(none)'}`, `  partial match: ${(n.signals || []).join(', ')}; the strict title matcher refused it`, `  add it: ${c.primary}`, `  or: ${c.fallback}`);
  }
  for (const g of gaps) {
    const c = ingestCommand(show.id, g);
    lines.push(`GAP (${g.outletId || 'known outlet'}, ${g.aggregatorCited ? 'cited by an aggregator' : `listed by ${g.adapter}`}): ${g.url}`, `  seen ${g.ageMin} min ago, still not live${g.rejectedFor ? ` (lane refused it: ${g.rejectedFor})` : ''}`, `  add it: ${c.primary}`, `  or: ${c.fallback}`);
  }
  const title = `Press night ${show.id} ${night}: ${nearMisses.length} near-miss, ${gaps.length} found-not-live`;
  return { title, description: lines.join('\n') };
}

module.exports = {
  GAP_AFTER_MS, MAX_NEAR_MISSES_PER_ADAPTER, INTENDED_REJECTIONS,
  leadTitle, nearMissSignals, gapCandidates, recordNew, signalsPath, ingestCommand, formatPressSignals,
};
