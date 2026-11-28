'use strict';

// venue-write-guard-ok: parsed venue is audit/candidate input only; promote-historical-we.js writes it through sanitizeVenueForWrite.

/**
 * Official London Theatre (SOLT) show pages, as archived by the Wayback
 * Machine (BRO-6343). Pre-2017 officiallondontheatre.co.uk show pages
 * (/london-shows/show/item<N>/<slug>) carry a dated <dl>:
 *
 *   <dt>Genre</dt><dd>Play</dd>
 *   <dt>Previews from</dt><dd>16.10.2008</dd>
 *   <dt>Opening night</dt><dd>21.10.2008</dd>
 *   <dt>Closing</dt><dd>24.01.2009</dd>
 *
 * and the venue as the <h2> of the #venue tab. This is the dated West End
 * listing for seasons the WhatsOnStage REST listings no longer cover
 * (WOS lost its pre-mid-2016 archive). Pure parsing only: no fetching.
 */

const { decodeHtmlEntities } = require('./text-cleaning');

const text = s => decodeHtmlEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

const MINOR_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

/**
 * Later (2015+) show pages put the running time inside the <h1> ("Funny Girl
 * Duration 2h30", "... Duration Part One: 2h40 / Part Two: 2h35"), and OLT
 * capitalises every word ("The End Of Longing"). Minor words go lower case
 * except first, last and after a colon, dash, ! or ? ("Showstopper! The
 * Improvised Musical").
 */
function cleanOltTitle(t) {
  const words = String(t || '').replace(/\s+Duration\b.*$/i, '').trim().split(/\s+/).filter(Boolean);
  return words.map((w, i) => {
    const afterBreak = i > 0 && /[:!?\u2013\u2014-]$/.test(words[i - 1]);
    return i > 0 && i < words.length - 1 && !afterBreak && MINOR_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w;
  }).join(' ');
}

/** "21.10.2008" -> "2008-10-21"; anything else -> null. */
function oltDate(s) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // Reject 31.02 and friends.
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
}

/** <dt>Label</dt><dd>value</dd> pairs, label lowercased. */
function definitionPairs(html) {
  const out = {};
  const re = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
  let m;
  while ((m = re.exec(html))) {
    const k = text(m[1]).toLowerCase();
    if (k && !(k in out)) out[k] = text(m[2]);
  }
  return out;
}

/**
 * @param {string} html raw (id_) snapshot of an OLT show page
 * @returns {{title: string, venue: string|null, genre: string|null, previewsStartDate: string|null,
 *            openingDate: string|null, closingDate: string|null}|null} null when it is not a show page
 */
function parseOltShowPage(html) {
  const s = String(html || '');
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(s);
  const og = /<meta\s+property="og:title"\s+content="([^"]*)"/i.exec(s);
  const title = cleanOltTitle(text(h1 ? h1[1] : og ? og[1] : ''));
  if (!title) return null;
  const pairs = definitionPairs(s);
  if (!('opening night' in pairs) && !('closing' in pairs) && !('previews from' in pairs)) return null;
  const venueTab = /id="venue"[^>]*>\s*<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(s);
  return {
    title,
    venue: venueTab ? text(venueTab[1]) || null : null,
    genre: pairs.genre || null,
    previewsStartDate: oltDate(pairs['previews from']),
    openingDate: oltDate(pairs['opening night']),
    closingDate: oltDate(pairs.closing),
  };
}

/** "…/london-shows/show/item101870/piaf" -> "101870". */
function oltItemId(url) {
  const m = /\/london-shows\/show\/(?:interactive-map\/)?item(\d+)/i.exec(String(url || ''));
  return m ? m[1] : null;
}

module.exports = { parseOltShowPage, oltDate, oltItemId, cleanOltTitle };
