---
name: ios-local-build-signing-and-expo-legacy-apis
description: "Local `expo run:ios` fails with no code-signing certs on this Mac even for simulator targets; expo-media-library/expo-file-system SDK 57 default exports are the new class-based API — old getAssetsAsync/cacheDirectory-style calls need the `/legacy` subpath import."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e6e965cf-21df-4854-8baf-ada6c8d441d3
  modified: 2026-07-27T01:14:51.781Z
---

**No local Apple code-signing on the Mac Studio.** `npx expo run:ios` (any target — device UDID, simulator UDID, `--simulator` flag) fails with `CommandError: No code signing certificates are available to use.` even when explicitly targeting a booted iOS Simulator. A raw `xcodebuild -sdk iphonesimulator -configuration Release build` (the exact invocation `maestro-e2e.yml` uses in CI) does compile without signing, but as a cold build (no DerivedData cache) it took 40+ minutes for the full React Native + Pods tree and didn't finish within a session's time budget.

**Why:** Reason unconfirmed (could be entitlements like associated domains forcing automatic-signing requirements even for simulator debug builds, or no dev certs in this machine's keychain at all).

**How to apply:** Don't attempt local native iOS builds for visual QA on this machine — budget for it to fail or take 40+ min uncached. For UI verification on this app, rely on: (1) code-level review, (2) Maestro E2E via CI (`maestro-e2e.yml`, manual `workflow_dispatch`), (3) requesting the user check a TestFlight/EAS build. If a local build is genuinely needed, use the CI's exact `xcodebuild -workspace ... -sdk iphonesimulator -configuration Release -destination "platform=iOS Simulator,id=<UDID>"` form (not `expo run:ios`) and expect a long wait on a cold cache — start it early in the session, not at the end.

**expo-media-library / expo-file-system (SDK 57) default export is the new API.** Both packages restructured: the default `.` export is now a class-based API (`Query`/`Asset`/`Album` for media-library; `File`/`Directory` for file-system) that dropped the familiar `getAssetsAsync`, `createAssetAsync`, `cacheDirectory`, `downloadAsync`, `MediaType`, `SortBy`. The old shape still exists but only under the `/legacy` subpath: `import * as MediaLibrary from 'expo-media-library/legacy'` and `import * as FileSystem from 'expo-file-system/legacy'`. TypeScript will fail with "Property X does not exist" if you import the bare package name and use the old API — check `node_modules/<pkg>/package.json`'s `exports` map for a `./legacy` entry before assuming an API was removed entirely.
