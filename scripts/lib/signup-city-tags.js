'use strict';
// BRO-6929: work out which city an email signup came from, including signups
// made before the form started sending a `city` field (BRO-6912).
//
// Past Formspree submissions already carry `page` (the pathname the signup box
// was on) and, for follows, `showId`. A signup counts as a city signup when:
//   1. it has a `city` field that is a known hub city, else
//   2. its page is /tours/<hub city>, else
//   3. its page is /show/<slug> and that show's city is a hub city, else
//   4. its showId belongs to a show in a hub city.
// UK cities are not hub cities, so they stay untagged (they route to the
// West End list on purpose).
//
// Pure functions, no network: the caller supplies the submissions and show
// list. Nothing here prints or returns a full email address in a log line.

const RESEND_CITY_PROPERTY = 'city';
const SKIP_ACTIONS = new Set(['unsubscribe', 'unfollow', 'health-check']);

/** Set of hub city keys (launched and staged) from data/city-hubs.json. */
function loadHubKeys() {
  const reg = require('../../data/city-hubs.json');
  return new Set(Object.keys(reg.hubs || {}));
}

/**
 * Lookup context built from shows.json rows. Only shows whose city is a hub
 * city are kept, so every hit is already a taggable city.
 */
function buildCityContext(shows, hubKeys) {
  const bySlug = new Map();
  const byId = new Map();
  for (const s of shows || []) {
    if (!s || typeof s.city !== 'string' || !hubKeys.has(s.city)) continue;
    if (s.slug) bySlug.set(String(s.slug), s.city);
    if (s.id) byId.set(String(s.id), s.city);
  }
  return { hubKeys, bySlug, byId };
}

function pathSegment(page, prefix) {
  const m = new RegExp('^/' + prefix + '/([^/?#]+)').exec(typeof page === 'string' ? page : '');
  return m ? m[1] : null;
}

/** The hub city a single submission came from, or null. */
function cityFromSubmission(sub, ctx) {
  if (!sub || typeof sub !== 'object') return null;
  const hubs = ctx.hubKeys;

  const tagged = typeof sub.city === 'string' ? sub.city.trim() : '';
  if (tagged && hubs.has(tagged)) return tagged;

  const hubFromPath = pathSegment(sub.page, 'tours');
  if (hubFromPath && hubs.has(hubFromPath)) return hubFromPath;

  const slug = pathSegment(sub.page, 'show');
  if (slug && ctx.bySlug.has(slug)) return ctx.bySlug.get(slug);

  if (sub.showId && ctx.byId.has(String(sub.showId))) return ctx.byId.get(String(sub.showId));
  return null;
}

/**
 * Per-email city tags from submissions given NEWEST FIRST (Formspree order).
 * Returns a Map email -> { cities: string[] (sorted, every city seen),
 * latest: string (city of the most recent tagged signup) }.
 * `isExcluded(email)` drops test addresses; unsubscribes and health checks are
 * ignored (list membership is decided elsewhere).
 */
function buildCityTags(submissionsNewestFirst, ctx, isExcluded) {
  const seen = new Map();
  const oldestFirst = [...(submissionsNewestFirst || [])].reverse();
  for (const sub of oldestFirst) {
    if (!sub) continue;
    const email = String(sub.email || sub._replyto || '').toLowerCase().trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    if (isExcluded && isExcluded(email)) continue;
    if (SKIP_ACTIONS.has(String(sub.action || '').toLowerCase())) continue;
    const city = cityFromSubmission(sub, ctx);
    if (!city) continue;
    const prev = seen.get(email) || { set: new Set(), latest: null };
    prev.set.add(city);
    prev.latest = city;
    seen.set(email, prev);
  }
  const out = new Map();
  for (const [email, v] of seen) out.set(email, { cities: [...v.set].sort(), latest: v.latest });
  return out;
}

/** Counts per city (never emails), for logs and reports. */
function summarizeCityTags(tags) {
  const byCity = {};
  for (const v of tags.values()) {
    for (const c of v.cities) byCity[c] = (byCity[c] || 0) + 1;
  }
  return { people: tags.size, byCity };
}

/**
 * Make sure the Resend contact property exists, then set it on each tagged
 * contact whose stored value changed. Contacts that are not in Resend (404) are
 * skipped. Never throws: a failure is counted and logged, and the sync goes on.
 *
 * @param {object} o
 * @param {Map} o.tags            from buildCityTags, already limited to the audience
 * @param {object} o.pushed       email -> city already written (mutated)
 * @param {(method,url,body)=>Promise<object>} o.http  rejects with err.status on non-2xx
 * @param {(ms)=>Promise} o.delay
 * @param {(msg)=>void} o.log
 */
async function pushCitiesToResend({ tags, pushed, http, delay, log }) {
  const stats = { set: 0, unchanged: 0, notInResend: 0, errors: 0, propertyCreated: false };
  try {
    const list = await http('GET', 'https://api.resend.com/contact-properties');
    const have = (list.data || []).some((p) => p.key === RESEND_CITY_PROPERTY);
    if (!have) {
      await http('POST', 'https://api.resend.com/contact-properties', { key: RESEND_CITY_PROPERTY, type: 'string' });
      stats.propertyCreated = true;
    }
  } catch (err) {
    stats.errors++;
    log(`  Could not ensure Resend "${RESEND_CITY_PROPERTY}" property: ${err.message}`);
    return stats;
  }

  for (const [email, v] of tags) {
    if (pushed[email] === v.latest) { stats.unchanged++; continue; }
    try {
      await http('PATCH', `https://api.resend.com/contacts/${encodeURIComponent(email)}`,
        { properties: { [RESEND_CITY_PROPERTY]: v.latest } });
      pushed[email] = v.latest;
      stats.set++;
    } catch (err) {
      if (err.status === 404) stats.notInResend++;
      else {
        stats.errors++;
        if (stats.errors <= 3) log(`  Resend city update failed: ${err.message}`);
      }
    }
    await delay(300);
  }
  return stats;
}

module.exports = {
  RESEND_CITY_PROPERTY,
  loadHubKeys,
  buildCityContext,
  cityFromSubmission,
  buildCityTags,
  summarizeCityTags,
  pushCitiesToResend,
};
