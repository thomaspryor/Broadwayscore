---
name: feedback-xcode-update-stale-simulator
description: "After a macOS Xcode update, simulator builds fail environmentally (CoreSimulator version mismatch + iOS platform not installed) — run -runFirstLaunch then -downloadPlatform iOS before blaming the code."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 96f1f818-d58a-4563-b84f-6e1953558609
  modified: 2026-07-20T04:58:48.763Z
---

2026-07-20, first SDK-57 native build of BroadwayScorecard-app: xcodebuild failed in 3 targets (ReactNativeDependencies copy script, expo-dev-menu asset catalog) and `xcodebuild -version` hung >120s. Root cause was the MACHINE, not the diff: Xcode had updated to 26.6 but CoreSimulator was stale (1051.54 < 1051.55, "Simulator device support disabled") and the iOS 26.5 platform runtime was never downloaded.

**Why:** Xcode app updates don't finish installing simulator support until first launch; CLI-only Macs never "first launch."

**How to apply:** When an iOS simulator build fails right after an Xcode update (or with weird asset-catalog / PhaseScriptExecution failures + slow xcodebuild), check `xcodebuild -version` responsiveness and grep the log for "CoreSimulator is out of date" / "is not installed". Fix: `xcodebuild -runFirstLaunch` then `xcodebuild -downloadPlatform iOS` (multi-GB, run in background). Also: never pipe xcodebuild to `tail` without pipefail — [[feedback_pipe_masks_exit_code]] hid this failure as exit 0.
