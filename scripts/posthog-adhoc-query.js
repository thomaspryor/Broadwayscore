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

function formatCell(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Renders a PostHog query response ({ columns, results }) as a markdown
 * table. Falls back to col0..colN headers when the API returns no columns,
 * and to a one-line "_No rows_" when there are no results.
 */
function toMarkdownTable({ columns, results }) {
  const rows = Array.isArray(results) ? results : [];
  if (rows.length === 0) return '_No rows_\n';
  const width = Math.max(...rows.map((r) => (Array.isArray(r) ? r.length : 1)));
  const headers = Array.isArray(columns) && columns.length === width
    ? columns.map(String)
    : Array.from({ length: width }, (_, i) => `col${i}`);
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];
  for (const row of rows) {
    const cells = Array.isArray(row) ? row : [row];
    lines.push(`| ${headers.map((_, i) => formatCell(cells[i])).join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
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
    parts.push('```sql\n' + section.statement + '\n```\n');
    if (section.error) {
      parts.push(`**FAILED:** ${formatCell(section.error)}\n`);
    } else {
      const n = Array.isArray(section.response?.results) ? section.response.results.length : 0;
      parts.push(`${n} row(s)\n\n${toMarkdownTable(section.response || {})}`);
    }
  });
  return `${parts.join('\n')}\n`;
}

async function runStatements(statements, query = phQueryFull) {
  const sections = [];
  for (const statement of statements) {
    try {
      const response = await query(statement);
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

module.exports = { splitStatements, toMarkdownTable, renderReport, runStatements };

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
