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
// At most this many NEW near-misses per adapter alert per pass (applied after the per-night dedupe, so URLs already
// alerted never use it up); the rest alert next pass. A feed that changes shape must not flood the channel.
const MAX_NEAR_MISSES_PER_ADAPTER = 5;
// A safety cap on what one adapter may hand over per pass, before any dedupe.
const MAX_NEAR_MISS_CANDIDATES_PER_ADAPTER = 40;
const idOf = (it) => it.key || it.url; // dedupe and timers use the canonical key; `url` is what the alert shows
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

const REVIEW_WORD_RE = / (?:review|reviews|reviewed) /;
/** The single significant word before a subtitle ("Dolly" in "Dolly: A True Original Musical"), 4+ letters, or null. */
function leadWord(showTitle) {
  const t = String(showTitle || '');
  const cut = t.split(/\s*[“"‘]|\s*:\s+|\s+[-–—]\s+|\s*\(/)[0].trim();
  if (!cut || cut === t.trim()) return null;
  const w = sig(cut);
  return w.length === 1 && w[0].length >= 4 && !/^\d+$/.test(w[0]) ? w[0] : null;
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
  // BRO-7778: a one-word lead ("Dolly: A True Original Musical", "Diana: The Untold and Untrue Story") counts beside a
  // review cue. Such a lead is shared with other shows (Hello, Dolly!; Diana, The Musical), so it is never admitted,
  // only reported here.
  const word = leadWord(show.title);
  const { pressAkaForTitle, registryShowTitles } = require('../show-names');
  // ...unless the headline names another show that holds the word ("Hello, Dolly! review" is not Dolly's).
  const otherShowNamed = () => registryShowTitles().some((t) => {
    const f = fold(t);
    return f !== fold(show.title) && f.trim().split(' ').length >= 2 && f.split(' ').includes(word) && hasPhrase(hay, t);
  });
  if (!lead && word && words.has(word) && REVIEW_WORD_RE.test(hay) && !otherShowNamed()) base.push(`lead-word:${word}`);
  // Press titles (shows.json akaTitles) count as the lead does.
  const akas = Array.isArray(show.akaTitles) ? show.akaTitles : pressAkaForTitle(show.title);
  const aka = akas.find((a) => typeof a === 'string' && sig(a).length >= 1 && hasPhrase(hay, a));
  if (aka) base.push(`aka:${aka}`);
  const tw = [...new Set(sig(show.title))];
  const hit = tw.filter((w) => words.has(w) || words.has(`${w}s`));
  if (tw.length >= 2 && hit.length >= 2 && hit.length / tw.length >= 0.6) base.push(`title-words:${hit.length}/${tw.length}`);
  // A one-word title ("The Fantasticks" -> fantasticks) counts when that word is distinctive (6+ letters); a run-together
  // slug (Talkin' Broadway's TheFantasticks.html) counts when it holds the whole title squashed (8+ letters).
  if (tw.length === 1 && tw[0].length >= 6 && hit.length === 1) base.push(`title-word:${tw[0]}`);
  const squashed = fold(show.title).replace(/ /g, '');
  if (!base.length && squashed.length >= 8 && hay.replace(/ /g, '').includes(squashed)) base.push('title-run-together');
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

// A review dated within this many days of the night, but outside the lane's +/-1 day window, points at a wrong
// openingDate (Blue Man Group-style data slips), not at an earlier production's review (those are months or years off).
const WINDOW_MISMATCH_MAX_DAYS = 7;
/**
 * BRO-7779 item 6: a sighting refused only for its date (outside-night-window) that is still evidence of TONIGHT's
 * show: an aggregator cites it, or the outlet's own feed / index lists it as a review dated a few days off the night.
 * INTENDED_REJECTIONS used to drop these silently, so a wrong openingDate hid every real review.
 */
function windowMismatch(s) {
  if (!s || s.rejectedFor !== 'outside-night-window') return false;
  if (s.aggregatorCited) return true;
  return !!(s.vettedOutlet && s.reviewLike && Number.isFinite(s.rejectedDayOffset) && Math.abs(s.rejectedDayOffset) <= WINDOW_MISMATCH_MAX_DAYS);
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
    // BRO-7779 item 6: an aggregator citing a review the lane dated outside tonight's window is the sign of a wrong
    // openingDate (or a wrong window), not of an old production: aggregators cite tonight's reviews for tonight's show.
    if (s.rejectedFor && INTENDED_REJECTIONS.has(s.rejectedFor) && !windowMismatch(s)) continue;
    const id = idOf(s);
    if (!firstSeen.has(id)) firstSeen.set(id, now);
    const age = now - firstSeen.get(id);
    // A window mismatch is a deliberate refusal, not a backlog: waiting 15 minutes would only delay the fix.
    if (age >= (windowMismatch(s) ? 0 : afterMs)) out.push({ ...s, firstSeenAt: new Date(firstSeen.get(id)).toISOString(), ageMin: Math.round(age / 60000) });
  }
  return out;
}

/**
 * Does an article's own text name the show (BRO-7743)? The title (whole, or its lead before a subtitle) AND the venue or
 * a cast member. Corroboration only: the alert fires either way, since a page behind a bot wall must not hide a review.
 * @returns {boolean|null} null when there is no text to judge
 */
function pageNamesShow(html, show) {
  const text = String(html || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  if (text.replace(/\s+/g, '').length < 200 || !show || !show.title) return null;
  const hay = fold(text.replace(/&#8217;|&rsquo;/g, "'"));
  const lead = leadTitle(show.title);
  const named = hasPhrase(hay, show.title) || (lead && hasPhrase(hay, lead)) || (sig(show.title).length === 1 && hasPhrase(hay, sig(show.title)[0]));
  if (!named) return false;
  const venue = String(show.venue || '').replace(/\b(theatre|theater)\b/gi, '').trim();
  if (venue.length >= 5 && hasPhrase(hay, venue)) return true;
  return (Array.isArray(show.cast) ? show.cast : []).some((c) => { const n = typeof c === 'string' ? c : c && c.name; return n && sig(n).length >= 2 && hasPhrase(hay, n); });
}

function signalsPath(ledgerDir, showId, night) {
  return path.join(ledgerDir, showId, `${night}.press-signals.jsonl`);
}

/**
 * Append the items not already recorded for this night (kind + canonical key); returns only those new ones. With
 * `perAdapter`, at most that many new items per adapter are taken; the rest stay unrecorded and come back next pass.
 */
function recordNew(ledgerDir, { showId, night, kind, items, now = Date.now(), perAdapter = Infinity }) {
  if (!items || !items.length) return [];
  const file = signalsPath(ledgerDir, showId, night);
  const done = new Set();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); done.add(`${r.kind}|${r.key || r.url}`); } catch { /* a torn line is skipped */ }
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const fresh = [];
  const taken = new Map();
  for (const it of items) {
    const k = `${kind}|${idOf(it)}`;
    if (done.has(k)) continue;
    const n = taken.get(it.adapter) || 0;
    if (n >= perAdapter) continue;
    taken.set(it.adapter, n + 1);
    done.add(k);
    fresh.push(it);
  }
  if (fresh.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, fresh.map((it) => JSON.stringify({ kind, key: idOf(it), url: it.url, at: new Date(now).toISOString(), outletId: it.outletId || null, adapter: it.adapter || null, signals: it.signals || undefined })).join('\n') + '\n');
  }
  return fresh;
}

/** The one command that puts a URL in front of the running lane (BRO-7741 inbox), plus the regular-path fallback. */
// The BRO-7741 lane inbox, when it is on this checkout; until then the regular ingest workflow is the one command.
const INBOX_SCRIPT = path.join(__dirname, '..', '..', 'opening-night-lane-inbox.js');
// BRO-7793: a Google News wrapper has no publisher URL the lane can fetch (the inbox accepts it, the runner then drops it).
const isGoogleWrapper = (url) => /^https?:\/\/news\.google\.com\//i.test(String(url || ''));
function ingestCommand(showId, item, { inbox = fs.existsSync(INBOX_SCRIPT) } = {}) {
  if (isGoogleWrapper(item.url)) return { primary: null, fallback: null, wrapper: true };
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`; // copy-paste safe even if the URL holds a quote
  const outlet = item.outletId ? ` --outlet=${item.outletId}` : '';
  // Through the queue cap (workflow-queue-cap-coverage); --priority because this is opening-night work.
  const workflow = `node scripts/capped-workflow-dispatch.js --workflow=ingest-urls.yml --priority -f show_id=${showId} -f urls=${q(`${item.url}${item.outletId ? ` ${item.outletId}` : ''}`)}`;
  if (!inbox) return { primary: workflow, fallback: null };
  return { primary: `node scripts/opening-night-lane-inbox.js add --show=${showId} --url=${q(item.url)}${outlet}`, fallback: workflow };
}

/** Alert text for new near-misses and gaps (one message per pass). Null when there is nothing new. */
function formatPressSignals(show, night, { nearMisses = [], gaps = [], sourceHealth = [] }) {
  if (!nearMisses.length && !gaps.length && !sourceHealth.length) return null;
  const lines = [];
  for (const n of nearMisses) {
    const c = ingestCommand(show.id, n);
    const page = n.pageNamesShow === true ? ' (the page names the show)' : n.pageNamesShow === false ? ' (the page did not name the show with its venue or cast)' : '';
    lines.push(`NEAR-MISS (${n.outletId || 'known outlet'}, via ${n.adapter}): ${n.url}${page}`, `  headline: ${n.title || '(none)'}`, `  partial match: ${(n.signals || []).join(', ')}; the strict title matcher refused it`, ...(c.wrapper ? ['  open the Google link, then add the outlet\'s own article URL with opening-night-lane-inbox.js add'] : [`  add it: \`${c.primary}\``]), ...(c.fallback ? [`  or: \`${c.fallback}\``] : []));
  }
  for (const g of gaps) {
    const c = ingestCommand(show.id, g);
    const why = windowMismatch(g) ? `${g.aggregatorCited ? 'an aggregator cites it' : 'the outlet lists it as a review'} but it is dated ${Number.isFinite(g.rejectedDayOffset) ? `${g.rejectedDayOffset > 0 ? '+' : ''}${g.rejectedDayOffset} day(s) from` : 'outside'} tonight: check the show's openingDate${g.rejectedDayOffset < 0 ? ' (or it is a preview-period review or another production)' : ''}` : g.rejectedFor ? `lane refused it: ${g.rejectedFor}` : 'lane has not dated it yet: backlog or a blocked page';
    lines.push(`${windowMismatch(g) ? 'WINDOW-MISMATCH' : 'GAP'} (${g.outletId || 'known outlet'}, ${g.aggregatorCited ? 'cited by an aggregator' : `listed by ${g.adapter}`}): ${g.url}`, `  seen ${g.ageMin} min ago, still not live (${why})`, ...(c.wrapper ? ['  open the Google link, then add the outlet\'s own article URL with opening-night-lane-inbox.js add'] : [`  add it: \`${c.primary}\``]), ...(c.fallback ? [`  or: \`${c.fallback}\``] : []));
  }
  for (const h of sourceHealth) {
    if (h.kind === 'fetch-failing') lines.push(`SOURCE FAILING (${h.adapter || 'lane'}${h.outletId ? `, ${h.outletId}` : ''}): ${h.url}`, `  ${h.fails} reads in a row failed (last: ${h.lastError || 'unknown'}); last good read ${h.lastOkAt || 'never tonight'}. Reviews it lists are not being seen.`);
    else lines.push(`SOURCE NOT READ (${h.adapter || 'lane'}${h.outletId ? `, ${h.outletId}` : ''}): ${h.url}`, `  not read for ${h.idleMin} min (last try ${h.lastAttemptAt || 'never tonight'}). Reviews it lists are not being seen.`);
  }
  const title = `Press night ${show.id} ${night}: ${nearMisses.length} near-miss, ${gaps.length} found-not-live${sourceHealth.length ? `, ${sourceHealth.length} source problem(s)` : ''}`;
  return { title, description: lines.join('\n') };
}

module.exports = {
  isGoogleWrapper,
  GAP_AFTER_MS, WINDOW_MISMATCH_MAX_DAYS, MAX_NEAR_MISSES_PER_ADAPTER, MAX_NEAR_MISS_CANDIDATES_PER_ADAPTER, INTENDED_REJECTIONS,
  leadTitle, nearMissSignals, windowMismatch, pageNamesShow, gapCandidates, recordNew, signalsPath, ingestCommand, formatPressSignals,
};
