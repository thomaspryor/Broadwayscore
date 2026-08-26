// Confirms a TestFlight build has been submitted for Beta App Review and is
// visible to external testers via the Public Beta group's public link.
const { keyPath, hasCredentials, ascGet } = require('./asc-client.js');

const BUNDLE_ID = 'com.broadwayscorecard.app';

const SUBMITTED_STATES = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'APPROVED'];
const EXTERNALLY_VISIBLE_STATES = ['IN_BETA_TESTING', 'BETA_APPROVED'];
const EXPECTED_PUBLIC_LINK = 'https://testflight.apple.com/join/CxZYfkyn';

// Returns { version, submitted, betaReviewState, externalBuildState,
//   inPublicBetaGroup, publicLinkEnabled, publicLink }
async function getBuildBetaStatus(version) {
  const apps = await ascGet(`/v1/apps?filter[bundleId]=${BUNDLE_ID}&fields[apps]=name,bundleId`);
  const app = apps.data?.[0];
  if (!app) throw new Error(`No app found for bundleId ${BUNDLE_ID}`);

  const builds = await ascGet(`/v1/builds?filter[app]=${app.id}&filter[version]=${version}&fields[builds]=version`);
  const build = builds.data?.[0];
  if (!build) throw new Error(`No build found for version ${version}`);

  const [detail, submission, groups] = await Promise.all([
    ascGet(`/v1/builds/${build.id}/buildBetaDetail`),
    ascGet(`/v1/builds/${build.id}/betaAppReviewSubmission`),
    ascGet(`/v1/apps/${app.id}/betaGroups?fields[betaGroups]=name,isInternalGroup,publicLinkEnabled,publicLink&limit=200`),
  ]);
  if (groups.meta?.paging?.total > groups.data.length) {
    throw new Error(`App has ${groups.meta.paging.total} beta groups, more than the ${groups.data.length} fetched — extend pagination`);
  }

  const betaReviewState = submission.data?.attributes?.betaReviewState || null;
  const externalBuildState = detail.data?.attributes?.externalBuildState || null;
  // Match the specific public group this ticket is about, not just any
  // external group — an app can have more than one.
  const publicGroup = groups.data?.find((g) => g.attributes.publicLink === EXPECTED_PUBLIC_LINK)
    || groups.data?.find((g) => !g.attributes.isInternalGroup && g.attributes.publicLinkEnabled);

  let inPublicBetaGroup = false;
  if (publicGroup) {
    const groupBuilds = await ascGet(`/v1/betaGroups/${publicGroup.id}/builds?fields[builds]=version&limit=200`);
    if (groupBuilds.meta?.paging?.total > groupBuilds.data.length) {
      throw new Error(`Public beta group has ${groupBuilds.meta.paging.total} builds, more than the ${groupBuilds.data.length} fetched — extend pagination`);
    }
    inPublicBetaGroup = groupBuilds.data?.some((b) => b.attributes.version === String(version)) || false;
  }

  return {
    version,
    submitted: betaReviewState !== null && SUBMITTED_STATES.includes(betaReviewState),
    betaReviewState,
    externalBuildState,
    externallyVisible: EXTERNALLY_VISIBLE_STATES.includes(externalBuildState),
    inPublicBetaGroup,
    publicLinkEnabled: publicGroup?.attributes?.publicLinkEnabled || false,
    publicLink: publicGroup?.attributes?.publicLink || null,
  };
}

module.exports = { hasCredentials, keyPath, getBuildBetaStatus, SUBMITTED_STATES, EXTERNALLY_VISIBLE_STATES, EXPECTED_PUBLIC_LINK };
