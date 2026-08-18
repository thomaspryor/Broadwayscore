/**
 * Minimal Linear GraphQL client. No SDK dependency — the whole surface this
 * project needs is 4 queries/mutations, and pulling in @linear/sdk for that
 * would be a bigger footprint than a fetch() wrapper.
 */

const fs = require('fs');
const path = require('path');
const { readEnvKeys } = require('./load-env');
// Query/mutation TEXT for the dispatcher's calls (getIssue/listOpenIssues/
// createComment below) lives in linear-dispatch.js as pure, no-I/O builder
// functions — so linear-next.js's tests can require() the exact strings this
// file sends over the wire instead of a second, drifting copy (CLAUDE.md rule
// 15: "never copies"). No cycle: linear-dispatch.js has zero requires back
// into this file.
const linearDispatch = require('./linear-dispatch');
// Pure 429/5xx decisions (S1-T1). Kept out of this file for the same reason
// linear-dispatch.js is: the interesting cases are unit-testable without a
// network stub only if they are pure.
const retryPolicy = require('./linear-retry-policy');

const API_URL = 'https://api.linear.app/graphql';
const TEAM_KEY = 'BRO';

function getApiKey() {
  const { LINEAR_API_KEY } = readEnvKeys(['LINEAR_API_KEY']);
  const key = process.env.LINEAR_API_KEY || LINEAR_API_KEY;
  if (!key) throw new Error('LINEAR_API_KEY not set in .env or environment');
  return key;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The one Linear transport. Every read and mutation in this file goes through
 * it, so 429/5xx handling added here is inherited by every consumer.
 *
 * Retry behaviour lives in scripts/lib/linear-retry-policy.js as pure
 * functions — see that file's header for why 5xx is NOT retried for mutations
 * (an issueCreate that got a 502 may already have been applied, and Sprint 3
 * pushes 1,831 creates through here).
 *
 * @param {string} query
 * @param {object} [variables]
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts]  total attempts including the first
 * @param {number} [opts.baseMs]       exponential backoff base
 * @param {(ms:number)=>Promise} [opts.sleepFn]  injected so tests don't wait
 * @param {(info:object)=>void} [opts.onRetry]   observability hook
 * @param {boolean} [opts.retryMutationsOn5xx]   opt-in, for idempotent callers
 * @param {number} [opts.timeoutMs]              per-attempt abort budget
 *
 * Options are INJECTED rather than read from env: that is this repo's
 * established retry shape (scripts/lib/autonomous-triage-core.js:451-455
 * fetchCardWithRetry takes {retries, delayMs, sleepFn}), and env knobs whose
 * only purpose is making a test fast outlive the test as undocumented global
 * config. The third argument is optional and additive — check-linear-cap.js
 * and every other direct graphql() caller are unaffected.
 */
async function graphql(query, variables, opts = {}) {
  const maxAttempts = Number.isInteger(opts.maxAttempts) ? opts.maxAttempts : retryPolicy.DEFAULT_MAX_ATTEMPTS;
  const sleepFn = typeof opts.sleepFn === 'function' ? opts.sleepFn : defaultSleep;
  const onRetry =
    typeof opts.onRetry === 'function'
      ? opts.onRetry
      : (info) =>
          console.error(
            `⏳ Linear HTTP ${info.status} (${info.reason}) — attempt ${info.attempt}/${info.maxAttempts}, retrying in ${info.delayMs}ms`
          );
  const mutation = opts.retryMutationsOn5xx ? false : retryPolicy.isMutation(query);
  // 30s is right for a bulk migration and far too slow for a gate hook probe:
  // the commit gate budgets ~4s per check and runs on every `git commit`
  // fleet-wide, so a hung board would cost 30s per commit rather than fail
  // open promptly. Callers that are latency-sensitive pass their own budget.
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 30_000;

  let attempt = 0;
  for (;;) {
    attempt++;
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: getApiKey() },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // A 30s AbortSignal timeout, a DNS failure or a socket reset REJECTS
      // rather than returning a response, so no status check downstream would
      // ever see it. Same partial-apply ambiguity as a 5xx, so it is gated on
      // the same `mutation` answer.
      //
      // Gated on `isMutation(query)` directly, NOT on the `mutation` variable
      // above: `retryMutationsOn5xx` is named for 5xx and means "this caller
      // made its creates idempotent (client-supplied ids), so a replayed 5xx is
      // safe". A network timeout is a different claim — the request may have
      // been applied AND the response lost — and an opt-in about HTTP status
      // codes must not silently also authorise replaying those.
      const writeOp = retryPolicy.isMutation(query);
      if (!retryPolicy.isTransientNetworkError(err) || writeOp || attempt >= maxAttempts) throw err;
      const delayMs = retryPolicy.retryDelayMs(attempt, null, { baseMs: opts.baseMs });
      onRetry({ status: err.name || 'network', reason: 'transient-network', attempt, maxAttempts, delayMs });
      await sleepFn(delayMs);
      continue;
    }

    // POSITIVE comparisons only, inside retryPolicy.isRetryableStatus. The
    // existing stubs in tests/unit/linear-client-archived-issue.test.mjs return
    // a bare `{ json }` with no `status`, `ok` or `headers` — an `!res.ok`
    // check here would route all seven of those tests down the retry path.
    if (retryPolicy.isRetryableStatus(res.status)) {
      // Parse the body even on a retryable status. Linear can return a
      // GraphQL-level error (notably USAGE_LIMIT_EXCEEDED, the free-tier cap)
      // under one, and linear-issue-create.js's isUsageLimitExceeded() reads
      // err.linearErrors — discarding the body here would make that loud cap
      // message go silent exactly during a bulk migration.
      const body = await res.json().catch(() => null);
      const verdict = retryPolicy.shouldRetry({ status: res.status, body, mutation });
      if (verdict.retry && attempt < maxAttempts) {
        const delayMs = retryPolicy.retryDelayMs(attempt, res.headers, { baseMs: opts.baseMs });
        onRetry({ status: res.status, reason: verdict.reason, attempt, maxAttempts, delayMs });
        await sleepFn(delayMs);
        continue;
      }
      // "HTTP <code>" keeps the code in STATUS POSITION, which is what the
      // fleet's transient classifier matches on
      // (autonomous-triage-core.js TRANSIENT_FETCH_ERROR_RE). A bare
      // "Linear API 429 ..." would not match and the error would be graded
      // permanent.
      const suffix = verdict.retry ? `after ${attempt} attempts` : `not retried (${verdict.reason})`;
      const graphqlDetail =
        body && Array.isArray(body.errors) && body.errors.length
          ? `: ${body.errors.map((e) => e && e.message).filter(Boolean).join('; ')}`
          : '';
      const err = new Error(`Linear API HTTP ${res.status} ${suffix}${graphqlDetail}`);
      err.status = res.status;
      err.retryable = verdict.retry;
      if (body && Array.isArray(body.errors) && body.errors.length) err.linearErrors = body.errors;
      throw err;
    }

    const json = await res.json();
    if (json.errors && json.errors.length) {
      const err = new Error(`Linear GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
      // Raw errors attached (not just flattened into the message) so callers that
      // need to branch on a specific error code — e.g. USAGE_LIMIT_EXCEEDED, the
      // free-tier 250-issue cap — don't have to string-match the human message.
      err.linearErrors = json.errors;
      throw err;
    }
    return json.data;
  }
}

async function getTeam() {
  const data = await graphql(
    `query($key: String!) {
      teams(filter: { key: { eq: $key } }) {
        nodes {
          id
          key
          states(first: 50) { nodes { id name type } }
        }
      }
    }`,
    { key: TEAM_KEY }
  );
  const team = data.teams.nodes[0];
  if (!team) throw new Error(`Team ${TEAM_KEY} not found`);
  return team;
}

async function listAllIssueTitles(teamId) {
  const titles = new Map(); // title -> identifier
  let after = null;
  for (;;) {
    const data = await graphql(
      `query($teamId: String!, $after: String) {
        team(id: $teamId) {
          issues(first: 100, after: $after) {
            nodes { identifier title }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { teamId, after }
    );
    const { nodes, pageInfo } = data.team.issues;
    for (const n of nodes) titles.set(n.title, n.identifier);
    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  return titles;
}

// Fuller read than listAllIssueTitles: --reconcile has to compare each issue's
// CURRENT project/state against what the curation says it should be, so title
// alone is not enough.
async function listIssues(teamId) {
  const issues = [];
  let after = null;
  for (;;) {
    const data = await graphql(
      `query($teamId: String!, $after: String) {
        team(id: $teamId) {
          issues(first: 100, after: $after) {
            nodes {
              id identifier title url project { name } state { name type }
              completedAt canceledAt
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { teamId, after }
    );
    const { nodes, pageInfo } = data.team.issues;
    for (const n of nodes) {
      issues.push({
        id: n.id,
        identifier: n.identifier,
        title: n.title,
        url: n.url,
        project: n.project ? n.project.name : null,
        state: n.state ? n.state.name : null,
        // stateType/completedAt/canceledAt: added for the issue-cap monitor
        // (BRO-285) to classify archive candidates without a second query —
        // additive fields, existing callers (scripts/linear-import.js) only
        // read id/identifier/title/url/project/state and are unaffected.
        stateType: n.state ? n.state.type : null,
        completedAt: n.completedAt || null,
        canceledAt: n.canceledAt || null,
      });
    }
    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  return issues;
}

// Single-issue fetch by human-readable identifier (e.g. "BRO-123") — Linear's
// `issue(id:)` field accepts either the UUID or the identifier directly, no
// team/number filter needed. Used by linear-next.js (task #1303) to seed a
// dispatch; returns null when the identifier doesn't resolve, same "caller
// checks for null" contract as this file's other read helpers.
async function getIssue(identifier) {
  const data = await graphql(linearDispatch.buildIssueQuery(), { id: identifier });
  return data.issue || null;
}

// Open (non-completed, non-canceled) issues for a team, priority-agnostic
// ordering left to the caller (linear-dispatch.js's sortIssuesByPriority) —
// this only fetches. Defaults to TEAM_KEY so callers rarely need to pass one.
// Cursor-paginated like listIssues() above: the workspace holds 200+ issues,
// so a single first:100 page silently truncates.
async function listOpenIssues(teamKey = TEAM_KEY) {
  const issues = [];
  let after = null;
  for (;;) {
    const data = await graphql(linearDispatch.buildOpenIssuesQuery(), { teamKey, after });
    const { nodes, pageInfo } = data.issues || { nodes: [], pageInfo: { hasNextPage: false } };
    issues.push(...(nodes || []));
    if (!pageInfo || !pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  return issues;
}

// Cross-system alert dedupe (Phase 0 rail 2, plan 2026-08-12, task #1341):
// does an OPEN issue in this team already carry `term` (the alert's
// conditionKey) in its title or body? Fetches the team's open issues WITH
// description (buildOpenIssuesWithDescriptionsQuery — listOpenIssues above
// omits it, since --list never renders it) and matches client-side via
// linear-dispatch.js's pure findOpenIssueForTerm — see that function's header
// for why this doesn't lean on Linear's filter DSL to do the matching.
// Returns the matching issue or null. Cursor-paginated (1-3+ round trips at
// the current 200+ issue count, early-exits on first match); called at most
// once per alert (not in a loop), so this is never a hot path.
async function searchIssues(term, teamKey = TEAM_KEY) {
  let after = null;
  for (;;) {
    const data = await graphql(linearDispatch.buildOpenIssuesWithDescriptionsQuery(), { teamKey, after });
    const { nodes, pageInfo } = data.issues || { nodes: [], pageInfo: { hasNextPage: false } };
    const match = linearDispatch.findOpenIssueForTerm(nodes || [], term);
    if (match) return match;
    if (!pageInfo || !pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  return null;
}

// All open (non-completed, non-canceled) issues for a team, WITH description —
// used by linear-next.js's cross-dispatch overlap check (task #1696), which
// needs to compare a new dispatch's title/description against EVERY other
// live issue, not just search for one term. Reuses searchIssues()'s exact
// query/pagination shape (buildOpenIssuesWithDescriptionsQuery) but returns
// every paginated node instead of early-exiting on a term match — a second,
// hand-rolled query here would silently drift from what searchIssues()
// already fetches.
async function listOpenIssuesWithDescriptions(teamKey = TEAM_KEY) {
  const issues = [];
  let after = null;
  for (;;) {
    const data = await graphql(linearDispatch.buildOpenIssuesWithDescriptionsQuery(), { teamKey, after });
    const { nodes, pageInfo } = data.issues || { nodes: [], pageInfo: { hasNextPage: false } };
    issues.push(...(nodes || []));
    if (!pageInfo || !pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  return issues;
}

// Every dispatched issue's completion report (linear-dispatch.js:195) hits
// createComment + updateIssue on an id that may have been archived out from
// under it — either a race with the cap-management archival (BRO-285) or a
// re-dispatch of an issue an earlier session already closed and archived.
// Both mutations then fail with the generic, id-agnostic "Entity not found:
// Issue" — indistinguishable at that message from a bad/deleted id. Detect
// it, confirm via a read (archived issues stay readable, just not
// writable), unarchive, and retry once (task #1510, BRO-247 incident
// 2026-08-14).
function isArchivedIssueError(err) {
  return !!(
    err &&
    Array.isArray(err.linearErrors) &&
    err.linearErrors.some((e) => /Entity not found: Issue/i.test(e && e.message))
  );
}

async function getIssueArchivedAt(id) {
  const data = await graphql(`query($id: String!) { issue(id: $id) { archivedAt } }`, { id });
  return data.issue ? data.issue.archivedAt : null;
}

// Named export alongside archiveIssue for symmetry — also used directly by
// withArchivedIssueRetry below.
async function issueUnarchive(id) {
  const data = await graphql(`mutation($id: String!) { issueUnarchive(id: $id) { success } }`, { id });
  if (!data.issueUnarchive || !data.issueUnarchive.success) throw new Error(`issueUnarchive failed for ${id}`);
  return data.issueUnarchive;
}

// Runs `run()` once; on the archived-issue error, confirms archival via a
// read, unarchives, and retries `run()` exactly once. A "not found" that
// ISN'T archival (bad id, deleted issue) rethrows the original error
// unchanged.
//
// Deliberately does NOT re-archive afterward. A caller reaching this path is
// actively touching the issue (posting a report, moving its state) — an
// initial version of this fix re-archived unconditionally to "restore the
// prior state," but that silently re-hides an issue a caller had just moved
// to a non-terminal state (e.g. linear-next.js's dispatch-start updateIssue
// to "In Progress"), which is a worse bug than the cryptic error this fixes.
// The BRO-285 archive cron (linear-cap-policy.js's isArchivableIssue) already
// owns "should this go back to archived" on its own schedule based on actual
// state/completedAt — that's the right place for that decision, not a guess
// made here on every retried mutation regardless of what it did.
async function withArchivedIssueRetry(id, run) {
  try {
    return await run();
  } catch (err) {
    if (!isArchivedIssueError(err)) throw err;
    const archivedAt = await getIssueArchivedAt(id);
    if (!archivedAt) throw err;
    await issueUnarchive(id);
    return run();
  }
}

// Post a comment on an issue (used by linear-next.js to record "Dispatched to
// <ref> at <ts>" on the issue itself, so double-dispatch is visible on the
// board without cross-referencing the local dispatch ledger).
async function createComment(issueId, body) {
  return withArchivedIssueRetry(issueId, async () => {
    const data = await graphql(linearDispatch.buildCommentMutation(), { issueId, body });
    if (!data.commentCreate.success) throw new Error(`commentCreate failed for issue ${issueId}`);
    return data.commentCreate;
  });
}

// Archive a Done/Canceled issue so it stops counting against the free-tier
// 250-unarchived-issue cap (BRO-285). Archiving is reversible in Linear's UI
// (unarchive), unlike delete, so this carries a lower bar than updateIssue's
// board-reprojection mutations — callers still keep their own audit trail
// (see scripts/linear-archive-done.js) before calling this.
async function archiveIssue(id) {
  const data = await graphql(
    `mutation($id: String!) {
      issueArchive(id: $id) { success }
    }`,
    { id }
  );
  if (!data.issueArchive || !data.issueArchive.success) throw new Error(`issueArchive failed for ${id}`);
  return data.issueArchive;
}

async function updateIssue(id, input) {
  return withArchivedIssueRetry(id, async () => {
    const data = await graphql(
      `mutation($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      { id, input }
    );
    if (!data.issueUpdate.success) throw new Error(`issueUpdate failed for ${id}`);
  });
}

async function listProjects() {
  const data = await graphql(`query { projects(first: 100) { nodes { id name } } }`);
  return data.projects.nodes;
}

async function createProject(name, teamId) {
  const data = await graphql(
    `mutation($input: ProjectCreateInput!) {
      projectCreate(input: $input) { success project { id name } }
    }`,
    { input: { name, teamIds: [teamId] } }
  );
  if (!data.projectCreate.success) throw new Error(`projectCreate failed for "${name}"`);
  return data.projectCreate.project;
}

/**
 * @param {string} [opts.id]          client-supplied UUID — THE idempotency key.
 * @param {string[]} [opts.labelIds]  labels to attach at creation.
 * @param {boolean} [opts.retryMutationsOn5xx]  only safe WITH an id (see below).
 *
 * `id` is a real String field on IssueCreateInput (confirmed by live
 * introspection against the API, twice, rather than from docs). Supplying it
 * makes a replayed create a server-side no-op instead of a duplicate, which is
 * the only reason the Sprint 3 bulk write can be retried at all: a board with
 * no bulk delete does not forgive a double-import of 1,949 cards.
 *
 * retryMutationsOn5xx is refused unless an id is supplied. linear-retry-policy.js
 * withholds 5xx retries from mutations precisely because a replay is ambiguous
 * (S1-T1), and the id is what resolves the ambiguity — so letting a caller opt
 * into the retry WITHOUT one would quietly undo that decision. Enforced here
 * rather than documented, because a comment cannot fail a build.
 */
async function createIssue({ teamId, title, description, priority, stateId, projectId, id, labelIds, retryMutationsOn5xx }) {
  if (retryMutationsOn5xx && !id) {
    throw new Error('createIssue: retryMutationsOn5xx requires a client-supplied id — a replay without one duplicates the issue');
  }
  const input = { teamId, title, description, priority, stateId, projectId };
  if (id) input.id = id;
  if (labelIds && labelIds.length) input.labelIds = labelIds;
  const data = await graphql(
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { id identifier title } }
    }`,
    { input },
    retryMutationsOn5xx ? { retryMutationsOn5xx: true } : {}
  );
  if (!data.issueCreate.success) throw new Error(`issueCreate failed for "${title}"`);
  return data.issueCreate.issue;
}

/**
 * EVERY label on the team, paginated.
 *
 * Distinct from findOrCreateLabel() below, which looks one name up by exact
 * match. The corpus import needs the whole set at once because Linear label
 * names are unique CASE-INSENSITIVELY: it has to match a normalised `bug`
 * against an existing `Bug` before deciding whether to create anything, and a
 * per-name exact lookup cannot answer that.
 */
async function listLabels(teamId) {
  const out = [];
  let cursor;
  do {
    const data = await graphql(
      `query($teamId: String!, $after: String) {
        team(id: $teamId) {
          labels(first: 250, after: $after) {
            nodes { id name }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { teamId, after: cursor }
    );
    const page = data.team.labels;
    out.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : undefined;
  } while (cursor);
  return out;
}

// ── attachments (BRO-282: the thing to approve must live WITH the ask, not
// on a local path on one machine) ──────────────────────────────────────────
//
// Linear's upload flow is two calls: fileUpload() gets a signed PUT URL +
// the public assetUrl it will resolve to, then attachmentCreate() points the
// issue at that assetUrl. The PUT itself is a plain (non-GraphQL) request to
// Linear's asset storage, so it goes through the bare fetch(), not graphql().

async function requestFileUpload({ contentType, filename, size }) {
  const data = await graphql(
    `mutation($contentType: String!, $filename: String!, $size: Int!) {
      fileUpload(contentType: $contentType, filename: $filename, size: $size) {
        success
        uploadFile { assetUrl uploadUrl headers { key value } }
      }
    }`,
    { contentType, filename, size }
  );
  if (!data.fileUpload || !data.fileUpload.success || !data.fileUpload.uploadFile) {
    throw new Error(`fileUpload failed for ${filename}`);
  }
  return data.fileUpload.uploadFile;
}

async function createAttachment({ issueId, url, title, subtitle }) {
  const data = await graphql(
    `mutation($input: AttachmentCreateInput!) {
      attachmentCreate(input: $input) { success attachment { id url title } }
    }`,
    { input: { issueId, url, title, subtitle } }
  );
  if (!data.attachmentCreate || !data.attachmentCreate.success) {
    throw new Error(`attachmentCreate failed for issue ${issueId}`);
  }
  return data.attachmentCreate.attachment;
}

// Reads filePath off disk, uploads it to Linear's asset storage, and attaches
// it to issueId. Returns the created attachment ({id, url, title}).
//
// The PUT is a plain fetch, not graphql() — so unlike every mutation in this
// file it gets no retry and no timeout for free. 30s matches graphql()'s own
// default per-attempt budget (see that function's header) so a hung asset
// upload fails in the same order of magnitude as a hung GraphQL call, instead
// of hanging the caller's crop-upload loop indefinitely (ship-check finding,
// BRO-282).
async function attachFileToIssue({ issueId, filePath, title, contentType = 'image/png' }) {
  const buffer = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const uploadFile = await requestFileUpload({ contentType, filename, size: buffer.length });
  const headers = { 'Content-Type': contentType };
  for (const h of uploadFile.headers || []) headers[h.key] = h.value;
  const res = await fetch(uploadFile.uploadUrl, {
    method: 'PUT',
    headers,
    body: buffer,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Linear file PUT failed: HTTP ${res.status}`);
  return createAttachment({ issueId, url: uploadFile.assetUrl, title: title || filename });
}

// ── labels (awaiting-owner marker) ──────────────────────────────────────────

async function lookupLabel(teamId, name) {
  const data = await graphql(
    `query($teamId: ID!, $name: String!) {
      issueLabels(filter: { team: { id: { eq: $teamId } }, name: { eq: $name } }) {
        nodes { id name }
      }
    }`,
    { teamId, name }
  );
  return (data.issueLabels && data.issueLabels.nodes || [])[0] || null;
}

async function findOrCreateLabel(teamId, name) {
  const existing = await lookupLabel(teamId, name);
  if (existing) return existing;
  try {
    const created = await graphql(
      `mutation($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) { success issueLabel { id name } }
      }`,
      { input: { teamId, name } }
    );
    if (!created.issueLabelCreate || !created.issueLabelCreate.success) {
      throw new Error(`issueLabelCreate failed for "${name}"`);
    }
    return created.issueLabelCreate.issueLabel;
  } catch (err) {
    // Two callers racing to create the label for the first time: the loser's
    // create can fail on Linear's uniqueness constraint. Re-check once before
    // giving up — the winner's label already satisfies this call.
    const winner = await lookupLabel(teamId, name);
    if (winner) return winner;
    throw err;
  }
}

// Additive — merges labelId into whatever labels the issue already carries,
// since issueUpdate's labelIds input is a full overwrite (a caller who
// naively passed `[labelId]` would silently strip every other label off the
// issue). Reads the CURRENT label set itself, immediately before the write,
// rather than trusting a caller-supplied snapshot from an earlier getIssue()
// call — a snapshot taken before a slow operation (e.g. a multi-file upload
// loop) widens the window for a concurrent labeler's change to get clobbered
// by this overwrite (ship-check finding, BRO-282). first: 50 here (vs. 20 on
// the general-purpose issue queries in linear-dispatch.js) because dropping a
// label on THIS specific read-modify-write would silently delete it from the
// issue, not just hide it from one report.
async function addLabelToIssue(issueId, labelId) {
  const data = await graphql(
    `query($id: String!) { issue(id: $id) { labels(first: 50) { nodes { id } } } }`,
    { id: issueId }
  );
  const currentLabelIds = ((data.issue && data.issue.labels && data.issue.labels.nodes) || []).map((l) => l.id);
  const labelIds = Array.from(new Set([...currentLabelIds, labelId]));
  return updateIssue(issueId, { labelIds });
}

module.exports = {
  TEAM_KEY,
  graphql,
  getTeam,
  listAllIssueTitles,
  listIssues,
  getIssue,
  listOpenIssues,
  listOpenIssuesWithDescriptions,
  searchIssues,
  createComment,
  updateIssue,
  archiveIssue,
  issueUnarchive,
  listProjects,
  createProject,
  createIssue,
  listLabels,
  requestFileUpload,
  createAttachment,
  attachFileToIssue,
  findOrCreateLabel,
  addLabelToIssue,
};
