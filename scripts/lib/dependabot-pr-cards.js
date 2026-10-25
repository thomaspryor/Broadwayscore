'use strict';

/**
 * Turn open Dependabot PRs into owner-alert-router 'auto' alerts, one per PR
 * (BRO-5631). Pure, so the selection is unit-tested apart from gh and Linear.
 *
 * Why cards and not a merge: the old workflow ran `gh pr merge --auto`, which
 * always failed (auto-merge is disabled on this repo), and Dependabot PRs skip
 * the test.yml jobs that need private data, so every monthly group PR rotted
 * open and the PR supervisor flagged it to an owner who never merges PRs. A
 * card hands the bump to a worker session, which rebuilds it on a fresh
 * branch, runs the full build (land.yml does not run `next build`) and lands
 * it. Unattended landing was rejected in review: land.yml would run the
 * updated packages' install scripts with a workflow-scoped PAT on disk.
 *
 * @param {Array<{number:number,title:string,url:string,headRefName:string,isCrossRepository?:boolean}>} prs
 * @returns {Array<{conditionKey:string,title:string,description:string,hint:string,url:string}>}
 */
function dependabotPrAlerts(prs) {
  return (prs || [])
    .filter((p) => p && Number.isInteger(p.number) && !p.isCrossRepository)
    .filter((p) => /^dependabot\//.test(p.headRefName || ''))
    .map((p) => ({
      conditionKey: `dependabot-pr:${p.number}`,
      title: `Land Dependabot PR #${p.number}: ${p.title}`,
      description: `Dependabot opened ${p.url} ("${p.title}"). Nothing merges Dependabot PRs on this repo, so it stays open until a worker lands the same bumps.`,
      hint: 'Apply the bumps with npm install on a fresh branch off origin/main (do not reuse the Dependabot branch; its lockfile goes stale). Run npx tsc --noEmit, npx tsc --noEmit -p scripts/llm-scoring/tsconfig.json and a full npm run build:ugc. Hold back any bump that changes the Playwright or browser version unless the visual baselines are checked. Land via land/bro-N-deps, then close the PR with a comment naming the landed commit. GitHub Actions bumps edit workflow files: CLAUDE.md §18 review first.',
      url: p.url,
    }));
}

module.exports = { dependabotPrAlerts };
