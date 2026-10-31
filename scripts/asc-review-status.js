#!/usr/bin/env node
// Query App Store Connect for current app review status and rejection details

const { ascGet } = require('./lib/asc-client.js');

async function main() {
  // 1. Find the Broadway Scorecard app
  const apps = await ascGet('/v1/apps?filter[bundleId]=com.broadwayscorecard.app&fields[apps]=name,bundleId');
  if (!apps.data?.length) {
    // Try listing all apps
    const all = await ascGet('/v1/apps?fields[apps]=name,bundleId');
    console.log('Apps found:', all.data?.map(a => `${a.attributes.name} (${a.attributes.bundleId}) — ID: ${a.id}`));
    return;
  }

  const app = apps.data[0];
  console.log(`App: ${app.attributes.name} (${app.id})\n`);

  // 2. Get all versions, sorted newest first
  const versions = await ascGet(
    `/v1/appStoreVersions?filter[app]=${app.id}&sort=-createdDate&fields[appStoreVersions]=versionString,appStoreState,reviewType,createdDate`
  );

  if (!versions.data?.length) {
    console.log('No versions found.');
    return;
  }

  // Show all recent versions with their state
  console.log('Recent versions:');
  for (const v of versions.data.slice(0, 5)) {
    const { versionString, appStoreState, createdDate } = v.attributes;
    console.log(`  v${versionString} — ${appStoreState} (created ${createdDate?.slice(0, 10)})`);
  }

  // 3. Find rejected version
  const rejected = versions.data.find(v =>
    ['REJECTED', 'DEVELOPER_REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'].includes(v.attributes.appStoreState)
  );
  const target = rejected || versions.data[0];
  console.log(`\nChecking version: v${target.attributes.versionString} (${target.attributes.appStoreState})`);

  // 4. Get review details for this version
  const details = await ascGet(
    `/v1/appStoreVersions/${target.id}/appStoreReviewDetail?fields[appStoreReviewDetails]=reviewNotes,contactEmail,contactFirstName,contactLastName`
  );
  if (details.data?.attributes?.reviewNotes) {
    console.log('\nReview notes:', details.data.attributes.reviewNotes);
  }

  // 5. Get rejection reasons from submission
  const submission = await ascGet(
    `/v1/appStoreVersions/${target.id}/appStoreVersionSubmission`
  );
  console.log('\nSubmission:', JSON.stringify(submission, null, 2));

  // 6. Get review rejections (newer API)
  const rejections = await ascGet(
    `/v1/appStoreVersions/${target.id}?include=appStoreReviewAttachments&fields[appStoreVersions]=appStoreState,reviewType`
  );
  if (rejections.data) {
    console.log('\nVersion detail:', JSON.stringify(rejections.data.attributes, null, 2));
  }
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
