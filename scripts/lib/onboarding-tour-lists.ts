/**
 * Quiz onboarding lists for US and Canada touring cities (BRO-6734). Pure: the
 * generator (scripts/generate-onboarding-data.ts) passes every input in.
 *
 * Before this, a touring-city pick got New York content: the Seen grid used
 * Broadway's hit list (or, for Chicago, four local posters), and the Want grid
 * offered NYC productions. Now each touring city gets:
 *   - seen: the tours that have played there in the window, biggest first (by
 *     the title's Broadway run), then its local hits, at least two full rows;
 *   - want: tours with a stop there still to come, soonest first, then its
 *     open local shows;
 *   - stops: how many tour engagements it has had or has booked, so the city
 *     picker can put the most-visited cities first.
 * Nothing is invented: every row is a real tour stop or a real production.
 */

export interface TourStopIn { city: string; venue?: string; start: string; end: string }
export interface TourIn {
  id: string;
  title: string;
  /** 'open' | 'closed' | 'upcoming' | ... ; a closed tour is still a tour people saw. */
  status: string;
  /** The tour's own Critic Score, when it has one. */
  score: number | null;
  stops: TourStopIn[];
}
/** The art and size of a title's Broadway (or West End) run, looked up by normalised title. */
export interface TitleArt { poster: string; showId: string; days: number }
export interface HitRow {
  title: string;
  showId: string;
  poster: string;
  days: number;
  score: number | null;
  productions: { showId: string; opened: string | null; closed: string | null; label?: string }[];
  /** The Broadway production whose art (and scores, on the value screen) stand in for a tour. */
  broadwayId?: string;
}
export interface WantRow {
  showId: string;
  title: string;
  poster: string;
  score: number | null;
  category: string;
  /** "Mar 3 to 15, 2027 · Boston Opera House" or a local venue. */
  note: string | null;
}

export const SEEN_MIN = 8; // two full rows of four
export const SEEN_TOP = 16;
export const WANT_TOP = 24;
export const LOCAL_RESERVE = 4;
export const WANT_MIN = 6;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const md = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

/** "Mar 3 to 15, 2027", "Mar 28 to Apr 4, 2027", "Dec 30, 2026 to Jan 4, 2027". No en dashes (owner style). */
export function stopDates(start: string, end: string): string {
  const ys = start.slice(0, 4);
  const ye = end.slice(0, 4);
  if (start === end) return `${md(start)}, ${ys}`;
  if (ys !== ye) return `${md(start)}, ${ys} to ${md(end)}, ${ye}`;
  if (start.slice(0, 7) === end.slice(0, 7)) return `${md(start)} to ${Number(end.slice(8, 10))}, ${ye}`;
  return `${md(start)} to ${md(end)}, ${ye}`;
}

export interface CityListsInput {
  cityName: string;
  tours: readonly TourIn[];
  art: (title: string) => TitleArt | null;
  /** Posters that are a landscape image padded with blur (look low-res in a grid). */
  badPoster: (poster: string) => boolean;
  /** The city's own productions (Chicago), already ranked; may be empty. */
  localSeen?: readonly HitRow[];
  localWant?: readonly WantRow[];
  /** National biggest tours, used only to top Seen up to two full rows. */
  topUp?: readonly HitRow[];
  today: string;
  windowStart: string;
}

const yearOf = (d: string) => d.slice(0, 4);

export function cityLists(i: CityListsInput): { seen: HitRow[]; want: WantRow[]; stops: number } {
  const here = (t: TourIn) => t.stops.filter(s => s.city === i.cityName);
  // Every engagement in the window or booked ahead counts toward "most visited".
  const stops = i.tours.reduce((n, t) => n + here(t).filter(s => s.end >= i.windowStart).length, 0);

  // Seen: tours with a stop here that has started, grouped by title (Beetlejuice toured twice).
  const byTitle = new Map<string, { title: string; tours: { t: TourIn; first: string; last: string; venue: string | null }[] }>();
  for (const t of i.tours) {
    const played = here(t).filter(s => s.start <= i.today && s.end >= i.windowStart);
    if (played.length === 0) continue;
    const first = played.reduce((m, s) => (s.start < m ? s.start : m), played[0].start);
    const last = played.reduce((m, s) => (s.end > m ? s.end : m), played[0].end);
    const key = t.title.toLowerCase();
    const g = byTitle.get(key) ?? { title: t.title, tours: [] };
    g.tours.push({ t, first, last, venue: played[played.length - 1].venue ?? null });
    byTitle.set(key, g);
  }
  const tourSeen: HitRow[] = [];
  for (const g of byTitle.values()) {
    const a = i.art(g.title);
    if (!a || i.badPoster(a.poster)) continue;
    g.tours.sort((x, y) => x.first.localeCompare(y.first));
    const lead = g.tours[g.tours.length - 1];
    tourSeen.push({
      title: g.title,
      showId: lead.t.id,
      poster: a.poster,
      days: a.days,
      score: lead.t.score,
      broadwayId: a.showId,
      productions: g.tours.map(x => ({
        showId: x.t.id,
        opened: x.first,
        closed: x.last > i.today ? null : x.last,
        label: yearOf(x.first) === yearOf(x.last) ? `The tour in ${yearOf(x.first)}` : `The tour in ${yearOf(x.first)} to ${yearOf(x.last)}`,
      })),
    });
  }
  tourSeen.sort((x, y) => y.days - x.days || (y.score ?? 0) - (x.score ?? 0) || x.title.localeCompare(y.title));

  const seen: HitRow[] = [];
  const titles = new Set<string>();
  const add = (r: HitRow) => {
    const k = r.title.toLowerCase();
    if (titles.has(k) || i.badPoster(r.poster) || seen.length >= SEEN_TOP) return;
    titles.add(k);
    seen.push(r);
  };
  // A city with its own productions (Chicago) keeps a row for its biggest local hits.
  const local = (i.localSeen ?? []).filter(r => !i.badPoster(r.poster));
  const reserve = Math.min(LOCAL_RESERVE, local.length);
  tourSeen.slice(0, SEEN_TOP - reserve).forEach(add);
  local.forEach(add);
  if (seen.length < SEEN_MIN) (i.topUp ?? []).forEach(r => { if (seen.length < SEEN_MIN) add(r); });

  // Want: a stop here still to come (or playing now), soonest first; then local shows.
  const wantTours: (WantRow & { start: string })[] = [];
  for (const t of i.tours) {
    const ahead = here(t).filter(s => s.end >= i.today).sort((a, b) => a.start.localeCompare(b.start))[0];
    if (!ahead) continue;
    const a = i.art(t.title);
    if (!a || i.badPoster(a.poster)) continue;
    wantTours.push({
      showId: t.id, title: t.title, poster: a.poster, score: t.score, category: 'tour', start: ahead.start,
      note: [stopDates(ahead.start, ahead.end), ahead.venue].filter(Boolean).join(' · '),
    });
  }
  wantTours.sort((x, y) => x.start.localeCompare(y.start) || x.title.localeCompare(y.title));
  const want: WantRow[] = [];
  const wantIds = new Set<string>();
  for (const w of [...wantTours.map(({ start: _s, ...r }) => r), ...(i.localWant ?? [])]) {
    if (wantIds.has(w.showId) || i.badPoster(w.poster) || want.length >= WANT_TOP) continue;
    wantIds.add(w.showId);
    want.push(w);
  }
  // A small city with only a few bookings: top up to two full rows of three with tours on the
  // road now, labelled as such. Longer lists are trimmed to full rows by the app.
  if (want.length < WANT_MIN) {
    const road = [...i.tours]
      .filter(t => t.stops.some(s => s.end >= i.today) && !wantIds.has(t.id))
      .map(t => ({ t, a: i.art(t.title) }))
      .filter(x => x.a && !i.badPoster(x.a.poster))
      .sort((x, y) => y.a!.days - x.a!.days || x.t.title.localeCompare(y.t.title));
    const titlesIn = new Set(want.map(w => w.title.toLowerCase()));
    for (const { t, a } of road) {
      if (want.length >= WANT_MIN) break;
      if (titlesIn.has(t.title.toLowerCase())) continue;
      titlesIn.add(t.title.toLowerCase());
      want.push({ showId: t.id, title: t.title, poster: a!.poster, score: t.score, category: 'tour', note: `On tour, not booked in ${i.cityName.replace(/,.*$/, '')} yet` });
    }
  }
  return { seen, want, stops };
}

/** The biggest tours of the window nationally (most cities), for topping up a small city. */
export function nationalTopTours(i: Omit<CityListsInput, 'cityName' | 'localSeen' | 'localWant' | 'topUp'>): HitRow[] {
  const rows: HitRow[] = [];
  const seenTitles = new Set<string>();
  const ranked = [...i.tours]
    .map(t => ({ t, a: i.art(t.title), cities: new Set(t.stops.filter(s => s.start <= i.today && s.end >= i.windowStart).map(s => s.city)).size }))
    .filter(x => x.a && x.cities > 0 && !i.badPoster(x.a.poster))
    .sort((x, y) => y.a!.days - x.a!.days || y.cities - x.cities);
  for (const { t, a } of ranked) {
    const k = t.title.toLowerCase();
    if (seenTitles.has(k)) continue;
    seenTitles.add(k);
    rows.push({
      title: t.title, showId: t.id, poster: a!.poster, days: a!.days, score: t.score, broadwayId: a!.showId,
      productions: [{ showId: t.id, opened: t.stops[0]?.start ?? null, closed: t.status === 'closed' ? (t.stops[t.stops.length - 1]?.end ?? null) : null }],
    });
    if (rows.length >= SEEN_TOP) break;
  }
  return rows;
}

/**
 * Letterbox check (BRO-6734). Small Chicago art is composed onto a 480x720
 * poster as the art fitted inside, over a blurred copy of itself
 * (scripts/tic-make-images.js). Square art leaves thin blurred bands and reads
 * fine; landscape art (Iceboy) leaves a thin strip of picture between two big
 * blurred bands and looks low-res in a grid. A blurred row has almost no
 * pixel-to-pixel change, so count such rows from the top and from the bottom:
 * when both bands cover at least LETTERBOX_BAND of the height, drop the poster.
 * `gray` is the full-size poster, one byte per pixel, row by row.
 */
export const LETTERBOX_BAND = 0.2;
export function isLetterboxed(gray: Uint8Array, w: number, h: number): boolean {
  const flat = (y: number) => {
    let sum = 0;
    for (let x = 1; x < w; x++) sum += Math.abs(gray[y * w + x] - gray[y * w + x - 1]);
    return sum / (w - 1) < 1;
  };
  let top = 0;
  while (top < h && flat(top)) top++;
  let bottom = 0;
  while (bottom < h && flat(h - 1 - bottom)) bottom++;
  return Math.min(top, bottom) >= LETTERBOX_BAND * h;
}
