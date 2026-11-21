import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// BRO-7931 class guard: a timeout kill lands in the scrape job and skips downstream jobs,
// so that job needs its own notify step that also fires on cancel; WET entry must keep exitCode.
const wf = fs.readFileSync(new URL('../../.github/workflows/scrape-bww-reviews.yml', import.meta.url), 'utf8');
test('BWW scrape job alerts on cancel', () => {
  const scrapeJob = wf.slice(wf.indexOf('  scrape:'), wf.indexOf('\n  rebuild:'));
  assert.match(scrapeJob, /if: failure\(\) \|\| cancelled\(\)[\s\S]*notify-failure/);
  assert.match(scrapeJob, /--time-budget-min=/);
});
test('WET entrypoint does not swallow exitCode', () => {
  const s = fs.readFileSync(new URL('../scrape-westendtheatre-roundups.js', import.meta.url), 'utf8');
  assert.doesNotMatch(s, /process\.exit\(0\)/);
});
