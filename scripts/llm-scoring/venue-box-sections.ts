/**
 * Venue-box sections (BRO-5294).
 *
 * Teachout's (and other critics') WSJ drama columns review two or three shows.
 * Each review carries a production box: "<Theatre>, <address> ($lo-$hi),
 * <phone>, closes <date>". When the stored fullText is the whole column, the
 * scorer read every show's verdict (the-nance-2013, act-one-2014, ...).
 *
 * Deterministic and conservative: find the one box naming the target show's
 * theatre, take the stretch of text next to that box (or box cluster) that
 * names the show clearly more often, and refuse whenever the choice is
 * ambiguous or another boxed show is named 2+ times in it. A refusal means the
 * caller scores the full text, as before.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface VenueShow { id: string; title: string; venue?: string | null; openingDate?: string | null }
export interface VenueBoxResult { ok: boolean; text?: string; reason: string; boxes: number }

const PRICE = /\(\$\s?\d[\d.,]*(?:\s?[-–]\s?\$?\d[\d.,]*)?\)/g;
const TAIL = /^(?:,?\s*\d{3}[-.]\d{3}[-.]\d{4}(?:\s*\/\s*\d{3}[-.]\d{3}[-.]\d{4})*)?(?:,?\s*(?:closes|extended|open-ended|through)(?:[^.\n]|\.(?=\s*\d)){0,30}?(?:\d{4}|\d{1,2}\b))?/;
const ADDRESS = /\b\d{1,4}\s+(?:[NSEW]\.?\s+)?[\w.']+(?:\s+[\w.']+)?\s+(?:St|Street|Ave|Avenue|Blvd|Road|Rd|Place|Pl|Square|Broadway)\b\.?,?\s*(?:[A-Z][\w.' ]{0,40},?\s*)?$/;
const CLUSTER_GAP = 300;
const MIN_SECTION = 800;

interface Box { start: number; end: number; lead: string }

export function findPriceBoxes(text: string): Box[] {
  const out: Box[] = [];
  for (const m of text.matchAll(PRICE)) {
    const idx = m.index ?? 0;
    let end = idx + m[0].length;
    const tail = TAIL.exec(text.slice(end));
    if (tail) end += tail[0].length;
    // A production box carries a phone number / run dates after the price, or
    // a street address before it; a bare "($299)" in the prose is not a box.
    const hasTail = !!(tail && tail[0].trim().length >= 6);
    const hasAddress = ADDRESS.test(text.slice(Math.max(0, idx - 60), idx));
    if (!hasTail && !hasAddress) continue;
    // The box begins after the sentence before it ends; the 90 chars before
    // the price hold the theatre name either way (used for venue matching).
    const windowStart = Math.max(0, idx - 120);
    const before = text.slice(windowStart, idx);
    let cut = -1;
    for (const m2 of before.matchAll(/[.!?…”"’)]\s+/g)) cut = (m2.index ?? 0) + m2[0].length;
    const start = cut >= 0 ? windowStart + cut : windowStart;
    out.push({ start, end, lead: text.slice(Math.max(0, idx - 90), idx).toLowerCase() });
  }
  return out;
}

// venue-write-guard-ok: reads a show's venue to match it against a review's production box; never writes a venue.
function venueWords(venue: string | null | undefined): string[] {
  return String(venue || '').toLowerCase()
    .replace(/\b(the|theat(?:re|er))\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter(Boolean);
}

function hasWord(hay: string, w: string): boolean {
  return new RegExp(`(?<![a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(hay);
}

function boxNamesVenue(box: Box, words: string[]): boolean {
  // Whole words only ("54" must not match "W. 54th St."), and at least one
  // word longer than 3 chars so a venue never matches on "in" or a number.
  if (!words.length || !words.some(w => w.length > 3)) return false;
  if (words.every(w => hasWord(box.lead, w))) return true;
  // "Golden Theatre" for "John Golden Theatre": allow dropping a first name.
  const rest = words.slice(1);
  return words.length >= 2 && rest.some(w => w.length > 3) && rest.every(w => hasWord(box.lead, w));
}

export function titleVariants(title: string): string[] {
  const l = title.toLowerCase().replace(/[’‘]/g, "'");
  const v = new Set<string>([l]);
  if (l.includes(':')) v.add(l.split(':')[0].trim());
  for (const x of [...v]) {
    v.add(x.replace(/\s*[-:]?\s*the musical$/, '').trim());
    v.add(x.replace(/^the gershwins' /, ''));
  }
  return [...v].filter(x => x.length >= 4);
}

function mentions(text: string, title: string): number {
  // Whole words only: "Rent" must not count inside "different" (BRO-5261).
  const lower = text.toLowerCase().replace(/[’‘]/g, "'");
  return Math.max(0, ...titleVariants(title).map(v =>
    (lower.match(new RegExp(`(?<![a-z0-9])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'g')) || []).length));
}

function days(a?: string | null, b?: string | null): number {
  const x = Date.parse(String(a || '').slice(0, 10)); const y = Date.parse(String(b || '').slice(0, 10));
  return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) / 86400000 : Infinity;
}

/**
 * The next show's photo caption, photo credit and theatre/address lines sit on
 * short lines right before its box (act-one-2014 ended with "Chris O'Dowd ...
 * in 'Of Mice and Men.' / Richard Phibbs / Longacre Theatre, 220 W. 48th St.").
 * Only lines that look like a caption, a photo credit or a box line go (at
 * most 4), so a short closing verdict ("Don't miss it.") or hard-wrapped
 * prose stays.
 */
const CAPTION = /\b(?:left|right|center|centre|top|above|below)\b.{0,80}\bin\s+['"“‘]|\bin\s+['"“‘][^'"”’]{2,60}\.?['"”’]\s*$/i;
const ADDRESS_LINE = /\b\d{1,4}\s+(?:[NSEW]\.?\s+)?[\w.']+(?:\s+[\w.']+)?\s+(?:St|Street|Ave|Avenue|Blvd|Place|Pl|Square|Broadway)\b\.?,?\s*$|^[^.!?]*\b(?:Theat(?:re|er)|Playhouse|Stages?|Company|Center|Club|Hall|Studio)\b[^.!?]*,?\s*$/;
function isCaptionOrBoxLine(line: string): boolean {
  const l = line.trim();
  if (!l || l.length >= 100) return false;
  if (CAPTION.test(l) || ADDRESS_LINE.test(l)) return true;
  // A photo credit: a short bare name, up to 4 words, no sentence punctuation.
  return l.length <= 40 && !/[.!?:;"“”]/.test(l.replace(/\b[A-Z]\./g, '')) && l.split(/\s+/).length <= 4 && /^[A-Z]/.test(l);
}

export function dropTrailingShortLines(section: string): string {
  const lines = section.split('\n');
  let dropped = 0;
  for (;;) {
    while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length <= 1 || dropped >= 4 || !isCaptionOrBoxLine(lines[lines.length - 1])) break;
    lines.pop(); dropped++;
  }
  return lines.join('\n').trim();
}

/** Pure: the target show's section of a multi-review column, or a refusal. */
export function extractVenueBoxSection(text: string, target: VenueShow, allShows: VenueShow[]): VenueBoxResult {
  const boxes = findPriceBoxes(text || '');
  if (boxes.length < 2) return { ok: false, reason: 'fewer than 2 production boxes', boxes: boxes.length };
  const words = venueWords(target.venue);
  const hits = boxes.map((b, i) => (boxNamesVenue(b, words) ? i : -1)).filter(i => i >= 0);
  if (hits.length !== 1) return { ok: false, reason: `target venue matches ${hits.length} boxes`, boxes: boxes.length };

  const clusters: number[][] = [[0]];
  for (let i = 1; i < boxes.length; i++) {
    if (boxes[i].start - boxes[i - 1].end < CLUSTER_GAP) clusters[clusters.length - 1].push(i);
    else clusters.push([i]);
  }
  const ci = clusters.findIndex(c => c.includes(hits[0]));
  const startOf = (k: number) => boxes[clusters[k][0]].start;
  const endOf = (k: number) => boxes[clusters[k][clusters[k].length - 1]].end;
  const before = text.slice(ci > 0 ? endOf(ci - 1) : 0, startOf(ci));
  const after = text.slice(endOf(ci), ci + 1 < clusters.length ? startOf(ci + 1) : text.length);
  const mb = mentions(before, target.title); const ma = mentions(after, target.title);
  // Boxes clustered between reviews: the first box belongs to the review before
  // the cluster. The text after a cluster can hold several reviews (one per
  // later box), possibly of shows we do not list, so it is never taken.
  // A cluster of boxes can sit in the MIDDLE of a review that continues after
  // it (master-class-2011, a-free-man-of-color-2010, waiting-for-godot-2009),
  // so neither side is known to be the whole review: refuse.
  if (clusters[ci].length > 1) {
    return { ok: false, reason: 'target box inside a box cluster (layout ambiguous)', boxes: boxes.length };
  }
  const [best, bm, om] = ma > mb ? [after, ma, mb] : [before, mb, ma];
  if (bm < 2 || bm <= om || best.trim().length < MIN_SECTION) {
    return { ok: false, reason: `ambiguous section (mentions ${mb} before / ${ma} after)`, boxes: boxes.length };
  }
  // Other boxed shows: same-season productions at the other boxes' theatres.
  for (let i = 0; i < boxes.length; i++) {
    if (i === hits[0]) continue;
    for (const s of allShows) {
      if (s.id === target.id || days(s.openingDate, target.openingDate) > 60) continue;
      if (boxNamesVenue(boxes[i], venueWords(s.venue)) && mentions(best, s.title) >= 2) {
        return { ok: false, reason: `section also names boxed show "${s.title}"`, boxes: boxes.length };
      }
    }
  }
  const section = dropTrailingShortLines(best.trim());
  if (section.length < MIN_SECTION) return { ok: false, reason: 'section too short after dropping caption lines', boxes: boxes.length };
  return { ok: true, text: section, reason: `venue-box section (${boxes.length} boxes)`, boxes: boxes.length };
}

let cachedShows: VenueShow[] | null = null;
function loadShows(): VenueShow[] {
  if (cachedShows) return cachedShows;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/shows.json'), 'utf-8'));
    cachedShows = (raw.shows || raw) as VenueShow[];
  } catch { cachedShows = []; }
  return cachedShows;
}

/** extractVenueBoxSection against data/shows.json. */
export function extractVenueBoxSectionForShowId(text: string, showId: string): VenueBoxResult {
  const shows = loadShows();
  const target = shows.find(s => s.id === showId);
  if (!target) return { ok: false, reason: 'unknown show', boxes: 0 };
  return extractVenueBoxSection(text, target, shows);
}
