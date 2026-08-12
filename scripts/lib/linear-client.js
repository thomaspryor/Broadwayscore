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
            nodes { id identifier title url project { name } state { name } }
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
async function listOpenIssues(teamKey = TEAM_KEY) {
  const data = await graphql(linearDispatch.buildOpenIssuesQuery(), { teamKey });
  return (data.issues && data.issues.nodes) || [];
}

// Post a comment on an issue (used by linear-next.js to record "Dispatched to
// <ref> at <ts>" on the issue itself, so double-dispatch is visible on the
// board without cross-referencing the local dispatch ledger).
async function createComment(issueId, body) {
  const data = await graphql(linearDispatch.buildCommentMutation(), { issueId, body });
  if (!data.commentCreate.success) throw new Error(`commentCreate failed for issue ${issueId}`);
  return data.commentCreate;
}

async function updateIssue(id, input) {
  const data = await graphql(
    `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    { id, input }
  );
  if (!data.issueUpdate.success) throw new Error(`issueUpdate failed for ${id}`);
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
  createComment,
  updateIssue,
  listProjects,
  createProject,
  createIssue,
};
