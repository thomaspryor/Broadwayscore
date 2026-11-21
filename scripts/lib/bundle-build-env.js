'use strict';

const { BUILD_ENV } = require('./autonomous-checks');

// The performance workflow builds without Vercel's environment. /blog and
// /studio import Sanity config even when feature flags are off. Reuse the
// public config other CI builds use, without changing which features we size.
function bundleBuildEnv(env = process.env) {
  const out = { ...env };
  for (const key of ['NEXT_PUBLIC_SANITY_PROJECT_ID', 'NEXT_PUBLIC_SANITY_DATASET', 'NEXT_PUBLIC_SANITY_API_VERSION']) {
    if (!out[key]) out[key] = BUILD_ENV[key];
  }
  return out;
}

module.exports = { bundleBuildEnv };
