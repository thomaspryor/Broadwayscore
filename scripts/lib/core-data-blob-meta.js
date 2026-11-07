'use strict';

/**
 * Single source of truth for which private core-data files the deploy gate
 * tracks, and the Vercel `--meta` key each one is stamped under (BRO-3149,
 * BRO-3618). The workflow (vercel-deploy.yml, via `--meta-args`), the Vercel
 * read-back (check-prod-deploy.js) and the gate (should-deploy-gate.js) all
 * derive their names from here so they cannot drift.
 *
 * These files live only in the private broadway-scorecard-data repo and are
 * pulled into data/ at build time, so the public-repo git diff never sees them
 * change. Their writers push to the private repo only (push-core-data), none
 * commits a public/data artifact in the same run.
 *
 * audience-buzz.json is deliberately NOT tracked: it is rewritten by ~16
 * workflows (mezzanine, LTD, snapshots, opening-night pollers...), so tracking
 * it would turn nearly every tick into a Vercel build. It rides the 6h
 * staleness backstop instead (the cost the gate exists to avoid). Add it to
 * DATA_TRACKED_FILES only after measuring its commit rate.
 */

const DATA_TRACKED_FILES = [
  'reviews.json',
  'shows.json',
  'commercial.json',
  'grosses.json',
  'grosses-history.json',
  'critic-consensus.json',
];

// 'critic-consensus.json' -> 'criticConsensusBlobSha'; 'reviews.json' -> 'reviewsBlobSha'
function blobShaMetaKey(file) {
  const base = file.replace(/\.json$/, '');
  const camel = base.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return `${camel}BlobSha`;
}

// Every `<x>BlobSha` entry of a Vercel deployment's meta, as { key: sha }.
function pickBlobShaMeta(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta || {})) {
    if (/BlobSha$/.test(k) && typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

module.exports = { DATA_TRACKED_FILES, blobShaMetaKey, pickBlobShaMeta };
