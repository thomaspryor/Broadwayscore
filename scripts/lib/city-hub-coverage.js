'use strict';

/**
 * BRO-7291 class 7 (coverage gaps): turn the city-hub dual-model coverage check into work instead of a list.
 * Pure; no I/O. The CLI is scripts/audit-city-hub-dual-model.js (coverage / report --write), which writes
 * data/audit/city-hub-dual/<city>/ingest-plan.json in dispatch-ingest-batch.js's plan format
 * ({ "<showId>": [{ url, outlet }] }), plus the hosts no registry outlet owns (registry candidates).
 */

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const normUrl = (u) => String(u || '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
/** Search-engine redirect links the grounded model returns instead of the article: never ingestable as-is. */
const REDIRECT_HOSTS = /(^|\.)(vertexaisearch\.cloud\.google\.com|google\.com|bing\.com)$/;

/**
 * Review candidates the models found that the hub does not have.
 * @param {object[]} shows   hub shows ({ id, openingDate })
 * @param {Map<string, object>} cov   coverage cache: showId -> { gemini: { reviews }, openai: { reviews } }
 * @param {Map<string, {urls:Set<string>, hosts:Set<string>}>} have   per show, the review URLs and hosts we already list
 * @returns {{ showId, url, outlet, critic, date, models: string[] }[]}
 */
function coverageGaps(shows, cov, have) {
  const out = new Map();
  for (const s of shows) {
    const r = cov.get(s.id);
    if (!r) continue;
    const mine = have.get(s.id) || { urls: new Set(), hosts: new Set() };
    for (const m of ['gemini', 'openai']) {
      for (const rv of ((r[m] || {}).reviews) || []) {
        if (!rv || !/^https?:\/\//.test(rv.url || '')) continue;
        const h = host(rv.url);
        if (!h || mine.urls.has(normUrl(rv.url)) || mine.hosts.has(h)) continue;
        // a "review" dated well before the run is a preview, an announcement or another production
        if (rv.date && s.openingDate && rv.date < addDaysIso(s.openingDate, -14)) continue;
        const k = `${s.id}|${normUrl(rv.url)}`;
        const prev = out.get(k);
        if (prev) { if (!prev.models.includes(m)) prev.models.push(m); continue; }
        out.set(k, { showId: s.id, url: rv.url, outlet: rv.outlet || '', critic: rv.critic || '', date: rv.date || '', models: [m] });
      }
    }
  }
  return [...out.values()];
}

function addDaysIso(iso, n) { return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10); }

/** HTTP statuses that prove a link is gone. Bot walls (403/406/429/503) and network errors prove nothing. */
const DEAD_STATUS = new Set([404, 410]);

/**
 * Split gaps into an ingest plan (hosts a registry outlet owns) and registry candidates (hosts none does).
 * `resolve(url)` -> { outletId } | null (review-normalization.resolveOutletFromUrl).
 * `status` (optional Map url -> HTTP status) drops links that are gone: the models invent plausible article URLs
 * (real BRO-7291 run: 7 of 23 unregistered-host links were 404s), and a host is only a registry candidate
 * while at least one of its links was not proven dead.
 * Redirect links are counted, never planned. At most `perShow` URLs per show.
 */
function ingestPlan(gaps, resolve, { perShow = 6, status = null } = {}) {
  const plan = {};
  const candidates = {};
  let redirects = 0;
  let dead = 0;
  for (const g of gaps) {
    const h = host(g.url);
    if (REDIRECT_HOSTS.test(h)) { redirects++; continue; }
    if (status && DEAD_STATUS.has(status.get(g.url))) { dead++; continue; }
    const o = resolve(g.url);
    if (o && o.outletId) {
      const list = plan[g.showId] || (plan[g.showId] = []);
      if (list.length < perShow && !list.some((x) => normUrl(x.url) === normUrl(g.url))) list.push({ url: g.url, outlet: o.outletId });
    } else {
      (candidates[h] || (candidates[h] = { outlet: g.outlet, urls: [] })).urls.push({ showId: g.showId, url: g.url });
    }
  }
  return { plan, registryCandidates: candidates, redirects, dead };
}

/**
 * The "look especially at" hint for a hub's coverage prompt: the outlets that already review this hub most,
 * by registry display name. Replaces a hand-kept per-city list that only two hubs had.
 * @param {{ outlet?: string, outletId?: string }[]} reviews   the hub's published reviews.json rows
 */
function outletHint(reviews, n = 10) {
  const counts = new Map();
  for (const r of reviews) {
    const name = r.outlet || r.outletId;
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k]) => k).join(', ');
}

module.exports = { coverageGaps, ingestPlan, outletHint, REDIRECT_HOSTS, DEAD_STATUS, host, normUrl };
