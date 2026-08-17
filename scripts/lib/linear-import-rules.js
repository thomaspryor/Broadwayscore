/**
 * Pure decision functions for scripts/linear-import.js. No I/O, no Linear/Notion
 * calls — importer requires() this and the tests do the same, so a rule change
 * that breaks curation shows up as a failing test, not a silent drift in what
 * gets imported.
 */

// Every local task mirror record's description carries a line like:
//   "[notion:3b2637c5-...] P1 Next · Not started · Product\nhttps://..."
// but the tag is not always the first line — zombie-sweep re-opens and other
// prefixes push it down, so search the whole description, not just line 1.
const NOTION_ID_RE = /\[notion:([a-f0-9-]+)\]/;

// EVERY Priority value the brain board can hold. Not a guess and not a sample:
// read straight off the data source schema's select options on 2026-08-17
// (`dataSources.retrieve` → properties.Priority.select.options), which is the
// complete vocabulary whether or not a card currently uses each one.
//
// There are 26, not the 17 the sprint plan assumed, and three of them do not
// behave like priorities at all:
//   * 'Done'  — a status accidentally set in the Priority column. It carries NO
//               priority information, so it must not silently become Low.
//   * 'P9'    — nonsense-tier, used as "never".
//   * 'High'/'Medium'/'Low' — Linear's own vocabulary, from sessions that
//               reached for Linear names while filing into Notion.
//
// This matters because Sprint 3 routes on the TIER: P0/P1 import live, P2/P3
// import Canceled + notion-archive. A legacy spelling that fails to normalise
// silently lands in the wrong half of that split.
const PRIORITY_SPELLINGS = [
  'P0 Now', 'P0 Urgent', 'P0',
  'P1 Next', 'P1 Now', 'P1 Soon', 'P1',
  'P2 Later', 'P2 Soon', 'P2 Next', 'P2 Future', 'P2 Backlog', 'P2',
  'P3 Backlog', 'P3 Low', 'P3 Eventually', 'P3 Someday', 'P3 Future', 'P3 Later', 'P3',
  'P4', 'P9',
  'High', 'Medium', 'Low',
  'Done',
];

// Longest-first so 'P1 Next' wins over the bare 'P1' prefix, and escaped
// because the vocabulary is data. Deliberately NOT a loose /P\d/ pattern: this
// runs over free-text mirror descriptions, where "P1" appears inside prose
// ("the P1 backlog") and a loose match would invent a priority from a mention.
const PRIORITY_RE = new RegExp(
  `\\b(${[...PRIORITY_SPELLINGS]
    .sort((a, b) => b.length - a.length)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\b`
);

function extractNotionId(description) {
  const m = NOTION_ID_RE.exec(description || '');
  return m ? m[1] : null;
}

function extractPriorityTag(description) {
  const m = PRIORITY_RE.exec(description || '');
  return m ? m[1] : null;
}

/**
 * Collapse any legacy spelling to its TIER: 'P0' | 'P1' | 'P2' | 'P3' | null.
 * null means "this card carries no usable priority", which is a real answer —
 * `Done` in the Priority column and an empty Priority are both that.
 *
 * Import-time only. Nothing here is ever written back to Notion: normalising a
 * board that is being deleted would corrupt the Sprint 2 corpus (the archive is
 * supposed to record what was actually there) for no benefit.
 */
function normalizePriorityTier(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^done$/i.test(s)) return null; // a status in the priority column
  const m = /^p(\d)\b/i.exec(s);
  if (m) {
    const n = Number(m[1]);
    if (n <= 2) return `P${n}`;
    return 'P3'; // P3, P4 and P9 are all "bottom of the pile"
  }
  if (/^high$/i.test(s)) return 'P1';
  if (/^medium$/i.test(s)) return 'P2';
  if (/^low$/i.test(s)) return 'P3';
  return null;
}

// Linear issue priority is an Int: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
const TIER_TO_LINEAR = { P0: 1, P1: 2, P2: 3, P3: 4 };

/**
 * Accepts any legacy spelling, not just the three canonical ones.
 *
 * A card with no usable priority maps to 0 (No priority) rather than 4 (Low).
 * The old behaviour returned Low for everything unrecognised, which asserted
 * something the data never said — and once 1,831 cards land on the board, "Low"
 * and "we don't know" are the difference between a triageable backlog and a
 * uniformly-grey one.
 */
function mapPriorityToLinear(priorityTag) {
  const tier = normalizePriorityTier(priorityTag);
  return tier ? TIER_TO_LINEAR[tier] : 0;
}

// The Sprint 3 split: P0/P1 import live into their workstream project, P2/P3
// import Canceled + `notion-archive` (searchable, not dispatchable). A card
// with no usable priority is NOT live work — routing an unprioritised card into
// the dispatchable half is how the invisible backlog gets recreated.
function isLivePriorityTier(raw) {
  const tier = normalizePriorityTier(raw);
  return tier === 'P0' || tier === 'P1';
}

// Local mirror status -> Linear workflow state name. in_progress cards keep
// their state; everything else (pending, and any unrecognized value) lands in
// Backlog rather than Todo, since Backlog is the "not yet started, not yet
// triaged" bucket that matches an unattended import.
function mapStatusToLinearState(localStatus) {
  return localStatus === 'in_progress' ? 'In Progress' : 'Backlog';
}

// Noise categories: recurring auto-generated alert/report cards that are not
// real backlog work. Never imported (not even to Archive) — creating a Linear
// issue for each daily digest re-run would just recreate the noise this
// migration exists to escape. Order matters only in that each check is
// independent; a title can only match one bucket in practice.
const NOISE_RULES = [
  { key: 'bsc_daily', test: (s) => s.startsWith('BSC Daily:') },
  {
    key: 'rage_ux',
    test: (s) => /^rage click/i.test(s) || /\brage click/i.test(s) || s.startsWith('UX audit:'),
  },
  {
    key: 't1t2_alert',
    test: (s) =>
      /^T1\/T2 (silent gap|review stuck)/.test(s) || /T1(\/T2)? Coverage alert/i.test(s),
  },
  { key: 'missing_show', test: (s) => s.startsWith('Missing show:') },
  { key: 'email_triage', test: (s) => /^\[em-\d/.test(s) },
  {
    // Cards about the session/dispatch fleet this very migration retires.
    // Importing "fix the dispatcher" work into the system replacing the
    // dispatcher is a contradiction, so these are excluded, not archived.
    key: 'fleet_selfref',
    test: (s) => {
      const low = s.toLowerCase();
      const kws = [
        'session-system v',
        'dispatch-dead',
        'dispatch dead',
        'duplicate-dispatch',
        'session/pm system',
        'cmux ',
        '2-death dispatch cap',
        'dispatch outcomes:',
        'dispatch ledger',
        'linear migration',
      ];
      // NOT 'push-with-retry': the migration retires the dispatcher, not git.
      // push-with-retry.sh is the shared push primitive every data workflow
      // depends on, and its two open cards are production bugs where a push
      // reported success while nothing reached origin (#959, #1279). Excluding
      // them as "fleet" drops real data-loss work on the floor.
      return kws.some((k) => low.includes(k));
    },
  },
];

function classifyNoise(subject) {
  const s = (subject || '').trim();
  for (const rule of NOISE_RULES) {
    if (rule.test(s)) return rule.key;
  }
  return null;
}

// Workstream projects every imported issue is filed under. Checked in order —
// most specific signal first — since a title can plausibly match more than
// one bare keyword (e.g. "iOS" showing up inside an unrelated sentence).
const PROJECT_RULES = [
  { name: 'iOS', test: (s) => /\biOS\b|testflight|iphone app|broadwayscorecard-app/i.test(s) },
  {
    name: 'Commercial',
    test: (s) =>
      /\bcommercial\b|recoupment|beat the critics|todaytix|impact network|licensing|affiliate/i.test(
        s
      ),
  },
  {
    name: 'Opening night',
    test: (s) =>
      /opening.night|t1\/t2|silent gap|review stuck|\bserp\b|\bcensus\b|opening-night/i.test(s),
  },
  {
    // Distribution keywords must carry distribution INTENT. The first draft of
    // this rule used a bare /reddit/, which pulled the audience-buzz
    // "cross-production Reddit contamination" data-quality sweep into
    // Marketing; a bare /post\b/ (tried and rejected) matched "post-rebase".
    // Verified against the real 200-card mirror, not reasoned about.
    name: 'Marketing/distribution',
    test: (s) =>
      /\br\/[a-z]|reddit (post|launch|distribution|rollout)|\bon reddit\b|newsletter subscriber|instagram|threads\b|linkedin|social media|starter posts|forbes|pitch kit|\bseo\b|search console|outreach|volunteers|cross-promo|\bmentor\b/i.test(
        s
      ),
  },
  {
    // User-facing site work. Without this stream it all lands in the
    // Infrastructure catch-all, which is how that project ended up holding
    // 122 of 257 issues on the first import — a dumping ground, not a stream.
    // (?<!clear_) keeps CLEAR_BREADCRUMBS (a scoring-flag audit constant) out.
    name: 'Site & product',
    test: (s) =>
      /show hero|show page|homepage|browse page|watchlist|\bdiary\b|(?<!clear_)breadcrumb|hoverratestars|stats engine|show stats|tag conflict|redesign/i.test(
        s
      ),
  },
  {
    name: 'Scoring quality',
    test: (s) =>
      // contamination/audience-buzz added 2026-08-12: the audience-buzz
      // title-collision sweep is corpus data quality, and without them it fell
      // through every rule into the Infrastructure catch-all.
      /scor(e|ing)|review.?guard|wrongproduction|wrongshow|duplicate.?of|anchored|ensemble|llm.?scor|content.quality|rebuild-all-reviews|contamination|audience.?buzz/i.test(
        s
      ),
  },
  {
    name: 'Coverage pipeline',
    test: (s) =>
      /coverage|discovery|scrape|scraper|extractor|outlet|byline|aggregator|gather-reviews|review.text/i.test(
        s
      ),
  },
];

function classifyProject(subject) {
  const s = subject || '';
  for (const rule of PROJECT_RULES) {
    if (rule.test(s)) return rule.name;
  }
  return 'Infrastructure'; // catch-all: CI, hooks, health-checks, misc plumbing
}

// Idle cutoff, in days since the Notion card was last edited, past which a
// PENDING card routes to Archive instead of its workstream.
//
// The card's original rule was "pending P2-Later, 30+ days idle". Measured
// against the live mirror on 2026-08-12 that matches ZERO records: the mirror
// holds only 14 P2s (it syncs P0/P1 + in-progress) and none of them are stale,
// so the rule could never move the 259-item import toward the plan's 120-150
// target. Idle time across ALL pending priorities is the signal that actually
// exists in the data. 12 days is where the distribution splits: 64 cards share
// a single bulk-edit date at exactly 12d, and everything fresher is genuinely
// active work. Nothing is deleted — Archive is one filter away.
const ARCHIVE_IDLE_DAYS = 12;

/**
 * @param {string} localStatus  mirror status ('pending' | 'in_progress' | ...)
 * @param {number|null} ageDays days since the Notion card was last edited
 * @param {number} [idleDays]   cutoff, defaults to ARCHIVE_IDLE_DAYS
 * @returns {boolean} true when this card belongs in Archive, not a workstream
 */
function isIdleArchive(localStatus, ageDays, idleDays = ARCHIVE_IDLE_DAYS) {
  // in_progress is live work by definition — someone is holding it right now,
  // and a stale Notion edit time says nothing about that.
  if (localStatus !== 'pending') return false;
  return typeof ageDays === 'number' && ageDays >= idleDays;
}

module.exports = {
  ARCHIVE_IDLE_DAYS,
  isIdleArchive,
  extractNotionId,
  extractPriorityTag,
  PRIORITY_SPELLINGS,
  normalizePriorityTier,
  isLivePriorityTier,
  mapPriorityToLinear,
  mapStatusToLinearState,
  classifyNoise,
  classifyProject,
  NOISE_RULES,
  PROJECT_RULES,
};
