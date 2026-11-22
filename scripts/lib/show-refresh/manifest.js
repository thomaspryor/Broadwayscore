'use strict';
/**
 * BRO-8056 phase 1b: the show-refresh build manifest. Written at prebuild
 * (scripts/build-show-refresh-manifest.ts), shipped to ISR functions
 * (next.config.js outputFileTracingIncludes), and read later by the reader
 * (phase 2) and the publisher (1d). It names exactly what this build rendered,
 * so the publisher can tell which shows changed since and the reader can tell
 * whether a published index belongs to this build.
 *
 * Pure: every input comes in as an argument.
 */
const crypto = require('crypto');
const { stable, hash16 } = require('../live-score/core');
const { SLICE_VERSION } = require('./slice');

const MANIFEST_SCHEMA = 1;
const MANIFEST_FILE = 'data/show-refresh-manifest.json';

/** Git's blob id for file content (what the gate's per-file shas are). */
function gitBlobSha(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  return crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
}

/** Registry identity without `_meta` (its lastUpdated churns every rebuild). */
function registrySha(registryFile) {
  const { _meta, ...rest } = registryFile || {};
  return hash16(stable(rest));
}

/** One show's image identity: the three paths its page renders. */
function imagesSig(images) {
  const i = images || {};
  return hash16(stable({ hero: i.hero ?? null, poster: i.poster ?? null, thumbnail: i.thumbnail ?? null }));
}

/**
 * @param {object} a
 * @param {string} a.manifestId - fresh per build (same commit rebuilt => new id)
 * @param {number} a.buildInstant - ms epoch; the clock every compute for this build uses
 * @param {string|null} a.coreSha - core-data commit, informational
 * @param {string|null} a.publicSha - this repo's commit
 * @param {object} a.registryFile - parsed data/outlet-registry.json
 * @param {Record<string, Buffer|string>} a.dataFiles - tracked core files by name (core-data-blob-meta DATA_TRACKED_FILES)
 * @param {string[]} [a.absentFiles] - optional inputs that did not exist at prebuild; verified still absent
 * @param {string[]} a.imageKeys - keys of data/site-image-versions.json
 * @param {Array<{id: string, slug: string, images?: object}>} a.shows - computed shows that were prerendered
 * @param {Map<string, string>} a.sliceHashById
 * @param {Map<string, boolean>} a.heldById - computeShowTBD at buildInstant
 */
function buildManifest(a) {
  for (const k of ['manifestId', 'buildInstant', 'registryFile', 'dataFiles', 'imageKeys', 'shows', 'sliceHashById', 'heldById']) {
    if (a[k] == null) throw new Error(`buildManifest: ${k} is required`);
  }
  if (!Number.isFinite(a.buildInstant)) throw new Error('buildManifest: buildInstant must be ms epoch');
  const shows = {};
  for (const s of a.shows) {
    const hash = a.sliceHashById.get(s.id);
    if (!hash) throw new Error(`buildManifest: no slice hash for prerendered show ${s.id}`);
    if (!a.heldById.has(s.id)) throw new Error(`buildManifest: no held verdict for ${s.id}`);
    shows[s.id] = { slug: s.slug, hash, held: a.heldById.get(s.id) === true, imagesSig: imagesSig(s.images) };
  }
  const dataShas = {};
  for (const name of Object.keys(a.dataFiles).sort()) dataShas[name] = gitBlobSha(a.dataFiles[name]);
  const absentFiles = [...new Set(a.absentFiles || [])].filter((n) => !(n in a.dataFiles)).sort();
  return {
    schema: MANIFEST_SCHEMA,
    sliceVersion: SLICE_VERSION,
    manifestId: a.manifestId,
    buildInstant: a.buildInstant,
    buildDate: new Date(a.buildInstant).toISOString().slice(0, 10),
    coreSha: a.coreSha || null,
    publicSha: a.publicSha || null,
    registrySha: registrySha(a.registryFile),
    dataShas,
    absentFiles,
    imageKeysSha: hash16(stable([...a.imageKeys].sort())),
    showCount: Object.keys(shows).length,
    shows,
  };
}

/**
 * Postbuild check: the data this build compiled is the data the manifest
 * describes. Returns the list of problems ([] = consistent).
 */
function verifyManifest(manifest, { dataFiles, publicSha }) {
  const problems = [];
  if (!isUsableManifest(manifest)) return [`manifest unusable (schema ${manifest && manifest.schema}, invalid ${!!(manifest && manifest.invalid)})`];
  // An optional input that appeared mid-build switches its loader to new data
  // (e.g. the coverage floor reads the gap audit over the snapshot).
  for (const name of manifest.absentFiles || []) {
    if (name in dataFiles) problems.push(`${name} appeared during the build`);
  }
  for (const [name, sha] of Object.entries(manifest.dataShas || {})) {
    if (!(name in dataFiles)) { problems.push(`${name} missing at postbuild`); continue; }
    const now = gitBlobSha(dataFiles[name]);
    if (now !== sha) problems.push(`${name} changed during the build (${sha.slice(0, 8)} -> ${now.slice(0, 8)})`);
  }
  if (publicSha && manifest.publicSha && publicSha !== manifest.publicSha) problems.push(`publicSha ${manifest.publicSha.slice(0, 8)} != HEAD ${publicSha.slice(0, 8)}`);
  return problems;
}

/**
 * The only test a reader may use before trusting a manifest. The postbuild
 * verifier never deletes a manifest the build already traced into functions
 * (Vercel packages after postbuild); it overwrites it with invalidManifest().
 */
function isUsableManifest(m) {
  return !!m && typeof m === 'object' && m.schema === MANIFEST_SCHEMA && m.invalid !== true
    && !!m.shows && typeof m.shows === 'object' && !!m.dataShas && typeof m.dataShas === 'object';
}

/** The marker written over a manifest that failed verification. */
function invalidManifest(problems) {
  return { schema: MANIFEST_SCHEMA, invalid: true, problems: [...(problems || [])].map(String) };
}

module.exports = { MANIFEST_SCHEMA, MANIFEST_FILE, gitBlobSha, registrySha, imagesSig, buildManifest, verifyManifest, isUsableManifest, invalidManifest };
