'use strict';

/**
 * One Tours To You page through the whole discovery-to-create pipeline without
 * writing anything (BRO-4931): classify the page, find the candidate, decide
 * the entry. check-tour-sweep.js compares the outcome with a fixture; the same
 * functions create-tour-entries.js runs do the work, so a sweep that passes
 * says the real run would behave the same.
 *
 * Outcome classes:
 *   create                  an entry would be written
 *   suggest                 a candidate whose launch or dates cannot be confirmed (the owner is asked)
 *   needs-classification    nothing says what the page is (the owner is asked)
 *   skip-event | skip-aggregator | skip-template | skip-company   not a production
 *   skip-nothing-running    no tour running now or booked to launch
 *   skip-too-few-stops      fewer engagements than a national tour has
 *   skip-duplicate-schedule the page carries another tour's table
 *   skip-tracked            a tracked tour already covers the segment
 *   skip-no-parent          the title matches a production that had not opened yet
 *
 * Pure apart from the fetchWiki callback.
 */

const { runningTourCandidate } = require('./tour-discovery');
const { candidateParentId } = require('./tour-roundup-candidate');
const { decideTourCreation, candidateRoundupUrl } = require('./tour-create-decision');

const OUTCOME_OF_KIND = {
  event: 'skip-event',
  aggregator: 'skip-aggregator',
  template: 'skip-template',
  company: 'skip-company',
  'nothing-running': 'skip-nothing-running',
  'too-few-stops': 'skip-too-few-stops',
  tracked: 'skip-tracked',
  'no-parent': 'skip-no-parent',
};

// Outcomes that depend on the date and on what the web says today, not on how
// the page is classified: a mismatch among them may be time passing.
const EVIDENCE_OUTCOMES = new Set(['create', 'suggest', 'skip-nothing-running', 'skip-too-few-stops', 'skip-tracked', 'skip-no-parent']);

/**
 * @param {object} args
 * @param {string} args.slug
 * @param {string|null} args.pageTitle the Tours To You page title (never the URL)
 * @param {string} args.html the schedule page ('' when it could not be read)
 * @param {Array} args.shows all shows
 * @param {object} [args.overrides] loadTourPageClasses()
 * @param {object} [args.tourSchedules] data/tour-schedules.json .tours
 * @param {{has: Function}|null} [args.retiredIds]
 * @param {Date} [args.now]
 * @param {(title: string) => Promise<string>} [args.fetchWiki] Wikipedia wikitext of the article that mentions a tour (dates)
 * @param {(title: string, opts?: {requireTour?: boolean}) => Promise<{title: string, text: string}|null>} [args.fetchWikiArticle] first article that exists, for the infobox only
 * @param {object[]} [args.ledgerRows] candidate ledger rows, for pairing a BWW roundup with the page
 * @returns {Promise<{outcome: string, reason: string, entry?: object, candidate?: object, pageClass?: object}>}
 */
async function evaluateTourPage({ slug, pageTitle = null, html, shows, overrides = {}, tourSchedules = {}, retiredIds = null, now = new Date(), fetchWiki = null, ledgerRows = [], fetchWikiArticle = null }) {
  const scheduleUrl = `https://tourstoyou.org/shows/${slug}/`;
  // Discovery reads the page without Wikipedia, as discover-running-tours.js does.
  const r = runningTourCandidate({ slug, scheduleUrl, html, shows, now, pageTitle, overrides });
  if (!r.candidate) return { outcome: OUTCOME_OF_KIND[r.kind] || 'suggest', reason: r.skip, pageClass: r.pageClass };
  const c = r.candidate;
  const parentId = candidateParentId(c);
  const parent = parentId ? shows.find(s => s.id === parentId) || null : null;
  const title = parent ? parent.title : c.title;
  let wikiText = '';
  let classifyWiki = null;
  // The same two fetches create-tour-entries.js makes: the article that mentions a tour (dates), and, for a
  // page nothing classified, the first article that exists (infobox only, never dates).
  if (fetchWiki) { try { wikiText = await fetchWiki(title); } catch { wikiText = ''; } }
  if (fetchWikiArticle && c.needsClassification && !parent) { try { classifyWiki = await fetchWikiArticle(title, { requireTour: false }); } catch { classifyWiki = null; } }
  const roundupUrl = candidateRoundupUrl(c, ledgerRows);
  const d = decideTourCreation({ candidate: c, parent, shows, scheduleUrl, html, wikiText, classifyWiki, roundupUrl, retiredIds, tourSchedules, now, overrides });
  return { outcome: d.outcome, reason: d.reason, ...(d.built.entry ? { entry: d.built.entry } : {}), candidate: d.candidate || c, pageClass: d.pageClass || r.pageClass };
}

/**
 * Compare one outcome with a fixture row's expectation.
 * @param {{expect: string|string[], id?: string, parent?: string|null}} want
 * @param {{outcome: string, entry?: object}} got outcome at today's date
 * @param {{outcome: string, entry?: object}|null} gotThen outcome as of the fixture's date (null when it is today)
 * @returns {{status: 'ok'|'warn'|'fail', why: string}}
 */
function compareOutcome(want, got, gotThen = null) {
  const wanted = [].concat(want.expect);
  const detail = o => {
    if (!o.entry) return '';
    const bits = [];
    if (want.id && o.entry.id !== want.id) bits.push(`id ${o.entry.id}, expected ${want.id}`);
    if (want.parent !== undefined && (o.entry.tourOf || null) !== want.parent) bits.push(`parent ${o.entry.tourOf || 'none'}, expected ${want.parent || 'none'}`);
    return bits.join('; ');
  };
  const matches = o => wanted.includes(o.outcome) && !(wanted.includes('create') && o.outcome === 'create' && detail(o));
  if (matches(got)) return { status: 'ok', why: '' };
  // Not what was expected today. If the page gave the expected outcome on the
  // fixture's date and both outcomes depend on the date, time passing is the likely cause.
  if (gotThen && matches(gotThen) && EVIDENCE_OUTCOMES.has(got.outcome) && EVIDENCE_OUTCOMES.has(gotThen.outcome)) {
    return { status: 'warn', why: `${got.outcome} today, ${gotThen.outcome} on the fixture date: depends on today's date` };
  }
  return { status: 'fail', why: `${got.outcome}${got.reason ? ` (${String(got.reason).slice(0, 140)})` : ''}, expected ${wanted.join(' or ')}${detail(got) ? `; ${detail(got)}` : ''}` };
}

module.exports = { OUTCOME_OF_KIND, EVIDENCE_OUTCOMES, evaluateTourPage, compareOutcome };
