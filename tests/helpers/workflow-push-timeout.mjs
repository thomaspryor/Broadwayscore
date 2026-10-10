// BRO-3068. Shared loader for the per-workflow push-timeout pinning tests
// (tests/unit/*-push-timeout.test.mjs). Factored out so the 12 new pinning
// test files added for BRO-3068 don't each re-implement the same
// yaml.load + job/step lookup boilerplate already established by the
// BRO-334/BRO-346 precedent (tests/unit/rebuild-fast-push-timeout.test.mjs,
// tests/unit/rebuild-reviews-push-timeout.test.mjs) — those two files are
// left as-is (pre-existing, already shipped) rather than migrated onto this
// helper.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Load and parse a workflow YAML file by its basename under .github/workflows/. */
export function loadWorkflow(basename) {
  const workflowPath = path.join(REPO_ROOT, '.github', 'workflows', basename);
  return yaml.load(fs.readFileSync(workflowPath, 'utf-8'));
}

/**
 * Find a named step within a specific job. Throws with a descriptive message
 * (rather than returning undefined) so a renamed step/job fails loudly with
 * the offending name, not a downstream "Cannot read properties of undefined".
 */
export function findStep(doc, jobName, stepName) {
  const job = doc.jobs && doc.jobs[jobName];
  if (!job) throw new Error(`job "${jobName}" not found`);
  const step = (job.steps || []).find((s) => s.name === stepName);
  if (!step) throw new Error(`step "${stepName}" not found in job "${jobName}"`);
  return step;
}
