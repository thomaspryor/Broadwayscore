# Production page parity

`node scripts/lib/prod-data-parity.js` checks approximately 20 production show
pages. It prints matched, mismatched and unavailable counts. Exit codes are 0
for a complete match, 1 for numeric or rendering mismatches, and 2 for an
unavailable reference/page or a deployment that changed during the probe.
The default command is read-only. `--alert` routes one deduplicated mismatch
condition through the existing owner alert router. `--base=URL` supports a
preview deployment or a local HTTP fixture.

The daily `data-health-check.yml` job already runs `scripts/health-check.js`,
which invokes this probe in CI. No new workflow or paid scraper is involved.
A full sample makes 22 ordinary requests to our site: one build reference,
20 pages and a second reference to detect a deployment race. Unavailable
checks are warnings in the health report and cannot resolve a mismatch card.

`scripts/prebuild.sh` runs `--snapshot` after generating public show details,
including on the fast deployment build. The ignored output
`public/data/prod-data-parity.json` contains only public numeric data and
identifiers. It records the code commit, shows/reviews input blob hashes, and
a 20-show sample spanning markets and recent, long-running, closed and
unscored shows. Scores come from `getCriticScore()`; counts come from the
shared scored-review calculation, retaining partial counts below the score
display threshold. Raw review text never enters this reference.

The probe reads this reference from production, never from local HEAD. Thus
deploy lag does not compare a new review against a page built before that
review existed. The reference and pages must come from a stable deployment;
if the final reference read fails or changes, provisional findings are
discarded. The existing deploy-freshness and deployed-coverage checks still
detect a whole deployment that is stale relative to current source data.

The parser checks the rendered badges and review counts, including both
responsive score cards, and recognizes explicit unscored states. It does not
reverse-convert the lossy five-star JSON-LD rating into a 100-point score.
Rendering failures are actionable mismatches, while HTTP/network failures
are unavailable readings.

Before the first deployment containing this change, the reference returns
404 and the production command exits 2. After deployment, run the command
again to confirm the deployed reference and live HTML together. Unit coverage:
`node --test tests/unit/prod-data-parity.test.mjs`.
