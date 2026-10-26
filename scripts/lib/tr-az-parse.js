/**
 * Theatre Record "A-Z of productions running in London" parser (BRO-6268).
 *
 * Every 2009-2016 issue PDF ends with an A-Z listing of London productions:
 *   TITLE IN CAPS  <type> ...; opened dd.mm.yy (pNNN)      (open-ended run)
 *   TITLE IN CAPS  <type> ...; season dd.mm-dd.mm.yy       (limited run)
 * pdftotext -layout interleaves its columns, so this parses the -raw reading
 * order and returns title, type and date strings only; the venue comes from the
 * Theatre Record production lookup (resolve-we-unlisted-tr.js), never from here.
 */
'use strict';

const TYPE = '(?:New (?:musical|play|piece|adaptation|show|production|opera|comedy|version|translation|dance piece|cabaret|work|staging)|Revival of|Transfer of|UK premiere|World premiere|European premiere|London premiere|Musical|Return of|Restaging of|Adaptation|Play)';
const ENTRY = new RegExp(`(?:^|\\s)((?:THE |A |AN )?[A-Z0-9][A-Z0-9'’:!?&.,\\-/()\\s]{1,70}?)\\s+(${TYPE})\\b`, 'g');
const DATE = '\\d{2}\\.\\d{2}\\.\\d{2}';

function azSection(text) {
  const t = String(text || '');
  const i = t.search(/A-Z of productions running in/i);
  return i < 0 ? '' : t.slice(i);
}

function cleanTitle(s) {
  // leading date/year tokens belong to the previous entry ("...closes 01.11.15 KINKY BOOTS", "13 October 2015 BEAUTIFUL")
  let t = String(s || '').replace(/\s+/g, ' ').replace(/^[^A-Z0-9]+/, '').trim();
  while (/^(?:\d{2}\.\d{2}(?:\.\d{2})?-*|\d{2}-\d{2}\.\d{2}\.\d{2}|(?:19|20)\d{2})\s/.test(t)) t = t.replace(/^\S+\s+/, '');
  return t;
}

function parseAzEntries(text) {
  const sec = azSection(text).replace(/\s+/g, ' ');
  const hits = [];
  let m;
  ENTRY.lastIndex = 0;
  while ((m = ENTRY.exec(sec))) {
    const title = cleanTitle(m[1]);
    if (title.length < 3 || !/[A-Z]{3}/.test(title) || /^(BOX OFFICE|PRESS CONTACT|THEATRE|OPENS PRESS)$/.test(title)) continue;
    hits.push({ title, type: m[2], at: m.index, end: m.index + m[0].length });
  }
  return hits.map((h, i) => {
    const body = sec.slice(h.end, i + 1 < hits.length ? hits[i + 1].end : sec.length).slice(0, 400);
    const opened = (body.match(new RegExp(`opened(?: [A-Z][A-Za-z' ]{2,22})? (${DATE})`)) || [])[1] || null;
    const season = (body.match(new RegExp(`season ?(\\d{2}(?:\\.\\d{2})?) ?-+ ?(${DATE})`)) || []);
    const closes = (body.match(new RegExp(`close[sd] ?(${DATE})`)) || [])[1] || null;
    const page = (body.match(/\(p(\d{2,4})\)/) || [])[1] || null;
    return { title: h.title, type: h.type, opened, seasonFrom: season[1] || null, seasonTo: season[2] || null, closes, page };
  });
}

module.exports = { azSection, parseAzEntries, cleanTitle };
