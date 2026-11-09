'use strict';

/**
 * Venues whose own site is the best key-art source for a local production, but that are
 * NOT feeder venues (REGIONAL_FEEDER_VENUES also steers how aggregator candidates are
 * classified, which this must not change). Image sourcing only (BRO-6771).
 */
const { foldDiacritics } = require('./title-match');
const slug = (t) => foldDiacritics(String(t || '')).toLowerCase().replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const IMAGE_ONLY_VENUES = [
  {
    re: /\bsignature theat(?:re|er)\b/i, city: 'Arlington, VA', domain: 'sigtheatre.org', sample: 'Signature Theatre, Arlington, VA',
    // Signature files every production under its season (Jul-Jun); a search engine often misses past ones.
    pageUrls: (show) => {
      const d = String(show.openingDate || '');
      const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
      if (!y || !m) return [];
      const start = m >= 7 ? y : y - 1;
      return [`https://www.sigtheatre.org/shows-and-events/all-events/${start}-${start + 1}/${slug(show.title)}`];
    },
    // A missing page still answers with the building photo as og:image: never art for a show.
    genericImage: /Sig_Building/i,
  },
  // Venues behind imageless scored UK/Chicago/DC rows (audit 2026-11-03). Each is a plain
  // "site:<domain> <title>" search: a wrong or dead domain only yields no hit and the generic
  // chain runs as before. Anchored so a bare name cannot capture another venue.
  { re: /^home\b(?:,|\s*$)/i, city: 'Manchester, UK', domain: 'homemcr.org', sample: 'HOME, Manchester' },
  { re: /\boctagon theat(?:re|er)\b/i, city: 'Bolton, UK', domain: 'octagonbolton.co.uk', sample: 'Octagon Theatre, Bolton' },
  { re: /^(?:egg theat(?:re|er)|ustinov)\b/i, city: 'Bath, UK', domain: 'theatreroyal.org.uk', sample: 'Egg Theatre, Bath' },
  { re: /\ba red orchid theat(?:re|er)\b/i, city: 'Chicago, IL', domain: 'aredorchidtheatre.org', sample: 'A Red Orchid Theatre, Chicago, IL' },
  { re: /\bfilament theat(?:re|er)\b/i, city: 'Chicago, IL', domain: 'filamenttheatre.org', sample: 'Filament Theatre, Chicago, IL' },
  { re: /\bfactory theat(?:re|er)\b/i, city: 'Chicago, IL', domain: 'thefactorytheater.com', sample: 'Factory Theater, Chicago, IL' },
  { re: /\btheat(?:re|er) wit\b/i, city: 'Chicago, IL', domain: 'theaterwit.org', sample: 'Theater Wit, Chicago, IL' },
  { re: /\bgreenhouse theat(?:re|er)\b/i, city: 'Chicago, IL', domain: 'greenhousetheater.org', sample: 'The Greenhouse Theater Center, Chicago, IL' },
  // Northlight Theatre plays at The Skokie (North Shore Center).
  { re: /^the skokie\b/i, city: 'Skokie, IL', domain: 'northlight.org', sample: 'The Skokie, Skokie, IL' },
  { re: /\bkeegan theat(?:re|er)\b/i, city: 'Washington, DC', domain: 'keegantheatre.com', sample: 'Keegan Theatre, Washington, DC' },
  { re: /\batlas performing arts\b/i, city: 'Washington, DC', domain: 'atlasarts.org', sample: 'Atlas Performing Arts Center, Washington, DC' },
  { re: /\bsilver spring stage\b/i, city: 'Silver Spring, MD', domain: 'ssstage.org', sample: 'Silver Spring Stage, Silver Spring, MD' },
];

function imageOnlyVenue(venue) {
  return IMAGE_ONLY_VENUES.find((v) => v.re.test(venue || '')) || null;
}

/**
 * Feeder venues (data/uk-regional-venues.json) whose productions live on a different site than
 * the venue's own domain. Image sourcing only: the feeder `domain` stays what classification and
 * verification use (BRO-6703). Òran Mór's lunchtime plays are A Play, A Pie and A Pint
 * productions, listed at playpiepint.com/whats-on/event/<slug>/; oran-mor.co.uk has no page for
 * them, so a "site:oran-mor.co.uk Contact" search landed on the venue's Contact Us page.
 */
const FEEDER_IMAGE_SITES = [
  {
    re: /(?<![\p{L}\p{N}_])[oò]ran m[oó]r(?![\p{L}\p{N}_])/iu, domain: 'playpiepint.com', sample: 'Òran Mór, Glasgow',
    pageUrls: (show) => (slug(show.title) ? [`https://playpiepint.com/whats-on/event/${slug(show.title)}/`] : []),
  },
];

function feederImageSite(venue) {
  return FEEDER_IMAGE_SITES.find((v) => v.re.test(venue || '')) || null;
}

/**
 * A venue site's own utility page (contact, about, privacy, terms, access, the homepage). Its
 * og:image is the venue logo or building, never a production's art, and a show titled "Contact"
 * or "About" matches it in a site: search (BRO-6703).
 */
const UTILITY_PAGE_RE = /^\/(?:(?:about|about-us|visit|visiting|info|help)\/)?(?:contact(?:-us)?|about(?:-us)?|privacy(?:-policy)?|cookies?(?:-policy)?|terms[a-z-]*|accessibility|visiting-accessibility|faqs?)\/?$/i;
function isVenueUtilityPage(url) {
  let p;
  try { p = new URL(url).pathname; } catch { return false; }
  return p === '/' || p === '' || UTILITY_PAGE_RE.test(p);
}

/**
 * The page's key art: og:image, then twitter:image, then the page's hero <img> (an <img> whose
 * own class names a hero, or the first <img> inside an element whose class does). Hope Mill
 * Theatre's event pages carry no og:image at all; the show art is only in
 * <div class="content-hero"><img src=...> (BRO-6703). The caller still runs the image verifier.
 *
 * @returns {{url: string, via: 'og:image'|'twitter:image'|'hero img'}|null}
 */
function extractKeyArtImage(html, baseUrl) {
  if (!html) return null;
  const abs = (raw) => {
    try { return new URL(String(raw).replace(/&amp;/g, '&').trim(), baseUrl || undefined).href; } catch { return null; }
  };
  const meta = (prop) => {
    const m = html.match(new RegExp(`(?:property|name)="${prop}"\\s+content="([^"]+)"`, 'i'))
      || html.match(new RegExp(`content="([^"]+)"\\s+(?:property|name)="${prop}"`, 'i'));
    return m ? abs(m[1]) : null;
  };
  const og = meta('og:image');
  if (og) return { url: og, via: 'og:image' };
  const tw = meta('twitter:image');
  if (tw) return { url: tw, via: 'twitter:image' };
  const srcOf = (tag) => { const m = tag.match(/\ssrc="([^"]+)"/i); return m ? abs(m[1]) : null; };
  const ownHero = html.match(/<img\b[^>]*\bclass="[^"]*\bhero\b[^"]*"[^>]*>/i);
  const inHero = html.match(/\bclass="[^"]*\bhero\b[^"]*"[^>]*>\s*(?:<(?:picture|a)\b[^>]*>\s*(?:<source\b[^>]*>\s*)*)?(<img\b[^>]*>)/i);
  const tag = ownHero ? ownHero[0] : inHero ? inHero[1] : null;
  const url = tag && srcOf(tag);
  return url ? { url, via: 'hero img' } : null;
}

/**
 * Was a venue-page image rejected ONLY for being a stage photo? (verify-image.js rejects every
 * production still as card art.) Any other issue (wrong show, wrong production, placeholder,
 * venue photo) means the image is not this production's and must stay rejected (BRO-6703).
 */
function isOwnProductionStill(verdict) {
  return !!verdict && verdict.match === false && require('./image-source-match').isCleanProductionStill(verdict);
}

module.exports = { IMAGE_ONLY_VENUES, imageOnlyVenue, FEEDER_IMAGE_SITES, feederImageSite, isVenueUtilityPage, extractKeyArtImage, isOwnProductionStill, slug };
