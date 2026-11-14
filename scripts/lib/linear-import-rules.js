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
// Diacritic folding for label normalisation — see normalizeLabelName below for
// why stripping non-ASCII without folding first defeats the function's purpose.
const { foldDiacritics } = require('./title-match');

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
 * Is this mirror task already represented on the Linear board? A hit on
 * EITHER identity key counts — see BRO-2468.
 *
 *   - `mapping[task.id]` — the legacy JSON (data/linear-import-mapping.json),
 *     keyed on the LOCAL MIRROR task id. That id is not stable: the mirror
 *     RENUMBERS it on resync (measured: Notion page 39c637c5-…a6b8 was taskId
 *     53 when it was imported as BRO-29, and came back as taskId 1884, which
 *     the mapping had never seen — so it was imported again as BRO-2399).
 *   - `pageIdIndex.has(notionId)` — the append-only pageId ledger
 *     (data/linear-import-mapping.jsonl, via import-ledger.js's
 *     indexByPageId()), keyed on the Notion page id. That id never changes,
 *     so it is the identity to prefer.
 *
 * A legacy row whose page id could not be recovered (see migrateLegacy()'s
 * `unresolved`) has no pageId to check and falls back to the taskId hit
 * alone — unchanged behaviour for that carve-out.
 *
 * `pageIdIndex` is whatever import-ledger.js's indexByPageId() returns (a Map)
 * or any object exposing a compatible `.has(id)`.
 */
function isAlreadyImported(task, notionId, mapping, pageIdIndex) {
  if (mapping[task.id]) return true;
  if (notionId && pageIdIndex && pageIdIndex.has(notionId)) return true;
  return false;
}

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

// ───────────────────────────────────────────────────────────────────────────
// Sprint 3: importing from the CORPUS rather than the local mirror.
//
// The mirror holds 460 files. The un-Done Notion backlog is 1,949 pages
// (measured off the Sprint 2 corpus 2026-08-17, not quoted from the plan —
// the plan's 1,831 predates several days of board growth). So a mirror-sourced
// import cannot see ~three quarters of what Sprint 3 exists to migrate, and no
// amount of fixing the dedupe changes that. Everything below classifies a
// CORPUS record; the mirror rules above are untouched and still drive
// --reconcile.
// ───────────────────────────────────────────────────────────────────────────

// A fixed namespace UUID for "a Linear issue minted from a Notion page". Its
// only requirement is that it never changes: the whole point is that the same
// pageId yields the same issue id on every run, forever.
//
// Randomly generated once, then frozen. Do NOT regenerate it — a new namespace
// silently makes every previously-imported card look un-imported, and a replay
// would then duplicate all 1,949 into a board with no bulk delete.
const NOTION_ISSUE_NAMESPACE = '6f1a7d9c-3b52-4e18-9a24-8c0f5d6e7b31';

/**
 * A DETERMINISTIC UUID, formatted as version 4.
 *
 * READ THIS BEFORE CHANGING THE VERSION NIBBLE. The sprint plan and the Sprint 3
 * handoff both specify UUIDv5 here, and both are wrong against the real API.
 * Measured live on 2026-08-18, the issue-create mutation rejects a v5 id outright:
 *
 *   constraints: { isUuid: "id must be a UUID" }
 *   userPresentableMessage: "id must be a UUID."
 *
 * with the very same request succeeding when the only change is a v4 id.
 * Linear's validator accepts v4 and nothing else, so a correct v5 UUID cannot
 * be used no matter how well it is derived.
 *
 * What Sprint 3 actually needs from this value is DETERMINISM, not randomness:
 * the same Notion page must always produce the same issue id. So the bytes come
 * from SHA-256 over (namespace, name) exactly as a name-based UUID would, and
 * only the six version/variant bits are stamped to v4 so the value survives
 * validation. It is a hash wearing a v4 costume, deliberately, and the tests
 * assert both halves: same input -> same id, and the id passes as v4.
 *
 * SHA-256 rather than SHA-1 because nothing here needs RFC 4122 §4.3 byte
 * compatibility — the version is already a lie, so there is no interop to
 * preserve, and no reason to reach for the weaker hash. 122 free bits make
 * collision across 1,949 pages unreachable.
 */
function deterministicUuidV4(name, namespace = NOTION_ISSUE_NAMESPACE) {
  const crypto = require('node:crypto');
  const hex = String(namespace).replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`bad UUID namespace: ${namespace}`);
  const nsBytes = Buffer.from(hex, 'hex');
  const hash = crypto.createHash('sha256').update(Buffer.concat([nsBytes, Buffer.from(String(name), 'utf8')])).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4 — required by Linear's isUuid validator
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const s = b.toString('hex');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/**
 * The deterministic Linear issue id for a Notion page.
 *
 * THIS IS THE THING THAT MAKES THE BULK WRITE SAFE, though not by the mechanism
 * the plan describes. Measured live on 2026-08-18, replaying a create with an
 * id that already exists does NOT silently no-op — it fails with a specific,
 * recognisable 400:
 *
 *   code: INPUT_ERROR
 *   "Entity Issue with id 2edea22f-… already exists."
 *
 * That is still exactly the guarantee Sprint 3 needs, and arguably a better one:
 * the duplicate is refused BY THE SERVER, loudly, instead of being created. The
 * importer's job is therefore to classify that one error as "already imported"
 * and continue — see isAlreadyExistsError() — rather than to assume silence.
 *
 * Two independent facts make this load-bearing:
 *
 *   1. S3-T3 deletes the exact-title dedupe, which was the importer's ONLY
 *      duplicate guard. It had to go — 28 titles are shared by 69 distinct
 *      un-Done cards, so title-dedupe silently collapses 41 real cards — but
 *      removing it without this leaves the board unprotected.
 *   2. scripts/lib/linear-retry-policy.js deliberately refuses to retry
 *      mutations on 5xx (S1-T1), because a replayed create cannot be assumed
 *      safe. A deterministic id is what makes the replay safe: it either
 *      creates the issue the ambiguous attempt never created, or it comes back
 *      as the conflict above. That, and only that, is what lets the importer
 *      opt into retryMutationsOn5xx.
 *
 * `kind` keeps the two sources in separate id spaces. A mirror task with no
 * [notion:] marker still needs a stable key, and hashing its task id under the
 * same namespace as a pageId would let the two collide in principle.
 */
function deriveIssueId(key, kind = 'notion-page') {
  if (!key) return null;
  return deterministicUuidV4(`${kind}:${key}`);
}

/**
 * Is this the "an issue with that id already exists" conflict?
 *
 * The importer treats it as SUCCESS (the card is on the board, which is the
 * post-condition it wanted) rather than as a failure. Matched on the stable
 * parts — the INPUT_ERROR code plus the "already exists" phrasing — and never
 * on the message alone, so an unrelated INPUT_ERROR (a bad stateId, a malformed
 * title) still aborts the run the way it should.
 */
function isAlreadyExistsError(err) {
  const errors = (err && err.linearErrors) || [];
  for (const e of errors) {
    const ext = (e && e.extensions) || {};
    const msg = `${e.message || ''} ${ext.userPresentableMessage || ''}`;
    if (ext.code === 'INPUT_ERROR' && /already exists/i.test(msg)) return true;
    if (/conflict on insert/i.test(e.message || '')) return true;
  }
  return false;
}

// Notion Status -> Linear workflow state name, for corpus records. Distinct
// from mapStatusToLinearState above, which speaks the local mirror's
// vocabulary ('pending'/'in_progress'); these are the board's own values.
function mapNotionStatusToLinearState(status) {
  return String(status || '').trim() === 'In progress' ? 'In Progress' : 'Backlog';
}

// The label every archived card carries, so the owner can find the whole
// migrated backlog with one filter.
const ARCHIVE_LABEL = 'notion-archive';
// Stamped by --rollback (S3-T7b) on everything it cancels.
const ROLLBACK_LABEL = 'import-rollback';

/**
 * Notion Tags are free text typed by many sessions over months. Linear label
 * names are compared exactly, so without normalisation "Opening Night",
 * "opening night" and "opening-night" become three labels for one idea.
 * Returns null for anything that cannot be a useful label.
 */
function normalizeLabelName(tag) {
  const s = foldDiacritics(String(tag || ''))
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    // Fold FIRST (above), then strip. Stripping non-ASCII without folding turns
    // "café" into "caf" while "cafe" stays "cafe" — two labels for one idea,
    // which is the exact problem this function exists to prevent. Caught by
    // tests/unit/sibling-matchers-diacritics.test.mjs, which fails CLOSED on any
    // scripts/lib file carrying the shred signature with no fold.
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  if (!s || s.length < 2 || s.length > 40) return null;
  return s;
}

function recordTags(record) {
  const raw = (record && record.properties && record.properties.Tags) || '';
  if (Array.isArray(raw)) return raw;
  // The corpus flattens multi-selects to a comma-separated string.
  return String(raw).split(/\s*,\s*/);
}

/**
 * The single disposition for one corpus record. EXACTLY one of:
 *
 *   {disposition:'live',    reason:'live'}       -> created open, in a workstream project
 *   {disposition:'archive', reason:'archive'}    -> created Canceled + notion-archive
 *   {disposition:'skip',    reason:'<named>'}    -> not created at all
 *
 * S3-T6's acceptance criterion is that created + skipped-with-reason + archived
 * equals the page total with ZERO cards in an unlabelled "other" bucket, which
 * is only checkable if every path out of this function is named. There is no
 * default return — the last branch is the archive branch, deliberately, since
 * "we could not tell" must land on the non-dispatchable side.
 */
function classifyCorpusRecord(record) {
  const props = (record && record.properties) || {};
  const title = String(props.Name || '').trim();
  const status = String(props.Status || '').trim();

  // Checked first so the reason names the real cause: a Done card is finished
  // work regardless of what its title looks like.
  if (status === 'Done') return { disposition: 'skip', reason: 'notion_done', title, status };
  if (!title) return { disposition: 'skip', reason: 'blank_title', title, status };

  const noise = classifyNoise(title);
  if (noise) return { disposition: 'skip', reason: `noise:${noise}`, title, status };

  const priority = props.Priority || '';
  const tier = normalizePriorityTier(priority);
  const labels = [...new Set(recordTags(record).map(normalizeLabelName).filter(Boolean))];
  const base = {
    title,
    status,
    priority,
    tier,
    labels,
    linearPriority: mapPriorityToLinear(priority),
    stateName: mapNotionStatusToLinearState(status),
    project: classifyProject(title),
  };

  if (isLivePriorityTier(priority)) return { ...base, disposition: 'live', reason: 'live' };
  return { ...base, disposition: 'archive', reason: 'archive', project: 'Archive' };
}

module.exports = {
  ARCHIVE_IDLE_DAYS,
  ARCHIVE_LABEL,
  ROLLBACK_LABEL,
  NOTION_ISSUE_NAMESPACE,
  deterministicUuidV4,
  deriveIssueId,
  isAlreadyExistsError,
  isAlreadyImported,
  mapNotionStatusToLinearState,
  normalizeLabelName,
  recordTags,
  classifyCorpusRecord,
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
