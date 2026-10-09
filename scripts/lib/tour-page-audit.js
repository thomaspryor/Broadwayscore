'use strict';
// National-tour page audit (BRO-4723): pure parsers and checks used by
// scripts/audit-tour-pages.js. Everything here takes HTML strings or plain
// data and returns findings, so tests/unit/tour-page-audit.test.mjs can feed
// it fixtures without a network.
//
// venue-write-guard-ok: venue strings here are parsed off built pages and
// compared against the data; this module never writes shows.json.
//
// The rules restate src/lib/tour-schedule.ts, src/lib/tour-cities.ts and
// src/lib/data-tour-cities.ts on purpose: the audit is an independent oracle
// for what the built site shows, so it must not import the code it checks.

const cheerio = require('cheerio');
const { jsonLdItems, hasJsonLdType } = require('./jsonld');

const DAY = 86400000;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** Same as src/lib/tour-cities.ts citySlug. */
function citySlug(city) {
  return String(city)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function nowNext(stops, today) {
  return {
    now: stops.find(s => s.start <= today && today <= s.end) || null,
    next: stops.find(s => s.start > today) || null,
  };
}

const { TOUR_PARENT_LABELS, productionsOfTitle, allowedTourArtIds, tourParentCategory } = require('./tour-family');

const PARENT_LINK_RE = /See the (.+?) production/i;

const normTitle = t => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|a|an|musical)\b/g, ' ').replace(/\s+/g, ' ').trim();

const finding = (severity, code, where, message) => ({ severity, code, where, message });

/** The TodayTix URL behind an affiliate redirect (todaytix.pxf.io/...?u=<encoded>), else the URL itself. */
function unwrapTicketUrl(href) {
  if (!href) return href;
  try {
    const u = new URL(href, 'https://broadwayscorecard.com');
    const inner = u.searchParams.get('u') || u.searchParams.get('url');
    if (inner && /^https?:\/\//.test(inner)) return inner;
  } catch { /* not a URL */ }
  return href;
}

// ---------------------------------------------------------------- parsers

function parseJsonLd($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html() || '';
    try { out.push({ value: JSON.parse(raw) }); } catch (e) { out.push({ error: e.message, raw: raw.slice(0, 200) }); }
  });
  return out;
}

function leafTexts($, root) {
  const out = [];
  $(root).find('*').each((_, el) => {
    if ($(el).children().length === 0) {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    }
  });
  return out;
}

function parseShowPage(html) {
  const $ = cheerio.load(html);
  const meta = $('[data-testid="show-meta-line"]').first();
  const metaP = meta.find('p').first().length ? meta.find('p').first() : meta;
  const metaText = metaP.text().replace(/\s+/g, ' ').trim();
  const runtimeM = metaText.match(/·\s*(\d+h(?:\s*\d+m)?|\d+m)\s*$/);
  const venueLine = runtimeM ? metaText.slice(0, runtimeM.index).trim() : metaText;
  const nowM = venueLine.match(/^Now in (.+?) · (.+)$/);
  const nextM = venueLine.match(/^Next: (.+), ([A-Z][a-z]{2} \d{1,2})$/);

  const card = $('#tour-schedule');
  const rowsOf = ul => ul.children('li').toArray().map(li => {
    const $li = $(li);
    const spans = $li.children('span');
    const place = $li.find('span.flex-1').first();
    const cityEl = place.children('span, a').eq(0);
    const ticket = $li.find('a[href]').filter((_, a) => /todaytix|tickets/i.test($(a).text() + $(a).attr('href'))).first();
    return {
      range: spans.first().text().trim(),
      city: cityEl.text().trim(),
      cityHref: cityEl.is('a') ? cityEl.attr('href') : (cityEl.find('a').attr('href') || null),
      venue: place.children('span, a').eq(1).text().trim(),
      now: /now playing/i.test($li.text()),
      ticketHref: ticket.length ? ticket.attr('href') : null,
      past: /opacity-60/.test($li.attr('class') || ''),
    };
  });
  const lists = card.find('ul');
  const fullList = card.find('details ul').first();
  const shownList = lists.filter((_, u) => $(u).closest('details').length === 0).first();

  const reviewsHeader = $('#critic-reviews header').first().text().replace(/\s+/g, ' ');
  const rcM = reviewsHeader.match(/(\d+)\s+reviews?/);
  // "See the Broadway production" / "See the Off-Broadway production" / ...: the link's market label follows the parent's category.
  const parentLinkEl = $('a').filter((_, a) => PARENT_LINK_RE.test($(a).text())).first();
  const broadwayLink = parentLinkEl.attr('href') || null;
  const parentLinkLabel = parentLinkEl.length ? (PARENT_LINK_RE.exec(parentLinkEl.text()) || [])[1] || null : null;
  const allTicketHrefs = $('a[href]').toArray().map(a => $(a).attr('href')).filter(h => /todaytix\.com/i.test(h));
  const imgs = $('img[src], img[srcset]').toArray().map(i => $(i).attr('src') || '').filter(Boolean);
  return {
    title: $('title').text(),
    robots: ($('meta[name="robots"]').attr('content') || '').toLowerCase(),
    canonical: $('link[rel="canonical"]').attr('href') || null,
    description: $('meta[name="description"]').attr('content') || '',
    h1: $('h1').first().text().replace(/\s+/g, ' ').trim(),
    tourSubtitle: $('[data-testid="tour-subtitle"]').first().text().trim() || null,
    venueLine,
    now: nowM ? { city: nowM[1], venue: nowM[2] } : null,
    next: nextM ? { city: nextM[1], date: nextM[2] } : null,
    runtime: runtimeM ? runtimeM[1].replace(/\s+/g, ' ') : null,
    reviewCount: rcM ? Number(rcM[1]) : (/Critic Scorecard/.test(reviewsHeader) ? 0 : null),
    scheduleCount: (() => { const m = card.find('header').text().match(/(\d+)\s+stops?/); return m ? Number(m[1]) : null; })(),
    scheduleShown: shownList.length ? rowsOf(shownList) : [],
    scheduleAll: fullList.length ? rowsOf(fullList) : [],
    hasSchedule: card.length > 0,
    lastStopNote: /played its last scheduled stop/i.test(card.text()),
    broadwayLink,
    parentLinkLabel,
    ticketHrefs: allTicketHrefs,
    images: imgs,
    jsonLd: parseJsonLd($),
    synopsisVisible: /About the Show|Synopsis/i.test($('main').text()),
  };
}

function parseListPage(html) {
  const $ = cheerio.load(html);
  const shows = [];
  const seen = new Set();
  $('a[href^="/show/"]').each((_, a) => {
    const id = $(a).attr('href').replace(/^\/show\//, '').replace(/[#?].*$/, '');
    if (seen.has(id)) return;
    seen.add(id);
    let card = $(a);
    for (let i = 0; i < 6 && card.parent().length; i++) {
      if (leafTexts($, card).some(t => /^\d+ reviews?$/.test(t))) break;
      card = card.parent();
    }
    const rc = leafTexts($, card).find(t => /^\d+ reviews?$/.test(t));
    const line = leafTexts($, card).find(t => /^(Now in|Next:)/.test(t)) || null;
    shows.push({ id, reviewCount: rc ? Number(rc.match(/\d+/)[0]) : null, line });
  });
  const cityLinks = Array.from(new Set($('a[href^="/tours/"]').toArray().map(a => $(a).attr('href').replace(/^\/tours\//, '').replace(/[#?/].*$/, ''))));
  return {
    robots: ($('meta[name="robots"]').attr('content') || '').toLowerCase(),
    countLabel: (() => { const m = $('main').text().match(/(\d+)\s+shows\s*\|/); return m ? Number(m[1]) : null; })(),
    shows,
    cityLinks,
    jsonLd: parseJsonLd($),
  };
}

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

function parseCityPage(html) {
  const $ = cheerio.load(html);
  const rows = [];
  $('section[aria-labelledby^="tc-"]').each((_, sec) => {
    const section = $(sec).attr('aria-labelledby').replace('tc-', '');
    $(sec).find('ul > li').each((__, li) => {
      const $li = $(li);
      const line = $li.children('p').first().text().replace(/\s+/g, ' ').trim();
      const [when, venue] = line.replace(/ · Tickets ↗$/, '').split(' · ');
      const showHref = $li.find('a[href^="/show/"]').first().attr('href') || '';
      const ticket = $li.children('p').first().find('a[href]').attr('href') || null;
      rows.push({ section, showId: showHref.replace(/^\/show\//, ''), when: (when || '').replace(/^Played /, ''), venue: (venue || '').trim(), ticketHref: ticket });
    });
  });
  return {
    status: null,
    robots: ($('meta[name="robots"]').attr('content') || '').toLowerCase(),
    canonical: $('link[rel="canonical"]').attr('href') || null,
    h1: $('h1').first().text().replace(/\s+/g, ' ').trim(),
    rows,
    jsonLd: parseJsonLd($),
  };
}

/** "Oct 13–Nov 1" / "Nov 13–15" / "Dec 29, 2026–Jan 3, 2027" / "Oct 6" → the start month/day it names. */
function rangeStartMonthDay(text) {
  const m = String(text).match(/^([A-Z][a-z]{2}) (\d{1,2})/);
  return m ? { month: MONTHS[m[1]], day: Number(m[2]) } : null;
}

/** Does a rendered date range ("Oct 13–Nov 1", "Played Nov 13–15, 2025") describe this stop? */
function rangeMatchesStop(text, stop) {
  const t = String(text).replace(/^Played /, '');
  const s = rangeStartMonthDay(t);
  if (!s) return false;
  if (s.month !== Number(stop.start.slice(5, 7)) || s.day !== Number(stop.start.slice(8, 10))) return false;
  const endDay = Number(stop.end.slice(8, 10));
  const endMon = Number(stop.end.slice(5, 7));
  if (stop.start === stop.end) return true;
  const tail = t.split('–')[1] || '';
  const em = tail.match(/^([A-Z][a-z]{2}) (\d{1,2})/);
  if (em) return MONTHS[em[1]] === endMon && Number(em[2]) === endDay;
  const dm = tail.match(/^(\d{1,2})/);
  return !!dm && Number(dm[1]) === endDay;
}

// ---------------------------------------------------------- data checks

/**
 * Checks on the data a tour page is built from (shows.json record, its
 * parent production, schedule, ticket rows). `others` is every other tour's
 * schedule, keyed by id, for the copied-table check. `shows` (all shows) lets
 * the audit tell a standalone tour from one missing its tourOf, and widens the
 * allowed art to same-title productions in the parent's category or Broadway.
 * tourOf is optional (BRO-4931): a standalone touring show has none.
 */
function checkTourData({ show, parent, schedule, tickets = [], others = {}, today, listed = false, shows = null }) {
  const out = [];
  const w = `data:${show.id}`;
  const stops = (schedule && schedule.stops) || [];

  if (!show.tourOf) {
    // Standalone tours are valid; only a tour that shares its title with a
    // production is probably missing the link.
    const same = shows ? productionsOfTitle(show.title, shows) : [];
    if (same.length) out.push(finding('warn', 'tourof-missing', w, `tour has no tourOf but ${same.length} production(s) share its title (${same.slice(0, 3).map(s => s.id).join(', ')})`));
  } else if (!parent) out.push(finding('error', 'tourof-dangling', w, `tourOf "${show.tourOf}" is not in shows.json`));
  else {
    if (parent.category === 'tour') out.push(finding('error', 'tourof-is-tour', w, `tourOf ${parent.id} is itself a tour`));
    if (normTitle(parent.title) !== normTitle(show.title)) out.push(finding('error', 'tourof-title-mismatch', w, `tour "${show.title}" points at "${parent.title}" (${parent.id})`));
  }

  const imgs = show.images || {};
  if (!imgs.poster && !imgs.thumbnail && !imgs.hero) out.push(finding('error', 'poster-missing', w, 'no poster, thumbnail or hero image'));
  const artIds = new Set(allowedTourArtIds(show, shows || (parent ? [parent] : [])));
  for (const [k, v] of Object.entries(imgs)) {
    const m = typeof v === 'string' && v.match(/\/images\/shows\/([^/]+)\//);
    if (m && !artIds.has(m[1])) {
      out.push(finding('error', 'art-from-other-production', w, `${k} image comes from ${m[1]}, not this tour, its parent ${show.tourOf || '(none)'} or a same-title production`));
    }
  }
  if (!show.synopsis || String(show.synopsis).trim().length < 40) out.push(finding('warn', 'synopsis-missing', w, 'no synopsis (or under 40 chars)'));

  if (show.closingDate && show.status !== 'closed' && show.closingDate < addDays(today, -1)) {
    out.push(finding('error', 'status-past-closing', w, `status ${show.status} but closingDate ${show.closingDate} has passed`));
  }

  if (stops.length) {
    const src = schedule.source || '';
    const slugM = src.match(/\/shows\/([^/]+)\/?$/);
    if (slugM && show.tourScheduleSlug && slugM[1] !== show.tourScheduleSlug) {
      out.push(finding('error', 'schedule-source-mismatch', w, `schedule read from ${src}, but tourScheduleSlug is ${show.tourScheduleSlug}`));
    } else if (slugM && !show.tourScheduleSlug && normTitle(slugM[1].replace(/-/g, ' ')) !== normTitle(show.title)) {
      out.push(finding('warn', 'schedule-source-title', w, `schedule source slug "${slugM[1]}" does not match title "${show.title}"`));
    }
    if (show.closingDate) {
      const after = stops.filter(s => s.start > show.closingDate);
      if (after.length) out.push(finding('error', 'stops-after-closing', w, `${after.length} stop(s) start after closingDate ${show.closingDate} (first: ${after[0].city} ${after[0].start})`));
    }
    if (show.status === 'closed') {
      const ahead = stops.filter(s => s.end >= today);
      if (ahead.length) out.push(finding('error', 'closed-tour-has-future-stops', w, `closed tour still has ${ahead.length} stop(s) on or after ${today}`));
    }
    if (show.openingDate) {
      const before = stops.filter(s => s.end < show.openingDate);
      if (before.length) out.push(finding('error', 'stops-before-opening', w, `${before.length} stop(s) end before the tour's openingDate ${show.openingDate} (another company's dates?)`));
    }
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s.start) || !/^\d{4}-\d{2}-\d{2}$/.test(s.end) || s.end < s.start) {
        out.push(finding('error', 'stop-bad-dates', w, `stop ${s.city} has dates ${s.start}..${s.end}`));
      }
      if (!s.city || !/,\s*[A-Z]{2}$/.test(s.city)) out.push(finding('warn', 'stop-city-format', w, `stop city "${s.city}" is not "City, ST"`));
      if (!s.venue) out.push(finding('error', 'stop-no-venue', w, `stop ${s.city} ${s.start} has no venue`));
      if (i && s.start < stops[i - 1].start) out.push(finding('error', 'stops-unsorted', w, `stops out of date order at ${s.city} ${s.start}`));
      if (i && s.start <= stops[i - 1].end && s.city !== stops[i - 1].city) {
        out.push(finding('error', 'stops-overlap', w, `${stops[i - 1].city} (${stops[i - 1].start}..${stops[i - 1].end}) overlaps ${s.city} (${s.start}..${s.end}): two companies merged into one schedule?`));
      }
    }
    // Copied table: another tour with the same run of 3+ identical stops.
    const sig = s => `${s.city}|${s.venue}|${s.start}|${s.end}`;
    const mine = new Set(stops.map(sig));
    for (const [oid, o] of Object.entries(others)) {
      if (oid === show.id) continue;
      const shared = ((o && o.stops) || []).filter(s => mine.has(sig(s)));
      if (shared.length >= 3) out.push(finding('error', 'schedule-copied', w, `${shared.length} stops identical to ${oid}'s schedule (another show's table?)`));
    }
    // An open tour whose every known stop is behind it: it closed and the
    // status lags, or the source posted no further dates (Kinky Boots' page
    // resumes 8 months later, which the segmenter treats as a new leg).
    const last = stops[stops.length - 1];
    if (show.status !== 'closed' && !show.closingDate && last && last.end < addDays(today, -14)) {
      out.push(finding('warn', 'schedule-ended', w, `open tour's last known stop ended ${last.end} (${last.city}); closed, or between legs?`));
    }
  } else if (show.status !== 'closed') {
    // A listed tour is indexed and on the tours list: no schedule means no
    // "Now in" line and no Tour Schedule card on a page people will visit.
    out.push(finding(listed ? 'error' : 'warn', 'schedule-missing', w, 'open tour has no schedule in data/tour-schedules.json'));
  }

  const byKey = new Map(stops.map(s => [`${s.city}|${s.start}`, s]));
  for (const t of tickets) {
    const stop = byKey.get(`${t.city}|${t.start}`);
    if (!stop) { out.push(finding('error', 'ticket-no-stop', w, `ticket row ${t.city} ${t.start} matches no schedule stop`)); continue; }
    if (!/^https:\/\/(www\.)?todaytix\.com\//.test(t.url || '')) out.push(finding('error', 'ticket-bad-url', w, `ticket url for ${t.city} is not a TodayTix https URL: ${t.url}`));
    if (t.onSale && show.status === 'closed') out.push(finding('error', 'ticket-on-closed-tour', w, `on-sale ticket row for ${t.city} on a closed tour`));
  }
  return out;
}

// ---------------------------------------------------------- JSON-LD

const EVENT_TYPES = ['Event', 'TheaterEvent', 'MusicEvent', 'Festival', 'ComedyEvent', 'DanceEvent', 'ScreeningEvent'];
// @type may be a string or an array (schema.org allows both).
const isEvent = n => EVENT_TYPES.some(t => hasJsonLdType(n, t));
const EVENT_STATUS = new Set(['EventScheduled', 'EventCancelled', 'EventPostponed', 'EventRescheduled', 'EventMovedOnline'].map(s => `https://schema.org/${s}`));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const ABS_URL = /^https?:\/\/[^\s]+$/;

/**
 * Google Event rich-result rules (developers.google.com/search/docs/
 * appearance/structured-data/event): name, startDate and location are
 * required; location is a Place with a name and an address (or a
 * VirtualLocation); endDate not before startDate; enumerations are
 * schema.org URLs; image, offers.url and url are absolute.
 */
function validateEvent(e, where) {
  const out = [];
  const err = (code, msg) => out.push(finding('error', code, where, msg));
  if (!e || typeof e !== 'object') return [finding('error', 'ld-event-not-object', where, 'event is not an object')];
  if (!isEvent(e)) err('ld-event-type', `@type ${JSON.stringify(e['@type'])} is not an Event type`);
  if (!e.name || typeof e.name !== 'string') err('ld-event-name', 'missing name');
  if (!e.startDate || !ISO_DATE.test(e.startDate)) err('ld-event-startdate', `startDate "${e.startDate}" missing or not ISO 8601`);
  if (e.endDate !== undefined) {
    if (!ISO_DATE.test(e.endDate)) err('ld-event-enddate', `endDate "${e.endDate}" not ISO 8601`);
    else if (e.startDate && e.endDate.slice(0, 10) < e.startDate.slice(0, 10)) err('ld-event-enddate-order', `endDate ${e.endDate} before startDate ${e.startDate}`);
  }
  if (e.eventStatus !== undefined && !EVENT_STATUS.has(e.eventStatus)) err('ld-event-status', `eventStatus "${e.eventStatus}" is not a schema.org EventStatusType URL`);
  if (e.eventAttendanceMode !== undefined && !/^https:\/\/schema\.org\/(Offline|Online|Mixed)EventAttendanceMode$/.test(e.eventAttendanceMode)) err('ld-event-attendance', `eventAttendanceMode "${e.eventAttendanceMode}" invalid`);
  const locs = Array.isArray(e.location) ? e.location : [e.location];
  if (!e.location) err('ld-event-location', 'missing location');
  else for (const l of locs) {
    if (!l || typeof l !== 'object') { err('ld-event-location', 'location is not an object'); continue; }
    if (l['@type'] === 'VirtualLocation') { if (!l.url) err('ld-event-location', 'VirtualLocation without url'); continue; }
    if (!l.name) err('ld-location-name', 'location has no name');
    const a = l.address;
    if (!a) err('ld-location-address', `location "${l.name}" has no address`);
    else if (typeof a === 'object' && !a.addressLocality && !a.streetAddress && !a.addressCountry) err('ld-location-address', `location "${l.name}" address has no locality/street/country`);
  }
  if (e.image !== undefined) {
    for (const im of [].concat(e.image)) if (typeof im !== 'string' || !ABS_URL.test(im)) err('ld-event-image', `image "${JSON.stringify(im).slice(0, 80)}" is not an absolute URL`);
  }
  if (e.url !== undefined && !ABS_URL.test(e.url)) err('ld-event-url', `url "${e.url}" is not absolute`);
  for (const o of [].concat(e.offers || [])) {
    if (o['@type'] && !/^(Offer|AggregateOffer)$/.test(o['@type'])) err('ld-offer-type', `offer @type ${o['@type']}`);
    if (o.url !== undefined && !ABS_URL.test(o.url)) err('ld-offer-url', `offer url "${o.url}" is not absolute`);
    if (o.availability !== undefined && !/^https:\/\/schema\.org\/[A-Za-z]+$/.test(o.availability)) err('ld-offer-availability', `offer availability "${o.availability}" invalid`);
    if (o.validFrom !== undefined && !ISO_DATE.test(o.validFrom)) err('ld-offer-validfrom', `offer validFrom "${o.validFrom}" invalid`);
  }
  if (e.aggregateRating) {
    const r = e.aggregateRating;
    const v = Number(r.ratingValue), best = Number(r.bestRating ?? 5), worst = Number(r.worstRating ?? 1);
    if (!(v >= worst && v <= best)) err('ld-rating-range', `ratingValue ${r.ratingValue} outside ${worst}..${best}`);
    if (!(Number(r.reviewCount ?? r.ratingCount) > 0)) err('ld-rating-count', 'aggregateRating without a positive reviewCount/ratingCount');
  }
  for (const [i, s] of (e.subEvent ? [].concat(e.subEvent) : []).entries()) out.push(...validateEvent(s, `${where} subEvent[${i}]`));
  return out;
}

/** Every Event node in a page's JSON-LD blocks (top level, @graph, ItemList items). */
function eventsIn(blocks) {
  const out = [];
  // jsonLdItems flattens one level of arrays and @graph wrappers
  // (scripts/lib/jsonld.js); recurse for deeper nesting (an array element that
  // is itself an array, a @graph inside a graph node) so no event is skipped.
  const walk = v => {
    const top = Array.isArray(v) ? v : [v];
    for (const n of jsonLdItems(v)) {
      if (Array.isArray(n)) walk(n);
      else if (isEvent(n)) out.push(n);
      else if (hasJsonLdType(n, 'ItemList')) (n.itemListElement || []).forEach(li => walk(li && (li.item || li)));
      if (!top.includes(n) && Array.isArray(n['@graph'])) walk(n['@graph']);
    }
  };
  blocks.forEach(b => b.value && walk(b.value));
  return out;
}

// ---------------------------------------------------------- page checks

/**
 * One tour show page against its data. `todays` is the list of dates the
 * build may legitimately reflect (today, and yesterday: a page built late
 * last night is still the live one until the next deploy).
 */
function checkShowPage({ url, page, show, parent, schedule, tickets = [], todays, listed, inSitemap, listReviewCount, jsonReviewCount, cityPages }) {
  const out = [];
  const err = (c, m) => out.push(finding('error', c, url, m));
  const warn = (c, m) => out.push(finding('warn', c, url, m));
  const stops = (schedule && schedule.stops) || [];
  const closed = show.status === 'closed';

  if (page.tourSubtitle !== 'National Tour') err('hero-subtitle', `hero subtitle is "${page.tourSubtitle}", expected "National Tour"`);

  // Now in / Next line
  const expect = todays.map(d => nowNext(stops, d));
  if (closed) {
    if (page.now || page.next) err('closed-tour-now-next', `closed tour shows "${page.venueLine}"`);
  } else if (stops.length) {
    if (page.now) {
      const ok = expect.some(e => e.now && e.now.city === page.now.city && e.now.venue === page.now.venue);
      if (!ok) err('now-in-stale', `page says "Now in ${page.now.city} · ${page.now.venue}", schedule says ${expect[0].now ? `${expect[0].now.city} · ${expect[0].now.venue}` : `no stop playing (next: ${expect[0].next ? expect[0].next.city : 'none'})`}`);
    } else if (page.next) {
      const ok = expect.some(e => !e.now && e.next && e.next.city.startsWith(page.next.city.replace(/,.*$/, '')));
      if (!ok) err('next-stale', `page says "Next: ${page.next.city}, ${page.next.date}", schedule says ${expect[0].now ? `now in ${expect[0].now.city}` : expect[0].next ? `next ${expect[0].next.city} ${expect[0].next.start}` : 'no stops ahead'}`);
    } else if (expect.some(e => e.now || e.next)) {
      err('now-next-missing', `schedule has ${expect[0].now ? `a stop playing now (${expect[0].now.city})` : `a next stop (${expect[0].next.city})`} but the hero shows "${page.venueLine}"`);
    }
  } else if (page.now || page.next) {
    err('now-next-without-schedule', `hero shows "${page.venueLine}" but the tour has no schedule`);
  }

  // Schedule card mirrors data/tour-schedules.json
  if (stops.length && !page.hasSchedule) err('schedule-card-missing', 'tour has a schedule but no Tour Schedule card rendered');
  if (!stops.length && page.hasSchedule) err('schedule-card-unexpected', 'Tour Schedule card rendered with no schedule in data');
  if (stops.length && page.hasSchedule) {
    if (page.scheduleCount !== stops.length) warn('schedule-count-drift', `card says ${page.scheduleCount} stops, data has ${stops.length} (deploy lag if schedules refreshed today)`);
    page.scheduleAll.forEach((r, i) => {
      const s = stops[i];
      if (!s) return;
      if (r.city !== s.city || r.venue !== s.venue || !rangeMatchesStop(r.range, s)) {
        if (i < 3 || out.filter(f => f.code === 'schedule-row-mismatch').length < 3) err('schedule-row-mismatch', `row ${i + 1} shows "${r.range} ${r.city} / ${r.venue}", data has "${s.start}..${s.end} ${s.city} / ${s.venue}"`);
      }
      if (cityPages) {
        const slug = citySlug(s.city);
        if (cityPages.has(slug) && r.cityHref !== `/tours/${slug}`) err('schedule-city-unlinked', `row ${s.city} should link /tours/${slug}`);
        if (!cityPages.has(slug) && r.cityHref) err('schedule-city-dead-link', `row ${s.city} links ${r.cityHref} but no such city page is built`);
      }
    });
    const nowRows = page.scheduleShown.filter(r => r.now);
    if (nowRows.length > 1) err('schedule-multiple-now', `${nowRows.length} rows marked NOW PLAYING`);
    if (closed && page.scheduleShown.length) err('closed-tour-upcoming-rows', 'closed tour lists upcoming stops');
  }

  // Tickets
  if (closed) for (const h of page.ticketHrefs) err('ticket-on-closed-tour', `closed tour shows ticket link ${unwrapTicketUrl(h)}`);
  for (const r0 of [...page.scheduleShown, ...page.scheduleAll]) {
    if (!r0.ticketHref) continue;
    const r = { ...r0, ticketHref: unwrapTicketUrl(r0.ticketHref) };
    if (r.past) err('ticket-on-past-stop', `past stop ${r.city} (${r.range}) has a ticket link`);
    const t = tickets.find(x => x.city === r.city && rangeMatchesStop(r.range, { start: x.start, end: (stops.find(s => s.city === x.city && s.start === x.start) || { end: x.start }).end }));
    if (!t) err('ticket-wrong-stop', `${r.city} (${r.range}) ticket link ${r.ticketHref} matches no ticket row for that stop`);
    else if (!t.onSale) err('ticket-not-on-sale', `${r.city} shows a ticket link but the row is not on sale`);
    else if (t.url !== r.ticketHref) err('ticket-wrong-url', `${r.city} ticket link ${r.ticketHref}, data has ${t.url}`);
  }

  // Parent production
  if (show.tourOf && parent) {
    const label = TOUR_PARENT_LABELS[tourParentCategory(parent)] || 'Broadway';
    if (!page.broadwayLink) warn('broadway-link-missing', `no "See the ${label} production" link`);
    else {
      if (page.broadwayLink !== `/show/${parent.slug || parent.id}`) err('broadway-link-wrong', `"See the ${label} production" links ${page.broadwayLink}, tourOf is ${parent.slug || parent.id}`);
      if (page.parentLinkLabel && page.parentLinkLabel !== label) warn('parent-link-label-wrong', `parent link says "See the ${page.parentLinkLabel} production", parent is category ${parent.category || 'broadway'} ("${label}")`);
    }
  }

  // Runtime: the tour's own, else (if shown) the Broadway parent's.
  if (page.runtime) {
    const own = show.runtime || null;
    if (own && own !== page.runtime) err('runtime-mismatch', `page runtime ${page.runtime}, data ${own}`);
    if (!own && parent && parent.runtime && parent.runtime !== page.runtime) warn('runtime-unexplained', `page runtime ${page.runtime}, tour has none and parent has ${parent.runtime}`);
  } else warn('runtime-missing', 'no runtime shown');

  // Review counts agree across list, page and the public JSON.
  const counts = [['page', page.reviewCount], ['list', listReviewCount], ['json', jsonReviewCount]].filter(([, v]) => v != null);
  if (new Set(counts.map(([, v]) => v)).size > 1) err('review-count-mismatch', `review counts disagree: ${counts.map(([k, v]) => `${k}=${v}`).join(', ')}`);

  // Indexing
  const noindex = /noindex/.test(page.robots);
  if (listed && noindex) err('listed-but-noindex', 'tour is on the tours list but the page is noindex');
  if (!listed && !noindex) err('unlisted-but-indexed', 'tour is not listed (too few reviews) but the page is indexable');
  if (inSitemap && noindex) err('sitemap-noindex', 'page is in the sitemap but noindex');
  if (listed && !inSitemap) err('listed-not-in-sitemap', 'listed tour page missing from the sitemap');
  if (!listed && inSitemap) err('unlisted-in-sitemap', 'unlisted tour page is in the sitemap');
  if (page.canonical && !page.canonical.endsWith(`/show/${show.slug || show.id}`)) err('canonical-wrong', `canonical ${page.canonical}`);

  // JSON-LD
  for (const b of page.jsonLd) if (b.error) err('ld-parse', `JSON-LD block does not parse: ${b.error}`);
  const events = eventsIn(page.jsonLd);
  if (!events.length) err('ld-no-event', 'no Event in JSON-LD');
  events.forEach((e, i) => out.push(...validateEvent(e, `${url} ld[${i}]`)));
  const main = events[0];
  if (main && stops.length) {
    const subs = [].concat(main.subEvent || []);
    const ahead = stops.filter(s => s.end >= todays[todays.length - 1]);
    if (closed && subs.length) err('ld-closed-subevents', `closed tour still lists ${subs.length} subEvents`);
    for (const se of subs) {
      const s = stops.find(x => x.start === se.startDate && x.end === se.endDate && x.venue === (se.location && se.location.name));
      if (!s) err('ld-subevent-unknown', `subEvent ${se.name} ${se.startDate}..${se.endDate} matches no schedule stop`);
      else if (s.end < todays[todays.length - 1]) err('ld-subevent-past', `subEvent ${se.name} ended ${s.end}`);
      if (se.offers && se.offers.url) {
        const t = tickets.find(x => x.url === unwrapTicketUrl(se.offers.url));
        if (!t || (s && (t.city !== s.city || t.start !== s.start))) err('ld-offer-wrong-stop', `subEvent ${se.name} offer ${se.offers.url} belongs to ${t ? `${t.city} ${t.start}` : 'no ticket row'}`);
      }
    }
    if (!closed && ahead.length && !subs.length) err('ld-subevents-missing', `${ahead.length} stops ahead but no subEvent`);
  }
  if (main && closed && main.eventStatus && main.eventStatus !== 'https://schema.org/EventScheduled') {
    // closed is fine either way; schema has no "ended" status
  }
  return out;
}

/** The city pages the build should have, from data (mirrors data-tour-cities.ts). */
function expectedCities({ tours, schedules, listedIds, today, minTours = 3, indexMinTours = 5, recentDays = 365 }) {
  const since = addDays(today, -recentDays);
  const open = tours.filter(t => t.status !== 'closed');
  const byCity = new Map();
  for (const t of open) {
    for (const s of ((schedules[t.id] && schedules[t.id].stops) || [])) {
      const slug = citySlug(s.city);
      if (!slug) continue;
      if (!byCity.has(slug)) byCity.set(slug, { city: s.city, stops: [] });
      byCity.get(slug).stops.push({ ...s, showId: t.id });
    }
  }
  const out = new Map();
  byCity.forEach(({ city, stops }, slug) => {
    stops.sort((a, b) => a.start.localeCompare(b.start) || a.showId.localeCompare(b.showId));
    const listed = stops.filter(s => listedIds.has(s.showId));
    const recent = new Set(listed.filter(s => s.end >= since).map(s => s.showId));
    if (recent.size < minTours) return;
    const upcoming = new Set(listed.filter(s => s.end >= today).map(s => s.showId)).size;
    out.set(slug, { slug, city, stops: stops.filter(s => s.end >= since), indexed: upcoming >= indexMinTours });
  });
  return out;
}

function checkCityPage({ url, page, expected, tours, schedules, tickets, todays, inSitemap }) {
  const out = [];
  const err = (c, m) => out.push(finding('error', c, url, m));
  const today = todays[todays.length - 1];
  const byId = new Map(tours.map(t => [t.id, t]));
  const noindex = /noindex/.test(page.robots);
  if (expected.indexed && noindex) err('city-should-index', `${expected.city} has 5+ listed tours ahead but is noindex`);
  if (!expected.indexed && !noindex) err('city-should-noindex', `${expected.city} is indexable with under 5 listed tours ahead`);
  if (inSitemap && noindex) err('city-sitemap-noindex', 'in sitemap but noindex');
  if (expected.indexed && !inSitemap) err('city-missing-from-sitemap', 'indexed city page not in sitemap');
  if (!expected.indexed && inSitemap) err('city-noindex-in-sitemap', 'noindex city page is in sitemap');
  if (!page.h1.includes(expected.city.replace(/,\s*[A-Z]{2}$/, ''))) err('city-h1', `h1 "${page.h1}" does not name ${expected.city}`);
  if (!page.rows.length) err('city-empty', 'no tour rows');

  for (const r of page.rows) {
    const show = byId.get(r.showId);
    if (!show) { err('city-row-unknown-show', `row links /show/${r.showId}, not a tour`); continue; }
    if (show.status === 'closed') err('city-row-closed-tour', `${show.title} is closed but listed`);
    const stops = ((schedules[r.showId] && schedules[r.showId].stops) || []).filter(s => citySlug(s.city) === expected.slug);
    const s = stops.find(x => rangeMatchesStop(r.when, x));
    if (!s) { err('city-row-no-stop', `${show.title} "${r.when}" matches no ${expected.city} stop in its schedule`); continue; }
    if (s.venue !== r.venue) err('city-row-venue', `${show.title} ${r.when}: venue "${r.venue}", schedule "${s.venue}"`);
    const want = s.start <= today && today <= s.end ? 'now' : s.start > today ? 'ahead' : 'past';
    const lag = todays.map(d => (s.start <= d && d <= s.end ? 'now' : s.start > d ? 'ahead' : 'past'));
    if (!lag.includes(r.section)) err('city-row-section', `${show.title} ${r.when} is under "${r.section}", expected "${want}"`);
    if (r.ticketHref) {
      if (r.section === 'past') err('city-ticket-past', `${show.title} past stop has a ticket link`);
      const t = (tickets[r.showId] || []).find(x => x.city === s.city && x.start === s.start);
      if (!t || t.url !== unwrapTicketUrl(r.ticketHref)) err('city-ticket-wrong', `${show.title} ${expected.city} ticket ${r.ticketHref} is not that stop's TodayTix link`);
    }
  }
  const shown = new Set(page.rows.map(r => `${r.showId}|${r.when}`));
  for (const s of expected.stops) {
    if (byId.get(s.showId) && byId.get(s.showId).status === 'closed') continue;
    const hit = page.rows.some(r => r.showId === s.showId && rangeMatchesStop(r.when, s));
    if (!hit) err('city-stop-missing', `${s.showId} ${s.start}..${s.end} at ${s.venue} is in data but not on the page`);
  }
  void shown;
  for (const b of page.jsonLd) if (b.error) err('ld-parse', `JSON-LD block does not parse: ${b.error}`);
  eventsIn(page.jsonLd).forEach((e, i) => {
    out.push(...validateEvent(e, `${url} ld[${i}]`));
    if (e.endDate && e.endDate < today) err('ld-city-past-event', `${e.name} ended ${e.endDate}`);
  });
  return out;
}

// ---- alert routing ----------------------------------------------------------

const CONDITION_PREFIX = 'tour-page-audit:';

/**
 * File one Linear card per error code through owner-alert-router.js (the
 * audit-dependencies.js pattern), and close the cards for codes this run no
 * longer reports. `router` is injected ({ routeAlert, resolveCondition,
 * loadLedger }) so the unit test drives the real contract. routeAlert never
 * throws on a dispatch failure; a missing tracker counts as a failure.
 * @returns {{ alerts: Array<object>, alertDispatchFailed: boolean }}
 */
// previousCodes: the error codes the last run reported (null = file at once).
// The live site can trail data/ by up to 6h (core data rides the deploy
// backstop), so a code seen on one run only may be deploy lag: it files on the
// second consecutive run, or at once when its card is already open.
async function runAlerts({ findings, router, runContext = {}, previousCodes = null, log = console.error }) {
  const { routeAlert, resolveCondition, loadLedger } = router;
  const byCode = new Map();
  for (const f of findings) {
    if (f.severity !== 'error') continue;
    if (!byCode.has(f.code)) byCode.set(f.code, []);
    byCode.get(f.code).push(f);
  }
  const keys = new Set([...byCode.keys()].map(c => CONDITION_PREFIX + c));
  const ledger = loadLedger();
  for (const [key, c] of Object.entries((ledger && ledger.conditions) || {})) {
    if (key.startsWith(CONDITION_PREFIX) && c.status === 'open' && !keys.has(key)) {
      resolveCondition(key, { reason: 'audit-tour-pages: no longer reported' });
    }
  }
  const dispatchAtFiling = runContext.runId ? { runId: runContext.runId, runUrl: runContext.runUrl || null } : undefined;
  const alerts = [];
  const pending = [];
  let alertDispatchFailed = false;
  for (const [code, list] of byCode) {
    const key = CONDITION_PREFIX + code;
    const open = ledger && ledger.conditions && ledger.conditions[key] && ledger.conditions[key].status === 'open';
    if (previousCodes && !previousCodes.has(code) && !open) {
      pending.push(code);
      log(`[alert] ${key}: first sighting (${list.length}), files if the next run still reports it`);
      continue;
    }
    const sample = list.slice(0, 15).map(f => `- ${f.where}: ${f.message}`).join('\n');
    try {
      const result = await routeAlert({
        conditionKey: key,
        title: `National tour pages show wrong information: ${list.length} page problem(s) (${code})`,
        description: `A helper session is assigned to this card automatically; the owner does not need to act. If nothing is done, readers of the national-tour pages keep seeing this.\n\nTechnical: the daily tour page audit (.github/workflows/audit-tour-pages.yml) found ${list.length} "${code}" error(s)${list.length > 15 ? ' (first 15)' : ''}:\n${sample}\n\nFix the root cause (the data pipeline or the page code), never the data by hand. The card closes itself on the first audit that no longer reports ${code}.`,
        hint: 'Reproduce with `node scripts/audit-tour-pages.js --warnings`; the checks live in scripts/lib/tour-page-audit.js.',
        severity: 'error',
        disposition: 'auto',
        cardAction: 'Fix',
        dispatchAtFiling,
        verify: { line: 'VERIFY: node scripts/audit-tour-pages.js --summary', note: 'crawls the live tour pages; exits 0 only when no error remains' },
      });
      const failed = result.dispatchOk === false || (['auto', 'silent'].includes(result.action) && !result.linearIdentifier);
      if (failed) { alertDispatchFailed = true; log(`[alert] dispatch failed for ${key}: ${result.dispatchError || 'no tracker identifier returned'}`); }
      alerts.push({ conditionKey: key, action: result.action, linearIdentifier: result.linearIdentifier || null, dispatchOk: !failed });
    } catch (err) {
      alertDispatchFailed = true;
      log(`[alert] routeAlert threw for ${key}: ${err.message}`);
      alerts.push({ conditionKey: key, action: 'error', linearIdentifier: null, dispatchOk: false });
    }
  }
  return { alerts, pending, alertDispatchFailed, codes: [...byCode.keys()].sort() };
}

module.exports = {
  citySlug, nowNext, normTitle, addDays, unwrapTicketUrl,
  parseShowPage, parseListPage, parseCityPage, rangeMatchesStop,
  checkTourData, checkShowPage, checkCityPage, expectedCities,
  validateEvent, eventsIn, runAlerts, CONDITION_PREFIX,
};
