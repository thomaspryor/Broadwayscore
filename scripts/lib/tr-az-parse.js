/**
 * Theatre Record "A-Z of productions running in London" parser (BRO-6268, BRO-6298).
 *
 * Every 2009-2016 issue PDF ends with an A-Z listing of the London productions
 * running. The probe (probe-tr-scanned.js @dump:<issue>:azraw) prints that
 * section as positioned text lines, `AZL|issue|page|xMin|yMin|xMax|text`, from
 * pdftotext -bbox-layout. Positions are what make it parseable: -raw and
 * -layout interleave the two column halves and the venue, box-office and press
 * columns, which glued phone numbers and dates into titles.
 *
 * Two layouts exist:
 *   2015 (to about issue 162 of 2016): two column halves per page. Each half has
 *     a description column ("TITLE <type> ...; opened dd.mm.yy (pNNN)" or
 *     "...; season dd.mm-dd.mm.yy") at the left edge, then venue, box office and
 *     press columns that this parser ignores (the venue comes from the Theatre
 *     Record production lookup).
 *   2016 (about issue 163 on): a table, one row per production:
 *     "TITLE - description" | venue | opened "dd Mon yy" | vol/pp | press.
 *
 * Output is titles, types, venues and date strings only, never prose.
 */
// venue-write-guard-ok: reads Theatre Record A-Z text and builds audit lookups; nothing here writes shows.json
'use strict';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DASH = /^[-–—]+$/;

function parseAzLine(s) {
  const m = String(s || '').match(/^AZL\|([^|]*)\|(\d+)\|(-?\d+)\|(-?\d+)\|(-?\d+)\|(.*)$/);
  if (!m) return null;
  return { issue: m[1], page: Number(m[2]), x: Number(m[3]), y: Number(m[4]), x2: Number(m[5]), text: m[6].replace(/\s+/g, ' ').trim() };
}

function parseAzText(text) {
  return String(text || '').split('\n').map(parseAzLine).filter(Boolean);
}

function iso(y, mo, d) {
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCMonth() !== mo - 1) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function year2(yy) { return Number(yy) <= 40 ? 2000 + Number(yy) : 1900 + Number(yy); }

/** "03.11.15" -> 2015-11-03; null when it does not parse as a real date. */
function dmy(s) {
  const m = String(s || '').match(/^(\d{1,2})\.(\d{2})\.(\d{2})$/);
  return m ? iso(year2(m[3]), Number(m[2]), Number(m[1])) : null;
}

/** "28 Jun 16" -> 2016-06-28. */
function dMonY(s) {
  const m = String(s || '').match(/^(\d{1,2}) ([A-Z][a-z]{2})[a-z]* (\d{2})$/);
  return m && MONTHS[m[2].toLowerCase()] ? iso(year2(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1])) : null;
}

/** "London at 10 November 2015" -> 2015-11-10. */
function asAtDate(lines) {
  for (const l of lines) {
    const m = l.text.match(/\bat (\d{1,2}) ([A-Z][a-z]+) (\d{4})/);
    if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return iso(Number(m[3]), MONTHS[m[2].slice(0, 3).toLowerCase()], Number(m[1]));
  }
  return null;
}

/** "THE BODYGUARD" style: TR files a leading article after the comma ("BODYGUARD, THE"). */
function fixArticle(t) {
  const m = t.match(/^(.+?),\s*(THE|A|AN)$/);
  return m ? `${m[2]} ${m[1]}` : t;
}

function cleanTitle(t) {
  return fixArticle(String(t || '').replace(/\s+/g, ' ').replace(/(\s*[-–—]+)+\s*$/, '').replace(/[,:;]+$/, '').trim());
}

// OCR sometimes lowercases a letter inside a caps word (TATtOOED): not a description word
const hasLower = tok => /[a-z]/.test(tok) && !/^[A-Z]{2,}[a-z]{1,2}[A-Z]+[^a-z]*$/.test(tok);

/**
 * Leading ALL-CAPS token run of a line: { caps: [tokens], rest: [tokens] }.
 * Dash tokens inside the run belong to the title (BEAUTIFUL - THE CAROLE KING
 * MUSICAL); the run ends at the first token with a lowercase letter.
 */
function splitCaps(text) {
  const toks = String(text || '').split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < toks.length && !hasLower(toks[i])) i++;
  return { caps: toks.slice(0, i), rest: toks.slice(i) };
}

/** A real title run: not "T S" (initials of a name in a continuation line), at least 3 letters/digits. */
function plausibleCaps(caps) {
  const body = caps.filter(t => !DASH.test(t));
  if (!body.length) return false;
  const chars = body.join('').replace(/[^A-Z0-9]/g, '');
  return chars.length >= 3 && body.some(t => t.replace(/[^A-Z0-9]/g, '').length >= 2);
}

function typeOf(rest) {
  const r = String(rest || '').toLowerCase().replace(/1/g, 'i');
  if (/^re[vi]{1,2}[iv]?al/.test(r) || /^rev\w{0,2}val/.test(r)) return 'Revival';
  if (/^trans\s?fer/.test(r)) return 'Transfer';
  if (/^return/.test(r)) return 'Return';
  if (/^new\b/.test(r)) return 'New';
  if (/^(uk|world|european|london) premi/.test(r)) return 'Premiere';
  return null;
}

function fixSpacedDates(body) {
  return body.replace(/(\d)\.\s+(\d)/g, '$1.$2').replace(/(\d)\s+\.(\d)/g, '$1.$2').replace(/(\d{2}\.\d{2}\.\d{2})\.(?=\D|$)/g, '$1');
}

/** Dates in a 2015-layout entry body; each is an ISO string or null. */
function bodyDates(bodyRaw) {
  const body = fixSpacedDates(bodyRaw);
  const out = { opened: null, seasonFrom: null, seasonTo: null, closes: null, page: null };
  const op = body.match(/opened(?: [A-Z][A-Za-z' ]{2,22}?)? (\d{1,2}\.\d{2}\.\d{2})\b/);
  if (op) out.opened = dmy(op[1]);
  const full = body.match(/season ?(\d{1,2}\.\d{2}\.\d{2}) ?-{1,2} ?(\d{1,2}\.\d{2}\.\d{2})/);
  const part = body.match(/season ?(\d{1,2}(?:\.\d{2})?) ?-{1,2} ?(\d{1,2}\.\d{2}\.\d{2})/);
  if (full) {
    out.seasonFrom = dmy(full[1]);
    out.seasonTo = dmy(full[2]);
  } else if (part) {
    out.seasonTo = dmy(part[2]);
    if (out.seasonTo) {
      const [ty, tm] = out.seasonTo.split('-').map(Number);
      const f = part[1].split('.');
      const fd = Number(f[0]);
      const fm = f[1] ? Number(f[1]) : tm;
      out.seasonFrom = iso(fm > tm ? ty - 1 : ty, fm, fd);
    }
  }
  const cl = body.match(/close[sd] ?(\d{1,2}\.\d{2}\.\d{2})/);
  if (cl) out.closes = dmy(cl[1]);
  const pg = body.match(/\(p(\d{2,4})\)/);
  if (pg) out.page = pg[1];
  return out;
}

/** True when a page line closes the A-Z section (the future-schedule page follows it). */
const isSectionEnd = l => /^future london schedule\b/i.test(l.text);

/** Split a page's lines into A-Z pages (from the marker up to the future schedule). */
function azPages(lines) {
  const out = new Map();
  let ended = false;
  for (const l of lines) {
    if (ended) break;
    if (isSectionEnd(l) && l.y < 200) { ended = true; break; }
    if (!out.has(l.page)) out.set(l.page, []);
    out.get(l.page).push(l);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
}

function parse2015(pages, asAt) {
  const entries = [];
  const stream = [];
  for (const pl of pages) {
    const body = pl.filter(l => l.y >= 60 && l.y <= 808 && l.text);
    const left = body.filter(l => l.x < 120).sort((a, b) => a.y - b.y || a.x - b.x);
    const right = body.filter(l => l.x >= 280 && l.x <= 340).sort((a, b) => a.y - b.y || a.x - b.x);
    stream.push(...left, ...right);
  }
  let cur = null;
  let pendingCaps = null;
  const flush = () => { if (cur) entries.push(cur); cur = null; };
  for (const l of stream) {
    const { caps, rest } = splitCaps(l.text);
    if (!rest.length && caps.length >= 2 && /[A-Z]{3}/.test(l.text) && !/^(BOX OFFICE|PRESS CONTACT)$/.test(l.text)) {
      // a title wrapped before its type word ("...THE NIGHT-" / "TIME Transfer of ...")
      pendingCaps = l.text;
      continue;
    }
    // a wrapped "23.09.07; New Ambassadors" is the current entry's date, never a new title (BRO-6343)
    if (caps.length && rest.length && /^[A-Z]/.test(rest[0]) && !/^\d{1,2}\.\d{2}\.\d{2}\b/.test(caps[0]) && (plausibleCaps(caps) || (pendingCaps && caps.length))) {
      flush();
      let title = caps.join(' ');
      if (pendingCaps) title = /-$/.test(pendingCaps) ? pendingCaps + title : `${pendingCaps} ${title}`;
      cur = { title: cleanTitle(title), type: typeOf(rest.join(' ')), venue: null, body: rest.join(' ') };
      pendingCaps = null;
      continue;
    }
    pendingCaps = null;
    if (cur) cur.body += ` ${l.text}`;
  }
  flush();
  return entries.map(e => {
    const d = bodyDates(e.body.slice(0, 500));
    // an A-Z date after the issue's own date is a misread year (opened 03.11.16 in a Nov 2015 issue)
    for (const k of ['opened', 'seasonFrom', 'seasonTo', 'closes']) if (d[k] && asAt && k === 'opened' && d[k] > asAt) d[k] = null;
    return { title: e.title, type: e.type, venue: null, ...d };
  });
}

/**
 * Title from the x<320 fragments sharing a row's y. pdftotext splits a row into
 * fragments and wrapped description lines of neighbouring entries share the
 * same y ("Levy. MISERABLES", "a YOUNG"), so the title is chained from the
 * caps runs in input order: a fragment contributes its leading caps run (after
 * skipping one stray lowercase token), and the chain ends at the first
 * fragment with description text after its caps.
 */
function titleFromFragments(frags) {
  let caps = [];
  let rest = [];
  for (const f of frags.slice(0, 5)) {
    let toks = f.text.split(/\s+/).filter(Boolean);
    // ...but a capitalised word before bare digits is the title itself ("Circusfest 2016 – Incl. ..." is no title "2016";
    // a wrapped "a" before "1984 – New adaptation" is still stray)
    const titleWordBeforeDigits = /^[A-Z][a-z]{3,}$/.test(toks[0] || '') && /^\d+$/.test(toks[1] || '');
    if (toks.length && hasLower(toks[0]) && toks.length > 1 && !hasLower(toks[1]) && !titleWordBeforeDigits) toks = toks.slice(1);
    const sc = splitCaps(toks.join(' '));
    if (!sc.caps.length || !plausibleCaps(sc.caps) && !/^\d/.test(sc.caps[0])) continue;
    caps = caps.concat(sc.caps);
    rest = sc.rest;
    if (rest.length) break;
  }
  return caps.length ? { caps, rest } : null;
}

function parse2016(pages) {
  const entries = [];
  for (const pl of pages) {
    const body = pl.filter(l => l.y >= 55 && l.y <= 815 && l.text);
    const venueLines = body.filter(l => l.x >= 320 && l.x < 345).sort((a, b) => a.y - b.y);
    let prev = null;
    for (const v of venueLines) {
      const near = body.filter(l => Math.abs(l.y - v.y) <= 3);
      const frags = near.filter(l => l.x < 320);
      if (!frags.length) {
        // second line of a venue name ("Royal Court Theatre" / "Upstairs")
        if (prev && v.y - prev.y <= 14 && !/^\d/.test(v.text)) prev.entry.venue = `${prev.entry.venue} ${v.text}`.trim();
        continue;
      }
      const t = titleFromFragments(frags);
      if (!t) continue;
      const { caps, rest } = t;
      const sameRowRight = near.filter(l => l.x >= 320).sort((a, b) => a.x - b.x).map(l => l.text).join(' ');
      let venue = near.filter(l => l.x >= 320 && l.x < 395).sort((a, b) => a.x - b.x).map(l => l.text).join(' ');
      venue = venue.replace(/\s*\b\d{1,2} [A-Z][a-z]{2} \d{2}\b.*$/, '').replace(/\s+\d{2}\/\d+.*$/, '').trim();
      let openedText = null;
      const dm = venue.match(/\s*(\d{1,2} [A-Z][a-z]{2} \d{2})$/);
      if (dm) { openedText = dm[1]; venue = venue.slice(0, dm.index).trim(); }
      if (!openedText) {
        const od = near.find(l => l.x >= 395 && l.x < 460 && /^\d{1,2} [A-Z][a-z]{2} \d{2}\b/.test(l.text));
        if (od) openedText = od.text.match(/^\d{1,2} [A-Z][a-z]{2} \d{2}/)[0];
      }
      if (!openedText) { const m = sameRowRight.match(/\b(\d{1,2} [A-Z][a-z]{2} \d{2})\b/); if (m) openedText = m[1]; }
      const entry = { title: cleanTitle(caps.join(' ').toUpperCase()), type: typeOf(rest.filter(t => !DASH.test(t)).join(' ')), venue, opened: dMonY(openedText), seasonFrom: null, seasonTo: null, closes: null, page: null };
      entries.push(entry);
      prev = { y: v.y, entry };
    }
  }
  return entries;
}

/**
 * Positioned A-Z lines (one issue) -> { format, asAt, entries }.
 * @param {Array<{issue:string,page:number,x:number,y:number,x2:number,text:string}>} lines
 */
const AZ_MARKER = /^A\s*[-–]\s*Z of productions running in\b/i;
const MARKER_X = 34; // the marker's x on a standard A-Z page (fixtures 170, 929)
const MARKER_Y = { 2015: 40, 2016: 17 }; // ...and its y on a standard 2015 / 2016 page

/**
 * Some issues print the A-Z shifted right (159: every column +125) or as the
 * right half of a two-page spread (163: x from 632, the regional future
 * schedule on the left half); 159 also sits 175pt lower. Shift each page so its columns sit where the
 * layout parsers expect them, and drop the other half of a spread. The shift
 * comes from the marker line and carries over to the pages that follow it.
 * Standard pages (marker within 60pt of x=34) are left untouched (BRO-6343).
 */
function alignAzColumns(lines, format = 2015) {
  const byPage = new Map();
  for (const l of lines) { if (!byPage.has(l.page)) byPage.set(l.page, []); byPage.get(l.page).push(l); }
  const out = [];
  let shift = 0;
  let down = 0;
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const pl = byPage.get(page);
    const marker = pl.find(l => AZ_MARKER.test(l.text));
    if (marker) {
      shift = marker.x - MARKER_X > 60 ? marker.x - MARKER_X : 0;
      down = marker.y - MARKER_Y[format] > 60 ? marker.y - MARKER_Y[format] : 0;
    }
    if (!shift && !down) { out.push(...pl); continue; }
    const leftEdge = shift ? MARKER_X + shift - 15 : -Infinity;
    // a carried shift fits only a page laid out like its marker page: a standard-width continuation keeps its own columns
    if (!marker && shift && !pl.some(l => !isSectionEnd(l) && Math.abs(l.x - (MARKER_X + shift)) <= 15)) { out.push(...pl); continue; }
    // the section-end heading is kept wherever it sits (163 prints it on the dropped left half of the next spread)
    for (const l of pl) if (l.x >= leftEdge || isSectionEnd(l)) out.push({ ...l, x: l.x - shift, x2: l.x2 - shift, y: l.y - down });
  }
  return out;
}

function parseAzLines(lines) {
  // overlapping dumps repeat positioned lines; each one counts once
  const seenLine = new Set();
  const unique = lines.filter(l => { const k = `${l.page}|${l.x}|${l.y}|${l.text}`; if (seenLine.has(k)) return false; seenLine.add(k); return true; });
  const is2016 = unique.some(l => /^OPENED VOL\/pp/i.test(l.text));
  const pages = azPages(alignAzColumns(unique, is2016 ? 2016 : 2015));
  const flat = pages.flat();
  const asAt = asAtDate(flat);
  const entries = is2016 ? parse2016(pages) : parse2015(pages, asAt);
  // a wrapped dd.mm.yy date is no title ("23.09.07"; "1984" and "946" are); a page printed twice (163) lists each row twice
  const seen = new Set();
  const kept = entries.filter(e => e.title && e.title.length >= 3 && !/^\d{1,2}\.\d{2}\.\d{2}$/.test(e.title)).filter(e => {
    const k = JSON.stringify(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { format: is2016 ? 2016 : 2015, asAt, entries: kept };
}

module.exports = { alignAzColumns, parseAzLine, parseAzText, parseAzLines, bodyDates, dmy, dMonY, splitCaps, typeOf, cleanTitle };
