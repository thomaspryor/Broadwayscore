#!/usr/bin/env node
/**
 * posthog-adhoc-query.js — run one or more HogQL statements against PostHog
 * and print each result as a markdown table (stdout, plus $GITHUB_STEP_SUMMARY
 * when set, so the run's Summary page shows it).
 *
 * Why: POSTHOG_PERSONAL_API_KEY exists only as a GitHub secret, and every
 * scheduled PostHog job runs a FIXED query set (posthog-weekly-insights.js,
 * analyze-traffic-sources.js). "Is anyone using feature X?" needs a one-off
 * query, and until BRO-4327 there was no way to run one from CI. The
 * workflow wrapper is .github/workflows/posthog-adhoc-query.yml.
 *
 * Read-only: PostHog's /query/ endpoint executes HogQL SELECTs. This script
 * never writes anywhere but stdout and the step summary.
 *
 * Env:
 *   HOGQL                     one or more statements, separated by a line
 *                             that is exactly `---`
 *   POSTHOG_PERSONAL_API_KEY  (via scripts/lib/posthog-query.js)
 *   GITHUB_STEP_SUMMARY       optional; markdown is appended when set
 *
 * Usage:
 *   HOGQL="SELECT count() FROM events WHERE timestamp > now() - interval 1 day" \
 *     node scripts/posthog-adhoc-query.js
 *   node scripts/posthog-adhoc-query.js --self-test   # no network, renders a
 *                                                     # fixed fake result
 *
 * Gotcha (cloud-memory/feedback_posthog_hogql_default_row_limit.md): HogQL
 * silently caps GROUP BY results at ~100 rows without an explicit LIMIT.
 * Put a LIMIT on every grouped statement you send here.
 *
 * Exit codes: 0 all statements ran; 1 no HOGQL / no key / any statement
 * failed (the failing statement's error is still rendered in the report so
 * the surviving results are not lost).
 */

const fs = require('fs');
const { phQueryFull, REAL_USERS_WHERE } = require('./lib/posthog-query');

const STATEMENT_SEPARATOR = /^\s*---\s*$/m;

/**
 * `{{REAL_USERS_WHERE}}` in a statement expands to the shared Real Users
 * lens (owner + bot geos excluded — the ONE definition lives in
 * scripts/lib/posthog-query.js), so ad-hoc queries get the same filter the
 * scheduled reports use instead of a hand-copied, drifting version.
 */
function expandLens(statement) {
  return statement.replace(/\{\{\s*REAL_USERS_WHERE\s*\}\}/g, `(${REAL_USERS_WHERE.trim()})`);
}

/** Splits the HOGQL env text into trimmed, non-empty, lens-expanded statements. */
function splitStatements(text) {
  return String(text || '')
    .split(STATEMENT_SEPARATOR)
    .map((s) => expandLens(s.trim()))
    .filter(Boolean);
}

/**
 * Rows rendered per statement. GITHUB_STEP_SUMMARY has a 1 MiB hard limit
 * (the step fails past it), and a `LIMIT 100000` statement — the row-cap
 * memory's own advice — would otherwise write every row to it.
 */
const MAX_RENDERED_ROWS = 500;

/**
 * PostHog's HogQL API silently caps any SELECT without a LIMIT at ~100 rows
 * (cloud-memory/feedback_posthog_hogql_default_row_limit.md). The response
 * says so itself (`hasMore: true`), which is the signal used here; the
 * regex fallback covers an older response shape that lacks the flag.
 */
function looksSilentlyCapped(statement, response) {
  if (response && typeof response.hasMore === 'boolean') return response.hasMore === true;
  const rowCount = Array.isArray(response?.results) ? response.results.length : 0;
  return rowCount === 100 && !/\bLIMIT\b/i.test(statement);
}

function escapeCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatCell(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value);
    // A click-through rate of 0.0037 must not print as 0.00: round only at
    // magnitude >= 1, keep three significant digits below it.
    return Math.abs(value) >= 1 ? value.toFixed(2) : value.toPrecision(3);
  }
  if (typeof value === 'object') return escapeCell(JSON.stringify(value));
  return escapeCell(value);
}

/** Fences the statement so a ``` inside it cannot break out of the block. */
function fenceSql(statement) {
  const fence = statement.includes('```') ? '````' : '```';
  return `${fence}sql\n${statement}\n${fence}\n`;
}

/**
 * Renders a PostHog query response ({ columns, results }) as a markdown
 * table. Falls back to col0..colN headers when the API returns no columns,
 * and to a one-line "_No rows_" when there are no results.
 */
function toMarkdownTable({ columns, results }) {
  const rows = Array.isArray(results) ? results : [];
  if (rows.length === 0) return '_No rows_\n';
  // reduce, not Math.max(...spread): the spread throws RangeError past ~120k rows.
  const width = rows.reduce((w, r) => Math.max(w, Array.isArray(r) ? r.length : 1), 0);
  const headers = Array.isArray(columns) && columns.length === width
    ? columns.map(String)
    : Array.from({ length: width }, (_, i) => `col${i}`);
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];
  for (const row of rows.slice(0, MAX_RENDERED_ROWS)) {
    const cells = Array.isArray(row) ? row : [row];
    lines.push(`| ${headers.map((_, i) => formatCell(cells[i])).join(' | ')} |`);
  }
  let out = `${lines.join('\n')}\n`;
  if (rows.length > MAX_RENDERED_ROWS) {
    out += `\n_Truncated: showing ${MAX_RENDERED_ROWS} of ${rows.length} rows. Add a tighter LIMIT or aggregate._\n`;
  }
  return out;
}

/**
 * Renders the full report. `sections` is [{ statement, response?, error? }].
 * Each section prints the statement it ran (fenced) so the Summary page is
 * self-describing when someone finds it a month later.
 */
function renderReport(sections, { title = 'PostHog ad-hoc query' } = {}) {
  const parts = [`## ${title}\n`, `_${sections.length} statement(s) · ${new Date().toISOString()}_\n`];
  sections.forEach((section, i) => {
    parts.push(`### Statement ${i + 1}\n`);
    parts.push(fenceSql(section.statement));
    if (section.error) {
      parts.push(`**FAILED:** ${formatCell(section.error)}\n`);
    } else {
      const n = Array.isArray(section.response?.results) ? section.response.results.length : 0;
      parts.push(`${n} row(s)\n\n${toMarkdownTable(section.response || {})}`);
      if (looksSilentlyCapped(section.statement, section.response)) {
        parts.push('⚠️ **Result is capped** — PostHog reports more rows than it returned (HogQL silently caps a statement with no LIMIT at ~100). Re-run with an explicit `LIMIT` well above the real row count.\n');
      }
    }
  });
  return `${parts.join('\n')}\n`;
}

/**
 * Same transient rule as scripts/analyze-traffic-sources.js
 * isTransientPostHogError: an HTTP status decides first (a 400 "timeout
 * exceeded" is a HogQL execution limit and fails identically on retry).
 */
function isTransientError(err) {
  const msg = String(err && err.message);
  const m = msg.match(/PostHog API (\d{3})/);
  if (m) { const st = +m[1]; return st >= 500 || st === 429 || st === 408; }
  return /time-?out|ECONNRESET|fetch failed/i.test(msg);
}

/**
 * Runs each statement in order, one retry after `retryDelayMs` on a
 * transient PostHog error (a 504 takes ~5 min to come back, hence the
 * workflow's 15-minute budget). A failed statement is recorded, not thrown,
 * so the other results still render.
 */
async function runStatements(statements, query = phQueryFull, { retryDelayMs = 20000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const sections = [];
  for (const statement of statements) {
    try {
      let response;
      try {
        response = await query(statement);
      } catch (first) {
        if (!isTransientError(first)) throw first;
        console.error(`retrying after transient error: ${String(first.message).split('\n')[0].slice(0, 120)}`);
        await sleep(retryDelayMs);
        response = await query(statement);
      }
      sections.push({ statement, response });
    } catch (err) {
      sections.push({ statement, error: err && err.message ? err.message : String(err) });
    }
  }
  return sections;
}

function emit(markdown) {
  process.stdout.write(markdown);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) fs.appendFileSync(summaryPath, markdown);
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--self-test')) {
    const fake = async (statement) => ({
      columns: ['page', 'views', 'users'],
      results: [['/trending', 12, 9], ['/west-end/trending', 3, 3]],
      statement,
    });
    const sections = await runStatements(
      splitStatements("SELECT 'a'\n---\nSELECT 'b'"),
      fake,
    );
    const report = renderReport(sections, { title: 'PostHog ad-hoc query (self-test)' });
    if (!report.includes('| page | views | users |') || sections.length !== 2) {
      console.error('self-test FAILED: rendered report did not contain the expected table');
      return 1;
    }
    emit(report);
    console.error('self-test OK: 2 statements rendered');
    return 0;
  }

  const statements = splitStatements(process.env.HOGQL);
  if (statements.length === 0) {
    console.error('HOGQL env var is empty — nothing to run. Separate multiple statements with a line containing only ---');
    return 1;
  }
  if (!process.env.POSTHOG_PERSONAL_API_KEY) {
    console.error('POSTHOG_PERSONAL_API_KEY not set');
    return 1;
  }

  const sections = await runStatements(statements);
  emit(renderReport(sections));
  const failed = sections.filter((s) => s.error).length;
  if (failed > 0) {
    console.error(`${failed}/${sections.length} statement(s) failed — see report above`);
    return 1;
  }
  console.error(`${sections.length} statement(s) ran`);
  return 0;
}

module.exports = { splitStatements, expandLens, toMarkdownTable, renderReport, runStatements, isTransientError, looksSilentlyCapped, formatCell, MAX_RENDERED_ROWS };

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
