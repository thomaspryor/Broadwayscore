/**
 * traffic-report-human.js — the owner-facing summary of the weekly traffic
 * report, written for a person, not a dashboard.
 *
 * Owner, 2026-09-20, on the first machine-shaped version: "It is not made for
 * humans at all. Make it easy to read, easy to grok, using human language,
 * human friendly terms not long-ass URL stubs." So:
 *   - pages are named ("Electra / Persona (West End) page", "the homepage"),
 *     never "/show/electra-persona-west-end"; show titles come from
 *     data/shows.json when present, else from the slug;
 *   - sources are named ("Reddit", "Google", "ChatGPT"), and variants of one
 *     site are merged (www.reddit.com + the Reddit app = Reddit);
 *   - one event appears once; GA4 duplicates of PostHog facts are dropped;
 *   - bots, search engines and our own tooling never appear as "new sites";
 *   - sections answer the owner's questions: what's working, what's fading,
 *     new sites sending visitors, Reddit and social, keep an eye on.
 *
 * Pure: takes the fetched rows + week list and returns markdown. The numbers
 * come from the same helpers the detailed report uses (analyze-traffic-sources.js).
 */
const fs = require('fs');
const path = require('path');

function helpers() { return require('../analyze-traffic-sources'); } // lazy: that file requires nothing from here

// ---------- naming ----------

const SEARCH_ENGINE = /google|bing\.com|yahoo|duckduckgo|ecosia|brave\.com|kagi|yandex|baidu|startpage|qwant|lilo\.org|oceanhero|presearch|metacrawler|lycos|zapmeta|hotbot|search66|webcrawler|dogpile|excite\.|ask\.com|aol\.com|^(www\.)?search\.|^search\./i;
const OWN_TOOLING = /broadwayscorecard\.com|resend\.com|vercel\.(app|com)|localhost|posthog\.com/i;
const SOURCE_NAMES = [
  [/(^|\.)reddit\.|^com\.reddit\./i, 'Reddit'],
  [/facebook|fb\.com|fbcdn/i, 'Facebook'],
  [/instagram/i, 'Instagram'],
  [/^t\.co$|^x\.com$|twitter/i, 'X (Twitter)'],
  [/threads\.(net|com)/i, 'Threads'],
  [/tiktok/i, 'TikTok'],
  [/bsky|bluesky/i, 'Bluesky'],
  [/linkedin/i, 'LinkedIn'],
  [/pinterest/i, 'Pinterest'],
  [/youtube|youtu\.be/i, 'YouTube'],
  [/chatgpt|openai/i, 'ChatGPT'],
  [/(^|\.)copilot\./i, 'Microsoft Copilot'],
  [/claude\.ai/i, 'Claude'],
  [/perplexity/i, 'Perplexity'],
  [/gemini\.google/i, 'Gemini'],
  [/broadwayworld/i, 'BroadwayWorld forum'],
  [/^\$direct$/, 'Direct'],
  [/google/i, 'Google'],
  [/bing\.com/i, 'Bing'],
  [/duckduckgo/i, 'DuckDuckGo'],
  [/yahoo/i, 'Yahoo'],
  [/ecosia/i, 'Ecosia'],
  [/brave\.com/i, 'Brave'],
  [/kagi/i, 'Kagi'],
];
const SOCIAL = new Set(['Reddit', 'Facebook', 'Instagram', 'X (Twitter)', 'Threads', 'TikTok', 'Bluesky', 'LinkedIn', 'Pinterest', 'YouTube', 'BroadwayWorld forum']);
const AI = new Set(['ChatGPT', 'Microsoft Copilot', 'Claude', 'Perplexity', 'Gemini']);

function sourceName(domain) {
  const d = String(domain || '');
  for (const [re, name] of SOURCE_NAMES) if (re.test(d)) return name;
  return d.replace(/^www\./, '') || '(unknown)';
}
function isSearch(domain) { return SEARCH_ENGINE.test(String(domain)); }
function isOwnTooling(domain) { return OWN_TOOLING.test(String(domain)); }
function isDirect(domain) { return /^\$direct$/.test(String(domain)) || String(domain) === '(none)'; }

const MARKET_LABEL = { broadway: 'Broadway', 'west-end': 'West End', 'off-broadway': 'Off-Broadway', 'off-west-end': 'Off West End', opera: 'Opera', regional: 'Regional', touring: 'Touring' };
const SMALL_WORDS = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'to', 'in', 'on', 'at', 'for', 'vs', 'with']);

function titleCase(slug) {
  return slug.split('-').filter(Boolean).map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

/** Load {slug -> show} from data/shows.json if present; empty map otherwise. */
function loadShows(showsPath) {
  const p = showsPath || path.join(__dirname, '..', '..', 'data', 'shows.json');
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = Array.isArray(raw) ? raw : raw.shows || [];
    const map = new Map();
    for (const s of arr) if (s && s.slug) map.set(s.slug, s);
    return map;
  } catch { return new Map(); }
}

/** Human name for a site path. */
function pageName(pth, shows = new Map()) {
  const p = String(pth || '').replace(/\/+$/, '') || '/';
  if (p === '/') return 'the homepage';
  const fixed = {
    '/west-end': 'the West End page', '/off-broadway': 'the Off-Broadway page', '/off-west-end': 'the Off West End page',
    '/broadway': 'the Broadway page', '/opera': 'the Opera page', '/lotteries': 'the Lotteries page',
    '/discount-tickets': 'the Discount Tickets page', '/box-office': 'the Box Office page', '/beat-the-critics': 'Beat the Critics',
    '/best-value': 'the Best Value page', '/cast': 'the Cast index', '/shows': 'the Shows index',
  };
  if (fixed[p]) return fixed[p];
  const m = p.match(/^\/show\/([^/]+)$/);
  if (m) {
    const slug = m[1];
    const show = shows.get(slug);
    if (show && show.title) {
      const market = MARKET_LABEL[show.category] || MARKET_LABEL[show.market] || null;
      return `${show.title}${market ? ` (${market})` : ''} page`;
    }
    let base = slug.replace(/-(20\d{2})$/, '');
    let market = null;
    for (const [suffix, label] of [['-off-west-end', 'Off West End'], ['-west-end', 'West End'], ['-off-broadway', 'Off-Broadway'], ['-broadway', 'Broadway']]) {
      if (base.endsWith(suffix)) { base = base.slice(0, -suffix.length); market = label; break; }
    }
    return `${titleCase(base)}${market ? ` (${market})` : ''} page`;
  }
  const g = p.match(/^\/(guides|browse|best|lists)\/([^/]+)$/);
  if (g) return `the "${titleCase(g[2])}" ${g[1] === 'guides' ? 'guide' : 'list'}`;
  const c = p.match(/^\/compare\/(.+)-vs-(.+)$/);
  if (c) return `the ${titleCase(c[1])} vs ${titleCase(c[2])} comparison`;
  const cast = p.match(/^\/(cast|creative|critics|actor)\/([^/]+)$/);
  if (cast) return `${titleCase(cast[2])}'s ${cast[1] === 'critics' ? 'critic' : cast[1] === 'creative' ? 'creative team' : 'cast'} page`;
  const th = p.match(/^\/(?:off-broadway\/)?theater\/([^/]+)$/);
  if (th) return `the ${titleCase(th[1])} page`;
  const r = p.match(/^\/reviews\/([^/]+)$/);
  if (r) return `the ${titleCase(r[1])} reviews page`;
  return `the ${p} page`;
}

// ---------- number helpers ----------

const fmtN = (n) => Math.round(n).toLocaleString('en-US');
function pctChange(now, before) {
  if (before <= 0) return null;
  return Math.round(((now - before) / before) * 100);
}
function fmtPct(p) { return p === null ? 'new' : `${p > 0 ? '+' : ''}${p}%`; }
/** "up from 18 (+300%)" reads fine; "up from 1 (+4600%)" does not. */
function fromBefore(before, pct) {
  if (before < 5) return 'up from almost nothing';
  return `up from ${fmtN(before)} (${fmtPct(pct)})`;
}
function fmtDate(iso) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function sumWeeks(bw, ws) { return ws.reduce((t, w) => t + (bw[w] || 0), 0); }

/** Re-key a series by a naming function, merging keys that map to the same name. */
function mergeSeries(series, nameOf) {
  const out = {};
  for (const [k, bw] of Object.entries(series)) {
    const name = nameOf(k);
    out[name] = out[name] || {};
    for (const [w, v] of Object.entries(bw)) out[name][w] = (out[name][w] || 0) + v;
  }
  return out;
}

// ---------- the summary ----------

/**
 * @param {object} ctx { ph, ga, weeks, currentWeek, problems?, showsPath? }
 * @returns {string} markdown
 */
function buildHumanSummary({ ph, ga, weeks, currentWeek, problems = [], showsPath }) {
  // showsPath: explicit data/shows.json (CI checks core data out to /tmp/core-data-checkout; locally the repo has it)
  const H = helpers();
  const notes = [];
  const shows = loadShows(showsPath);
  if (showsPath && !shows.size) notes.push('Show titles could not be loaded this week, so pages are named from their web addresses.');
  const full = weeks.filter((w) => w !== currentWeek);
  const last = full[full.length - 1];
  const recent4 = full.slice(-4);
  const prior4 = full.slice(-8, -4);
  const monthAvgWeeks = full.slice(-5, -1); // the 4 weeks before the last full week
  const phOk = ph && !ph.skipped;
  const gaOk = ga && !ga.skipped;
  const enoughWeeks = full.length >= 8;
  // Referrer attribution only when the referrer × page query actually returned
  // rows; otherwise say nothing about where a page's visitors came from.
  const refAvailable = phOk && Array.isArray(ph.referralLanding) && ph.referralLanding.length > 0 && !(ph.errors && ph.errors.referralLanding);
  const S = (rows) => H.bucketWeekly((rows || []).map((r) => ({ date: r.date, key: r.key, value: r.sessions })));
  const U = (rows) => H.bucketWeekly((rows || []).map((r) => ({ date: r.date, key: r.key, value: r.users || 0 })));

  const channel = phOk ? S(ph.channelType) : {};
  // Search engines, direct and our own tooling are dropped BEFORE naming, so a
  // merged name like "Bing" can never slip past a domain-shaped filter later.
  const referrerRaw = phOk ? S(ph.referringDomain) : {};
  const referrer = mergeSeries(Object.fromEntries(Object.entries(referrerRaw).filter(([d]) => !isSearch(d) && !isOwnTooling(d) && !isDirect(d))), sourceName);
  const landing = phOk ? S(ph.landing) : {};
  const country = phOk ? S(ph.country) : {};
  const countryUsers = phOk ? U(ph.country) : {};
  const utm = phOk ? S(ph.utmSource) : {};
  const refIdx = H.indexReferralLanding(phOk ? ph.referralLanding : []);
  // invert: week -> path -> {sourceName: count}
  const pathSources = {};
  for (const [w, doms] of Object.entries(refIdx.byWeek)) {
    for (const [d, pages] of Object.entries(doms)) {
      if (isSearch(d) || isOwnTooling(d)) continue;
      const name = sourceName(d);
      for (const [pth, c] of Object.entries(pages)) {
        ((pathSources[w] = pathSources[w] || {})[pth] = pathSources[w][pth] || {})[name] = (pathSources[w][pth][name] || 0) + c;
      }
    }
  }
  const sourcesForPath = (pth, ws) => {
    const agg = {};
    for (const w of ws) for (const [n, c] of Object.entries((pathSources[w] || {})[pth] || {})) agg[n] = (agg[n] || 0) + c;
    return Object.entries(agg).sort((a, b) => b[1] - a[1]);
  };
  const pagesForSource = (name, ws) => {
    const agg = {};
    for (const w of ws) for (const [d, pages] of Object.entries(refIdx.byWeek[w] || {})) {
      if (sourceName(d) !== name) continue;
      for (const [pth, c] of Object.entries(pages)) agg[pth] = (agg[pth] || 0) + c;
    }
    return Object.entries(agg).sort((a, b) => b[1] - a[1]);
  };
  const showOf = (pth) => { const m = String(pth).match(/^\/show\/([^/]+)$/); return m ? shows.get(m[1]) : null; };
  const listPages = (pairs, n = 2) => pairs.slice(0, n).map(([p, c]) => `${pageName(p, shows)} (${fmtN(c)})`).join(', ');

  const md = [];
  md.push(`# Your traffic, week of ${fmtDate(last)}`);
  md.push('');

  if (problems.length) {
    md.push(`> Part of the data did not load this week, so some sections may be thin: ${problems.map((p) => p.replace(/PostHog API \d{3}:[\s\S]*/, 'PostHog was unreachable')).join('; ')}.`);
    md.push('');
  }

  // ---- In short ----
  const total = (ws) => Object.values(channel).reduce((t, bw) => t + sumWeeks(bw, ws), 0);
  const lastTotal = total([last]);
  const avgTotal = monthAvgWeeks.length ? total(monthAvgWeeks) / monthAvgWeeks.length : 0;
  const search = channel['Organic Search'] || {};
  const searchLast = search[last] || 0;
  const searchAvg = monthAvgWeeks.length ? sumWeeks(search, monthAvgWeeks) / monthAvgWeeks.length : 0;
  const inShort = [];
  if (phOk && lastTotal) {
    const p = pctChange(lastTotal, avgTotal);
    const vs = (pc) => (pc === null ? '' : Math.abs(pc) < 3 ? 'about the same as' : pc > 0 ? `${pc}% more than` : `${Math.abs(pc)}% fewer than`);
    inShort.push(`Last week the site had ${fmtN(lastTotal)} visits (known bots excluded)${p === null ? '' : `, ${vs(p)} a typical week in the previous month`}.`);
    if (searchLast) {
      const sp = pctChange(searchLast, searchAvg);
      const move = sp === null ? '' : Math.abs(sp) < 3 ? ', about the same as usual' : `, ${sp > 0 ? 'up' : 'down'} ${Math.abs(sp)}%`;
      const share = Math.round((searchLast / lastTotal) * 100);
      inShort.push(`Search brought ${fmtN(searchLast)} of them (${share}%)${move}.${share >= 50 ? ' Search is where most of your traffic comes from, so that number is the one to watch.' : ''}`);
    }
  } else if (!phOk) {
    inShort.push('PostHog (the trustworthy visitor count) did not load this week, so the summary is limited.');
  }

  // trends
  const T = (series, opts) => H.trendsFor(series, weeks, currentWeek, opts);
  const tLanding = T(landing, { minWeekly: 20 });
  const tRef = T(referrer, { minWeekly: 10 });
  const tChannel = T(channel, { minWeekly: 20 });
  const tUtm = T(utm, { minWeekly: 10 });

  // ---- What's working ----
  const working = [];
  for (const x of tLanding.rising.slice(0, 5)) {
    const show = showOf(x.key);
    const srcs = sourcesForPath(x.key, recent4);
    const named = srcs.reduce((t, [, c]) => t + c, 0);
    const total4 = sumWeeks(landing[x.key] || {}, recent4);
    let why = '';
    if (!refAvailable) why = '';
    else if (srcs.length && named >= total4 * 0.5) why = ` Mostly from ${srcs.slice(0, 2).map(([n, c]) => `${n} (${fmtN(c)})`).join(' and ')}.`;
    else if (srcs.length) why = ` Mostly search and direct, plus ${srcs.slice(0, 2).map(([n, c]) => `${fmtN(c)} from ${n}`).join(' and ')}.`;
    else why = ' Mostly search and direct.';
    let ctx = '';
    if (show && show.openingDate && recent4.some((w) => Math.abs(new Date(show.openingDate) - new Date(w)) < 35 * 86400000)) {
      const future = new Date(show.openingDate) > new Date(last + 'T00:00:00Z');
      ctx = future ? ` The show opens ${fmtDate(show.openingDate)}, so this is pre-opening interest.` : ` The show opened ${fmtDate(show.openingDate)}, so this is opening interest.`;
    }
    working.push(`**${pageName(x.key, shows)}**: about ${fmtN(x.recentPerWeek)} visits a week, ${fromBefore(x.priorPerWeek, x.pct)}.${why}${ctx}`);
  }
  for (const x of tRef.rising.filter((r) => !isSearch(r.key) && r.key !== 'Direct').slice(0, 3)) {
    const pages = pagesForSource(x.key, recent4);
    working.push(`**${x.key}** is sending more: ${fmtN(x.recentPerWeek)} visits a week, ${fromBefore(x.priorPerWeek, x.pct)}${pages.length ? `, mostly to ${listPages(pages)}` : ''}.`);
  }
  for (const x of tChannel.rising.filter((c) => c.key !== 'Organic Search').slice(0, 2)) {
    working.push(`**${channelName(x.key)}** as a whole is up on a four-week view: a typical week is now ${fmtN(x.recentPerWeek)} visits, it was ${fmtN(x.priorPerWeek)} the month before.`);
  }
  for (const x of tUtm.rising.slice(0, 2)) {
    working.push(`**${utmName(x.key)}** links are bringing ${fmtN(x.recentPerWeek)} visits a week, ${fromBefore(x.priorPerWeek, x.pct)}.`);
  }

  // ---- Biggest single weeks (PostHog landing spikes, one per page) ----
  // One-off weeks, not trends: bigger bar than the rising list, and pages
  // already reported as rising are skipped so one story is told once.
  const spikes = H.detectSpikes(landing, weeks, { currentWeek, minAbs: 60, ratio: 4 });
  const seenPage = new Set(tLanding.rising.map((x) => x.key));
  const bigWeeks = [];
  for (const s of spikes) {
    if (seenPage.has(s.key)) continue;
    seenPage.add(s.key);
    const srcs = sourcesForPath(s.key, [s.week]);
    const from = refAvailable && srcs.length && srcs[0][1] >= s.value * 0.25 ? ` ${fmtN(srcs[0][1])} of them came from ${srcs[0][0]}.` : '';
    bigWeeks.push(`Week of ${fmtDate(s.week)}: **${pageName(s.key, shows)}** got ${fmtN(s.value)} visits (usually ${fmtN(s.priorMedian)}).${from}`);
    if (bigWeeks.length >= 4) break;
  }

  // ---- What's fading + keep an eye on ----
  const fading = [];
  const watch = [];
  // GA4 sees every arrival on a page (including direct); PostHog's landing series
  // above is external arrivals through the Real Users lens. If PostHog collapses
  // while GA4 is flat, it was direct/bot traffic to that page that stopped, not
  // the page (the Wicked case, 2026-09-21).
  const gaLanding = gaOk ? H.bucketWeekly((ga.landing || []).map((r) => ({ date: r.date, key: r.key, value: r.sessions }))) : null;
  const gaTrendFor = (pth) => (gaLanding && gaLanding[pth]) ? H.trendsFor({ [pth]: gaLanding[pth] }, weeks, currentWeek, { minWeekly: 1, pct: 40 }) : null;
  for (const x of tLanding.falling.slice(0, 6)) {
    const show = showOf(x.key);
    const collapsed = x.priorPerWeek >= 40 && x.pct <= -80;
    const live = show && /^(open|opened|previews|running)$/i.test(String(show.status || ''));
    const closed = show && /^(closed|closing)$/i.test(String(show.status || ''));
    const gaT = collapsed ? gaTrendFor(x.key) : null;
    const gaFlat = gaT && !gaT.falling.length; // GA4 has the page but it did not fall 40%+
    if (collapsed && closed) {
      fading.push(`**${pageName(x.key, shows)}**: ${fmtN(x.recentPerWeek)} visits a week, down from ${fmtN(x.priorPerWeek)}. The show has closed, so that is expected.`);
    } else if (collapsed && gaFlat) {
      watch.push(`Direct visits to **${pageName(x.key, shows)}** stopped (about ${fmtN(x.priorPerWeek)} a week to ${fmtN(x.recentPerWeek)}). Google visits to it are unchanged, so this is a bot or a removed link somewhere, not a broken page.`);
    } else if (collapsed) {
      watch.push(`**${pageName(x.key, shows)}** went from ${fmtN(x.priorPerWeek)} visits a week to ${fmtN(x.recentPerWeek)}${live ? ' while the show is still running' : ''}. ${gaT ? 'Google visits to it fell too, so check the page still loads and is still in Google.' : 'Could be a bot or a removed link; check the page still loads.'}`);
    } else {
      fading.push(`**${pageName(x.key, shows)}**: ${fmtN(x.recentPerWeek)} visits a week, down from ${fmtN(x.priorPerWeek)} (${x.pct}%).`);
    }
  }
  // Social sources get their own section below; do not say it twice.
  for (const x of tRef.falling.filter((r) => !isSearch(r.key) && r.key !== 'Direct' && !SOCIAL.has(r.key)).slice(0, 3)) {
    fading.push(`**${x.key}** is sending less: ${fmtN(x.recentPerWeek)} visits a week, down from ${fmtN(x.priorPerWeek)} (${x.pct}%).`);
  }
  for (const x of tChannel.falling.filter((c) => c.key !== 'Organic Social').slice(0, 3)) {
    fading.push(`**${channelName(x.key)}** as a whole is down on a four-week view: a typical week is now ${fmtN(x.recentPerWeek)} visits, it was ${fmtN(x.priorPerWeek)} the month before.`);
  }

  // ---- New sites sending you visitors ----
  const fresh = H.newSources(referrer, weeks, currentWeek, { minTotal: 5 })
    .filter((x) => !isSearch(x.key) && !isOwnTooling(x.key) && !isDirect(x.key) && x.key !== 'Direct' && !SOCIAL.has(x.key) && !AI.has(x.key));
  const freshLines = fresh.slice(0, 8).map((x) => {
    const pages = pagesForSource(x.key, x.lateWeeks);
    const all = pages.reduce((t, [, c]) => t + c, 0);
    const where = pages.length === 1 || (pages.length && pages[0][1] >= all * 0.8) ? `all to ${pageName(pages[0][0], shows)}` : pages.length ? `to ${listPages(pages)}` : '';
    return `**${x.key}**: ${fmtN(x.late)} visits since ${fmtDate(x.firstWeek)}${where ? `, ${where}` : ''}${x.current ? ` (+${x.current} this week)` : ''}.`;
  });

  // ---- Reddit and social ----
  const social = [];
  for (const name of ['Reddit', 'Facebook', 'Instagram', 'X (Twitter)', 'Threads', 'TikTok', 'Bluesky', 'BroadwayWorld forum']) {
    const bw = referrer[name];
    if (!bw) continue;
    const r4 = sumWeeks(bw, recent4);
    const typicalNow = H.median(recent4.map((w) => bw[w] || 0));
    const typicalBefore = H.median(prior4.map((w) => bw[w] || 0));
    if (r4 < 5 && typicalBefore < 5) continue;
    const pages = pagesForSource(name, recent4);
    let line = `**${name}**: ${fmtN(r4)} visits in the last 4 weeks (a typical week is ${fmtN(typicalNow)}${prior4.length ? `, it was ${fmtN(typicalBefore)} a month earlier` : ''})${pages.length ? `, mostly to ${listPages(pages)}` : ''}.`;
    // best week in the window and where it went
    let best = null;
    for (const w of full) if (!best || (bw[w] || 0) > best.v) best = { w, v: bw[w] || 0 };
    if (best && best.v >= Math.max(30, typicalNow * 3)) {
      const bp = pagesForSource(name, [best.w]);
      line += ` Your best ${name} week was ${fmtDate(best.w)}: ${fmtN(best.v)} visits`;
      if (bp.length) {
        const pth = bp[0][0];
        const show = showOf(pth);
        const opened = show && show.openingDate && Math.abs(new Date(show.openingDate) - new Date(best.w + 'T00:00:00Z')) < 11 * 86400000;
        line += `, ${fmtN(bp[0][1])} of them to ${pageName(pth, shows)}${opened ? ` (the show opened ${fmtDate(show.openingDate)})` : ''}`;
        const after = full.slice(full.indexOf(best.w) + 1, full.indexOf(best.w) + 4).map((w) => (landing[pth] || {})[w] || 0);
        if (after.length === 3) line += `. The page then got ${after.map(fmtN).join(', ')} visits in the following weeks`;
      }
      const monthsOfNormal = typicalNow > 0 ? Math.round(best.v / typicalNow / 4) : 0;
      line += `.${monthsOfNormal >= 1 ? ` One good week brought about ${monthsOfNormal === 1 ? 'a month' : monthsOfNormal + ' months'} of normal ${name} traffic, and it faded within a month.` : ''}`;
    }
    social.push(line);
  }

  // ---- Keep an eye on: bots, GA4 artefacts, email ----
  for (const [c, bw] of Object.entries(country)) {
    const s4 = sumWeeks(bw, recent4);
    const u4 = sumWeeks(countryUsers[c] || {}, recent4);
    // Per-day unique visitors ≈ visits is only suggestive (daily returners look
    // the same), so this needs volume and a near-perfect ratio, and says "might".
    if (s4 >= 500 && u4 / s4 >= 0.985 && c !== 'United States' && c !== 'United Kingdom') {
      watch.push(`Traffic from **${c}** might be automated: ${fmtN(s4)} visits in 4 weeks, and on every single day each visit was a new visitor. Hong Kong looked exactly like this before it was confirmed as bots. Not filtered yet; say the word.`);
    }
  }
  if (gaOk) {
    const gaCh = H.bucketWeekly((ga.channel || []).map((r) => ({ date: r.date, key: r.key, value: r.sessions })));
    const gaEng = H.bucketWeekly((ga.channel || []).map((r) => ({ date: r.date, key: r.key, value: r.engagedSessions })));
    for (const key of ['Unassigned', 'Cross-network', '(not set)']) {
      for (const w of [last, currentWeek]) {
        const s = (gaCh[key] || {})[w] || 0;
        const e = (gaEng[key] || {})[w] || 0;
        if (s >= 100 && e / s < 0.05) {
          watch.push(`Google Analytics logged ${fmtN(s)} extra visits in the week of ${fmtDate(w)} that never clicked anything: bots or a tracking glitch, not readers, and not counted above.`);
          break;
        }
      }
    }
  }
  const email = channel['Email'];
  if (email && full.length >= 5) {
    const priorWeeks = full.slice(0, -1).map((w) => email[w] || 0);
    const lowest = Math.min(...priorWeeks);
    const lastE = email[last] || 0;
    if (lastE < lowest && lowest >= 10) watch.push(`Email brought only ${fmtN(lastE)} visits last week, below every other week in this report (the low was ${fmtN(lowest)}). Did a send go out?`);
  }

  // ---- assemble ----
  md.push(`**In short.** ${inShort.join(' ')}`);
  md.push('');
  const thin = !enoughWeeks ? `- Needs 8 full weeks of data to compare month over month; this run has ${full.length}.` : null;
  md.push(`## What's working`);
  md.push('');
  md.push(working.length ? working.map((l) => `- ${l}`).join('\n') : thin || '- Nothing grew by more than 40% this month. Steady is fine.');
  md.push('');
  if (bigWeeks.length) {
    md.push(`**Biggest single weeks in the last 3 months**`);
    md.push('');
    md.push(bigWeeks.map((l) => `- ${l}`).join('\n'));
    md.push('');
  }
  md.push(`## What's fading`);
  md.push('');
  md.push(fading.length ? fading.map((l) => `- ${l}`).join('\n') : thin || '- Nothing fell by more than 40% this month.');
  md.push('');
  md.push(`## New sites sending you visitors`);
  md.push('');
  md.push(freshLines.length ? freshLines.map((l) => `- ${l}`).join('\n') : !phOk ? '- Referrer data did not load this week.' : '- None this month. (Search engines, social networks and your own tools are not counted here.)');
  md.push('');
  md.push(`## Reddit and social`);
  md.push('');
  md.push(social.length ? social.map((l) => `- ${l}`).join('\n') : '- No meaningful social traffic in the last month.');
  md.push('');
  md.push(`## Keep an eye on`);
  md.push('');
  md.push(watch.length ? watch.map((l) => `- ${l}`).join('\n') : problems.length || !enoughWeeks ? '- Nothing looks broken in the data that loaded, but this week\'s data is incomplete (see the note at the top).' : '- Nothing looks broken.');
  if (notes.length) { md.push(''); md.push(notes.map((l) => `_${l}_`).join('\n')); }
  md.push('');

  // channels table with plain names
  if (phOk && Object.keys(channel).length) {
    md.push(`## Where visitors came from, last week vs a typical week the month before`);
    md.push('');
    const rows = Object.entries(channel)
      .map(([k, bw]) => ({ name: channelName(k), last: bw[last] || 0, avg: monthAvgWeeks.length ? sumWeeks(bw, monthAvgWeeks) / monthAvgWeeks.length : 0 }))
      .filter((r) => r.last || r.avg)
      .sort((a, b) => b.last - a.last);
    md.push('| Source | Last week | Typical week before | Change |');
    md.push('| --- | --- | --- | --- |');
    for (const r of rows) md.push(`| ${r.name} | ${fmtN(r.last)} | ${fmtN(r.avg)} | ${fmtPct(pctChange(r.last, r.avg))} |`);
    md.push('');
  }
  md.push(`_The full week-by-week tables are attached as a file. Numbers are visits as counted by PostHog, with known bot countries and your own visits excluded._`);
  md.push('');
  return md.join('\n');
}

function channelName(k) {
  return {
    'Organic Search': 'Search (Google, Bing, etc.)', Direct: 'Direct (typed in, bookmarks, untagged links)', Referral: 'Links from other sites',
    AI: 'AI assistants (ChatGPT, etc.)', 'Organic Social': 'Social (Reddit, Facebook, etc.)', Email: 'Email', 'Organic Video': 'Video (YouTube, etc.)',
    'Paid Search': 'Paid search', 'Paid Social': 'Paid social', 'Cross Network': 'Cross-network ads', '(none)': 'Untagged', '(unknown)': 'Unknown',
  }[k] || k;
}
function utmName(k) {
  const [src, medium] = String(k).split(' / ').map((s) => s.trim());
  if (/newsletter|weekly/.test(src)) return 'Newsletter';
  if (/opening/.test(src)) return 'Opening-night email';
  if (/fantasy/.test(src)) return 'Fantasy email';
  if (/beat-the-critics|btc/.test(src)) return 'Beat the Critics email';
  return sourceName(src) + (medium ? ` (${medium})` : '');
}

module.exports = { buildHumanSummary, pageName, sourceName, isSearch, isOwnTooling, mergeSeries, channelName, utmName, loadShows };
