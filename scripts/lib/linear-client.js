/**
 * Minimal Linear GraphQL client. No SDK dependency — the whole surface this
 * project needs is 4 queries/mutations, and pulling in @linear/sdk for that
 * would be a bigger footprint than a fetch() wrapper.
 */

const { readEnvKeys } = require('./load-env');
// Query/mutation TEXT for the dispatcher's calls (getIssue/listOpenIssues/
// createComment below) lives in linear-dispatch.js as pure, no-I/O builder
// functions — so linear-next.js's tests can require() the exact strings this
// file sends over the wire instead of a second, drifting copy (CLAUDE.md rule
// 15: "never copies"). No cycle: linear-dispatch.js has zero requires back
// into this file.
const linearDispatch = require('./linear-dispatch');

const API_URL = 'https://api.linear.app/graphql';
const TEAM_KEY = 'BRO';

function getApiKey() {
  const { LINEAR_API_KEY } = readEnvKeys(['LINEAR_API_KEY']);
  const key = process.env.LINEAR_API_KEY || LINEAR_API_KEY;
  if (!key) throw new Error('LINEAR_API_KEY not set in .env or environment');
  return key;
}

async function graphql(query, variables) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: getApiKey() },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
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

async function createIssue({ teamId, title, description, priority, stateId, projectId }) {
  const data = await graphql(
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { id identifier title } }
    }`,
    { input: { teamId, title, description, priority, stateId, projectId } }
  );
  if (!data.issueCreate.success) throw new Error(`issueCreate failed for "${title}"`);
  return data.issueCreate.issue;
}

module.exports = {
  TEAM_KEY,
  graphql,
  getTeam,
  listAllIssueTitles,
  listIssues,
  getIssue,
  listOpenIssues,
  searchIssues,
  createComment,
  updateIssue,
  archiveIssue,
  issueUnarchive,
  listProjects,
  createProject,
  createIssue,
};
