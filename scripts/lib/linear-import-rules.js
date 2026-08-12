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
const PRIORITY_RE = /\b(P0 Now|P1 Next|P2 Later)\b/;

function extractNotionId(description) {
  const m = NOTION_ID_RE.exec(description || '');
  return m ? m[1] : null;
}

function extractPriorityTag(description) {
  const m = PRIORITY_RE.exec(description || '');
  return m ? m[1] : null;
}

// Linear issue priority is an Int: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
const PRIORITY_MAP = { 'P0 Now': 1, 'P1 Next': 2, 'P2 Later': 3 };
function mapPriorityToLinear(priorityTag) {
  return PRIORITY_MAP[priorityTag] || 4; // else -> Low, per card instructions
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
  mapPriorityToLinear,
  mapStatusToLinearState,
  classifyNoise,
  classifyProject,
  NOISE_RULES,
  PROJECT_RULES,
};
