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
        'push-with-retry',
        'cmux ',
        '2-death dispatch cap',
        'dispatch outcomes:',
        'dispatch ledger',
        'linear migration',
      ];
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
    name: 'Marketing/distribution',
    test: (s) =>
      /reddit|newsletter|social pulse|instagram|threads\b|linkedin|forbes|pitch kit|distribution|outreach|volunteers|producer|mentor/i.test(
        s
      ),
  },
  {
    name: 'Scoring quality',
    test: (s) =>
      /scor(e|ing)|review.?guard|wrongproduction|wrongshow|duplicate.?of|anchored|ensemble|llm.?scor|content.quality|rebuild-all-reviews/i.test(
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

module.exports = {
  extractNotionId,
  extractPriorityTag,
  mapPriorityToLinear,
  mapStatusToLinearState,
  classifyNoise,
  classifyProject,
  NOISE_RULES,
  PROJECT_RULES,
};
