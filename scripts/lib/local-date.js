'use strict';
/**
 * local-date — the calendar date a reader saw on the article, not the UTC date.
 *
 * Why (BRO-5499): `date.toISOString().slice(0, 10)` and `og:published_time`
 * values ending in Z / +00:00 give the UTC date. An opening-night review posted
 * at 9pm ET on Oct 15 is 01:00 UTC Oct 16, so it was stored as Oct 16. Corpus
 * scan 2026-10-16: of ~8,300 review files whose URL carries /YYYY/MM/DD/, ~400
 * were stored exactly one day LATER than the URL date and ~35 one day earlier,
 * concentrated in RSS / listing / page-meta sources.
 *
 * Rules:
 *   - an ISO stamp with an explicit non-UTC offset ("-04:00") is already local:
 *     take its date part verbatim;
 *   - a UTC stamp (Z, +00:00, +0000), or an RFC-822 / Date instant, is converted
 *     to the publisher's timezone (America/New_York; Europe/London for UK hosts or when the
 *     caller passes {tz}); exactly 00:00:00 UTC is a date-only value and is kept as is;
 *   - known limit: a CMS that prints LOCAL time with a fake +00:00 offset is wrong for posts
 *     between midnight and ~4am local only;
 *   - a date-only or zone-less stamp is returned as is (it is a calendar date).
 *
 * Pure: no I/O (CLAUDE.md §15). Tests: local-date.test.mjs.
 */

const NY = 'America/New_York';
const LONDON = 'Europe/London';

// Publisher hostnames that are UK outlets without a UK ccTLD. Matched on the HOSTNAME only (equal or
// subdomain), never on the whole URL, so nashuatelegraph.com / independent.com stay New York.
const UK_HOSTNAMES = ['theguardian.com', 'whatsonstage.com', 'thetimes.com', 'ft.com', 'theartsdesk.com', 'broadwayworld.com/westend'];
const UK_TLD_RE = /\.(?:uk|london)$/i;

function hostOf(url) {
  const m = String(url || '').match(/^(?:https?:)?\/\/([^/:?#]+)/i);
  return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
}

/**
 * Timezone of the market a show belongs to (shows.json market / category), or null when unknown.
 * Callers that know the show should prefer this over the publisher host.
 */
function tzForMarket(marketOrCategory) {
  const m = String(marketOrCategory || '').toLowerCase();
  if (m === 'west-end' || m === 'off-west-end') return LONDON;
  if (m === 'broadway' || m === 'off-broadway' || m === 'tour') return NY;
  return null;
}

function tzForUrl(url) {
  const host = hostOf(url);
  if (host && (UK_TLD_RE.test(host) || UK_HOSTNAMES.some((h) => !h.includes('/') && (host === h || host.endsWith('.' + h))))) return LONDON;
  if (/broadwayworld\.com\/westend/i.test(String(url || ''))) return LONDON;
  return NY;
}

/** Calendar date (YYYY-MM-DD) of an instant in the given IANA timezone. */
function localDateString(instant, tz = NY) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Calendar date of a feed/page timestamp for the article at `url`. Returns null when unparseable. */
function publishedStampToLocalDate(raw, url, { tz } = {}) {
  if (raw == null) return null;
  const tzName = tz || tzForUrl(url);
  // Exactly 00:00:00 UTC is how feeds and CMSs print a date-only value: that IS the calendar date.
  if (raw instanceof Date) return raw.getUTCHours() === 0 && raw.getUTCMinutes() === 0 && raw.getUTCSeconds() === 0 ? raw.toISOString().slice(0, 10) : localDateString(raw, tzName);
  const s = String(raw).trim();
  const dateOnly = s.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnly) return dateOnly[1];
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i);
  if (iso) {
    const zone = iso[3];
    if (!zone) return iso[1]; // zone-less: a local wall-clock stamp
    if (!/^(Z|[+-]00(?::?00)?)$/i.test(zone)) return iso[1]; // explicit local offset
    if (/^0?0:00(?::00(?:\.0+)?)?$/.test(iso[2])) return iso[1]; // midnight UTC = a date-only value
    const hhmmss = iso[2].replace(/^(\d):/, '0$1:');
    return localDateString(new Date(`${iso[1]}T${hhmmss.length === 5 ? hhmmss + ':00' : hhmmss}Z`), tzName);
  }
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.getUTCHours() === 0 && parsed.getUTCMinutes() === 0 && parsed.getUTCSeconds() === 0 ? parsed.toISOString().slice(0, 10) : localDateString(parsed, tzName);
}

/**
 * For the older normalizeExtractedDate copies that take the first YYYY-MM-DD in a string: returns the
 * publisher-local date for a zoned ISO stamp, and the input untouched for anything else.
 */
function localizeIsoStamp(raw, url, opts) {
  if (typeof raw !== 'string' || !/^\s*\d{4}-\d{2}-\d{2}[T ]/.test(raw)) return raw;
  return publishedStampToLocalDate(raw, url, opts) || raw;
}

module.exports = { localDateString, publishedStampToLocalDate, localizeIsoStamp, tzForUrl, tzForMarket, NY, LONDON };
